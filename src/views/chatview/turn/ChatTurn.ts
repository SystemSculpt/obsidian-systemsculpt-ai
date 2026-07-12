import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type { StreamCompletionState, StreamTurnResult } from "../controllers/StreamingController";
import { initialChatTurnState, reduceChatTurn } from "./ChatTurnReducer";
import type { ChatTurnEffect, ChatTurnEvent, ChatTurnOutcome, ChatTurnState } from "./ChatTurnTypes";
import type { ChatTurnEffects } from "./ChatTurnEffects";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";

const MAX_EMPTY_INITIAL_RETRIES = 2;
const MAX_EMPTY_CONTINUATION_RETRIES = 3;
const MAX_TOOL_CONTINUATION_ROUNDS = 8;

function isEmptyCompletion(state: StreamCompletionState): boolean {
  return state === "empty" || state === "no_events" || state === "reasoning_only" || state === "empty_after_seed";
}

function isPendingTool(toolCall: ToolCall): boolean {
  return toolCall.state !== "completed" && toolCall.state !== "failed";
}

function cancellationCode(toolCall: ToolCall): string | undefined {
  return toolCall.result?.error?.code;
}

export class ChatTurnTerminalFence {
  private terminal = false;
  private winningOutcome: ChatTurnOutcome | undefined;

  constructor(
    private readonly operation: import("../../../services/managed/ManagedTypes").AcceptedChatOperation,
    private readonly emit: (outcome: ChatTurnOutcome) => void = () => undefined,
  ) {}

  public isOpen(operation: import("../../../services/managed/ManagedTypes").AcceptedChatOperation = this.operation): boolean {
    return !this.terminal && operation === this.operation;
  }

  public get outcome(): ChatTurnOutcome | undefined { return this.winningOutcome; }

  public claimTerminal(outcome: ChatTurnOutcome): boolean {
    if (this.terminal) return false;
    this.terminal = true;
    this.winningOutcome = outcome;
    this.emit(outcome);
    return true;
  }
}

export function durableContinuationIndex(
  operation: import("../../../services/managed/ManagedTypes").AcceptedChatOperation,
  snapshot: ChatTranscriptSnapshot,
  justCommittedMessageId: string,
): number {
  const turnStart = snapshot.messages.findIndex((message) =>
    message.role === "user" && message.message_id === operation.durableTurnId,
  );
  if (turnStart < 0) throw new Error("Durable continuation snapshot does not contain the accepted turn.");
  const afterTurnStart = snapshot.messages.slice(turnStart + 1);
  const nextUserOffset = afterTurnStart.findIndex((message) => message.role === "user");
  const acceptedTurnMessages = nextUserOffset < 0 ? afterTurnStart : afterTurnStart.slice(0, nextUserOffset);
  const checkpoints = acceptedTurnMessages.filter((message) =>
    message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
  );
  const committedIndex = checkpoints.findIndex((message) => message.message_id === justCommittedMessageId);
  if (committedIndex < 0) throw new Error("Durable continuation snapshot does not contain the committed checkpoint.");
  return committedIndex;
}

/** Owns the accepted turn from its durable user commit through terminal settlement. */
export class ChatTurn {
  private state: ChatTurnState = initialChatTurnState;
  private running: Promise<void> | null = null;
  private userMessage!: ChatMessage;
  private currentStream: StreamTurnResult | null = null;
  private previousStream: StreamTurnResult | null = null;
  private pendingTools: ToolCall[] = [];
  private nextToolIndex = 0;
  private checkpointOutcomeUnknown = false;
  private cancelledBeforeStart = false;
  private postCheckpointSnapshot: ChatTranscriptSnapshot | undefined;
  private durableContinuationOrdinal: number | undefined;
  private readonly terminalFence: ChatTurnTerminalFence;

  constructor(private readonly effects: ChatTurnEffects) {
    this.terminalFence = new ChatTurnTerminalFence(
      effects.acceptedOperation,
      (outcome) => effects.onTerminal?.(outcome, effects.acceptedOperation),
    );
  }

  public get signal(): AbortSignal { return this.effects.signal; }
  public get acceptedOperation() { return this.effects.acceptedOperation; }
  public get outcome(): ChatTurnOutcome | undefined {
    return this.state.kind === "terminal" ? this.state.outcome : undefined;
  }

  public run(userMessage: ChatMessage): Promise<void> {
    if (this.running) return this.running;
    if (this.state.kind === "terminal") return Promise.resolve();
    this.userMessage = userMessage;
    this.running = this.dispatch({ type: "TURN_STARTED" });
    return this.running;
  }

