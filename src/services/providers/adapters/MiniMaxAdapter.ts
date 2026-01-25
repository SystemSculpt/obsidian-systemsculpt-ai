import { ProviderModel } from "./BaseProviderAdapter";
import type { ChatMessage } from "../../../types";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import { MINIMAX_FALLBACK_MODEL_IDS } from "../../../constants/minimax";

const FALLBACK_MODELS: ProviderModel[] = [
  {
    id: MINIMAX_FALLBACK_MODEL_IDS[0],
    name: MINIMAX_FALLBACK_MODEL_IDS[0],
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: MINIMAX_FALLBACK_MODEL_IDS[1],
    name: MINIMAX_FALLBACK_MODEL_IDS[1],
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: MINIMAX_FALLBACK_MODEL_IDS[2],
    name: MINIMAX_FALLBACK_MODEL_IDS[2],
    contextWindow: 1000192,
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: MINIMAX_FALLBACK_MODEL_IDS[3],
    name: MINIMAX_FALLBACK_MODEL_IDS[3],
    contextWindow: 1000192,
    supportsStreaming: true,
    supportsTools: true,
  },
];

export class MiniMaxAdapter extends OpenAICompatibleAdapter {
  async getModels(): Promise<ProviderModel[]> {
    try {
      const models = await super.getModels();
      return this.mergeWithFallback(models);
    } catch (error: any) {
      if (this.isAuthError(error)) {
        throw this.handleError(error);
      }
      return FALLBACK_MODELS.map((model) => ({ ...model }));
    }
  }

  getChatEndpoint(): string {
    const baseUrl = this.provider.endpoint.trim().replace(/\/$/, "");

    if (/chatcompletion/i.test(baseUrl)) {
      return baseUrl;
    }

    if (/\/text$/i.test(baseUrl)) {
      return `${baseUrl}/chatcompletion`;
    }

    return super.getChatEndpoint();
  }

  buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    mcpTools?: any[],
    streaming: boolean = true,
    extras?: {
      plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>;
      web_search_options?: { search_context_size?: "low" | "medium" | "high" };
      maxTokens?: number;
      includeReasoning?: boolean;
    }
  ): Record<string, any> {
    const requestBody = super.buildRequestBody(messages, modelId, mcpTools, streaming, extras);

    // MiniMax rejects OpenAI-specific chat settings.
    delete requestBody.tool_choice;
    delete requestBody.parallel_tool_calls;

    return requestBody;
  }

  private mergeWithFallback(models: ProviderModel[]): ProviderModel[] {
    const seen = new Map<string, ProviderModel>();

    for (const model of models) {
      if (!model || !model.id) {
        continue;
      }
      seen.set(model.id, { ...model });
    }

    for (const fallback of FALLBACK_MODELS) {
      if (!seen.has(fallback.id)) {
        seen.set(fallback.id, { ...fallback });
      }
    }

    return Array.from(seen.values());
  }

  private isAuthError(error: any): boolean {
    const status = typeof error?.status === "number" ? error.status : undefined;
    return status === 401 || status === 403;
  }
}
