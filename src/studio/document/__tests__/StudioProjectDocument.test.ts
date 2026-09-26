import { readFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { StudioProjectStore } from "../../StudioProjectStore";
import { StudioProjectSession } from "../../StudioProjectSession";
import { serializeStudioProject } from "../../schema";
import { cloneStudioProjectSnapshot } from "../../StudioProjectSnapshots";
import type { StudioProjectV1 } from "../../types";
import { studioDocumentRevision, type StudioLegacyOriginalCopy } from "../StudioProjectDocument";
import { mergeStudioText } from "../StudioTextMerge";
import { STUDIO_MERGE_RETENTION_MS, StudioHybridClock, emptyStudioClock, pruneStudioClock, readStudioMergeBlock, studioStamp } from "../StudioDocumentClock";

let now = Date.UTC(2026, 8, 25, 9);
const tick = (ms = 1000) => { now += ms; };

/**
 * One device's vault. Writes carry the device's time as their modification
 * time; `restart` gives a fresh adapter object, as a plugin reload does.
 */
function vault(device = "aaaaaaaaaaaa") {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>();
  /** Paths whose writes fail, as a blocked or read-only folder does. */
  const blocked = new Set<string>();
  let beforeProcess: (() => void) | undefined;
  const put = (path: string, data: string) => { files.set(path, data); mtimes.set(path, now); };
  const adapter = () => ({
    exists: async (path: string) => files.has(path) || dirs.has(path),
    mkdir: async (path: string) => { dirs.add(path); },
    read: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return files.get(path)!; },
    write: async (path: string, data: string) => { if (blocked.has(path)) throw new Error(`Cannot write ${path}`); put(path, data); },
    readBinary: async (path: string) => { if (!files.has(path)) throw new Error(`File not found: ${path}`); return new TextEncoder().encode(files.get(path)!).buffer; },
    writeBinary: async (path: string, data: ArrayBuffer) => { put(path, new TextDecoder().decode(data)); },
    process: async (path: string, update: (data: string) => string) => {
      if (blocked.has(path)) throw new Error(`Cannot write ${path}`);
      const interleave = beforeProcess; beforeProcess = undefined; interleave?.();
      const next = update(files.get(path)!); put(path, next); return next;
    },
    list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")), folders: [] }),
    remove: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => { put(to, files.get(from)!); files.delete(from); },
    stat: async (path: string) => files.has(path) ? { type: "file", ctime: 0, mtime: mtimes.get(path)!, size: files.get(path)!.length } : null,
  });
  const copies: StudioLegacyOriginalCopy[] = [];
  /** Merge notices, as the user sees them. */
  const notices: string[] = [];
  const open = () => new StudioProjectStore({ vault: { adapter: adapter(), getFiles: () => [...files.keys()].map(path => ({ path })) } } as never, {
    deviceId: device, now: () => now, onLegacyOriginalCopied: copy => copies.push(copy), onMergeNotice: (_path, message) => notices.push(message),
  });
  return { device, files, mtimes, blocked, copies, notices, store: open(), restart: open, beforeNextProcess: (callback: () => void) => { beforeProcess = callback; } };
}
type Vault = ReturnType<typeof vault>;

const path = "Studio/Weekly.systemsculpt";
const node = (id: string, value: string, x = 0) => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x, y: 0 }, config: { value } });

/** Synchronization delivers another device's project file with its modification time. */
function deliver(from: Vault, to: Vault, bytes = from.files.get(path)!) {
  to.files.set(path, bytes);
  to.mtimes.set(path, from.mtimes.get(path)!);
}

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

/** What StudioService does for a watcher event: import the current file. */
const receive = (on: Vault) => on.store.refreshDocument(path);

function session(store: StudioProjectStore, opened: StudioProjectV1): StudioProjectSession {
  return new StudioProjectSession({
    projectPath: path, project: opened, discreteDelayMs: 60000, continuousDelayMs: 60000,
    saveProject: (target, value, onBeforeProjectWrite, baseProject) => store.saveProject(target, value, { onBeforeProjectWrite, baseProject }),
  });
}

