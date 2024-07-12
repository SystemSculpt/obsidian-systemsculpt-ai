export type AIProvider = 'openai' | 'groq' | 'openRouter' | 'local';

export interface Model {
  id: string;
  name: string;
  description?: string;
  isLocal?: boolean;
  provider: AIProvider;
  contextLength?: number;
  favorite?: boolean;
}
