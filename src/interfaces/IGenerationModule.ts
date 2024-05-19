import { ChatMessage } from '../modules/chat/ChatMessage';

export interface IGenerationModule {
  abortController: AbortController | null;
  isGenerationCompleted: boolean;
  stopGeneration(): void;
  addMessage?: (message: ChatMessage) => void;
}
