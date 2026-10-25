import nodePath from "node:path";
import { desktopHost } from "../../../platform/desktopOnly";
import { hasHostCapability } from "../../../platform/hostCapabilities";
import { StudioProjectStore } from "../../StudioProjectStore";
import { StudioProjectSession } from "../../StudioProjectSession";
import { StudioProjectSessionManager } from "../../StudioProjectSessionManager";
import type { StudioProjectV1 } from "../../types";

jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn(), path: jest.fn() } }));
jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn() }));

const path = "Studio/Notes.systemsculpt";
const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });

/**
 * A desktop vault: Obsidian's adapter and Node's file system over the same
 * files. Writes carry sub-millisecond modification times, as APFS, ext4 and
 * NTFS keep them. `published` counts project files replaced on disk; `reads`
 * counts every read of the project file, through either interface.
 */
function desktopVault() {
  const root = "/vault";
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const dirs = new Set<string>();
  const counts = { published: 0, reads: 0, fsyncs: 0 };
  let clock = Date.UTC(2026, 9, 25, 9) + 0.25;
  const put = (file: string, data: string) => { files.set(file, data); mtimes.set(file, clock += 1.5); };
  const read = (file: string) => {
    if (file === path) counts.reads++;
    if (!files.has(file)) throw missing(file);
    return files.get(file)!;
  };
  const stat = (file: string) => {
    if (!files.has(file)) throw missing(file);
    return { mtimeMs: mtimes.get(file)!, size: Buffer.byteLength(files.get(file)!) };
  };
  const relative = (full: string) => nodePath.relative(root, full).split(nodePath.sep).join("/");
  (desktopHost.fs as jest.Mock).mockResolvedValue({
    stat: async (full: string) => stat(relative(full)),
    readFile: async (full: string) => read(relative(full)),
    open: async (full: string) => {
      const file = relative(full);
      if (files.has(file)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      put(file, "");
      return {
        writeFile: async (raw: string) => put(file, raw),
        sync: async () => { counts.fsyncs++; },
        stat: async () => stat(file),
        close: async () => undefined,
      };
    },
    rename: async (from: string, to: string) => {
      const source = relative(from), target = relative(to);
      if (target === path) counts.published++;
      files.set(target, files.get(source)!); mtimes.set(target, mtimes.get(source)!);
      files.delete(source); mtimes.delete(source);
    },
    rm: async (full: string) => { files.delete(relative(full)); mtimes.delete(relative(full)); },
  });
  (desktopHost.path as jest.Mock).mockResolvedValue(nodePath);
  const adapter = {
    getBasePath: () => root,
    exists: async (file: string) => files.has(file) || dirs.has(file),
    mkdir: async (folder: string) => { dirs.add(folder); },
    read: async (file: string) => read(file),
    write: async (file: string, data: string) => put(file, data),
    readBinary: async (file: string) => new TextEncoder().encode(read(file)).buffer,
    writeBinary: async (file: string, data: ArrayBuffer) => put(file, new TextDecoder().decode(data)),
    list: async (folder: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes("/")), folders: [] }),
    stat: async (file: string) => files.has(file) ? { type: "file", ctime: 0, ...stat(file) } : null,
  };
  const store = new StudioProjectStore({ vault: { adapter, getFiles: () => [...files.keys()].map(file => ({ path: file })) } } as never, { deviceId: "aaaaaaaaaaaa" });
  return {
    files, counts, store,
    /** Another writer replaces the file: an agent's file tools, a text editor or a sync client. */
    writeElsewhere: (raw: string) => put(path, raw),
  };
}
type Vault = ReturnType<typeof desktopVault>;

const textNode = (id: string, value: string, x = 0) => ({ id, kind: "studio.text", version: "1.0.0", title: id, position: { x, y: 0 }, config: { value } });

/** An open project with two text cards, saved the way Studio opens a view. */
async function openProject(vault: Vault): Promise<StudioProjectSession> {
  const created = await vault.store.createProject({ name: "Notes", projectPath: path, minPluginVersion: "6.18.0", maxRuns: 10, maxArtifactsMb: 10 });
  await vault.store.saveProject(path, { ...created.project, graph: { ...created.project.graph, nodes: [textNode("draft", ""), textNode("sources", "Sources", 400)] } });
  const opened = await vault.store.loadProject(path);
  return new StudioProjectSession({
    projectPath: path, project: opened,
    saveProject: (target, value, onBeforeProjectWrite, baseProject) => vault.store.saveProject(target, value, { onBeforeProjectWrite, baseProject }),
  });
}

/** One keystroke in a card, as the inline text editor reports it. */
const type = (session: StudioProjectSession, id: string, value: string) =>
  session.mutate("node.config", draft => { draft.graph.nodes.find(node => node.id === id)!.config.value = value; }, { mode: "continuous" });

