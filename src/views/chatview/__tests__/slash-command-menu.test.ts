import { JSDOM } from "jsdom";
import { SlashCommandMenu } from "../SlashCommandMenu";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(global as any).window = dom.window;
(global as any).document = dom.window.document;

const ensureDomHelpers = () => {
  const proto = (global as any).window.HTMLElement?.prototype;
  if (!proto) return;
  if (!proto.addClass) {
    proto.addClass = function (cls: string) {
      this.classList.add(cls);
      return this;
    };
  }
  if (!proto.removeClass) {
    proto.removeClass = function (cls: string) {
      this.classList.remove(cls);
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
  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      return this.createEl("span", options);
    };
  }
  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
  }
  if (!proto.setAttr) {
    proto.setAttr = function (name: string, value: any) {
      if (value === null || value === undefined || value === false) {
        this.removeAttribute(name);
      } else if (value === true) {
        this.setAttribute(name, "");
      } else {
        this.setAttribute(name, `${value}`);
      }
      return this;
    };
  }
};

ensureDomHelpers();

describe("SlashCommandMenu", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("executes the history command when selected", async () => {
    const input = document.createElement("textarea");
    input.value = "/history";
    const handleOpenChatHistoryFile = jest.fn(async () => {});

    const menu = new SlashCommandMenu({
      plugin: {
        app: { workspace: { getLeaf: jest.fn(), setActiveLeaf: jest.fn() } },
        settings: { selectedModelId: "systemsculpt@@systemsculpt/ai-agent" },
      } as any,
      chatView: { messages: [] } as any,
      inputElement: input,
      inputHandler: { handleOpenChatHistoryFile },
      onClose: jest.fn(),
      onExecute: async (command) => {
        await command.execute({} as any);
      },
    });

    menu.show("history");

    const historyItem = Array.from(document.querySelectorAll(".systemsculpt-slash-result-item")).find(
      (el) => el.textContent?.includes("Open Chat History")
    );
    expect(historyItem).not.toBeNull();
    historyItem?.dispatchEvent(new dom.window.Event("click"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleOpenChatHistoryFile).toHaveBeenCalled();
  });

  it("executes the debug command when selected", async () => {
    const input = document.createElement("textarea");
    input.value = "/debug";
    const copyDebugSnapshotToClipboard = jest.fn(async () => {});
    const chatView = {
      copyCurrentChatFilePathToClipboard: jest.fn(async () => {}),
      copyChatArtifactPathsToClipboard: jest.fn(async () => {}),
      copyDebugSnapshotToClipboard,
    } as any;

    const menu = new SlashCommandMenu({
      plugin: {
        app: { workspace: { getLeaf: jest.fn(), setActiveLeaf: jest.fn() } },
        settings: { selectedModelId: "systemsculpt@@systemsculpt/ai-agent" },
      } as any,
      chatView,
      inputElement: input,
      inputHandler: { handleOpenChatHistoryFile: jest.fn(async () => {}) },
      onClose: jest.fn(),
      onExecute: async (command) => {
        await command.execute(chatView);
      },
    });

    menu.show("debug");

    const debugItem = Array.from(document.querySelectorAll(".systemsculpt-slash-result-item")).find(
      (el) => el.textContent?.includes("Copy Chat Debug")
    );
    expect(debugItem).not.toBeNull();
    debugItem?.dispatchEvent(new dom.window.Event("click"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copyDebugSnapshotToClipboard).toHaveBeenCalled();
  });

  it("executes the chat path command when selected", async () => {
    const input = document.createElement("textarea");
    input.value = "/path";
    const copyCurrentChatFilePathToClipboard = jest.fn(async () => {});
    const chatView = {
      copyCurrentChatFilePathToClipboard,
      copyChatArtifactPathsToClipboard: jest.fn(async () => {}),
      copyDebugSnapshotToClipboard: jest.fn(async () => {}),
    } as any;

    const menu = new SlashCommandMenu({
      plugin: {
        app: { workspace: { getLeaf: jest.fn(), setActiveLeaf: jest.fn() } },
        settings: { selectedModelId: "systemsculpt@@systemsculpt/ai-agent" },
      } as any,
      chatView,
      inputElement: input,
      inputHandler: { handleOpenChatHistoryFile: jest.fn(async () => {}) },
      onClose: jest.fn(),
      onExecute: async (command) => {
        await command.execute(chatView);
      },
    });

    menu.show("path");

    const pathItem = Array.from(document.querySelectorAll(".systemsculpt-slash-result-item")).find(
      (el) => el.textContent?.includes("Copy Chat Path")
    );
    expect(pathItem).not.toBeNull();
    pathItem?.dispatchEvent(new dom.window.Event("click"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copyCurrentChatFilePathToClipboard).toHaveBeenCalled();
  });

  it("executes the chat log paths command when selected", async () => {
    const input = document.createElement("textarea");
    input.value = "/log";
    const copyChatArtifactPathsToClipboard = jest.fn(async () => {});
    const chatView = {
      copyCurrentChatFilePathToClipboard: jest.fn(async () => {}),
      copyChatArtifactPathsToClipboard,
      copyDebugSnapshotToClipboard: jest.fn(async () => {}),
    } as any;

    const menu = new SlashCommandMenu({
      plugin: {
        app: { workspace: { getLeaf: jest.fn(), setActiveLeaf: jest.fn() } },
        settings: { selectedModelId: "systemsculpt@@systemsculpt/ai-agent" },
      } as any,
      chatView,
      inputElement: input,
      inputHandler: { handleOpenChatHistoryFile: jest.fn(async () => {}) },
      onClose: jest.fn(),
      onExecute: async (command) => {
        await command.execute(chatView);
      },
    });

    menu.show("log");

    const logPathItem = Array.from(document.querySelectorAll(".systemsculpt-slash-result-item")).find(
      (el) => el.textContent?.includes("Copy Chat Log Paths")
    );
    expect(logPathItem).not.toBeNull();
    logPathItem?.dispatchEvent(new dom.window.Event("click"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copyChatArtifactPathsToClipboard).toHaveBeenCalled();
  });
});
