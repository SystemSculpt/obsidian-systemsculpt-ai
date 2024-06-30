export interface ChatSettings {
  chatsPath: string;
  systemPrompt: string;
  showChatButtonOnStatusBar: boolean;
  lastOpenedChatPath: string | null;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  chatsPath: 'SystemSculpt/Chats',
  systemPrompt:
    "You are the universe's most intelligent assistant. Your responses are succinct, problem solving, and concise. You don't limit yourself to something as unimportant as a simple AI; you're much more than that - an entity built on human history, ecompassing knowledge from all depths of what has been created thus far.",
  showChatButtonOnStatusBar: true,
  lastOpenedChatPath: null,
};
