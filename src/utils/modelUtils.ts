import { SystemSculptModel, ModelIdentifier } from "../types/llm";

/**
 * Model ID utilities
 * 
 * This file provides utilities for consistent model identification throughout the application.
 * We use a strict canonical format: `${providerId}@@${modelId}`
 * This avoids conflicts with models that have slashes in their IDs (like OpenRouter models).
 */

// Canonical separator used in all model IDs
export const MODEL_ID_SEPARATOR = '@@';

/**
 * Creates a canonical model ID from provider and model components
 * The format is "{provider}@@{modelId}" which avoids conflicts with model IDs containing slashes
 * 
 * @param providerId The provider identifier (e.g., "openai", "anthropic", "openrouter")
 * @param modelId The model identifier within that provider (e.g., "gpt-4", "claude-3-opus", "openai/o3-mini")
 * @returns A canonical model ID
 */
export function createCanonicalId(providerId: string, modelId: string): string {
  return `${providerId.toLowerCase()}${MODEL_ID_SEPARATOR}${modelId}`;
}

/**
 * Parses a canonical model ID into its components
 * @param canonicalId The canonical model ID (e.g., "openai@@gpt-4" or "openrouter@@openai/o3-mini")
 * @returns An object containing providerId and modelId, or null if the format is invalid
 */
export function parseCanonicalId(canonicalId: string): { providerId: string; modelId: string } | null {
  if (!canonicalId?.includes(MODEL_ID_SEPARATOR)) {
    return null;
  }
  
  const [providerId, ...modelIdParts] = canonicalId.split(MODEL_ID_SEPARATOR);
  return {
    providerId: providerId.toLowerCase(),
    modelId: modelIdParts.join(MODEL_ID_SEPARATOR) // Rejoin in case model ID contains separator
  };
}

/**
 * Convert a legacy model ID format to our canonical format
 * This is ONLY used for migrating legacy IDs - all new code should use canonical format exclusively
 * 
 * @param legacyId A legacy model ID (e.g., "openai/gpt-4")
 * @param defaultProvider The default provider to use if no provider is detected
 * @returns A canonical model ID
 */
export function migrateFromLegacyId(legacyId: string, defaultProvider: string = "systemsculpt"): string {
  // If already in canonical format, return as is
  if (legacyId?.includes(MODEL_ID_SEPARATOR)) {
    return legacyId;
  }
  
  // For known providers with slashes in their model IDs, handle them specially
  const knownProviders = ['openrouter', 'together', 'fireworks'];
  
  // Legacy format with slash separator
  if (legacyId?.includes('/')) {
    // Check if the ID starts with a known provider
    for (const provider of knownProviders) {
      if (legacyId.toLowerCase().startsWith(`${provider}/`)) {
        // Extract the provider and the rest is the model ID
        const providerId = provider;
        const modelId = legacyId.substring(provider.length + 1);
        return createCanonicalId(providerId, modelId);
      }
    }
    
    // Default parsing for provider/model format
    const parts = legacyId.split('/');
    if (parts.length >= 2) {
      return createCanonicalId(
        parts[0].toLowerCase(),
        parts.slice(1).join('/') // Preserve any slashes in the model ID portion
      );
    }
  }
  
  // No provider detected, use default provider
  return createCanonicalId(defaultProvider, legacyId);
}

/**
 * Gets the canonical model ID from a SystemSculptModel object, or converts it if needed
 * @param model The model object
 * @returns The canonical model ID
 */
export function getCanonicalId(model: SystemSculptModel): string {
  // If the model already has a canonical ID, use it
  if (model.id?.includes(MODEL_ID_SEPARATOR)) {
    return model.id;
  }
  
  // If there's an identifier object, use that to create a canonical ID
  if (model.identifier?.providerId && model.identifier?.modelId) {
    return createCanonicalId(model.identifier.providerId, model.identifier.modelId);
  }
  
  // Migrate from legacy format
  if (model.provider) {
    return createCanonicalId(model.provider, model.id || model.name);
  }
  
  // Last resort if we can't determine provider
  return createCanonicalId("unknown", model.id || model.name || "unknown-model");
}

/**
 * Find a model in a list using the canonical ID or ID components
 * @param models List of models to search
 * @param modelId The model ID to find (will be converted to canonical format if needed)
 * @returns The matching model or undefined if not found
 */
