export interface Model {
  id: string;
  name: string;
  description?: string;
  isLocal?: boolean;
  provider: 'openai' | 'groq' | 'openRouter' | 'local';
}
