import {
  buildChatLeafState,
  detectLoadedChatBackend,
} from "../ChatPersistenceTypes";

describe("ChatPersistenceTypes SystemSculpt runtime contract", () => {
  it("loads an explicit Pi backend marker as a read-only legacy chat", () => {
    expect(
      detectLoadedChatBackend({
        explicitBackend: "pi",
      })
    ).toBe("legacy");
  });

  it("loads a SystemSculpt chat with retained Pi session metadata as legacy", () => {
    expect(
      detectLoadedChatBackend({
        explicitBackend: "systemsculpt",
        piSessionFile: "/tmp/session.jsonl",
      })
    ).toBe("legacy");
  });

  it("loads a transcript carrying a Pi entry identity as legacy", () => {
    expect(detectLoadedChatBackend({ hasPiEntryId: true })).toBe("legacy");
  });

  it("loads historical Pi and custom-provider model identities as legacy", () => {
    for (const model of [
      "local-pi-openai@@gpt-4.1",
      "openrouter@@openai/gpt-5.4-mini",
      "retired-provider@@retired-model",
    ]) {
      expect(detectLoadedChatBackend({ model })).toBe("legacy");
    }
  });

  it.each([
    "",
    "ai-agent",
    "systemsculpt/ai-agent",
    "systemsculpt@@systemsculpt/managed",
    "systemsculpt@@systemsculpt/ai-agent",
  ])("keeps the established managed identity %p writable", (model) => {
    expect(detectLoadedChatBackend({ model })).toBe("systemsculpt");
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