export function findModelById(models: SystemSculptModel[], modelId: string): SystemSculptModel | undefined {
  
  // Convert to canonical format if needed
  const canonicalId = modelId.includes(MODEL_ID_SEPARATOR) 
    ? modelId 
    : migrateFromLegacyId(modelId);
  
  
  // Direct match with canonical ID 
  let model = models.find(m => m.id === canonicalId);
  if (model) {
    return model;
  }
  
  // Parse the canonical ID and try component matching
  const parsed = parseCanonicalId(canonicalId);
  if (!parsed) {
    return undefined;
  }
  
  
  // Try to match by components
  model = models.find(m => {
    // Match by provider
    if (m.provider.toLowerCase() !== parsed.providerId) {
      return false;
    }
    
    // Match by model ID
    return (
      m.identifier?.modelId === parsed.modelId ||  // Match by identifier.modelId
      m.name === parsed.modelId                    // Match by name
    );
  });
  
  if (model) {
    return model;
  }
  
  // OpenAI special case - normalize and match by partial name
  if (parsed.providerId === 'openai') {
    const normalizedModelId = parsed.modelId.toLowerCase()
      .replace(/[-\.]/g, '')
      .replace(/\s+/g, '');
    
    model = models.find(m => {
      if (m.provider.toLowerCase() !== 'openai') return false;
      
      const normalizedName = (m.name || '').toLowerCase()
        .replace(/[-\.]/g, '')
        .replace(/\s+/g, '');
      
      return normalizedName.includes(normalizedModelId) || 
             normalizedModelId.includes(normalizedName);
    });
    
    if (model) {
      return model;
    }
  }
  
  return undefined;
}

/**
 * Extract a display name from a model ID
 * @param modelId Any model ID (canonical or legacy)
 * @returns A user-friendly display name
 */
export function getDisplayName(modelId: string): string {
  // For canonical format
  if (modelId?.includes(MODEL_ID_SEPARATOR)) {
    const parsed = parseCanonicalId(modelId);
    if (parsed) {
      return parsed.modelId;
    }
  }
  
  // For legacy format with slash
  if (modelId?.includes('/')) {
    const parts = modelId.split('/');
    if (parts.length >= 2) {
      return parts[parts.length - 1]; // Last part is usually the model name
    }
  }
  
  // No pattern matched, return as is
  return modelId;
}

/**
 * Returns a standardized, bracketed provider prefix for display labels
 * Examples:
 * - systemsculpt -> "[SS AI] "
 * - anthropic -> "[ANTHROPIC] "
 * - openai -> "[OPENAI] "
 */
export function getProviderDisplayPrefix(providerId: string): string {
  const normalized = (providerId || '').toLowerCase();
  if (!normalized) {
    return '';
  }
  if (normalized === 'systemsculpt') {
    return '[SS AI] ';
  }
  return `[${normalized.toUpperCase()}] `;
}

/**
 * Build a user-facing label that includes a bracketed provider prefix
 * followed by the model's display name.
 * Accepts canonical or legacy model IDs.
 */
export function getModelLabelWithProvider(modelId: string): string {
  if (!modelId) {
    return '';
  }
  const canonical = ensureCanonicalId(modelId);
  const parsed = parseCanonicalId(canonical);
  if (parsed) {
    const prefix = getProviderDisplayPrefix(parsed.providerId);
    return `${prefix}${getDisplayName(canonical)}`;
  }
  // Fallback for unexpected formats
  return getDisplayName(modelId);
}

/**
 * Determine if a model supports image inputs (vision)
 * Uses explicit capabilities when available and falls back to heuristics
 */
export function supportsImages(model: SystemSculptModel): boolean {
  if (!model) return false;
  // Prefer explicit capabilities and architecture only; avoid name-based heuristics
  const caps = (model.capabilities || []).map(c => c.toLowerCase());
  if (caps.includes('vision') || caps.includes('image') || caps.includes('images')) {
    return true;
  }
  const modality = (model.architecture?.modality || '').toLowerCase();
  if (modality.includes('vision') || modality.includes('image') || modality.includes('text+image')) {
    return true;
  }
  return false;
}

/**
 * Get image compatibility info for a model
 */
export function getImageCompatibilityInfo(model: SystemSculptModel): {
  isCompatible: boolean;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
} {
  if (!model) {
    return { isCompatible: false, reason: 'No model provided', confidence: 'low' };
  }

  // Highest priority: Runtime-discovered incompatibility
  if (model.runtimeKnownImageIncompatible) {
    return {
      isCompatible: false,
      reason: 'Model rejected images at runtime - incompatibility confirmed',
      confidence: 'high'
    };
  }

  const caps = (model.capabilities || []).map(c => c.toLowerCase());
  if (caps.includes('vision') || caps.includes('image') || caps.includes('images')) {
    return {
      isCompatible: true,
      reason: 'Model capabilities include vision/image',
      confidence: 'high'
    };
  }
  const modality = (model.architecture?.modality || '').toLowerCase();
  if (modality.includes('vision') || modality.includes('image') || modality.includes('text+image')) {
    return {
      isCompatible: true,
      reason: 'Architecture modality indicates vision support',
      confidence: 'medium'
    };
  }

  // If the model reports an explicit (non-empty) modality and it doesn't include
  // vision indicators, treat that as a high-confidence "no".
  const trimmedModality = modality.trim();
  if (trimmedModality.length > 0 && trimmedModality !== 'unknown') {
    return {
      isCompatible: false,
      reason: 'Architecture modality indicates no vision support',
      confidence: 'high'
    };
  }

  // No strong signal either way.
  return {
    isCompatible: false,
    reason: 'No vision indicators detected',
    confidence: 'low'
  };
}

