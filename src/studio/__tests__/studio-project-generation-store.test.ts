import {
  StudioProjectGenerationStore,
  validateProjectionLocator,
  type StudioGenerationAdapter,
} from "../persistence/StudioProjectGenerationStore";
import { sha256HexFromBytesPortable } from "../hash";

class MemoryAdapter implements StudioGenerationAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  failAfterWrites: number | null = null;
  private writes = 0;

  armFailure(afterWrites: number | null): void {
    this.failAfterWrites = afterWrites;
    this.writes = 0;
  }

  private cut(): void {
    if (this.failAfterWrites !== null && this.writes++ >= this.failAfterWrites) {
      throw new Error("injected write failure");
    }
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return new TextDecoder().decode(value);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return value.slice().buffer;
  }
  async write(path: string, data: string): Promise<void> {
    this.cut();
    this.files.set(path, new TextEncoder().encode(data));
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.cut();
    this.files.set(path, new Uint8Array(data.slice(0)));
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "";
    const files: string[] = [];
    const folders = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const tail = file.slice(prefix.length);
      const slash = tail.indexOf("/");
      if (slash < 0) files.push(file);
      else folders.add(`${prefix}${tail.slice(0, slash)}`);
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === path) continue;
      const tail = dir.slice(prefix.length);
      const first = tail.split("/")[0];
      if (first) folders.add(`${prefix}${first}`);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }
  async mkdir(path: string): Promise<void> { this.dirs.add(path); }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
  }
}

const locator = { vaultRelativeProjectPath: "SystemSculpt/Studio/Alpha.systemsculpt" };
const legacyProject = JSON.stringify({
  schema: "studio.project.v1",
  projectId: "project_alpha",
  name: "Alpha",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  engine: { apiMode: "systemsculpt_only", minPluginVersion: "4.0.0" },
  graph: { nodes: [], edges: [], entryNodeIds: [], groups: [] },
  permissionsRef: { policyVersion: 1, policyPath: "SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json" },
  settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 100, maxArtifactsMb: 512 } },
  migrations: { projectSchemaVersion: "1.0.0", applied: [] },
}, null, 2) + "\n";

async function seedLegacy(adapter: MemoryAdapter): Promise<void> {
  await adapter.write(locator.vaultRelativeProjectPath, legacyProject);
  await adapter.write("SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json", "{\"schema\":\"studio.policy.v1\"}\n");
}

describe("StudioProjectGenerationStore", () => {
  it("uses real portable SHA-256 and rejects unsafe projection locators", () => {
    expect(sha256HexFromBytesPortable(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(() => validateProjectionLocator({ vaultRelativeProjectPath: "../Alpha.systemsculpt" })).toThrow();
    expect(() => validateProjectionLocator({ vaultRelativeProjectPath: ".systemsculpt/studio/projects/Alpha.systemsculpt" })).toThrow();
    expect(() => validateProjectionLocator({ vaultRelativeProjectPath: "/Alpha.systemsculpt" })).toThrow();
    expect(validateProjectionLocator(locator)).toEqual(locator);
  });

  it("adopts a legacy project into a validated immutable root generation", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });

    const adopted = await store.discoverAndAdopt(locator);
    expect(adopted.status).toBe("committed");
    if (adopted.status !== "committed") return;
    expect(adopted.expectedGeneration.revision).toBe(0);
    expect(adopted.expectedGeneration.generationHash).toMatch(/^[0-9a-f]{64}$/);

    const reopened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") {
      expect(new TextDecoder().decode(reopened.generation.files.get("project.systemsculpt"))).toBe(legacyProject);
    }
  });

  it("preserves the legacy projection across every root-publication write cut", async () => {
    for (let cut = 0; cut < 10; cut += 1) {
      const adapter = new MemoryAdapter();
      await seedLegacy(adapter);
      adapter.armFailure(cut);
      const result = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
      adapter.armFailure(null);
      expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(legacyProject);
      const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
      if (result.status === "committed" || recovered.status === "ready") {
        expect(recovered.status).toBe("ready");
      } else {
        expect(recovered.status).toBe("recovery_required");
      }
    }
  });

  it("publishes a whole generation with exact revision+hash CAS and rejects stale writers", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const adopted = await store.discoverAndAdopt(locator);
    if (adopted.status !== "committed") throw new Error("adoption failed");

    const committed = await store.commitWholeGeneration({
      projectId: "project_alpha",
      commandKind: "discrete_save",
      transform: (files) => {
        files.set("project.systemsculpt", new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Beta"')));
        return files;
      },
    }, adopted.expectedGeneration);
    expect(committed.status).toBe("committed");

    const stale = await store.commitWholeGeneration({
      projectId: "project_alpha",
      commandKind: "autosave",
      transform: (files) => files,
    }, adopted.expectedGeneration);
    expect(stale.status).toBe("stale_revision");
  });

  it("never exposes a torn generation after restart", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const adopted = await store.discoverAndAdopt(locator);
    if (adopted.status !== "committed") throw new Error("adoption failed");
    adapter.armFailure(1);
    const result = await store.commitWholeGeneration({
      projectId: "project_alpha",
      commandKind: "asset",
      transform: (files) => {
        files.set("support/assets/sha256/aa/blob.bin", new Uint8Array([0, 1, 2, 255]));
        return files;
      },
    }, adopted.expectedGeneration);
    expect(result.status).toBe("storage_unavailable");
    adapter.armFailure(null);

    const reopened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") expect(reopened.expectedGeneration).toEqual(adopted.expectedGeneration);
  });

  it("detects two valid children as a fork instead of choosing a winner", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const first = await store.commitWholeGeneration({ projectId: "project_alpha", commandKind: "autosave", transform: (f) => { f.set("support/a", new Uint8Array([1])); return f; } }, root.expectedGeneration);
    if (first.status !== "committed") throw new Error("first commit failed");
    const firstDir = [...adapter.dirs].find((path) => path.includes(`/1-${first.expectedGeneration.generationHash}`));
    if (!firstDir) throw new Error("missing first generation");
    const copied = new Map([...adapter.files].filter(([path]) => path.startsWith(firstDir)).map(([path, bytes]) => [path, bytes.slice()]));
    await adapter.remove(firstDir);
    const second = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).commitWholeGeneration({ projectId: "project_alpha", commandKind: "autosave", transform: (f) => { f.set("support/b", new Uint8Array([2])); return f; } }, root.expectedGeneration);
    if (second.status !== "committed") throw new Error("second commit failed");
    for (const [path, bytes] of copied) adapter.files.set(path, bytes);
    adapter.dirs.add(firstDir);

    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("fork_detected");
  });
});