/** A file written on this device outside Studio's merge, then the open session's reconciliation. */
async function arrive(on: Vault, live: StudioProjectSession, external: StudioProjectV1) {
  on.files.set(path, serializeStudioProject(external));
  on.mtimes.set(path, now);
  const result = await receive(on);
  await live.reconcileExternalProject(result.project, serializeStudioProject(result.project));
}

/** Edit the file's JSON as a text editor or an agent's file tools would. */
function rewriteFile(on: Vault, change: (file: { canvas: { nodes: Array<{ id: string; config?: { value?: string } }> }; merge?: unknown }) => void) {
  const file = JSON.parse(on.files.get(path)!);
  change(file);
  on.files.set(path, `${JSON.stringify(file, null, 2)}\n`);
  on.mtimes.set(path, now);
}

const find = (value: StudioProjectV1, id: string) => value.graph.nodes.find(item => item.id === id);
const values = (value: StudioProjectV1) => Object.fromEntries(value.graph.nodes.map(item => [item.id, item.config.value]));
const block = (on: Vault) => readStudioMergeBlock(JSON.parse(on.files.get(path)!).merge)!;

/** Device A creates the project with cards a and b, and device B opens A's file. */
async function pair() {
  const a = vault("aaaaaaaaaaaa"), b = vault("bbbbbbbbbbbb");
  await project(a.store, [node("a", "Alpha"), node("b", "Beta")]);
  deliver(a, b);
  await b.store.loadProject(path);
  tick();
  return { a, b };
}

describe("edits made on this device outside Studio's merge", () => {
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

  it("applies an agent's file edit in full, deletions included, and publishes its stamps with the next save", async () => {
    const device = vault();
    await project(device.store, [node("a", "Alpha"), node("b", "Beta")]);
    const published = block(device);
    tick();
    // The agent's file tools keep the merge record and change the canvas.
    rewriteFile(device, file => {
      file.canvas.nodes = file.canvas.nodes.filter(item => item.id !== "b");
      file.canvas.nodes[0].config = { value: "Alpha, by the agent" };
    });
    const agentFile = device.files.get(path)!;
    expect(values((await receive(device)).project)).toEqual({ a: "Alpha, by the agent" });
    // The file is not rewritten under the editor that wrote it.
    expect(device.files.get(path)).toBe(agentFile);
    expect(device.notices).toEqual([]);

    tick();
    await edit(device, draft => { find(draft, "a")!.title = "Renamed"; });
    const next = block(device);
    expect(next.at > published.at).toBe(true);
    expect(Object.keys(next.deleted)).toEqual(["node:b"]);
    expect(next.canvas).toBe(await studioDocumentRevision(serializeStudioProject(await device.store.loadProject(path))));
  });

  it("applies a text editor's edit that drops the merge record", async () => {
    const device = vault();
    await project(device.store, [node("a", "Alpha")]);
    tick();
    rewriteFile(device, file => { delete file.merge; file.canvas.nodes[0].config = { value: "Edited by hand" }; });
    expect(values((await receive(device)).project)).toEqual({ a: "Edited by hand" });
    tick();
    await edit(device, draft => { find(draft, "a")!.title = "Renamed"; });
    expect(values(await device.store.loadProject(path))).toEqual({ a: "Edited by hand" });
    expect(block(device)).not.toBeNull();
  });

  it("gives another device an edit made outside Studio's merge as that device's own edit", async () => {
    const { a, b } = await pair();
    // An agent edits A's published file; B has accepted that same publication.
    rewriteFile(a, file => { file.canvas.nodes[1].config = { value: "Beta, by the agent" }; });
    tick();
    deliver(a, b);
    expect(values((await receive(b)).project)).toEqual({ a: "Alpha", b: "Beta, by the agent" });
  });
});

