export type ChatPersistenceOperation =
  | "user_commit"
  | "assistant_commit"
  | "tool_checkpoint"
  | "history_delete"
  | "pi_sync"
  | "pi_fork"
  | "resend_branch"
  | "flush";

export class ChatPersistenceError extends Error {
  public readonly code = "chat_persistence_failed" as const;
  public readonly operation: ChatPersistenceOperation;
  public readonly chatId: string;
  public readonly cause: unknown;

  constructor(options: {
    operation: ChatPersistenceOperation;
    chatId: string;
    cause: unknown;
  }) {
    const causeMessage = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`Chat persistence failed during ${options.operation}: ${causeMessage}`);
    this.name = "ChatPersistenceError";
    this.operation = options.operation;
    this.chatId = options.chatId;
    this.cause = options.cause;
  }
}
