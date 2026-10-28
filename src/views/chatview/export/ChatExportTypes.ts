import { ChatMessage } from '../../../types';
import type { ChatExportOptions } from '../../../types/chatExport';

interface ChatExportContextFile {
  path: string;
  content?: string;
}

export interface ChatExportSummary {
  totalMessages: number;
  assistantMessages: number;
  userMessages: number;
  toolCallCount: number;
  reasoningBlockCount: number;
  imageCount: number;
}

export interface ChatExportContext {
  title: string;
  chatId?: string;
  chatVersion?: number;
  exportedAt: Date;
  contextFiles: ChatExportContextFile[];
  messages: readonly ChatMessage[];
  summary: ChatExportSummary;
}

export interface ChatExportResult {
  markdown: string;
  options: ChatExportOptions;
  context: ChatExportContext;
}
