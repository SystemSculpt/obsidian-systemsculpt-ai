export interface ModelArchitecture {
  modality: string;
  tokenizer: string;
  instruct_type: string | null;
}

export interface ModelPricing {
  prompt: string;
  completion: string;
  image: string;
  request: string;
}

export interface TopProvider {
  context_length: number;
  max_completion_tokens: number | null;
  is_moderated: boolean;
}

export interface ModelIdentifier {
  providerId: string; // e.g. "openrouter", "systemsculpt"
  modelId: string; // e.g. "gpt-4", "mistral-7b"
  displayName?: string; // Optional display name override
}

export interface SystemSculptModel {
  identifier: ModelIdentifier; // New structured identifier
  id: string; // Kept for backward compatibility
  name: string;
  description: string;
  context_length: number;
  capabilities: string[];
  supported_parameters?: string[]; // OpenRouter supported parameters (includes "tools", "functions", etc.)
  upstream_model?: string; // Underlying provider-qualified model id (e.g., "openrouter/openai/gpt-5-codex")
  architecture: {
    modality: string;
    tokenizer?: string;
    instruct_type?: string | null;
  };
  pricing: {
    prompt: string;
    completion: string;
    image: string;
    request: string;
  };
  provider: string;
  top_provider?: {
    context_length: number;
    max_completion_tokens: number | null;
    is_moderated: boolean;
  };
  isFavorite?: boolean;

  /**
   * Runtime-discovered incompatibility flags.
   * These are set when the model rejects tools/images at runtime.
   */
  runtimeKnownToolIncompatible?: boolean;
  runtimeKnownImageIncompatible?: boolean;
}

export interface CustomProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  isEnabled: boolean;
  lastTested?: number; // Timestamp of last connection test
  cachedModels?: string[]; // Cached list of model IDs
  failureCount?: number; // Number of consecutive connection failures
  lastFailureTime?: number; // Timestamp of last failure
  lastHealthyAt?: number; // Timestamp of last successful test that we persisted
  lastHealthyConfigHash?: string; // Hash of endpoint/apiKey combo that produced the success
}

export interface ActiveProvider {
  id: string; // Unique ID of the provider
  name: string; // Display name (e.g., "SystemSculpt", "Ollama", etc.)
  type: "native" | "custom"; // Whether it's the native SystemSculpt or a custom provider
}

export interface ModelFilterSettings {
  showVisionModels: boolean;
  showReasoningModels: boolean;
  showCreativeModels: boolean;
}

export const DEFAULT_FILTER_SETTINGS: ModelFilterSettings = {
  showVisionModels: false,
  showReasoningModels: false,
  showCreativeModels: false,
};
