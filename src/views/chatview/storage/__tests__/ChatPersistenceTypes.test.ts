import {
  buildChatLeafState,
  parseManagedChatSessionBinding,
} from "../ChatPersistenceTypes";

describe("ChatPersistenceTypes SystemSculpt runtime contract", () => {
  const binding = {
    id: "mchat_0123456789abcdef0123456789abcdef",
    revision: 3,
    boundChatId: "chat-1",
    checkpointMessageId: "assistant-3",
    toolsetFingerprint: "2:741638a5:5967d5",
    budget: { messageCount: 4, imageCount: 1, attachmentBytes: 32, storedJsonBytes: 512 },
  };

  it("strictly accepts a session bound to the expected chat", () => {
    expect(parseManagedChatSessionBinding(binding, "chat-1")).toEqual(binding);
  });

  it("rejects session state bound to another chat", () => {
    expect(parseManagedChatSessionBinding(binding, "chat-2")).toBeUndefined();
  });

  it("rejects unknown session fields and malformed budgets", () => {
    expect(parseManagedChatSessionBinding({ ...binding, extra: true }, "chat-1")).toBeUndefined();
    expect(parseManagedChatSessionBinding({
      ...binding,
      budget: { ...binding.budget, messageCount: -1 },
    }, "chat-1")).toBeUndefined();
  });

  it("builds minimal resume state without backend or session internals", () => {
    expect(
      buildChatLeafState({
        chatId: "chat-1",
        title: "Chat 1",
        chatPath: "SystemSculpt/Chats/chat-1.md",
      })
    ).toEqual({
      chatId: "chat-1",
      chatTitle: "Chat 1",
      file: "SystemSculpt/Chats/chat-1.md",
    });
  });
});
