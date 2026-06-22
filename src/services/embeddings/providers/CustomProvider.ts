/**
 * CustomProvider - User-configurable embeddings provider
 *
 * Supports any OpenAI-compatible embeddings API:
 * - OpenAI API
 * - Azure OpenAI
 * - Local embeddings servers (LM Studio, Ollama, ...)
 * - Other compatible providers
 *
 * Response parsing is delegated to the shared `normalizeEmbeddingsResponse` so
 * every server shape (OpenAI `data[]`, top-level `{embedding}`/`{embeddings}`,
 * raw arrays) is handled in one tested place (#153), and every failure is raised
 * as a typed `EmbeddingsProviderError` so callers can tell a transient 429/5xx
 * apart from a permanent 4xx (#150, and the retry/backoff slice that follows).
 */

import { httpRequest } from '../../../utils/httpClient';
import { EmbeddingsProvider, EmbeddingsGenerateOptions } from '../types';
import { normalizeEmbeddingsResponse } from './embeddingResponse';
import { EmbeddingsProviderError, isEmbeddingsProviderError } from './ProviderError';
import { buildHttpErrorOptions } from './providerHttpErrors';

export interface CustomProviderConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  maxBatchSize?: number;
}

export class CustomProvider implements EmbeddingsProvider {
  readonly id = 'custom';
  readonly name = 'Custom Provider';
  readonly supportsModels = true;
  public readonly model: string | undefined;
  public expectedDimension: number | undefined;

  private readonly maxBatchSize: number;
  private readonly headers: Record<string, string>;
  private readonly isOllamaStyle: boolean;

