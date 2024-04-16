import { requestUrl } from 'obsidian';
import https from 'https';
import { Model } from './Model';

export class OpenAIService {
  private static instance: OpenAIService;
  private apiKey: string;
  private settings: { openAIApiKey: string };
  private isRequestInProgress: boolean = false;
  private currentAbortController: AbortController | null = null;

  private constructor(apiKey: string, settings: { openAIApiKey: string }) {
    this.apiKey = apiKey;
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
      this.instance.settings.openAIApiKey = newApiKey;
    } else {
      this.instance = new OpenAIService(newApiKey, { openAIApiKey: newApiKey });
    }
    return this.instance;
  }

  updateApiKey(newApiKey: string): void {
    this.apiKey = newApiKey;
    this.settings.openAIApiKey = newApiKey;
  }

  public isRequestCurrentlyInProgress(): boolean {
    return this.isRequestInProgress;
  }

  public setRequestInProgress(state: boolean): void {
    this.isRequestInProgress = state;
  }

  public abortCurrentRequest(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort(); // Send an abort signal
      this.currentAbortController = null; // Reset the controller
    }
  }

  async createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    temperature: number = 0.2,
    maxTokens: number = 100
  ): Promise<string> {
    if (this.isRequestInProgress) {
      console.warn(
        'An OpenAI request is already in progress. Aborting the ongoing request and skipping new request.'
      );
      this.abortCurrentRequest(); // Abort the current request
      return '';
    }

    this.setRequestInProgress(true); // Use the setter method
    const abortController = new AbortController(); // Create a new AbortController for this request
    this.currentAbortController = abortController; // Store the controller to possibly abort later

    console.log('System Prompt:', systemPrompt);
    console.log('User Message:', userMessage);
    console.log(
      `Model ID: ${modelId} | Temperature: ${temperature} | Max Tokens: ${maxTokens}`
    );

    const currentApiKey = this.settings.openAIApiKey;

    try {
      const response = await requestUrl({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });

      return response.json.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating chat completion:', error);
      throw new Error(
        'Failed to generate chat completion. Please check your OpenAI API key and try again.'
      );
    } finally {
      this.setRequestInProgress(false);
    }
  }

  async createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (this.isRequestInProgress) {
      console.warn(
        'An OpenAI request is already in progress. Aborting the ongoing request and skipping new request.'
      );
      this.abortCurrentRequest(); // Abort the current request
      return;
    }

    this.setRequestInProgress(true); // Use the setter method
    const abortController = new AbortController(); // Create a new AbortController for this request
    this.currentAbortController = abortController; // Store the controller to possibly abort later

    console.log('System Prompt:', systemPrompt);
    console.log('User Message:', userMessage);
    console.log(`Model ID: ${modelId} | Max Tokens: ${maxTokens}`);

    const currentApiKey = this.settings.openAIApiKey;

    const requestData = JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      stream: true,
      max_tokens: maxTokens,
    });

    return new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          port: 443,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${currentApiKey}`,
          },
        },
        res => {
          if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
              req.destroy();
              reject(new Error('Request aborted'));
            });
          }

          res.on('data', chunk => {
            if (!abortSignal || !abortSignal.aborted) {
              const chunkValue = new TextDecoder('utf-8').decode(chunk);
              callback(chunkValue);
            }
          });

          res.on('end', () => {
            if (!abortSignal || !abortSignal.aborted) {
              resolve();
            }
          });

          res.on('error', error => {
            if (error.message === 'aborted') {
              console.log('Request was aborted as expected.'); // Silently handle the abort error
            } else {
              console.error(
                'Error generating streaming chat completion:',
                error
              );
              reject(
                new Error(
                  'Failed to generate streaming chat completion. Please check your OpenAI API key and try again.'
                )
              );
            }
          });
        }
      );

      req.on('error', error => {
        if (error.message !== 'aborted') {
          // Only log if the error is not the expected abort error
          console.error('Error generating streaming chat completion:', error);
          reject(
            new Error(
              'Failed to generate streaming chat completion. Please check your OpenAI API key and try again.'
            )
          );
        }
      });

      req.write(requestData);
      req.end();
    }).finally(() => {
      this.setRequestInProgress(false);
    });
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

    try {
      const response = await requestUrl({
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${currentApiKey}`,
        },
      });

      return response.json.data
        .filter(
          model => model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4-turbo'
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

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!this.instance) {
      console.error('OpenAIService instance not initialized.');
      return false;
    }
    try {
      const response = await requestUrl({
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
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
