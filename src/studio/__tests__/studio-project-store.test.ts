import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { StudioEditorRevision } from "../document/StudioEditorRevision";
import type { StudioLegacyOriginalCopy } from "../document/StudioProjectDocument";
import { StudioProjectSession } from "../StudioProjectSession";
import { serializeStudioProject } from "../schema";
import { cloneStudioProjectSnapshot } from "../StudioProjectSnapshots";
import { StudioProjectStore } from "../StudioProjectStore";
import { StudioService } from "../StudioService";
import { createManagedCapabilityGraphStub, getManagedStudioTestVaultName } from "./managed-capability-graph.stub";
import { deriveStudioAssetsDir, deriveStudioPolicyPath, sanitizeStudioProjectName } from "../paths";

// Spy on the CJS module object so `new Notice(...)` in the service is intercepted.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidian = require("obsidian");

type InMemoryApp = {
  vault: {
    adapter: {
      exists: (path: string) => Promise<boolean>;
      mkdir: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
      writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
      read: (path: string) => Promise<string>;
      readBinary: (path: string) => Promise<ArrayBuffer>;
      process: (path: string, update: (data: string) => string) => Promise<string>;
      copy: (source: string, destination: string) => Promise<void>;
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      remove: (path: string) => Promise<void>;
      rename: (source: string, destination: string) => Promise<void>;
    };
    getAbstractFileByPath?: (path: string) => unknown;
    getFiles: () => Array<{ path: string }>;
  };
};

/** Authored and copied files. */
const authoredFiles = (files: Map<string, string>) => [...files.keys()];
/** The merge record a published project file carries. */
const mergeRecord = (raw: string) => JSON.parse(raw).merge as { deleted: Record<string, string>; stamps: Record<string, unknown> };
/** The canonical canvas text of a published file, without its merge record: what an agent revision names. */
const canonicalText = (raw: string) => { const { merge: _merge, ...content } = JSON.parse(raw); return `${JSON.stringify(content, null, 2)}\n`; };

function createStore(options?: { existingFiles?: string[]; existingDirs?: string[]; onLegacyOriginalCopied?: (copy: StudioLegacyOriginalCopy) => void }) {
  const existingFiles = options?.existingFiles || [];
  const existingDirs = options?.existingDirs || [];
  const files = new Map<string, string>();
  for (const filePath of existingFiles) {
    files.set(filePath, "{}");
  }
  const dirs = new Set<string>(existingDirs);

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || dirs.has(path)),
    mkdir: jest.fn(async (path: string) => {
      dirs.add(path);
    }),
    write: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value === "undefined") {
        throw new Error(`File not found: ${path}`);
      }
      return value;
    }),
    writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, new TextDecoder().decode(data));
    }),
    readBinary: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (typeof value === "undefined") throw new Error(`File not found: ${path}`);
      return new TextEncoder().encode(value).buffer;
    }),
    process: jest.fn(async (path: string, update: (data: string) => string) => {
      const value = files.get(path);
      if (typeof value === "undefined") throw new Error(`File not found: ${path}`);
      const nextValue = update(value);
      files.set(path, nextValue);
      return nextValue;
    }),
    copy: jest.fn(async (source: string, destination: string) => {
      const value = files.get(source);
      if (typeof value === "undefined") throw new Error(`File not found: ${source}`);
      if (files.has(destination) || dirs.has(destination)) {
        throw new Error(`Path already exists: ${destination}`);
      }
      files.set(destination, value);
    }),
    list: jest.fn(async (path: string) => {
      const prefix = path ? `${path}/` : "";
      const listedFiles = Array.from(files.keys()).filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"));
      const listedFolders = new Set(Array.from(dirs).filter((dir) => dir.startsWith(prefix) && dir !== path).map((dir) => `${prefix}${dir.slice(prefix.length).split("/")[0]}`));
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const tail = file.slice(prefix.length);
        if (tail.includes("/")) listedFolders.add(`${prefix}${tail.split("/")[0]}`);
      }
      return { files: listedFiles.sort(), folders: [...listedFolders].sort() };
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    }),
    rename: jest.fn(async (source: string, destination: string) => {
      if (files.has(source)) {
        const value = files.get(source)!;
        files.delete(source);
        files.set(destination, value);
        return;
      }

      if (!dirs.has(source)) {
        throw new Error(`Path not found: ${source}`);
      }

      const dirRenames = Array.from(dirs)
        .filter((path) => path === source || path.startsWith(`${source}/`))
        .sort((left, right) => left.length - right.length);
      for (const oldDir of dirRenames) {
        dirs.delete(oldDir);
        const nextDir = oldDir === source ? destination : `${destination}${oldDir.slice(source.length)}`;
        dirs.add(nextDir);
      }

      const fileRenames = Array.from(files.entries())
        .filter(([path]) => path.startsWith(`${source}/`))
        .sort(([left], [right]) => left.length - right.length);
      for (const [oldPath, value] of fileRenames) {
        files.delete(oldPath);
        files.set(`${destination}${oldPath.slice(source.length)}`, value);
      }
    }),
  };

  const app: InMemoryApp = {
    vault: {
      adapter,
      getAbstractFileByPath: () => null,
      getFiles: () => Array.from(files.keys()).map((path) => ({ path })),
    },
  };

  const storeOptions = { onLegacyOriginalCopied: options?.onLegacyOriginalCopied };
  return {
    adapter,
    app,
    dirs,
    files,
    store: new StudioProjectStore(app as any, storeOptions),
    reopen: () => new StudioProjectStore(app as any, storeOptions),
  };
}

