import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall, ToolCallResult } from "../../types/toolCalls";
import {
  composeAcceptedChatContinuation,
  composeAcceptedChatContinuationDelta,
  managedToolsetFingerprint,
  prepareManagedMessage,
  type AcceptedManagedChatRequestSnapshot,
  type ManagedPreparedMessage,
} from "../../services/chat/AcceptedChatRequestSnapshot";
import { safeManagedResultData as safeResultData } from "../../services/chat/ManagedToolResult";
import {
  advanceManagedChatSessionBudget,
  inspectManagedToolContinuationBudget,
} from "../../services/managed/ManagedChatSessionBudget";
import type {
  AcceptedManagedChatOperation,
  ManagedChatLeaseResult,
  ManagedChatSessionBudgetState,
} from "../../services/managed/ManagedTypes";
import {
  requiresUserApproval,
  type ToolApprovalPolicy,
} from "../../utils/toolPolicy";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import {
  MANAGED_AGENT_EVENT_VERSION,
  applyManagedAgentEvent,
  createInitialAgentConversation,
  type AgentConversationSnapshot,
  type AgentUsage,
  type ManagedAgentError,
  type ManagedAgentEvent,
  type ManagedAgentEventEnvelope,
  type ToolResultSummary,
} from "./AgentConversation";
import type {
  AgentTranscriptSnapshot,
  AgentUserCommitInput,
} from "./AgentTranscriptRepository";
import type {
  ManagedChatDispatchInput,
  ManagedChatDispatchResult,
  ManagedChatRuntimeEvent,
  ManagedChatSessionCheckpoint,
} from "./turn/ManagedChatRuntimeAdapter";

const DEFAULT_MAX_CONTINUATION_ROUNDS = 8;

export type ManagedAgentToolLocation = "server" | "vault";

export type ManagedAgentControllerHost = Readonly<{
  acquireChatTurnLease: () => Promise<ManagedChatLeaseResult>;
  commitUser: (input: AgentUserCommitInput) => Promise<AgentTranscriptSnapshot>;
  claimUser: (snapshot: AgentTranscriptSnapshot, input: AgentUserCommitInput) => boolean;
  prepareAcceptedRequest: (
    operation: AcceptedManagedChatOperation,
  ) => Promise<AcceptedManagedChatRequestSnapshot>;
  persistAssistant: (
    message: ChatMessage,
    phase: "tool_checkpoint",
  ) => Promise<AgentTranscriptSnapshot | void>;
  persistAssistantWithSession: (
    message: ChatMessage,
    checkpoint: ManagedChatSessionCheckpoint,
    toolsetFingerprint: string,
    budget: ManagedChatSessionBudgetState,
  ) => Promise<AgentTranscriptSnapshot>;
  clearSessionCheckpoint: () => Promise<void>;
  snapshot: () => AgentTranscriptSnapshot;
  executeLocalTool: (toolCall: ToolCall, signal: AbortSignal) => Promise<ToolCallResult>;
  refreshCredits: () => void | Promise<void>;
  reportError: (error: unknown) => void;
}>;

export type ManagedAgentRuntimePort = Readonly<{
  dispatch: (input: ManagedChatDispatchInput) => Promise<ManagedChatDispatchResult>;
  notifyDurablyTerminal: (operation: AcceptedManagedChatOperation) => void;
}>;

export type ManagedAgentStartInput = Readonly<{
  commit: AgentUserCommitInput;
  turnBoundaryId?: string;
  approvalPolicy?: ToolApprovalPolicy;
  signal?: AbortSignal;
}>;

export type ManagedAgentRunResult =
  | Readonly<{
      kind: "completed";
      operation: AcceptedManagedChatOperation;
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "cancelled";
      operation?: AcceptedManagedChatOperation;
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "failed";
      operation?: AcceptedManagedChatOperation;
      error: ManagedAgentError;
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "admission_denied";
      outcome: Exclude<ManagedChatLeaseResult["outcome"], "allowed">;
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "superseded" | "busy";
      snapshot: AgentConversationSnapshot;
    }>;

export type ManagedAgentControllerOptions = Readonly<{
  host: ManagedAgentControllerHost;
  runtime: ManagedAgentRuntimePort;
  maxContinuationRounds?: number;
  now?: () => number;
  classifyToolLocation?: (toolName: string) => ManagedAgentToolLocation;
}>;

type Listener = (
  snapshot: AgentConversationSnapshot,
  envelope: ManagedAgentEventEnvelope,
) => void;

type PendingApproval = {
  readonly approvalId: string;
  resolve: (approved: boolean | null) => void;
  detach: () => void;
};

type ActiveRun = {
  readonly token: symbol;
  readonly abortController: AbortController;
  snapshot: AgentConversationSnapshot;
  operation?: AcceptedManagedChatOperation;
  acceptedRequest?: AcceptedManagedChatRequestSnapshot;
  runId?: string;
  turnId?: string;
  seq: number;
  terminal: boolean;
  terminalNotified: boolean;
  checkpointMessage?: ChatMessage;
  pendingApproval?: PendingApproval;
  completion?: Promise<ManagedAgentRunResult>;
};

type StreamedTool = {
  readonly index: number;
  readonly uiCallId: string;
  readonly partId: string;
  transportId?: string;
  name?: string;
  readonly chunks: string[];
  emittedChunks: number;
  finalArguments?: string;
  completed: boolean;
  location?: ManagedAgentToolLocation;
  input?: Record<string, unknown>;
  toolCall?: ToolCall;
};

type StreamedTextPart = {
  readonly kind: "text";
  readonly partId: string;
  text: string;
};

type StreamedReasoningPart = {
  readonly kind: "reasoning";
  readonly partId: string;
  summary: string;
};

type StreamedNarrativePart = StreamedTextPart | StreamedReasoningPart;

