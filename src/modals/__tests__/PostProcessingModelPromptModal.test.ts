/** @jest-environment jsdom */

import { App } from "obsidian";
import { PostProcessingModelPromptModal } from "../PostProcessingModelPromptModal";

describe("PostProcessingModelPromptModal", () => {
  it("frames the issue as SystemSculpt availability without exposing raw model ids", () => {
    const app = new App();
    const plugin: any = {
      app,
      openSettingsTab: jest.fn(),
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
    };

    const modal = new PostProcessingModelPromptModal(plugin, {
      missingModelId: "systemsculpt@@systemsculpt/ai-agent",
      reason: "SystemSculpt transcription clean-up is temporarily unavailable.",
    });

    modal.onOpen();

    const text = modal.contentEl.textContent || "";
    expect(text).toContain("nothing to change here in the plugin");
    expect(text).toContain("SystemSculpt");
    expect(text).not.toContain("Model id:");
    expect(text).not.toContain("systemsculpt@@systemsculpt/ai-agent");
  });
});
