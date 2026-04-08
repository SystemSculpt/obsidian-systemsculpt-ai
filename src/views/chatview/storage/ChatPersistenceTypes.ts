import type { ChatMessage } from "../../../types";

export type ChatBackend = "systemsculpt" | "legacy";

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
  model?: string;
  created: string;
  lastModified: string;
  title: string;
  version?: number;
  tags?: string[];
  context_files?: ChatContextFileMetadata[];
  // Legacy only. New chat saves do not persist client-side prompt selection metadata.
  systemMessage?: ChatSystemMessageMetadata;
  chatFontSize?: "small" | "medium" | "large";
  selectedPromptPath?: string;
  agentModeEnabled?: boolean;
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
  chatPath: string;
  lastModified: number;
  messageCount: number;
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
  defaultBackend?: ChatBackend;
}): ChatBackend {
  const fallbackBackend = options.defaultBackend ?? "systemsculpt";
  const explicitBackend = typeof options.explicitBackend === "string"
    ? options.explicitBackend.trim().toLowerCase()
    : "";

  if (explicitBackend === "legacy") {
    return "legacy";
  }

  if (explicitBackend === "pi" || explicitBackend === "systemsculpt") {
    return "systemsculpt";
  }

  const piState = normalizePiSessionState({
    sessionFile: options.piSessionFile,
    sessionId: options.piSessionId,
  });
  if (piState.sessionFile || piState.sessionId) {
    return "systemsculpt";
  }

  return fallbackBackend;
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

export function getLastMessagePiEntryId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = String(messages[index]?.pi_entry_id || "").trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}
