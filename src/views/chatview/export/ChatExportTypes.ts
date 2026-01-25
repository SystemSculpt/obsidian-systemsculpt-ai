import { ChatMessage } from '../../../types';
import type { ChatExportOptions } from '../../../types/chatExport';

export interface ChatExportModelInfo {
  id?: string;
  label?: string;
}

export interface ChatExportSystemPromptInfo {
  type: string;
  label?: string;
  content: string;
}

export interface ChatExportContextFile {
  path: string;
  content?: string;
}

export interface ChatExportSummary {
  totalMessages: number;
  assistantMessages: number;
  userMessages: number;
  toolMessages: number;
  toolCallCount: number;
  reasoningBlockCount: number;
  imageCount: number;
}

export interface ChatExportContext {
  title: string;
  chatId?: string;
  chatVersion?: number;
  exportedAt: Date;
  model?: ChatExportModelInfo;
  webSearchEnabled?: boolean;
  systemPrompt?: ChatExportSystemPromptInfo;
  contextFiles: ChatExportContextFile[];
  messages: ChatMessage[];
  summary: ChatExportSummary;
}

export interface ChatExportBuildResult {
  markdown: string;
}

export interface ChatExportResult extends ChatExportBuildResult {
  options: ChatExportOptions;
  context: ChatExportContext;
}

export interface ChatExportResolvedOptions {
  options: ChatExportOptions;
  context: ChatExportContext;
}

export interface ChatExportMetadataLine {
  label: string;
  value: string;
}
