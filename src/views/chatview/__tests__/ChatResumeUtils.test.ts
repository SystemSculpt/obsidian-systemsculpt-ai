/**
 * @jest-environment jsdom
 */
import { buildChatResumeState, openChatResumeDescriptor } from "../ChatResumeUtils";

describe("ChatResumeUtils", () => {
  it("builds resume state including Pi metadata", () => {
    const state = buildChatResumeState({
      chatId: "chat-123",
      title: "Test Chat",
      modelId: "pi@@pi",
      chatPath: "SystemSculpt/Chats/test.md",
      chatBackend: "pi",
      lastModified: Date.now(),
      messageCount: 2,
      pi: {
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        lastEntryId: "entry-9",
        lastSyncedAt: "2026-03-09T00:00:00.000Z",
      },
    });

    expect(state).toEqual({
      chatId: "chat-123",
      chatTitle: "Test Chat",
      selectedModelId: "pi@@pi",
      chatBackend: "pi",
      piSessionFile: "/tmp/session.jsonl",
      piSessionId: "session-1",
      piLastEntryId: "entry-9",
      piLastSyncedAt: "2026-03-09T00:00:00.000Z",
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
      modelId: "pi@@pi",
      chatPath: "SystemSculpt/Chats/test.md",
      chatBackend: "pi",
      lastModified: Date.now(),
      messageCount: 2,
    });

    expect(targetLeaf.setViewState).toHaveBeenCalledWith({
      type: "systemsculpt-chat-view",
      active: true,
      state: {
        chatId: "chat-123",
        chatTitle: "Test Chat",
        selectedModelId: "pi@@pi",
        chatBackend: "pi",
        piSessionFile: undefined,
        piSessionId: undefined,
        piLastEntryId: undefined,
        piLastSyncedAt: undefined,
        file: "SystemSculpt/Chats/test.md",
      },
    });
    expect(plugin.app.workspace.revealLeaf).toHaveBeenCalledWith(targetLeaf);
  });
});
