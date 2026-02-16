import type { App, Menu, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../main";
import { FileContextMenuService } from "../context-menu/FileContextMenuService";
import { errorLogger } from "../utils/errorLogger";
import { tryCopyImageFileToClipboard } from "../utils/clipboard";
import type {
  DocumentProcessingModalHandle,
  DocumentProcessingModalLauncher,
} from "../modals/DocumentProcessingModal";

jest.mock("../views/chatview/ChatView", () => ({
  ChatView: jest.fn().mockImplementation(() => ({
    addFileToContext: jest.fn(),
  })),
}));

jest.mock("../utils/clipboard", () => ({
  tryCopyImageFileToClipboard: jest.fn(),
}));

const createMenuStub = () => {
  const trackedItems: Array<{ title: string; onClick?: () => void }> = [];

  const menu: Partial<Menu> & {
    recordedItems: typeof trackedItems;
    separators: number;
  } = {
    recordedItems: trackedItems,
    separators: 0,
    addItem(cb: (item: any) => void) {
      const item = {
        title: "",
        setTitle(title: string) {
          item.title = title;
          return item;
        },
        setIcon() {
          return item;
        },
        setSection() {
          return item;
        },
        onClick(handler: () => void) {
          item.onClickHandler = handler;
          return item;
        },
      } as any;

      cb(item);
      trackedItems.push({ title: item.title, onClick: item.onClickHandler });
      return menu as any;
    },
    addSeparator() {
      menu.separators += 1;
      return menu as any;
    },
    setUseNativeMenu() {
      return menu as any;
    },
  };

  return menu as Menu & { recordedItems: typeof trackedItems; separators: number };
};

const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

const createFile = (extension: string): TFile => {
  const name = `Example.${extension}`;
  return new (require("obsidian").TFile)({
    path: name,
    name,
    extension,
    stat: { ctime: Date.now(), mtime: Date.now(), size: 2048 },
  }) as TFile;
};

const createWorkspaceMock = (options: { layoutReady?: boolean } = {}) => {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const leaf = {
    openFile: jest.fn(async () => undefined),
  } as unknown as WorkspaceLeaf;
  const layoutCallbacks: Array<() => void> = [];
  const workspace = {
    layoutReady: options.layoutReady ?? true,
    on(event: string, callback: (...args: any[]) => void) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(callback);
      return { off: jest.fn() };
    },
    onLayoutReady(cb: () => void) {
      layoutCallbacks.push(cb);
      if (workspace.layoutReady) {
        cb();
      }
    },
    getLeaf: jest.fn(() => leaf),
    setActiveLeaf: jest.fn(),
  } as unknown as App["workspace"] & {
    layoutReady: boolean;
    onLayoutReady: (cb: () => void) => void;
  };

  const triggerLayoutReady = () => {
    if (!workspace.layoutReady) {
      workspace.layoutReady = true;
      layoutCallbacks.splice(0).forEach((cb) => cb());
    }
  };

  return { workspace, handlers, leaf, triggerLayoutReady };
};

