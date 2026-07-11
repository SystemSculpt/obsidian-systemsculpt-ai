export type ChatTurnOutcome =
  | "completed"
  | "cancelled"
  | "transport_failed"
  | "retry_exhausted"
  | "persistence_failed"
  | "tool_outcome_unknown";

export type ChatTurnState =
  | { readonly kind: "idle" }
  | { readonly kind: "committing_user" }
  | { readonly kind: "streaming_initial"; readonly retryCount: number }
  | { readonly kind: "retrying_initial"; readonly retryCount: number; readonly failureKind: "empty" | "malformed" | "transport" }
  | { readonly kind: "committing_assistant"; readonly phase: "initial" | "continuation"; readonly pendingToolCount: number; readonly continuationIndex: number }
  | { readonly kind: "awaiting_approval"; readonly remainingToolCount: number; readonly continuationIndex: number }
  | { readonly kind: "executing_tool"; readonly remainingToolCount: number; readonly continuationIndex: number }
  | { readonly kind: "checkpointing_tools"; readonly outcomeUnknown: boolean; readonly continuationIndex: number }
  | { readonly kind: "continuation_pending"; readonly continuationIndex: number }
  | { readonly kind: "streaming_continuation"; readonly retryCount: number; readonly continuationIndex: number }
  | { readonly kind: "retrying_continuation"; readonly retryCount: number; readonly continuationIndex: number; readonly failureKind: "empty" | "malformed" | "transport" }
  | { readonly kind: "cancel_requested" }
  | { readonly kind: "settling"; readonly requestedOutcome: "cancelled" | "tool_outcome_unknown" }
  | { readonly kind: "terminal"; readonly outcome: ChatTurnOutcome };

export type ChatTurnEvent =
  | { readonly type: "TURN_STARTED" }
  | { readonly type: "USER_COMMITTED" }
  | { readonly type: "PERSIST_FAILED"; readonly operation: "user_commit" | "assistant_commit" | "tool_checkpoint" }
  | { readonly type: "STREAM_DELTA" }
  | { readonly type: "STREAM_FINISHED"; readonly toolCount: number }
  | { readonly type: "STREAM_FAILED"; readonly failureKind: "empty" | "malformed" | "transport" }
  | { readonly type: "RETRY_ALLOWED"; readonly retryCount: number }
  | { readonly type: "RETRY_EXHAUSTED" }
  | { readonly type: "ASSISTANT_COMMITTED" }
  | { readonly type: "TOOL_APPROVED" }
  | { readonly type: "TOOL_DENIED" }
  | { readonly type: "TOOL_COMPLETED" }
  | { readonly type: "TOOL_FAILED" }
  | { readonly type: "TOOL_CANCEL_UNKNOWN" }
  | { readonly type: "TOOL_CHECKPOINT_COMMITTED"; readonly continuationRequired: boolean }
  | { readonly type: "CONTINUATION_STARTED" }
  | { readonly type: "CANCEL_REQUESTED" }
  | { readonly type: "SETTLEMENT_STARTED"; readonly requestedOutcome: "cancelled" | "tool_outcome_unknown" }
  | { readonly type: "SETTLED"; readonly outcome: "cancelled" | "tool_outcome_unknown" };

export type ChatTurnEffect =
  | { readonly type: "PERSIST_USER" }
  | { readonly type: "START_STREAM"; readonly phase: "initial" | "continuation"; readonly retryCount: number; readonly continuationIndex: number }
  | { readonly type: "PERSIST_ASSISTANT" }
  | { readonly type: "REQUEST_TOOL_APPROVAL"; readonly remainingToolCount: number }
  | { readonly type: "EXECUTE_TOOL"; readonly remainingToolCount: number }
  | { readonly type: "PERSIST_TOOL_CHECKPOINT"; readonly outcomeUnknown: boolean }
  | { readonly type: "START_CONTINUATION"; readonly continuationIndex: number }
  | { readonly type: "REQUEST_ABORT" }
  | { readonly type: "AWAIT_SETTLEMENT"; readonly requestedOutcome: "cancelled" | "tool_outcome_unknown" }
  | { readonly type: "FINISH"; readonly outcome: ChatTurnOutcome };

export type ChatTurnTransition = {
  readonly state: ChatTurnState;
  readonly effects: readonly ChatTurnEffect[];
};
