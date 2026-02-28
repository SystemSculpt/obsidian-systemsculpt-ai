/**
 * SystemSculptProvider - Default embeddings provider
 * 
 * Uses the SystemSculpt API for generating embeddings
 * with automatic retry logic and error handling
 */

import { httpRequest, isHostTemporarilyDisabled, HttpResponseShim } from '../../../utils/httpClient';
import { EmbeddingsProvider, EmbeddingsGenerateOptions, EmbeddingBatchMetadata } from '../types';
import { API_BASE_URL, SYSTEMSCULPT_API_ENDPOINTS, SYSTEMSCULPT_API_HEADERS } from '../../../constants/api';
import { resolveSystemSculptApiBaseUrl } from '../../../utils/urlHelpers';
import { tokenCounter } from '../../../utils/TokenCounter';
import { errorLogger } from '../../../utils/errorLogger';
import { EmbeddingsProviderError, EmbeddingsProviderErrorCode, isEmbeddingsProviderError } from './ProviderError';
import { DEFAULT_EMBEDDING_MODEL } from '../../../constants/embeddings';
import { isAuthFailureMessage } from '../../../utils/errors';
import { sanitizeTextForApi as sanitizeSystemSculptTextForApi } from './systemSculptSanitizer';

export class SystemSculptProvider implements EmbeddingsProvider {
  readonly id = 'systemsculpt';
  readonly name = 'SystemSculpt';
  readonly supportsModels = false;
  
  private readonly defaultModel = DEFAULT_EMBEDDING_MODEL;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;
  private readonly requestTimeoutMs = 90000; // Add explicit timeout to avoid silent hangs
  private readonly maxTextsPerRequest = 25;
  public lastModelChanged: boolean = false;
  private readonly baseUrl: string;
  private readonly embeddingsEndpoint = SYSTEMSCULPT_API_ENDPOINTS.EMBEDDINGS.GENERATE;
  private readonly pluginVersion: string;
  private static readonly FORBIDDEN_LOG_WINDOW_MS = 60 * 1000;

  public expectedDimension: number | undefined;
  private forbiddenHtmlLastLogAt = 0;
  private forbiddenHtmlSuppressedDuplicates = 0;

  constructor(
    private licenseKey: string,
    baseUrl: string = API_BASE_URL,
    public model?: string,
    pluginVersion: string = ''
  ) {
    this.baseUrl = resolveSystemSculptApiBaseUrl(baseUrl);
    this.pluginVersion = String(pluginVersion || '').trim();
    // Use the server-selected default so namespaces stay consistent
    this.model = DEFAULT_EMBEDDING_MODEL;
  }

  async generateEmbeddings(texts: string[], options?: EmbeddingsGenerateOptions): Promise<number[][]> {
    if (!this.licenseKey) {
      throw new Error('License key is required for SystemSculpt embeddings');
    }

    if (texts.length === 0) {
      return [];
    }

    // Validate and truncate texts
    const validTexts = texts
      .filter(text => text && typeof text === 'string' && text.trim().length > 0)
      .map(text => {
        const sanitized = this.sanitizeTextForApi(text);
        // Ensure each text is within token limits
        // Use a more conservative limit (5000 tokens) to account for server overhead
        const truncated = tokenCounter.truncateToTokenLimit(sanitized, 5000);
        return truncated;
      });

    if (validTexts.length === 0) {
      return [];
    }

    if (validTexts.length > this.maxTextsPerRequest) {
      return this.generateEmbeddingsInClientBatches(validTexts, options);
    }

    return this.performEmbeddingRequest(validTexts, options);
  }

  private sanitizeTextForApi(text: string): string {
    return sanitizeSystemSculptTextForApi(text);
  }

  private async generateEmbeddingsInClientBatches(
    validTexts: string[],
    options?: EmbeddingsGenerateOptions
  ): Promise<number[][]> {
    const batches = this.splitClientBatches(validTexts, options?.batchMetadata);

    if (batches.length === 0) {
      return [];
    }

    try {
      errorLogger.warn('SystemSculpt embeddings input exceeded client batch limit; splitting into safe batches', {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          totalTexts: validTexts.length,
          maxTextsPerRequest: this.maxTextsPerRequest,
          inputType: options?.inputType || 'document',
          segments: batches.length,
        },
      });
    } catch {}

