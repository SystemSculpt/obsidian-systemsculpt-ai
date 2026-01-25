/** @jest-environment jsdom */
import { describe, expect, it } from "@jest/globals";
import { App, TFile } from "obsidian";
import type { ToolCallRequest } from "../../types/toolCalls";
import { buildQuickEditDiffPreview } from "../preview";

describe("buildQuickEditDiffPreview", () => {
  it("applies write tool calls as full replacements", async () => {
    const app = new App();
    const file = new TFile({ path: "Notes/Test.md" });

    (app.vault.read as any).mockResolvedValueOnce("hello\nworld\n");

    const toolCalls: ToolCallRequest[] = [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "mcp-filesystem_write",
          arguments: JSON.stringify({
            path: "Notes/Test.md",
            content: "hi\neveryone\n",
          }),
        },
      },
    ];

    const preview = await buildQuickEditDiffPreview(app, file, toolCalls);
    expect(preview.oldContent).toBe("hello\nworld\n");
    expect(preview.newContent).toBe("hi\neveryone\n");
    expect(preview.diff.stats.additions + preview.diff.stats.deletions).toBeGreaterThan(0);
  });
});