type OrderedStreamPart =
  | StreamedReasoningPart
  | StreamedTextPart
  | Readonly<{ kind: "tool"; tool: StreamedTool }>;

type StreamResult = {
  readonly message: ChatMessage;
  readonly tools: StreamedTool[];
  readonly sessionCheckpoint: ManagedChatSessionCheckpoint;
  readonly finishReason?: string;
  readonly requestId?: string;
};

type UsageValues = {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costTotal?: number;
};

class ManagedAgentControllerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ManagedAgentControllerError";
  }
}

/**
 * One model message is an ordered stream of logical parts, not a text blob plus
 * an unordered tool array. This ledger is the single chronology source for the
 * live reducer and the durable ChatMessage projection.
 */
class OrderedMessageStream {
  private readonly parts: OrderedStreamPart[] = [];
  private activeText?: StreamedTextPart;
  private activeReasoning?: StreamedReasoningPart;
  private nextTextOrdinal = 0;
  private nextReasoningOrdinal = 0;

  public constructor(private readonly messageId: string) {}

  public appendText(delta: string): Readonly<{
    part: StreamedTextPart;
    completedReasoning?: StreamedReasoningPart;
  }> {
    const completedReasoning = this.completeActiveReasoning();
    if (!this.activeText) {
      this.activeText = {
        kind: "text",
        partId: `${this.messageId}:text:${this.nextTextOrdinal}`,
        text: "",
      };
      this.nextTextOrdinal += 1;
      this.parts.push(this.activeText);
    }
    this.activeText.text += delta;
    return {
      part: this.activeText,
      ...(completedReasoning ? { completedReasoning } : {}),
    };
  }

  public appendReasoning(delta: string): Readonly<{
    part: StreamedReasoningPart;
    completedText?: StreamedTextPart;
  }> {
    const completedText = this.completeActiveText();
    if (!this.activeReasoning) {
      this.activeReasoning = {
        kind: "reasoning",
        partId: `${this.messageId}:reasoning:${this.nextReasoningOrdinal}`,
        summary: "",
      };
      this.nextReasoningOrdinal += 1;
      this.parts.push(this.activeReasoning);
    }
    this.activeReasoning.summary += delta;
    return {
      part: this.activeReasoning,
      ...(completedText ? { completedText } : {}),
    };
  }

  public appendTool(tool: StreamedTool): StreamedNarrativePart | undefined {
    const completedNarrative = this.completeActiveNarrative();
    this.parts.push({ kind: "tool", tool });
    return completedNarrative;
  }

  public completeActiveText(): StreamedTextPart | undefined {
    const text = this.activeText;
    if (!text) return undefined;
    this.activeText = undefined;
    return text;
  }

  public completeActiveReasoning(): StreamedReasoningPart | undefined {
    const reasoning = this.activeReasoning;
    if (!reasoning) return undefined;
    this.activeReasoning = undefined;
    return reasoning;
  }

  public completeActiveNarrative(): StreamedNarrativePart | undefined {
    return this.completeActiveText() ?? this.completeActiveReasoning();
  }

  public reset(): void {
    this.parts.length = 0;
    this.activeText = undefined;
    this.activeReasoning = undefined;
    this.nextTextOrdinal = 0;
    this.nextReasoningOrdinal = 0;
  }

  public get content(): string {
    return this.parts
      .filter((part): part is StreamedTextPart => part.kind === "text")
      .map((part) => part.text)
      .join("");
  }

