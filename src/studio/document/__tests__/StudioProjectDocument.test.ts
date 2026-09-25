import { readFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { StudioProjectStore } from "../../StudioProjectStore";
import { StudioProjectSession } from "../../StudioProjectSession";
import { serializeStudioProject } from "../../schema";
import { cloneStudioProjectSnapshot } from "../../StudioProjectSnapshots";
import type { StudioProjectV1 } from "../../types";
import { studioClockPath, type StudioLegacyOriginalCopy } from "../StudioProjectDocument";
import { mergeStudioText } from "../StudioTextMerge";
import { STUDIO_CLOCK_MAX_AGE_MS, StudioHybridClock, emptyStudioClock, parseStudioClock, pruneStudioClock, studioStamp } from "../StudioDocumentClock";

let now = Date.UTC(2026, 8, 25, 9);
const tick = (ms = 1000) => { now += ms; };

/**
 * One device's vault. Writes carry the device's time as their modification
 * time; `restart` gives a fresh adapter object, as a plugin reload does.
 */
function vault(device = "aaaaaaaaaaaa", options: { stat?: boolean } = {}) {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>();
  const put = (path: string, data: string) => { files.set(path, data); mtimes.set(path, now); };
  const adapter = () => ({
    exists: async (path: string) => files.has(path) || dirs.has(path),
    mkdir: async (path: string) => { dirs.add(path); },
    read: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return files.get(path)!; },
    write: async (path: string, data: string) => { put(path, data); },
    readBinary: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return new TextEncoder().encode(files.get(path)!).buffer; },
    writeBinary: async (path: string, data: ArrayBuffer) => { put(path, new TextDecoder().decode(data)); },
    process: async (path: string, update: (data: string) => string) => { const next = update(files.get(path)!); put(path, next); return next; },
    list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")), folders: [] }),
    remove: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => { put(to, files.get(from)!); files.delete(from); },
    ...(options.stat === false ? {} : { stat: async (path: string) => files.has(path) ? { type: "file", ctime: 0, mtime: mtimes.get(path)!, size: files.get(path)!.length } : null }),
  });
  const copies: StudioLegacyOriginalCopy[] = [];
  const open = () => new StudioProjectStore({ vault: { adapter: adapter(), getFiles: () => [...files.keys()].map(path => ({ path })) } } as never, { deviceId: device, now: () => now, onLegacyOriginalCopied: copy => copies.push(copy) });
  return { device, files, mtimes, copies, store: open(), restart: open };
}
type Vault = ReturnType<typeof vault>;

/** Synchronization delivers another device's bytes with their modification times. */
function deliver(from: Vault, to: Vault, what: { project?: boolean; clock?: boolean }) {
  const paths = [...(what.project ? [path] : []), ...(what.clock ? [studioClockPath(path, from.device)] : [])];
  for (const file of paths) { to.files.set(file, from.files.get(file)!); to.mtimes.set(file, from.mtimes.get(file)!); }
}

const path = "Studio/Weekly.systemsculpt";
const node = (id: string, value: string, x = 0) => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x, y: 0 }, config: { value } });

async function project(store: StudioProjectStore, nodes: ReturnType<typeof node>[]): Promise<StudioProjectV1> {
  const created = await store.createProject({ name: "Weekly", projectPath: path, minPluginVersion: "6.11.0", maxRuns: 10, maxArtifactsMb: 10 });
  return (await store.saveProject(path, { ...created.project, graph: { ...created.project.graph, nodes } })).project;
}

/** A user edit on one device: load, change, save against what was loaded. */
async function edit(on: Vault, change: (draft: StudioProjectV1) => void): Promise<StudioProjectV1> {
  const opened = await on.store.loadProject(path);
  const draft = cloneStudioProjectSnapshot(opened);
  change(draft);
  return (await on.store.saveProject(path, draft, { baseProject: opened })).project;
}

/** What StudioService does for a watcher event: import the changed file. */
const receive = (on: Vault) => on.store.importProjectText(path, on.files.get(path)!);

function session(store: StudioProjectStore, opened: StudioProjectV1): StudioProjectSession {
  return new StudioProjectSession({
    projectPath: path, project: opened, discreteDelayMs: 60000, continuousDelayMs: 60000,
    saveProject: (target, value, onBeforeProjectWrite, baseProject) => store.saveProject(target, value, { onBeforeProjectWrite, baseProject }),
  });
}

/** An external replacement arriving while a session is open, then the session's reconciliation. */
async function arrive(on: Vault, live: StudioProjectSession, external: StudioProjectV1, modified = now) {
  on.files.set(path, serializeStudioProject(external));
  on.mtimes.set(path, modified);
  const result = await receive(on);
  await live.reconcileExternalProject(result.project, serializeStudioProject(result.project));
  return result.conflicts;
}

