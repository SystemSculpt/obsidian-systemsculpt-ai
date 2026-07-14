import type SystemSculptPlugin from "../main";
import { DEFAULT_SETTINGS } from "../types";
import type { ManagedTextGenerationOperation } from "./managed/ManagedTextGenerationAdapter";

export type PostProcessingContext = Readonly<{
  operationId?: string;
  signal?: AbortSignal;
}>;

function createOperationId(): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `postprocess:${random}`.slice(0, 128);
}

export class PostProcessingService {
  private static instance: PostProcessingService;

  private constructor(private readonly plugin: SystemSculptPlugin) {}

  static getInstance(plugin: SystemSculptPlugin): PostProcessingService {
    if (!PostProcessingService.instance) {
      PostProcessingService.instance = new PostProcessingService(plugin);
    }
    return PostProcessingService.instance;
  }

  async processTranscription(text: string, context: PostProcessingContext = {}): Promise<string> {
    if (!this.plugin.settings.postProcessingEnabled) return text;

    const operationId = context.operationId ?? createOperationId();
    const operation: ManagedTextGenerationOperation = {
      operationId,
      purpose: "transcript_postprocess",
      signal: context.signal,
      buildMessages: () => [
        { role: "system", content: this.getPostProcessingPrompt() },
        { role: "user", content: text },
      ],
    };

    try {
      const result = await this.plugin.getManagedCapabilityClient().generateText(operation);
      return result.text.trim();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Cleanup is optional. Admission and first-party failures preserve the
      // acknowledged raw transcript without invoking another remote path.
      return text;
    }
  }

  private getPostProcessingPrompt(): string {
    const configuredPrompt = String(this.plugin.settings.postProcessingPrompt || "").trim();
    return configuredPrompt || DEFAULT_SETTINGS.postProcessingPrompt;
  }
}
