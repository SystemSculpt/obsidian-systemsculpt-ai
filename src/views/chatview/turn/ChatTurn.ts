import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type { StreamCompletionState, StreamTurnResult } from "../controllers/StreamingController";
import { initialChatTurnState, reduceChatTurn } from "./ChatTurnReducer";
import type { ChatTurnEffect, ChatTurnEvent, ChatTurnOutcome, ChatTurnState } from "./ChatTurnTypes";
import type { ChatTurnEffects } from "./ChatTurnEffects";

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

  constructor(private readonly effects: ChatTurnEffects) {}

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
        try {
          await this.effects.commitAssistant(this.currentStream.message);
        } catch (error) {
          await this.dispatch({ type: "PERSIST_FAILED", operation: "assistant_commit" });
          throw error;
        }
        await this.dispatch({ type: "ASSISTANT_COMMITTED" });
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
        await this.dispatch({ type: "CONTINUATION_STARTED" });
        return;

      case "REQUEST_ABORT":
      case "AWAIT_SETTLEMENT":
      case "FINISH":
        return;
    }
  }

  private async startStream(phase: "initial" | "continuation", retryCount: number, continuationIndex: number): Promise<void> {
    if (this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    if (phase === "continuation" && continuationIndex >= MAX_TOOL_CONTINUATION_ROUNDS) {
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "transport" });
      await this.dispatch({ type: "RETRY_EXHAUSTED" });
      if (this.effects.onMaxContinuationDepth) this.effects.onMaxContinuationDepth(MAX_TOOL_CONTINUATION_ROUNDS);
      throw new Error("The hosted agent exceeded the maximum tool continuation depth.");
    }

    let streamed: StreamTurnResult;
    try {
      streamed = phase === "initial"
        ? await this.effects.runInitialStream(this.acceptedOperation, retryCount, this.signal)
        : await this.effects.runContinuationStream(this.acceptedOperation, retryCount, this.signal, this.previousStream!);
    } catch (error) {
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
    if (isEmptyCompletion(streamed.completionState)) {
      await this.dispatch({ type: "STREAM_FAILED", failureKind: "empty" });
      const limit = phase === "initial" ? MAX_EMPTY_INITIAL_RETRIES : MAX_EMPTY_CONTINUATION_RETRIES;
      if (retryCount >= limit) {
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
    await this.dispatch({ type: "STREAM_FINISHED", toolCount: continuationRequired ? this.pendingTools.length : 0 });
  }

  private async requestApproval(): Promise<void> {
    const toolCall = this.pendingTools[this.nextToolIndex];
    if (!toolCall) throw new Error("Chat turn requested approval without a pending tool.");
    if (this.cancelledBeforeStart) {
      await this.effects.executeTool(toolCall, this.signal);
      this.nextToolIndex += 1;
      await this.dispatch({ type: "TOOL_DENIED" });
      return;
    }
    if (this.signal.aborted) {
      await this.effects.executeTool(toolCall, this.signal);
      this.cancelledBeforeStart = true;
      this.nextToolIndex += 1;
      await this.dispatch({ type: "TOOL_DENIED" });
      return;
    }
    const approved = await this.effects.requestToolApproval(toolCall);
    if (this.signal.aborted) {
      await this.effects.executeTool(toolCall, this.signal);
      this.cancelledBeforeStart = true;
      this.nextToolIndex += 1;
      await this.dispatch({ type: "TOOL_DENIED" });
      return;
    }
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
    await this.effects.executeTool(toolCall, this.signal);
    const code = cancellationCode(toolCall);
    if (code === "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN") {
      this.checkpointOutcomeUnknown = true;
      await this.dispatch({ type: "TOOL_CANCEL_UNKNOWN" });
      return;
    }
    if (code === "TOOL_CANCELLED_BEFORE_START") this.cancelledBeforeStart = true;
    this.nextToolIndex += 1;
    await this.dispatch({ type: toolCall.state === "completed" ? "TOOL_COMPLETED" : "TOOL_FAILED" });
  }

  private async persistToolCheckpoint(outcomeUnknown: boolean): Promise<void> {
    if (!this.currentStream) throw new Error("Chat turn tool checkpoint has no stream result.");
    try {
      await this.effects.commitToolCheckpoint(this.currentStream.message);
    } catch (error) {
      await this.dispatch({ type: "PERSIST_FAILED", operation: "tool_checkpoint" });
      throw error;
    }
    await this.effects.renderToolCheckpoint(this.currentStream.message);

    if (outcomeUnknown || this.checkpointOutcomeUnknown) {
      await this.dispatch({ type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: false });
      return;
    }
    if (this.cancelledBeforeStart || this.signal.aborted) {
      await this.requestSettlement();
      return;
    }
    this.previousStream = this.currentStream;
    await this.dispatch({ type: "TOOL_CHECKPOINT_COMMITTED", continuationRequired: true });
  }
}
