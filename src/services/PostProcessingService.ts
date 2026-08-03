import type SystemSculptPlugin from "../main";
import { DEFAULT_SETTINGS } from "../types";
import type { ManagedTextGenerationOperation } from "./managed/ManagedTextGenerationAdapter";

export type PostProcessingContext = Readonly<{
  operationId?: string;
  signal?: AbortSignal;
  /** Task-scoped snapshot so settings changes cannot alter in-flight output. */
  enabled?: boolean;
  prompt?: string;
}>;

export type PostProcessingResult = Readonly<{
  text: string;
  warning?: string;
}>;

type PostProcessingInput = Readonly<{
  cleanupInstructions: string;
  transcript: string;
}>;

function createOperationId(): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `postprocess:${random}`.slice(0, 128);
}

export class PostProcessingService {
  private static instance: PostProcessingService | null = null;

  private constructor(private readonly plugin: SystemSculptPlugin) {}

  static getInstance(plugin: SystemSculptPlugin): PostProcessingService {
    if (!PostProcessingService.instance || PostProcessingService.instance.plugin !== plugin) {
      PostProcessingService.instance = new PostProcessingService(plugin);
    }
    return PostProcessingService.instance;
  }

  static clearInstance(plugin?: SystemSculptPlugin): void {
    if (!plugin || PostProcessingService.instance?.plugin === plugin) {
      PostProcessingService.instance = null;
    }
  }

  async processTranscription(text: string, context: PostProcessingContext = {}): Promise<PostProcessingResult> {
    if (!(context.enabled ?? this.plugin.settings.postProcessingEnabled)) {
      return { text };
    }

    const operationId = context.operationId ?? createOperationId();
    const operation: ManagedTextGenerationOperation = {
      operationId,
      purpose: "transcript_postprocess",
      signal: context.signal,
      buildMessages: () => [
        { role: "user", content: this.buildPostProcessingInput(text, context.prompt) },
      ],
    };

    try {
      const result = await this.plugin.getManagedCapabilityClient().generateText(operation);
      const cleanedText = result.text.trim();
      if (result.finishReason !== "stop" || !cleanedText) {
        return {
          text,
          warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
        };
      }
      return { text: cleanedText };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Cleanup is optional. Admission and first-party failures preserve the
      // acknowledged raw transcript without invoking another remote path.
      return {
        text,
        warning: "Transcript cleanup was unavailable, so the raw transcript was saved instead.",
      };
    }
  }

  private getCleanupInstructions(override?: string): string {
    const configuredPrompt = String(override ?? this.plugin.settings.postProcessingPrompt ?? "").trim();
    return configuredPrompt || DEFAULT_SETTINGS.postProcessingPrompt;
  }

  private buildPostProcessingInput(text: string, override?: string): string {
    const input: PostProcessingInput = {
      cleanupInstructions: this.getCleanupInstructions(override),
      transcript: text,
    };
    return JSON.stringify(input);
  }
}