  public toDurableParts(timestampBase: number): MessagePart[] {
    return this.parts.map((part, index): MessagePart => {
      const timestamp = timestampBase + index;
      if (part.kind === "text") {
        return { id: part.partId, type: "content", timestamp, data: part.text };
      }
      if (part.kind === "reasoning") {
        return { id: part.partId, type: "reasoning", timestamp, data: part.summary };
      }
      if (!part.tool.toolCall) {
        throw new ManagedAgentControllerError(
          "managed_tool_incomplete",
          `Tool call ${part.tool.index} did not produce a durable action.`,
        );
      }
      return {
        id: part.tool.partId,
        type: "tool_call",
        timestamp,
        data: part.tool.toolCall,
      };
    });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || (typeof error === "object" && error !== null
      && (error as { kind?: unknown }).kind === "aborted");
}

function asManagedError(error: unknown): ManagedAgentError {
  if (isManagedDispatchFailure(error)) return asManagedError(dispatchError(error));
  if (error instanceof ManagedAgentControllerError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error instanceof Error) {
    return { code: "managed_agent_failed", message: error.message || "SystemSculpt stopped unexpectedly." };
  }
  return { code: "managed_agent_failed", message: "SystemSculpt stopped unexpectedly." };
}

function isManagedDispatchFailure(
  error: unknown,
): error is Exclude<ManagedChatDispatchResult, { kind: "success" }> {
  if (!error || typeof error !== "object" || !("kind" in error) || !("diagnostic" in error)) return false;
  return [
    "empty", "transport_failure", "aborted", "capability_request", "license", "credits",
    "operation_in_progress", "operation_already_completed", "operation_terminal", "settlement_pending",
    "plugin_version", "rate_limit", "unavailable", "session", "attachment_unavailable",
  ].includes(String((error as { kind: unknown }).kind));
}

function defaultToolLocation(_toolName: string): ManagedAgentToolLocation {
  // Every model-emitted tool in the current contract executes through the
  // first-party tool service. Server-owned web search never surfaces as a tool call.
  return "vault";
}

function parseToolInput(argumentsJson: string, toolName: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new ManagedAgentControllerError(
      "invalid_tool_arguments",
      `SystemSculpt returned invalid input for ${toolName}.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManagedAgentControllerError(
      "invalid_tool_arguments",
      `SystemSculpt returned invalid input for ${toolName}.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function toolResultSummary(toolCall: ToolCall): ToolResultSummary {
  const name = toolCall.request.function.name;
  const input = parseToolInput(toolCall.request.function.arguments, name);
  const data = toolCall.result?.data;
  const paths = toolCall.result?.success
    ? collectToolArtifactPaths(name, input, data)
    : collectSuccessfulToolArtifactPaths(name, data);
  return {
    title: `${name} ${toolCall.result?.success ? "completed" : "failed"}`,
    summary: toolCall.result?.success
      ? paths.join(", ") || undefined
      : toolCall.result?.error?.message || "The tool failed without an error message.",
    ...(typeof data !== "undefined" ? { data: safeResultData(data) } : {}),
    ...(paths.length ? {
      artifacts: paths.map((path) => ({
        id: `${toolCall.id}:artifact:${path}`,
        kind: "vault_file" as const,
        title: path.split("/").pop() || path,
        path,
      })),
    } : {}),
  };
}

function addUsage(base: UsageValues, current: UsageValues): AgentUsage {
  const next: UsageValues = {};
  for (const key of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens", "costTotal"] as const) {
    const value = current[key];
    if (typeof value === "number") next[key] = (base[key] ?? 0) + value;
  }
  return next;
}

function accumulateUsage(base: UsageValues, current: UsageValues): UsageValues {
  const next = { ...base };
  for (const key of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens", "costTotal"] as const) {
    const value = current[key];
    if (typeof value === "number") next[key] = (base[key] ?? 0) + value;
  }
  return next;
}

function dispatchError(result: Exclude<ManagedChatDispatchResult, { kind: "success" }>): ManagedAgentControllerError {
  const messages: Record<Exclude<ManagedChatDispatchResult["kind"], "success">, string> = {
    empty: "SystemSculpt returned an empty response.",
    aborted: "The SystemSculpt request was cancelled.",
    transport_failure: "SystemSculpt could not complete the request.",
    capability_request: "SystemSculpt rejected this request.",
    license: "A valid SystemSculpt license is required.",
    credits: "There are not enough credits for this request.",
    operation_in_progress: "This SystemSculpt task is already in progress.",
    operation_already_completed: "This SystemSculpt task has already completed.",
    operation_terminal: "This SystemSculpt task is already finished.",
    settlement_pending: "The previous SystemSculpt task is still finishing.",
    plugin_version: "Update SystemSculpt to use chat.",
    rate_limit: "SystemSculpt is temporarily rate limited.",
    unavailable: "SystemSculpt is temporarily unavailable.",
    session: "This chat session could not be resumed safely.",
    attachment_unavailable: "An earlier attachment is unavailable, so this chat cannot be rebuilt safely.",
  };
  const localMessages: Readonly<Record<string, string>> = {
    local_request_too_large: "This chat request is too large to send. Remove attachments or start a new chat.",
    local_transcript_invalid: "This chat history could not be prepared safely. Start a new chat and try again.",
    local_attachment_unavailable: "An earlier attachment is unavailable, so this chat cannot be rebuilt safely.",
    local_contract_invalid: "This plugin and the SystemSculpt chat contract no longer match. Update the plugin.",
    local_rebase_message_limit: "This chat is too long to rebuild safely. Start a new chat to continue.",
    local_rebase_attachment_limit: "This chat has too many retained attachments to rebuild safely. Start a new chat to continue.",
    local_rebase_text_limit: "This chat has too much retained text to rebuild safely. Start a new chat to continue.",
    local_tool_contract_limit: "The SystemSculpt action contract is too large. Update the plugin and try again.",
    local_session_message_limit: "This chat has reached its managed message limit. Start a new chat to continue.",
    local_session_image_limit: "This chat has reached its managed image limit. Start a new chat to continue.",
    local_session_attachment_limit: "This chat has reached its managed attachment limit. Start a new chat to continue.",
    local_session_stored_json_limit: "This chat has reached its managed storage limit. Start a new chat to continue.",
  };
  return new ManagedAgentControllerError(
    result.diagnostic.code || `managed_${result.kind}`,
    (result.diagnostic.code && localMessages[result.diagnostic.code]) || messages[result.kind],
    result.diagnostic.requestId,
  );
}

/**
 * Owns one durable managed-agent turn from admission through terminal
 * settlement. UI consumers only observe typed reducer snapshots and resolve
 * inline approvals; transport and vault side effects stay behind narrow ports.
 */
export class ManagedAgentController {
  private readonly host: ManagedAgentControllerHost;
  private readonly runtime: ManagedAgentRuntimePort;
  private readonly maxContinuationRounds: number;
  private readonly now: () => number;
  private readonly classifyToolLocation: (toolName: string) => ManagedAgentToolLocation;
  private readonly listeners = new Set<Listener>();
  private active?: ActiveRun;
  private currentSnapshot = createInitialAgentConversation();

  constructor(options: ManagedAgentControllerOptions) {
    this.host = options.host;
    this.runtime = options.runtime;
    this.maxContinuationRounds = options.maxContinuationRounds ?? DEFAULT_MAX_CONTINUATION_ROUNDS;
    if (!Number.isInteger(this.maxContinuationRounds) || this.maxContinuationRounds < 1) {
      throw new Error("maxContinuationRounds must be a positive integer.");
    }
    this.now = options.now ?? Date.now;
    this.classifyToolLocation = options.classifyToolLocation ?? defaultToolLocation;
  }

  public getSnapshot(): AgentConversationSnapshot {
    return this.currentSnapshot;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(input: ManagedAgentStartInput): Promise<ManagedAgentRunResult> {
    if (this.active && !this.active.terminal) {
      return Promise.resolve({ kind: "busy", snapshot: this.currentSnapshot });
    }
    const active: ActiveRun = {
      token: Symbol("managed-agent-run"),
      abortController: new AbortController(),
      snapshot: createInitialAgentConversation(),
      seq: 0,
      terminal: false,
      terminalNotified: false,
    };
    this.active = active;
    this.currentSnapshot = active.snapshot;
    const detachExternalSignal = this.followExternalSignal(input.signal, active.abortController);
    const completion = this.run(active, input).finally(() => {
      detachExternalSignal();
      this.resolvePendingApproval(active, null);
      void this.bestEffort(() => this.host.refreshCredits());
    });
    active.completion = completion;
    return completion;
  }

  public respondToApproval(approvalId: string, approved: boolean): boolean {
    const active = this.active;
    const pending = active?.pendingApproval;
    if (!active || active.terminal || !pending || pending.approvalId !== approvalId) return false;
    this.emit(active, { type: "approval.resolved", approvalId, approved });
    this.resolvePendingApproval(active, approved);
    return true;
  }

  public async cancel(): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    active.abortController.abort();
    this.resolvePendingApproval(active, null);
    await active.completion;
  }

  private async run(active: ActiveRun, input: ManagedAgentStartInput): Promise<ManagedAgentRunResult> {
    try {
      const admission = await this.host.acquireChatTurnLease();
      this.assertOpen(active);
      if (admission.outcome !== "allowed") {
        active.terminal = true;
        return {
          kind: "admission_denied",
          outcome: admission.outcome,
          snapshot: active.snapshot,
        };
      }

      const acceptedTranscript = await this.host.commitUser(input.commit);
      this.assertOpen(active);
      if (!this.host.claimUser(acceptedTranscript, input.commit)) {
        active.terminal = true;
        return { kind: "superseded", snapshot: active.snapshot };
      }
      const acceptedMessage = acceptedTranscript.messages.find((message) =>
        message.role === "user" && message.message_id === input.commit.message.message_id);
      if (!acceptedMessage) {
        throw new ManagedAgentControllerError(
          "accepted_user_missing",
          "The durable transcript does not contain the accepted user message.",
        );
      }
      const durableTurnId = String(acceptedMessage.message_id || "").trim();
      if (!durableTurnId) {
        throw new ManagedAgentControllerError(
          "accepted_turn_id_missing",
          "The accepted user message does not have a durable turn ID.",
        );
      }
      const operation: AcceptedManagedChatOperation = Object.freeze({
        runtime: "managed",
        lease: admission.lease,
        durableTurnId,
        acceptedUserMessage: acceptedMessage,
        initialDurableSnapshot: acceptedTranscript,
        turnBoundaryId: input.turnBoundaryId?.trim() || durableTurnId,
      });
      active.operation = operation;
      active.runId = `managed-run:${durableTurnId}`;
      active.turnId = durableTurnId;
      this.emit(active, { type: "run.started" });
      this.emit(active, { type: "run.status", phase: "submitted", label: "Starting" });

      const acceptedRequest = await this.host.prepareAcceptedRequest(operation);
      this.assertOpen(active);
      if (acceptedRequest.operation !== operation) {
        throw new ManagedAgentControllerError(
          "accepted_request_identity_changed",
          "The prepared managed request changed operation identity.",
        );
      }
      active.acceptedRequest = acceptedRequest;

      let phase: "initial" | "continuation" = "initial";
      let continuationIndex = 0;
      let streamOrdinal = 0;
      let checkpointSnapshot: AgentTranscriptSnapshot | undefined;
      let usageBase: UsageValues = {};

      while (true) {
        this.assertOpen(active);
        if (phase === "continuation" && continuationIndex >= this.maxContinuationRounds) {
          throw new ManagedAgentControllerError(
            "max_tool_continuation_depth",
            `SystemSculpt exceeded ${this.maxContinuationRounds} tool rounds.`,
          );
        }
        this.emit(active, {
          type: "run.status",
          phase: phase === "initial" ? "thinking" : "working",
          label: phase === "initial"
            ? acceptedRequest.webSearch ? "Searching web" : "Thinking"
            : "Continuing",
        });
        const messageId = `${durableTurnId}:assistant:${streamOrdinal}`;
        const streamed = await this.streamPhase(
          active,
          operation,
          acceptedRequest,
          phase,
          continuationIndex,
          checkpointSnapshot,
          messageId,
          usageBase,
        );
        usageBase = streamed.usageBase;
        const message = streamed.result.message;
        active.checkpointMessage = message;
        const sessionBudget = this.advanceSessionBudget(
          acceptedRequest,
          phase,
          checkpointSnapshot,
          message,
          streamed.result.sessionCheckpoint,
        );
        await this.host.persistAssistantWithSession(
          message,
          streamed.result.sessionCheckpoint,
          managedToolsetFingerprint(acceptedRequest.tools),
          sessionBudget,
        );
        this.assertOpen(active);

        if (streamed.result.tools.length === 0) {
          active.checkpointMessage = undefined;
          this.emit(active, { type: "run.completed" }, true);
          this.notifyTerminal(active);
          return { kind: "completed", operation, snapshot: active.snapshot };
        }

        const rotateSession = this.assertToolContinuationBudget(
          operation,
          acceptedRequest,
          phase,
          checkpointSnapshot,
          message,
          sessionBudget,
        );
        if (rotateSession) {
          await this.host.clearSessionCheckpoint();
          this.assertOpen(active);
        }
        for (const streamedTool of streamed.result.tools) {
          await this.settleTool(active, streamedTool, input.approvalPolicy);
          this.assertOpen(active);
        }
        const persistedCheckpoint = await this.host.persistAssistant(message, "tool_checkpoint");
        this.assertOpen(active);
        active.checkpointMessage = undefined;
        const durable = persistedCheckpoint ?? this.host.snapshot();
        checkpointSnapshot = durable;
        phase = "continuation";
        continuationIndex = streamOrdinal === 0 ? 0 : continuationIndex + 1;
        streamOrdinal += 1;
      }
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        await this.persistOutstandingToolSettlement(active, "cancelled");
        await this.clearUnsafeSession(active);
        if (active.runId && !active.terminal) {
          this.emit(active, { type: "run.cancelled" }, true);
        } else {
          active.terminal = true;
        }
        this.notifyTerminal(active);
        return { kind: "cancelled", operation: active.operation, snapshot: active.snapshot };
      }
      const managedError = asManagedError(error);
      await this.persistOutstandingToolSettlement(active, "failed", managedError);
      await this.clearUnsafeSession(active);
      if (active.runId && !active.terminal) {
        this.emit(active, { type: "run.failed", error: managedError }, true);
      } else {
        active.terminal = true;
      }
      this.notifyTerminal(active);
      this.safeReport(error);
      return {
        kind: "failed",
        operation: active.operation,
        error: managedError,
        snapshot: active.snapshot,
      };
    }
  }

  private assertToolContinuationBudget(
    operation: AcceptedManagedChatOperation,
    acceptedRequest: AcceptedManagedChatRequestSnapshot,
    phase: "initial" | "continuation",
    checkpointSnapshot: AgentTranscriptSnapshot | undefined,
    assistant: ChatMessage,
    sessionBudget: ManagedChatSessionBudgetState,
  ): boolean {
    let fullMessages: readonly ManagedPreparedMessage[];
    try {
      fullMessages = phase === "initial"
        ? acceptedRequest.messages
        : checkpointSnapshot
          ? composeAcceptedChatContinuation(acceptedRequest, checkpointSnapshot)
          : [];
      if (fullMessages.length === 0) throw new Error("Managed continuation snapshot is missing.");
      fullMessages = [...fullMessages, prepareManagedMessage(assistant)];
    } catch {
      throw new ManagedAgentControllerError(
        "local_transcript_invalid",
        "This chat cannot prepare a safe action continuation. No vault actions were run.",
      );
    }
    const budget = inspectManagedToolContinuationBudget({
      limits: operation.lease.descriptor.limits,
      fullMessagesThroughAssistant: fullMessages,
      sessionBudget,
      tools: (assistant.tool_calls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.request.function.name,
      })),
      toolDefinitions: acceptedRequest.tools,
    });
    if (budget.issue) {
      throw new ManagedAgentControllerError(budget.issue.code, budget.issue.message);
    }
    return budget.rotateSession;
  }