const onDisk = (vault: Vault, id: string) => (JSON.parse(vault.files.get(path)!).canvas.nodes as Array<{ id: string; config: { value?: string } }>).find(node => node.id === id)?.config.value;
const sentence = "Draft the weekly note";

describe("Studio typing autosave", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (hasHostCapability as jest.Mock).mockImplementation(capability => capability === "local-filesystem");
  });
  afterEach(() => { jest.useRealTimers(); });

  it("writes 20 keystrokes 200 ms apart once, 1.5 s after the last, without reading the file again", async () => {
    const vault = desktopVault(), session = await openProject(vault);
    Object.assign(vault.counts, { published: 0, reads: 0, fsyncs: 0 });
    for (let key = 1; key <= 20; key++) {
      type(session, "draft", sentence.slice(0, key));
      await jest.advanceTimersByTimeAsync(200);
    }
    expect(vault.counts.published).toBe(0);
    await jest.advanceTimersByTimeAsync(1299);
    expect(vault.counts.published).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    await session.waitForInFlightSave();
    expect(vault.counts).toEqual({ published: 1, reads: 0, fsyncs: 1 });
    expect(onDisk(vault, "draft")).toBe(sentence.slice(0, 20));
    expect(session.getDebugState().hasPendingLocalSaveWork).toBe(false);

    // The next pause writes again, still from the stamp of this device's own write.
    type(session, "draft", sentence);
    await jest.advanceTimersByTimeAsync(1500);
    await session.waitForInFlightSave();
    expect(vault.counts).toEqual({ published: 2, reads: 0, fsyncs: 2 });
    expect(onDisk(vault, "draft")).toBe(sentence);
    await session.close();
  });

  it("saves a burst when its view closes before the pause", async () => {
    const vault = desktopVault(), session = await openProject(vault);
    vault.counts.published = 0;
    for (let key = 1; key <= 8; key++) {
      type(session, "draft", sentence.slice(0, key));
      await jest.advanceTimersByTimeAsync(200);
    }
    await session.close();
    expect(vault.counts.published).toBe(1);
    expect(onDisk(vault, "draft")).toBe(sentence.slice(0, 8));
    expect(session.isDisposed()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("saves a burst when the app quits or the plugin unloads before the pause", async () => {
    const vault = desktopVault(), manager = new StudioProjectSessionManager();
    const session = await manager.retainSession(path, () => openProject(vault));
    vault.counts.published = 0;
    for (let key = 1; key <= 5; key++) {
      type(session, "draft", sentence.slice(0, key));
      await jest.advanceTimersByTimeAsync(200);
    }
    // Quit: the save completes as the app's quit task and the session stays open.
    await manager.flushAll();
    expect(vault.counts.published).toBe(1);
    expect(onDisk(vault, "draft")).toBe(sentence.slice(0, 5));
    expect(session.isDisposed()).toBe(false);

    // Unload: plugin teardown closes every session, which saves what is pending.
    type(session, "draft", sentence.slice(0, 6));
    await jest.advanceTimersByTimeAsync(200);
    await manager.closeAll();
    expect(vault.counts.published).toBe(2);
    expect(onDisk(vault, "draft")).toBe(sentence.slice(0, 6));
    expect(session.isDisposed()).toBe(true);
  });

  it("reads and merges a file another writer changed since this device's write, even at the same size", async () => {
    const vault = desktopVault(), session = await openProject(vault);
    type(session, "draft", "Draft");
    await jest.advanceTimersByTimeAsync(1500);
    await session.waitForInFlightSave();

    // An agent rewrites the other card to text of the same length: same size, a later modification time.
    const file = JSON.parse(vault.files.get(path)!) as { canvas: { nodes: Array<{ id: string; config: { value: string } }> } };
    file.canvas.nodes.find(node => node.id === "sources")!.config.value = "Mirrors";
    const before = vault.files.get(path)!.length;
    vault.writeElsewhere(`${JSON.stringify(file, null, 2)}\n`);
    expect(vault.files.get(path)!.length).toBe(before);
    vault.counts.reads = 0;

    type(session, "draft", "Draft the note");
    await jest.advanceTimersByTimeAsync(1500);
    await session.waitForInFlightSave();
    expect(vault.counts.reads).toBeGreaterThan(0);
    expect(onDisk(vault, "draft")).toBe("Draft the note");
    expect(onDisk(vault, "sources")).toBe("Mirrors");
    const merged: StudioProjectV1 = session.getProject();
    expect(merged.graph.nodes.find(node => node.id === "sources")?.config.value).toBe("Mirrors");
    await session.close();
  });
});
