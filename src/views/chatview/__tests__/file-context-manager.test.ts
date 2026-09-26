/** @jest-environment jsdom */
import { App, TFile } from "obsidian";
import { FileContextManager } from "../FileContextManager";

const createManager = () => {
  const app = new App();
  const onContextChange = jest.fn(async () => {});
  const manager = new FileContextManager({
    app,
    plugin: {} as any,
    onContextChange,
  });
  return { app, onContextChange, manager };
};

describe("FileContextManager", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes and deduplicates pinned files", () => {
    const { app, manager } = createManager();
    const trigger = jest.spyOn(app.workspace, "trigger");
    expect(manager.pinFile("Note.md")).toBe(true);
    expect(Array.from(manager.getPinnedFiles())).toEqual(["[[Note.md]]"]);
    expect(manager.hasPinnedFile("Note.md")).toBe(true);
    expect(manager.pinFile("[[Note.md]]")).toBe(false);
    expect(trigger).toHaveBeenCalledWith(
      "systemsculpt:file-context-state-changed",
      expect.objectContaining({ manager, kind: "context" }),
    );
  });

  it("unpins files and persists the metadata change", async () => {
    const { manager, onContextChange } = createManager();
    manager.pinFile("Note.md");
    expect(await manager.unpinFile("Note.md")).toBe(true);
    expect(manager.getPinnedFiles().size).toBe(0);
    expect(onContextChange).toHaveBeenCalledTimes(1);
  });

  it("keeps only existing files when restoring the pinned set", async () => {
    const { app, manager } = createManager();
    const noteFile = new TFile({ path: "Note.md" });
    app.metadataCache.getFirstLinkpathDest = jest.fn((link) => (link === "Note" ? noteFile : null));
    app.vault.getAbstractFileByPath = jest.fn((path) => (path === "Note.md" ? noteFile : null));

    await manager.setPinnedFiles(["Note", "[[Note]]", "Missing"]);
    expect(Array.from(manager.getPinnedFiles())).toEqual(["[[Note]]"]);
  });

  it("does not restore the old conversation's pins after the context is cleared", async () => {
    const { app, manager } = createManager();
    app.metadataCache.getFirstLinkpathDest = jest.fn(() => new TFile({ path: "Note.md" }));

    const restoring = manager.setPinnedFiles(["Note.md"]);
    manager.clearPinnedFiles();
    await restoring;

    expect(manager.getPinnedFiles().size).toBe(0);
  });

});

const mockPinFiles = jest.fn();
const mockPinFile = jest.fn();
jest.mock("../../../services/DocumentContextManager", () => ({
  DocumentContextManager: { getInstance: () => ({ pinVaultFiles: mockPinFiles, pinVaultFile: mockPinFile }) },
}));

function harness() {
  const app = new App();
  const file = new TFile({ path: "report.pdf" });
  (app.vault.getFiles as jest.Mock).mockReturnValue([file]);
  const onContextChange = jest.fn(async () => undefined);
  const manager = new FileContextManager({ app, plugin: {} as never, onContextChange });
  return { manager, file };
}

describe("FileContextManager UI pin lifetime", () => {
  afterEach(() => { document.body.empty(); jest.clearAllMocks(); });

  it("passes a lifecycle signal to direct/drop pins and refuses new work after disposal", async () => {
    const { manager, file } = harness();
    let signal!: AbortSignal;
    mockPinFile.mockImplementationOnce((_file, _manager, options) => {
      signal = options.signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }));
    });
    const pending = manager.pinVaultFile(file);
    expect(signal.aborted).toBe(false);
    manager.dispose();
    await pending;
    expect(signal.aborted).toBe(true);
    await manager.pinVaultFile(file);
    await manager.openPinFiles();
    expect(mockPinFile).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="modal.context.pin"]')).toBeNull();
    expect(manager.pinFile("late.md")).toBe(false);
    expect(manager.getPinnedFiles().size).toBe(0);
  });

  it.each(["cancel", "dispose"] as const)("%s cancels the real picker callback without late notices", async (action) => {
    const notices = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const { manager } = harness();
    let signal!: AbortSignal;
    let reject!: (error: Error) => void;
    mockPinFiles.mockImplementationOnce((_files, _manager, options) => {
      signal = options.signal;
      return new Promise((_resolve, fail) => { reject = fail; });
    });
    await manager.openPinFiles();
    document.querySelector<HTMLInputElement>('.ss-context-file-item input[type="checkbox"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-testid="modal.context.pin"]')!.click();
    expect(signal.aborted).toBe(false);
    if (action === "cancel") document.querySelector<HTMLButtonElement>('[data-testid="modal.context.cancel"]')!.click();
    else manager.dispose();
    expect(signal.aborted).toBe(true);
    reject(new Error("Late download failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('[data-testid="modal.context.pin"]')).toBeNull();
    expect(notices).not.toHaveBeenCalled();
    manager.dispose();
    notices.mockRestore();
  });
});
