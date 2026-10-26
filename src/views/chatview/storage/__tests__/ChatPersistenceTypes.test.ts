import {
  buildChatLeafState,
  parseAgentConversationId,
  parseChatApprovalMode,
} from "../ChatPersistenceTypes";

describe("ChatPersistenceTypes thin agent contract", () => {
  it.each(['auto', 'ask', 'full-access'] as const)('preserves saved %s mode', mode => {
    expect(parseChatApprovalMode(mode)).toBe(mode);
  });
  it.each([undefined, null, '', 'unknown', true, {}])('fails safe to Ask for %p', value => {
    expect(parseChatApprovalMode(value)).toBe('ask');
  });
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
