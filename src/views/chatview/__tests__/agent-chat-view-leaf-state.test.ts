/** @jest-environment jsdom */

import { AgentChatView } from "../AgentChatView";

type LeafStateView = {
  getState(): Record<string, unknown>;
  updateViewState(): void;
  setState(state: Record<string, unknown>): Promise<void>;
};

function view() {
  const setViewState = jest.fn(async () => undefined);
  const chat = Object.create(AgentChatView.prototype) as AgentChatView & LeafStateView;
  Object.assign(chat, {
    leaf: { setViewState },
    chatId: "chat-1",
    chatTitle: "Plan",
    chatVersion: 3,
    chatFontSize: "medium",
    approvalMode: "ask",
    draftKey: "chat-1",
    appliedViewState: null,
    isFullyLoaded: true,
    transcript: { snapshot: () => ({ chatId: "chat-1" }) },
    getExpectedChatHistoryFilePath: () => "SystemSculpt/Chats/chat-1.md",
  });
  return { chat, setViewState };
}

describe("AgentChatView leaf state", () => {
  it("keeps the per-turn transcript version out of the workspace layout", async () => {
    const { chat, setViewState } = view();
    expect(chat.getState()).not.toHaveProperty("version");

    chat.updateViewState();
    (chat as unknown as { chatVersion: number }).chatVersion = 4;
    chat.updateViewState();
    expect(setViewState).toHaveBeenCalledTimes(1);

    (chat as unknown as { chatTitle: string }).chatTitle = "Renamed plan";
    chat.updateViewState();
    expect(setViewState).toHaveBeenCalledTimes(2);
    expect(setViewState).toHaveBeenLastCalledWith(
      { type: expect.any(String), state: expect.objectContaining({ chatTitle: "Renamed plan" }) },
      { focus: false },
    );

    // Obsidian restoring a state makes the next push authoritative again.
    await chat.setState({ chatId: "chat-1" });
    chat.updateViewState();
    expect(setViewState).toHaveBeenCalledTimes(3);
  });
});