  private advanceSessionBudget(
    acceptedRequest: AcceptedManagedChatRequestSnapshot,
    phase: "initial" | "continuation",
    checkpointSnapshot: AgentTranscriptSnapshot | undefined,
    assistant: ChatMessage,
    checkpoint: ManagedChatSessionCheckpoint,
  ): ManagedChatSessionBudgetState {
    const previousBinding = checkpoint.revision > 1
      ? this.host.snapshot().managedSession
      : undefined;
    if (
      checkpoint.revision > 1
      && (
        !previousBinding
        || previousBinding.id !== checkpoint.id
        || previousBinding.revision + 1 !== checkpoint.revision
      )
    ) {
      throw new ManagedAgentControllerError(
        "local_session_budget_mismatch",
        "The saved SystemSculpt session counters no longer match this response.",
      );
    }
    let requestMessages: readonly ManagedPreparedMessage[];
    try {
      requestMessages = phase === "initial"
        ? checkpoint.revision > 1
          ? acceptedRequest.turnMessages
          : acceptedRequest.messages
        : checkpointSnapshot
          ? checkpoint.revision > 1
            ? composeAcceptedChatContinuationDelta(acceptedRequest, checkpointSnapshot)
            : composeAcceptedChatContinuation(acceptedRequest, checkpointSnapshot)
          : [];
      if (requestMessages.length === 0) throw new Error("Managed session request is missing.");
    } catch {
      throw new ManagedAgentControllerError(
        "local_transcript_invalid",
        "This chat cannot persist its managed session counters safely.",
      );
    }
    const budget = advanceManagedChatSessionBudget({
      ...(previousBinding ? { previous: previousBinding.budget } : {}),
      requestMessages,
      responseMessage: prepareManagedMessage(assistant),
      tools: acceptedRequest.tools,
    });
    if (!budget) {
      throw new ManagedAgentControllerError(
        "local_session_budget_invalid",
        "This chat cannot persist its managed session counters safely.",
      );
    }
    return budget;
  }

