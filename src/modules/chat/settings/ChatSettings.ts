import { DEFAULT_CHATS_PATH, DEFAULT_SYSTEM_PROMPT } from '../utils';

export interface ChatSettings {
  chatsPath: string;
  systemPrompt: string;
  showChatButtonOnStatusBar: boolean;
  lastOpenedChatPath: string | null;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  chatsPath: DEFAULT_CHATS_PATH,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showChatButtonOnStatusBar: true,
  lastOpenedChatPath: null,
};
