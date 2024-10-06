import { DEFAULT_CHATS_PATH, DEFAULT_SYSTEM_PROMPT } from "../utils";

export interface ChatSettings {
  chatsPath: string;
  systemPrompt: string;
  showChatButtonOnStatusBar: boolean;
  lastOpenedChatPath: string | null;
  attachmentsPath: string;
  markerApiKey: string;
  createAssetSubfolder: boolean;
  markerEndpoint: string;
  createFolder: boolean;
  apiEndpoint: "datalab" | "selfhosted";
  langs: string;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  chatsPath: DEFAULT_CHATS_PATH,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showChatButtonOnStatusBar: true,
  lastOpenedChatPath: null,
  attachmentsPath: "SystemSculpt/Chats/Attachments",
  markerApiKey: "",
  createAssetSubfolder: true,
  markerEndpoint: "localhost:8000",
  createFolder: true,
  apiEndpoint: "selfhosted",
  langs: "en",
};