  private async streamPhase(
    active: ActiveRun,
    operation: AcceptedManagedChatOperation,
    acceptedRequest: AcceptedManagedChatRequestSnapshot,
    phase: "initial" | "continuation",
    continuationIndex: number,
    checkpointSnapshot: AgentTranscriptSnapshot | undefined,
    messageId: string,
    usageBase: UsageValues,
  ): Promise<{ result: StreamResult; usageBase: UsageValues }> {
    const dispatched = await this.runtime.dispatch({
      operation,
      acceptedRequestSnapshot: acceptedRequest,
      phase,
      continuationIndex,
      ...(checkpointSnapshot ? { postCheckpointDurableSnapshot: checkpointSnapshot } : {}),
      signal: active.abortController.signal,
    });
    this.assertOpen(active);
    if (dispatched.kind !== "success") throw dispatchError(dispatched);

    this.emit(active, { type: "message.started", messageId, role: "assistant" });
    const orderedStream = new OrderedMessageStream(messageId);
    const tools = new Map<number, StreamedTool>();
    let finishReason: string | undefined;
    let requestId = dispatched.diagnostic.requestId;
    let done = false;
    let sessionCheckpoint: ManagedChatSessionCheckpoint | undefined;
    let phaseUsage: UsageValues = {};

    for await (const event of dispatched.events) {
      this.assertOpen(active);
      switch (event.kind) {
        case "phase_restarted":
          orderedStream.reset();
          tools.clear();
          finishReason = undefined;
          done = false;
          sessionCheckpoint = undefined;
          phaseUsage = {};
          this.emit(active, { type: "message.restarted", messageId });
          this.emit(active, { type: "run.status", phase: "retrying", label: "Recovering" });
          break;
        case "reasoning_summary_delta": {
          if (!event.text) break;
          const appended = orderedStream.appendReasoning(event.text);
          if (appended.completedText) {
            this.emit(active, {
              type: "text.completed",
              messageId,
              partId: appended.completedText.partId,
            });
          }
          this.emit(active, {
            type: "reasoning.delta",
            messageId,
            partId: appended.part.partId,
            delta: event.text,
          });
          break;
        }
        case "content_delta": {
          if (!event.text) break;
          const appended = orderedStream.appendText(event.text);
          if (appended.completedReasoning) {
            this.emit(active, {
              type: "reasoning.completed",
              messageId,
              partId: appended.completedReasoning.partId,
            });
          }
          this.emit(active, {
            type: "text.delta",
            messageId,
            partId: appended.part.partId,
            delta: event.text,
          });
          break;
        }
        case "tool_call_delta": {
          const isNew = !tools.has(event.index);
          const tool = this.upsertStreamedTool(tools, event, messageId);
          if (isNew) {
            this.startOrderedTool(active, orderedStream, tool, messageId);
          }
          if (typeof event.arguments === "string" && event.arguments.length > 0) {
            tool.chunks.push(event.arguments);
          }
          this.flushToolInput(active, tool, messageId);
          break;
        }
        case "tool_call_completed": {
          const isNew = !tools.has(event.index);
          const tool = this.upsertStreamedTool(tools, event, messageId);
          if (isNew) {
            this.startOrderedTool(active, orderedStream, tool, messageId);
          }
          this.finalizeStreamedTool(active, tool, event.arguments, messageId);
          break;
        }
        case "finish_reason":
          if (finishReason) {
            throw new ManagedAgentControllerError(
              "duplicate_finish_reason",
              "SystemSculpt returned conflicting completion states.",
              requestId,
            );
          }
          finishReason = event.reason;
          break;
        case "request_id":
          requestId = event.requestId;
          break;
        case "usage":
          phaseUsage = this.nextPhaseUsage(phaseUsage, event);
          this.emit(active, { type: "usage.updated", usage: addUsage(usageBase, phaseUsage) });
          break;
        case "session_committed":
          if (sessionCheckpoint) {
            throw new ManagedAgentControllerError(
              "duplicate_session_checkpoint",
              "SystemSculpt returned conflicting session checkpoints.",
              requestId,
            );
          }
          sessionCheckpoint = event.checkpoint;
          break;
        case "done":
          done = true;
          break;
        default:
          this.unreachableEvent(event);
      }
      if (done) break;
    }

    if (!done) {
      throw new ManagedAgentControllerError(
        "managed_stream_incomplete",
        "The SystemSculpt response ended unexpectedly.",
        requestId,
      );
    }
    if (!sessionCheckpoint) {
      throw new ManagedAgentControllerError(
        "managed_session_checkpoint_missing",
        "SystemSculpt did not confirm the chat session.",
        requestId,
      );
    }
    this.completeNarrativePart(active, messageId, orderedStream.completeActiveNarrative());
    const finalizedTools = [...tools.values()].sort((left, right) => left.index - right.index);
    if (finalizedTools.some((tool) => !tool.completed || !tool.toolCall)) {
      throw new ManagedAgentControllerError(
        "managed_tool_incomplete",
        "The SystemSculpt response ended with an incomplete action.",
        requestId,
      );
    }
    if (
      (finishReason === "tool_calls" || finishReason === "toolUse")
      && finalizedTools.length === 0
    ) {
      throw new ManagedAgentControllerError(
        "managed_tool_result_missing",
        "SystemSculpt requested an action without completing it.",
        requestId,
      );
    }
    const content = orderedStream.content;
    if (!content && finalizedTools.length === 0) {
      throw new ManagedAgentControllerError(
        "managed_empty_response",
        "SystemSculpt returned an empty response.",
        requestId,
      );
    }

    const toolCalls = finalizedTools.map((tool) => tool.toolCall!);
    const message: ChatMessage = {
      role: "assistant",
      content,
      message_id: messageId,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      messageParts: orderedStream.toDurableParts(this.now()),
    };
    return {
      result: { message, tools: finalizedTools, sessionCheckpoint, finishReason, requestId },
      usageBase: accumulateUsage(usageBase, phaseUsage),
    };
  }

