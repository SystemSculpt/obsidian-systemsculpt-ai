/**
 * @jest-environment jsdom
 */
import { buildChatResumeState, openChatResumeDescriptor } from "../ChatResumeUtils";

describe("ChatResumeUtils", () => {
  it("builds resume state with only the managed chat identity", () => {
    const state = buildChatResumeState({
      chatId: "chat-123",
      title: "Test Chat",
      chatPath: "SystemSculpt/Chats/test.md",
      lastModified: Date.now(),
      messageCount: 2,
    });

    expect(state).toEqual({
      chatId: "chat-123",
      chatTitle: "Test Chat",
      file: "SystemSculpt/Chats/test.md",
    });
  });

  it("reveals the resumed chat leaf after opening it", async () => {
    const targetLeaf = {
      setViewState: jest.fn().mockResolvedValue(undefined),
    };
    const plugin = {
      app: {
        workspace: {
          getLeaf: jest.fn().mockReturnValue(targetLeaf),
          revealLeaf: jest.fn(),
        },
      },
    } as any;

    await openChatResumeDescriptor(plugin, {
      chatId: "chat-123",
      title: "Test Chat",
      chatPath: "SystemSculpt/Chats/test.md",
      lastModified: Date.now(),
      messageCount: 2,
    });

    expect(targetLeaf.setViewState).toHaveBeenCalledWith({
      type: "systemsculpt-chat-view",
      active: true,
      state: {
        chatId: "chat-123",
        chatTitle: "Test Chat",
        file: "SystemSculpt/Chats/test.md",
      },
    });
    expect(plugin.app.workspace.revealLeaf).toHaveBeenCalledWith(targetLeaf);
  });
});
