export type AIProvider = 'openai' | 'groq' | 'openRouter' | 'local';

export interface Model {
  id: string;
  name: string;
  description?: string;
  provider: AIProvider;
  contextLength?: number;
  favorite?: boolean;
  maxOutputTokens?: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

export interface AIServiceInterface {
  createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<string>;

  createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    maxOutputTokens: number,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  getModels(): Promise<Model[]>;

  updateSettings(settings: { temperature: number }): void;

  updateApiKey(apiKey: string): void;
}
