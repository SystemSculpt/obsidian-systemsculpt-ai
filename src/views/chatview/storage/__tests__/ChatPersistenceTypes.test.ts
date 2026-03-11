import {
  buildChatLeafState,
  normalizePiSessionState,
  resolveChatBackend,
} from "../ChatPersistenceTypes";

describe("ChatPersistenceTypes SystemSculpt runtime contract", () => {
  it("normalizes legacy pi backend markers onto the SystemSculpt runtime", () => {
    expect(
      resolveChatBackend({
        explicitBackend: "pi",
        piSessionFile: "/tmp/session.jsonl",
      })
    ).toBe("systemsculpt");
  });

  it("keeps the managed backend label even when local Pi session state is not preserved", () => {
    expect(
      resolveChatBackend({
        explicitBackend: "pi",
        piSessionFile: "/tmp/session.jsonl",
        defaultBackend: "legacy",
        allowPiBackend: false,
      })
    ).toBe("systemsculpt");
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
