import { ChatDebugLogService } from "../ChatDebugLogService";

describe("ChatDebugLogService", () => {
  it("caps the stream buffer and flags truncation", () => {
    const plugin = { app: { vault: { adapter: {} } }, storage: null } as any;
    const chatView = { chatId: "chat-1" } as any;
    const service = new ChatDebugLogService(plugin, chatView);

    const initialStats = service.getStreamStats();
    const payload = "x".repeat(Math.floor(initialStats.maxBytes / 2));

    service.recordStreamEvent({ type: "content", text: payload });
    expect(service.getStreamStats().entryCount).toBe(1);

    service.recordStreamEvent({ type: "content", text: payload });
    const stats = service.getStreamStats();

    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.truncated).toBe(true);
  });
});