    const aggregated: number[][] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const segmentOptions: EmbeddingsGenerateOptions | undefined = batch.metadata
        ? { ...(options ?? {}), batchMetadata: batch.metadata }
        : options;

      const embeddings = await this.performEmbeddingRequest(batch.texts, segmentOptions, {
        segmentIndex: i,
        segmentCount: batches.length,
      });
      aggregated.push(...embeddings);
    }

    return aggregated;
  }

  private handleForbiddenHtmlResponse(
    error: EmbeddingsProviderError,
    metadata: Record<string, unknown>,
    responseText?: string
  ): EmbeddingsProviderError {
    const now = Date.now();
    const shouldLogFull = now - this.forbiddenHtmlLastLogAt > SystemSculptProvider.FORBIDDEN_LOG_WINDOW_MS;

    if (shouldLogFull) {
      if (this.forbiddenHtmlSuppressedDuplicates > 0) {
        errorLogger.warn('SystemSculpt embeddings 403 HTML persisted; suppressed duplicate logs', {
          source: 'SystemSculptProvider',
          method: 'generateEmbeddings',
          providerId: this.id,
          metadata: {
            ...metadata,
            suppressedDuplicates: this.forbiddenHtmlSuppressedDuplicates,
          }
        });
        this.forbiddenHtmlSuppressedDuplicates = 0;
      }
      const fallbackText = responseText || (typeof (error.details as any)?.fullText === 'string'
        ? (error.details as any).fullText as string
        : 'No response text available');
      errorLogger.error('=== HTTP 403 FORBIDDEN ERROR - FULL RESPONSE DETAILS ===', error, {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          ...metadata,
          fullResponseText: fallbackText,
          fullResponseLength: fallbackText.length,
        }
      });
      this.forbiddenHtmlLastLogAt = now;
    } else {
      this.forbiddenHtmlSuppressedDuplicates += 1;
    }

    return new EmbeddingsProviderError(error.message, {
      code: 'HOST_UNAVAILABLE',
      status: error.status ?? 403,
      retryInMs: error.retryInMs,
      transient: true,
      providerId: error.providerId ?? this.id,
      endpoint: error.endpoint ?? this.getEndpointUrl(),
      details: {
        ...(error.details || {}),
        suppressionWindowMs: SystemSculptProvider.FORBIDDEN_LOG_WINDOW_MS
      },
      cause: error
    });
  }


  private splitClientBatches(
    texts: string[],
    metadata?: EmbeddingBatchMetadata
  ): Array<{ texts: string[]; metadata?: EmbeddingBatchMetadata }> {
    const batches: Array<{ texts: string[]; metadata?: EmbeddingBatchMetadata }> = [];
    if (!Array.isArray(texts) || texts.length === 0) {
      return batches;
    }

    for (let start = 0; start < texts.length; start += this.maxTextsPerRequest) {
      const slice = texts.slice(start, start + this.maxTextsPerRequest);
      const sliceMeta = this.sliceBatchMetadata(metadata, start, slice.length);
      batches.push({ texts: slice, metadata: sliceMeta });
    }

    return batches;
  }

  private isHtmlResponseError(error: EmbeddingsProviderError): boolean {
    const details = error.details as Record<string, unknown> | undefined;
    return typeof details?.kind === 'string' && details.kind === 'html-response';
  }

  private async performEmbeddingRequest(
    validTexts: string[],
    options?: EmbeddingsGenerateOptions,
    segmentContext?: { segmentIndex: number; segmentCount: number }
  ): Promise<number[][]> {
    const payloadTexts = validTexts;
    const batchSummary = this.summarizeBatchMetadata(options?.batchMetadata);
    const textStats = payloadTexts.map((text, idx) => ({
      index: idx,
      length: text.length,
      estimatedTokens: tokenCounter.estimateTokens(text)
    }));
    const totalEstimatedTokens = textStats.reduce((sum, stat) => sum + stat.estimatedTokens, 0);
    const maxEstimatedTokens = textStats.reduce((max, stat) => Math.max(max, stat.estimatedTokens), 0);

    errorLogger.debug('SystemSculpt embeddings payload prepared', {
      source: 'SystemSculptProvider',
      method: 'generateEmbeddings',
      providerId: this.id,
      metadata: {
        inputType: options?.inputType || 'document',
        textCount: textStats.length,
        totalEstimatedTokens,
        maxEstimatedTokens,
        batch: batchSummary,
        segment: segmentContext
      }
    });

    const oversizedTexts = textStats.filter(stat => stat.estimatedTokens > 8000);
    if (oversizedTexts.length > 0) {
      errorLogger.warn('SystemSculpt embeddings inputs exceeded conservative token budget; truncation applied', {
        source: 'SystemSculptProvider',
        method: 'generateEmbeddings',
        providerId: this.id,
        metadata: {
          oversizedCount: oversizedTexts.length,
          maxEstimatedTokens: Math.max(...oversizedTexts.map(stat => stat.estimatedTokens)),
          batch: batchSummary,
          segment: segmentContext
        }
      });
    }

    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const url = this.getEndpointUrl();
      const hostStatus = isHostTemporarilyDisabled(url);
      if (hostStatus.disabled) {
        const retryMs = Math.max(1000, hostStatus.retryInMs || 0);
        throw new EmbeddingsProviderError(
          `Embeddings host temporarily unavailable. Retry in ${retryMs}ms`,
          {
            code: 'HOST_UNAVAILABLE',
            providerId: this.id,
            endpoint: url,
            retryInMs: retryMs,
            transient: true,
            status: 0,
          }
        );
      }

      try {
        const requestHeaders = {
          ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey),
          ...(this.pluginVersion ? { 'x-plugin-version': this.pluginVersion } : {}),
          'Idempotency-Key': this.buildIdempotencyKey(
            payloadTexts,
            this.model || this.defaultModel,
            options?.inputType || 'document'
          ),
        };
        // Lightweight idempotency key: stable hash of concatenated inputs + model + inputType
        // Server expects 'texts' for batch requests
        const requestBody = {
          texts: payloadTexts,
          model: this.model || this.defaultModel,
          inputType: options?.inputType || 'document',
          // Provide currentModel to allow server to flag migrations
          currentModel: this.model || this.defaultModel
        };

        
        const response = await httpRequest({
          url,
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          timeoutMs: this.requestTimeoutMs
        });

        if (!response.status || response.status !== 200) {
          throw this.buildHttpError(response, url, segmentContext, batchSummary, validTexts.length);
        }

        const raw = typeof response.text === 'string' ? response.text : '';
        let data: any = undefined;
        try { data = raw ? JSON.parse(raw) : undefined; } catch {}

        if (!data || (!data.embeddings && !data.embedding)) {
          throw new EmbeddingsProviderError(
            'Invalid response format: missing embeddings array',
            {
              code: 'UNEXPECTED_RESPONSE',
              providerId: this.id,
              endpoint: url,
            }
          );
        }

        // Adopt server-selected model and flag migrations when signaled
        if (typeof data.model === 'string' && data.model.length > 0) {
          this.model = data.model;
        }
        this.lastModelChanged = !!data.modelChanged;

        // Track the dimension we actually receive to inform downstream validation
        const sampleEmbedding = Array.isArray(data.embeddings) && data.embeddings.length > 0
          ? data.embeddings[0]
          : (Array.isArray(data.embedding) ? data.embedding : null);
        const sampleDim = Array.isArray(sampleEmbedding) ? sampleEmbedding.length : 0;
        if (Number.isFinite(sampleDim) && sampleDim > 0) {
          this.expectedDimension = sampleDim;
        }

        // Support single or batch responses
        if (Array.isArray(data.embeddings)) return data.embeddings;
        if (Array.isArray(data.embedding)) return [data.embedding];
        return [];

      } catch (error) {
        let normalized = this.normalizeError(error, url);
        lastError = normalized;
        const status = normalized.status;
        const htmlSample = typeof (normalized.details as any)?.sample === 'string'
          ? (normalized.details as any).sample
          : undefined;
        if (status && (status === 502 || status === 503 || status === 504)) {
          try {
            errorLogger.warn('SystemSculpt embeddings API gateway error', {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: {
                status,
                attempt,
                maxRetries: this.maxRetries,
                texts: validTexts.length,
                baseUrl: this.baseUrl,
                batch: batchSummary,
                segment: segmentContext
              }
            });
          } catch {}
        }
        // If host circuit is open or clear network refusal, break early to avoid spam
        const isCircuit = normalized.code === 'HOST_UNAVAILABLE';
        const refused = normalized.code === 'NETWORK_ERROR';
        const fullResponseText = typeof (normalized.details as any)?.fullText === 'string'
          ? (normalized.details as any).fullText
          : undefined;
        const attemptMetadata = {
          attempt,
          maxRetries: this.maxRetries,
          providerId: this.id,
          endpoint: url,
          status,
          code: normalized.code,
          retryInMs: normalized.retryInMs,
          payload: {
            textCount: textStats.length,
            totalEstimatedTokens,
            maxEstimatedTokens
          },
          batch: batchSummary,
          segment: segmentContext,
          htmlSample
        };

        let handledForbiddenHtml = false;
        if (status === 403 && this.isHtmlResponseError(normalized)) {
          normalized = this.handleForbiddenHtmlResponse(
            normalized,
            attemptMetadata,
            fullResponseText || htmlSample
          );
          lastError = normalized;
          handledForbiddenHtml = true;
        }

        if (!handledForbiddenHtml) {
          if (attempt < this.maxRetries && !isCircuit && !refused) {
            errorLogger.warn('SystemSculpt embeddings request failed; retrying', {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: attemptMetadata
            });
          } else {
            errorLogger.error('SystemSculpt embeddings request failed', normalized, {
              source: 'SystemSculptProvider',
              method: 'generateEmbeddings',
              providerId: this.id,
              metadata: attemptMetadata
            });
          }
        }
        // Stop immediately on auth/license or rate-limit errors - no point retrying
        const isAuthError = normalized.licenseRelated
          || normalized.code === 'LICENSE_INVALID'
          || status === 401
          || status === 402;
        const isRateLimited = normalized.code === 'RATE_LIMITED' || status === 429;
        if (isCircuit || isAuthError || isRateLimited) break;
        if (attempt < this.maxRetries && !isCircuit) {
          // Only retry once on networkish errors
          if (refused && attempt >= 2) break;
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new EmbeddingsProviderError('Failed to generate embeddings after retries', {
      code: 'NETWORK_ERROR',
      providerId: this.id,
      endpoint: this.getEndpointUrl(),
      transient: true
    });
  }

  private getEndpointUrl(): string {
    return `${this.baseUrl}${this.embeddingsEndpoint}`;
  }

  private summarizeBatchMetadata(meta?: EmbeddingBatchMetadata | null): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    const sampleItems = meta.items.slice(0, 10).map(item => ({
      path: item.path,
      chunkId: item.chunkId,
      processedLength: item.processedLength,
      estimatedTokens: item.estimatedTokens,
      truncated: item.truncated
    }));
    return {
      batchIndex: meta.batchIndex,
      batchSize: meta.batchSize,
      estimatedTotalTokens: meta.estimatedTotalTokens,
      maxEstimatedTokens: meta.maxEstimatedTokens,
      truncatedCount: meta.truncatedCount,
      sampleItems
    };
  }

  private sliceBatchMetadata(
    meta: EmbeddingBatchMetadata | undefined,
    start: number,
    count: number
  ): EmbeddingBatchMetadata | undefined {
    if (!meta) return undefined;
    if (count <= 0) return undefined;
    const items = meta.items.slice(start, start + count);
    if (items.length === 0) return undefined;

    const estimatedTotalTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    const maxEstimatedTokens = items.reduce((max, item) => Math.max(max, item.estimatedTokens), 0);
    const truncatedCount = items.reduce((total, item) => total + (item.truncated ? 1 : 0), 0);

    return {
      batchIndex: meta.batchIndex,
      batchSize: items.length,
      estimatedTotalTokens,
      maxEstimatedTokens,
      truncatedCount,
      items
    };
  }

  private buildIdempotencyKey(texts: string[], model: string, inputType: 'document' | 'query'): string {
    // Non-cryptographic stable hash to keep fast on client
    let hash = 2166136261;
    const add = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
    };
    add(model + '|' + inputType + '|');
    for (const t of texts) add(t);
    return (hash >>> 0).toString(36);
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test with a simple embedding
      await this.generateEmbeddings(['test']);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    // The server dictates the single supported embeddings model
    return [DEFAULT_EMBEDDING_MODEL];
  }

  getMaxBatchSize(): number {
    return this.maxTextsPerRequest;
  }

  private parseErrorResponse(response: HttpResponseShim | any): {
    message: string;
    retryInMs?: number;
    details?: Record<string, unknown>;
    isHtml: boolean;
  } {
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const text = typeof response?.text === 'string' ? response.text : '';
    const trimmed = text ? text.trim() : '';
    const contentType = this.getHeaderValue(response?.headers, 'content-type');
    const lowerTrimmed = trimmed.toLowerCase();
    const isHtml = (contentType && contentType.toLowerCase().includes('text/html'))
      || lowerTrimmed.startsWith('<!doctype html')
      || lowerTrimmed.startsWith('<html')
      || trimmed.startsWith('<');

    let message: string | undefined;

    if (status && (status === 502 || status === 503 || status === 504)) {
      message = isHtml
        ? `SystemSculpt API is temporarily unavailable (HTTP ${status}). The upstream service returned a gateway error page instead of JSON.`
        : `SystemSculpt API is temporarily unavailable (HTTP ${status}). Retry shortly.`;
    } else if (isHtml) {
      const statusLabel = status ? ` (HTTP ${status})` : '';
      message = `Received HTML${statusLabel} instead of JSON from the SystemSculpt API. This usually means a gateway or CDN page was returned.`;
    } else {
      const structured = typeof response?.json === 'object' && response?.json !== null
        ? response.json
        : undefined;

      if (structured && typeof structured === 'object') {
        const messageField = (structured as any).message;
        const errorField = (structured as any).error;
        const trimmedMessage = typeof messageField === 'string' ? messageField.trim() : '';
        const trimmedError = typeof errorField === 'string' ? errorField.trim() : '';
        if (trimmedMessage && trimmedError && trimmedMessage.toLowerCase() !== trimmedError.toLowerCase()) {
          message = `${trimmedMessage} (${trimmedError})`;
        } else if (trimmedMessage) {
          message = trimmedMessage;
        } else if (trimmedError) {
          message = trimmedError;
        }
      }

      if (!message && trimmed.length > 0) {
        try {
          const errorData = text ? JSON.parse(text) : undefined;
          if (errorData && typeof errorData === 'object') {
            const parsedMessage = typeof (errorData as any).message === 'string' ? (errorData as any).message.trim() : '';
            const parsedError = typeof (errorData as any).error === 'string' ? (errorData as any).error.trim() : '';
            if (parsedMessage && parsedError && parsedMessage.toLowerCase() !== parsedError.toLowerCase()) {
              message = `${parsedMessage} (${parsedError})`;
            } else if (parsedMessage) {
              message = parsedMessage;
            } else if (parsedError) {
              message = parsedError;
            } else {
              message = trimmed;
            }
          }
        } catch {
          message = trimmed;
        }
      }
    }

    if (!message || message.length === 0) {
      message = status ? `HTTP ${status}` : 'Unknown error';
    }

    const retryInMs = this.parseRetryAfter(response?.headers);
    let details = typeof response?.json === 'object' && response?.json !== null
      ? { ...(response.json as Record<string, unknown>) }
      : undefined;

    if (isHtml) {
      const sample = trimmed.substring(0, 160);
      const htmlDetails: Record<string, unknown> = {
        kind: 'html-response',
        sample,
        fullText: trimmed,
      };
      details = details ? { ...htmlDetails, ...details } : htmlDetails;
    } else if (trimmed.length > 0) {
      if (!details) {
        details = {};
      }
      details.fullText = trimmed;
    }

    return { message, retryInMs, details, isHtml };
  }

  private getHeaderValue(headers: any, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') {
      return undefined;
    }
    const entries = Array.isArray(headers)
      ? headers
      : Object.entries(headers);
    const lowerName = name.toLowerCase();
    for (const entry of entries as Array<[string, any]>) {
      const [key, value] = entry;
      if (typeof key === 'string' && key.toLowerCase() === lowerName) {
        if (Array.isArray(value)) {
          return typeof value[0] === 'string' ? value[0] : undefined;
        }
        if (typeof value === 'string') {
          return value;
        }
      }
    }
    return undefined;
  }

  private parseRetryAfter(headers: any): number | undefined {
    const headerValue = this.getHeaderValue(headers, 'retry-after');
    if (!headerValue) return undefined;

    const numeric = Number(headerValue);
    if (!Number.isNaN(numeric) && numeric >= 0) {
      return numeric * 1000;
    }

    const absolute = Date.parse(headerValue);
    if (!Number.isNaN(absolute)) {
      const diff = absolute - Date.now();
      if (diff > 0) {
        return diff;
      }
    }

    return undefined;
  }

  private buildHttpError(
    response: HttpResponseShim,
    requestUrl: string,
    segmentContext?: { segmentIndex: number; segmentCount: number },
    batchSummary?: Record<string, unknown>,
    textCount?: number
  ): EmbeddingsProviderError {
    const parsed = this.parseErrorResponse(response);
    const { message, retryInMs, details, isHtml } = parsed;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    const code = this.classifyErrorCode(status, message, isHtml);
    const mergedDetails: Record<string, unknown> | undefined = (() => {
      if (!details && !batchSummary && typeof textCount !== 'number' && !segmentContext) {
        return details;
      }
      const merged: Record<string, unknown> = { ...(details ?? {}) };
      if (batchSummary) merged.batch = batchSummary;
      if (typeof textCount === 'number') merged.textCount = textCount;
      if (segmentContext) merged.segment = segmentContext;
      return merged;
    })();
    return new EmbeddingsProviderError(
      `API error ${status ?? 0}: ${message}`,
      {
        code,
        status,
        retryInMs,
        transient: this.isTransientStatus(status),
        licenseRelated: code === 'LICENSE_INVALID',
        providerId: this.id,
        endpoint: requestUrl,
        details: mergedDetails,
        cause: response
      }
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private classifyErrorCode(status: number | undefined, message: string, isHtml?: boolean): EmbeddingsProviderErrorCode {
    if (isHtml) {
      if (status === 403 || (typeof status === 'number' && status >= 500)) {
        return 'HOST_UNAVAILABLE';
      }
      return 'INVALID_RESPONSE';
    }
    const authFailure = isAuthFailureMessage(message);
    if (status === 401 || status === 402) {
      return 'LICENSE_INVALID';
    }
    if (status === 403) {
      return authFailure ? 'LICENSE_INVALID' : 'HTTP_ERROR';
    }
    if (status === 429) {
      return 'RATE_LIMITED';
    }
    if (authFailure) {
      return 'LICENSE_INVALID';
    }
    if (status === 0) {
      return 'NETWORK_ERROR';
    }
    if (!status && this.looksNetworkError(message)) {
      return 'NETWORK_ERROR';
    }
    const lower = message.toLowerCase();
    if (lower.includes('temporarily unavailable')) {
      return 'HOST_UNAVAILABLE';
    }
    if (status && status >= 400) {
      return 'HTTP_ERROR';
    }
    return 'NETWORK_ERROR';
  }

  private isTransientStatus(status?: number): boolean {
    if (typeof status !== 'number') return false;
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }

  private looksNetworkError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('net::err')
      || lower.includes('econn')
      || lower.includes('enotfound')
      || lower.includes('timeout')
      || lower.includes('timed out')
      || lower.includes('network');
  }

  private extractErrorMessage(error: unknown): string {
    if (isEmbeddingsProviderError(error)) {
      return error.message;
    }
    if (error && typeof error === 'object' && ('status' in error || 'text' in error || 'json' in error)) {
      try {
        const parsed = this.parseErrorResponse(error as any);
        if (parsed.message) return parsed.message;
      } catch {}
    }
    if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
    const fallback = (error as any)?.message;
    if (typeof fallback === 'string' && fallback.length > 0) {
      return fallback;
    }
    return 'SystemSculpt API request failed';
  }

  private extractErrorDetails(error: unknown): Record<string, unknown> | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }
    const maybe = error as any;
    const details: Record<string, unknown> = {};
    if (typeof maybe.status === 'number') {
      details.status = maybe.status;
    }
    if (typeof maybe.text === 'string' && maybe.text.trim().length > 0) {
      details.text = maybe.text.trim().slice(0, 4000);
    }
    if (typeof maybe.json === 'object' && maybe.json !== null) {
      details.json = maybe.json;
    }
    if (typeof maybe.details === 'object' && maybe.details !== null) {
      const inner = maybe.details as Record<string, unknown>;
      if (typeof inner.kind === 'string') {
        details.kind = inner.kind;
      }
      if (typeof inner.sample === 'string') {
        details.sample = inner.sample;
      }
    }
    if (Object.keys(details).length === 0) {
      return undefined;
    }
    return details;
  }

  private normalizeError(error: unknown, requestUrl: string): EmbeddingsProviderError {
    if (isEmbeddingsProviderError(error)) {
      return error;
    }

    const status = typeof (error as any)?.status === "number" ? (error as any).status : undefined;
    const retryInMsRaw = typeof (error as any)?.retryInMs === "number" ? (error as any).retryInMs : undefined;

    const maybe = error as any;
    const hasResponseText = typeof maybe?.text === "string" && maybe.text.trim().length > 0;
    const hasResponseJson = typeof maybe?.json === "object" && maybe.json !== null;
    const hasResponseHeaders = typeof maybe?.headers === "object" && maybe.headers !== null;
    const hasResponseShape = !!(error && typeof error === "object" && (hasResponseText || hasResponseJson || hasResponseHeaders));

    let parsedResponse:
      | { message: string; retryInMs?: number; details?: Record<string, unknown>; isHtml: boolean }
      | undefined;
    if (hasResponseShape) {
      try {
        parsedResponse = this.parseErrorResponse(maybe);
      } catch {}
    }

    const retryInMsParsed = typeof parsedResponse?.retryInMs === "number" ? parsedResponse.retryInMs : undefined;
    const retryInMs = retryInMsRaw && retryInMsRaw > 0
      ? retryInMsRaw
      : retryInMsParsed && retryInMsParsed > 0
        ? retryInMsParsed
        : undefined;

    const details = parsedResponse?.details ?? this.extractErrorDetails(error);
    const baseMessage = parsedResponse?.message ?? this.extractErrorMessage(error);
    const message =
      typeof status === "number" && status > 0
        ? `API error ${status}: ${baseMessage}`
        : baseMessage;
    const isHtml = parsedResponse?.isHtml ?? (typeof details?.kind === "string" && details.kind === "html-response");
    const code = this.classifyErrorCode(status, baseMessage, isHtml);
    const transient = this.isTransientStatus(status) || code === 'NETWORK_ERROR' || code === 'HOST_UNAVAILABLE';
    const licenseRelated = code === 'LICENSE_INVALID';

    return new EmbeddingsProviderError(message, {
      code,
      status,
      retryInMs,
      transient,
      licenseRelated,
      providerId: this.id,
      endpoint: requestUrl,
      details,
      cause: error
    });
  }
}