  private startOrderedTool(
    active: ActiveRun,
    orderedStream: OrderedMessageStream,
    tool: StreamedTool,
    messageId: string,
  ): void {
    if (!tool.name) {
      throw new ManagedAgentControllerError(
        "managed_tool_name_missing",
        `Tool call ${tool.index} did not identify itself when streaming began.`,
      );
    }
    this.completeNarrativePart(active, messageId, orderedStream.appendTool(tool));
    tool.location = this.classifyToolLocation(tool.name);
    this.emit(active, {
      type: "tool.input.started",
      callId: tool.uiCallId,
      partId: tool.partId,
      messageId,
      name: tool.name,
      location: tool.location,
    });
  }

  private completeNarrativePart(
    active: ActiveRun,
    messageId: string,
    part: StreamedNarrativePart | undefined,
  ): void {
    if (!part) return;
    if (part.kind === "reasoning") {
      this.emit(active, { type: "reasoning.completed", messageId, partId: part.partId });
      return;
    }
    this.emit(active, { type: "text.completed", messageId, partId: part.partId });
  }

  private upsertStreamedTool(
    tools: Map<number, StreamedTool>,
    event: Extract<ManagedChatRuntimeEvent, { kind: "tool_call_delta" | "tool_call_completed" }>,
    messageId: string,
  ): StreamedTool {
    let tool = tools.get(event.index);
    if (!tool) {
      const uiCallId = `${messageId}:tool:${event.index}`;
      tool = {
        index: event.index,
        uiCallId,
        partId: `${uiCallId}:part`,
        chunks: [],
        emittedChunks: 0,
        completed: false,
      };
      tools.set(event.index, tool);
    }
    if (event.id) {
      if (tool.transportId && tool.transportId !== event.id) {
        throw new ManagedAgentControllerError(
          "managed_tool_identity_changed",
          `Tool call ${event.index} changed its transport ID while streaming.`,
        );
      }
      tool.transportId = event.id;
    }
    if (event.name) {
      if (tool.name && tool.name !== event.name) {
        throw new ManagedAgentControllerError(
          "managed_tool_identity_changed",
          `Tool call ${event.index} changed its name while streaming.`,
        );
      }
      tool.name = event.name;
    }
    return tool;
  }

