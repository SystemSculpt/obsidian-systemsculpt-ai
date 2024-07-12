import { requestUrl } from 'obsidian';
import { Model, AIProvider } from './Model';
import { AIServiceInterface } from './AIServiceInterface';
import { logger } from '../utils/logger';

export class OpenAIService implements AIServiceInterface {
  private apiKey: string;
  private apiEndpoint: string;
  private settings: { temperature: number };

  constructor(apiKey: string, apiEndpoint: string) {
    this.apiKey = apiKey;
    this.apiEndpoint = apiEndpoint;
  }

  updateSettings(settings: { temperature: number }) {
    this.settings = settings;
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    temperature?: number
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not set');
    }

    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
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

    const response = await fetch(`${this.apiEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal,
    temperature?: number
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not set');
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
    // Instead of using requestUrl, the fetch function is used to make the request to the Groq API.
    // This is because requestUrl doesn't provide a body property on the response object.

    const req = await fetch(`${this.apiEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`OpenAI request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('OpenAI request failed with status 404');
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
  }

  async createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal,
    temperature?: number
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is not set');
    }

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

    const req = await fetch(`${this.apiEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`OpenAI request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('OpenAI request failed with status 404');
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
  }

  async getModels(): Promise<Model[]> {
    if (!this.apiKey) return [];

    try {
      const response = await requestUrl({
        url: `https://api.openai.com/v1/models`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      if (response.status === 200) {
        const data = response.json;
        return data.data
          .filter(
            (model: any) =>
              model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4o'
          )
          .map((model: any) => ({
            id: model.id,
            name: model.id,
            isLocal: false,
            provider: 'openai',
            contextLength: model.id === 'gpt-3.5-turbo' ? 16384 : 128000,
          }));
      } else {
        logger.error('Failed to fetch OpenAI models:', response.status);
        return [];
      }
    } catch (error) {
      logger.error('Error fetching OpenAI models:', error);
      return [];
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;

    try {
      const response = await requestUrl({
        url: `https://api.openai.com/v1/models`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch (error) {
      logger.error('Error validating OpenAI API key:', error);
      return false;
    }
  }

  updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}
