import { Platform } from "obsidian";
import { httpRequest } from "../../../utils/httpClient";
import { CustomProvider, ChatMessage } from "../../../types";

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  capabilities?: string[];
  supported_parameters?: string[];
  pricing?: {
    prompt: string;
    completion: string;
    image?: string;
    request?: string;
  };
  architecture?: {
    modality: string;
    tokenizer?: string;
    instruct_type?: string | null;
  };
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  aliases?: string[];
}

export interface ProviderCapabilities {
  supportsModelsEndpoint: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  requiresApiVersion?: string;
}

export interface StreamTransformResult {
  stream: ReadableStream;
  headers?: Record<string, string>;
}

export abstract class BaseProviderAdapter {
  protected provider: CustomProvider;
  // Circuit breaker for requestUrl per-host when Electron net fails repeatedly
  private static requestUrlHostState: Map<string, { failures: number; disabledUntil?: number }> = new Map();

  constructor(provider: CustomProvider) {
    this.provider = provider;
  }

  /**
   * Get provider-specific capabilities
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Get available models for this provider
   */
  abstract getModels(): Promise<ProviderModel[]>;

  /**
   * Validate the API key for this provider
   */
  abstract validateApiKey(): Promise<void>;

  /**
   * Get headers for API requests
   */
  abstract getHeaders(): Record<string, string>;

  /**
   * Transform messages to provider-specific format
   */
  abstract transformMessages(messages: ChatMessage[]): {
    messages: any[];
    systemPrompt?: string;
  };

  /**
   * Build the request body for chat completion
   */
  abstract buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    mcpTools?: any[],
    streaming?: boolean,
    extras?: {
      maxTokens?: number;
      includeReasoning?: boolean;
    }
  ): Record<string, any>;

  /**
   * Get the endpoint URL for chat completions
   */
  abstract getChatEndpoint(): string;

  /**
   * Transform the streaming response to OpenAI-compatible format
   */
  abstract transformStreamResponse(
    response: Response,
    isMobile: boolean
  ): Promise<StreamTransformResult>;

  /**
   * Handle errors specific to this provider
   */
  abstract handleError(error: any): Error;

  /**
   * Common request method using Obsidian's requestUrl
   */
  protected async makeRequest(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    }
  ): Promise<any> {

    // Determine host for circuit breaking
    let host = '';
    try { host = new URL(url).host; } catch {}

    const now = Date.now();
    const hostState = BaseProviderAdapter.requestUrlHostState.get(host);
    const disabled = hostState?.disabledUntil && hostState.disabledUntil > now;

    // If requestUrl recently failed for this host, go straight to fetch on desktop
    if (disabled && typeof fetch === 'function' && !Platform.isMobileApp) {
      try {
        // Normalize headers for fetch branch (duplicate logic from below, localized here)
        const fetchHeaders: Record<string, string> = { ...options.headers };
        if (options.method?.toUpperCase() === 'GET') {
          for (const k of Object.keys(fetchHeaders)) {
            if (k.toLowerCase() === 'content-type') delete fetchHeaders[k];
          }
        } else if (options.body && !Object.keys(fetchHeaders).some(k => k.toLowerCase() === 'content-type')) {
          fetchHeaders['Content-Type'] = 'application/json';
        }

        const fetchResponse = await fetch(url, {
          method: options.method,
          headers: fetchHeaders,
          body: options.body,
          cache: 'no-store',
        } as RequestInit);

        const text = await fetchResponse.text();
        let json: any = undefined;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }

        const shimResult = {
          status: fetchResponse.status,
          text,
          json,
        } as any;

        if (!shimResult.status || shimResult.status >= 400) {
          const normalizedError: any = {
            status: shimResult.status || 500,
            data: shimResult.json || {},
            text: shimResult.text,
          };
          normalizedError.message = shimResult.text || (shimResult.json && (shimResult.json.error?.message || shimResult.json.message)) || `HTTP ${normalizedError.status}`;
          throw normalizedError;
        }

        return shimResult;
      } catch (fetchErr) {
        // fall through to try requestUrl anyway
      }
    }

    try {
      const result = await httpRequest({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
      });


      return result as any;
    } catch (error) {
      throw error;
    }
  }
}