  private flushToolInput(active: ActiveRun, tool: StreamedTool, messageId: string): void {
    if (!tool.name) return;
    tool.location = this.classifyToolLocation(tool.name);
    while (tool.emittedChunks < tool.chunks.length) {
      const delta = tool.chunks[tool.emittedChunks];
      tool.emittedChunks += 1;
      if (!delta) continue;
      this.emit(active, {
        type: "tool.input.delta",
        callId: tool.uiCallId,
        partId: tool.partId,
        messageId,
        name: tool.name,
        location: tool.location,
        delta,
      });
    }
  }

  private finalizeStreamedTool(
    active: ActiveRun,
    tool: StreamedTool,
    finalArguments: string,
    messageId: string,
  ): void {
    if (tool.completed) {
      throw new ManagedAgentControllerError(
        "duplicate_tool_completion",
        `Tool call ${tool.index} completed more than once.`,
      );
    }
    if (!tool.name) {
      throw new ManagedAgentControllerError(
        "managed_tool_name_missing",
        `Tool call ${tool.index} does not have a name.`,
      );
    }
    const streamedArguments = tool.chunks.join("");
    if (streamedArguments && streamedArguments !== finalArguments) {
      throw new ManagedAgentControllerError(
        "managed_tool_arguments_changed",
        `Tool call ${tool.name} changed its arguments at completion.`,
      );
    }
    if (!streamedArguments && finalArguments) tool.chunks.push(finalArguments);
    this.flushToolInput(active, tool, messageId);
    tool.finalArguments = finalArguments;
    tool.location = tool.location ?? this.classifyToolLocation(tool.name);
    tool.input = parseToolInput(finalArguments, tool.name);
    const transportId = tool.transportId ?? `${messageId}:transport-tool:${tool.index}`;
    tool.transportId = transportId;
    tool.toolCall = {
      id: transportId,
      messageId,
      request: {
        id: transportId,
        type: "function",
        function: { name: tool.name, arguments: finalArguments },
      },
      state: "executing",
      timestamp: this.now(),
    };
    tool.completed = true;
    this.emit(active, {
      type: "tool.requested",
      call: {
        callId: tool.uiCallId,
        partId: tool.partId,
        messageId,
        name: tool.name,
        location: tool.location,
        input: tool.input,
      },
    });
  }