const find = (value: StudioProjectV1, id: string) => value.graph.nodes.find(item => item.id === id);
const values = (value: StudioProjectV1) => Object.fromEntries(value.graph.nodes.map(item => [item.id, item.config.value]));
const ownClock = (on: Vault) => parseStudioClock(on.files.get(studioClockPath(path, on.device))!)!.clock;

describe("three-way merge of an external change", () => {
  it("merges different fields and separate edits of one text, then saves them together", async () => {
    const device = vault(), { store } = device;
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
    tick();
    await arrive(device, live, external);

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
    const device = vault(), { store, files } = device;
    const base = await project(store, [node("a", "Original wording")]);
    const live = session(store, base);
    live.mutate("node.config", draft => { find(draft, "a")!.config.value = "Local rewrite"; });
    const external = cloneStudioProjectSnapshot(base);
    find(external, "a")!.config.value = "External rewrite";
    tick();
    await arrive(device, live, external);

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
    const device = vault(), { files, store, restart } = device;
    const base = await project(store, [node("a", "keep"), node("b", "delete me")]);
    const staleTime = now;
    const stale = cloneStudioProjectSnapshot(base);
    find(stale, "b")!.position.x = 900;
    tick();
    const live = session(store, base);
    live.mutate("graph.node.remove", draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    await live.flushPendingSaveWork({ force: true });
    // Only the key and its deletion time are kept, in this device's clock beside the project.
    expect(Object.keys(ownClock(device).deleted)).toEqual(["node:b"]);
    expect(ownClock(device).stamps["node:b"]).toBeUndefined();

    // Another device that never saw the deletion replaces the file with its edited copy.
    tick();
    expect(await arrive(device, live, stale, staleTime)).toEqual(["Studio left out 1 deleted item that an older copy of this file still contained. Use Undo to bring back a deletion."]);
    expect(live.getProject().graph.nodes.map(item => item.id)).toEqual(["a"]);
    expect(JSON.parse(files.get(path)!).canvas.nodes.map((item: { id: string }) => item.id)).toEqual(["a"]);

    files.set(path, serializeStudioProject(stale));
    expect((await restart().loadProject(path)).graph.nodes.map(item => item.id)).toEqual(["a"]);

    // Undo is Studio's own restore: the node returns and its tombstone is cleared.
    tick();
    live.applyHistorySnapshot(base);
    await live.flushPendingSaveWork({ force: true });
    expect((await restart().loadProject(path)).graph.nodes.map(item => item.id).sort()).toEqual(["a", "b"]);
    expect(ownClock(device).deleted).toEqual({});
    await live.close();
  });
});

describe("stamped merge of a copy from another device", () => {
  async function pair() {
    const a = vault("aaaaaaaaaaaa"), b = vault("bbbbbbbbbbbb");
    await project(a.store, [node("a", "Alpha"), node("b", "Beta")]);
    deliver(a, b, { project: true, clock: true });
    await b.store.loadProject(path);
    tick();
    return { a, b };
  }

  it.each([["before", false], ["after", true]])("keeps this device's newer edits and entities from a stale copy and applies the other device's edit (its edit %s this device's)", async (_order, otherEditsLast) => {
    const { a, b } = await pair();
    const onB = async () => { await edit(b, draft => { find(draft, "b")!.config.value = "Beta from B"; }); tick(); };
    // B is offline while both devices edit.
    if (!otherEditsLast) await onB();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha from A"; draft.graph.nodes.push(node("c", "Created on A")); });
    tick();
    if (otherEditsLast) await onB();
    // B reconnects: its clock and its whole-file copy arrive.
    deliver(b, a, { project: true, clock: true });
    const merged = await receive(a);
    expect(merged.conflicts).toEqual([]);
    expect(values(merged.project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A" });

    // The merge is published, so B receives A's edits, and both files converge.
    tick();
    deliver(a, b, { project: true, clock: true });
    expect(values((await receive(b)).project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A" });
    expect(b.files.get(path)).toBe(a.files.get(path));
  });

  it("keeps edits to different fields of the same entity from both devices", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "a")!.title = "Renamed on B"; });
    tick();
    await edit(a, draft => { find(draft, "a")!.position.x = 480; });
    deliver(b, a, { project: true, clock: true });
    expect(find((await receive(a)).project, "a")).toMatchObject({ title: "Renamed on B", position: { x: 480 } });
  });

  it("gives a field changed on both devices the newer value, and combines separate changes to prose", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.position.x = 100; find(draft, "b")!.config.value = "Beta. Include risks."; });
    tick();
    await edit(b, draft => { find(draft, "a")!.position.x = 200; find(draft, "b")!.config.value = "Please review: Beta"; });
    deliver(b, a, { project: true, clock: true });
    const merged = (await receive(a)).project;
    expect(find(merged, "a")!.position.x).toBe(200);
    expect(find(merged, "b")!.config.value).toBe("Please review: Beta. Include risks.");

    // A newer change on this device wins over an older one from the other device.
    tick();
    await edit(b, draft => { find(draft, "a")!.position.x = 300; });
    tick();
    await edit(a, draft => { find(draft, "a")!.position.x = 400; });
    deliver(b, a, { project: true, clock: true });
    expect(find((await receive(a)).project, "a")!.position.x).toBe(400);
  });

  it("applies a deletion made on the other device, even over an older edit here", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "b")!.config.value = "Edited before the deletion"; });
    tick();
    await edit(b, draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    deliver(b, a, { project: true, clock: true });
    expect(Object.keys(values((await receive(a)).project))).toEqual(["a"]);
    expect(Object.keys(ownClock(a).deleted)).toEqual(["node:b"]);
  });

  it("falls back to the file's modification time when the other device's clock arrives late, then uses the clock", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "b")!.config.value = "Beta from B"; });
    tick();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha from A"; draft.graph.nodes.push(node("c", "Created on A")); });
    tick();
    // The project file arrives first, carrying B's modification time; B's clock has not synchronized yet.
    deliver(b, a, { project: true });
    const early = await receive(a);
    expect(values(early.project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A" });
    expect(early.conflicts).toEqual(["Studio kept 2 newer changes from this device that a copy of this file from elsewhere did not include."]);

    // The clock arrives later; B receives A's merge, edits again, and the next copy merges by stamps.
    deliver(b, a, { clock: true });
    tick();
    deliver(a, b, { project: true, clock: true });
    await receive(b);
    tick();
    await edit(b, draft => { find(draft, "c")!.config.value = "Created on A, edited on B"; });
    deliver(b, a, { project: true, clock: true });
    const late = await receive(a);
    expect(late.conflicts).toEqual([]);
    expect(values(late.project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A, edited on B" });
  });

  it("keeps this device's entities and warns when nothing dates the copy", async () => {
    const a = vault("aaaaaaaaaaaa", { stat: false }), b = vault("bbbbbbbbbbbb");
    await project(a.store, [node("a", "Alpha")]);
    deliver(a, b, { project: true, clock: true });
    await b.store.loadProject(path);
    tick();
    await edit(a, draft => { draft.graph.nodes.push(node("c", "Created on A")); });
    tick();
    await edit(b, draft => { find(draft, "a")!.config.value = "Alpha from B"; });
    deliver(b, a, { project: true });
    const merged = await receive(a);
    expect(values(merged.project)).toEqual({ a: "Alpha from B", c: "Created on A" });
    expect(merged.conflicts).toEqual(["Studio kept 1 newer change from this device that a copy of this file from elsewhere did not include."]);
  });

  it("warns when a copy older than this device's changes replaced the file while Studio was closed", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha from A"; });
    tick();
    const restarted = a.restart();
    deliver(b, a, { project: true, clock: true });
    expect((await restarted.refreshDocument(path)).conflicts).toEqual(["This copy of the project is older than changes made on this device while Studio was closed. Those changes may be missing."]);
  });
});

