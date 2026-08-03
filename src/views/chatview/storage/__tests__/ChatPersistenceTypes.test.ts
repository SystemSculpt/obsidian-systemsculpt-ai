import {
  buildChatLeafState,
  parseAgentConversationId,
} from "../ChatPersistenceTypes";

describe("ChatPersistenceTypes thin agent contract", () => {
  it("accepts only canonical server conversation routing pointers", () => {
    expect(parseAgentConversationId("conversation_0123456789abcdef0123456789abcdef"))
      .toBe("conversation_0123456789abcdef0123456789abcdef");
    expect(parseAgentConversationId(" session_0123456789abcdef0123456789abcdef ")).toBeUndefined();
    expect(parseAgentConversationId("conversation_invalid")).toBeUndefined();
  });

  it("keeps chat leaf state independent from agent internals", () => {
    expect(buildChatLeafState({
      chatId: "chat-1",
      title: "Chat 1",
      chatPath: "SystemSculpt/Chats/chat-1.md",
    })).toEqual({
      chatId: "chat-1",
      chatTitle: "Chat 1",
      file: "SystemSculpt/Chats/chat-1.md",
    });
  });
});
