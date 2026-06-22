/** @jest-environment jsdom */

import { App } from "obsidian";
import { PostProcessingModelPromptModal } from "../PostProcessingModelPromptModal";

describe("PostProcessingModelPromptModal", () => {
  const createPlugin = () => {
    const app = new App();
    return {
      app,
      openSettingsTab: jest.fn(),
      getSettingsManager: jest.fn(() => ({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      })),
    } as any;
  };

  it("frames the issue as SystemSculpt availability without exposing raw model ids", () => {
    const plugin = createPlugin();

    const modal = new PostProcessingModelPromptModal(plugin, {
      missingModelId: "systemsculpt@@systemsculpt/ai-agent",
      reason: "SystemSculpt transcription clean-up is temporarily unavailable.",
      isManaged: true,
    });

    modal.onOpen();

    const text = modal.contentEl.textContent || "";
    expect(text).toContain("change the clean-up prompt in Recording settings");
    expect(text).toContain("SystemSculpt");
    expect(text).not.toContain("Model id:");
    expect(text).not.toContain("systemsculpt@@systemsculpt/ai-agent");
  });

  it("frames a BYOK model problem around the model/provider, not SystemSculpt licensing", () => {
    const plugin = createPlugin();

    const modal = new PostProcessingModelPromptModal(plugin, {
      missingModelId: "openai@@gpt-4",
      reason: "The post-processing model (openai@@gpt-4) is unavailable right now.",
      isManaged: false,
    });

    modal.onOpen();

    const text = modal.contentEl.textContent || "";
    // The fix for a user-chosen model is in Recording settings, not licensing.
    expect(text).toContain("Recording settings");
    expect(text).toMatch(/different (post-processing )?model|another model/i);
    // Must not imply SystemSculpt is silently running clean-up for them.
    expect(text).not.toContain("SystemSculpt still handles transcription clean-up automatically");
    expect(text).not.toContain("Model id:");
  });
});
