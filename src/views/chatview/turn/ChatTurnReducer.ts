import type { ChatTurnEffect, ChatTurnEvent, ChatTurnOutcome, ChatTurnState, ChatTurnTransition } from "./ChatTurnTypes";

export class ChatTurnIllegalTransitionError extends Error {
  readonly stateKind: ChatTurnState["kind"];
  readonly eventType: ChatTurnEvent["type"];

  constructor(stateKind: ChatTurnState["kind"], eventType: ChatTurnEvent["type"]) {
    super(`Illegal chat turn transition: ${stateKind} + ${eventType}`);
    this.name = "ChatTurnIllegalTransitionError";
    this.stateKind = stateKind;
    this.eventType = eventType;
  }
}

export const initialChatTurnState: ChatTurnState = Object.freeze({ kind: "idle" });

function result(state: ChatTurnState, ...effects: ChatTurnEffect[]): ChatTurnTransition {
  return { state, effects };
}

function finish(outcome: ChatTurnOutcome): ChatTurnTransition {
  return result({ kind: "terminal", outcome }, { type: "FINISH", outcome });
}

function illegal(state: ChatTurnState, event: ChatTurnEvent): never {
  throw new ChatTurnIllegalTransitionError(state.kind, event.type);
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function hasValidStateCounts(state: ChatTurnState): boolean {
  switch (state.kind) {
    case "streaming_initial":
    case "retrying_initial":
      return isCount(state.retryCount);
    case "committing_assistant":
      return isCount(state.pendingToolCount)
        && Number.isInteger(state.continuationIndex)
        && (state.phase === "initial" ? state.continuationIndex === 0 : state.continuationIndex >= 1);
    case "awaiting_approval":
    case "executing_tool":
      return Number.isInteger(state.remainingToolCount) && state.remainingToolCount > 0 && isCount(state.continuationIndex);
    case "checkpointing_tools":
      return isCount(state.continuationIndex);
    case "continuation_pending":
      return Number.isInteger(state.continuationIndex) && state.continuationIndex >= 1;
    case "streaming_continuation":
    case "retrying_continuation":
      return isCount(state.retryCount) && Number.isInteger(state.continuationIndex) && state.continuationIndex > 0;
    default:
      return true;
  }
}

function afterToolResult(remainingToolCount: number, continuationIndex: number): ChatTurnTransition {
  const nextCount = remainingToolCount - 1;
  if (nextCount > 0) {
    return result(
      { kind: "awaiting_approval", remainingToolCount: nextCount, continuationIndex },
      { type: "REQUEST_TOOL_APPROVAL", remainingToolCount: nextCount },
    );
  }
  return result(
    { kind: "checkpointing_tools", outcomeUnknown: false, continuationIndex },
    { type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: false },
  );
}

export function reduceChatTurn(state: ChatTurnState, event: ChatTurnEvent): ChatTurnTransition {
  if (state.kind === "terminal") return result(state);
  if (!hasValidStateCounts(state)) return illegal(state, event);

  if (event.type === "CANCEL_REQUESTED") {
    if (state.kind === "idle" || state.kind === "cancel_requested" || state.kind === "settling") return illegal(state, event);
    return result({ kind: "cancel_requested" }, { type: "REQUEST_ABORT" });
  }

  switch (state.kind) {
    case "idle":
      if (event.type === "TURN_STARTED") return result(
        { kind: "streaming_initial", retryCount: 0 },
        { type: "START_STREAM", phase: "initial", retryCount: 0, continuationIndex: 0 },
      );
      break;

    case "streaming_initial":
      if (event.type === "STREAM_DELTA") return result(state);
      if (event.type === "STREAM_FAILED") return result({ kind: "retrying_initial", retryCount: state.retryCount, failureKind: event.failureKind });
      if (event.type === "STREAM_FINISHED" && isCount(event.toolCount)) {
        return result(
          { kind: "committing_assistant", phase: "initial", pendingToolCount: event.toolCount, continuationIndex: 0 },
          { type: "PERSIST_ASSISTANT" },
        );
      }
      break;

    case "retrying_initial":
      if (event.type === "RETRY_ALLOWED" && isCount(event.retryCount) && event.retryCount > state.retryCount) {
        return result(
          { kind: "streaming_initial", retryCount: event.retryCount },
          { type: "START_STREAM", phase: "initial", retryCount: event.retryCount, continuationIndex: 0 },
        );
      }
      if (event.type === "RETRY_EXHAUSTED") return finish(state.failureKind === "empty" ? "retry_exhausted" : "transport_failed");
      break;

    case "committing_assistant":
      if (event.type === "PERSIST_FAILED" && event.operation === "assistant_commit") return finish("persistence_failed");
      if (event.type === "ASSISTANT_COMMITTED") {
        if (state.pendingToolCount === 0) return finish("completed");
        return result(
          { kind: "awaiting_approval", remainingToolCount: state.pendingToolCount, continuationIndex: state.continuationIndex },
          { type: "REQUEST_TOOL_APPROVAL", remainingToolCount: state.pendingToolCount },
        );
      }
      break;

    case "awaiting_approval":
      if (event.type === "TOOL_APPROVED") {
        return result(
          { kind: "executing_tool", remainingToolCount: state.remainingToolCount, continuationIndex: state.continuationIndex },
          { type: "EXECUTE_TOOL", remainingToolCount: state.remainingToolCount },
        );
      }
      if (event.type === "TOOL_DENIED") return afterToolResult(state.remainingToolCount, state.continuationIndex);
      break;

    case "executing_tool":
      if (event.type === "TOOL_COMPLETED" || event.type === "TOOL_FAILED") {
        return afterToolResult(state.remainingToolCount, state.continuationIndex);
      }
      if (event.type === "TOOL_CANCEL_UNKNOWN") {
        return result(
          { kind: "checkpointing_tools", outcomeUnknown: true, continuationIndex: state.continuationIndex },
          { type: "PERSIST_TOOL_CHECKPOINT", outcomeUnknown: true },
        );
      }
      break;

    case "checkpointing_tools":
      if (event.type === "PERSIST_FAILED" && event.operation === "tool_checkpoint") return finish("persistence_failed");
      if (event.type === "TOOL_CHECKPOINT_COMMITTED") {
        if (state.outcomeUnknown) return finish("tool_outcome_unknown");
        if (!event.continuationRequired) return finish("completed");
        const continuationIndex = state.continuationIndex + 1;
        return result(
          { kind: "continuation_pending", continuationIndex },
          { type: "START_CONTINUATION", continuationIndex },
        );
      }
      break;

    case "continuation_pending":
      if (event.type === "CONTINUATION_STARTED") {
        return result(
          { kind: "streaming_continuation", retryCount: 0, continuationIndex: state.continuationIndex },
          { type: "START_STREAM", phase: "continuation", retryCount: 0, continuationIndex: state.continuationIndex },
        );
      }
      break;

    case "streaming_continuation":
      if (event.type === "STREAM_DELTA") return result(state);
      if (event.type === "STREAM_FAILED") {
        return result({ kind: "retrying_continuation", retryCount: state.retryCount, continuationIndex: state.continuationIndex, failureKind: event.failureKind });
      }
      if (event.type === "STREAM_FINISHED" && isCount(event.toolCount)) {
        return result(
          { kind: "committing_assistant", phase: "continuation", pendingToolCount: event.toolCount, continuationIndex: state.continuationIndex },
          { type: "PERSIST_ASSISTANT" },
        );
      }
      break;

    case "retrying_continuation":
      if (event.type === "RETRY_ALLOWED" && isCount(event.retryCount) && event.retryCount > state.retryCount) {
        return result(
          { kind: "streaming_continuation", retryCount: event.retryCount, continuationIndex: state.continuationIndex },
          { type: "START_STREAM", phase: "continuation", retryCount: event.retryCount, continuationIndex: state.continuationIndex },
        );
      }
      if (event.type === "RETRY_EXHAUSTED") return finish(state.failureKind === "empty" ? "retry_exhausted" : "transport_failed");
      break;

    case "cancel_requested":
      if (event.type === "SETTLEMENT_STARTED") {
        return result(
          { kind: "settling", requestedOutcome: event.requestedOutcome },
          { type: "AWAIT_SETTLEMENT", requestedOutcome: event.requestedOutcome },
        );
      }
      break;

    case "settling":
      if (event.type === "SETTLED" && event.outcome === state.requestedOutcome) return finish(event.outcome);
      break;
  }

  return illegal(state, event);
}
