import { requestUrl } from 'obsidian';
import https from 'https';
import http from 'http'; // Import the http module for local requests
import { Model } from './Model';

export class AIService {
  private static instance: AIService;
  private apiKey: string;
  private settings: {
    openAIApiKey: string;
    apiEndpoint: string;
    localEndpoint?: string;
  };
  private isRequestInProgress: boolean = false;
  private currentAbortController: AbortController | null = null;
  private openAIApiKeyValid: boolean = false;
  private localEndpointOnline: boolean = false;

  private constructor(
    apiKey: string,
    settings: {
      openAIApiKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
    }
  ) {
    this.apiKey = apiKey;
    this.settings = settings;
  }

  public static getInstance(
    apiKey: string,
    settings: {
      openAIApiKey: string;
      apiEndpoint: string;
      localEndpoint?: string;
    }
  ): AIService {
    if (!AIService.instance) {
      AIService.instance = new AIService(apiKey, settings);
    } else {
      // Update the existing instance with potentially new settings
      AIService.instance.apiKey = apiKey;
      AIService.instance.settings = settings;
    }
    return AIService.instance;
  }

  static updateApiKey(newApiKey: string): AIService {
    if (this.instance) {
      this.instance.apiKey = newApiKey;
      this.instance.settings.openAIApiKey = newApiKey;
      this.instance.openAIApiKeyValid = true; // Optionally set the key as valid here
    } else {
      this.instance = new AIService(newApiKey, {
        openAIApiKey: newApiKey,
        apiEndpoint: 'https://api.openai.com',
      });
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

    const model = await this.getModelById(modelId);
    let endpoint = `${this.settings.apiEndpoint}/v1/chat/completions`;
    let method = 'POST';
    let requestLib = https; // Default to https for API requests

    if (model?.isLocal) {
      endpoint = `${this.settings.localEndpoint}/v1/chat/completions`; // Adjusted for local model
      //@ts-ignore
      requestLib = http; // Switch to the http module for local requests
    }

    return new Promise<void>((resolve, reject) => {
      const req = requestLib.request(
        endpoint,
        {
          method: method,
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
                  'Failed to generate streaming chat completion. Please check your local endpoint and OpenAI API key and try again.'
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
              'Failed to generate streaming chat completion. Please check your local endpoint and OpenAI API key and try again.'
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

  async getModels(includeOpenAI: boolean = true): Promise<Model[]> {
    const currentApiKey = this.settings.openAIApiKey;
    const models: Model[] = [];

    // Fetch local models
    if (this.settings.localEndpoint && this.localEndpointOnline) {
      try {
        const localResponse = await fetch(
          `${this.settings.localEndpoint}/v1/models`
        );
        if (localResponse.ok) {
          const localModels = await localResponse.json();
          models.push(
            ...localModels.data.map((model: any) => ({
              id: model.id,
              name: model.id.split('/').pop(), // Extracting the part after the last '/'
              isLocal: true,
            }))
          );
        }
      } catch (localError) {
        console.log(
          'Failed to fetch local models. Please check your local endpoint settings.'
        ); // User-friendly error message
      }
    }

    // Fetch models from OpenAI API
    if (includeOpenAI && this.openAIApiKeyValid) {
      try {
        const response = await requestUrl({
          url: `${this.settings.apiEndpoint}/v1/models`,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${currentApiKey}`,
          },
        });
        models.push(
          ...response.json.data
            .filter(
              (model: any) =>
                model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4-turbo'
            )
            .map((model: any) => ({
              id: model.id,
              name: model.id.replace(/-turbo$/, ' turbo'), // Simplifying name display for turbo models
              isLocal: false,
            }))
        );
      } catch (error) {
        console.log(
          'Failed to fetch OpenAI models. Please check your OpenAI API key settings.'
        ); // User-friendly error message
      }
    }

    return models;
  }

  static async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey || !this.instance) {
      console.log(
        'OpenAIService instance not initialized or API key is empty.'
      );
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
      this.instance.openAIApiKeyValid = response.status === 200;
      return response.status === 200;
    } catch (error) {
      console.log('OpenAI API key is invalid.');
      this.instance.openAIApiKeyValid = false;
      return false;
    }
  }

  static async validateLocalEndpoint(endpoint: string): Promise<boolean> {
    if (!endpoint) {
      console.log('Local endpoint is empty.');
      return false;
    }
    try {
      const response = await fetch(endpoint, { method: 'HEAD' });
      this.instance.localEndpointOnline = response.ok;
      return response.ok; // Returns true if the status code is 2xx
    } catch (error) {
      console.log(
        'Local AI connection refused. Please check your local endpoint settings.'
      ); // User-friendly error message
      this.instance.localEndpointOnline = false;
      return false;
    }
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    const models = await this.getModels(true); // Assuming getModels fetches both local and API models
    return models.find(model => model.id === modelId);
  }

  public setLocalEndpointOnline(isOnline: boolean): void {
    this.localEndpointOnline = isOnline;
  }

  public getLocalEndpointOnline(): boolean {
    return this.localEndpointOnline;
  }

  public setOpenAIApiKeyValid(isValid: boolean): void {
    this.openAIApiKeyValid = isValid;
  }

  public getOpenAIApiKeyValid(): boolean {
    return this.openAIApiKeyValid;
  }

  // Method to dynamically update settings
  public static updateSettings(newSettings: {
    openAIApiKey?: string;
    apiEndpoint?: string;
    localEndpoint?: string;
  }): void {
    if (this.instance) {
      if (newSettings.openAIApiKey !== undefined) {
        this.instance.settings.openAIApiKey = newSettings.openAIApiKey;
      }
      if (newSettings.apiEndpoint !== undefined) {
        this.instance.settings.apiEndpoint = newSettings.apiEndpoint;
      }
      if (newSettings.localEndpoint !== undefined) {
        this.instance.settings.localEndpoint = newSettings.localEndpoint;
      }
    }
  }
}
