/**
 * CustomProvider - User-configurable embeddings provider
 * 
 * Supports any OpenAI-compatible embeddings API:
 * - OpenAI API
 * - Azure OpenAI
 * - Local embeddings servers
 * - Other compatible providers
 */

import { httpRequest } from '../../../utils/httpClient';
import { EmbeddingsProvider, EmbeddingsGenerateOptions } from '../types';

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

    try {
      if (this.isOllamaStyle) {
        return this.processOllamaParallel(texts, endpoint, model, options);
      } else {
        // OpenAI-compatible batch embeddings
        const response = await httpRequest({
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

        if (!response.status || response.status !== 200) {
          const errorMessage = await this.parseErrorResponse(response as any);
          throw new Error(`Custom API error ${response.status}: ${errorMessage}`);
        }

        const data = response.json ?? JSON.parse(response.text || '{}');
        
        // Handle OpenAI-style response
        if (data.data && Array.isArray(data.data)) {
          const embeddings = data.data
            .sort((a: any, b: any) => a.index - b.index)
            .map((item: any) => item.embedding);
          
          const sample = embeddings[0];
          const dim = Array.isArray(sample) ? sample.length : undefined;
          if (typeof dim === 'number' && dim > 0) {
            this.expectedDimension = dim;
          }
          
          return embeddings;
        }
        
        // Handle direct array response
        if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
          const dim = data[0].length;
          if (typeof dim === 'number' && dim > 0) {
            this.expectedDimension = dim;
          }
          return data;
        }

        throw new Error('Unsupported response format from custom endpoint');
      }
    } catch (error) {
      throw error;
    }
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
      const response = await httpRequest({
        url: endpoint,
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model,
          prompt: text,
          task_type: options?.inputType === 'query' ? 'retrieval_query' : 'retrieval_document'
        })
      });

      if (!response.status || response.status !== 200) {
        const errorMessage = await this.parseErrorResponse(response as any);
        throw new Error(`Custom API error ${response.status}: ${errorMessage}`);
      }

      const data = response.json ?? JSON.parse(response.text || '{}');
      let embedding: number[] | undefined;

      if (Array.isArray(data?.embedding)) {
        embedding = data.embedding;
      } else if (Array.isArray(data?.data) && Array.isArray(data.data[0]?.embedding)) {
        embedding = data.data[0].embedding;
      }

      if (!embedding) {
        throw new Error('Unsupported response format from Ollama endpoint');
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