  private async settleTool(
    active: ActiveRun,
    streamed: StreamedTool,
    policy: ToolApprovalPolicy | undefined,
  ): Promise<void> {
    const toolCall = streamed.toolCall;
    if (!toolCall || !streamed.name || !streamed.location) {
      throw new ManagedAgentControllerError(
        "managed_tool_incomplete",
        "SystemSculpt attempted to run an incomplete action.",
      );
    }
    if (streamed.location === "server") {
      this.emit(active, { type: "tool.started", callId: streamed.uiCallId });
      toolCall.state = "failed";
      toolCall.executionStartedAt = this.now();
      toolCall.executionCompletedAt = this.now();
      toolCall.result = {
        success: false,
        error: {
          code: "SERVER_TOOL_RESULT_UNAVAILABLE",
          message: "The server did not include a completed result for this server-side tool.",
        },
      };
      this.emit(active, {
        type: "tool.failed",
        callId: streamed.uiCallId,
        result: toolResultSummary(toolCall),
        error: {
          code: "SERVER_TOOL_RESULT_UNAVAILABLE",
          message: "The server did not include a completed result for this server-side tool.",
        },
      });
      return;
    }

    if (requiresUserApproval(streamed.name, policy)) {
      const approvalId = `${streamed.uiCallId}:approval`;
      // Install the resolver before publishing approval state. Subscribers may
      // enforce an automation policy synchronously from approval.requested.
      const approval = this.waitForApproval(active, approvalId);
      this.emit(active, { type: "approval.requested", callId: streamed.uiCallId, approvalId });
      this.emit(active, { type: "run.waiting", reason: "approval" });
      const approved = await approval;
      this.assertOpen(active);
      if (!approved) {
        toolCall.state = "failed";
        toolCall.executionCompletedAt = this.now();
        toolCall.result = {
          success: false,
          error: { code: "USER_DENIED", message: "The user denied this tool execution." },
        };
        return;
      }
    }

    this.emit(active, { type: "tool.started", callId: streamed.uiCallId });
    this.emit(active, { type: "run.waiting", reason: "local_tool" });
    toolCall.executionStartedAt = this.now();
    let result: ToolCallResult;
    try {
      result = await this.host.executeLocalTool(toolCall, active.abortController.signal);
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) throw error;
      result = {
        success: false,
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "The local tool failed.",
        },
      };
    }
    toolCall.executionCompletedAt = this.now();
    toolCall.result = result;
    toolCall.state = result.success ? "completed" : "failed";
    this.assertOpen(active);
    if (result.success) {
      this.emit(active, {
        type: "tool.succeeded",
        callId: streamed.uiCallId,
        result: toolResultSummary(toolCall),
      });
    } else {
      this.emit(active, {
        type: "tool.failed",
        callId: streamed.uiCallId,
        result: toolResultSummary(toolCall),
        error: {
          code: result.error?.code || "TOOL_EXECUTION_FAILED",
          message: result.error?.message || "The local tool failed.",
        },
      });
    }
    this.emit(active, { type: "run.status", phase: "working", label: "Continuing" });
  }

  private async persistOutstandingToolSettlement(
    active: ActiveRun,
    outcome: "cancelled" | "failed",
    failure?: ManagedAgentError,
  ): Promise<void> {
    const message = active.checkpointMessage;
    if (!message?.tool_calls?.length) return;
    for (const toolCall of message.tool_calls) {
      if (toolCall.state !== "executing") continue;
      const outcomeUnknown = typeof toolCall.executionStartedAt === "number";
      toolCall.state = "failed";
      toolCall.executionCompletedAt = this.now();
      toolCall.result = {
        success: false,
        error: outcome === "cancelled"
          ? outcomeUnknown
            ? {
                code: "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
                message: "Cancellation was requested after tool execution started; its outcome is unknown.",
              }
            : {
                code: "TOOL_CANCELLED_BEFORE_START",
                message: "Tool execution was cancelled before it started.",
              }
          : {
              code: outcomeUnknown ? "TOOL_OUTCOME_UNKNOWN" : (failure?.code || "MANAGED_AGENT_FAILED"),
              message: outcomeUnknown
                ? "The managed run failed after tool execution started; its outcome is unknown."
                : (failure?.message || "The managed run failed before tool execution started."),
            },
      };
    }
    try {
      await this.host.persistAssistant(message, "tool_checkpoint");
    } catch (error) {
      this.safeReport(error);
    } finally {
      active.checkpointMessage = undefined;
    }
  }

  private async clearUnsafeSession(active: ActiveRun): Promise<void> {
    if (!active.operation) return;
    try {
      await this.host.clearSessionCheckpoint();
    } catch (error) {
      this.safeReport(error);
    }
  }

  private waitForApproval(active: ActiveRun, approvalId: string): Promise<boolean | null> {
    return new Promise((resolve) => {
      const signal = active.abortController.signal;
      const onAbort = (): void => this.resolvePendingApproval(active, null);
      signal.addEventListener("abort", onAbort, { once: true });
      active.pendingApproval = {
        approvalId,
        resolve,
        detach: () => signal.removeEventListener("abort", onAbort),
      };
      if (signal.aborted) this.resolvePendingApproval(active, null);
    });
  }

  private resolvePendingApproval(active: ActiveRun, approved: boolean | null): void {
    const pending = active.pendingApproval;
    if (!pending) return;
    active.pendingApproval = undefined;
    pending.detach();
    pending.resolve(approved);
  }

  private nextPhaseUsage(
    previous: UsageValues,
    event: Extract<ManagedChatRuntimeEvent, { kind: "usage" }>,
  ): UsageValues {
    const next: UsageValues = { ...previous };
    for (const key of ["promptTokens", "completionTokens", "reasoningTokens", "totalTokens", "costTotal"] as const) {
      const value = event[key];
      if (typeof value !== "number") continue;
      const prior = previous[key];
      if (typeof prior === "number" && value < prior) {
        throw new ManagedAgentControllerError(
          "managed_usage_decreased",
          `Managed usage ${key} decreased within one response.`,
        );
      }
      next[key] = value;
    }
    return next;
  }

  private emit(active: ActiveRun, event: ManagedAgentEvent, terminal = false): void {
    if (this.active?.token !== active.token || active.terminal) return;
    if (!active.runId || !active.turnId) {
      throw new Error("SystemSculpt run identity must be established before emitting events.");
    }
    const envelope: ManagedAgentEventEnvelope = {
      version: MANAGED_AGENT_EVENT_VERSION,
      seq: active.seq + 1,
      runId: active.runId,
      turnId: active.turnId,
      emittedAt: this.now(),
      event,
    };
    active.snapshot = applyManagedAgentEvent(active.snapshot, envelope);
    active.seq = envelope.seq;
    this.currentSnapshot = active.snapshot;
    if (terminal) active.terminal = true;
    for (const listener of this.listeners) {
      try {
        listener(active.snapshot, envelope);
      } catch (error) {
        this.safeReport(error);
      }
    }
  }

  private assertOpen(active: ActiveRun): void {
    if (
      this.active?.token !== active.token
      || active.terminal
      || active.abortController.signal.aborted
    ) {
      throw new DOMException("The SystemSculpt task was cancelled.", "AbortError");
    }
  }

  private notifyTerminal(active: ActiveRun): void {
    if (active.terminalNotified || !active.operation) return;
    active.terminalNotified = true;
    try {
      this.runtime.notifyDurablyTerminal(active.operation);
    } catch (error) {
      this.safeReport(error);
    }
  }

  private followExternalSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => undefined;
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    return () => signal.removeEventListener("abort", abort);
  }

  private safeReport(error: unknown): void {
    try {
      this.host.reportError(error);
    } catch {
      // Error reporting must never change turn settlement.
    }
  }

  private async bestEffort(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.safeReport(error);
    }
  }

  private unreachableEvent(event: never): never {
    throw new ManagedAgentControllerError(
      "unsupported_managed_event",
      `Unsupported managed event: ${JSON.stringify(event)}.`,
    );
  }
}
