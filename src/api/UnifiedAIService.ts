import { requestUrl, Notice } from 'obsidian';
import { Model, AIProvider, AIServiceInterface } from './Model';
import { logger } from '../utils/logger';

export class UnifiedAIService implements AIServiceInterface {
  private apiKey: string;
  private endpoint: string;
  private settings: { temperature: number };
  private provider: AIProvider;

  constructor(
    apiKey: string,
    endpoint: string,
    provider: AIProvider,
    settings: { temperature: number }
  ) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;
    this.provider = provider;
    this.settings = settings;
  }

  updateSettings(settings: { temperature: number }) {
    this.settings = settings;
  }

  updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string> {
    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
    });

    logger.log(
      'Model: ',
      modelId,
      'Max Output Tokens: ',
      maxOutputTokens,
      'Temperature: ',
      this.settings.temperature
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.provider === 'openRouter') {
      headers['HTTP-Referer'] = 'https://SystemSculpt.com';
      headers['X-Title'] = 'SystemSculpt AI for Obsidian';
    }

    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: requestData,
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
    });

    logger.log(
      'Model: ',
      modelId,
      'Max Output Tokens: ',
      maxOutputTokens,
      'Temperature: ',
      this.settings.temperature
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.provider === 'openRouter') {
      headers['HTTP-Referer'] = 'https://SystemSculpt.com';
      headers['X-Title'] = 'SystemSculpt AI for Obsidian';
    }

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('API request failed with status 404');
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let done = false;
    let buffer = '';
    let lastContent = '';

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            callback(line);
          }
        }
      }
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const requestData = JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
      max_tokens: maxOutputTokens,
      temperature: this.settings.temperature,
    });

    logger.log(
      'Model: ',
      modelId,
      'Max Output Tokens: ',
      maxOutputTokens,
      'Temperature: ',
      this.settings.temperature
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.provider === 'openRouter') {
      headers['HTTP-Referer'] = 'https://SystemSculpt.com';
      headers['X-Title'] = 'SystemSculpt AI for Obsidian';
    }

    const req = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`API request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('API request failed with status 404');
    }

    const reader = req.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let done = false;
    let buffer = '';
    let lastContent = '';

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      const decodedChunk = decoder.decode(value);
      buffer += decodedChunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices && data.choices[0].delta.content) {
              const newContent = data.choices[0].delta.content;
              if (newContent !== lastContent) {
                callback(line);
                lastContent = newContent;
              }
            } else {
              callback(line);
            }
          } catch (error) {
            callback(line);
          }
        }
      }
    }
  }

  private async getLocalModels(): Promise<Model[]> {
    logger.log(`Attempting to fetch local models from endpoint: ${this.endpoint}/models`);
    try {
      const response = await requestUrl({
        url: `${this.endpoint}/models`,
        method: 'GET',
      });
      logger.log(`Local models API response status: ${response.status}`);
      if (response.status === 200) {
        const data = response.json;
        logger.log(`Successfully fetched local models data: ${JSON.stringify(data)}`);
        return this.parseModels(data);
      } else {
        logger.error(`Failed to fetch local models. Status: ${response.status}, Response: ${JSON.stringify(response)}`);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('Error fetching local models:', error.message);
        logger.error('Error stack:', error.stack);
      } else {
        logger.error('Unknown error fetching local models:', error);
      }
    }
    logger.log('Returning empty array for local models due to error');
    return [];
  }

  async getModels(): Promise<Model[]> {
    if (this.provider === 'local') {
      return await this.getLocalModels();
    }

    if (!this.hasValidApiKey() || !this.endpoint.trim()) {
      logger.log(
        `No valid API key or endpoint provided for ${this.provider}. Skipping model fetch.`
      );
      return [];
    }

    logger.log(
      `Getting models for ${this.provider} from ${this.endpoint}/models`
    );
    try {
      const response = await requestUrl({
        url: `${this.endpoint}/models`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      if (response.status === 200) {
        const data = response.json;
        const parsedModels = this.parseModels(data);
        logger.log(
          `Successfully fetched ${parsedModels.length} models for ${this.provider}`
        );
        return parsedModels;
      } else {
        logger.error(
          `Failed to fetch models for ${this.provider}: Status ${
            response.status
          }, Response: ${JSON.stringify(response.json)}`
        );
        return [];
      }
    } catch (error) {
      logger.error(`Error fetching models for ${this.provider}:`, error);
      logger.error(
        `Provider: ${this.provider}, Endpoint: ${this.endpoint}/models`
      );
      if (error instanceof Error) {
        if ('status' in error) {
          const statusError = error as { status: number };
          if (statusError.status === 404) {
            logger.error(
              `${this.provider} API endpoint not found. Please check the API documentation and your settings.`
            );
          } else if (statusError.status === 401) {
            logger.error(
              `Invalid ${this.provider} API key. Please check your settings.`
            );
          }
        }
      }
      return [];
    }
  }

  private parseModels(data: any): Model[] {
    if (this.provider === 'local') {
      return data.data.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: 'local' as AIProvider,
        contextLength: model.context_window || undefined,
        maxOutputTokens: model.context_window || 4096,
        pricing: { prompt: 0, completion: 0 },
      }));
    } else if (this.provider === 'openai') {
      const filteredWords = [
        'dall-e',
        'tts',
        'whisper',
        'embedding',
        'davinci',
        'babbage',
        'gpt-4-turbo-2024-04-09',
        'gpt-4-1106-preview',
        'gpt-4o-mini-2024-07-18',
        'gpt-4-turbo-preview',
        'gpt-4-0125-preview',
        'gpt-4o-2024-05-13',
        'gpt-3.5-turbo-instruct',
        'gpt-3.5-turbo-instruct-0914',
        'gpt-3.5-turbo-16k',
        'gpt-3.5-turbo-0125',
        'gpt-3.5-turbo-1106',
        'gpt-4-0613',
        'gpt-3.5-turbo',
      ];
      const priorityOrder = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4'];
      const priorityContextLengths: { [key: string]: number } = {
        'gpt-4o': 128000,
        'gpt-4o-mini': 128000,
        'gpt-4-turbo': 128000,
        'gpt-4': 8192,
      };
      const priorityMaxOutputTokens: { [key: string]: number } = {
        'gpt-4o': 4096,
        'gpt-4o-mini': 16000,
        'gpt-4-turbo': 4096,
        'gpt-4': 4096,
      };
      const specialPricing: {
        [key: string]: { prompt: number; completion: number };
      } = {
        'gpt-4o': { prompt: 0.000005, completion: 0.000015 },
        'gpt-4o-mini': { prompt: 0.00000015, completion: 0.0000006 },
        'gpt-4-turbo': { prompt: 0.00001, completion: 0.00003 },
        'gpt-4': { prompt: 0.00003, completion: 0.00006 },
      };

      const filteredModels = data.data.filter(
        (model: any) =>
          !filteredWords.some(word => model.id.toLowerCase().includes(word))
      );

      const sortedModels = filteredModels.sort((a: any, b: any) => {
        const aIndex = priorityOrder.findIndex(prefix => a.id === prefix);
        const bIndex = priorityOrder.findIndex(prefix => b.id === prefix);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.id.localeCompare(b.id);
      });

      return sortedModels.map((model: any) => ({
        id: model.id,
        name: model.id,
        provider: 'openai' as AIProvider,
        contextLength:
          priorityContextLengths[model.id] || model.context_window || undefined,
        maxOutputTokens:
          priorityMaxOutputTokens[model.id] || model.context_window || 4096,
        pricing:
          specialPricing[model.id] ||
          (model.pricing
            ? {
                prompt: parseFloat(model.pricing.prompt),
                completion: parseFloat(model.pricing.completion),
              }
            : { prompt: 0, completion: 0 }),
      }));
    } else if (this.provider === 'groq') {
      return data.data
        .filter(
          (model: any) =>
            model.id !== 'whisper-large-v3' &&
            !model.id.toLowerCase().includes('tool-use')
        )
        .map((model: any) => ({
          id: model.id,
          name: model.id,
          provider: 'groq' as AIProvider,
          contextLength: model.context_window || undefined,
          pricing: model.pricing
            ? {
                prompt: parseFloat(model.pricing.prompt),
                completion: parseFloat(model.pricing.completion),
              }
            : { prompt: 0, completion: 0 },
        }));
    } else if (this.provider === 'openRouter') {
      return data.data.map((model: any) => ({
        id: model.id || model.name,
        name: model.name || model.id,
        provider: 'openRouter' as AIProvider,
        contextLength: model.context_length || undefined,
        pricing: model.pricing
          ? {
              prompt: parseFloat(model.pricing.prompt),
              completion: parseFloat(model.pricing.completion),
            }
          : { prompt: 0, completion: 0 },
      }));
    }
    return [];
  }

  public hasValidApiKey(): boolean {
    return (
      this.provider === 'local' || (!!this.apiKey && this.apiKey.length > 0)
    );
  }

  static async validateApiKey(
    apiKey: string,
    endpoint: string,
    provider: AIProvider
  ): Promise<boolean> {
    if (provider === 'local') {
      try {
        // Try Ollama endpoint first
        const ollamaResponse = await requestUrl({
          url: `${endpoint}/api/tags`,
          method: 'GET',
        });
        if (ollamaResponse.status === 200) {
          return true;
        }
      } catch {
        // If Ollama fails, try OpenAI-compatible endpoint
        try {
          const openAIResponse = await requestUrl({
            url: `${endpoint}/models`,
            method: 'GET',
          });
          return openAIResponse.status === 200;
        } catch (error: unknown) {
          if (error instanceof Error) {
            logger.error('Error validating local endpoint:', error.message);
          } else {
            logger.error('Unknown error validating local endpoint');
          }
          return false;
        }
      }
    }

    if (!apiKey && provider !== 'local') return false;

    logger.log(`Validating ${provider} API key`);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
      };

      if (provider === 'openRouter') {
        headers['HTTP-Referer'] = 'https://SystemSculpt.com';
        headers['X-Title'] = 'SystemSculpt AI for Obsidian';
      }

      const response = await requestUrl({
        url: `${endpoint}/models`,
        method: 'GET',
        headers: headers,
      });
      return response.status === 200;
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error(`Error validating ${provider} API key:`, error.message);
      } else {
        logger.error(`Unknown error validating ${provider} API key`);
      }
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const statusError = error as { status: number };
        if (statusError.status === 404) {
          logger.error(
            `${provider} API endpoint not found. Please check the API documentation and your settings.`
          );
        } else if (statusError.status === 401) {
          logger.error(
            `Invalid ${provider} API key. Please check your settings.`
          );
        }
      }
      return false;
    }
  }
}
