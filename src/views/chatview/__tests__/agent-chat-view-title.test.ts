/** @jest-environment jsdom */

jest.mock("../../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../../platform/hostCapabilities"),
  getHostOperatingSystem: () => "macOS",
}));

import { AgentChatView } from "../AgentChatView";
import { generateDefaultChatTitle } from "../../../utils/titleUtils";

function view() {
  const chat = Object.create(AgentChatView.prototype) as AgentChatView;
  const titleEl = document.createElement("div");
  const tabTitleEl = document.createElement("div");
  const workspaceTitleEl = document.createElement("div");
  for (const element of [titleEl, tabTitleEl, workspaceTitleEl]) element.setText("New chat");
  Object.assign(chat, {
    titleEl,
    leaf: { updateHeader: () => tabTitleEl.setText(chat.getDisplayText()) },
    workspace: { setTitle: (title: string) => workspaceTitleEl.setText(title) },
    app: { workspace: { requestSaveLayout: jest.fn() } },
    chatId: "",
    chatTitle: generateDefaultChatTitle(),
    titleExplicit: false,
    draftKey: "draft-1",
    isFullyLoaded: true,
    transcript: { setTitle: jest.fn() },
    syncChrome: jest.fn(),
    updateViewState: jest.fn(),
  });
  return { chat, titles: () => [titleEl.textContent, tabTitleEl.textContent, workspaceTitleEl.textContent] };
}

describe("AgentChatView title synchronization", () => {
  it("refreshes the host header, tab and workspace when a saved chat is renamed", async () => {
    const { chat, titles } = view();
    chat.chatId = "chat-1";
    await chat.setTitle("From your iPhone", false);
    expect(chat.getDisplayText()).toBe("From your iPhone");
    expect(titles()).toEqual(Array(3).fill("From your iPhone"));
  });

  it("refreshes all titles when Obsidian restores a title into the current draft", async () => {
    const { chat, titles } = view();
    await chat.setState({ draftKey: "draft-1", chatTitle: "Named draft" });
    expect(chat.getDisplayText()).toBe("Named draft");
    expect(titles()).toEqual(Array(3).fill("Named draft"));
  });

  it("refreshes all titles when the first committed transcript gets its identity, then resets to New chat", () => {
    const { chat, titles } = view();
    const identity = chat as unknown as {
      applyTranscriptIdentity(snapshot: { chatId: string; title: string; version: number; messages: unknown[] }): void;
    };
    identity.applyTranscriptIdentity({ chatId: "chat-1", title: "Plan the launch", version: 1, messages: [{}] });
    expect(chat.getDisplayText()).toBe("Plan the launch");
    expect(titles()).toEqual(Array(3).fill("Plan the launch"));

    identity.applyTranscriptIdentity({ chatId: "", title: generateDefaultChatTitle(), version: 0, messages: [] });
    expect(chat.getDisplayText()).toBe("New chat");
    expect(titles()).toEqual(Array(3).fill("New chat"));
  });

  it("keeps generated draft titles hidden when the current draft state is restored", async () => {
    const { chat, titles } = view();
    await chat.setState({ draftKey: "draft-1", chatTitle: "Named draft" });
    await chat.setState({ draftKey: "draft-1", chatTitle: generateDefaultChatTitle() });
    expect(chat.getDisplayText()).toBe("New chat");
    expect(titles()).toEqual(Array(3).fill("New chat"));
  });
});

describe("AgentChatView header", () => {
  it("puts history and new chat in Obsidian's view header, once, with their view shortcuts", () => {
    const chat = Object.create(AgentChatView.prototype) as AgentChatView;
    const actions: Array<{ icon: string; title: string; element: HTMLElement; run: () => void }> = [];
    const newChat = jest.fn(async () => undefined);
    const openHistory = jest.fn(async () => undefined);
    Object.assign(chat, {
      headerActionsAdded: false,
      newChat,
      openHistory,
      // Obsidian's addAction prepends each action before the ones already there.
      addAction: (icon: string, title: string, run: () => void) => {
        const element = document.createElement("button");
        actions.unshift({ icon, title, element, run });
        return element;
      },
    });
    const add = (chat as unknown as { addHeaderActions(): void }).addHeaderActions.bind(chat);
    add();
    add();
    expect(actions.map(({ icon, title }) => [icon, title])).toEqual([["history", "Chat history"], ["square-pen", "New chat"]]);
    expect(actions.map(({ element }) => element.dataset.testid)).toEqual(["chat.header.history", "chat.header.new"]);
    expect(actions.map(({ element }) => element.getAttribute("aria-keyshortcuts"))).toEqual(["Meta+K", "Meta+Shift+O"]);
    actions[0].run();
    actions[1].run();
    expect(openHistory).toHaveBeenCalledTimes(1);
    expect(newChat).toHaveBeenCalledTimes(1);
  });

  it("shows the workspace's own title row only while Obsidian hides its view header", () => {
    const chat = Object.create(AgentChatView.prototype) as AgentChatView;
    const containerEl = document.body.createDiv();
    const header = containerEl.createDiv({ cls: "view-header" });
    containerEl.createDiv({ cls: "view-content" });
    const setHostHeaderHidden = jest.fn();
    Object.assign(chat, { containerEl, workspace: { setHostHeaderHidden } });
    const sync = (chat as unknown as { syncHostHeader(): void }).syncHostHeader.bind(chat);
    try {
      sync();
      expect(setHostHeaderHidden).toHaveBeenLastCalledWith(false);
      // A sidebar, phone drawer or "Show tab title bar" off.
      header.style.display = "none";
      sync();
      expect(setHostHeaderHidden).toHaveBeenLastCalledWith(true);
      header.remove();
      sync();
      expect(setHostHeaderHidden).toHaveBeenLastCalledWith(true);
    } finally { containerEl.remove(); }
  });
});
