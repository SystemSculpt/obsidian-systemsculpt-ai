import type { ChatMessage } from "../../../types";

export type ChatBackend = "systemsculpt" | "legacy";

export function detectLoadedChatBackend(options: {
  explicitBackend?: unknown;
  piSessionFile?: unknown;
  piSessionId?: unknown;
  hasPiEntryId?: boolean;
  model?: unknown;
}): ChatBackend {
  const explicitBackend = typeof options.explicitBackend === "string"
    ? options.explicitBackend.trim().toLowerCase()
    : "";
  const hasPiSessionMetadata = [options.piSessionFile, options.piSessionId]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  const model = typeof options.model === "string" ? options.model.trim().toLowerCase() : "";
  const providerSeparator = model.indexOf("@@");
  const providerId = providerSeparator >= 0 ? model.slice(0, providerSeparator) : "";
  const hasHistoricalModelIdentity =
    model.startsWith("local-pi-") ||
    (providerSeparator >= 0 && providerId !== "systemsculpt");
  return explicitBackend === "pi" ||
    explicitBackend === "legacy" ||
    hasPiSessionMetadata ||
    options.hasPiEntryId === true ||
    hasHistoricalModelIdentity
    ? "legacy"
    : "systemsculpt";
}

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
  hideSystemMessages?: boolean;
  chatBackend?: ChatBackend;
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
