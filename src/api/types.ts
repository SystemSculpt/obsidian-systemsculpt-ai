import { OpenAIProvider } from "./providers/OpenAIProvider";
import { GroqAIProvider } from "./providers/GroqAIProvider";
import { OpenRouterAIProvider } from "./providers/OpenRouterAIProvider";
import { LocalAIProvider } from "./providers/LocalAIProvider";
import { AnthropicAIProvider } from "./providers/AnthropicAIProvider";

export type AIProviderType =
  | OpenAIProvider
  | GroqAIProvider
  | OpenRouterAIProvider
  | LocalAIProvider
  | AnthropicAIProvider;

export type AIProviderKey =
  | "openai"
  | "groq"
  | "openRouter"
  | "local"
  | "anthropic"
  | "all";

export interface AIProviderServices {
  [key: string]: AIProviderType | undefined;
  openai?: AIProviderType;
  groq?: AIProviderType;
  openRouter?: AIProviderType;
  local?: AIProviderType;
  anthropic?: AIProviderType;
}

export const providerKeyMap: Record<string, AIProviderKey> = {
  openAIApiKey: "openai",
  groqAPIKey: "groq",
  openRouterAPIKey: "openRouter",
  localEndpoint: "local",
  anthropicApiKey: "anthropic",
} as const;
