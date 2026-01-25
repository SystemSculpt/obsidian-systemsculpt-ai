import { JSDOM } from "jsdom";
import { App, TFile } from "obsidian";
import { handleOpenChatHistoryFile, handleSaveChatAsNote } from "../NotesHandlers";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        });
      return this;
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`.split(/\s+/).filter(Boolean).forEach((c) => this.classList.remove(c));
        });
      return this;
    };
  }
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
      this.appendChild(el);
      return el;
    };
  }
  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
  }
};

ensureDomHelpers();

describe("NotesHandlers", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens chat history file when present", async () => {
    const app = new App();
    const openFile = jest.fn(async () => {});
    app.workspace.getLeaf = jest.fn(() => ({ openFile }));

    const chatId = "chat-123";
    const chatFile = new TFile({ path: `SystemSculpt/Chats/${chatId}.md` });
    app.vault.getAbstractFileByPath = jest.fn(() => chatFile);

    const self = {
      app,
      plugin: { settings: { chatsDirectory: "SystemSculpt/Chats" } },
      getChatId: () => chatId,
    };

    await handleOpenChatHistoryFile(self as any);
    expect(openFile).toHaveBeenCalledWith(chatFile);
  });

  it("saves chat as note when file does not exist", async () => {
    const app = new App();
    app.vault.adapter = { exists: jest.fn(async () => false) } as any;
    app.vault.create = jest.fn(async () => {});
    app.vault.getAbstractFileByPath = jest.fn((path: string) => new TFile({ path }));
    app.workspace.openLinkText = jest.fn(async () => {});

    const self = {
      app,
      plugin: {
        app,
        settings: { savedChatsDirectory: "SystemSculpt/Saved Chats" },
        directoryManager: { ensureDirectoryByPath: jest.fn(async () => {}) },
      },
      getChatMarkdown: jest.fn(async () => "CHAT CONTENT"),
      getChatTitle: jest.fn(() => "My Chat"),
    };

    await handleSaveChatAsNote(self as any);
    expect(app.vault.create).toHaveBeenCalled();
    expect(app.workspace.openLinkText).toHaveBeenCalled();
  });

  it("overwrites existing chat note when confirmed", async () => {
    const app = new App();
    app.vault.adapter = { exists: jest.fn(async () => true) } as any;
    app.vault.modify = jest.fn(async () => {});
    app.vault.getAbstractFileByPath = jest.fn((path: string) => new TFile({ path }));
    app.workspace.openLinkText = jest.fn(async () => {});

    const self = {
      app,
      plugin: {
        app,
        settings: { savedChatsDirectory: "SystemSculpt/Saved Chats" },
        directoryManager: { ensureDirectoryByPath: jest.fn(async () => {}) },
      },
      getChatMarkdown: jest.fn(async () => "CHAT CONTENT"),
      getChatTitle: jest.fn(() => "My Chat"),
    };

    const promise = handleSaveChatAsNote(self as any);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const overwriteButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => btn.textContent === "Overwrite"
    );
    expect(overwriteButton).not.toBeNull();
    overwriteButton?.click();

    await promise;
    expect(app.vault.modify).toHaveBeenCalled();
  });
});
