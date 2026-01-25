export interface ChatExportOptions {
  includeMetadata: boolean;
  includeSystemPrompt: boolean;
  includeContextFiles: boolean;
  includeContextFileContents: boolean;
  includeConversation: boolean;
  includeUserMessages: boolean;
  includeAssistantMessages: boolean;
  includeToolMessages: boolean;
  includeReasoning: boolean;
  includeToolCalls: boolean;
  includeToolCallArguments: boolean;
  includeToolCallResults: boolean;
  includeImages: boolean;
}

const DEFAULT_CHAT_EXPORT_OPTIONS: ChatExportOptions = {
  includeMetadata: true,
  includeSystemPrompt: true,
  includeContextFiles: true,
  includeContextFileContents: true,
  includeConversation: true,
  includeUserMessages: true,
  includeAssistantMessages: true,
  includeToolMessages: false,
  includeReasoning: true,
  includeToolCalls: true,
  includeToolCallArguments: true,
  includeToolCallResults: true,
  includeImages: true,
};

export function createDefaultChatExportOptions(): ChatExportOptions {
  return { ...DEFAULT_CHAT_EXPORT_OPTIONS };
}

export function mergeChatExportOptions(
  base: ChatExportOptions,
  overrides?: Partial<ChatExportOptions>
): ChatExportOptions {
  if (!overrides) {
    return { ...base };
  }
  return {
    ...base,
    ...overrides,
  };
}

export function normalizeChatExportOptions(
  overrides?: Partial<ChatExportOptions>
): ChatExportOptions {
  return mergeChatExportOptions(createDefaultChatExportOptions(), overrides);
}

export interface ChatExportPreferences {
  options: Partial<ChatExportOptions>;
  lastFolder?: string;
  openAfterExport?: boolean;
  lastFileName?: string;
}
