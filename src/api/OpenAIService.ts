import axios, { AxiosInstance } from 'axios';
import { Model } from './Model';

export class OpenAIService {
  private static instance: OpenAIService;
  private apiKey: string;
  client: AxiosInstance;
  private settings: { openAIApiKey: string };

  private constructor(apiKey: string, settings: { openAIApiKey: string }) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    this.settings = settings;
  }

  static getInstance(
    apiKey: string,
    settings: { openAIApiKey: string }
  ): OpenAIService {
    if (!OpenAIService.instance) {
      OpenAIService.instance = new OpenAIService(apiKey, settings);
    }
    return OpenAIService.instance;
  }

  static updateApiKey(newApiKey: string): OpenAIService {
    if (this.instance) {
      this.instance.apiKey = newApiKey;
      this.instance.client.defaults.headers.Authorization = `Bearer ${newApiKey}`;
      this.instance.settings.openAIApiKey = newApiKey;
    } else {
      this.instance = new OpenAIService(newApiKey, { openAIApiKey: newApiKey });
    }
    return this.instance;
  }

  updateApiKey(newApiKey: string): void {
    this.apiKey = newApiKey;
    this.client.defaults.headers.Authorization = `Bearer ${newApiKey}`;
    this.settings.openAIApiKey = newApiKey;
  }

  async createChatCompletion(
    prompt: string,
    modelId: string,
    temperature: number = 0.2,
    maxTokens: number = 100
  ): Promise<string> {
    const currentApiKey = this.settings.openAIApiKey;
    this.client.defaults.headers.Authorization = `Bearer ${currentApiKey}`;

    console.log('Using API Key: ', this.client.defaults.headers.Authorization);
    console.log(`Using model: ${modelId}`);
    console.log(`Max tokens: ${maxTokens}`);
    try {
      const response = await this.client.post('/chat/completions', {
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      });

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating chat completion:', error);
      throw new Error(
        'Failed to generate chat completion. Please check your OpenAI API key and try again.'
      );
    }
  }

  async validateApiKeyInternal(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch (error) {
      console.error('Error validating OpenAI API key:', error);
      return false;
    }
  }

  async getModels(): Promise<Model[]> {
    const currentApiKey = this.settings.openAIApiKey;
    this.client.defaults.headers.Authorization = `Bearer ${currentApiKey}`;

    try {
      const response = await this.client.get('/models');
      return response.data.data
        .filter(
          model =>
            model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4-turbo-preview'
        )
        .map((model: any) => ({
          id: model.id,
          name: model.id,
        }));
    } catch (error) {
      console.error('Error fetching OpenAI models:', error);
      throw new Error(
        'Failed to fetch OpenAI models. Please check your OpenAI API key and try again.'
      );
    }
  }

  async getUsage(): Promise<any> {
    const currentApiKey = this.settings.openAIApiKey;
    this.client.defaults.headers.Authorization = `Bearer ${currentApiKey}`;

    try {
      const response = await this.client.get('/usage');
      return response.data;
    } catch (error) {
      console.error('Error fetching OpenAI usage:', error);
      throw new Error(
        'Failed to fetch OpenAI usage. Please check your OpenAI API key and try again.'
      );
    }
  }

  async generateEmbeddings(input: string): Promise<number[]> {
    const currentApiKey = this.settings.openAIApiKey;
    this.client.defaults.headers.Authorization = `Bearer ${currentApiKey}`;

    try {
      const response = await this.client.post('/embeddings', {
        input,
        model: 'text-embedding-3-large',
      });

      return response.data.data[0].embedding;
    } catch (error) {
      console.error('Error generating embeddings:', error);
      throw new Error(
        'Failed to generate embeddings. Please check your OpenAI API key and try again.'
      );
    }
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!this.instance) {
      console.error('OpenAIService instance not initialized.');
      return false;
    }
    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.status === 200;
    } catch (error) {
      console.error('Error validating OpenAI API key:', error);
      return false;
    }
  }
}