describe("copies from another device", () => {
  it("keeps a failed publication's tentative edit out of the accepted merge baseline", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "a")!.position.x = 5; });
    const older = b.files.get(path)!;
    tick();
    await edit(b, draft => { find(draft, "a")!.position.x = 10; });
    deliver(b, a);
    const before = (await receive(a)).project;
    const wanted = cloneStudioProjectSnapshot(before);
    find(wanted, "a")!.position.x = 11;
    a.beforeNextProcess(() => deliver(b, a, older));
    const saved = await a.store.saveProject(path, wanted, { baseProject: before });
    expect(saved.conflicts).toEqual([]);
    expect(find(saved.project, "a")!.position.x).toBe(11);
    expect(find(await a.restart().loadProject(path), "a")!.position.x).toBe(11);
  });

  it.each(["disabled", "config", "membership"])("keeps an absent %s field's removal stamp through restart and stale replay", async field => {
    const { a, b } = await pair();
    if (field === "membership") {
      await edit(a, draft => { draft.graph.groups = [{ id: "g", name: "Group", nodeIds: ["b"] }]; });
      deliver(a, b); await receive(b); tick();
    }
    const change = (draft: StudioProjectV1, present: boolean) => {
      if (field === "disabled") find(draft, "a")!.disabled = present;
      else if (field === "config") {
        if (present) find(draft, "a")!.config.description = "Old description";
        else delete find(draft, "a")!.config.description;
      } else draft.graph.groups![0].nodeIds = present ? ["a", "b"] : ["b"];
    };
    await edit(b, draft => change(draft, true));
    const intermediate = b.files.get(path)!;
    tick();
    await edit(b, draft => change(draft, false));
    deliver(b, a); await receive(a);
    const restarted = { ...a, store: a.restart() };
    await restarted.store.loadProject(path);
    deliver(b, restarted, intermediate);
    const after = (await receive(restarted)).project;
    if (field === "disabled") expect(find(after, "a")!.disabled).not.toBe(true);
    else if (field === "config") expect(find(after, "a")!.config.description).toBeUndefined();
    else expect(after.graph.groups![0].nodeIds).toEqual(["b"]);
  });

  it("settles after both devices remove the same optional field", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.disabled = true; });
    deliver(a, b); await receive(b); tick();
    await edit(a, draft => { find(draft, "a")!.disabled = false; });
    tick();
    await edit(b, draft => { find(draft, "a")!.disabled = false; });
    deliver(b, a); await receive(a);
    const settled = a.files.get(path);
    for (let delivery = 0; delivery < 3; delivery++) {
      tick(); deliver(a, b); await receive(b);
      tick(); deliver(b, a); await receive(a);
      expect(a.files.get(path)).toBe(settled);
      expect(b.files.get(path)).toBe(settled);
    }
  });

  it("publishes a retained deletion even when merging leaves the incoming canvas unchanged", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { draft.graph.nodes.push(node("c", "Created on A")); });
    const staleCopy = a.files.get(path)!;
    tick();
    await edit(a, draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "c"); });
    const deletion = block(a).deleted["node:c"];
    tick();
    await edit(b, draft => { find(draft, "a")!.title = "Renamed on B"; });
    deliver(b, a);
    await receive(a);
    expect(block(a).deleted["node:c"]).toBe(deletion);

    const restarted = { ...a, store: a.restart() };
    await restarted.store.loadProject(path);
    deliver(b, restarted, staleCopy);
    expect(values((await receive(restarted)).project)).toEqual({ a: "Alpha", b: "Beta" });
    // The merged publication reaches the other device and settles without a write loop.
    deliver(a, b);
    await receive(b);
    expect(b.files.get(path)).toBe(a.files.get(path));
  });

  it("adopts newer stamps for equal values before an intermediate stale edit arrives", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.title = "Shared title"; });
    tick();
    await edit(b, draft => { find(draft, "a")!.title = "Stale title"; });
    const staleCopy = b.files.get(path)!;
    tick();
    await edit(b, draft => { find(draft, "a")!.title = "Shared title"; });
    deliver(b, a);
    await receive(a);
    expect(a.files.get(path)).toBe(b.files.get(path));

    deliver(b, a, staleCopy);
    expect(find((await receive(a)).project, "a")!.title).toBe("Shared title");
  });

  it("fingerprints the published merge record when accepting a project in the live session", async () => {
    const { a, b } = await pair();
    const live = session(a.store, await a.store.loadProject(path));
    const before = a.files.get(path)!;
    live.markAcceptedProjectText(before);
    tick();
    // Same canvas, new publication: the session must still evaluate its merge information.
    await edit(b, () => {});
    deliver(b, a);
    expect(live.resolveProjectFileTextUpdate(a.files.get(path)!).decision).toEqual({ kind: "evaluate" });
    const result = await receive(a);
    const published = await a.store.readProjectRawText(path);
    await live.reconcileExternalProject(result.project, published);
    expect(live.matchesLastAcceptedProjectText(published!)).toBe(true);
    expect(live.matchesLastAcceptedProjectText(before)).toBe(false);
    expect(live.matchesLastAcceptedProjectText(serializeStudioProject(result.project))).toBe(false);
    await live.close();
  });

  it("remembers a restore even when this device never saw the deletion", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    const deletion = b.files.get(path)!;
    tick();
    await edit(b, draft => { draft.graph.nodes.push(node("b", "Beta")); });
    deliver(b, a);
    await receive(a);
    deliver(b, a, deletion);
    expect(values((await receive(a)).project)).toEqual({ a: "Alpha", b: "Beta" });
  });

  it.each([["before", false], ["after", true]])("keep this device's newer edits and cards from an offline device and apply that device's edit (its edit %s this device's)", async (_order, otherEditsLast) => {
    const { a, b } = await pair();
    const onB = async () => { await edit(b, draft => { find(draft, "b")!.config.value = "Beta from B"; }); tick(); };
    // B is offline while both devices edit.
    if (!otherEditsLast) await onB();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha from A"; draft.graph.nodes.push(node("c", "Created on A")); });
    tick();
    if (otherEditsLast) await onB();
    // B reconnects: its copy arrives.
    deliver(b, a);
    expect(values((await receive(a)).project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A" });
    expect(a.notices).toEqual([]);

    // The merge is published, so B receives A's edits, and both files converge.
    tick();
    deliver(a, b);
    expect(values((await receive(b)).project)).toEqual({ a: "Alpha from A", b: "Beta from B", c: "Created on A" });
    expect(b.files.get(path)).toBe(a.files.get(path));
  });

  it("keeps edits to different fields of the same card from both devices", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "a")!.title = "Renamed on B"; });
    tick();
    await edit(a, draft => { find(draft, "a")!.position.x = 480; });
    deliver(b, a);
    expect(find((await receive(a)).project, "a")).toMatchObject({ title: "Renamed on B", position: { x: 480 } });
  });

  it("gives a field changed on both devices the newer value, and combines separate changes to prose made from the same earlier text", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.position.x = 100; find(draft, "b")!.config.value = "Beta. Include risks."; });
    tick();
    await edit(b, draft => { find(draft, "a")!.position.x = 200; find(draft, "b")!.config.value = "Please review: Beta"; });
    deliver(b, a);
    const merged = (await receive(a)).project;
    expect(find(merged, "a")!.position.x).toBe(200);
    expect(find(merged, "b")!.config.value).toBe("Please review: Beta. Include risks.");

    // A newer change on this device wins over an older one from the other device.
    tick();
    await edit(b, draft => { find(draft, "a")!.position.x = 300; });
    tick();
    await edit(a, draft => { find(draft, "a")!.position.x = 400; });
    deliver(b, a);
    expect(find((await receive(a)).project, "a")!.position.x).toBe(400);
  });

  it("combines separate prose changes after repeated autosaves on both devices", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "b")!.config.value = "Beta. Include"; });
    tick();
    await edit(a, draft => { find(draft, "b")!.config.value = "Beta. Include risks."; });
    tick();
    await edit(b, draft => { find(draft, "b")!.config.value = "Review: Beta"; });
    tick();
    await edit(b, draft => { find(draft, "b")!.config.value = "Please review: Beta"; });
    deliver(b, a);
    expect(find((await receive(a)).project, "b")!.config.value).toBe("Please review: Beta. Include risks.");
    deliver(a, b);
    expect(find((await receive(b)).project, "b")!.config.value).toBe("Please review: Beta. Include risks.");
    expect(b.files.get(path)).toBe(a.files.get(path));
  });

  it("does not combine prose with a change made from text the other device never had", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "a")!.config.value = "one two three four"; });
    tick();
    // B, offline, changes the original text.
    await edit(b, draft => { find(draft, "a")!.config.value = "one 2 three"; });
    tick();
    // A restarts, so its next change starts from "one two three four".
    const restarted = { ...a, store: a.restart() };
    await edit(restarted, draft => { find(draft, "a")!.config.value = "zero one two three four"; });
    tick();
    deliver(b, restarted);
    // Diff3 against "one two three four" would read B's text as removing " four". The newer change wins instead.
    expect(values((await receive(restarted)).project).a).toBe("zero one two three four");
  });

  it("takes the other device's change to a field this device changed and changed back", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "a")!.config.value = "Alpha from B"; });
    tick();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alphax"; });
    tick();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha"; });
    tick();
    deliver(b, a);
    expect(values((await receive(a)).project).a).toBe("Alpha from B");
  });

  it.each([["position", false], ["position", true], ["prose", false], ["prose", true]])("resolves %s Undo in either delivery order and rejects later echoes (Undo first: %s)", async (field, undoFirst) => {
    const { a, b } = await pair();
    const write = (draft: StudioProjectV1, value: "base" | "local" | "peer") => {
      if (field === "position") find(draft, "a")!.position.x = { base: 0, local: 10, peer: 7 }[value];
      else find(draft, "a")!.config.value = { base: "Alpha", local: "Local", peer: "Peer" }[value];
    };
    const read = (value: StudioProjectV1) => field === "position" ? find(value, "a")!.position.x : find(value, "a")!.config.value;
    const expected = field === "position" ? 7 : "Peer";
    await edit(b, draft => write(draft, "peer")); tick();
    await edit(a, draft => write(draft, "local"));
    const c = vault("cccccccccccc"); deliver(a, c); await c.store.loadProject(path); tick();
    await edit(a, draft => write(draft, "base")); tick();
    await edit(c, draft => { find(draft, "a")!.title = "Unrelated peer title"; });
    const first = undoFirst ? b : a, second = undoFirst ? a : b;
    deliver(second, first); await receive(first);
    deliver(first, second); await receive(second);
    expect(read(await a.store.loadProject(path))).toBe(expected);
    expect(read(await b.store.loadProject(path))).toBe(expected);
    deliver(c, a);
    const afterEcho = (await receive(a)).project;
    expect(read(afterEcho)).toBe(expected);
    expect(find(afterEcho, "a")!.title).toBe("Unrelated peer title");
  });

  it.each(["position", "prose"])("preserves a newer %s edit after expired stamps, reopening and a stale delivery", async field => {
    const { a, b } = await pair();
    const c = vault("cccccccccccc"); deliver(a, c); await c.store.loadProject(path);
    const put = (draft: StudioProjectV1, older: boolean) => {
      if (field === "position") find(draft, "a")!.position.x = older ? 10 : 7;
      else find(draft, "a")!.config.value = older ? "Older peer value" : "Newer local value";
    };
    const read = (value: StudioProjectV1) => field === "position" ? find(value, "a")!.position.x : find(value, "a")!.config.value;
    const expected = field === "position" ? 7 : "Newer local value";
    tick(STUDIO_MERGE_RETENTION_MS + 1000);
    await edit(a, draft => { draft.name = "Current project title"; });
    tick(); await edit(c, draft => put(draft, true));
    tick(); await edit(b, draft => { find(draft, "a")!.title = "Unrelated peer title"; });
    tick(); await edit(a, draft => put(draft, false));
    deliver(b, a);
    expect(read((await receive(a)).project)).toBe(expected);
    const published = JSON.parse(a.files.get(path)!).merge;
    // Valid published entries must survive the actual file parser unchanged.
    expect(readStudioMergeBlock(published)!.stamps).toEqual(published.stamps);
    const reopened = { ...a, store: a.restart() };
    await reopened.store.loadProject(path);
    deliver(c, reopened);
    const replay = (await receive(reopened)).project;
    expect(read(replay)).toBe(expected);
    expect(find(replay, "a")!.title).toBe("Unrelated peer title");
  });

  it.each(["position", "prose"])("keeps local %s Undo when a peer republishes the superseded value with an unrelated edit", async field => {
    const { a, b } = await pair();
    const change = (draft: StudioProjectV1, changed: boolean) => {
      if (field === "position") find(draft, "a")!.position.x = changed ? 10 : 0;
      else find(draft, "a")!.config.value = changed ? "Alpha changed" : "Alpha";
    };
    await edit(a, draft => change(draft, true));
    deliver(a, b); await receive(b); tick();
    await edit(a, draft => change(draft, false));
    tick();
    await edit(b, draft => { find(draft, "a")!.title = "Peer title"; });
    deliver(b, a);
    expect(find((await receive(a)).project, "a")).toMatchObject({ title: "Peer title", position: { x: 0 }, config: { value: "Alpha" } });
  });

  it("applies a deletion made on the other device, even over an older edit here", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { find(draft, "b")!.config.value = "Edited before the deletion"; });
    tick();
    await edit(b, draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    deliver(b, a);
    expect(Object.keys(values((await receive(a)).project))).toEqual(["a"]);
    expect(Object.keys(block(a).deleted)).toEqual(["node:b"]);
  });

  it("leaves out a card this device deleted that an older copy still contains, until an explicit Undo", async () => {
    const { a, b } = await pair();
    await edit(b, draft => { find(draft, "b")!.position.x = 900; });
    tick();
    const live = session(a.store, await a.store.loadProject(path));
    live.mutate("graph.node.remove", draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    await live.flushPendingSaveWork({ force: true });
    tick();
    deliver(b, a);
    const result = await receive(a);
    await live.reconcileExternalProject(result.project, serializeStudioProject(result.project));
    expect(a.notices).toEqual(["Studio left out 1 deleted item that an older copy of this file still contained. Use Undo to bring back a deletion."]);
    expect(live.getProject().graph.nodes.map(item => item.id)).toEqual(["a"]);

    // Undo is Studio's own restore: the card returns and its tombstone is cleared.
    tick();
    const restored = cloneStudioProjectSnapshot(live.getProject());
    restored.graph.nodes.push(node("b", "Beta"));
    live.applyHistorySnapshot(restored);
    await live.flushPendingSaveWork({ force: true });
    expect((await a.store.loadProject(path)).graph.nodes.map(item => item.id).sort()).toEqual(["a", "b"]);
    expect(block(a).deleted).toEqual({});
    await live.close();
  });

  it("restores a card deleted and undone on another device, whenever the deletion reaches this device", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { draft.graph.nodes = draft.graph.nodes.filter(item => item.id !== "b"); });
    const deletion = a.files.get(path)!;
    tick(10_000);
    await edit(a, draft => { draft.graph.nodes.push(node("b", "Beta")); });
    tick(30_000);
    // B processes the deletion only after the Undo; its tombstone keeps the deletion's own time.
    deliver(a, b, deletion);
    expect(Object.keys(values((await receive(b)).project))).toEqual(["a"]);
    tick();
    deliver(a, b);
    expect(Object.keys(values((await receive(b)).project)).sort()).toEqual(["a", "b"]);
  });

  it("keeps a card from an older copy of a device that has learned of the card since", async () => {
    const { a, b } = await pair();
    await edit(a, draft => { draft.graph.nodes.push(node("c", "Created on A")); });
    tick();
    // B, not synced yet, edits and publishes a copy without the card.
    await edit(b, draft => { find(draft, "b")!.config.value = "Beta from B"; });
    const olderCopy = b.files.get(path)!;
    tick();
    // B then receives A's file and learns of the card.
    deliver(a, b);
    await receive(b);
    tick();
    // A receives B's older copy.
    deliver(b, a, olderCopy);
    expect(values((await receive(a)).project)).toEqual({ a: "Alpha", b: "Beta from B", c: "Created on A" });
    expect(block(a).deleted).toEqual({});
  });

  it("keeps what this device changed from a SystemSculpt 6.10 copy, applies its other changes, and says so", async () => {
    const { a } = await pair();
    await edit(a, draft => { find(draft, "a")!.config.value = "Alpha from A"; });
    tick();
    const legacy = JSON.parse(readFileSync(join(__dirname, "../../__tests__/fixtures/v610-document-state.systemsculpt"), "utf8")).document;
    rewriteFile(a, file => {
      delete file.merge;
      (file as Record<string, unknown>).document = legacy;
      file.canvas.nodes[0].config = { value: "Alpha from 6.10" };
      file.canvas.nodes[1].config = { value: "Beta from 6.10" };
    });
    expect(values((await receive(a)).project)).toEqual({ a: "Alpha from A", b: "Beta from 6.10" });
    expect(a.notices).toEqual(["SystemSculpt 6.10 on another device changed this project. Studio kept 1 change made on this device; update SystemSculpt on every device."]);
  });
});

