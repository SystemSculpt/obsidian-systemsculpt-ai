import { normalizeStudioPiProviderHint } from "./StudioPiProviderUtils";

export type StudioPiDynamicOAuthProvider = {
  id?: string;
  name?: string;
};

export type StudioPiAuthMethod = "oauth" | "api_key";

export type StudioPiAuthMethodRestriction = {
  disabled: boolean;
  inlineReason?: string;
  hoverDetails?: string;
};

export const API_KEY_ENV_VAR_BY_PROVIDER: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  huggingface: "HF_TOKEN",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
};

export const PROVIDER_LABEL_OVERRIDES: Record<string, string> = {
  systemsculpt: "SystemSculpt",
  "openai-codex": "OpenAI Codex (ChatGPT OAuth)",
  "google-gemini-cli": "Google Gemini CLI",
  "google-antigravity": "Google Antigravity",
  "github-copilot": "GitHub Copilot",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  minimax: "MiniMax",
  mistral: "Mistral",
  xai: "xAI",
};

export const PROVIDER_AUTH_HINT_OVERRIDES: Record<string, string> = {
  "amazon-bedrock":
    "Use AWS_PROFILE or AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) or AWS_BEARER_TOKEN_BEDROCK in your environment.",
  "google-vertex":
    "Use `gcloud auth application-default login` and set GOOGLE_CLOUD_PROJECT plus GOOGLE_CLOUD_LOCATION.",
  "azure-openai-responses":
    "Requires AZURE_OPENAI_API_KEY plus Azure endpoint/resource environment configuration.",
};

export const KNOWN_OAUTH_PROVIDER_IDS = new Set<string>([
  "anthropic",
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
]);

export const DEFAULT_PI_PROVIDER_HINTS = [
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "minimax",
  "google",
  "mistral",
  "xai",
];

const PROVIDER_AUTH_METHOD_RESTRICTIONS: Record<
  string,
  Partial<Record<StudioPiAuthMethod, Omit<StudioPiAuthMethodRestriction, "disabled">>>
> = {
  anthropic: {
    oauth: {
      inlineReason:
        "Disabled for now: Anthropic says using its plan outside Claude Code risks account bans.",
      hoverDetails:
        "Anthropic has explicitly mentioned that if you use their Anthropic plan for anything other than Claude Code you risk getting banned, so we are leaving this option visible but disabling it until further notice.",
    },
  },
};

const STRICT_PI_ENDPOINT_MAPPING_RULES: Array<{ providerId: string; markers: string[] }> = [
  {
    providerId: "openai",
    markers: ["api.openai.com"],
  },
  {
    providerId: "anthropic",
    markers: ["api.anthropic.com", "anthropic.com", "claude.ai"],
  },
  {
    providerId: "openrouter",
    markers: ["openrouter.ai"],
  },
  {
    providerId: "groq",
    markers: ["api.groq.com", "groq.com"],
  },
  {
    providerId: "minimax",
    markers: ["minimax"],
  },
  {
    providerId: "google",
    markers: ["generativelanguage.googleapis.com", "ai.google.dev"],
  },
  {
    providerId: "mistral",
    markers: ["api.mistral.ai", "mistral.ai"],
  },
  {
    providerId: "xai",
    markers: ["api.x.ai", "x.ai"],
  },
];

function normalizeProviderId(value: unknown): string {
  return normalizeStudioPiProviderHint(value);
}

export function getStudioPiRegisteredProviderIds(): string[] {
  return Array.from(
    new Set<string>([
      ...DEFAULT_PI_PROVIDER_HINTS,
      ...Object.keys(API_KEY_ENV_VAR_BY_PROVIDER),
      ...Array.from(KNOWN_OAUTH_PROVIDER_IDS.values()),
    ])
  );
}

export function getDefaultStudioPiProviderHints(): string[] {
  return [...DEFAULT_PI_PROVIDER_HINTS];
}

function resolveDynamicProviderName(
  providerId: string,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): string {
  if (!dynamicOAuthProviders) {
    return "";
  }
  const dynamic = dynamicOAuthProviders.get(providerId);
  return String(dynamic?.name || "").trim();
}

export function supportsOAuthLogin(
  providerId: string,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return false;
  return KNOWN_OAUTH_PROVIDER_IDS.has(normalized) || Boolean(dynamicOAuthProviders?.has(normalized));
}

export function getStudioPiAuthMethodRestriction(
  providerId: string,
  method: StudioPiAuthMethod
): StudioPiAuthMethodRestriction {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return { disabled: false };
  }
  const restriction = PROVIDER_AUTH_METHOD_RESTRICTIONS[normalized]?.[method];
  if (!restriction) {
    return { disabled: false };
  }
  return {
    disabled: true,
    inlineReason: restriction.inlineReason,
    hoverDetails: restriction.hoverDetails,
  };
}

export function isStudioPiAuthMethodEnabled(
  providerId: string,
  method: StudioPiAuthMethod,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): boolean {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return false;
  }
  const restriction = getStudioPiAuthMethodRestriction(normalized, method);
  if (restriction.disabled) {
    return false;
  }
  if (method === "oauth") {
    return supportsOAuthLogin(normalized, dynamicOAuthProviders);
  }
  return Boolean(getApiKeyEnvVarForProvider(normalized));
}

export function selectDefaultAuthMethod(
  providerId: string,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): "oauth" | "api_key" {
  const normalized = normalizeProviderId(providerId);
  if (isStudioPiAuthMethodEnabled(normalized, "oauth", dynamicOAuthProviders)) {
    return "oauth";
  }
  if (isStudioPiAuthMethodEnabled(normalized, "api_key", dynamicOAuthProviders)) {
    return "api_key";
  }
  return "api_key";
}

export function resolveProviderLabel(
  providerId: string,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): string {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return "Unknown provider";
  const dynamicName = resolveDynamicProviderName(normalized, dynamicOAuthProviders);
  if (dynamicName) return dynamicName;
  if (PROVIDER_LABEL_OVERRIDES[normalized]) return PROVIDER_LABEL_OVERRIDES[normalized];
  return normalized;
}

export function getStudioPiProviderLabelOrUndefined(
  providerId: string,
  dynamicOAuthProviders?: ReadonlyMap<string, StudioPiDynamicOAuthProvider>
): string | undefined {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  const label = resolveProviderLabel(normalized, dynamicOAuthProviders).trim();
  if (!label || label === normalized) {
    return undefined;
  }
  return label;
}

export function getApiKeyEnvVarForProvider(providerId: string): string {
  return API_KEY_ENV_VAR_BY_PROVIDER[normalizeProviderId(providerId)] || "";
}

export function buildApiKeyHint(
  providerId: string,
  envVar: string | undefined
): string {
  const normalized = normalizeProviderId(providerId);
  const override = PROVIDER_AUTH_HINT_OVERRIDES[normalized];
  if (override) return override;
  if (envVar) return `Set the ${envVar} environment variable, or paste it below to save it in ~/.pi/agent/auth.json.`;
  return "Paste your API key below to save it for Pi.";
}

function normalizeEndpoint(endpoint: string): string {
  return String(endpoint || "").trim().toLowerCase().replace(/\/+$/, "");
}

export function resolvePiProviderFromEndpoint(endpoint: string): string | null {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) {
    return null;
  }

  for (const rule of STRICT_PI_ENDPOINT_MAPPING_RULES) {
    if (rule.markers.some((marker) => normalized.includes(marker))) {
      return rule.providerId;
    }
  }
  return null;
}
