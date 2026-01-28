import { ChatMessage } from "../../../types";
import { 
  BaseProviderAdapter, 
  ProviderModel, 
  ProviderCapabilities,
  StreamTransformResult 
} from "./BaseProviderAdapter";
import { DebugLogger } from "../../../utils/debugLogger";
import { errorLogger } from "../../../utils/errorLogger";
import { AI_PROVIDERS, SERVICE_HEADERS } from "../../../constants/externalServices";
import { mapAssistantToolCallsForApi, normalizeOpenAITools, transformToolsForModel } from "../../../utils/tooling";
import { isAuthFailureMessage } from "../../../utils/errors";

export class OpenAICompatibleAdapter extends BaseProviderAdapter {
  getCapabilities(): ProviderCapabilities {
    return {
      supportsModelsEndpoint: true,
      supportsStreaming: true,
      supportsTools: true,
    };
  }

  async getModels(): Promise<ProviderModel[]> {
    const headers = this.getHeaders();
    const endpoint = this.getModelsEndpoint();


    try {
      // Avoid spamming logs if local endpoints are down by checking circuit state
      try {
        const { isHostTemporarilyDisabled } = await import('../../../utils/httpClient');
        const status = isHostTemporarilyDisabled(endpoint);
        if (status.disabled) {
          // Return empty silently; caller may aggregate across providers
          return [];
        }
      } catch {}
      const result = await this.makeRequest(endpoint, {
        method: "GET",
        headers,
      });


      // OpenAI format: { data: [{ id: string, ... }] }
      const models = (result.json.data || [])
        .filter((model: any) => !String(model.id || '').toLowerCase().includes("whisper"))
        .map((model: any): ProviderModel => {
          const supportedParameters = Array.isArray(model.supported_parameters)
            ? (model.supported_parameters as string[])
            : undefined;

          const architecture =
            model.architecture && typeof model.architecture === "object" && typeof model.architecture.modality === "string"
              ? {
                  modality: model.architecture.modality,
                  tokenizer: typeof model.architecture.tokenizer === "string" ? model.architecture.tokenizer : undefined,
                  instruct_type:
                    typeof model.architecture.instruct_type === "string" || model.architecture.instruct_type === null
                      ? model.architecture.instruct_type
                      : undefined,
                }
              : undefined;

          const pricing =
            model.pricing && typeof model.pricing === "object"
              ? {
                  prompt: String(model.pricing.prompt ?? "0"),
                  completion: String(model.pricing.completion ?? "0"),
                  image: typeof model.pricing.image === "string" ? model.pricing.image : undefined,
                  request: typeof model.pricing.request === "string" ? model.pricing.request : undefined,
                }
              : undefined;

          const capabilities: string[] = Array.isArray(model.capabilities)
            ? (model.capabilities as any[])
                .map((c) => (typeof c === "string" ? c : ""))
                .filter((c) => c.length > 0)
            : [];

          const hasVisionCapability = capabilities.some((c) => {
            const lc = c.toLowerCase();
            return lc === "vision" || lc === "image" || lc === "images";
          });

          const modality = String(architecture?.modality || "").toLowerCase();
          const inputModalities = Array.isArray(model.architecture?.input_modalities)
            ? (model.architecture.input_modalities as any[])
                .map((m) => (typeof m === "string" ? m.toLowerCase() : ""))
                .filter((m) => m.length > 0)
            : [];

          if (!hasVisionCapability && (modality.includes("image") || inputModalities.includes("image"))) {
            capabilities.push("vision");
          }

          const supportsTools =
            supportedParameters
              ? supportedParameters.includes("tools")
              : !!(String(model.id).includes("gpt") || String(model.id).includes("claude"));

          return {
            id: model.id,
            name: model.name || model.id,
            contextWindow: model.context_length ?? model.context_window ?? model.contextWindow ?? 0,
            capabilities: capabilities.length > 0 ? capabilities : undefined,
            supported_parameters: supportedParameters,
            pricing,
            architecture,
            supportsStreaming: true,
            supportsTools,
          };
        });

      return models;
    } catch (error: any) {

      // Map common fetch-layer errors to clearer messages
      const message = (typeof error?.message === 'string') ? error.message : '';
      if (message.includes('net::ERR_FAILED') || message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) {
        // Suppress noisy stack traces for local endpoints by returning empty
        if (this.provider.endpoint.includes('localhost')) {
          try {
            errorLogger.debug('Local provider unreachable; suppressing model error', {
              source: 'OpenAICompatibleAdapter',
              method: 'getModels',
              metadata: { endpoint }
            });
          } catch {}
          return [];
        }
        throw new Error("Network error while contacting provider. Check the endpoint URL and your connection.");
      }
      // If error has no status (e.g., network), surface a concise message
      if (error && typeof error.status === 'undefined') {
        if (this.provider.endpoint.includes('localhost')) {
          try {
            errorLogger.debug('Local provider unreachable (no status); suppressing', {
              source: 'OpenAICompatibleAdapter',
              method: 'getModels',
              metadata: { endpoint }
            });
          } catch {}
          return [];
        }
        throw new Error(message || 'Failed to reach provider.');
      }
      throw this.handleError(error);
    }
  }

