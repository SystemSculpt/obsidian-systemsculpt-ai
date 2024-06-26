import { requestUrl } from 'obsidian';
import { Model } from './Model';

export class GroqService {
  private apiKey: string;
  private settings: { temperature: number };

  constructor(apiKey: string, settings: { temperature: number }) {
    this.apiKey = apiKey;
    this.settings = settings;
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
    if (!this.apiKey) {
      throw new Error('Groq API key is not set');
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

    console.log(
      'Model: ',
      modelId,
      'Max Tokens: ',
      maxTokens,
      'Temperature: ',
      this.settings.temperature
    );

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: requestData,
      }
    );

    if (!response.ok) {
      throw new Error(`Groq API request failed with status ${response.status}`);
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
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Groq API key is not set');
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
    // Instead of using requestUrl, the fetch function is used to make the request to the Groq API.
    // This is because requestUrl doesn't provide a body property on the response object.

    const req = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`Groq API request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('Groq API request failed with status 404');
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
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Groq API key is not set');
    }

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

    const req = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
    });

    if (!req.ok) {
      throw new Error(`Groq API request failed with status ${req.status}`);
    }

    if (!req.body) {
      throw new Error('Groq API request failed with status 404');
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

    console.log('getting groq models...');
    try {
      const response = await requestUrl({
        url: 'https://api.groq.com/openai/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      if (response.status === 200) {
        const data = response.json;
        return data.data
          .filter((model: any) => model.id !== 'whisper-large-v3')
          .map((model: any) => ({
            id: model.id,
            name: model.id,
            isLocal: false,
            provider: 'groq',
          }));
      } else {
        console.error('Failed to fetch Groq models:', response.status);
        return [];
      }
    } catch (error) {
      console.error('Error fetching Groq models:', error);
      return [];
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey) return false;

    console.log('validating groq api key...');
    try {
      const response = await requestUrl({
        url: 'https://api.groq.com/openai/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch (error) {
      console.error('Error validating Groq API key:', error);
      return false;
    }
  }

  updateApiKey(apiKey: string): void {
    console.log('updating groq api key...');
    this.apiKey = apiKey;
  }
}