const createPluginStub = () => {
  const registrations: Array<() => void> = [];
  const plugin = {
    registerEvent: jest.fn((ref) => ref),
    register: jest.fn((unload: () => void) => {
      registrations.push(unload);
    }),
    settings: {
      licenseKey: "license",
      licenseValid: true,
      cleanTranscriptionOutput: true,
    },
    pluginLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as unknown as SystemSculptPlugin & { pluginLogger: any };

  return { plugin, registrations };
};

describe("FileContextMenuService", () => {
const bootstrap = (
  options: { autoStart?: boolean; workspaceOptions?: { layoutReady?: boolean } } = {}
) => {
  const { workspace, handlers, triggerLayoutReady } = createWorkspaceMock(
    options.workspaceOptions
  );
  const vault = {
    getAbstractFileByPath: jest.fn(() => null),
    create: jest.fn(async () => createFile("md")),
    modify: jest.fn(async () => undefined),
  };
  const app = { workspace, vault } as unknown as App;
  const { plugin } = createPluginStub();
  const documentProcessor = {
    processDocument: jest.fn(async () => "site/extracted.md"),
  } as any;
  const chatLauncher = {
    open: jest.fn(async () => undefined),
  };

  const modalHandle: DocumentProcessingModalHandle = {
    updateProgress: jest.fn(),
    markSuccess: jest.fn(),
    markFailure: jest.fn(),
    close: jest.fn(),
  };

  const processingModalLauncher: DocumentProcessingModalLauncher = jest
    .fn()
    .mockReturnValue(modalHandle);

  const service = new FileContextMenuService({
    app,
    plugin,
    documentProcessor,
    chatLauncher,
    launchProcessingModal: processingModalLauncher,
  } as any);

  if (options.autoStart ?? true) {
    service.start();
  }

  (tryCopyImageFileToClipboard as jest.Mock).mockReset();
  (tryCopyImageFileToClipboard as jest.Mock).mockResolvedValue(true);

  return {
    app,
    plugin,
    service,
    handlers,
    documentProcessor,
    chatLauncher,
    processingModalLauncher,
    modalHandle,
    triggerLayoutReady,
  };
};

  const emitFileMenu = (
    handlers: Map<string, Array<(...args: any[]) => void>>,
    menu: Menu,
    file: TFile,
    source = "file-explorer",
    leaf?: WorkspaceLeaf
  ) => {
    const callbacks = handlers.get("file-menu") ?? [];
    callbacks.forEach((cb) => cb(menu, file, source, leaf));
  };

  const emitFilesMenu = (
    handlers: Map<string, Array<(...args: any[]) => void>>,
    menu: Menu,
    files: TAbstractFile[],
    source = "file-explorer"
  ) => {
    const callbacks = handlers.get("files-menu") ?? [];
    callbacks.forEach((cb) => cb(menu, files, source));
  };

  it("adds Convert to Markdown for supported documents", () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("pdf");

    emitFileMenu(handlers, menu, file, "preview");

    const titles = menu.recordedItems.map((item) => item.title);
    expect(titles).toContain("Convert to Markdown");
  });

  it("invokes the document processor when the menu item is clicked", async () => {
    const { handlers, documentProcessor } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("pdf");

    emitFileMenu(handlers, menu, file, "file-explorer");

    const entry = menu.recordedItems.find((item) =>
      item.title === "Convert to Markdown"
    );
    expect(entry).toBeDefined();
    await entry!.onClick?.();

    expect(documentProcessor.processDocument).toHaveBeenCalledWith(
      expect.objectContaining({ path: file.path }),
      expect.objectContaining({ flow: "document" })
    );
  });

  it("opens the processing modal and forwards progress events", async () => {
    const { handlers, documentProcessor, processingModalLauncher, modalHandle } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("pdf");

    emitFileMenu(handlers, menu, file, "file-explorer");

    const entry = menu.recordedItems.find((item) => item.title === "Convert to Markdown");
    expect(entry).toBeDefined();

    await entry!.onClick?.();

    expect(processingModalLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        app: expect.any(Object),
        file,
      })
    );

    const [, options] = documentProcessor.processDocument.mock.calls[0];
    expect(options?.onProgress).toBeDefined();

    const progressEvent = {
      stage: "uploading",
      progress: 20,
      label: "Uploading document",
      flow: "document",
    } as any;

    options.onProgress?.(progressEvent);

    expect(modalHandle.updateProgress).toHaveBeenCalledWith(progressEvent);
    expect(modalHandle.markSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionPath: "site/extracted.md",
      })
    );
  });

  it("marks the modal as failed when conversion errors", async () => {
    const { handlers, documentProcessor, processingModalLauncher, modalHandle } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("pdf");

    const error = new Error("license missing");
    (documentProcessor.processDocument as jest.Mock).mockRejectedValueOnce(error);

    emitFileMenu(handlers, menu, file, "file-explorer");

    const entry = menu.recordedItems.find((item) => item.title === "Convert to Markdown");
    expect(entry).toBeDefined();

    await entry!.onClick?.();

    expect(processingModalLauncher).toHaveBeenCalled();
    expect(modalHandle.markFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error,
      })
    );
  });

  it("does not add entries for unsupported files", () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("zip");

    emitFileMenu(handlers, menu, file, "preview");

    expect(menu.recordedItems).toHaveLength(0);
  });

  it("adds copy image entry for image files", () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("png");

    emitFileMenu(handlers, menu, file, "preview");

    const titles = menu.recordedItems.map((item) => item.title);
    expect(titles).toContain("SystemSculpt - Copy Image to Clipboard");
  });

  it("copies image to clipboard when copy image menu item is clicked", async () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("png");

    emitFileMenu(handlers, menu, file, "file-explorer");

    const entry = menu.recordedItems.find(
      (item) => item.title === "SystemSculpt - Copy Image to Clipboard"
    );
    expect(entry).toBeDefined();
    await entry!.onClick?.();

    expect(tryCopyImageFileToClipboard).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: file.path })
    );
  });

  it("shows failure notice when copy image fails", async () => {
    const { handlers } = bootstrap();
    (tryCopyImageFileToClipboard as jest.Mock).mockResolvedValueOnce(false);
    const menu = createMenuStub();
    const file = createFile("png");

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    emitFileMenu(handlers, menu, file, "file-explorer");

    const entry = menu.recordedItems.find(
      (item) => item.title === "SystemSculpt - Copy Image to Clipboard"
    );
    expect(entry).toBeDefined();
    await entry!.onClick?.();

    expect(logSpy).toHaveBeenCalledWith("Notice: Unable to copy image to clipboard.");
    logSpy.mockRestore();
  });

  it("adds a single entry when multiple files are selected but only one is convertible", () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const pdf = createFile("pdf");
    const folder = { constructor: { name: "TFolder" } } as unknown as TAbstractFile;

    emitFilesMenu(handlers, menu, [pdf, folder], "file-explorer");

    const count = menu.recordedItems.filter((item) => item.title === "Convert to Markdown").length;
    expect(count).toBe(1);
  });

  it("registers file context menu listeners immediately on construction", () => {
    const { handlers } = bootstrap({ autoStart: false });

    expect(handlers.get("file-menu")?.length ?? 0).toBeGreaterThan(0);
    expect(handlers.get("files-menu")?.length ?? 0).toBeGreaterThan(0);
  });

  it("logs menu openings even when no actions are available", () => {
    const { handlers } = bootstrap();
    const menu = createMenuStub();
    const file = createFile("png");
    const infoSpy = jest.spyOn(errorLogger, "info");

    emitFileMenu(handlers, menu, file, "file-explorer");

    expect(infoSpy).toHaveBeenCalledWith(
      "File menu opened",
      expect.objectContaining({
        source: "FileContextMenuService",
        metadata: expect.objectContaining({
          filePath: file.path,
          source: "file-explorer",
          extension: file.extension,
        }),
      })
    );

    infoSpy.mockRestore();
  });

  it("defers handler registration until layout is ready", () => {
    const { handlers, triggerLayoutReady } = bootstrap({
      autoStart: false,
      workspaceOptions: { layoutReady: false },
    });

    expect(handlers.get("file-menu")?.length ?? 0).toBe(0);
    expect(handlers.get("files-menu")?.length ?? 0).toBe(0);

    triggerLayoutReady();

    expect(handlers.get("file-menu")?.length ?? 0).toBeGreaterThan(0);
    expect(handlers.get("files-menu")?.length ?? 0).toBeGreaterThan(0);
  });
});
