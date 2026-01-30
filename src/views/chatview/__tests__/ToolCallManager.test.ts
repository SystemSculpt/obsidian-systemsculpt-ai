import { ToolCallManager } from "../ToolCallManager";

describe("ToolCallManager.processToolResult", () => {
  it("truncates large text results while preserving structure", () => {
    const manager = new ToolCallManager({} as any);
    const originalText = "a".repeat(20_000);

    const processed = manager.processToolResult(
      { success: true, text: originalText, lang: "en" },
      "mcp-youtube_youtube_transcript"
    );

    expect(processed.success).toBe(true);
    expect(processed.truncated).toBe(true);
    expect(processed.originalLength).toBe(originalText.length);
    expect(String(processed.text).length).toBeLessThan(originalText.length);
    expect(String(processed.text)).toContain("truncated for brevity");
    expect(processed.truncation_info).toBeUndefined();
  });
});

