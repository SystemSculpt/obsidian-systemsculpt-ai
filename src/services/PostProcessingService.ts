import { SystemSculptService } from "./SystemSculptService";
import {
  getManagedSystemSculptModelId,
  hasManagedSystemSculptAccess,
} from "./systemsculpt/ManagedSystemSculptModel";
import type SystemSculptPlugin from "../main";

import { ChatMessage } from "../types";
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
   * Get the model ID to use for post-processing
   * @returns The canonical model ID
   */
  private getPostProcessingModelId(): string {
    return getManagedSystemSculptModelId();
  }

  async processTranscription(text: string): Promise<string> {
    if (!this.plugin.settings.postProcessingEnabled) {
      return text;
    }

    try {
      const modelId = this.getPostProcessingModelId();
      if (!hasManagedSystemSculptAccess(this.plugin)) {
        await this.promptPostProcessingModelFix(modelId);
        return text;
      }
      await this.ensurePostProcessingModelAvailability(modelId);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: this.plugin.settings.postProcessingPrompt,
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

  private buildModelUnavailableReason(modelId: string): string {
    if (!this.plugin.settings.licenseKey?.trim()) {
      return "Post-processing now runs only through SystemSculpt, but no license key is configured. Add your license in Setup to continue.";
    }

    if (this.plugin.settings.licenseValid !== true) {
      return "Post-processing now runs only through SystemSculpt, but the current license has not been validated yet. Validate it in Setup to continue.";
    }

    return `The managed SystemSculpt post-processing model (${modelId}) is unavailable right now. Check Setup and your connection, or disable post-processing for now.`;
  }
}
