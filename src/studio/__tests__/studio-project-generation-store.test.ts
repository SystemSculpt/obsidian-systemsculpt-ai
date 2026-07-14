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
  readonly corruptReads = new Set<string>();

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
    if (this.corruptReads.has(path)) {
      const corrupted = value.slice();
      corrupted[0] = corrupted[0] ^ 0xff;
      return corrupted.buffer;
    }
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
const TEST_HASH_A = "a".repeat(64);
const TEST_HASH_B = "b".repeat(64);
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

  it("rejects non-closed legacy schema and missing referenced policy before adoption", async () => {
    const extraAdapter = new MemoryAdapter();
    const withExtra = JSON.stringify({ ...JSON.parse(legacyProject), unexpected: true });
    extraAdapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(withExtra));
    expect((await new StudioProjectGenerationStore(extraAdapter).discoverAndAdopt(locator)).status).toBe("invalid_candidate");

    const missingPolicy = new MemoryAdapter();
    missingPolicy.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(legacyProject));
    expect((await new StudioProjectGenerationStore(missingPolicy).discoverAndAdopt(locator)).status).toBe("invalid_candidate");
    expect([...missingPolicy.files.keys()].some((path) => path.startsWith(".systemsculpt/studio/projects/"))).toBe(false);
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

  it("preserves changed document bytes when the selected-token sidecar hashes are stale", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"Externally edited"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));
    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("read_only");
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(changed);
  });

  it("ingests an external document edit only with a closed-API marker hashing exact candidate bytes", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Trusted external edit"'));
    const policy = adapter.files.get("SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json")!;
    const marker = await store.createExternalCandidateMarker({ projectId: "project_alpha", expectedGeneration: root.expectedGeneration, projectDocument: changed, supportFiles: [{ supportRelativePath: "policy/grants.json", bytes: policy }] });
    adapter.files.set(locator.vaultRelativeProjectPath, changed);
    adapter.files.set(`${locator.vaultRelativeProjectPath}.identity.json`, new TextEncoder().encode(marker));
    adapter.files.set("SystemSculpt/Studio/Alpha.systemsculpt-assets/.studio-projection.json", new TextEncoder().encode(marker));
    const opened = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
    if (opened.status === "ready") expect(opened.expectedGeneration.revision).toBe(1);
  });

  it("preserves support edits whose unchanged sidecar hashes are stale", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const policyPath = "SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json";
    adapter.files.set(policyPath, new TextEncoder().encode("{\"schema\":\"studio.policy.v1\",\"external\":true}\n"));
    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("read_only");
    expect(new TextDecoder().decode(adapter.files.get(policyPath)!)).toContain("external");
  });

  it("preserves partial support replacement as read-only", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    adapter.files.delete("SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json");
    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("read_only");
  });

  it("preserves changed bytes with missing or stale markers instead of repairing over them", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"Untrusted edit"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));
    adapter.files.delete(`${locator.vaultRelativeProjectPath}.identity.json`);

    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("read_only");
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(changed);
  });

  it("forks when a second locator claims the same project ID even with identical bytes", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const other = { vaultRelativeProjectPath: "SystemSculpt/Studio/Copy.systemsculpt" };
    adapter.files.set(other.vaultRelativeProjectPath, new TextEncoder().encode(legacyProject));
    const adopted = await new StudioProjectGenerationStore(adapter).discoverAndAdopt(other);
    expect(adopted.status).toBe("fork_detected");
  });

  it("does not retire the old rename projection until destination fresh-read validation passes", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };
    adapter.corruptReads.add(destination.vaultRelativeProjectPath);
    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename", projectId: "project_alpha", locator: destination,
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);
    expect(renamed.status).toBe("storage_unavailable");
    expect(adapter.files.has(locator.vaultRelativeProjectPath)).toBe(true);
  });

  it("projection repair removes stale support files and validates exact output", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const stale = "SystemSculpt/Studio/Alpha.systemsculpt-assets/stale.txt";
    adapter.files.set(stale, new TextEncoder().encode("stale"));
    adapter.files.delete(locator.vaultRelativeProjectPath);
    const repaired = await new StudioProjectGenerationStore(adapter).repairProjection("project_alpha");
    expect(repaired.status).toBe("ready");
    expect(adapter.files.has(stale)).toBe(false);
  });

  it("rejects unmanifested generation files and bounded scan overflow", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const generationDir = [...adapter.dirs].find((path) => path.includes(`/0-${root.expectedGeneration.generationHash}`));
    if (!generationDir) throw new Error("missing generation");
    adapter.files.set(`${generationDir}/files/unmanifested.bin`, new Uint8Array([9]));
    expect((await new StudioProjectGenerationStore(adapter).recover("project_alpha")).status).toBe("recovery_required");

    adapter.files.delete(`${generationDir}/files/unmanifested.bin`);
    adapter.dirs.add(".systemsculpt/studio/projects/project_alpha/generations/extra-a");
    adapter.dirs.add(".systemsculpt/studio/projects/project_alpha/generations/extra-b");
    expect((await new StudioProjectGenerationStore(adapter, { maxCandidates: 2 }).recover("project_alpha")).status).toBe("recovery_required");
  });

  it("keeps secret sentinels out of manifest and descriptor metadata", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const secretProject = legacyProject.replace('"Alpha"', '"SECRET_SENTINEL"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(secretProject));
    const result = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (result.status !== "committed") throw new Error("adoption failed");
    const metadata = [...adapter.files].filter(([path]) => path.endsWith("manifest.json") || path.endsWith("commit.json")).map(([, bytes]) => new TextDecoder().decode(bytes)).join("\n");
    expect(metadata).not.toContain("SECRET_SENTINEL");
  });

  it("publishes a whole generation with exact revision+hash CAS and rejects stale writers", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const adopted = await store.discoverAndAdopt(locator);
    if (adopted.status !== "committed") throw new Error("adoption failed");

    const committed = await store.commitWholeGeneration({
      kind: "replace_project",
      projectId: "project_alpha",
      reason: "discrete_save",
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Beta"')),
    }, adopted.expectedGeneration);
    expect(committed.status).toBe("committed");

    const stale = await store.commitWholeGeneration({
      kind: "replace_project",
      projectId: "project_alpha",
      reason: "autosave",
      projectDocument: new TextEncoder().encode(legacyProject),
    }, adopted.expectedGeneration);
    expect(stale.status).toBe("stale_revision");
  });

  it("recovers deterministically after every descendant publication write cut", async () => {
    for (let cut = 0; cut < 12; cut += 1) {
      const adapter = new MemoryAdapter(); await seedLegacy(adapter);
      const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
      if (root.status !== "committed") throw new Error("adoption failed");
      adapter.armFailure(cut);
      await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).commitWholeGeneration({
        kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `aa/${TEST_HASH_A}.bin`, bytes: new Uint8Array([1, 2, 3]) },
      }, root.expectedGeneration);
      adapter.armFailure(null);
      const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
      expect(recovered.status).toBe("ready");
      if (recovered.status === "ready") expect([0, 1]).toContain(recovered.expectedGeneration.revision);
    }
  });

  it("never exposes a torn generation after restart", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const adopted = await store.discoverAndAdopt(locator);
    if (adopted.status !== "committed") throw new Error("adoption failed");
    adapter.armFailure(1);
    const result = await store.commitWholeGeneration({
      kind: "put_asset",
      projectId: "project_alpha",
      asset: { contentAddressedPath: `aa/${TEST_HASH_A}.bin`, bytes: new Uint8Array([0, 1, 2, 255]) },
    }, adopted.expectedGeneration);
    expect(result.status).toBe("storage_unavailable");
    adapter.armFailure(null);

    const reopened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") expect(reopened.expectedGeneration).toEqual(adopted.expectedGeneration);
  });

  it("ignores corrupted newest manifest and descriptor candidates", async () => {
    for (const target of ["manifest.json", "commit.json"]) {
      const adapter = new MemoryAdapter(); await seedLegacy(adapter);
      const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
      const root = await store.discoverAndAdopt(locator);
      if (root.status !== "committed") throw new Error("adoption failed");
      const child = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).commitWholeGeneration({ kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `aa/${TEST_HASH_A}.bin`, bytes: new Uint8Array([1]) } }, root.expectedGeneration);
      if (child.status !== "committed") throw new Error("commit failed");
      const dir = [...adapter.dirs].find((path) => path.includes(`/1-${child.expectedGeneration.generationHash}`));
      if (!dir) throw new Error("missing child");
      const path = `${dir}/${target}`; const bytes = adapter.files.get(path)!; bytes[0] ^= 1;
      const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
      expect(recovered.status).toBe("ready");
      if (recovered.status === "ready") expect(recovered.expectedGeneration).toEqual(root.expectedGeneration);
    }
  });

  it("detects two valid children as a fork instead of choosing a winner", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const first = await store.commitWholeGeneration({ kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `aa/${TEST_HASH_A}.bin`, bytes: new Uint8Array([1]) } }, root.expectedGeneration);
    if (first.status !== "committed") throw new Error("first commit failed");
    const firstDir = [...adapter.dirs].find((path) => path.includes(`/1-${first.expectedGeneration.generationHash}`));
    if (!firstDir) throw new Error("missing first generation");
    const copied = new Map([...adapter.files].filter(([path]) => path.startsWith(firstDir)).map(([path, bytes]) => [path, bytes.slice()]));
    await adapter.remove(firstDir);
    const second = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).commitWholeGeneration({ kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `bb/${TEST_HASH_B}.bin`, bytes: new Uint8Array([2]) } }, root.expectedGeneration);
    if (second.status !== "committed") throw new Error("second commit failed");
    for (const [path, bytes] of copied) adapter.files.set(path, bytes);
    adapter.dirs.add(firstDir);

    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("fork_detected");
  });
});
