import nodePath from "node:path";
import { desktopHost } from "../../../platform/desktopOnly";
import { hasHostCapability } from "../../../platform/hostCapabilities";
import { writeStudioDocumentAtomically } from "../StudioDocumentAtomicWrite";

jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn(), path: jest.fn() } }));
jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn() }));

const mockCapability = hasHostCapability as jest.MockedFunction<typeof hasHostCapability>;
const mockFs = desktopHost.fs as jest.Mock;
const mockPath = desktopHost.path as jest.Mock;

type FakeDesktop = {
  files: Map<string, string>;
  opened: string[];
  renamed: Array<[string, string]>;
  removed: string[];
  fs: Record<string, jest.Mock>;
};

function desktop(root: string, initial: Record<string, string>, options?: { failWrite?: boolean; changeAfterTemporary?: string }): FakeDesktop {
  const files = new Map(Object.entries(initial).map(([relative, raw]) => [nodePath.join(root, relative), raw]));
  const state: FakeDesktop = { files, opened: [], renamed: [], removed: [], fs: {} };
  state.fs = {
    readFile: jest.fn(async (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(path)!;
    }),
    open: jest.fn(async (path: string, flags: string) => {
      expect(flags).toBe("wx");
      if (files.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      state.opened.push(path);
      files.set(path, "");
      return {
        writeFile: jest.fn(async (raw: string) => {
          if (options?.failWrite) throw new Error("disk full");
          files.set(path, raw);
          if (options?.changeAfterTemporary !== undefined) {
            const target = nodePath.join(nodePath.dirname(path), nodePath.basename(path).replace(/^\./, "").replace(/\.[^.]+\.tmp$/, ""));
            files.set(target, options.changeAfterTemporary);
          }
        }),
        sync: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
      };
    }),
    rename: jest.fn(async (from: string, to: string) => {
      state.renamed.push([from, to]);
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    rm: jest.fn(async (path: string, { force }: { force: boolean }) => {
      expect(force).toBe(true);
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

  it("returns true without touching storage when nothing changes", async () => {
    mockCapability.mockReturnValue(true);
    const adapter = adapterFor("/vault");
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "same", "same")).toBe(true);
    expect(mockFs).not.toHaveBeenCalled();
    expect(adapter.process).not.toHaveBeenCalled();
  });

  it("publishes through one temporary sibling and a rename on desktop", async () => {
    mockCapability.mockReturnValue(true);
    const state = desktop("/vault", { "Studio/A.systemsculpt": "before" });
    expect(await writeStudioDocumentAtomically(adapterFor("/vault"), "Studio/A.systemsculpt", "before", "after")).toBe(true);
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
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toBe(true);
    expect(stored).toBe("after");
    expect(mockFs).not.toHaveBeenCalled();

    stored = "someone else";
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toBe(false);
    expect(stored).toBe("someone else");
  });

  it("uses the adapter when the desktop adapter cannot resolve a base path", async () => {
    mockCapability.mockReturnValue(true);
    let stored = "before";
    const adapter = { process: jest.fn(async (_path: string, update: (current: string) => string) => { stored = update(stored); }) } as any;
    expect(await writeStudioDocumentAtomically(adapter, "Studio/A.systemsculpt", "before", "after")).toBe(true);
    expect(stored).toBe("after");
    expect(mockFs).not.toHaveBeenCalled();
  });
});
