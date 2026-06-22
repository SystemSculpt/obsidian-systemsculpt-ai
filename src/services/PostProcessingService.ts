import { SystemSculptService } from "./SystemSculptService";
import {
  getManagedSystemSculptModelId,
  hasManagedSystemSculptAccess,
  isManagedSystemSculptModelId,
} from "./systemsculpt/ManagedSystemSculptModel";
import type SystemSculptPlugin from "../main";

import { ChatMessage, DEFAULT_SETTINGS } from "../types";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";

import { PostProcessingModelPromptModal } from "../modals/PostProcessingModelPromptModal";

export class PostProcessingService {
  private static instance: PostProcessingService;
  private sculptService: SystemSculptService;
  private static promptVisible = false;

  private constructor(private plugin: SystemSculptPlugin) {
    this.sculptService = SystemSculptService.getInstance(plugin);
  }

  static getInstance(plugin: SystemSculptPlugin): PostProcessingService {
    if (!PostProcessingService.instance) {
      PostProcessingService.instance = new PostProcessingService(plugin);
    }
    return PostProcessingService.instance;
  }

  /**
   * Resolve the model ID to use for post-processing.
   *
   * #97: post-processing has its own model so users can run clean-up on a
   * fast/cheap model while keeping a stronger model for chat. Resolution order:
   *   1. `postProcessingModelId` — the dedicated model the user picked.
   *   2. `selectedModelId` — the active chat model, so post-processing "just
   *      works" for BYOK users (and matches the model they already see) when no
   *      dedicated model is chosen.
   *   3. the managed SystemSculpt model — last resort for a fresh install that
   *      has no chat model selected yet.
   *
   * @returns The canonical model ID
   */
  private getPostProcessingModelId(): string {
    const configured = String(this.plugin.settings.postProcessingModelId || "").trim();
    if (configured) {
      return configured;
    }

    const chatModel = String(this.plugin.settings.selectedModelId || "").trim();
    return chatModel || getManagedSystemSculptModelId();
  }

  async processTranscription(text: string): Promise<string> {
    if (!this.plugin.settings.postProcessingEnabled) {
      return text;
    }

    try {
      const modelId = this.getPostProcessingModelId();
      // Only the managed SystemSculpt model is gated behind a SystemSculpt
      // license. A BYOK model routes through the same provider runtime the chat
      // uses, so it must never be blocked behind managed access (#97) — let
      // availability validation handle a misconfigured BYOK provider instead.
      if (isManagedSystemSculptModelId(modelId) && !hasManagedSystemSculptAccess(this.plugin)) {
        await this.promptPostProcessingModelFix(modelId);
        return text;
      }
      await this.ensurePostProcessingModelAvailability(modelId);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: this.getPostProcessingPrompt(),
          message_id: crypto.randomUUID(),
        },
        {
          role: "user",
          content: text,
          message_id: crypto.randomUUID(),
        },
      ];

      // Use SystemSculptService streaming (no retries)
      let processedText = "";
      const stream = this.sculptService.streamMessage({
        messages,
        model: modelId,
      });
      for await (const event of stream) {
        if (event.type === "content") {
          processedText += event.text;
        }
      }

      return processedText.trim();
    } catch (error) {
      // On error, return original text
      if (error instanceof SystemSculptError && error.code === ERROR_CODES.MODEL_UNAVAILABLE) {
        // Model prompts are triggered earlier; no additional action needed here
      }
      return text;
    }
  }

  private async ensurePostProcessingModelAvailability(modelId: string): Promise<void> {
    try {
      const validation = await this.plugin.modelService.validateSpecificModel(modelId);
      if (!validation.isAvailable) {
        await this.promptPostProcessingModelFix(modelId);
        throw new SystemSculptError(
          `Post-processing model ${modelId} is unavailable`,
          ERROR_CODES.MODEL_UNAVAILABLE,
          404,
          { model: modelId }
        );
      }
    } catch (error) {
      if (error instanceof SystemSculptError) {
        throw error;
      }
      await this.promptPostProcessingModelFix(modelId);
      throw new SystemSculptError(
        `Failed to validate post-processing model ${modelId}`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        500,
        { model: modelId }
      );
    }
  }

  private async promptPostProcessingModelFix(modelId: string): Promise<void> {
    if (PostProcessingService.promptVisible) {
      return;
    }

    PostProcessingService.promptVisible = true;
    const reason = this.buildModelUnavailableReason(modelId);

    const modal = new PostProcessingModelPromptModal(this.plugin, {
      missingModelId: modelId,
      reason,
      onClose: () => {
        PostProcessingService.promptVisible = false;
      },
    });

    modal.open();
  }

  private getPostProcessingPrompt(): string {
    const configuredPrompt = String(
      this.plugin.settings.postProcessingPrompt || ""
    ).trim();

    return configuredPrompt || DEFAULT_SETTINGS.postProcessingPrompt;
  }

  private buildModelUnavailableReason(modelId: string): string {
    // A user-chosen (BYOK) post-processing model fails for provider/config
    // reasons, not licensing — keep this guidance model-agnostic (#97).
    if (!isManagedSystemSculptModelId(modelId)) {
      return `The post-processing model (${modelId}) is unavailable right now. Make sure its provider is configured in Setup, pick a different post-processing model in the Recorder settings, or disable post-processing for now.`;
    }

    if (!this.plugin.settings.licenseKey?.trim()) {
      return "Post-processing is set to the managed SystemSculpt model, but no license key is configured. Add your license in Setup, or choose your own post-processing model in the Recorder settings.";
    }

    if (this.plugin.settings.licenseValid !== true) {
      return "Post-processing is set to the managed SystemSculpt model, but the current license has not been validated yet. Validate it in Setup, or choose your own post-processing model in the Recorder settings.";
    }

    return `The managed SystemSculpt post-processing model (${modelId}) is unavailable right now. Check Setup and your connection, or disable post-processing for now.`;
  }
}
