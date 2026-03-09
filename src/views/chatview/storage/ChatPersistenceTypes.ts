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

export interface PiSessionState {
  sessionFile?: string;
  sessionId?: string;
  lastEntryId?: string;
  lastSyncedAt?: string;
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
  pi?: PiSessionState;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizePiSessionState(options?: {
  sessionFile?: unknown;
  sessionId?: unknown;
  lastEntryId?: unknown;
  lastSyncedAt?: unknown;
}): PiSessionState {
  return {
    sessionFile: normalizeOptionalString(options?.sessionFile),
    sessionId: normalizeOptionalString(options?.sessionId),
    lastEntryId: normalizeOptionalString(options?.lastEntryId),
    lastSyncedAt: normalizeOptionalString(options?.lastSyncedAt),
  };
}

export function resolveChatBackend(options: {
  explicitBackend?: unknown;
  piSessionFile?: unknown;
  piSessionId?: unknown;
}): ChatBackend {
  if (options.explicitBackend === "pi" || options.explicitBackend === "legacy") {
    return options.explicitBackend;
  }

  const piState = normalizePiSessionState({
    sessionFile: options.piSessionFile,
    sessionId: options.piSessionId,
  });
  return piState.sessionFile || piState.sessionId ? "pi" : "legacy";
}

export function buildChatLeafState(input: {
  chatId: string;
  title: string;
  modelId: string;
  chatPath: string;
  chatBackend: ChatBackend;
  pi?: PiSessionState;
}): Record<string, unknown> {
  const piState = normalizePiSessionState({
    sessionFile: input.pi?.sessionFile,
    sessionId: input.pi?.sessionId,
    lastEntryId: input.pi?.lastEntryId,
    lastSyncedAt: input.pi?.lastSyncedAt,
  });

  return {
    chatId: input.chatId,
    chatTitle: input.title,
    selectedModelId: input.modelId,
    chatBackend: input.chatBackend,
    piSessionFile: piState.sessionFile,
    piSessionId: piState.sessionId,
    piLastEntryId: piState.lastEntryId,
    piLastSyncedAt: piState.lastSyncedAt,
    file: input.chatPath,
  };
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
