import { requestUrl, RequestUrlParam, Notice } from 'obsidian';
import { Model, AIProvider } from './Model';
import { AIServiceInterface } from './AIServiceInterface';
import { logger } from '../utils/logger';

export class LocalAIService implements AIServiceInterface {
  private endpoint?: string;
  private settings: { temperature: number };

  constructor(settings: { temperature: number }, endpoint?: string) {
    this.settings = settings;
    this.endpoint = endpoint;
  }

  updateSettings(settings: { temperature: number }) {
    this.settings = settings;
  }

  updateApiKey(_apiKey: string): void {
    // LocalAIService doesn't use an API key, so this method is a no-op
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number
  ): Promise<string> {
    if (!this.endpoint) {
      throw new Error('Local endpoint not configured');
    }

    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      stream: false,
      temperature: this.settings.temperature,
    });

    logger.log(
      'Model: ',
      modelId,
      'Max Tokens: ',
      maxTokens,
      'Temperature: ',
      this.settings.temperature
    );

    const response = await requestUrl({
      url: `${this.endpoint}/v1/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestData,
      contentType: 'application/json',
    });

    if (response.status !== 200) {
      throw new Error(`Local AI request failed with status ${response.status}`);
    }

    const data = await response.json;
    return data.choices[0].message.content.trim();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.endpoint) {
      throw new Error('Local endpoint not configured');
    }

    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
      max_tokens: maxTokens,
      temperature: this.settings.temperature,
    });

    logger.log(
      'Model: ',
      modelId,
      'Max Tokens: ',
      maxTokens,
      'Temperature: ',
      this.settings.temperature
    );

    try {
      const req = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestData,
      });

      if (!req.ok) {
        throw new Error(`Local AI request failed with status ${req.status}`);
      }

      if (!req.body) {
        throw new Error('Local AI request failed with status 404');
      }

      const reader = req.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      let firstPartialChunk = '';
      let secondPartialChunk = '';

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        const decodedChunk = decoder.decode(value);
        const chunks = decodedChunk.split('\n');
        chunks.forEach(chunk => {
          if (chunk.startsWith('data: ') && chunk.endsWith('null}]}')) {
            callback(chunk);
          } else if (chunk.startsWith('data: ')) {
            firstPartialChunk = chunk;
          } else {
            secondPartialChunk = chunk;
            callback(firstPartialChunk + secondPartialChunk);
          }
        });
      }
    } catch (error) {
      logger.log(
        'Using requestUrl without stream instead of fetch due to error!'
      );

      const requestData = JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        max_tokens: maxTokens,
        temperature: this.settings.temperature,
      });

      logger.log(
        'Model: ',
        modelId,
        'Max Tokens: ',
        maxTokens,
        'Temperature: ',
        this.settings.temperature
      );

      const response = await requestUrl({
        url: `${this.endpoint}/v1/chat/completions`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestData,
        contentType: 'application/json',
      });

      const data = response.json;
      const content = data.choices[0].message.content;
      callback(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`
      );
      callback('data: [DONE]\n');
    }
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.endpoint) {
      throw new Error('Local endpoint not configured');
    }

    try {
      const requestData = JSON.stringify({
        model: modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: maxTokens,
        temperature: this.settings.temperature,
      });

      logger.log(
        'Model: ',
        modelId,
        'Max Tokens: ',
        maxTokens,
        'Temperature: ',
        this.settings.temperature
      );

      const req = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestData,
      });

      if (!req.ok) {
        throw new Error(`Local AI request failed with status ${req.status}`);
      }

      if (!req.body) {
        throw new Error('Local AI request failed with status 404');
      }

      const reader = req.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let done = false;
      let firstPartialChunk = '';
      let secondPartialChunk = '';

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        const decodedChunk = decoder.decode(value);
        const chunks = decodedChunk.split('\n');
        chunks.forEach(chunk => {
          if (chunk.startsWith('data: ') && chunk.endsWith('null}]}')) {
            callback(chunk);
          } else if (chunk.startsWith('data: ')) {
            firstPartialChunk = chunk;
          } else {
            secondPartialChunk = chunk;
            callback(firstPartialChunk + secondPartialChunk);
          }
        });
      }
    } catch (error) {
      logger.log('Error in LocalAIService:', error);

      if (error instanceof Error && error.message.includes('status 500')) {
        // Create a CustomNotice to inform the user
        const notice = new Notice(
          'Ollama error detected. Please try restarting your Ollama instance.',
          10000
        );

        // Throw a more informative error
        throw new Error(
          'Ollama instance may need to be restarted. Please restart Ollama and try again.'
        );
      }

      // If it's not the specific error we're looking for, proceed with the existing fallback
      logger.log(
        'Using requestUrl without stream instead of fetch due to error!'
      );

      const requestData = JSON.stringify({
        model: modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: false,
        max_tokens: maxTokens,
        temperature: this.settings.temperature,
      });

      logger.log(
        'Model: ',
        modelId,
        'Max Tokens: ',
        maxTokens,
        'Temperature: ',
        this.settings.temperature
      );

      const response = await requestUrl({
        url: `${this.endpoint}/v1/chat/completions`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: requestData,
        contentType: 'application/json',
      });

      const data = response.json;
      const content = data.choices[0].message.content;
      callback(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`
      );
      callback('data: [DONE]\n');
    }
  }

  async getModels(): Promise<Model[]> {
    logger.log('LocalAIService: Starting getModels');
    if (!this.endpoint) {
      logger.log(
        'LocalAIService: No endpoint configured, returning empty array'
      );
      return [];
    }

    if (!this.isValidEndpoint(this.endpoint)) {
      logger.error('LocalAIService: Invalid endpoint URL:', this.endpoint);
      return [];
    }

    try {
      // First, try to fetch models from /v1/models (LM Studio compatibility)
      try {
        const v1ModelsResponse = await requestUrl({
          url: `${this.endpoint}/v1/models`,
          method: 'GET',
        });

        if (v1ModelsResponse.status === 200) {
          return this.fetchModelsFromV1Models(v1ModelsResponse.json);
        }
      } catch (error) {
        logger.log(
          'LocalAIService: /v1/models endpoint not available, trying /api/tags'
        );
      }

      // If /v1/models fails, try /api/tags (Ollama compatibility)
      logger.log('LocalAIService: Attempting to fetch models from /api/tags');
      const tagsResponse = await requestUrl({
        url: `${this.endpoint}/api/tags`,
        method: 'GET',
      });

      if (tagsResponse.status === 200) {
        return this.fetchModelsFromApiTags(tagsResponse.json);
      }

      logger.error(
        'LocalAIService: Failed to fetch models from both endpoints'
      );
      return [];
    } catch (error) {
      logger.error('LocalAIService: Error fetching models:', error);
      return [];
    }
  }

  private async fetchModels(data: any, isV1Models: boolean): Promise<Model[]> {
    const models: Model[] = [];

    const modelList = isV1Models ? data.data : data.models;

    for (const model of modelList) {
      const modelId = isV1Models ? model.id : model.name;
      let contextLength: number | undefined = undefined;

      try {
        const showResponse = await requestUrl({
          url: `${this.endpoint}/api/show`,
          method: 'POST',
          body: JSON.stringify({ name: modelId }),
          headers: { 'Content-Type': 'application/json' },
        });

        if (showResponse.status === 200) {
          const showData = showResponse.json;
          if (showData.model_info) {
            const contextLengthKey = Object.keys(showData.model_info).find(key =>
              key.endsWith('.context_length')
            );
            if (contextLengthKey) {
              const rawContextLength = showData.model_info[contextLengthKey];
              contextLength = typeof rawContextLength === 'number' ? rawContextLength : undefined;
            }
          }
        }
      } catch (error) {
        logger.error(`LocalAIService: Failed to fetch details for model ${modelId}`, error);
      }

      models.push({
        id: modelId,
        name: modelId,
        isLocal: true,
        provider: 'local',
        contextLength: contextLength,
      });
    }

    return models;
  }

  private async fetchModelsFromV1Models(data: any): Promise<Model[]> {
    return this.fetchModels(data, true);
  }

  private async fetchModelsFromApiTags(data: any): Promise<Model[]> {
    return this.fetchModels(data, false);
  }

  private isValidEndpoint(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const port = parseInt(parsedUrl.port, 10);

      // Check if the port is within the valid range (1-65535)
      if (port && (port < 1 || port > 65535)) {
        logger.error('LocalAIService: Invalid port number:', port);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('LocalAIService: Invalid URL:', url, error);
      return false;
    }
  }

  static async validateEndpoint(endpoint: string): Promise<boolean> {
    if (!endpoint) return false;

    try {
      const response = await requestUrl({
        url: `${endpoint}/v1/models`,
        method: 'GET',
      });
      return response.status === 200;
    } catch (error) {
      if (error.status === 404) {
        try {
          const response = await requestUrl({
            url: `${endpoint}/api/tags`,
            method: 'GET',
          });
          return response.status === 200;
        } catch (error) {
          logger.error('Error validating endpoint with /api/tags:', error);
          return false;
        }
      } else {
        logger.error('Error validating endpoint:', error);
        return false;
      }
    }
  }
}