describe("StudioProjectStore", () => {
  it("sanitizes human-readable names while removing path-breaking characters", () => {
    expect(sanitizeStudioProjectName("  Launch: Plan / Alpha?  ")).toBe("Launch Plan Alpha");
    expect(sanitizeStudioProjectName("")).toBe("Untitled Studio Project");
  });

  it("auto-suffixes .systemsculpt paths when collisions exist", async () => {
    const { store, files } = createStore({
      existingFiles: [
        "SystemSculpt/Studio/New Studio Project.systemsculpt",
        "SystemSculpt/Studio/New Studio Project (2).systemsculpt",
      ],
    });

    const created = await store.createProject({
      name: "New Studio Project",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("SystemSculpt/Studio/New Studio Project (3).systemsculpt");
    expect(files.has("SystemSculpt/Studio/New Studio Project (3).systemsculpt")).toBe(true);
    expect(
      files.has("SystemSculpt/Studio/New Studio Project (3).systemsculpt-assets/project.manifest.json")
    ).toBe(false);
  });

  it("normalizes manual project paths and applies collision suffixes", async () => {
    const { store } = createStore({ existingFiles: ["Custom/Flow.systemsculpt"] });

    const created = await store.createProject({
      name: "Flow",
      projectPath: "Custom/Flow",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("Custom/Flow (2).systemsculpt");
  });

  it("treats pre-existing assets folders as path collisions", async () => {
    const { store } = createStore({
      existingDirs: ["Custom/Flow.systemsculpt-assets"],
    });

    const created = await store.createProject({
      name: "Flow",
      projectPath: "Custom/Flow",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });

    expect(created.path).toBe("Custom/Flow (2).systemsculpt");
  });

  it("serializes concurrent support publications for one project", async () => {
    const { store } = createStore();
    const created = await store.createProject({ name: "Concurrent", minPluginVersion: "4.13.0", maxRuns: 100, maxArtifactsMb: 512 });
    await Promise.all([0, 1, 2].map((index) => store.putAsset(created.path, created.project.projectId, {
      contentAddressedPath: `0${index}/${String(index).repeat(64)}.bin`,
      bytes: new Uint8Array([index]),
    })));
    for (let index = 0; index < 3; index += 1) {
      const absolute = `${deriveStudioAssetsDir(created.path)}/assets/sha256/0${index}/${String(index).repeat(64)}.bin`;
      expect(await store.readSupportFile(created.path, absolute)).toEqual(new Uint8Array([index]));
    }
  });

  it("refreshes document authority on every load and ingests a causal file edit", async () => {
    const { store, files, reopen } = createStore();
    const created = await store.createProject({ name: "Direct edit", minPluginVersion: "4.13.0", maxRuns: 100, maxArtifactsMb: 512 });
    expect((await store.loadProject(created.path)).name).toBe("Direct edit");

    const externallyEdited = JSON.parse(files.get(created.path)!) as Record<string, unknown>;
    externallyEdited.name = "Edited outside Studio";
    files.set(created.path, `${JSON.stringify(externallyEdited, null, 2)}\n`);

    expect((await store.loadProject(created.path)).name).toBe("Edited outside Studio");
    expect((await store.loadProject(created.path, { forceReload: true })).name).toBe("Edited outside Studio");
    // A new consumer must see the accepted edit without the previous store's cache.
    expect((await reopen().loadProject(created.path)).name).toBe("Edited outside Studio");
  });

  it("keeps persistence bookkeeping out of project-file errors", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, files } = createStore();
    const created = await store.createProject({
      name: "Invalid file",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });
    files.set(created.path, "{");

    const result = await store.refreshDocument(created.path);
    const message = result.conflicts.join("\n");

    expect(message).toMatch(/waiting for a complete valid file edit/i);
    expect(message).not.toMatch(
      /external|sync|projection|authority|generation|candidate|marker|revision|hash/i
    );
    expect(files.get(created.path)).toBe("{");
    expect(result.project.name).toBe("Invalid file");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("publishes a renamed projection and retires the old visible paths safely", async () => {
    const { store, files, dirs } = createStore();

    const created = await store.createProject({
      name: "Original",
      minPluginVersion: "4.13.0",
      maxRuns: 100,
      maxArtifactsMb: 512,
    });
    const oldAssetsDir = deriveStudioAssetsDir(created.path);
    await store.putAsset(created.path, created.project.projectId, {
      contentAddressedPath: `aa/${"a".repeat(64)}.txt`,
      bytes: new TextEncoder().encode("blob"),
    });

    const renamed = await store.renameProject(created.path, "Renamed", {
      project: created.project,
    });
    const newAssetsDir = deriveStudioAssetsDir(renamed.newPath);
    const renamedProject = await store.loadProject(renamed.newPath);

    expect(renamed.oldPath).toBe("SystemSculpt/Studio/Original.systemsculpt");
    expect(renamed.newPath).toBe("SystemSculpt/Studio/Renamed.systemsculpt");
    expect(files.has("SystemSculpt/Studio/Original.systemsculpt")).toBe(false);
    expect(files.has("SystemSculpt/Studio/Renamed.systemsculpt")).toBe(true);
    expect(files.has(`${oldAssetsDir}/project.manifest.json`)).toBe(false);
    expect(files.has(`${newAssetsDir}/project.manifest.json`)).toBe(false);
    expect(files.has(`${oldAssetsDir}/assets/sha256/aa/${"a".repeat(64)}.txt`)).toBe(false);
    expect(files.has(`${newAssetsDir}/assets/sha256/aa/${"a".repeat(64)}.txt`)).toBe(true);
    expect([...files.keys()].some((path) => path.includes("/retired/"))).toBe(false);
    expect(renamedProject.name).toBe("Renamed");
    expect(renamedProject.permissionsRef.policyPath).toBe(deriveStudioPolicyPath(renamed.newPath));
  });
});


describe("Studio concurrent workspace writers", () => {
  async function workspace() {
    const state = createStore();
    const created = await state.store.createProject({ name: "Workspace", minPluginVersion: "6.7.2", maxRuns: 100, maxArtifactsMb: 1024 });
    return { ...state, ...created };
  }

  it("keeps a released-format file plain readable JSON through open and save", async () => {
    const { store, files, path } = await workspace();
    const released = JSON.parse(files.get(path)!) as Record<string, unknown>;
    released.canvas = { ...(released.canvas as object), nodes: [{ id: "note", kind: "studio.text", x: 10, y: 20, config: { value: "Released text" } }] };
    files.set(path, `${JSON.stringify(released, null, 2)}\n`);

    const opened = await store.loadProject(path, { forceReload: true });
    expect(opened.graph.nodes.map(node => node.id)).toEqual(["note"]);
    expect([...files.keys()].filter(file => file.endsWith(".systemsculpt"))).toEqual([path]);

    opened.name = "Adopted";
    const saved = await store.saveProject(path, opened);
    expect(saved.conflicts).toEqual([]);
    const written = JSON.parse(files.get(path)!) as { name: string; canvas: { nodes: Array<{ id: string; config: { value: string } }> } };
    expect(written.name).toBe("Adopted");
    expect(written.canvas.nodes[0].config.value).toBe("Released text");
    expect(Object.keys(written)).toEqual(["schema", "id", "name", "docs", "canvas", "merge"]);
  });

  it("saves a canvas edit while an asset arrives without deleting or rewriting the asset", async () => {
    const { store, files, path, project } = await workspace();
    const asset = `${deriveStudioAssetsDir(path)}/assets/sha256/ab/${"ab".repeat(32)}.png`;
    files.set(asset, "arrived from another device");
    project.name = "Canvas edit";
    await expect(store.saveProject(path, project)).resolves.toMatchObject({ conflicts: [] });
    expect(files.get(asset)).toBe("arrived from another device");
    expect((await store.loadProject(path)).name).toBe("Canvas edit");
  });

  it("rebases a local edit onto a valid external document with unrelated new nodes", async () => {
    const { store, files, path, project } = await workspace();
    const base = cloneStudioProjectSnapshot(project);
    const external = cloneStudioProjectSnapshot(project);
    external.graph.nodes.push({ id: "remote", kind: "studio.text", version: "1.0.0", title: "Remote text", position: { x: 0, y: 0 }, config: { value: "external edit" } });
    files.set(path, serializeStudioProject(external));
    project.name = "Local title";
    const saved = await store.saveProject(path, project, { baseProject: base });
    expect(saved.conflicts).toEqual([]);
    expect(saved.project.name).toBe("Local title");
    expect(saved.project.graph.nodes[0].id).toBe("remote");
    expect((await store.loadProject(path, { forceReload: true })).graph.nodes[0].id).toBe("remote");
  });

  it("keeps the file's value for a field changed on both sides, reports it, and saves independent local changes without copies", async () => {
    const { store, files, path, project } = await workspace();
    const base = cloneStudioProjectSnapshot(project), external = cloneStudioProjectSnapshot(project);
    external.name = "External title";
    files.set(path, serializeStudioProject(external));
    project.name = "Local title";
    project.graph.nodes.push({ id: "local", kind: "studio.text", version: "1.0.0", position: { x: 0, y: 0 }, config: { value: "keep me" } });
    const saved = await store.saveProject(path, project, { baseProject: base });
    // The session preserves its own version of a reported field as an Undo step.
    expect(saved.conflicts).toEqual(["name"]);
    expect(saved.project.name).toBe("External title");
    expect(saved.project.graph.nodes[0].id).toBe("local");
    expect(authoredFiles(files)).toEqual([path]);
    expect([...files.keys()].some(file => file.startsWith(".systemsculpt/studio/recovery/"))).toBe(false);
  });

  it("lets a user reconnect the same ports after a saved disconnection", async () => {
    const { store, path, project } = await workspace();
    const text = (id: string) => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x: 0, y: 0 }, config: { value: id } });
    project.graph.nodes.push(text("a"), { ...text("b"), kind: "studio.text_output", config: {} });
    const connect = () => ({ id: `edge_${Math.random().toString(16).slice(2)}`, fromNodeId: "a", fromPortId: "text", toNodeId: "b", toPortId: "text" });
    project.graph.edges = [connect()];
    let saved = (await store.saveProject(path, project)).project;
    expect(saved.graph.edges).toHaveLength(1);
    saved = cloneStudioProjectSnapshot(saved); saved.graph.edges = [];
    saved = (await store.saveProject(path, saved)).project;
    expect(saved.graph.edges).toHaveLength(0);
    saved = cloneStudioProjectSnapshot(saved); saved.graph.edges = [connect()];
    saved = (await store.saveProject(path, saved)).project;
    expect(saved.graph.edges.map(edge => `${edge.fromNodeId}->${edge.toNodeId}`)).toEqual(["a->b"]);
    expect((await store.loadProject(path, { forceReload: true })).graph.edges).toHaveLength(1);
  });

  it("binds grants to the file's own location instead of an authored policy reference", async () => {
    const { store, files, path } = await workspace();
    const foreign = JSON.parse(files.get(path)!) as Record<string, unknown>;
    delete foreign.document;
    files.set(path, `${JSON.stringify({ ...foreign, schema: "studio.project.v1", projectId: foreign.id, name: foreign.name, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" }, graph: { nodes: [], edges: [], entryNodeIds: [], groups: [] }, permissionsRef: { policyVersion: 1, policyPath: "Studio/Other.systemsculpt-assets/policy/grants.json" }, settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 10, maxArtifactsMb: 10 } }, migrations: { projectSchemaVersion: "1.0.0", applied: [] } }, null, 2)}\n`);
    const opened = await store.loadProject(path, { forceReload: true });
    expect(opened.permissionsRef.policyPath).toBe(deriveStudioPolicyPath(path));
  });

  it("keeps both node results when parallel runs publish caches from the same starting snapshot", async () => {
    const { store, path, project } = await workspace();
    const cache = (id: string) => new TextEncoder().encode(JSON.stringify({ schema: "studio.node-cache.v1", projectId: project.projectId, updatedAt: "2026-09-09T00:00:00.000Z", entries: { [id]: { nodeId: id, runId: `run_${id}`, updatedAt: "2026-09-09T00:00:00.000Z", outputs: { text: id } } } }));
    await Promise.all([store.replaceCache(path, project.projectId, cache("a")), store.replaceCache(path, project.projectId, cache("b"))]);
    const bytes = await store.readSupportFile(path, `${deriveStudioAssetsDir(path)}/cache/node-results.json`);
    expect(Object.keys(JSON.parse(new TextDecoder().decode(bytes!)).entries).sort()).toEqual(["a", "b"]);
  });
});


describe("single authored file", () => {
  const options = {name: "Concurrent", minPluginVersion: "6.9.0", maxRuns: 100, maxArtifactsMb: 512};
  const text = (id: string, value: string, x = 0) => ({id, kind: "studio.text", x, y: 0, config: {value}});
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  async function withNode(store: StudioProjectStore, path: string, value = "hello") {
    const {revision} = await store.readDocument(path);
    return store.editDocument(path, revision, [{kind: "create", entityId: "node:a", value: text("a", value)}]);
  }

  it("creates exactly one file and serializes twenty clients from one revision", async () => {
    const {store, files, reopen} = createStore();
    const {path} = await store.createProject(options);
    expect(authoredFiles(files)).toEqual([path]);
    const {revision} = await store.readDocument(path);
    await Promise.all(Array.from({length: 20}, (_, index) => reopen().editDocument(path, revision, [{kind: "create", entityId: `node:n${index}`, value: text(`n${index}`, `agent ${index}`, index)}])));
    expect((await reopen().loadProject(path)).graph.nodes).toHaveLength(20);
    expect(authoredFiles(files)).toEqual([path]);
  });

  it("names a revision by the SHA-256 of the canonical file text", async () => {
    const {store, files} = createStore();
    const {path} = await store.createProject(options);
    const {revision} = await store.readDocument(path);
    expect(revision).toBe(sha256(canonicalText(files.get(path)!)));
    const edited = await withNode(store, path);
    expect(edited.revision).toBe(sha256(canonicalText(files.get(path)!)));
    expect(edited.revision).not.toBe(revision);
  });

  it("merges separate fields and separate edits of one text from the same revision", async () => {
    const {store} = createStore();
    const {path} = await store.createProject(options);
    const {revision} = await withNode(store, path, "hello world");
    await store.editDocument(path, revision, [{entityId: "node:a", path: ["config", "value"], value: "hello wonderful world"}]);
    await store.editDocument(path, revision, [{entityId: "node:a", path: ["x"], value: 400}]);
    await store.editDocument(path, revision, [{entityId: "node:a", path: ["config", "value"], value: "hello world!"}]);
    const node = (await store.loadProject(path)).graph.nodes[0];
    expect(node.position.x).toBe(400);
    expect(node.config.value).toBe("hello wonderful world!");
  });

  it("rejects a whole batch that touches a field changed after its revision", async () => {
    const {store, files} = createStore();
    const {path} = await store.createProject(options);
    const {revision} = await withNode(store, path);
    await store.editDocument(path, revision, [{entityId: "node:a", path: ["config", "value"], value: "hello there"}]);
    const before = files.get(path);
    await expect(store.editDocument(path, revision, [
      {kind: "create", entityId: "node:b", value: text("b", "unrelated")},
      {entityId: "node:a", path: ["config", "value"], value: "goodbye"},
    ])).rejects.toThrow("Studio changed canvas.nodes[a].config.value after this revision. Read the document again and retry.");
    expect(files.get(path)).toBe(before);
    await expect(store.editDocument(path, "0".repeat(64), [])).rejects.toThrow("This Studio revision is no longer available. Read the document again and retry.");
  });

  it("never lets a stale edit or a create bring back a deleted entity; restore is explicit", async () => {
    const {store, files, reopen} = createStore();
    const {path} = await store.createProject(options);
    const {revision} = await withNode(store, path);
    await store.editDocument(path, revision, [{kind: "delete", entityId: "node:a"}]);
    await expect(store.editDocument(path, revision, [{entityId: "node:a", path: ["x"], value: 900}])).rejects.toThrow("Studio changed canvas.nodes[a] after this revision.");
    const {revision: latest} = await store.readDocument(path);
    await expect(store.editDocument(path, latest, [{kind: "create", entityId: "node:a", value: text("a", "again")}])).rejects.toThrow("This entity ID is already used; choose a new ID or explicitly restore it.");
    expect((await reopen().loadProject(path)).graph.nodes).toHaveLength(0);
    // Only the key and its deletion time are kept, in the file's merge record.
    expect(Object.keys(mergeRecord(files.get(path)!).deleted)).toEqual(["node:a"]);
    expect(Object.keys(mergeRecord(files.get(path)!).stamps)).not.toContain("node:a");
    expect(JSON.stringify(mergeRecord(files.get(path)!))).not.toContain("hello");
    await store.editDocument(path, latest, [{kind: "restore", entityId: "node:a", value: text("a", "restored")}]);
    expect((await reopen().loadProject(path)).graph.nodes[0].config.value).toBe("restored");
    expect(mergeRecord(files.get(path)!).deleted).toEqual({});
  });

  it("keeps the agent tool contract: one content revision in heads, older Automerge heads rejected", async () => {
    const {app, files} = createStore();
    const service = new StudioService({
      app: {...app, vault: {...app.vault, getName: getManagedStudioTestVaultName, configDir: ".obsidian"}},
      manifest: {id: "systemsculpt-ai", version: "9.9.9", dir: "/tmp/systemsculpt-ai"},
      settings: {studioDefaultProjectsFolder: "SystemSculpt/Studio", studioRunRetentionMaxRuns: 100, studioRunRetentionMaxArtifactsMb: 1024},
      getLogger: () => ({warn: jest.fn(), error: jest.fn()}),
      getManagedCapabilityGraph: createManagedCapabilityGraphStub,
    } as any);
    const {path} = await service.createProjectFile({name: "Agents"});
    const read = await service.readAgentDocument(path) as {heads: string[]; canvas: Record<string, unknown>};
    expect(read.heads).toEqual([sha256(canonicalText(files.get(path)!))]);
    expect(Object.keys(read.canvas)).toEqual(["schema", "id", "name", "docs", "canvas"]);
    await expect(service.editAgentDocument(path, [...read.heads, "a".repeat(64)], [])).rejects.toThrow("Read the Studio revision before editing.");
    const edited = await service.editAgentDocument(path, read.heads, [{kind: "create", entityId: "node:a", value: text("a", "one")}]) as {heads: string[]; entities: Record<string, unknown>};
    expect(edited.heads).toEqual([sha256(canonicalText(files.get(path)!))]);
    expect(edited.entities["node:a"]).toMatchObject({id: "a"});
  });

  it("can reuse a renamed path for a new identity", async () => {
    const {store} = createStore();
    const {path} = await store.createProject(options);
    await store.renameProject(path, "Moved");
    const next = await store.createProject(options);
    expect(next.path).toBe(path);
    expect((await store.loadProject(path)).projectId).toBe(next.project.projectId);
  });
  it("retries a failed publication against the latest file instead of reporting success", async () => {
    const {store, files, adapter} = createStore();
    const {path, project} = await store.createProject(options);
    const original = adapter.process.getMockImplementation()!;
    adapter.process.mockImplementationOnce(async (file, update) => {
      const external = cloneStudioProjectSnapshot(project); external.name = "External";
      files.set(file, serializeStudioProject(external));
      return update(files.get(file)!);
    });
    const draft = cloneStudioProjectSnapshot(project);
    draft.graph.nodes.push({id: "n", kind: "studio.text", version: "1.0.0", position: {x: 0, y: 0}, config: {value: "persist"}});
    await store.saveProject(path, draft, {baseProject: project});
    adapter.process.mockImplementation(original);
    const saved = await store.loadProject(path);
    expect(saved.name).toBe("External");
    expect(saved.graph.nodes[0].config.value).toBe("persist");
  });
  it("retains typing made during a save without duplicating already committed text", async () => {
    const {store, files} = createStore();
    const created = await store.createProject(options);
    const {project} = await withNode(store, created.path);
    let saving!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {saving = resolve;});
    const hold = new Promise<void>(resolve => {release = resolve;});
    let calls = 0;
    const session = new StudioProjectSession({projectPath: created.path, project, discreteDelayMs: 60000,
      saveProject: async (path, value, onBeforeProjectWrite, baseProject) => {
        if (++calls === 1) {saving(); await hold;}
        return store.saveProject(path, value, {baseProject, onBeforeProjectWrite});
      },
    });
    session.mutate("node.config", p => {p.graph.nodes[0].config.value = "hello world";});
    const flush = session.flushPendingSaveWork({force: true});
    await started;
    session.mutate("node.config", p => {p.graph.nodes[0].config.value = "hello world!";});
    release(); await flush;
    expect(session.getProject().graph.nodes[0].config.value).toBe("hello world!");
    expect((await store.loadProject(created.path)).graph.nodes[0].config.value).toBe("hello world!");
    expect(authoredFiles(files)).toEqual([created.path]);
    await session.close();
  });

  it("imports duplicate and delayed watcher events exactly once", async () => {
    const {store, files} = createStore();
    const {path} = await store.createProject(options);
    const {project: base} = await withNode(store, path);
    const draft = cloneStudioProjectSnapshot(base); draft.graph.nodes[0].config.value = "hello world";
    const raw = serializeStudioProject(draft); files.set(path, raw);
    await store.refreshDocument(path);
    await store.refreshDocument(path);
    // A delayed watcher event only refreshes from the current file, so it cannot roll the document back.
    await store.refreshDocument(path);
    expect((await store.loadProject(path)).graph.nodes[0].config.value).toBe("hello world");
    expect(files.get(path)).toBe(raw);
  });

  it("merges agent text into what a mounted editor displayed and commits plain values otherwise", async () => {
    const {store} = createStore();
    const {path} = await store.createProject(options);
    const {project: base, revision} = await withNode(store, path);
    const editor = new StudioEditorRevision();
    editor.display("config:value", base.graph.nodes[0].config.value);
    const remote = await store.editDocument(path, revision, [{entityId: "node:a", path: ["config", "value"], value: "hello remote"}]);
    // The card still shows "hello": the typed character lands in the agent's text.
    const first = editor.commit("config:value", "hello!", remote.project.graph.nodes[0].config.value);
    expect(first).toBe("hello! remote");
    const draft = cloneStudioProjectSnapshot(remote.project); draft.graph.nodes[0].config.value = first;
    const saved = (await store.saveProject(path, draft, {baseProject: remote.project})).project;
    expect(editor.commit("config:value", "hello!!", saved.graph.nodes[0].config.value)).toBe("hello!! remote");
    // A change that overlaps the typed range cannot be merged without guessing: the typed value wins.
    expect(editor.commit("config:value", "bye", "hello!! remote")).toBe("bye");
    // Without another writer, a keystroke is its plain value.
    editor.display("title", "Title");
    expect(editor.commit("title", "Title!", "Title")).toBe("Title!");
    expect(editor.commit("title", "Title!!", "Title!")).toBe("Title!!");
  });

  it("round-trips labeled and unlabeled arrows and shape group membership", async () => {
    const {store} = createStore();
    const {path, project} = await store.createProject(options);
    project.diagram = {shapes: [
      {id: "a", shape: "rectangle", position: {x: 0, y: 0}, size: {width: 100, height: 80}, label: "A"},
      {id: "b", shape: "rectangle", position: {x: 300, y: 0}, size: {width: 100, height: 80}, label: "B"},
    ], arrows: [
      {id: "a->b", fromShapeId: "a", toShapeId: "b"},
      {id: "b->a", fromShapeId: "b", toShapeId: "a", label: "return"},
    ]};
    project.graph.groups = [{id: "g", name: "Shapes", nodeIds: [], shapeIds: ["a", "b"]}];
    await store.saveProject(path, project);
    await store.dispose();
    const reopened = await store.loadProject(path);
    expect(reopened.diagram).toEqual(project.diagram);
    expect(reopened.graph.groups?.[0].shapeIds).toEqual(["a", "b"]);
  });

});

