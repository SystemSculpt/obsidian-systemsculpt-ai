import { App, TFile } from "obsidian";
import {
  StudioProjectGenerationStore,
  validateProjectionLocator,
  type StudioGenerationAdapter,
} from "../persistence/StudioProjectGenerationStore";
import { sha256HexFromBytesPortable } from "../hash";
import { parseStudioProject, serializeStudioProject } from "../schema";
import { FileOperations } from "../../tools/vault/tools/FileOperations";

class MemoryAdapter implements StudioGenerationAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  failAfterWrites: number | null = null;
  afterWrite: ((path: string, bytes: Uint8Array) => Promise<void> | void) | null = null;
  private writes = 0;
  readonly corruptReads = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

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
    const bytes = new TextEncoder().encode(data);
    this.files.set(path, bytes);
    await this.afterWrite?.(path, bytes.slice());
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.cut();
    const bytes = new Uint8Array(data.slice(0));
    this.files.set(path, bytes);
    await this.afterWrite?.(path, bytes.slice());
  }
  async compareAndSwapText(path: string, expectedData: string, nextData: string): Promise<boolean> {
    const currentData = await this.read(path);
    if (currentData !== expectedData) return false;
    await this.write(path, nextData);
    return true;
  }
  async copyFileIfAbsent(sourcePath: string, destinationPath: string): Promise<boolean> {
    const source = this.files.get(sourcePath);
    if (!source) throw new Error(`missing ${sourcePath}`);
    if (this.files.has(destinationPath)) return false;
    this.cut();
    const bytes = source.slice();
    this.files.set(destinationPath, bytes);
    await this.afterWrite?.(destinationPath, bytes.slice());
    return true;
  }
  async movePath(sourcePath: string, destinationPath: string): Promise<void> {
    if (this.files.has(destinationPath) || this.dirs.has(destinationPath)) {
      throw new Error(`destination exists ${destinationPath}`);
    }
    const sourceFile = this.files.get(sourcePath);
    if (sourceFile) {
      this.files.delete(sourcePath);
      this.files.set(destinationPath, sourceFile);
      return;
    }
    const sourcePrefix = `${sourcePath}/`;
    const matchingFiles = [...this.files].filter(([path]) => path.startsWith(sourcePrefix));
    const matchingDirs = [...this.dirs].filter((path) => path === sourcePath || path.startsWith(sourcePrefix));
    if (matchingFiles.length === 0 && matchingDirs.length === 0) {
      throw new Error(`missing ${sourcePath}`);
    }
    for (const [path, bytes] of matchingFiles) {
      this.files.delete(path);
      this.files.set(`${destinationPath}/${path.slice(sourcePrefix.length)}`, bytes);
    }
    for (const path of matchingDirs.sort((left, right) => left.length - right.length)) {
      this.dirs.delete(path);
      const suffix = path === sourcePath ? "" : path.slice(sourcePrefix.length);
      this.dirs.add(suffix ? `${destinationPath}/${suffix}` : destinationPath);
    }
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

  it("does not overwrite a create destination that appears after availability was checked", async () => {
    const adapter = new MemoryAdapter();
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    expect(await store.isProjectionLocatorAvailable(locator)).toBe(true);

    const agentDestination = "agent-created destination\n";
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(agentDestination));

    const created = await store.create({
      kind: "create",
      projectId: "project_alpha",
      projectDocument: new TextEncoder().encode(legacyProject),
      policyDocument: new TextEncoder().encode('{"schema":"studio.policy.v1"}\n'),
      projectManifest: new TextEncoder().encode("{}\n"),
    }, locator);

    expect(created.status).toBe("read_only");
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(agentDestination);
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

  it("retries every interrupted uncommitted root publication without deleting legacy bytes", async () => {
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

      const partialCandidates = [...adapter.dirs].filter((path) =>
        path.startsWith(".systemsculpt/studio/projects/project_alpha/generations/")
      );
      const retried = await new StudioProjectGenerationStore(adapter, {
        now: () => "2026-07-11T02:02:03.004Z",
      }).discoverAndAdopt(locator);
      expect(retried.status).toBe("committed");
      expect((await new StudioProjectGenerationStore(adapter).recover("project_alpha")).status).toBe("ready");
      expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(legacyProject);
      for (const path of partialCandidates) expect(adapter.dirs.has(path)).toBe(true);
    }
  });

  it("does not retry root adoption over an invalid committed authority candidate", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const candidate = `.systemsculpt/studio/projects/project_alpha/generations/0-${TEST_HASH_A}`;
    adapter.dirs.add(candidate);
    adapter.files.set(`${candidate}/commit.json`, new TextEncoder().encode("{}"));

    const retried = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).discoverAndAdopt(locator);

    expect(retried).toMatchObject({
      status: "recovery_required",
      message: expect.stringContaining("No validated generation exists"),
    });
    expect([...adapter.files.keys()].filter((path) => path.endsWith("/manifest.json"))).toHaveLength(0);
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(legacyProject);
  });

  it("commits a valid direct document edit exactly once", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"Externally edited"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));
    const opened = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("external sync failed");
    expect(opened.expectedGeneration.revision).toBe(1);
    expect(opened.generation.metadata.commandKind).toBe("external_sync");
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(changed);

    const reopened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") expect(reopened.expectedGeneration).toEqual(opened.expectedGeneration);
    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(2);
  });

  it("coalesces concurrent opens for one direct edit into exactly one generation", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"One concurrent agent edit"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));

    const [first, second] = await Promise.all([
      new StudioProjectGenerationStore(adapter, {
        now: () => "2026-07-11T02:02:03.004Z",
      }).open("project_alpha", locator),
      new StudioProjectGenerationStore(adapter, {
        now: () => "2026-07-11T02:02:03.004Z",
      }).open("project_alpha", locator),
    ]);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.expectedGeneration).toEqual(second.expectedGeneration);
    expect(first.expectedGeneration.revision).toBe(1);
    expect(first.generation.metadata.commandKind).toBe("external_sync");
    expect(second.generation.metadata.commandKind).toBe("external_sync");
    expect(new TextDecoder().decode(first.generation.files.get("project.systemsculpt"))).toBe(changed);
    expect(new TextDecoder().decode(second.generation.files.get("project.systemsculpt"))).toBe(changed);
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(changed);

    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(2);
  });

  it("round-trips an ordinary ChatView file-tool edit into one external_sync generation", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");

    const app = new App();
    const file = new TFile({ path: locator.vaultRelativeProjectPath });
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockImplementation(async () => adapter.read(locator.vaultRelativeProjectPath));
    (app.vault as any).process = jest.fn(async (_file: TFile, update: (content: string) => string) => {
      const updated = update(await adapter.read(locator.vaultRelativeProjectPath));
      await adapter.write(locator.vaultRelativeProjectPath, updated);
      return updated;
    });
    (app.vault.modify as jest.Mock).mockImplementation(async (_file: TFile, content: string) => {
      await adapter.write(locator.vaultRelativeProjectPath, content);
    });

    const toolResult = await new FileOperations(app, ["/"]).editFile({
      path: locator.vaultRelativeProjectPath,
      edits: [{ oldText: '"name": "Alpha"', newText: '"name": "Agent-authored canvas"' }],
    } as any);
    expect(toolResult.appliedCount).toBe(1);

    const opened = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("external sync failed");
    expect(opened.expectedGeneration.revision).toBe(1);
    expect(opened.generation.metadata.commandKind).toBe("external_sync");
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toContain("Agent-authored canvas");

    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(2);
  });

  it("leaves malformed direct edits untouched and authority unchanged", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const malformed = "{ not valid json\n";
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(malformed));

    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("invalid_candidate");
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(malformed);
    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") expect(recovered.expectedGeneration).toEqual(root.expectedGeneration);
  });

  it("rejects parser-normalizable direct edits without changing bytes or history", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const rawDocument = JSON.parse(legacyProject);
    rawDocument.graph.nodes.push({
      id: "node_input",
      kind: "studio.input",
      version: "1.0.0",
      title: "Input",
      position: { x: "80", y: 120 },
      config: { value: "hello" },
      continueOnError: false,
      disabled: false,
    });
    const malformedButNormalizable = `${JSON.stringify(rawDocument, null, 2)}\n`;
    adapter.files.set(
      locator.vaultRelativeProjectPath,
      new TextEncoder().encode(malformedButNormalizable)
    );

    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);

    expect(opened.status).toBe("invalid_candidate");
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(malformedButNormalizable);
    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") {
      expect(recovered.expectedGeneration).toEqual(root.expectedGeneration);
    }
    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(1);
  });

  it("rejects direct edits to Studio-owned project fields without changing bytes or history", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const rawDocument = JSON.parse(legacyProject);
    rawDocument.settings.retention.maxRuns = 7;
    const changedStableField = `${JSON.stringify(rawDocument, null, 2)}\n`;
    adapter.files.set(
      locator.vaultRelativeProjectPath,
      new TextEncoder().encode(changedStableField)
    );

    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);

    expect(opened.status).toBe("invalid_candidate");
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(changedStableField);
    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") {
      expect(recovered.expectedGeneration).toEqual(root.expectedGeneration);
    }
    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(1);
  });

  it("loads an older valid project file and regenerates missing authoring references", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");

    const canonicalDocument = serializeStudioProject(parseStudioProject(legacyProject));
    const canonical = await store.commitWholeGeneration({
      kind: "replace_project",
      projectId: "project_alpha",
      reason: "discrete_save",
      projectDocument: new TextEncoder().encode(canonicalDocument),
    }, root.expectedGeneration);
    if (canonical.status !== "committed") throw new Error("canonical save failed");

    const restoredDocument = JSON.parse(canonicalDocument);
    restoredDocument.name = "Restored older backup";
    delete restoredDocument.agentGuide;
    delete restoredDocument.nodeKindReference;
    adapter.files.set(
      locator.vaultRelativeProjectPath,
      new TextEncoder().encode(`${JSON.stringify(restoredDocument, null, 2)}\n`)
    );

    const opened = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).open("project_alpha", locator);

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    expect(opened.expectedGeneration.revision).toBe(2);
    expect(opened.generation.metadata.commandKind).toBe("external_sync");
    const repaired = JSON.parse(await adapter.read(locator.vaultRelativeProjectPath));
    expect(repaired.name).toBe("Restored older backup");
    expect(repaired.agentGuide?.schema).toBe("studio.agent-guide.v1");
    expect(repaired.nodeKindReference?.schema).toBe("studio.node-kind-reference.v1");
  });

  it("reconciles a valid direct edit on first open after restart", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"Restart edit"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));

    const adopted = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).discoverAndAdopt(locator);
    expect(adopted.status).toBe("committed");
    if (adopted.status === "committed") {
      expect(adopted.expectedGeneration.revision).toBe(1);
      expect(new TextDecoder().decode(adopted.generation.files.get("project.systemsculpt"))).toBe(changed);
    }
  });

  it("does not overwrite an external edit with a local generation commit", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const external = legacyProject.replace('"Alpha"', '"External wins the file"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(external));

    const localCommit = await store.commitWholeGeneration({
      kind: "replace_project",
      projectId: "project_alpha",
      reason: "autosave",
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Unsaved local edit"')),
    }, root.expectedGeneration);

    expect(localCommit.status).toBe("read_only");
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(external);
  });

  it("does not overwrite an agent edit that lands after a Studio save has begun", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");

    let descriptorReached!: () => void;
    let allowDescriptorWriteToFinish!: () => void;
    const descriptorWasWritten = new Promise<void>((resolve) => { descriptorReached = resolve; });
    const descriptorWriteMayFinish = new Promise<void>((resolve) => { allowDescriptorWriteToFinish = resolve; });
    adapter.afterWrite = async (path) => {
      if (!/\/generations\/1-[0-9a-f]{64}\/commit\.json$/.test(path)) return;
      adapter.afterWrite = null;
      descriptorReached();
      await descriptorWriteMayFinish;
    };

    const studioSave = store.commitWholeGeneration({
      kind: "replace_project",
      projectId: "project_alpha",
      reason: "autosave",
      projectDocument: new TextEncoder().encode(
        legacyProject.replace('"Alpha"', '"Studio save already in flight"')
      ),
    }, root.expectedGeneration);

    await descriptorWasWritten;
    const agentEdit = legacyProject.replace('"Alpha"', '"Agent edit wins the visible file"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(agentEdit));
    allowDescriptorWriteToFinish();

    const saveResult = await studioSave;
    expect(saveResult.status).not.toBe("committed");
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(agentEdit);
  });

  it("repairs private support edits without making the project file stale", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const policyPath = "SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json";
    adapter.files.set(policyPath, new TextEncoder().encode("{\"schema\":\"studio.policy.v1\",\"external\":true}\n"));
    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
    expect(new TextDecoder().decode(adapter.files.get(policyPath)!)).not.toContain("external");
  });

  it("repairs missing private support files automatically", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    adapter.files.delete("SystemSculpt/Studio/Alpha.systemsculpt-assets/policy/grants.json");
    const opened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
  });

  it("accepts a valid one-file edit without requiring legacy metadata files", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const changed = legacyProject.replace('"Alpha"', '"Untrusted edit"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(changed));
    adapter.files.set(`${locator.vaultRelativeProjectPath}.identity.json`, new TextEncoder().encode("legacy"));
    adapter.files.set("SystemSculpt/Studio/Alpha.systemsculpt-assets/.studio-projection.json", new TextEncoder().encode("legacy"));

    const opened = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).open("project_alpha", locator);
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") throw new Error("metadata repair failed");
    expect(opened.expectedGeneration.revision).toBe(1);
    expect(new TextDecoder().decode(opened.generation.files.get("project.systemsculpt"))).toBe(changed);
    expect(new TextDecoder().decode(adapter.files.get(locator.vaultRelativeProjectPath)!)).toBe(changed);
    expect(adapter.files.has(`${locator.vaultRelativeProjectPath}.identity.json`)).toBe(false);
    expect(adapter.files.has("SystemSculpt/Studio/Alpha.systemsculpt-assets/.studio-projection.json")).toBe(false);

    const reopened = await new StudioProjectGenerationStore(adapter).open("project_alpha", locator);
    expect(reopened.status).toBe("ready");
    if (reopened.status === "ready") {
      expect(reopened.expectedGeneration).toEqual(opened.expectedGeneration);
      expect(reopened.projectionStatus).toBe("matching");
    }
    const generations = await adapter.list(".systemsculpt/studio/projects/project_alpha/generations");
    expect(generations.folders).toHaveLength(2);
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

  it("adopts an ordinary file rename on first open after restart", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Moved.systemsculpt" };
    await adapter.movePath(locator.vaultRelativeProjectPath, destination.vaultRelativeProjectPath);

    const adopted = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).discoverAndAdopt(destination);

    expect(adopted.status).toBe("committed");
    if (adopted.status !== "committed") return;
    expect(adopted.expectedGeneration.revision).toBe(1);
    expect(adopted.generation.metadata.projection.canonicalPath).toBe(
      destination.vaultRelativeProjectPath
    );
    const document = JSON.parse(await adapter.read(destination.vaultRelativeProjectPath));
    expect(document.name).toBe("Moved");
    expect(document.permissionsRef.policyPath).toBe(
      "SystemSculpt/Studio/Moved.systemsculpt-assets/policy/grants.json"
    );
  });

  it("adopts a folder move when the previous parent no longer exists", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const root = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    }).discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const previousParent = "SystemSculpt/Studio";
    const movedParent = "SystemSculpt/Moved Studio";
    const destination = {
      vaultRelativeProjectPath: `${movedParent}/Alpha.systemsculpt`,
    };
    await adapter.movePath(previousParent, movedParent);
    const originalList = adapter.list.bind(adapter);
    adapter.list = jest.fn(async (path) => {
      if (path === previousParent) throw new Error(`missing ${path}`);
      return originalList(path);
    });

    const adopted = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).discoverAndAdopt(destination);

    expect(adopted.status).toBe("committed");
    if (adopted.status !== "committed") return;
    expect(adopted.expectedGeneration.revision).toBe(1);
    expect(adopted.generation.metadata.projection.canonicalPath).toBe(
      destination.vaultRelativeProjectPath
    );
    expect(adapter.list).not.toHaveBeenCalledWith(previousParent);
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

  it("does not overwrite a rename destination that appears after availability was checked", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };
    expect(await store.isProjectionLocatorAvailable(destination)).toBe(true);

    const agentDestination = legacyProject.replace('"Alpha"', '"Agent owns destination"');
    adapter.files.set(destination.vaultRelativeProjectPath, new TextEncoder().encode(agentDestination));

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("read_only");
    expect(await adapter.read(destination.vaultRelativeProjectPath)).toBe(agentDestination);
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(legacyProject);
  });

  it("publishes an in-place logical rename through visible-file CAS", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const copyFileIfAbsent = jest.spyOn(adapter, "copyFileIfAbsent");
    const compareAndSwapText = jest.spyOn(adapter, "compareAndSwapText");

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator,
      projectDocument: new TextEncoder().encode(legacyProject),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("committed");
    if (renamed.status !== "committed") return;
    expect(renamed.expectedGeneration.revision).toBe(1);
    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(legacyProject);
    expect(compareAndSwapText).toHaveBeenCalledWith(
      locator.vaultRelativeProjectPath,
      legacyProject,
      legacyProject
    );
    expect(copyFileIfAbsent).not.toHaveBeenCalled();
  });

  it("adopts a project file already moved by an ordinary vault rename", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };
    await adapter.movePath(locator.vaultRelativeProjectPath, destination.vaultRelativeProjectPath);
    const renamedDocument = legacyProject.replace('"Alpha"', '"Renamed"');

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      destinationProjectDocumentBeforeRename: new TextEncoder().encode(legacyProject),
      projectDocument: new TextEncoder().encode(renamedDocument),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("committed");
    expect(await adapter.read(destination.vaultRelativeProjectPath)).toBe(renamedDocument);
    expect(adapter.files.has(locator.vaultRelativeProjectPath)).toBe(false);
  });

  it("does not overwrite a moved project that changes again before rename adoption", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };
    await adapter.movePath(locator.vaultRelativeProjectPath, destination.vaultRelativeProjectPath);
    const agentEdit = legacyProject.replace('"Alpha"', '"Agent edited moved file"');
    adapter.files.set(destination.vaultRelativeProjectPath, new TextEncoder().encode(agentEdit));

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      destinationProjectDocumentBeforeRename: new TextEncoder().encode(legacyProject),
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("read_only");
    expect(await adapter.read(destination.vaultRelativeProjectPath)).toBe(agentEdit);
  });

  it("moves the old visible project into private recovery after a successful logical rename", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("committed");
    expect(adapter.files.has(locator.vaultRelativeProjectPath)).toBe(false);
    expect(await adapter.read(destination.vaultRelativeProjectPath)).toContain('"Renamed"');
    expect(
      [...adapter.files.keys()].some((path) =>
        path.startsWith(".systemsculpt/studio/projects/project_alpha/retired/")
      )
    ).toBe(true);
  });

  it("does not delete an agent edit that lands on the source path during rename", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };

    let descriptorReached!: () => void;
    let allowRenameToFinish!: () => void;
    const descriptorWasWritten = new Promise<void>((resolve) => { descriptorReached = resolve; });
    const renameMayFinish = new Promise<void>((resolve) => { allowRenameToFinish = resolve; });
    adapter.afterWrite = async (path) => {
      if (!/\/generations\/1-[0-9a-f]{64}\/commit\.json$/.test(path)) return;
      adapter.afterWrite = null;
      descriptorReached();
      await renameMayFinish;
    };

    const rename = store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    await descriptorWasWritten;
    const agentEdit = legacyProject.replace('"Alpha"', '"Agent kept editing the original path"');
    adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(agentEdit));
    allowRenameToFinish();
    await rename;

    expect(await adapter.read(locator.vaultRelativeProjectPath)).toBe(agentEdit);
  });

  it("surfaces a rename when raced agent bytes cannot be restored visibly", async () => {
    const adapter = new MemoryAdapter(); await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T01:02:03.004Z",
    });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");
    const destination = { vaultRelativeProjectPath: "SystemSculpt/Studio/Renamed.systemsculpt" };
    const agentEdit = legacyProject.replace('"Alpha"', '"Agent edit during rename"');
    adapter.afterWrite = async (path) => {
      if (!/\/generations\/1-[0-9a-f]{64}\/commit\.json$/.test(path)) return;
      adapter.afterWrite = null;
      adapter.files.set(locator.vaultRelativeProjectPath, new TextEncoder().encode(agentEdit));
    };

    const originalCopy = adapter.copyFileIfAbsent.bind(adapter);
    adapter.copyFileIfAbsent = jest.fn(async (sourcePath, destinationPath) => {
      if (sourcePath.includes("/retired/") && destinationPath === locator.vaultRelativeProjectPath) {
        throw new Error("restore copy unavailable");
      }
      return originalCopy(sourcePath, destinationPath);
    });
    const originalMove = adapter.movePath.bind(adapter);
    let movedIntoRetired = false;
    adapter.movePath = jest.fn(async (sourcePath, destinationPath) => {
      if (destinationPath.includes("/retired/") && sourcePath === locator.vaultRelativeProjectPath) {
        movedIntoRetired = true;
        return originalMove(sourcePath, destinationPath);
      }
      if (movedIntoRetired && destinationPath === locator.vaultRelativeProjectPath) {
        throw new Error("restore move unavailable");
      }
      return originalMove(sourcePath, destinationPath);
    });

    const renamed = await store.commitWholeGeneration({
      kind: "logical_rename",
      projectId: "project_alpha",
      locator: destination,
      projectDocument: new TextEncoder().encode(legacyProject.replace('"Alpha"', '"Renamed"')),
      projectManifest: new TextEncoder().encode("{}"),
    }, root.expectedGeneration);

    expect(renamed.status).toBe("storage_unavailable");
    expect(
      [...adapter.files].some(([path, bytes]) =>
        path.includes("/retired/") && new TextDecoder().decode(bytes) === agentEdit
      )
    ).toBe(true);
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

  it("commits and reopens imported support files written by Studio", async () => {
    const adapter = new MemoryAdapter();
    await seedLegacy(adapter);
    const store = new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T01:02:03.004Z" });
    const root = await store.discoverAndAdopt(locator);
    if (root.status !== "committed") throw new Error("adoption failed");

    const imported = await new StudioProjectGenerationStore(adapter, {
      now: () => "2026-07-11T02:02:03.004Z",
    }).commitWholeGeneration({
      kind: "put_support_file",
      projectId: "project_alpha",
      file: {
        supportRelativePath: "imports/context.txt",
        bytes: new TextEncoder().encode("source context\n"),
      },
    }, root.expectedGeneration);

    expect(imported.status).toBe("committed");
    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("ready");
    if (recovered.status !== "ready") throw new Error("support generation did not reopen");
    expect(recovered.generation.metadata.commandKind).toBe("support");
    expect(new TextDecoder().decode(recovered.generation.files.get("support/imports/context.txt"))).toBe("source context\n");
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
    const rootProjection = new Map(
      [...adapter.files]
        .filter(([path]) => !path.startsWith(".systemsculpt/studio/projects/"))
        .map(([path, bytes]) => [path, bytes.slice()])
    );
    const first = await store.commitWholeGeneration({ kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `aa/${TEST_HASH_A}.bin`, bytes: new Uint8Array([1]) } }, root.expectedGeneration);
    if (first.status !== "committed") throw new Error("first commit failed");
    const firstDir = [...adapter.dirs].find((path) => path.includes(`/1-${first.expectedGeneration.generationHash}`));
    if (!firstDir) throw new Error("missing first generation");
    const copied = new Map([...adapter.files].filter(([path]) => path.startsWith(firstDir)).map(([path, bytes]) => [path, bytes.slice()]));
    await adapter.remove(firstDir);
    for (const path of [...adapter.files.keys()]) if (!path.startsWith(".systemsculpt/studio/projects/")) adapter.files.delete(path);
    for (const [path, bytes] of rootProjection) adapter.files.set(path, bytes);
    const second = await new StudioProjectGenerationStore(adapter, { now: () => "2026-07-11T02:02:03.004Z" }).commitWholeGeneration({ kind: "put_asset", projectId: "project_alpha", asset: { contentAddressedPath: `bb/${TEST_HASH_B}.bin`, bytes: new Uint8Array([2]) } }, root.expectedGeneration);
    if (second.status !== "committed") throw new Error("second commit failed");
    for (const [path, bytes] of copied) adapter.files.set(path, bytes);
    adapter.dirs.add(firstDir);

    const recovered = await new StudioProjectGenerationStore(adapter).recover("project_alpha");
    expect(recovered.status).toBe("fork_detected");
  });
});
