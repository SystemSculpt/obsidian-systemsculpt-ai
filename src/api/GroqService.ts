import { requestUrl } from 'obsidian';
import { Model } from './Model';

export class GroqService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  updateApiKey(apiKey: string): void {
    console.log('updating groq api key...');
    this.apiKey = apiKey;
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

    console.log('creating groq chat completion...');
    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
    });

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

    console.log('creating groq streaming chat completion...');
    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
      max_tokens: maxTokens,
    });

    // Instead of using requestUrl, the fetch function is used to make the request to the Groq API.
    // This is because requestUrl doesn't provide a body property on the response object.

    const req = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestData,
      signal: abortSignal,
    });

    if (!req.ok) {
      throw new Error(`Groq API request failed with status ${req.status}`);
    }

    //@ts-ignore
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
        return data.data.map((model: any) => ({
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
}