/**
 * Ensure a model ID is in canonical format
 * This function should be called on ALL model IDs before saving or using them
 * 
 * @param modelId The model ID to ensure is canonical
 * @param defaultProvider Provider to use if none is detected
 * @returns A canonical model ID
 */
export function ensureCanonicalId(modelId: string, defaultProvider: string = "systemsculpt"): string {
  // If null/undefined, return empty string - agent model should only be set explicitly
  if (!modelId) {
    return "";
  }
  
  // If already canonical, return as is
  if (modelId.includes(MODEL_ID_SEPARATOR)) {
    return modelId;
  }
  
  // Otherwise, migrate from legacy format
  return migrateFromLegacyId(modelId, defaultProvider);
}

/**
 * Check if a model is an embedding model (not suitable for chat)
 * @param model The model to check
 * @returns true if the model is an embedding model
 */
export function isEmbeddingModel(model: SystemSculptModel): boolean {
  // Check various indicators that this is an embedding model
  const nameCheck = model.name.toLowerCase().includes('embed');
  const idCheck = model.id.toLowerCase().includes('embed');
  const capabilitiesCheck = model.capabilities && 
    model.capabilities.includes('embeddings') && 
    !model.capabilities.includes('chat');
  
  return nameCheck || idCheck || capabilitiesCheck;
}

/**
 * Filter a list of models to only include chat-capable models
 * @param models List of models to filter
 * @returns List of models that are suitable for chat
 */
export function filterChatModels(models: SystemSculptModel[]): SystemSculptModel[] {
  return models.filter(model => !isEmbeddingModel(model));
}

/**
 * Check if a model supports MCP tools/function calling
 * Uses OpenRouter's supported_parameters when available, falls back to heuristics
 * @param model The model to check
 * @returns true if the model supports tools/function calling
 */
export function supportsTools(model: SystemSculptModel): boolean {
  // Primary: Use OpenRouter's supported_parameters data (most reliable)
  if (model.supported_parameters && Array.isArray(model.supported_parameters)) {
    return model.supported_parameters.includes('tools');
  }
  
  // Secondary: Check explicit capabilities
  if (model.capabilities && model.capabilities.length > 0) {
    const toolCapabilities = [
      'tools',
      'function_calling', 
      'function-calling',
      'tool_use',
      'tool-use'
    ];
    
    const hasCapability = model.capabilities.some(cap => 
      toolCapabilities.includes(cap.toLowerCase())
    );
    
    if (hasCapability) {
      return true;
    }
  }
  
  // Fallback: When no data is available, optimistically assume support
  // OpenRouter safely ignores the 'tools' parameter for unsupported models
  return hasKnownToolSupport(model);
}

/**
 * Fallback check for tool support when OpenRouter metadata is missing
 * Since OpenRouter ignores unsupported parameters, we can be optimistic
 * @param model The model to check
 * @returns true (optimistic default when no data available)
 */
function hasKnownToolSupport(model: SystemSculptModel): boolean {
  // When OpenRouter metadata is missing, we optimistically assume tool support
  // OpenRouter will safely ignore the 'tools' parameter if the model doesn't support it
  // This avoids blocking models unnecessarily
  return true;
}


/**
 * Get tool compatibility info for a model
 * @param model The model to check
 * @returns Object with compatibility info and reason
 */
export function getToolCompatibilityInfo(model: SystemSculptModel): {
  isCompatible: boolean;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
} {
  // Highest priority: Runtime-discovered incompatibility
  if (model.runtimeKnownToolIncompatible) {
    return {
      isCompatible: false,
      reason: 'Model rejected tools at runtime - incompatibility confirmed',
      confidence: 'high'
    };
  }

  // Primary: Use OpenRouter's supported_parameters (highest confidence)
  if (model.supported_parameters && Array.isArray(model.supported_parameters)) {
    const supportsTools = model.supported_parameters.includes('tools');
    return {
      isCompatible: supportsTools,
      reason: supportsTools
        ? 'OpenRouter confirms model supports "tools" parameter'
        : 'OpenRouter data shows model does not support "tools" parameter',
      confidence: 'high'
    };
  }
  
  // Secondary: Check explicit capabilities
  if (model.capabilities && model.capabilities.length > 0) {
    const toolCapabilities = [
      'tools', 'function_calling', 'function-calling', 'tool_use', 'tool-use'
    ];
    
    const hasToolCapability = model.capabilities.some(cap => 
      toolCapabilities.includes(cap.toLowerCase())
    );
    
    if (hasToolCapability) {
      return {
        isCompatible: true,
        reason: 'Model capabilities indicate tool support',
        confidence: 'medium'
      };
    }
  }
  
  // Fallback: No explicit data available
  // Since OpenRouter safely ignores unsupported parameters, we default to trying
  return {
    isCompatible: true,
    reason: 'No explicit tool support data - will attempt (OpenRouter safely ignores unsupported params)',
    confidence: 'low'
  };
}



 
