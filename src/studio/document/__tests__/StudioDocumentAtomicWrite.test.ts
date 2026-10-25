import nodePath from "node:path";
import { desktopHost } from "../../../platform/desktopOnly";
import { hasHostCapability } from "../../../platform/hostCapabilities";
import { studioDocumentFileStamp, writeStudioDocumentAtomically } from "../StudioDocumentAtomicWrite";

jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn(), path: jest.fn() } }));
jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn() }));

const mockCapability = hasHostCapability as jest.MockedFunction<typeof hasHostCapability>;
const mockFs = desktopHost.fs as jest.Mock;
const mockPath = desktopHost.path as jest.Mock;

type FakeDesktop = {
  files: Map<string, string>;
  /** Modification times in milliseconds, with the sub-millisecond part APFS, ext4 and NTFS keep. */
  mtimes: Map<string, number>;
  opened: string[];
  renamed: Array<[string, string]>;
  removed: string[];
  fs: Record<string, jest.Mock>;
};

function desktop(root: string, initial: Record<string, string>, options?: { failWrite?: boolean; changeAfterTemporary?: string; wholeMilliseconds?: boolean }): FakeDesktop {
  const files = new Map(Object.entries(initial).map(([relative, raw]) => [nodePath.join(root, relative), raw]));
  let clock = 1_790_000_000_000.25;
  const touch = () => { clock += options?.wholeMilliseconds ? 1000 : 1.5; return options?.wholeMilliseconds ? Math.floor(clock) : clock; };
  const mtimes = new Map([...files.keys()].map(path => [path, touch()]));
  const stat = (path: string) => {
    if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { mtimeMs: mtimes.get(path)!, size: Buffer.byteLength(files.get(path)!) };
  };
  const state: FakeDesktop = { files, mtimes, opened: [], renamed: [], removed: [], fs: {} };
  state.fs = {
    stat: jest.fn(async (path: string) => stat(path)),
    readFile: jest.fn(async (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(path)!;
    }),
    open: jest.fn(async (path: string, flags: string) => {
      expect(flags).toBe("wx");
      if (files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      state.opened.push(path);
      files.set(path, "");
      mtimes.set(path, touch());
      return {
        writeFile: jest.fn(async (raw: string) => {
          if (options?.failWrite) throw new Error("disk full");
          files.set(path, raw);
          mtimes.set(path, touch());
          if (options?.changeAfterTemporary !== undefined) {
            const target = nodePath.join(nodePath.dirname(path), nodePath.basename(path).replace(/^\./, "").replace(/\.[^.]+\.tmp$/, ""));
            files.set(target, options.changeAfterTemporary);
            mtimes.set(target, touch());
          }
        }),
        sync: jest.fn(async () => undefined),
        stat: jest.fn(async () => stat(path)),
        close: jest.fn(async () => undefined),
      };
    }),
    rename: jest.fn(async (from: string, to: string) => {
      state.renamed.push([from, to]);
      files.set(to, files.get(from)!);
      mtimes.set(to, mtimes.get(from)!);
      files.delete(from);
      mtimes.delete(from);
    }),
    rm: jest.fn(async (path: string, { force }: { force: boolean }) => {
      expect(force).toBe(true);
      mtimes.delete(path);
      if (files.delete(path)) state.removed.push(path);
    }),
  };
  mockFs.mockResolvedValue(state.fs);
  mockPath.mockResolvedValue(nodePath);
  return state;
}

function adapterFor(root: string, processImpl?: jest.Mock) {
  return { getBasePath: () => root, process: processImpl ?? jest.fn() } as any;
}

describe("writeStudioDocumentAtomically", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "window", { value: { crypto: { randomUUID: () => "uuid" } }, configurable: true, writable: true });
  });

  it("succeeds without touching storage when nothing changes", async () => {
    mockCapability.mockReturnValue(true);
    const adapter = adapterFor("/vault");
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "same", "same")).toEqual({ fileStamp: null });
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "same", "same", "known")).toEqual({ fileStamp: "known" });
    expect(mockFs).not.toHaveBeenCalled();
    expect(adapter.process).not.toHaveBeenCalled();
  });

  it("publishes through one temporary sibling and a rename on desktop", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" });
    const published = await writeStudioDocumentAtomically(adapterFor("/vault"), "Studio/A.systemsculpt", "before", "after");
    expect(published).toEqual({ fileStamp: `${state.mtimes.get("/vault/Studio/A.systemsculpt")}:5` });
    expect(await studioDocumentFileStamp(adapterFor("/vault"), "Studio/A.systemsculpt")).toBe(published && published.fileStamp);
    expect(state.opened).toEqual(["/vault/Studio/.A.systemsculpt.uuid.tmp"]);
    expect(state.renamed).toEqual([["/vault/Studio/.A.systemsculpt.uuid.tmp", "/vault/Studio/A.systemsculpt"]]);
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("after");
    expect([...state.files.keys()]).toEqual(["/vault/Studio/A.systemsculpt"]);
  });

  it("refuses to replace bytes that no longer match the expected text", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "someone else" });
    expect(await writeStudioDocumentAtomically(adapterFor("/vault"), "Studio/A.systemsculpt", "before", "after")).toBe(false);
    expect(state.opened).toEqual([]);
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("someone else");
  });

  it("detects a competing write that lands after the temporary file exists and leaves no sibling behind", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" }, { changeAfterTemporary: "raced" });
    expect(await writeStudioDocumentAtomically(adapterFor("/vault"), "Studio/A.systemsculpt", "before", "after")).toBe(false);
    expect(state.renamed).toEqual([]);
    expect(state.removed).toEqual(["/vault/Studio/.A.systemsculpt.uuid.tmp"]);
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("raced");
    expect([...state.files.keys()]).toEqual(["/vault/Studio/A.systemsculpt"]);
  });

  it("removes the temporary sibling when writing fails and keeps the document intact", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" }, { failWrite: true });
    await expect(writeStudioDocumentAtomically(adapterFor("/vault"), "Studio/A.systemsculpt", "before", "after")).rejects.toThrow("disk full");
    expect(state.renamed).toEqual([]);
    expect(state.removed).toEqual(["/vault/Studio/.A.systemsculpt.uuid.tmp"]);
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("before");
    expect([...state.files.keys()]).toEqual(["/vault/Studio/A.systemsculpt"]);
  });

  it("rejects paths that escape the vault before reading anything", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", {});
    await expect(writeStudioDocumentAtomically(adapterFor("/vault"), "../outside.systemsculpt", "before", "after")).rejects.toThrow("outside the vault");
    expect(state.fs.readFile).not.toHaveBeenCalled();
    expect(state.fs.open).not.toHaveBeenCalled();
  });

  it("uses the adapter's serialized process operation when no local filesystem capability exists", async () => {
    mockCapability.mockReturnValue(false);
    let stored = "before";
    const process = jest.fn(async (_path: string, update: (current: string) => string) => { stored = update(stored); });
    const adapter = adapterFor("/vault", process);
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toEqual({ fileStamp: null });
    expect(stored).toBe("after");
    expect(mockFs).not.toHaveBeenCalled();
    expect(await studioDocumentFileStamp(adapter, "Studio/A.systemsculpt")).toBeNull();

    stored = "someone else";
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toBe(false);
    expect(stored).toBe("someone else");
  });

  it("uses the adapter when the desktop adapter cannot resolve a base path", async () => {
    mockCapability.mockReturnValue(true);
    let stored = "before";
    const adapter = { process: jest.fn(async (_path: string, update: (current: string) => string) => { stored = update(stored); }) } as any;
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toEqual({ fileStamp: null });
    expect(stored).toBe("after");
    expect(mockFs).not.toHaveBeenCalled();
  });
  it("publishes over its own last write from the file stamp alone, without reading the file", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" });
    const adapter = adapterFor("/vault");
    const first = await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "first");
    state.fs.readFile.mockClear();
    const second = await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "first", "second", first ? first.fileStamp ?? undefined : undefined);
    expect(state.fs.readFile).not.toHaveBeenCalled();
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("second");
    expect(second && second.fileStamp).toBe(await studioDocumentFileStamp(adapter, "Studio/A.systemsculpt"));
    expect(second && second.fileStamp).not.toBe(first && first.fileStamp);
  });

  it("reads the file when another writer changed it after the stamped write, even at the same size", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" });
    const adapter = adapterFor("/vault");
    const first = await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "first");
    state.files.set("/vault/Studio/A.systemsculpt", "agent");
    state.mtimes.set("/vault/Studio/A.systemsculpt", state.mtimes.get("/vault/Studio/A.systemsculpt")! + 0.5);
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "first", "second", first ? first.fileStamp ?? undefined : undefined)).toBe(false);
    expect(state.fs.readFile).toHaveBeenCalled();
    expect(state.files.get("/vault/Studio/A.systemsculpt")).toBe("agent");
  });

  it("gives no file stamp when the file system keeps only whole milliseconds", async () => {
    mockCapability.mockReturnValue(true);
    desktop("/vault", { "Studio/A.systemsculpt": "before" }, { wholeMilliseconds: true });
    const adapter = adapterFor("/vault");
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toEqual({ fileStamp: null });
    expect(await studioDocumentFileStamp(adapter, "Studio/A.systemsculpt")).toBeNull();
    expect(await studioDocumentFileStamp(adapter, "Studio/Missing.systemsculpt")).toBeNull();
  });
});
