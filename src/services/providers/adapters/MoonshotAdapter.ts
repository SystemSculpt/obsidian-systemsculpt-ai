import { ProviderModel } from "./BaseProviderAdapter";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";

const FALLBACK_MODELS: ProviderModel[] = [
  {
    id: "moonshotai/kimi-k2",
    name: "Kimi K2",
    supportsStreaming: true,
    supportsTools: true,
  },
  {
    id: "moonshotai/kimi-k2-vision",
    name: "Kimi K2 Vision",
    supportsStreaming: true,
    supportsTools: true,
  },
];

export class MoonshotAdapter extends OpenAICompatibleAdapter {
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

    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/chat/completions`;
    }

    if (baseUrl.endsWith("/chat/completions")) {
      return baseUrl;
    }

    return `${baseUrl}/v1/chat/completions`;
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

