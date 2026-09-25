import { readFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { StudioProjectStore } from "../../StudioProjectStore";
import { StudioProjectSession } from "../../StudioProjectSession";
import { serializeStudioProject } from "../../schema";
import { cloneStudioProjectSnapshot } from "../../StudioProjectSnapshots";
import type { StudioProjectV1 } from "../../types";
import { studioTombstonesPath, type StudioLegacyOriginalCopy } from "../StudioProjectDocument";
import { mergeStudioText } from "../StudioTextMerge";
import { STUDIO_TOMBSTONE_MAX_AGE_MS, STUDIO_TOMBSTONE_MAX_ENTRIES, updateStudioTombstones } from "../StudioProjectTombstones";

/** One vault's files; `restart` gives a fresh adapter object, as a plugin reload does. */
function vault() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = () => ({
    exists: async (path: string) => files.has(path) || dirs.has(path),
    mkdir: async (path: string) => { dirs.add(path); },
    read: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return files.get(path)!; },
    write: async (path: string, data: string) => { files.set(path, data); },
    readBinary: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return new TextEncoder().encode(files.get(path)!).buffer; },
    writeBinary: async (path: string, data: ArrayBuffer) => { files.set(path, new TextDecoder().decode(data)); },
    process: async (path: string, update: (data: string) => string) => { const next = update(files.get(path)!); files.set(path, next); return next; },
    list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")), folders: [] }),
    remove: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
  });
  const copies: StudioLegacyOriginalCopy[] = [];
  const open = () => new StudioProjectStore({ vault: { adapter: adapter(), getFiles: () => [...files.keys()].map(path => ({ path })) } } as never, { onLegacyOriginalCopied: copy => copies.push(copy) });
  return { files, copies, store: open(), restart: open };
}

const path = "Studio/Weekly.systemsculpt";
const node = (id: string, value: string, x = 0) => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x, y: 0 }, config: { value } });

async function project(store: StudioProjectStore, nodes: ReturnType<typeof node>[]): Promise<StudioProjectV1> {
  const created = await store.createProject({ name: "Weekly", projectPath: path, minPluginVersion: "6.11.0", maxRuns: 10, maxArtifactsMb: 10 });
  return (await store.saveProject(path, { ...created.project, graph: { ...created.project.graph, nodes } })).project;
}

function session(store: StudioProjectStore, opened: StudioProjectV1): StudioProjectSession {
  return new StudioProjectSession({
    projectPath: path, project: opened, discreteDelayMs: 60000, continuousDelayMs: 60000,
    saveProject: (target, value, onBeforeProjectWrite, baseProject) => store.saveProject(target, value, { onBeforeProjectWrite, baseProject }),
  });
}

/** What StudioService does for a watcher event: import the file, then reconcile the open session. */
async function arrive(store: StudioProjectStore, files: Map<string, string>, live: StudioProjectSession, external: StudioProjectV1) {
  files.set(path, serializeStudioProject(external));
  const result = await store.importProjectText(path, files.get(path)!);
  await live.reconcileExternalProject(result.project, serializeStudioProject(result.project));
  return result.conflicts;
}

const find = (value: StudioProjectV1, id: string) => value.graph.nodes.find(item => item.id === id);

describe("three-way merge of an external change", () => {
  it("merges different fields and separate edits of one text, then saves them together", async () => {
    const { store, files } = vault();
    const base = await project(store, [node("a", "Draft the weekly summary."), node("b", "Sources")]);
    const live = session(store, base);
    live.mutate("node.config", draft => {
      find(draft, "a")!.position.x = 300;
      find(draft, "a")!.config.value = "Draft the weekly summary. Include risks.";
    });
    const external = cloneStudioProjectSnapshot(base);
    find(external, "a")!.title = "Weekly";
    find(external, "a")!.config.value = "Please draft the weekly summary.";
    find(external, "b")!.config.value = "Sources: interviews";
    await arrive(store, files, live, external);

    const merged = find(live.getProject(), "a")!;
    expect(merged).toMatchObject({ title: "Weekly", position: { x: 300, y: 0 }, config: { value: "Please draft the weekly summary. Include risks." } });
    expect(find(live.getProject(), "b")!.config.value).toBe("Sources: interviews");
    expect(live.getConflictRecovery()).toBeNull();

    await live.flushPendingSaveWork({ force: true });
    const saved = await store.loadProject(path);
    expect(find(saved, "a")).toMatchObject({ title: "Weekly", position: { x: 300 }, config: { value: "Please draft the weekly summary. Include risks." } });
    await live.close();
  });

  it("keeps the file's value when both sides rewrite the same text and preserves the local version as a recovery copy", async () => {
    const { store, files } = vault();
    const base = await project(store, [node("a", "Original wording")]);
    const live = session(store, base);
    live.mutate("node.config", draft => { find(draft, "a")!.config.value = "Local rewrite"; });
    const external = cloneStudioProjectSnapshot(base);
    find(external, "a")!.config.value = "External rewrite";
    await arrive(store, files, live, external);

    expect(find(live.getProject(), "a")!.config.value).toBe("External rewrite");
    const recovery = live.getConflictRecovery();
    expect(recovery?.fields).toEqual(["canvas.nodes[a].config.value"]);
    expect(find(recovery!.project, "a")!.config.value).toBe("Local rewrite");
    expect([...files.keys()].filter(file => file.endsWith(".systemsculpt"))).toEqual([path]);
    await live.close();
  });
});

