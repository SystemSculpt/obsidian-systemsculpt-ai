import type { ChatMessage } from "../../../types";
import type { ManagedChatSessionBudgetState } from "../../../services/managed/ManagedTypes";

export type ChatApprovalMode = "ask" | "full-access";

export type ManagedChatSessionBinding = Readonly<{
  id: string;
  revision: number;
  boundChatId: string;
  checkpointMessageId: string;
  toolsetFingerprint: string;
  budget: ManagedChatSessionBudgetState;
}>;

const MANAGED_CHAT_SESSION_ID = /^mchat_[0-9a-f]{32}$/;
const MANAGED_CHAT_TOOLSET_FINGERPRINT = /^\d+:[0-9a-f]+:[0-9a-f]+$/;

function parseManagedChatSessionBudget(value: unknown): ManagedChatSessionBudgetState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = ["messageCount", "imageCount", "attachmentBytes", "storedJsonBytes"];
  if (
    Object.keys(candidate).length !== keys.length
    || !keys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key))
  ) {
    return undefined;
  }
  if (!keys.every((key) => Number.isSafeInteger(candidate[key]) && (candidate[key] as number) >= 0)) {
    return undefined;
  }
  return Object.freeze({
    messageCount: candidate.messageCount as number,
    imageCount: candidate.imageCount as number,
    attachmentBytes: candidate.attachmentBytes as number,
    storedJsonBytes: candidate.storedJsonBytes as number,
  });
}

export function parseManagedChatSessionBinding(
  value: unknown,
  expectedChatId?: string,
): ManagedChatSessionBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Object.keys(candidate).every((key) => [
    "id", "revision", "boundChatId", "checkpointMessageId", "toolsetFingerprint", "budget",
  ].includes(key))) return undefined;
  if (typeof candidate.id !== "string" || !MANAGED_CHAT_SESSION_ID.test(candidate.id)) return undefined;
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1) return undefined;
  if (typeof candidate.boundChatId !== "string" || !candidate.boundChatId.trim()) return undefined;
  if (expectedChatId && candidate.boundChatId !== expectedChatId) return undefined;
  if (typeof candidate.checkpointMessageId !== "string" || !candidate.checkpointMessageId.trim()) return undefined;
  if (
    typeof candidate.toolsetFingerprint !== "string"
    || !MANAGED_CHAT_TOOLSET_FINGERPRINT.test(candidate.toolsetFingerprint)
  ) return undefined;
  const budget = parseManagedChatSessionBudget(candidate.budget);
  if (!budget) return undefined;
  return Object.freeze({
    id: candidate.id,
    revision: candidate.revision as number,
    boundChatId: candidate.boundChatId,
    checkpointMessageId: candidate.checkpointMessageId,
    toolsetFingerprint: candidate.toolsetFingerprint,
    budget,
  });
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
  managedSession?: ManagedChatSessionBinding;
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
