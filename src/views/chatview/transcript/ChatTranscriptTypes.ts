import type { ChatMessage } from "../../../types";
import type { ChatPersistenceOperation } from "../persistence/ChatPersistenceError";

export type ChatTranscriptSnapshot = Readonly<{
  chatId: string;
  version: number;
  messages: readonly Readonly<ChatMessage>[];
  readOnly?: true;
}>;

export type AcceptedUserTranscriptInput =
  | Readonly<{ kind: "append"; message: ChatMessage }>
  | Readonly<{ kind: "resend"; message: ChatMessage; targetMessageId: string; expectedIndex: number; expectedVersion: number }>;

export type AcceptedUserTranscriptResult = Readonly<{
  snapshot: ChatTranscriptSnapshot;
  message: Readonly<ChatMessage>;
}>;

export type ChatTranscriptCandidate = Readonly<{
  operation: Exclude<ChatPersistenceOperation, "flush" | "resend_branch" | "resend_user_commit">;
  baseRevision: number;
  messages: readonly Readonly<ChatMessage>[];
}>;

export type ChatTranscriptBranch = Readonly<{
  operation: "resend_branch";
  baseRevision: number;
  messages: readonly Readonly<ChatMessage>[];
}>;

export type StoredChatTranscript = Readonly<{
  chatId: string;
  version: number;
  messages: readonly ChatMessage[];
  readOnly?: boolean;
}>;
