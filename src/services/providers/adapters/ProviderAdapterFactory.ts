import { CustomProvider } from "../../../types";
import { BaseProviderAdapter } from "./BaseProviderAdapter";
import { OpenAICompatibleAdapter } from "./OpenAICompatibleAdapter";
import { AnthropicAdapter } from "./AnthropicAdapter";
import { isAnthropicEndpoint, isCorrectableAnthropicEndpoint } from "../../../constants/anthropic";
import { isMiniMaxEndpoint } from "../../../constants/minimax";
import { isMoonshotEndpoint } from "../../../constants/moonshot";
import { MiniMaxAdapter } from "./MiniMaxAdapter";
import { MoonshotAdapter } from "./MoonshotAdapter";
import type SystemSculptPlugin from "../../../main";

export class ProviderAdapterFactory {
  /**
   * Create the appropriate adapter for a given provider
   */
  static createAdapter(provider: CustomProvider, plugin?: SystemSculptPlugin): BaseProviderAdapter {
    // Check if this is an Anthropic endpoint (including correctable malformed ones)
    if (isAnthropicEndpoint(provider.endpoint) || isCorrectableAnthropicEndpoint(provider.endpoint)) {
      return new AnthropicAdapter(provider, plugin);
    }

    if (isMoonshotEndpoint(provider.endpoint)) {
      return new MoonshotAdapter(provider);
    }

    if (isMiniMaxEndpoint(provider.endpoint)) {
      return new MiniMaxAdapter(provider);
    }

    // Default to OpenAI-compatible adapter
    return new OpenAICompatibleAdapter(provider);
  }

  /**
   * Determine the provider type from the endpoint
   */
  static getProviderType(endpoint: string): "anthropic" | "moonshot" | "minimax" | "openai-compatible" {
    if (isAnthropicEndpoint(endpoint) || isCorrectableAnthropicEndpoint(endpoint)) {
      return "anthropic";
    }
    if (isMoonshotEndpoint(endpoint)) {
      return "moonshot";
    }
    if (isMiniMaxEndpoint(endpoint)) {
      return "minimax";
    }
    return "openai-compatible";
  }
}