describe("hybrid clock and merge records", () => {
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

  it("moves on a millisecond instead of widening a full counter", () => {
    const clock = new StudioHybridClock("aaaaaaaaaaaa", () => 1000);
    clock.observe(studioStamp(1000, 36 ** 4 - 1, "bbbbbbbbbbbb"));
    const next = clock.now();
    expect(next).toBe(studioStamp(1001, 0, "aaaaaaaaaaaa"));
    expect(next > studioStamp(1000, 36 ** 4 - 1, "bbbbbbbbbbbb")).toBe(true);
  });

  it("prunes stamps and tombstones by age, drops stamps of absent entities, and ignores damaged records", () => {
    const wall = Date.UTC(2026, 8, 25), old = studioStamp(wall - STUDIO_MERGE_RETENTION_MS - 1), recent = studioStamp(wall - 1000);
    const clock = emptyStudioClock();
    clock.stamps["node:a"] = { "": old, title: `${recent}/${old}` };
    clock.stamps["node:gone"] = { "": recent };
    clock.deleted["node:x"] = old;
    clock.deleted["node:y"] = recent;
    pruneStudioClock(clock, new Set(["node:a"]), wall);
    expect(JSON.parse(JSON.stringify(clock))).toEqual({ stamps: { "node:a": { title: `${recent}/${old}` } }, deleted: { "node:y": recent } });
    expect(readStudioMergeBlock(null)).toBeNull();
    expect(readStudioMergeBlock({ at: "not a stamp", canvas: "0".repeat(64) })).toBeNull();
    expect(readStudioMergeBlock({ at: recent, canvas: "0".repeat(64), stamps: { "node:a": { title: "junk", "": recent } }, deleted: { project: recent } }))
      .toEqual({ at: recent, canvas: "0".repeat(64), stamps: { "node:a": { "": recent } }, deleted: {} });
  });
});

describe("6.10 files with embedded merge state", () => {
  const fixture = readFileSync(join(__dirname, "../../__tests__/fixtures/v610-document-state.systemsculpt"), "utf8");

  it("opens the readable canvas, drops the merge state on the next save and keeps one byte-identical backup", async () => {
    const { files, store, copies, restart } = vault();
    files.set(path, fixture);
    const opened = await store.loadProject(path);
    // Loading alone never rewrites the file.
    expect(files.get(path)).toBe(fixture);
    expect(opened.graph.nodes.map(item => item.id)).toEqual(["brief", "summary"]);

    await store.saveProject(path, opened);
    const written = files.get(path)!;
    expect(Object.keys(JSON.parse(written))).toEqual(["schema", "id", "name", "docs", "canvas", "merge"]);
    expect(written.length).toBeLessThan(fixture.length);
    const original = JSON.parse(fixture), { merge: _merge, ...content } = JSON.parse(written);
    expect(content).toEqual({ schema: original.schema, id: original.id, name: original.name, docs: original.docs, canvas: original.canvas });

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