describe("deletion tombstones", () => {
  it("drops a deleted node from a stale copy of the file, also after a restart, until an explicit Undo", async () => {
    const { files, store, restart } = vault();
    const base = await project(store, [node("a", "keep"), node("b", "delete me")]);
    const stale = cloneStudioProjectSnapshot(base);
    find(stale, "b")!.position.x = 900;
    const live = session(store, base);
    live.mutate("graph.node.remove", draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    await live.flushPendingSaveWork({ force: true });
    expect(JSON.parse(files.get(studioTombstonesPath(path))!).deleted).toEqual({ "node:b": expect.any(Number) });

    // Another device that never saw the deletion replaces the file with its edited copy.
    expect(await arrive(store, files, live, stale)).toEqual(["Studio left out 1 deleted item that an older copy of this file still contained. Use Undo to bring back a deletion."]);
    expect(live.getProject().graph.nodes.map(item => item.id)).toEqual(["a"]);
    expect(JSON.parse(files.get(path)!).canvas.nodes.map((item: { id: string }) => item.id)).toEqual(["a"]);

    files.set(path, serializeStudioProject(stale));
    expect((await restart().loadProject(path)).graph.nodes.map(item => item.id)).toEqual(["a"]);

    // Undo is Studio's own restore: the node returns and its tombstone is cleared.
    live.applyHistorySnapshot(base);
    await live.flushPendingSaveWork({ force: true });
    expect((await restart().loadProject(path)).graph.nodes.map(item => item.id).sort()).toEqual(["a", "b"]);
    expect(JSON.parse(files.get(studioTombstonesPath(path))!).deleted).toEqual({});
    await live.close();
  });

  it("prunes tombstones by age and keeps only the newest entries", () => {
    const now = Date.UTC(2026, 8, 25);
    const aged = updateStudioTombstones({ "node:old": now - STUDIO_TOMBSTONE_MAX_AGE_MS - 1, "node:recent": now - 1000 }, null, new Set(), now);
    expect(aged).toEqual({ "node:recent": now - 1000 });
    const many = updateStudioTombstones({}, new Set(Array.from({ length: STUDIO_TOMBSTONE_MAX_ENTRIES + 5 }, (_, index) => `node:${index}`)), new Set(), now);
    expect(Object.keys(many)).toHaveLength(STUDIO_TOMBSTONE_MAX_ENTRIES);
    // An entity present again is no longer deleted.
    expect(updateStudioTombstones({ "node:a": now }, null, new Set(["node:a"]), now)).toEqual({});
  });
});

describe("6.10 files with embedded merge state", () => {
  const fixture = readFileSync(join(__dirname, "../../__tests__/fixtures/v610-document-state.systemsculpt"), "utf8");

  it("opens the readable canvas, drops the merge state on the next save and keeps one byte-identical backup", async () => {
    const { files, store, copies, restart } = vault();
    files.set(path, fixture);
    const opened = await store.loadProject(path);
    // Loading alone never rewrites: a device still on 6.10 cannot trade rewrites with this one.
    expect(files.get(path)).toBe(fixture);
    expect(opened.graph.nodes.map(item => item.id)).toEqual(["brief", "summary"]);

    await store.saveProject(path, opened);
    const written = files.get(path)!;
    expect(Object.keys(JSON.parse(written))).toEqual(["schema", "id", "name", "docs", "canvas"]);
    expect(written.length).toBeLessThan(fixture.length);
    const original = JSON.parse(fixture);
    expect(JSON.parse(written)).toEqual({ schema: original.schema, id: original.id, name: original.name, docs: original.docs, canvas: original.canvas });

    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ projectPath: path, retiredNodes: [] });
    expect(copies[0].copyPath).toMatch(/\.systemsculpt-assets\/legacy\/.+-document-state-original\.json$/);
    expect(files.get(copies[0].copyPath)).toBe(fixture);

    // A 6.10 device writing its format again is read the same way, without another backup.
    files.set(path, fixture.replace("Review on Fridays", "Review on Mondays"));
    const again = restart();
    const reopened = await again.loadProject(path);
    expect(reopened.diagram?.shapes[0].label).toBe("Review on Mondays");
    await again.saveProject(path, reopened);
    expect(JSON.parse(files.get(path)!).document).toBeUndefined();
    expect(copies).toHaveLength(1);
  });
});

describe("text merge", () => {
  it("combines separate changes and refuses touching or overlapping ones", () => {
    expect(mergeStudioText("hello world", "hello wonderful world", "hello world!")).toBe("hello wonderful world!");
    expect(mergeStudioText("abc", "abc", "abcd")).toBe("abcd");
    expect(mergeStudioText("abc", "aXc", "aXc")).toBe("aXc");
    expect(mergeStudioText("hello", "hello!", "hello remote")).toBe("hello! remote");
    expect(mergeStudioText("one two three", "one 2 three", "one two 3")).toBe("one 2 3");
    expect(mergeStudioText("one two", "one 2", "one two!")).toBeNull();
    expect(mergeStudioText("one two", "one 2", "one TWO")).toBeNull();
    // Never splits a surrogate pair.
    expect(mergeStudioText("a😀b", "a😁b", "a😀b!")).toBe("a😁b!");
  });
});

describe("save cost", () => {
  it("saves a 40-node canvas in well under 20 ms", async () => {
    const { store } = vault();
    const nodes = Array.from({ length: 40 }, (_, index) => node(`n${index}`, `Card ${index}: ${"lorem ipsum dolor sit amet ".repeat(8)}`, index * 320));
    let saved = await project(store, nodes);
    const timings: number[] = [];
    for (let index = 0; index < 12; index++) {
      const next = cloneStudioProjectSnapshot(saved);
      next.graph.nodes[index % 40].config.value += "x";
      const started = performance.now();
      saved = (await store.saveProject(path, next, { baseProject: saved })).project;
      timings.push(performance.now() - started);
    }
    const median = timings.sort((left, right) => left - right)[Math.floor(timings.length / 2)];
    expect(median).toBeLessThan(20);
  });
});
