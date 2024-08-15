import { DEFAULT_CHATS_PATH, DEFAULT_SYSTEM_PROMPT } from '../utils';

export interface ChatSettings {
  chatsPath: string;
  systemPrompt: string;
  showChatButtonOnStatusBar: boolean;
  lastOpenedChatPath: string | null;
  attachmentsPath: string;
  markerApiKey: string;
  extractContent: 'all' | 'text' | 'images';
  createAssetSubfolder: boolean;
  writeMetadata: boolean;
  markerEndpoint: string;
  createFolder: boolean;
  deleteOriginal: boolean;
  movePDFtoFolder: boolean;
  apiEndpoint: 'datalab' | 'selfhosted';
  langs: string;
  forceOCR: boolean;
  paginate: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  chatsPath: DEFAULT_CHATS_PATH,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showChatButtonOnStatusBar: true,
  lastOpenedChatPath: null,
  attachmentsPath: 'SystemSculpt/Chats/Attachments',
  markerApiKey: '',
  extractContent: 'all',
  createAssetSubfolder: true,
  writeMetadata: true,
  markerEndpoint: 'localhost:8000',
  createFolder: true,
  deleteOriginal: false,
  movePDFtoFolder: false,
  apiEndpoint: 'selfhosted',
  langs: 'en',
  forceOCR: false,
  paginate: false,
};
