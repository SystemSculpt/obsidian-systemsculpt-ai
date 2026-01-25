import { JSDOM } from "jsdom";
import { App, TFile } from "obsidian";
import { FileContextManager } from "../FileContextManager";
import type { DocumentProcessingProgressEvent } from "../../../types/documentProcessing";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).CustomEvent = dom.window.CustomEvent;

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

  it("normalizes and deduplicates context files", () => {
    const { manager } = createManager();
    expect(manager.addToContextFiles("Note.md")).toBe(true);
    expect(Array.from(manager.getContextFiles())).toEqual(["[[Note.md]]"]);
    expect(manager.addToContextFiles("[[Note.md]]")).toBe(false);
  });

  it("removes context files and triggers context change", async () => {
    const { manager, onContextChange } = createManager();
    manager.addToContextFiles("Note.md");
    expect(await manager.removeFromContextFiles("Note.md")).toBe(true);
    expect(manager.getContextFiles().size).toBe(0);
    expect(onContextChange).toHaveBeenCalledTimes(1);
  });

  it("keeps only existing files when setting context", async () => {
    const { app, manager } = createManager();
    const noteFile = new TFile({ path: "Note.md" });
    app.metadataCache.getFirstLinkpathDest = jest.fn((link) => (link === "Note" ? noteFile : null));
    app.vault.getAbstractFileByPath = jest.fn((path) => (path === "Note.md" ? noteFile : null));

    await manager.setContextFiles(["Note", "Missing"]);
    expect(Array.from(manager.getContextFiles())).toEqual(["[[Note]]"]);
  });

  it("cleans invalid context files and emits notices", async () => {
    const { app, manager, onContextChange } = createManager();
    const noteFile = new TFile({ path: "Note.md" });
    app.metadataCache.getFirstLinkpathDest = jest.fn((link) => (link === "Note" ? noteFile : null));
    app.vault.getAbstractFileByPath = jest.fn((path) => (path === "Note.md" ? noteFile : null));

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    manager.addToContextFiles("Note");
    manager.addToContextFiles("Missing");

    await manager.validateAndCleanContextFiles();

    expect(Array.from(manager.getContextFiles())).toEqual(["[[Note]]"]);
    expect(onContextChange).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("tracks processing entries and auto-removes ready states", () => {
    jest.useFakeTimers();
    (window as any).setTimeout = setTimeout;
    (window as any).clearTimeout = clearTimeout;

    const { manager } = createManager();
    const file = new TFile({ path: "Note.md" });
    const event: DocumentProcessingProgressEvent = {
      stage: "ready",
      progress: 100,
      label: "Done",
      icon: "check-circle",
      flow: "document",
    };
    manager.updateProcessingStatus(file, event);
    expect(manager.getProcessingEntries()).toHaveLength(1);

    jest.advanceTimersByTime(1500);
    expect(manager.getProcessingEntries()).toHaveLength(0);
    jest.useRealTimers();
  });

  it("dismisses processing entries manually", () => {
    const { manager } = createManager();
    const file = new TFile({ path: "Note.md" });
    const event: DocumentProcessingProgressEvent = {
      stage: "processing",
      progress: 32,
      label: "Processing",
      icon: "loader",
      flow: "document",
    };
    manager.updateProcessingStatus(file, event);
    expect(manager.getProcessingEntries()).toHaveLength(1);
    manager.dismissProcessingStatus(file.path);
    expect(manager.getProcessingEntries()).toHaveLength(0);
  });
});

