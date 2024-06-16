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
      stream: false,
    });

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
    callback: (chunk: string) => void
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
      });

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
    callback: (chunk: string) => void
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
      });

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
      });

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
      // if it's a 404, change the endpoint to /api/tags and try again
      if (error.status === 404) {
        try {
          let response = await requestUrl(`${this.endpoint}/api/tags`);

          if (response.status === 200) {
            const data = response.json;
            return data.models.map((model: any) => ({
              id: model.name,
              name: model.name,
              isLocal: true,
              provider: 'local',
            }));
          } else {
            console.error(
              'Failed to fetch local models from /api/tags:',
              response.status
            );
            return [];
          }
        } catch (error) {
          console.error('Error fetching models from /api/tags:', error);
          return [];
        }
      } else {
        console.error('Error fetching models:', error);
        return [];
      }
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
