import { SystemSculptService } from "./SystemSculptService";
import type SystemSculptPlugin from "../main";

import { ChatMessage } from "../types";
import { SystemSculptModel } from "../types/llm";
import { ensureCanonicalId, parseCanonicalId, createCanonicalId } from "../utils/modelUtils";
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
    const useLatestEverywhere = this.plugin.settings.useLatestModelEverywhere ?? true;
    const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
    let modelId = (useLatestEverywhere || isStandardMode) ? '' : this.plugin.settings.postProcessingModelId;
    let providerId = (useLatestEverywhere || isStandardMode) ? '' : this.plugin.settings.postProcessingProviderId;

    if (!modelId || !providerId) {
      // Fallback logic: Use global selected model
      const globalDefault = this.plugin.settings.selectedModelId;
      if (globalDefault) {
        const parsedGlobal = parseCanonicalId(globalDefault);
        if (parsedGlobal) {
          modelId = parsedGlobal.modelId;
          providerId = parsedGlobal.providerId;
        } else {
          modelId = globalDefault;
        }
      }
    }

    let canonicalId = (modelId || '').trim();

    if (!canonicalId) {
      throw new Error("Failed to determine a valid model for post-processing.");
    }

    if (!canonicalId.includes('@@')) {
      canonicalId = providerId
        ? createCanonicalId(providerId, canonicalId)
        : ensureCanonicalId(canonicalId);
    }

    canonicalId = ensureCanonicalId(canonicalId);

    if (!canonicalId) {
      throw new Error("Failed to determine a valid model for post-processing.");
    }

    return canonicalId;
  }

  async processTranscription(text: string): Promise<string> {
    if (!this.plugin.settings.postProcessingEnabled) {
      return text;
    }

    try {
      const modelId = this.getPostProcessingModelId();
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
        await this.promptPostProcessingModelFix(modelId, validation.alternativeModel);
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

  private async promptPostProcessingModelFix(modelId: string, alternativeModel?: SystemSculptModel): Promise<void> {
    if (PostProcessingService.promptVisible) {
      return;
    }

    PostProcessingService.promptVisible = true;
    const reason = this.buildModelUnavailableReason(modelId);
    const scope = this.usesLockedPostProcessingModel() ? 'global' : 'post-processing';

    const modal = new PostProcessingModelPromptModal(this.plugin, {
      missingModelId: modelId,
      reason,
      alternativeModel,
      scope,
      onClose: () => {
        PostProcessingService.promptVisible = false;
      },
    });

    modal.open();
  }

  private buildModelUnavailableReason(modelId: string): string {
    const parsed = parseCanonicalId(modelId);
    if (parsed?.providerId === 'systemsculpt') {
      if (!this.plugin.settings.licenseKey?.trim()) {
        return 'Post-processing is linked to the SystemSculpt AI Agent, but no license key is configured. Add a license or pick a different provider.';
      }

      if (this.plugin.settings.licenseValid !== true) {
        return 'Post-processing is using the SystemSculpt AI Agent, but the license has not been validated yet. Validate your license or choose another model.';
      }

      if (!this.plugin.settings.enableSystemSculptProvider) {
        return 'The SystemSculpt provider is turned off, so the configured post-processing model is unavailable.';
      }
    }

    return 'The selected post-processing model is no longer available. Please choose another model or disable post-processing.';
  }

  private usesLockedPostProcessingModel(): boolean {
    const useLatestEverywhere = this.plugin.settings.useLatestModelEverywhere ?? true;
    const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
    return useLatestEverywhere || isStandardMode;
  }
}
