import type { ChatMessage } from "../../../types";

export type ChatBackend = "pi" | "legacy";

export interface ChatContextFileMetadata {
  path: string;
  type: "source" | "extraction";
}

export interface ChatSystemMessageMetadata {
  type: "general-use" | "concise" | "agent" | "custom";
  path?: string;
}

export interface ChatMetadata {
  id: string;
  model: string;
  created: string;
  lastModified: string;
  title: string;
  version?: number;
  tags?: string[];
  context_files?: ChatContextFileMetadata[];
  systemMessage?: ChatSystemMessageMetadata;
  chatFontSize?: "small" | "medium" | "large";
  chatBackend?: ChatBackend;
  piSessionFile?: string;
  piSessionId?: string;
  piLastEntryId?: string;
  piLastSyncedAt?: string;
}

export interface ParsedChatMarkdown {
  metadata: ChatMetadata;
  messages: ChatMessage[];
}

export interface ChatResumeDescriptor {
  chatId: string;
  title: string;
  modelId: string;
  chatPath: string;
  chatBackend: ChatBackend;
  lastModified: number;
  messageCount: number;
  pi?: {
    sessionFile?: string;
    sessionId?: string;
    lastEntryId?: string;
    lastSyncedAt?: string;
  };
}

export function resolveChatBackend(options: {
  explicitBackend?: unknown;
  piSessionFile?: unknown;
}): ChatBackend {
  if (options.explicitBackend === "pi" || options.explicitBackend === "legacy") {
    return options.explicitBackend;
  }

  return typeof options.piSessionFile === "string" && options.piSessionFile.trim().length > 0
    ? "pi"
    : "legacy";
}

export function getLastMessagePiEntryId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = String(messages[index]?.pi_entry_id || "").trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}
