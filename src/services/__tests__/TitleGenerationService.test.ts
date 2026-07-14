import { TFile } from "obsidian";
import type { ChatMessage } from "../../types";
import { TitleGenerationService } from "../TitleGenerationService";

function plugin(content = "# Local Note Heading\nBody") {
  return { app: { vault: { read: jest.fn(async () => content) } } } as any;
}

describe("TitleGenerationService", () => {
  beforeEach(() => {
    (TitleGenerationService as unknown as { instance: TitleGenerationService | null }).instance = null;
  });

  it("derives a bounded local chat title without any remote service", async () => {
    const mock = plugin();
    const messages: ChatMessage[] = [
      { role: "user", content: "Design a simpler managed architecture for workflows", message_id: "1" },
    ];
    await expect(TitleGenerationService.getInstance(mock).generateTitle(messages))
      .resolves.toBe("Design a simpler managed architecture for workflows");
    expect(mock).not.toHaveProperty("aiService");
  });

  it("derives a note title from its first meaningful local line", async () => {
    const mock = plugin("---\ntag: local\n---\n# Architecture Cutover\nDetails");
    const file = new TFile({ path: "Notes/old-name.md" });
    await expect(TitleGenerationService.getInstance(mock).generateTitle(file)).resolves.toBe("Architecture Cutover");
    expect(mock.app.vault.read).toHaveBeenCalledWith(file);
  });

  it("uses explicit local context and reports one final title", async () => {
    const mock = plugin();
    const progress = jest.fn();
    const status = jest.fn();
    const title = await TitleGenerationService.getInstance(mock).generateTitle([], progress, status, "Local context wins");
    expect(title).toBe("Local context wins");
    expect(progress).toHaveBeenCalledWith(title);
    expect(status).toHaveBeenLastCalledWith(100, "Title ready");
  });

  it("falls back deterministically for empty content", async () => {
    await expect(TitleGenerationService.getInstance(plugin()).generateTitle([])).resolves.toBe("Untitled Chat");
  });

  it("sanitizes invalid filename characters", () => {
    const result = TitleGenerationService.getInstance(plugin()).sanitizeTitle('Title: With / Invalid \\ Chars * ? " < > |');
    expect(result).not.toMatch(/[\\/:*?"<>|]/u);
  });
});
