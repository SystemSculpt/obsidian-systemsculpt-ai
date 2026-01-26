import { JSDOM } from "jsdom";
import { App, TFile } from "obsidian";
import { handleLargeTextPaste, handlePaste } from "../LargePasteHandlers";
import { LARGE_TEXT_THRESHOLDS, LargeTextHelpers } from "../../../../constants/largeText";
import { validateBrowserFileSize } from "../../../../utils/FileValidator";

jest.mock("../../../../utils/FileValidator", () => ({
  validateBrowserFileSize: jest.fn(async () => true),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;

  if (!proto.setText) {
    proto.setText = function (text: string) {
      this.textContent = text ?? "";
      return this;
    };
  }

  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const el = (this.ownerDocument ?? document).createElement(tag);
      if (options?.cls) {
        `${options.cls}`.split(/\s+/).filter(Boolean).forEach((c: string) => el.classList.add(c));
      }
      if (options?.text !== undefined) {
        el.textContent = `${options.text}`;
      }
      if (options?.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          if (value === true) el.setAttribute(key, "");
          else if (value !== false && value != null) el.setAttribute(key, `${value}`);
        });
      }
      this.appendChild(el);
      return el;
    };
  }

  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
};

ensureDomHelpers();

describe("LargePasteHandlers", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("inserts placeholder and stores pending content for large text", async () => {
    const insertTextAtCursor = jest.fn();
    const setPendingLargeTextContent = jest.fn();
    const text = "a\nb\nc";
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await handleLargeTextPaste(
      {
        app: new App(),
        plugin: {} as any,
        addFileToContext: jest.fn(async () => {}),
        insertTextAtCursor,
        getPendingLargeTextContent: () => null,
        setPendingLargeTextContent,
      },
      text
    );

    expect(setPendingLargeTextContent).toHaveBeenCalledWith(text);
    expect(insertTextAtCursor).toHaveBeenCalledWith(LargeTextHelpers.createPlaceholder(3));
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("blocks paste when text exceeds hard limit", async () => {
    const tooLargeText = "a".repeat(LARGE_TEXT_THRESHOLDS.MAX_SIZE_KB * 1024 + 1);
    const event = {
      clipboardData: {
        getData: jest.fn(() => tooLargeText),
        files: [],
      },
      preventDefault: jest.fn(),
    } as any;

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await handlePaste(
      {
        app: new App(),
        plugin: {} as any,
        addFileToContext: jest.fn(async () => {}),
        insertTextAtCursor: jest.fn(),
        getPendingLargeTextContent: () => null,
        setPendingLargeTextContent: jest.fn(),
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("prompts before handling hard warning text", async () => {
    const warningText = "a".repeat((LARGE_TEXT_THRESHOLDS.HARD_WARNING_KB + 8) * 1024);
    const event = {
      clipboardData: {
        getData: jest.fn(() => warningText),
        files: [],
      },
      preventDefault: jest.fn(),
    } as any;

    const pastePromise = handlePaste(
      {
        app: new App(),
        plugin: {} as any,
        addFileToContext: jest.fn(async () => {}),
        insertTextAtCursor: jest.fn(),
        getPendingLargeTextContent: () => null,
        setPendingLargeTextContent: jest.fn(),
      },
      event
    );

    await Promise.resolve();
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Cancel"
    );
    expect(cancelBtn).not.toBeNull();
    cancelBtn?.dispatchEvent(new dom.window.Event("click"));

    await pastePromise;

    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  it("handles pasted files and adds them to context", async () => {
    const app = new App();
    app.vault.createBinary = jest.fn(async () => {});
    app.vault.getAbstractFileByPath = jest.fn((path: string) => new TFile({ path }));

    const addFileToContext = jest.fn(async () => {});
    const plugin = {
      settings: { attachmentsDirectory: "Attachments" },
      directoryManager: { ensureDirectoryByPath: jest.fn(async () => {}) },
    } as any;

    const fakeFile = {
      name: "photo.png",
      type: "image/png",
      arrayBuffer: jest.fn(async () => new ArrayBuffer(4)),
    };

    const event = {
      clipboardData: {
        getData: jest.fn(() => ""),
        files: [fakeFile],
      },
      preventDefault: jest.fn(),
    } as any;

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await handlePaste(
      {
        app,
        plugin,
        addFileToContext,
        insertTextAtCursor: jest.fn(),
        getPendingLargeTextContent: () => null,
        setPendingLargeTextContent: jest.fn(),
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(validateBrowserFileSize).toHaveBeenCalled();
    expect(app.vault.createBinary).toHaveBeenCalled();
    expect(addFileToContext).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("skips inserting text when image files are present", async () => {
    const app = new App();
    app.vault.createBinary = jest.fn(async () => {});
    app.vault.getAbstractFileByPath = jest.fn((path: string) => new TFile({ path }));

    const addFileToContext = jest.fn(async () => {});
    const insertTextAtCursor = jest.fn();
    const plugin = {
      settings: { attachmentsDirectory: "Attachments" },
      directoryManager: { ensureDirectoryByPath: jest.fn(async () => {}) },
    } as any;

    const fakeImage = {
      name: "clipboard.png",
      type: "image/png",
      arrayBuffer: jest.fn(async () => new ArrayBuffer(4)),
    };

    const event = {
      clipboardData: {
        getData: jest.fn(() => "data:image/png;base64,abcd"),
        files: [fakeImage],
      },
      preventDefault: jest.fn(),
    } as any;

    await handlePaste(
      {
        app,
        plugin,
        addFileToContext,
        insertTextAtCursor,
        getPendingLargeTextContent: () => null,
        setPendingLargeTextContent: jest.fn(),
      },
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(validateBrowserFileSize).toHaveBeenCalled();
    expect(addFileToContext).toHaveBeenCalled();
    expect(insertTextAtCursor).not.toHaveBeenCalled();
  });
});