  async validateApiKey(): Promise<void> {
    // For OpenRouter, validate with a test completion
    if (this.provider.endpoint.includes("openrouter.ai")) {
      await this.validateOpenRouterKey();
      return;
    }

    // For other OpenAI-compatible providers, try to fetch models
    try {
      await this.getModels();
    } catch (error: any) {
      if (isAuthFailureMessage(error?.message) || error?.message?.includes("Invalid API key")) {
        throw new Error("Invalid API key. Please check your API key and try again.");
      }
      throw error;
    }
  }

  private async validateOpenRouterKey(): Promise<void> {
    const headers = this.getHeaders();
    
    try {
      const result = await this.makeRequest(
        AI_PROVIDERS.OPENROUTER.CHAT_COMPLETIONS,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: [{ role: "user", content: "Test" }],
            model: "mistralai/mistral-7b-instruct",
            max_tokens: 1,
          }),
        }
      );
    } catch (error: any) {
      if (error.status === 401) {
        throw new Error(
          "Invalid API key. Please check your OpenRouter API key and try again."
        );
      } else if (error.status === 402 && error.data?.error?.message?.includes("credit")) {
        throw new Error(
          "Insufficient credits. Please add credits to your OpenRouter account."
        );
      } else if (error.status === 429) {
        throw new Error(
          "Rate limit exceeded. Please try again in a few minutes."
        );
      }
      throw new Error(
        `API key validation failed: ${
          error.data?.error?.message || `HTTP ${error.status}`
        }`
      );
    }
  }

  getHeaders(): Record<string, string> {

    // Only include auth-related headers here; content-type is set per-request when needed
    const headers: Record<string, string> = {};

    // Add appropriate auth header based on provider
    if (this.provider.endpoint.includes("openrouter.ai")) {
      headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
      headers["HTTP-Referer"] = SERVICE_HEADERS.OPENROUTER["HTTP-Referer"];
      headers["X-Title"] = SERVICE_HEADERS.OPENROUTER["X-Title"];
    } else if (this.provider.endpoint.includes("openai.com")) {
      // OpenAI requires Bearer token and may require OpenAI-Beta headers for some features
      headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
      // Allow user-specified extra headers via provider.headers if present in future
    } else {
      // Generic auth header for other providers
      if (this.provider.apiKey && this.provider.apiKey.trim() !== '') {
        headers["Authorization"] = `Bearer ${this.provider.apiKey}`;
      }
    }

    return headers;
  }

  transformMessages(messages: ChatMessage[]): { messages: any[] } {
    // Map messages with proper handling of tool-related fields and multipart content
    const includeReasoningDetails = this.provider.endpoint.includes("openrouter.ai");

    const transformedMessages = messages.map((msg) => {
      const mappedMessage: any = {
        role: msg.role,
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
        ...(msg.name && { name: msg.name }),
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(includeReasoningDetails && (msg as any).reasoning_details
          ? { reasoning_details: (msg as any).reasoning_details }
          : {}),
      };

      // OpenAI-compatible API accepts either string content or array of blocks (for vision).
      // Some providers reject array content when it contains only text, so collapse text-only
      // arrays into a single string for broader compatibility.
      if (msg.content !== null && typeof msg.content !== 'undefined') {
        if (Array.isArray(msg.content)) {
          // Ensure parts adhere to OpenAI format: {type:'text', text: string} or {type:'image_url', image_url:{url}}
          const parts: any[] = [];
          for (const part of msg.content as any[]) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              parts.push({ type: 'text', text: part.text });
            } else if (
              part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string'
            ) {
              parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
            }
          }
          if (parts.length === 0) {
            mappedMessage.content = "";
          } else {
            const hasImage = parts.some((p) => p.type === "image_url");
            if (!hasImage) {
              const textOnly = parts
                .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
                .filter((s) => s.length > 0)
                .join("\n");
              mappedMessage.content = textOnly;
            } else {
              mappedMessage.content = parts;
            }
          }
        } else {
          // String content passes through
          mappedMessage.content = msg.content;
        }
      }

      // Normalize assistant tool_calls to ensure valid JSON argument strings
      if (Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
        const rawToolCalls = (msg as any).tool_calls as any[];
        mappedMessage.tool_calls = mapAssistantToolCallsForApi(rawToolCalls);
      }

      return mappedMessage;
    });

    return { messages: transformedMessages };
  }

  buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    mcpTools?: any[],
    streaming: boolean = true,
    extras?: {
      plugins?: Array<{ id: string; max_results?: number; search_prompt?: string }>;
      web_search_options?: { search_context_size?: 'low' | 'medium' | 'high' };
      maxTokens?: number;
      includeReasoning?: boolean;
    }
  ): Record<string, any> {
    let { messages: transformedMessages } = this.transformMessages(messages);
    try {
      // Log system prompt preview when debug mode is enabled
      const sys = transformedMessages.find((m: any) => m.role === 'system');
      const sysContent: string = typeof sys?.content === 'string' ? sys.content : '';
      if (sysContent) {
        const preview = sysContent.slice(0, 600);
        errorLogger.debug('OpenAI adapter: system prompt preview', {
          source: 'OpenAICompatibleAdapter',
          method: 'buildRequestBody',
          metadata: { modelId, preview, length: sysContent.length }
        });
      }
    } catch {}
    
    // Groq quirk: some Groq text-only models reject array content with 400 "messages[n].content must be a string".
    // When endpoint is Groq and model is likely text-only, degrade multipart user/assistant content to string by concatenation.
    const isGroq = this.provider.endpoint.includes('api.groq.com');
    const isVisionModel = (id: string): boolean => {
      const lowered = id.toLowerCase();
      return (
        lowered.includes('vision') ||
        lowered.includes('llama-4-scout') ||
        lowered.includes('llama-4v') ||
        lowered.includes('llava')
      );
    };
    if (isGroq && !isVisionModel(modelId)) {
      transformedMessages = transformedMessages.map((m: any) => {
        if (Array.isArray(m.content)) {
          const textParts = m.content
            .map((p: any) => {
              if (p?.type === 'text' && typeof p.text === 'string') return p.text;
              if (p?.type === 'image_url' && p.image_url?.url) {
                const url = String(p.image_url.url);
                if (url.startsWith('data:')) return '[image attached]';
                return `[image] ${url}`;
              }
              return '';
            })
            .filter((s: string) => s.length > 0);
          return { ...m, content: textParts.join('\n') };
        }
        return m;
      });
    }

    // Generic degrade: for providers that strictly reject non-vision models with image parts,
    // allow callers to pass a hint via modelId naming. If clearly non-vision by name, degrade.
    const nonVisionNameHints = /(text-only|no-vision)/i;
    if (nonVisionNameHints.test(modelId)) {
      transformedMessages = transformedMessages.map((m: any) => {
        if (Array.isArray(m.content)) {
          const textOnly = m.content
            .map((p: any) => p?.type === 'text' && typeof p.text === 'string' ? p.text : (p?.type === 'image_url' ? '[image attached]' : ''))
            .filter((s: string) => s.length > 0)
            .join('\n');
          return { ...m, content: textOnly || '' };
        }
        return m;
      });
    }

    const requestBody: Record<string, any> = {
      model: modelId,
      messages: transformedMessages,
      stream: streaming,
    };

    if (Number.isFinite(extras?.maxTokens) && (extras?.maxTokens as number) > 0) {
      requestBody.max_tokens = Math.max(1, Math.floor(extras?.maxTokens as number));
    }

    // Do not set temperature; rely on provider defaults

    // Provider-specific extras (OpenRouter)
    try {
      const isOpenRouter = this.provider.endpoint.includes('openrouter.ai');
      if (isOpenRouter && extras) {
        if (extras.plugins && extras.plugins.length > 0) requestBody.plugins = extras.plugins;
        if (extras.web_search_options) requestBody.web_search_options = extras.web_search_options;
        const modelLower = modelId.toLowerCase();
        const supportsReasoning = modelLower.includes('claude') ||
          modelLower.includes('thinking') ||
          modelLower.includes('deepseek') ||
          modelLower.includes('gemini') ||
          modelLower.includes('o1') ||
          modelLower.includes('o3');
        if (supportsReasoning && extras.includeReasoning !== false) {
          requestBody.include_reasoning = true;
        }
      }
    } catch {}

    // Handle tools with validation
    if (mcpTools && mcpTools.length > 0) {
      const validTools = normalizeOpenAITools(mcpTools);
      if (validTools.length > 0) {
        requestBody.tools = transformToolsForModel(modelId, this.provider.endpoint, validTools);
        requestBody.tool_choice = "auto";
        requestBody.parallel_tool_calls = false;
      }
    }

    return requestBody;
  }

  private validateTools(mcpTools: any[]): any[] { return normalizeOpenAITools(mcpTools); }

  getChatEndpoint(): string {
    const baseUrl = this.provider.endpoint.trim().replace(/\/$/, "");
    
    // Handle various endpoint formats
    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/chat/completions`;
    } else if (baseUrl.endsWith("/chat/completions")) {
      return baseUrl;
    } else {
      return `${baseUrl}/v1/chat/completions`;
    }
  }

  private getModelsEndpoint(): string {
    const baseUrl = this.provider.endpoint.trim().replace(/\/$/, "");
    
    let finalEndpoint: string;
    // Support both OpenAI-style and proxy/alt bases
    if (baseUrl.endsWith("/v1")) {
      finalEndpoint = `${baseUrl}/models`;
    } else if (baseUrl.endsWith("/models")) {
      finalEndpoint = baseUrl;
    } else {
      finalEndpoint = `${baseUrl}/v1/models`;
    }
    
    
    return finalEndpoint;
  }

  async transformStreamResponse(
    response: Response,
    isMobile: boolean
  ): Promise<StreamTransformResult> {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const providerFormat = (response.headers.get('x-provider-format') || '').toLowerCase();

    // If we have a real SSE stream, pass through
    if (contentType.includes('text/event-stream') && response.body) {
      return { stream: response.body, headers: { 'Content-Type': 'text/event-stream' } };
    }

    // If upstream indicates JSON (e.g., requestUrl fallback), transform to SSE-like stream
    if (contentType.includes('application/json') || providerFormat === 'openai-json') {
      const data = await response.json();
      const { createSSEStreamFromChatCompletionJSON } = await import('../../../utils/streaming');
      const stream = createSSEStreamFromChatCompletionJSON(data, { chunkSize: 1024 });
      return { stream, headers: { 'Content-Type': 'text/event-stream' } };
    }

    // Default: assume body is stream-like; for providers that send only data: lines, treat as SSE
    return { stream: response.body!, headers: { 'Content-Type': 'text/event-stream' } };
  }

  handleError(error: any): Error {
    const message =
      typeof error?.data?.error?.message === "string"
        ? error.data.error.message
        : typeof error?.data?.message === "string"
          ? error.data.message
          : typeof error?.message === "string"
            ? error.message
            : typeof error?.text === "string"
              ? error.text
              : "";
    const authFailure = isAuthFailureMessage(message);

    if (error.status === 401) {
      return new Error("Invalid API key. Please check your API key and try again.");
    } else if (error.status === 403) {
      return new Error("Access denied. Please verify your API key has the correct permissions.");
    } else if (error.status === 404) {
      return new Error("API endpoint not found. Please check the URL and try again.");
    } else if (error.status === 429) {
      if (authFailure) {
        return new Error("Authentication failed due to too many failed attempts. Please check your API key and try again in a few minutes.");
      }
      return new Error("Rate limit exceeded. Please try again later.");
    }

    if (authFailure) {
      return new Error("Invalid API key. Please check your API key and try again.");
    }
    
    return new Error(
      error.data?.error?.message || 
      error.message || 
      `HTTP error: ${error.status || 'unknown'}`
    );
  }
}
