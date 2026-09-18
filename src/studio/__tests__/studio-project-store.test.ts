import { StudioEditorRevision } from "../document/StudioEditorRevision";
import { StudioProjectSession } from "../StudioProjectSession";
import { serializeStudioProject } from "../schema";
import { cloneStudioProjectSnapshot } from "../StudioProjectSnapshots";
import { StudioProjectStore } from "../StudioProjectStore";
import { deriveStudioAssetsDir, deriveStudioPolicyPath, sanitizeStudioProjectName } from "../paths";

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

function createStore(options?: { existingFiles?: string[]; existingDirs?: string[] }) {
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

  return {
    adapter,
    dirs,
    files,
    store: new StudioProjectStore(app as any),
    reopen: () => new StudioProjectStore(app as any),
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

    const result = await store.importProjectText(created.path, "{");
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

  it("opens a released-format file without merge state and embeds it into the same file", async () => {
    const { store, files, path } = await workspace();
    const legacy = JSON.parse(files.get(path)!) as Record<string, unknown>;
    delete legacy.document;
    legacy.canvas = { ...(legacy.canvas as object), nodes: [{ id: "note", kind: "studio.text", x: 10, y: 20, config: { value: "Released before merge state" } }] };
    files.set(path, `${JSON.stringify(legacy, null, 2)}\n`);

    const opened = await store.loadProject(path, { forceReload: true });
    expect(opened.graph.nodes.map(node => node.id)).toEqual(["note"]);
    expect(opened.document?.engine).toBe("automerge");
    // Import publishes the readable canvas and its merge state together; no sidecar appears.
    expect(JSON.parse(files.get(path)!).document?.engine).toBe("automerge");
    expect([...files.keys()].filter(file => file.endsWith(".systemsculpt"))).toEqual([path]);

    opened.name = "Adopted";
    const saved = await store.saveProject(path, opened);
    expect(saved.conflicts).toEqual([]);
    const written = JSON.parse(files.get(path)!) as { name: string; document?: { engine: string; heads: string[] }; canvas: { nodes: Array<{ id: string; config: { value: string } }> } };
    expect(written.name).toBe("Adopted");
    expect(written.document?.engine).toBe("automerge");
    expect(written.document?.heads).toHaveLength(1);
    expect(written.canvas.nodes[0].config.value).toBe("Released before merge state");
    expect(Object.keys(files.get(path) ? JSON.parse(files.get(path)!) : {})).toEqual(["schema", "id", "name", "docs", "canvas", "document"]);
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

  it("converges to one value and saves independent local changes without copies", async () => {
    const { store, files, path, project } = await workspace();
    const base = cloneStudioProjectSnapshot(project), external = cloneStudioProjectSnapshot(project);
    external.name = "External title";
    files.set(path, serializeStudioProject(external));
    project.name = "Local title";
    project.graph.nodes.push({ id: "local", kind: "studio.text", version: "1.0.0", position: { x: 0, y: 0 }, config: { value: "keep me" } });
    const saved = await store.saveProject(path, project, { baseProject: base });
    expect(saved.conflicts).toEqual([]);
    expect(typeof saved.project.name).toBe("string");
    expect(saved.project.graph.nodes[0].id).toBe("local");
    expect([...files.keys()]).toEqual([path]);
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
  it("creates exactly one file and serializes twenty clients from one revision", async () => {
    const {store, files, reopen} = createStore();
    const {path, project} = await store.createProject(options);
    expect([...files.keys()]).toEqual([path]);
    await Promise.all(Array.from({length: 20}, (_, index) => reopen().editDocument(path, project.document!.heads, [{kind: "create", entityId: `node:n${index}`, value: {id: `n${index}`, kind: "studio.text", x: index, y: 0, config: {value: `agent ${index}`}}}])));
    expect((await reopen().loadProject(path)).graph.nodes).toHaveLength(20);
    expect([...files.keys()]).toEqual([path]);
  });
  it("keeps concurrent text in one node and never resurrects a stale deletion", async () => {
    const {store, files, reopen} = createStore();
    const {path, project} = await store.createProject(options);
    const created = await store.editDocument(path, project.document!.heads, [{kind: "create", entityId: "node:a", value: {id: "a", kind: "studio.text", x: 0, y: 0, config: {value: "hello world"}}}]);
    const heads = created.project.document!.heads;
    await Promise.all([
      store.editDocument(path, heads, [{entityId: "node:a", path: ["config", "value"], value: "hello wonderful world"}]),
      reopen().editDocument(path, heads, [{entityId: "node:a", path: ["config", "value"], value: "hello world!"}]),
    ]);
    expect((await store.loadProject(path)).graph.nodes[0].config.value).toBe("hello wonderful world!");
    await store.editDocument(path, heads, [{kind: "delete", entityId: "node:a"}]);
    await store.editDocument(path, heads, [{entityId: "node:a", path: ["x"], value: 900}]);
    expect((await reopen().loadProject(path)).graph.nodes).toHaveLength(0);
    expect([...files.keys()]).toEqual([path]);
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
    const {project} = await store.editDocument(created.path, created.project.document!.heads, [{kind: "create", entityId: "node:a", value: {id: "a", kind: "studio.text", x: 0, y: 0, config: {value: "hello"}}}]);
    let saving!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {saving = resolve;});
    const hold = new Promise<void>(resolve => {release = resolve;});
    let calls = 0;
    const session = new StudioProjectSession({projectPath: created.path, project, discreteDelayMs: 60000,
      saveProject: async (path, value, onBeforeProjectWrite, baseProject, intent) => {
        if (++calls === 1) {saving(); await hold;}
        return store.saveProject(path, value, {baseProject, onBeforeProjectWrite, ...intent});
      },
    });
    session.mutate("node.config", p => {p.graph.nodes[0].config.value = "hello world";});
    const flush = session.flushPendingSaveWork({force: true});
    await started;
    session.mutate("node.config", p => {p.graph.nodes[0].config.value = "hello world!";});
    release(); await flush;
    expect(session.getProject().graph.nodes[0].config.value).toBe("hello world!");
    expect((await store.loadProject(created.path)).graph.nodes[0].config.value).toBe("hello world!");
    expect([...files.keys()]).toEqual([created.path]);
    await session.close();
  });

  it("imports duplicate and delayed watcher events exactly once", async () => {
    const {store, files} = createStore();
    const {path, project} = await store.createProject(options);
    const {project: base} = await store.editDocument(path, project.document!.heads, [{kind: "create", entityId: "node:a", value: {id: "a", kind: "studio.text", x: 0, y: 0, config: {value: "hello"}}}]);
    const draft = cloneStudioProjectSnapshot(base); draft.graph.nodes[0].config.value = "hello world";
    const raw = serializeStudioProject(draft); files.set(path, raw);
    await store.importProjectText(path, raw);
    await store.importProjectText(path, raw);
    await store.importProjectText(path, raw);
    expect((await store.loadProject(path)).graph.nodes[0].config.value).toBe("hello world");
  });

  it("preserves agent text while a mounted editor continues from its displayed revision", async () => {
    const {store} = createStore();
    const {path, project} = await store.createProject(options);
    const {project: base} = await store.editDocument(path, project.document!.heads, [{kind: "create", entityId: "node:a", value: {id: "a", kind: "studio.text", x: 0, y: 0, config: {value: "hello"}}}]);
    const editor = new StudioEditorRevision(cloneStudioProjectSnapshot(base));
    const remote = await store.editDocument(path, base.document!.heads, [{entityId: "node:a", path: ["config", "value"], value: "hello remote"}]);
    let merged = editor.edit("a", {config: "value"}, "hello!", remote.project);
    merged = (await store.saveProject(path, merged)).project;
    merged = editor.edit("a", {config: "value"}, "hello!!", merged);
    const result = (await store.saveProject(path, merged)).project.graph.nodes[0].config.value as string;
    expect(result).toContain("remote");
    expect(result.match(/hello/g)).toHaveLength(1);
    expect(result.match(/!/g)).toHaveLength(2);
    expect(result.match(/remote/g)).toHaveLength(1);
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