describe("hybrid clock and clock files", () => {
  it("orders stamps by time, counter and device, and follows stamps seen from other devices", () => {
    let time = 1000;
    const clock = new StudioHybridClock("aaaaaaaaaaaa", () => time);
    const first = clock.now(), second = clock.now();
    expect(second > first).toBe(true);
    clock.observe(studioStamp(5000, 3, "bbbbbbbbbbbb"));
    time = 2000;
    expect(clock.now() > studioStamp(5000, 3, "bbbbbbbbbbbb")).toBe(true);
    // A stamp from a clock far in the future is not followed.
    clock.observe(studioStamp(time + 2 * 24 * 60 * 60 * 1000));
    expect(clock.now() < studioStamp(time + 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("prunes stamps and tombstones by age, drops stamps of absent entities, and rejects foreign files", () => {
    const wall = Date.UTC(2026, 8, 25), old = studioStamp(wall - STUDIO_CLOCK_MAX_AGE_MS - 1), recent = studioStamp(wall - 1000);
    const clock = emptyStudioClock();
    clock.stamps["node:a"] = { "": old, title: recent };
    clock.stamps["node:gone"] = { "": recent };
    clock.deleted["node:x"] = old;
    clock.deleted["node:y"] = recent;
    pruneStudioClock(clock, new Set(["node:a"]), wall);
    expect(JSON.parse(JSON.stringify(clock))).toEqual({ stamps: { "node:a": { title: recent } }, deleted: { "node:y": recent }, files: {} });
    expect(parseStudioClock("{")).toBeNull();
    expect(parseStudioClock(JSON.stringify({ schema: "other", device: "a" }))).toBeNull();
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
