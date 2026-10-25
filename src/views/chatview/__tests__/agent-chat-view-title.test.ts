/** @jest-environment jsdom */

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
