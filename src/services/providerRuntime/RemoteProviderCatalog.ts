import type SystemSculptPlugin from "../../main";
import type { CustomProvider, SystemSculptModel } from "../../types/llm";
import { createCanonicalId } from "../../utils/modelUtils";
import { AI_PROVIDERS } from "../../constants/externalServices";
import { resolveProviderLabel, resolvePiProviderFromEndpoint } from "../../studio/piAuth/StudioPiProviderRegistry";

type RemoteProviderSeed = {
  providerId: string;
  modelId: string;
  name: string;
  description: string;
  contextLength: number;
  modality: string;
  supportedParameters: string[];
  endpoint: string;
};

const REMOTE_PROVIDER_SEEDS: readonly RemoteProviderSeed[] = [
  {
    providerId: "openrouter",
    modelId: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "OpenRouter remote provider model for mobile chat, tool use, and image-capable turns.",
    contextLength: 400_000,
    modality: "text+image->text",
    supportedParameters: ["tools"],
    endpoint: AI_PROVIDERS.OPENROUTER.BASE_URL,
  },
  {
    providerId: "xai",
    modelId: "grok-4.3",
    name: "Grok 4.3",
    description: "xAI remote provider model for chat, tool use, reasoning, and image-capable turns.",
    contextLength: 1_000_000,
    modality: "text+image->text",
    supportedParameters: ["tools"],
    endpoint: AI_PROVIDERS.XAI.BASE_URL,
  },
  {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "OpenAI remote provider model for chat, tool use, reasoning, and image-capable turns.",
    contextLength: 400_000,
    modality: "text+image->text",
    supportedParameters: ["tools"],
    endpoint: AI_PROVIDERS.OPENAI.BASE_URL,
  },
  {
    // Anthropic runs through the native Messages API executor (not the
    // OpenAI-compatible /chat/completions path) — see AnthropicRemoteStreamExecutor (#230).
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "Anthropic Claude remote provider model (native Messages API) for chat, tool use, and reasoning.",
    contextLength: 200_000,
    modality: "text+image->text",
    supportedParameters: ["tools"],
    endpoint: AI_PROVIDERS.ANTHROPIC.BASE_URL,
  },
];

export function normalizeProviderId(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function hasConfiguredProvider(
  providerId: string,
  customProviders: CustomProvider[],
): boolean {
  return resolveConfiguredProviderApiKey(providerId, customProviders).length > 0;
}

function resolveConfiguredProviderApiKey(
  providerId: string,
  customProviders: CustomProvider[],
): string {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return "";
  }

  for (const provider of customProviders) {
    const endpointProvider = resolvePiProviderFromEndpoint(provider.endpoint || "");
    const providerKey = normalizeProviderId(provider.id || provider.name || endpointProvider);
    const hasApiKey = String(provider.apiKey || "").trim().length > 0;
    const enabled = provider.isEnabled !== false;
    if (enabled && hasApiKey && providerKey === normalized) {
      return String(provider.apiKey || "").trim();
    }
  }

  return "";
}

function toRemoteProviderModel(seed: RemoteProviderSeed): SystemSculptModel {
  const providerLabel = resolveProviderLabel(seed.providerId);
  return {
    id: createCanonicalId(seed.providerId, seed.modelId),
    name: seed.name,
    description: seed.description,
    provider: seed.providerId,
    sourceMode: "custom_endpoint",
    sourceProviderId: seed.providerId,
    identifier: {
      providerId: seed.providerId,
      modelId: seed.modelId,
      displayName: seed.name,
    },
    piExecutionModelId: seed.modelId,
    piAuthMode: "byok",
    piRemoteAvailable: true,
    piLocalAvailable: false,
    context_length: seed.contextLength,
    capabilities: ["chat", "reasoning", "vision"],
    supported_parameters: [...seed.supportedParameters],
    architecture: {
      modality: seed.modality,
      tokenizer: `${seed.providerId}-remote`,
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      image: "0",
      request: "0",
    },
    top_provider: {
      context_length: seed.contextLength,
      max_completion_tokens: null,
      is_moderated: false,
    },
    upstream_model: `${seed.providerId}/${seed.modelId}`,
  } satisfies SystemSculptModel;
}

export function listConfiguredRemoteProviderModels(
  plugin: SystemSculptPlugin,
): SystemSculptModel[] {
  const customProviders = Array.isArray(plugin.settings?.customProviders)
    ? (plugin.settings.customProviders as CustomProvider[])
    : [];

  return REMOTE_PROVIDER_SEEDS
    .filter((seed) => hasConfiguredProvider(seed.providerId, customProviders))
    .map((seed) => toRemoteProviderModel(seed));
}

export function resolveRemoteProviderEndpoint(providerId: string): string {
  const normalized = normalizeProviderId(providerId);
  if (normalized === "openrouter") {
    return AI_PROVIDERS.OPENROUTER.BASE_URL;
  }
  if (normalized === "xai") {
    return AI_PROVIDERS.XAI.BASE_URL;
  }
  if (normalized === "openai") {
    return AI_PROVIDERS.OPENAI.BASE_URL;
  }
  if (normalized === "anthropic") {
    return AI_PROVIDERS.ANTHROPIC.BASE_URL;
  }
  return "";
}

/**
 * Endpoint resolution for executing against a remote provider. A user who
 * configured the provider with an explicit endpoint (proxy, gateway, or a
 * local fixture in tests) gets that endpoint; otherwise the canonical base
 * URL applies. Matching mirrors resolveConfiguredProviderApiKey: the entry's
 * id/name (or endpoint-derived provider) keys the lookup, and disabled
 * entries never win.
 */
export function resolveConfiguredRemoteProviderEndpoint(
  plugin: Pick<SystemSculptPlugin, "settings">,
  providerId: string,
): string {
  const normalized = normalizeProviderId(providerId);
  const customProviders = Array.isArray(plugin.settings?.customProviders)
    ? (plugin.settings.customProviders as CustomProvider[])
    : [];

  for (const provider of customProviders) {
    const endpointProvider = resolvePiProviderFromEndpoint(provider.endpoint || "");
    const providerKey = normalizeProviderId(provider.id || provider.name || endpointProvider);
    const enabled = provider.isEnabled !== false;
    const endpoint = String(provider.endpoint || "").trim();
    if (enabled && providerKey === normalized && /^https?:\/\//i.test(endpoint)) {
      return endpoint.replace(/\/+$/, "");
    }
  }

  return resolveRemoteProviderEndpoint(providerId);
}

export function getConfiguredRemoteProviderApiKey(
  plugin: SystemSculptPlugin,
  providerId: string,
): string {
  const customProviders = Array.isArray(plugin.settings?.customProviders)
    ? (plugin.settings.customProviders as CustomProvider[])
    : [];
  return resolveConfiguredProviderApiKey(providerId, customProviders);
}