  constructor(private config: CustomProviderConfig) {
    this.maxBatchSize = config.maxBatchSize || 100;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers
    };

    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    this.model = config.model;
    const endpoint = (config.endpoint || '').toLowerCase();
    // Heuristic: Ollama embeddings endpoint is /api/embeddings
    this.isOllamaStyle = endpoint.includes('/api/embeddings');
  }

  async generateEmbeddings(texts: string[], options?: EmbeddingsGenerateOptions): Promise<number[][]> {
    const endpoint = (this.config.endpoint || "").trim();
    if (!endpoint) {
      throw new Error('Custom endpoint URL is required');
    }
    const model = (this.config.model || "").trim();
    if (!model) {
      throw new Error("Custom embeddings model is required");
    }

    if (texts.length === 0) {
      return [];
    }

    // Handle large batches
    if (texts.length > this.maxBatchSize) {
      return this.generateEmbeddingsInBatches(texts, options?.inputType);
    }

    if (this.isOllamaStyle) {
      return this.processOllamaParallel(texts, endpoint, model, options);
    }
    return this.processOpenAiBatch(texts, endpoint, model, options);
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Validate endpoint format
      const url = new URL(this.config.endpoint);
      if (!url.protocol.startsWith('http')) {
        throw new Error('Endpoint must use HTTP or HTTPS protocol');
      }

      // Test with a simple embedding
      await this.generateEmbeddings(['test']);
      return true;
    } catch (error) {
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    // For custom providers, we don't know available models
    // Return the configured model and common ones (updated with Google defaults)
    const commonModels = [
      'openrouter/openai/text-embedding-3-small',
      'openai/text-embedding-3-small',
      'openai/text-embedding-3-large',
      'all-MiniLM-L6-v2',
      'all-mpnet-base-v2',
      'text-embedding-004',
      'text-embedding-004-multilingual'
    ];

    if (this.config.model && !commonModels.includes(this.config.model)) {
      return [this.config.model, ...commonModels];
    }

    return commonModels;
  }

  getMaxBatchSize(): number {
    return this.maxBatchSize;
  }

  /** OpenAI-compatible batch embeddings (one request for the whole batch). */
  private async processOpenAiBatch(
    texts: string[],
    endpoint: string,
    model: string,
    options?: EmbeddingsGenerateOptions
  ): Promise<number[][]> {
    let response;
    try {
      response = await httpRequest({
        url: endpoint,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          input: texts,
          model,
          encoding_format: 'float',
          input_type: options?.inputType === 'query' ? 'query' : 'document'
        })
      });
    } catch (error) {
      throw this.toNetworkError(error, endpoint);
    }

    if (!response.status || response.status !== 200) {
      throw await this.toHttpError(response, endpoint);
    }

    const data = response.json ?? this.safeParseJson(response.text);
    const vectors = normalizeEmbeddingsResponse(data);
    if (!vectors) {
      throw new EmbeddingsProviderError('Unsupported response format from custom endpoint', {
        code: 'UNEXPECTED_RESPONSE',
        providerId: this.id,
        endpoint,
        details: { shape: this.describeShape(data) }
      });
    }

    this.recordDimension(vectors);
    return vectors;
  }

  private async generateEmbeddingsInBatches(texts: string[], inputType?: 'document' | 'query'): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchEmbeddings = await this.generateEmbeddings(batch, { inputType });
      results.push(...batchEmbeddings);
    }

    return results;
  }

  private async processOllamaParallel(
    texts: string[],
    endpoint: string,
    model: string,
    options?: EmbeddingsGenerateOptions
  ): Promise<number[][]> {
    const maxConcurrent = 5;
    const results: Array<{ index: number; embedding: number[] }> = [];
    const inFlight = new Set<Promise<void>>();
    let nextIndex = 0;
    let firstError: Error | null = null;

    const processOne = async (index: number, text: string): Promise<void> => {
      let response;
      try {
        response = await httpRequest({
          url: endpoint,
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            model,
            prompt: text,
            task_type: options?.inputType === 'query' ? 'retrieval_query' : 'retrieval_document'
          })
        });
      } catch (error) {
        throw this.toNetworkError(error, endpoint);
      }

      if (!response.status || response.status !== 200) {
        throw await this.toHttpError(response, endpoint);
      }

      const data = response.json ?? this.safeParseJson(response.text);
      const vectors = normalizeEmbeddingsResponse(data);
      const embedding = vectors?.[0];

      if (!embedding) {
        throw new EmbeddingsProviderError('Unsupported response format from Ollama endpoint', {
          code: 'UNEXPECTED_RESPONSE',
          providerId: this.id,
          endpoint,
          details: { shape: this.describeShape(data) }
        });
      }

      if (!this.expectedDimension && embedding.length > 0) {
        this.expectedDimension = embedding.length;
      }

      results.push({ index, embedding });
    };

    while (nextIndex < texts.length || inFlight.size > 0) {
      while (nextIndex < texts.length && inFlight.size < maxConcurrent && !firstError) {
        const idx = nextIndex++;
        const promise = processOne(idx, texts[idx])
          .catch(err => { if (!firstError) firstError = err; })
          .finally(() => inFlight.delete(promise));
        inFlight.add(promise);
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
      if (firstError && inFlight.size === 0) {
        throw firstError;
      }
    }

    if (firstError) {
      throw firstError;
    }

    return results.sort((a, b) => a.index - b.index).map(r => r.embedding);
  }

  /** Adopt the observed dimension from the first vector for downstream validation. */
  private recordDimension(vectors: number[][]): void {
    const dim = vectors[0]?.length;
    if (typeof dim === 'number' && dim > 0) {
      this.expectedDimension = dim;
    }
  }

  /** Build a typed error for a non-200 HTTP response, preserving the legacy message. */
  private async toHttpError(response: any, endpoint: string): Promise<EmbeddingsProviderError> {
    const errorMessage = await this.parseErrorResponse(response);
    return new EmbeddingsProviderError(
      `Custom API error ${response.status}: ${errorMessage}`,
      buildHttpErrorOptions({
        status: response.status || 0,
        headers: response.headers,
        providerId: this.id,
        endpoint,
        details: { body: errorMessage.slice(0, 500) }
      })
    );
  }

  /** Wrap a transport-level failure as a transient NETWORK_ERROR (never double-wrap). */
  private toNetworkError(error: unknown, endpoint: string): EmbeddingsProviderError {
    if (isEmbeddingsProviderError(error)) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new EmbeddingsProviderError(message, {
      code: 'NETWORK_ERROR',
      transient: true,
      providerId: this.id,
      endpoint,
      cause: error
    });
  }

  private safeParseJson(text?: string): unknown {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return undefined;
    }
  }

  /** A compact, non-sensitive description of a response shape for error diagnostics. */
  private describeShape(data: unknown): string {
    if (data == null) return String(data);
    if (Array.isArray(data)) return `array[${data.length}]`;
    if (typeof data === 'object') return `object{${Object.keys(data as object).join(',')}}`;
    return typeof data;
  }

  private async parseErrorResponse(response: any): Promise<string> {
    try {
      const errorData = JSON.parse(response.text);

      // Common error formats
      if (errorData.error?.message) return errorData.error.message;
      if (errorData.message) return errorData.message;
      if (errorData.detail) return errorData.detail;

      return response.text;
    } catch {
      return response.text || 'Unknown error';
    }
  }
}