describe("v1 projects with retired node kinds", () => {
  const v1Text = readFileSync(join(__dirname, "fixtures/v1-retired-node-kinds.systemsculpt"), "utf8");
  const path = "SystemSculpt/Studio/Legacy API digest.systemsculpt";

  it("migrates studio.label and studio.http_request before validating the file", async () => {
    const { store, files, reopen } = createStore();
    files.set(path, v1Text);

    const opened = await store.loadProject(path);

    const kinds = Object.fromEntries(opened.graph.nodes.map((node) => [node.id, node.kind]));
    expect(kinds).toEqual({
      caption: "studio.text",
      endpoint: "studio.input",
      fetch: "studio.retired_http_request",
      response: "studio.text_output",
    });
    const caption = opened.graph.nodes.find((node) => node.id === "caption");
    expect(caption?.config).toEqual({ value: "Fetches the item list and shows the response body.", fontSize: 18 });
    expect(caption?.size).toEqual({ width: 300, height: 120 });
    expect(opened.graph.nodes.find((node) => node.id === "fetch")?.size).toEqual({ width: 410, height: 320 });
    expect(opened.graph.edges.map((edge) => `${edge.fromNodeId}.${edge.fromPortId}->${edge.toNodeId}.${edge.toPortId}`).sort())
      .toEqual(["endpoint.text->fetch.url", "fetch.body->response.text"]);
    expect(opened.migrations.applied.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "studio.text-node-kinds.v1",
      "studio.retire-http-request.v1",
    ]));

    // The first import publishes the migrated canvas in the current dialect without the retired node's secrets.
    const written = files.get(path)!;
    expect(JSON.parse(written).schema).toBe("studio.project.v2");
    expect(written).not.toMatch(/sentinel-header|sentinel-token|"label"|"http_request"/);
    const reopened = await reopen().loadProject(path);
    expect(reopened.graph.nodes.map((node) => node.kind)).toEqual(opened.graph.nodes.map((node) => node.kind));
  });

  const legacyFolder = "SystemSculpt/Studio/Legacy API digest.systemsculpt-assets/legacy";
  const legacyCopies = (files: Map<string, string>) => [...files.keys()].filter((file) => file.startsWith(`${legacyFolder}/`));

  it("keeps the original v1 bytes before the first rewrite replaces them", async () => {
    const copied = jest.fn();
    const { store, files, adapter } = createStore({ onLegacyOriginalCopied: copied });
    files.set(path, v1Text);
    const replace = adapter.process.getMockImplementation()!;
    let copiesAtRewrite: string[] | null = null;
    adapter.process.mockImplementation(async (target: string, update: (data: string) => string) => {
      if (target === path && copiesAtRewrite === null) copiesAtRewrite = legacyCopies(files).map((copy) => files.get(copy)!);
      return replace(target, update);
    });

    await store.loadProject(path);

    expect(legacyCopies(files)).toHaveLength(1);
    const [copyPath] = legacyCopies(files);
    expect(copyPath).toMatch(/\/legacy\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-v1-original\.json$/);
    // The copy is written from the file's own bytes, not from a re-serialized project.
    const [, written] = adapter.writeBinary.mock.calls.find(([target]) => target === copyPath)!;
    expect(new Uint8Array(written)).toEqual(new TextEncoder().encode(v1Text));
    expect(copiesAtRewrite).toEqual([v1Text]);
    expect(JSON.parse(files.get(path)!).schema).toBe("studio.project.v2");
    expect(copied).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledWith({
      projectPath: path,
      copyPath,
      retiredNodes: [
        { title: "Text", kind: "studio.label" },
        { title: "Fetch items", kind: "studio.http_request" },
      ],
    });
  });

  it("keeps the copy before a save that is the first writer", async () => {
    const copied = jest.fn();
    const { store, files } = createStore({ onLegacyOriginalCopied: copied });
    files.set(path, v1Text);
    const elsewhere = createStore();
    elsewhere.files.set(path, v1Text);
    const project = await elsewhere.store.loadProject(path);

    const saved = await store.saveProject(path, { ...project, name: "Legacy API digest (edited)" });

    expect(saved.conflicts).toEqual([]);
    expect(JSON.parse(files.get(path)!).name).toBe("Legacy API digest (edited)");
    expect(legacyCopies(files).map((copy) => files.get(copy))).toEqual([v1Text]);
    expect(copied).toHaveBeenCalledTimes(1);
  });

  it("copies each distinct original once, however often the project is opened", async () => {
    const copied = jest.fn();
    const { store, files, reopen } = createStore({ onLegacyOriginalCopied: copied });
    files.set(path, v1Text);

    await store.loadProject(path);
    await store.loadProject(path);
    await reopen().loadProject(path);
    expect(legacyCopies(files)).toHaveLength(1);
    expect(copied).toHaveBeenCalledTimes(1);

    // A sync client restoring the same v1 bytes is upgraded again without a second copy.
    files.set(path, v1Text);
    await reopen().loadProject(path);
    expect(JSON.parse(files.get(path)!).schema).toBe("studio.project.v2");
    expect(legacyCopies(files)).toHaveLength(1);
    expect(copied).toHaveBeenCalledTimes(1);

    // Different original bytes are a separate record.
    const edited = v1Text.replace("Fetch items", "Fetch all items");
    files.set(path, edited);
    await reopen().loadProject(path);
    expect(legacyCopies(files).map((copy) => files.get(copy)).sort()).toEqual([v1Text, edited].sort());
    expect(copied).toHaveBeenCalledTimes(2);
  });

  it("never copies a v2 file", async () => {
    const copied = jest.fn();
    const { store, files, adapter } = createStore({ onLegacyOriginalCopied: copied });
    const created = await store.createProject({ name: "Current", minPluginVersion: "9.9.9", maxRuns: 100, maxArtifactsMb: 1024 });
    const loaded = await store.loadProject(created.path);
    await store.saveProject(created.path, { ...loaded, name: "Current renamed" });
    // A v2 file whose formatting differs is read as it is, still without a copy.
    files.set(created.path, JSON.stringify(JSON.parse(files.get(created.path)!)));
    await store.refreshDocument(created.path);

    expect(JSON.parse(files.get(created.path)!).name).toBe("Current renamed");
    expect([...files.keys()].filter((file) => file.includes("/legacy/"))).toEqual([]);
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(copied).not.toHaveBeenCalled();
  });

  it("names the copy and the converted nodes in one notice when Studio opens the project", async () => {
    const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({}));
    try {
      const { app, files } = createStore();
      files.set(path, v1Text);
      const service = new StudioService({
        app: { ...app, vault: { ...app.vault, getName: getManagedStudioTestVaultName, configDir: ".obsidian" } },
        manifest: { id: "systemsculpt-ai", version: "9.9.9", dir: "/tmp/systemsculpt-ai" },
        settings: { studioDefaultProjectsFolder: "SystemSculpt/Studio", studioRunRetentionMaxRuns: 100, studioRunRetentionMaxArtifactsMb: 1024 },
        getLogger: () => ({ warn: jest.fn(), error: jest.fn() }),
        getManagedCapabilityGraph: createManagedCapabilityGraphStub,
      } as any);

      await service.retainProjectSession(path);
      await service.releaseProjectSession(path);
      await service.retainProjectSession(path);
      await service.releaseProjectSession(path);

      expect(legacyCopies(files)).toHaveLength(1);
      const [copyPath] = legacyCopies(files);
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledWith(
        `Studio updated ${path} to the current project format. Converted retired nodes: Text (studio.label), Fetch items (studio.http_request). The original file is saved at ${copyPath}.`,
        15000,
      );
    } finally {
      notice.mockRestore();
    }
  });

  it("keeps rejecting v1 node kinds that no migration knows", async () => {
    const { store, files } = createStore();
    files.set(path, v1Text.replace('"studio.label"', '"studio.unknown_kind"'));

    await expect(store.loadProject(path)).rejects.toThrow(
      'Studio couldn\'t read this project file: Graph compile failed: missing node definition for "studio.unknown_kind@1.0.0".'
    );
    expect(files.get(path)).toBe(v1Text.replace('"studio.label"', '"studio.unknown_kind"'));
  });
});