  private async dispatch(event: ChatTurnEvent): Promise<void> {
    const transition = reduceChatTurn(this.state, event);
    this.state = transition.state;
    for (const effect of transition.effects) {
      await this.executeEffect(effect);
    }
  }

  private async requestSettlement(outcome: "cancelled" | "tool_outcome_unknown" = "cancelled"): Promise<void> {
    if (this.state.kind === "terminal") return;
    await this.dispatch({ type: "CANCEL_REQUESTED" });
    await this.dispatch({ type: "SETTLEMENT_STARTED", requestedOutcome: outcome });
    await this.dispatch({ type: "SETTLED", outcome });
  }

  private async executeEffect(effect: ChatTurnEffect): Promise<void> {
    switch (effect.type) {
      case "START_STREAM":
        await this.startStream(effect.phase, effect.retryCount, effect.continuationIndex);
        return;

      case "PERSIST_ASSISTANT":
        if (!this.currentStream) throw new Error("Chat turn assistant persistence has no stream result.");
        if (this.signal.aborted) { await this.requestSettlement(); return; }
        if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
        try {
          await this.effects.commitAssistant(this.currentStream.message, this.terminalFence);
        } catch (error) {
          await this.dispatch({ type: "PERSIST_FAILED", operation: "assistant_commit" });
          throw error;
        }
        if (this.signal.aborted) { await this.requestSettlement(); return; }
        if (this.terminalFence.isOpen(this.acceptedOperation)) await this.dispatch({ type: "ASSISTANT_COMMITTED" });
        return;

      case "REQUEST_TOOL_APPROVAL":
        await this.requestApproval();
        return;

      case "EXECUTE_TOOL":
        await this.executeCurrentTool();
        return;

      case "PERSIST_TOOL_CHECKPOINT":
        await this.persistToolCheckpoint(effect.outcomeUnknown);
        return;

      case "START_CONTINUATION":
        if (this.signal.aborted) { await this.requestSettlement(); return; }
        if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
        await this.dispatch({ type: "CONTINUATION_STARTED" });
        return;

      case "REQUEST_ABORT":
      case "AWAIT_SETTLEMENT":
        return;

      case "FINISH":
        this.terminalFence.claimTerminal(effect.outcome);
        return;
    }
  }

  private async startStream(phase: "initial" | "continuation", retryCount: number, continuationIndex: number): Promise<void> {
    if (this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    if (phase === "continuation" && continuationIndex >= MAX_TOOL_CONTINUATION_ROUNDS) {
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "transport" });
      await this.dispatch({ type: "RETRY_EXHAUSTED" });
      if (this.effects.onMaxContinuationDepth) this.effects.onMaxContinuationDepth(MAX_TOOL_CONTINUATION_ROUNDS);
      throw new Error("The hosted agent exceeded the maximum tool continuation depth.");
    }

