import type { ChatMessage } from "../../../types";

export type ChatApprovalMode = "ask" | "full-access";

export function parseAgentConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^conversation_[a-f0-9]{32}$/.test(value) ? value : undefined;
}

export interface ChatContextFileMetadata {
  path: string;
  type: "source" | "extraction";
}

export interface ChatMetadata {
  id: string;
  created: string;
  lastModified: string;
  title: string;
  version?: number;
  tags?: string[];
  context_files?: ChatContextFileMetadata[];
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  /**
   * A routing pointer only. The server owns conversation state and validates
   * this identifier on every bootstrap.
   */
  agentConversationId?: string;
}

export interface ParsedChatMarkdown {
  metadata: ChatMetadata;
  messages: ChatMessage[];
}

export interface ChatResumeDescriptor {
  chatId: string;
  title: string;
  chatPath: string;
  lastModified: number;
  messageCount: number;
}

export function buildChatLeafState(input: {
  chatId: string;
  title: string;
  chatPath: string;
}): Record<string, unknown> {
  return {
    chatId: input.chatId,
    chatTitle: input.title,
    file: input.chatPath,
  };
}
