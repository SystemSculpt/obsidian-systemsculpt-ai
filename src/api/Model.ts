export type AIProvider =
  | "openai"
  | "groq"
  | "openRouter"
  | "local"
  | "anthropic";

export interface Model {
  id: string;
  name: string;
  description?: string;
  provider: AIProvider;
  contextLength?: number;
  favorite?: boolean;
  supportsVision?: boolean;
}

export interface AIServiceInterface {
  createChatCompletion(
    systemPrompt: string,
    userMessage: string,
    modelId: string
  ): Promise<string>;

  createStreamingChatCompletionWithCallback(
    systemPrompt: string,
    userMessage: string,
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  createStreamingConversationWithCallback(
    systemPrompt: string,
    messages: { role: string; content: string }[],
    modelId: string,
    callback: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<void>;

  getModels(): Promise<Model[]>;

  updateSettings(settings: { temperature: number }): void;

  updateApiKey(apiKey: string): void;
}