    let streamed: StreamTurnResult;
    try {
      streamed = phase === "initial"
        ? await this.effects.runInitialStream(this.acceptedOperation, retryCount, this.signal, this.terminalFence)
        : await this.effects.runContinuationStream(
            this.acceptedOperation,
            retryCount,
            this.signal,
            this.previousStream!,
            this.postCheckpointSnapshot,
            this.durableContinuationOrdinal,
            this.terminalFence,
          );
    } catch (error) {
      if (this.terminalFence.outcome === "transport_failed") {
        await this.dispatch({ type: "STREAM_FAILED", failureKind: "transport" });
        await this.dispatch({ type: "RETRY_EXHAUSTED" });
        throw error;
      }
      if (this.signal.aborted) {
        await this.requestSettlement();
        return;
      }
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "transport" });
      await this.dispatch({ type: "RETRY_EXHAUSTED" });
      throw error;
    }

    if (streamed.completionState === "aborted" || this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    if (isEmptyCompletion(streamed.completionState)) {
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "empty" });
      const limit = phase === "initial" ? MAX_EMPTY_INITIAL_RETRIES : MAX_EMPTY_CONTINUATION_RETRIES;
      if (this.effects.retryEmptyStream === false || retryCount >= limit) {
        await this.dispatch({ type: "RETRY_EXHAUSTED" });
        if (phase === "initial" && this.effects.onInitialRetryExhausted) this.effects.onInitialRetryExhausted(streamed);
        if (phase === "continuation" && this.effects.onContinuationRetryExhausted) {
          this.effects.onContinuationRetryExhausted(streamed, retryCount, this.previousStream!);
        }
        throw new Error(phase === "initial"
          ? "The hosted agent returned an empty response."
          : "The hosted agent returned an empty continuation after tool execution.");
      }
      await this.dispatch({ type: "RETRY_ALLOWED", retryCount: retryCount + 1 });
      return;
    }

    this.currentStream = streamed;
    this.pendingTools = (streamed.message.tool_calls || []).filter(isPendingTool);
    this.nextToolIndex = 0;
    let continuationRequired: boolean;
    try {
      continuationRequired = this.effects.shouldContinueTools(streamed) && this.pendingTools.length > 0;
    } catch (error) {
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "malformed" });
      await this.dispatch({ type: "RETRY_EXHAUSTED" });
      throw error;
    }
    if (this.signal.aborted) { await this.requestSettlement(); return; }
    if (this.terminalFence.isOpen(this.acceptedOperation)) {
      await this.dispatch({ type: "STREAM_FINISHED", toolCount: continuationRequired ? this.pendingTools.length : 0 });
    }
  }

  private async requestApproval(): Promise<void> {
    const toolCall = this.pendingTools[this.nextToolIndex];
    if (!toolCall) throw new Error("Chat turn requested approval without a pending tool.");
    if (this.cancelledBeforeStart || this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    const approved = await this.effects.requestToolApproval(toolCall, this.signal, this.terminalFence);
    if (this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    if (!approved) {
      this.nextToolIndex += 1;
      await this.dispatch({ type: "TOOL_DENIED" });
      return;
    }
    await this.dispatch({ type: "TOOL_APPROVED" });
  }

  private async executeCurrentTool(): Promise<void> {
    const toolCall = this.pendingTools[this.nextToolIndex];
    if (!toolCall) throw new Error("Chat turn requested execution without a pending tool.");
    if (this.signal.aborted) { await this.requestSettlement(); return; }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    await this.effects.executeTool(toolCall, this.signal, this.terminalFence);
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    const code = cancellationCode(toolCall);
    if (code === "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN") {
      this.checkpointOutcomeUnknown = true;
      await this.dispatch({ type: "TOOL_CANCEL_UNKNOWN" });
      return;
    }
    if (this.signal.aborted) { await this.requestSettlement(); return; }
    if (code === "TOOL_CANCELLED_BEFORE_START") this.cancelledBeforeStart = true;
    this.nextToolIndex += 1;
    await this.dispatch({ type: toolCall.state === "completed" ? "TOOL_COMPLETED" : "TOOL_FAILED" });
  }

  private async persistToolCheckpoint(outcomeUnknown: boolean): Promise<void> {
    if (!this.currentStream) throw new Error("Chat turn tool checkpoint has no stream result.");
    if (this.signal.aborted && !(outcomeUnknown || this.checkpointOutcomeUnknown)) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    try {
      await this.effects.commitToolCheckpoint(
        this.currentStream.message,
        this.terminalFence,
        outcomeUnknown || this.checkpointOutcomeUnknown,
      );
    } catch (error) {
      await this.dispatch({ type: "PERSIST_FAILED", operation: "tool_checkpoint" });
      throw error;
    }
    const outcomeIsUnknown = outcomeUnknown || this.checkpointOutcomeUnknown;
    if (outcomeIsUnknown) {
      if (this.terminalFence.isOpen(this.acceptedOperation)) {
        await this.effects.renderToolCheckpoint(this.currentStream.message, this.terminalFence);
        await this.dispatch({ type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: false });
      }
      return;
    }
    if (this.signal.aborted) { await this.requestSettlement(); return; }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    if (this.effects.readDurableSnapshot) {
      this.postCheckpointSnapshot = await this.effects.readDurableSnapshot();
      if (this.signal.aborted) { await this.requestSettlement(); return; }
      if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
      this.durableContinuationOrdinal = durableContinuationIndex(
        this.acceptedOperation,
        this.postCheckpointSnapshot,
        String(this.currentStream.message.message_id || ""),
      );
    }
    if (this.signal.aborted) { await this.requestSettlement(); return; }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    await this.effects.renderToolCheckpoint(this.currentStream.message, this.terminalFence);

    if (this.cancelledBeforeStart || this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (!this.terminalFence.isOpen(this.acceptedOperation)) return;
    this.previousStream = this.currentStream;
    await this.dispatch({ type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: true });
  }
}
