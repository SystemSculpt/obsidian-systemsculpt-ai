import { SystemSculptModel, SystemSculptSettings } from "../types";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";
import { MODEL_ID_SEPARATOR } from "../utils/modelUtils";
import { AGENT_CONFIG } from "../constants/agent";
import SystemSculptPlugin from "../main";

/**
 * Service responsible for model management and caching
 */
export class ModelManagementService {
  private plugin: SystemSculptPlugin;
  private baseUrl: string;
  private static readonly DEFAULT_UPSTREAM_MODEL = "openrouter/google/gemini-3-flash-preview";
  
  constructor(plugin: SystemSculptPlugin, baseUrl: string) {
    this.plugin = plugin;
    this.baseUrl = baseUrl;
  }

  /**
   * Update the base URL
   */
  public updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  /**
   * Get current license key from settings
   */
  private get licenseKey(): string {
    return this.plugin.settings.licenseKey;
  }

  /**
   * Get current settings
   */
  private get settings(): SystemSculptSettings {
    return this.plugin.settings;
  }

  /**
   * Strip provider prefixes from model IDs
   */
  public stripProviderPrefixes(modelId: string): string {
    // No longer strip provider prefixes. We expect canonical, provider-prefixed IDs
    // like "openrouter/openai/gpt-4o" or "groq/llama-3-8b" to be passed to the server.
    return modelId;
  }

