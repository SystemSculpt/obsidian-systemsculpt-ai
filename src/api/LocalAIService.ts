import { requestUrl, RequestUrlParam } from 'obsidian';
import { Model } from './Model';

export class LocalAIService {
  private endpoint?: string;
  private settings: { temperature: number };

  constructor(settings: { temperature: number }, endpoint?: string) {
    this.settings = settings;
    this.endpoint = endpoint;
  }

  updateSettings(settings: { temperature: number }) {
    this.settings = settings;
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

    console.log(
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

    console.log(
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
      console.log(
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

      console.log(
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

      console.log(
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
      console.log(
        'Using requestUrl without stream instead of fetch due to error!'
      );

      const requestData = JSON.stringify({
        model: modelId,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: false,
        max_tokens: maxTokens,
        temperature: this.settings.temperature,
      });

      console.log(
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
    console.log('LocalAIService: Starting getModels');
    if (!this.endpoint) {
      console.log(
        'LocalAIService: No endpoint configured, returning empty array'
      );
      return [];
    }

    // Validate the endpoint URL
    if (!this.isValidEndpoint(this.endpoint)) {
      console.error('LocalAIService: Invalid endpoint URL:', this.endpoint);
      return [];
    }

    try {
      console.log('LocalAIService: Attempting to fetch models from /v1/models');
      const requestOptions: RequestUrlParam = {
        url: `${this.endpoint}/v1/models`,
        method: 'GET',
      };

      const response = await requestUrl(requestOptions);
      console.log('LocalAIService: Response status:', response.status);

      if (response.status === 200) {
        const data = response.json;
        console.log('LocalAIService: Models data received:', data);

        const models = data.data.map((model: any) => ({
          id: model.id,
          name: model.id.split('/').pop(),
          isLocal: true,
          provider: 'local',
        }));
        console.log('LocalAIService: Processed models:', models);
        return models;
      } else {
        console.log(
          'LocalAIService: Failed to fetch models from /v1/models, attempting /api/tags'
        );
        return this.fetchModelsFromApiTags();
      }
    } catch (error) {
      console.log(
        'LocalAIService: Error fetching from /v1/models, attempting /api/tags'
      );
      return this.fetchModelsFromApiTags();
    }
  }

  private async fetchModelsFromApiTags(): Promise<Model[]> {
    try {
      let response = await requestUrl(`${this.endpoint}/api/tags`);
      console.log(
        'LocalAIService: Response status from /api/tags:',
        response.status
      );

      if (response.status === 200) {
        const data = response.json;
        console.log(
          'LocalAIService: Models data received from /api/tags:',
          data
        );

        const models = data.models.map((model: any) => ({
          id: model.name,
          name: model.name,
          isLocal: true,
          provider: 'local',
        }));
        console.log('LocalAIService: Processed models from /api/tags:', models);
        return models;
      } else {
        console.error(
          'LocalAIService: Failed to fetch local models from /api/tags:',
          response.status
        );
        return [];
      }
    } catch (error) {
      console.error(
        'LocalAIService: Error fetching models from /api/tags:',
        error
      );
      return [];
    }
  }

  private isValidEndpoint(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const port = parseInt(parsedUrl.port, 10);

      // Check if the port is within the valid range (1-65535)
      if (port && (port < 1 || port > 65535)) {
        console.error('LocalAIService: Invalid port number:', port);
        return false;
      }

      return true;
    } catch (error) {
      console.error('LocalAIService: Invalid URL:', url, error);
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
          console.error('Error validating endpoint with /api/tags:', error);
          return false;
        }
      } else {
        console.error('Error validating endpoint:', error);
        return false;
      }
    }
  }
}
