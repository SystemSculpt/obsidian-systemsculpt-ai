// Anthropic API constants and models

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

export const ANTHROPIC_API_VERSION = "2023-06-01"; // Required API version header

export const ANTHROPIC_MODELS = [
  // Claude 4 models
  {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1",
    contextWindow: 200000,
    maxOutput: 32000,
    capabilities: ["text", "vision", "tools", "extended-thinking"],
    supportsStreaming: true,
    supportsTools: true,
    aliases: ["claude-opus-4-1"],
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200000,
    maxOutput: 32000,
    capabilities: ["text", "vision", "tools", "extended-thinking"],
    supportsStreaming: true,
    supportsTools: true,
    aliases: ["claude-opus-4-0"],
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200000, // 1M context beta available with context-1m-2025-08-07 header
    maxOutput: 64000,
    capabilities: ["text", "vision", "tools", "extended-thinking"],
    supportsStreaming: true,
    supportsTools: true,
    aliases: ["claude-sonnet-4-0"],
  },
  // Claude Haiku 3.5 - fastest model
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude Haiku 3.5",
    contextWindow: 200000,
    maxOutput: 8192,
    capabilities: ["text", "vision", "tools"],
    supportsStreaming: true,
    supportsTools: true,
    aliases: ["claude-3-5-haiku-latest"],
  },
];

// Event types for Anthropic's SSE streaming
export const ANTHROPIC_STREAM_EVENTS = {
  MESSAGE_START: "message_start",
  CONTENT_BLOCK_START: "content_block_start",
  CONTENT_BLOCK_DELTA: "content_block_delta",
  CONTENT_BLOCK_STOP: "content_block_stop",
  MESSAGE_DELTA: "message_delta",
  MESSAGE_STOP: "message_stop",
  PING: "ping",
  ERROR: "error",
} as const;

// Helper to detect if a provider endpoint is Anthropic
export function isAnthropicEndpoint(endpoint: string): boolean {
  return endpoint.toLowerCase().includes("anthropic.com") || 
         endpoint.toLowerCase().includes("claude.ai");
}

/**
 * Corrects malformed Anthropic endpoints to the standard format
 * Detects endpoints containing "api.anthropic.com" and normalizes them
 * 
 * @param endpoint - The potentially malformed endpoint
 * @returns Object with corrected endpoint and correction flag
 */
export function correctAnthropicEndpoint(endpoint: string): {
  correctedEndpoint: string;
  wasCorrected: boolean;
  originalEndpoint: string;
} {
  const original = endpoint.trim();
  const lower = original.toLowerCase();
  
  // If the endpoint contains "api.anthropic.com", extract and correct it
  if (lower.includes("api.anthropic.com")) {
    // Check if it's already correct
    if (original === ANTHROPIC_API_BASE_URL || 
        original === `${ANTHROPIC_API_BASE_URL}/v1` ||
        original === `${ANTHROPIC_API_BASE_URL}/`) {
      return {
        correctedEndpoint: original,
        wasCorrected: false,
        originalEndpoint: original,
      };
    }
    
    // Extract the correct endpoint, handling various malformed cases:
    // - "https://wrong-domain.com/api.anthropic.com/v1"
    // - "api.anthropic.com/v1/messages"
    // - "https://proxy.example.com/api.anthropic.com"
    // - "some-prefix-api.anthropic.com-suffix"
    
    return {
      correctedEndpoint: ANTHROPIC_API_BASE_URL,
      wasCorrected: true,
      originalEndpoint: original,
    };
  }
  
  // If it's a general anthropic endpoint but not api.anthropic.com, keep as is
  return {
    correctedEndpoint: original,
    wasCorrected: false,
    originalEndpoint: original,
  };
}

/**
 * Enhanced detection for Anthropic endpoints that can be auto-corrected
 * Specifically looks for "api.anthropic.com" which is the correctable pattern
 * 
 * @param endpoint - The endpoint to check
 * @returns True if endpoint contains api.anthropic.com and should be corrected
 */
export function isCorrectableAnthropicEndpoint(endpoint: string): boolean {
  return endpoint.toLowerCase().includes("api.anthropic.com");
}

/**
 * Resolves a model ID or alias to the canonical model ID
 * 
 * @param modelIdOrAlias - The model ID or alias to resolve
 * @returns The canonical model ID, or the input if not found
 */
export function resolveAnthropicModelId(modelIdOrAlias: string): string {
  // First check if it's already a canonical ID
  const canonicalModel = ANTHROPIC_MODELS.find(m => m.id === modelIdOrAlias);
  if (canonicalModel) {
    return canonicalModel.id;
  }
  
  // Check if it's an alias
  const aliasedModel = ANTHROPIC_MODELS.find(m => 
    m.aliases && m.aliases.includes(modelIdOrAlias)
  );
  if (aliasedModel) {
    return aliasedModel.id;
  }
  
  // Return as-is if not found (might be a new model not in our list)
  return modelIdOrAlias;
}