import { requestUrl } from 'obsidian';
import { Model } from './Model';

export class LocalAIService {
  private endpoint?: string;

  constructor(endpoint?: string) {
    this.endpoint = endpoint;
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
    });

    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestData,
    });

    if (!response.ok) {
      throw new Error(`Local AI request failed with status ${response.status}`);
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
    });

    // Instead of using requestUrl, the fetch function is used to make the request to the Groq API.
    // This is because requestUrl doesn't provide a body property on the response object.

    const req = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestData,
      signal: abortSignal,
    });

    if (!req.ok) {
      throw new Error(`Local AI request failed with status ${req.status}`);
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
    if (!this.endpoint) return [];

    try {
      const response = await requestUrl(`${this.endpoint}/v1/models`);
      if (response.status === 200) {
        const data = response.json;
        return data.data.map((model: any) => ({
          id: model.id,
          name: model.id.split('/').pop(),
          isLocal: true,
          provider: 'local',
        }));
      } else {
        console.error('Failed to fetch local models:', response.status);
        return [];
      }
    } catch (error) {
      return [];
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
      return false;
    }
  }
}