  /**
   * Get all available models
   */
  public async getModels(): Promise<SystemSculptModel[]> {
    // Return local fallback when SystemSculpt provider is disabled (e.g., no valid license)
    if (!this.settings.enableSystemSculptProvider) {
      return [this.buildLocalAgentModel()];
    }

    // Return fallback if no license key is configured
    if (!this.licenseKey?.trim()) {
      return [this.buildLocalAgentModel()];
    }

    try {
      // Fetch models from SystemSculpt API
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url: `${this.baseUrl}${SYSTEMSCULPT_API_ENDPOINTS.MODELS.LIST}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-license-key': this.licenseKey,
        },
      });

      if (response.status !== 200) {
        throw new SystemSculptError(
          `Failed to fetch models: ${response.status}`,
          ERROR_CODES.MODEL_REQUEST_ERROR,
          response.status
        );
      }

      const apiResponse = response.json;

      // Handle different response formats
      let apiModels: SystemSculptModel[];
      if (Array.isArray(apiResponse)) {
        apiModels = apiResponse;
      } else if (apiResponse && Array.isArray(apiResponse.models)) {
        apiModels = apiResponse.models;
      } else if (apiResponse && Array.isArray(apiResponse.data)) {
        apiModels = apiResponse.data;
      } else {
        throw new Error("Invalid API response format");
      }
      const primaryModel = apiModels[0];
      if (!primaryModel) {
        return [this.buildLocalAgentModel()];
      }

      return [this.buildAgentModelFromApi(primaryModel)];

    } catch (error) {
      return [this.buildLocalAgentModel()];
    }
  }

  /**
   * Get model information by ID
   */
  public async getModelInfo(modelId: string): Promise<{
    isCustom: boolean;
    provider?: any;
    actualModelId: string;
    upstreamModelId?: string;
  }> {
    // Use the UnifiedModelService to find the model
    const model = await this.plugin.modelService.getModelById(modelId);
    
    if (!model) {
      throw new SystemSculptError(
        `Model ${modelId} not found`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        404
      );
    }

    // Parse canonical ID to get the actual model name for API calls
    const { parseCanonicalId } = await import('../utils/modelUtils');
    const parsed = parseCanonicalId(model.id);
    if (!parsed) {
      throw new SystemSculptError(
        `Invalid model ID format: ${model.id}`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        400
      );
    }

    const { providerId, modelId: parsedModelId } = parsed;

    // Check if this is a SystemSculpt model
    if (providerId === 'systemsculpt') {
      const upstreamFromModel = (model as any)?.upstream_model;
      const normalizedUpstream = typeof upstreamFromModel === 'string' ? upstreamFromModel.trim() : '';
      const resolvedUpstream = normalizedUpstream.length > 0
        ? normalizedUpstream
        : ModelManagementService.DEFAULT_UPSTREAM_MODEL;
      const canonicalDefault = AGENT_CONFIG.MODEL_ID.split(MODEL_ID_SEPARATOR)[1] || 'systemsculpt/ai-agent';
      const canonicalModelId = parsedModelId && parsedModelId.trim().length > 0
        ? parsedModelId
        : canonicalDefault;
      return {
        isCustom: false,
        actualModelId: canonicalModelId,
        upstreamModelId: resolvedUpstream,
      };
    }

    // This is a custom provider model - find the provider configuration
    const customProvider = this.settings.customProviders.find(p => 
      p.isEnabled && (p.id === providerId || p.name.toLowerCase() === providerId)
    );

    if (!customProvider) {
      throw new SystemSculptError(
        `Custom provider ${providerId} not found or disabled`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        404
      );
    }

    return {
      isCustom: true,
      provider: customProvider,
      actualModelId: parsedModelId,
      upstreamModelId: parsedModelId,
    };
  }

  /**
   * Preload models (no-op since we're not caching)
   */
  public async preloadModels(): Promise<void> {
    // Remove preloading since we're not caching
    return Promise.resolve();
  }

  private buildLocalAgentModel(): SystemSculptModel {
    const { MODEL_ID, MODEL_DISPLAY_NAME, MODEL_DESCRIPTION } = AGENT_CONFIG;
    const [, upstreamModelId] = MODEL_ID.split(MODEL_ID_SEPARATOR);

    return {
      id: MODEL_ID,
      name: MODEL_DISPLAY_NAME,
      description: MODEL_DESCRIPTION,
      provider: 'systemsculpt',
      identifier: {
        providerId: 'systemsculpt',
        modelId: upstreamModelId,
        displayName: MODEL_DISPLAY_NAME,
      },
      upstream_model: ModelManagementService.DEFAULT_UPSTREAM_MODEL,
      capabilities: ['tools', 'function_calling', 'vision'],
      supported_parameters: ['top_p', 'max_tokens', 'stream', 'tools'],
      context_length: 128000,
      architecture: {
        modality: 'text+image->text',
        tokenizer: 'unknown',
        instruct_type: null,
      },
      pricing: {
        prompt: '0.000010',
        completion: '0.000030',
        image: '0',
        request: '0',
      },
    } as SystemSculptModel;
  }

  private buildAgentModelFromApi(model: Partial<SystemSculptModel>): SystemSculptModel {
    const { MODEL_ID, MODEL_DISPLAY_NAME, MODEL_DESCRIPTION } = AGENT_CONFIG;
    const [, upstreamModelId] = MODEL_ID.split(MODEL_ID_SEPARATOR);
    const upstreamFromApi = typeof model.upstream_model === 'string' && model.upstream_model.trim().length > 0
      ? model.upstream_model
      : ModelManagementService.DEFAULT_UPSTREAM_MODEL;

    return {
      ...model,
      id: MODEL_ID,
      name: MODEL_DISPLAY_NAME,
      description: model.description || MODEL_DESCRIPTION,
      provider: 'systemsculpt',
      identifier: {
        providerId: 'systemsculpt',
        modelId: (model.id as string) || upstreamModelId,
        displayName: MODEL_DISPLAY_NAME,
      },
      upstream_model: upstreamFromApi,
      context_length: model.context_length ?? 128000,
      capabilities: model.capabilities ?? ['tools', 'function_calling', 'vision'],
      supported_parameters: model.supported_parameters ?? ['top_p', 'max_tokens', 'stream', 'tools'],
      pricing: model.pricing ?? {
        prompt: '0.000010',
        completion: '0.000030',
        image: '0',
        request: '0',
      },
      architecture: model.architecture ?? {
        modality: 'text+image->text',
        tokenizer: 'unknown',
        instruct_type: null,
      },
    } as SystemSculptModel;
  }
}
