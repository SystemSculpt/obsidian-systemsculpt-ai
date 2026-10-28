import { ClientLatency, type ClientToolRenderCode } from "./ClientLatency";
import { captureFailedRun, boundedIncidentElapsedMs, type IncidentFailureScalars } from "./RunFailureEvidence";
import { managedError, managedException, wasDefinitelyRejected, responseStatus, incidentFailureMechanism, boundedErrorPayload } from "./ManagedResponseErrors";
import { runProgressKey } from "./RunProgress";
import {
  ConversationProjection, freezeSnapshot, initialSnapshot,
  type ProjectionTurn, type RunPresentation, type HistoryProjection,
} from "./ConversationProjection";
import {
  isWireMessage, toolInput, toolApproval,
  isAuthoritativeTerminalToolPart, outputAsToolResult,
  safeOutboundVaultToolResult, toJsonValue, terminalError,
  type WireMessage, type LocalToolCall, type ProjectedTool,
} from "./WireConversation";
import { VaultActionAuthorization, type VaultActionDecision } from "./VaultActionAuthorization";
import type { AgentChatTransportSegmentSummaryEvent, AgentRunFailureCaptureEvent } from "../../core/diagnostics/AgentIncidentCapture";
import type { ChatSession, AgentRunInput, AgentRunResult } from "../ChatSession";
export type { AgentRunInput, AgentRunResult } from "../ChatSession";
import {
  normalizeAgentIncidentFailureCode,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
} from "../../core/diagnostics/AgentIncidentSchema";
import { planRequiredError } from "../../utils/errors";
import { PlatformRequestClient } from "../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_CONTEXT_PATH,
  THIN_AGENT_CONTRACT_VERSION,
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  isThinAgentContextWithinLimits,
  parseThinAgentContextResponse,
  type MeasuredThinAgentContext,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
  type ThinAgentContextResponse,
  type ThinAgentRunTerminalData,
} from "../../services/managed/ThinAgentV1Contract";
import type { ThinAgentInputLimits } from "../../services/managed/ThinAgentInputLimits";
import type { ChatMessage } from "../../types";
import type { ToolCallResult } from "../../types/toolCalls";
import {
  countLocalToolOutcome,
  localToolOutcomeSchema,
} from "../../tools/LocalToolOutcome";
import {
  isThinAgentConversationId,
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentRequestId,
  isThinAgentServerRunId,
} from "../../utils/ThinAgentLifecycleSchema";
import {
  isMutatingTool,
  requiresUserApproval,
  type ToolApprovalPolicy,
} from "../../utils/toolPolicy";
import type {
  AgentConversationSnapshot,
  AgentRunPhase,
  ManagedAgentError,
} from "../ChatConversation";
import {
  AgentSession,
  type AgentCommandAckEvent,
  type AgentConnectionState,
  type AgentSessionSnapshot,
} from "./AuthoritativeSession";
import { AgentStreamingTransport } from "./StreamingTransport";
import type {
  AgentJsonValue,
  AgentQueueSnapshotEvent,
} from "./Protocol";
import {
  AgentMutationJournal,
  canonicalAgentToolInput,
} from "./MutationJournal";
import {
  AgentLifecycle,
  type AgentLifecycleInput,
  type AgentLifecycleRecord,
  type CreditsRefreshReason,
  type HistorySyncKind,
} from "./Lifecycle";
import { isAgentBillingFailure } from "./AgentFailurePolicy";

export type {
  AgentLifecycleCode,
  AgentLifecycleInput,
  AgentLifecyclePhase,
} from "./Lifecycle";

function toolRequestedItemCount(call: LocalToolCall): number | undefined {
  if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
    return undefined;
  }
  const input = call.input as Readonly<Record<string, AgentJsonValue>>;
  const candidates = call.name === "multi_edit" || call.name === "open"
    ? input.files
    : input.paths;
  return Array.isArray(candidates) && candidates.length <= 10_000
    ? candidates.length
    : undefined;
}

function safeToolFailureClass(
  result: ToolCallResult,
): AgentLifecycleInput["toolFailureClass"] {
  if (result.success) return undefined;
  switch (result.error?.code) {
    case "TOOL_PARTIAL_FAILURE": return "partial_failure";
    case "TOOL_OPERATION_FAILED": return "operation_failed";
    case "TOOL_CANCELLED_BEFORE_START": return "cancelled";
    case "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN": return "outcome_unknown";
    case "TOOL_MUTATION_JOURNAL_UNAVAILABLE": return "journal_unavailable";
    case "TOOL_MUTATION_OUTCOME_UNKNOWN": return "outcome_unknown";
    case "TOOL_CALL_ID_CONFLICT": return "identity_mismatch";
    case "INVALID_TOOL_CALL":
    case "INVALID_TOOL_ARGUMENTS": return "invalid_input";
    case "TOOL_EXECUTION_FAILED": return "execution_failed";
    default: return "unknown";
  }
}

type RequestClient = Pick<PlatformRequestClient, "request">;

export type AgentChatSessionOptions = Readonly<{
  baseUrl: string;
  pluginVersion: string;
  licenseKey: () => string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  mutationJournal: AgentMutationJournal;
  executeLocalTool: (
    call: LocalToolCall,
    signal: AbortSignal,
  ) => Promise<ToolCallResult>;
  persistAssistant: (message: ChatMessage) => Promise<void>;
  reconcileHistory?: (messages: readonly ChatMessage[]) => Promise<void>;
  updateInputLimits?: (limits: ThinAgentInputLimits) => void;
  refreshCredits?: (
    reason: Extract<CreditsRefreshReason, "post_terminal" | "billing_failure">,
    correlation: Readonly<{
      requestId: string;
      serverRunId?: string;
    }>,
  ) => Promise<void>;
  reportError?: (error: unknown) => void;
  onLifecycle?: (record: AgentLifecycleRecord) => void;
  onIncidentCapture?: (event: AgentRunFailureCaptureEvent) => void;
  onTransportSegmentSummary?: (
    event: AgentChatTransportSegmentSummaryEvent,
  ) => void;
  requestClient?: RequestClient;
  runStallGraceMs?: number;
  resynchronizationDelayMs?: (attempt: number) => number;
  recoveryEnvironment?: Readonly<{
    ownerWindow: () => Window;
    isVisible: () => boolean;
    subscribe: (refresh: () => void) => () => void;
  }>;
  now?: () => number;
  monotonicNow?: () => number;
}>;

/**
 * How long a live run may wait on the server with a healthy connection and no
 * new authoritative content before the presentation stops claiming progress.
 *
 * Connection health is the wrong signal for this: a run can die server-side
 * while snapshot reads still succeed, which reads as an eternal "Thinking".
 * Generous on purpose, because a reasoning model legitimately
 * goes quiet for a long time; this only replaces a false progress claim with
 * an honest one and never terminates the run, which the server still owns.
 */
const RUN_STALL_GRACE_MS = 240_000;
const MAX_RESYNCHRONIZATION_DELAY_MS = 120_000;
const HIDDEN_RESYNCHRONIZATION_DELAY_MS = 60_000;
type ActiveRun = {
  readonly token: object;
  readonly origin: "submitted" | "recovered";
  readonly conversationId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly approvalPolicy: ToolApprovalPolicy;
  readonly abort: AbortController;
  readonly completion: Promise<AgentRunResult>;
  readonly resolve: (result: AgentRunResult) => void;
  readonly executingToolIds: Set<string>;
  readonly projection: ProjectionTurn;
  readonly projectionOwner: ConversationProjection;
  readonly settledToolIds: Set<string>;
  readonly acknowledgedClientContinuationIds: Set<string>;
  readonly authorization: VaultActionAuthorization;
  readonly toolTasks: Map<string, Promise<void>>;
  phase: AgentRunPhase;
  label: string;
  serverRunId: string | null;
  terminal: ThinAgentRunTerminalData | null;
  finalizing: boolean;
  cancelRequested: boolean;
  serverAdmissionPossible: boolean;
  serverQueued: boolean;
  streamSupersededByRecovery: boolean;
  elapsedMs: number | null;

};

type StallRecovery = Readonly<{
  runToken: object;
  progressKey: string;
}>;

type PendingToolDelivery = {
  readonly requestId: string;
  readonly call: LocalToolCall;
  readonly toolExecutionOrdinal?: number;
  readonly state: "output-available" | "output-error";
  readonly output?: AgentJsonValue;
  readonly errorText?: string;
  attemptedOpenEpoch: number | null;
  inFlight: boolean;
  acknowledged: boolean;
  acknowledgementRecorded: boolean;
};

type PendingApprovalDecision = VaultActionDecision & Readonly<{
  requestId: string;
  callId: string;
}>;

type PendingApprovalDelivery = {
  readonly decision: PendingApprovalDecision;
  attemptedOpenEpoch: number | null;
  inFlight: boolean;
  acknowledged: boolean;
  acknowledgementRecorded: boolean;
};

const MAX_CONTEXT_RESPONSE_BYTES = 16 * 1024;

export class AgentChatSession implements ChatSession {
  private readonly requestClient: RequestClient;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly listeners = new Set<(snapshot: AgentConversationSnapshot) => void>();
  private transport: AgentStreamingTransport | null = null;
  private session: AgentSession<WireMessage> | null = null;
  private detachSession: (() => void) | null = null;
  private detachConnectionState: (() => void) | null = null;
  private conversationId: string | null = null;
  private projection = new ConversationProjection();
  private connectionState: AgentConnectionState = "idle";
  private runStalled = false;
  private runStallTimer: number | null = null;
  private runProgressKey = "";
  private awaitingClientWork = false;
  private currentSnapshot: AgentConversationSnapshot = initialSnapshot();
  private active: ActiveRun | null = null;
  private pendingCancelRequestId: string | null = null;
  private pendingCancelInFlight = false;
  private readonly pendingDeliveries = new Map<string, PendingToolDelivery>();
  private readonly pendingApprovalDeliveries = new Map<string, PendingApprovalDelivery>();
  private readonly lifecycle: AgentLifecycle;
  private renderTimer: number | null = null;
  /** A live run whose presentation is due at the end of the render window. */
  private pendingActivePresentation: ActiveRun | null = null;
  private pendingReconcile: Promise<void> = Promise.resolve();
  private pendingFinalization: Promise<void> = Promise.resolve();
  private reconciledKey: string | null = null;

  private generation = 0;
  private openEpoch = 0;
  private resynchronizationTimer: number | null = null;
  private resynchronizationInFlight = false;
  private resynchronizationAttempt = 0;
  private resynchronizationPending = false;
  private recoveryWindow: Window = window;
  private detachRecoveryEnvironment: (() => void) | null = null;
  private stallRecovery: StallRecovery | null = null;
  private readonly clientLatency: ClientLatency;

  public constructor(private readonly options: AgentChatSessionOptions) {
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
    this.now = options.now ?? Date.now;
    this.monotonicNow = () => {
      try {
        const value = options.monotonicNow?.()
          ?? (typeof performance !== "undefined" ? performance.now() : 0);
        return Number.isFinite(value) ? value : 0;
      } catch {
        return typeof performance !== "undefined" ? performance.now() : 0;
      }
    };
    this.clientLatency = new ClientLatency({
      monotonicNow: this.monotonicNow,
      activeRun: () => this.active,
      toolName: (requestId, callId) => this.active?.requestId === requestId
        ? this.findCurrentTool(this.active, callId)?.name ?? null
        : null,
      recordLifecycle: (input) => this.recordLifecycle(input),
      onTransportSegmentSummary: (event) => this.options.onTransportSegmentSummary?.(event),
    });
    this.lifecycle = new AgentLifecycle(
      (record) => this.options.onLifecycle?.(record),
      this.now,
    );
  }

  public getSnapshot(): AgentConversationSnapshot {
    return this.currentSnapshot;
  }

  public subscribe(listener: (snapshot: AgentConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public recordLifecycle(input: AgentLifecycleInput): void {
    // Lifecycle records stay local and never affect an authoritative run.
    this.lifecycle.record(input);
  }

  public recordClientRequestLifecycle(input: AgentLifecycleInput): void {
    const latency = input.requestId && input.clientMonotonicOffsetMs === undefined
      ? this.clientLatency.fields(input.requestId)
      : {};
    this.lifecycle.record({ ...input, ...latency });
  }

  public recordClientRenderMilestone(
    code: "response_first_dom_committed" | "response_first_paint_opportunity",
    requestId: string,
    observedAtMonotonicMs: number,
  ): void {
    this.clientLatency.recordMilestone(code, requestId, observedAtMonotonicMs);
  }

  public needsClientRenderMilestone(
    code: "response_first_dom_committed" | "response_first_paint_opportunity",
    requestId: string,
  ): boolean {
    return this.clientLatency.needsRenderMilestone(code, requestId);
  }

  public recordClientToolRenderMilestone(
    code: ClientToolRenderCode,
    requestId: string,
    toolCallId: string,
    observedAtMonotonicMs: number,
  ): void {
    this.clientLatency.recordToolRenderMilestone(
      code,
      requestId,
      toolCallId,
      observedAtMonotonicMs,
    );
  }

  public needsClientToolRenderMilestone(
    code: ClientToolRenderCode,
    requestId: string,
    toolCallId: string,
  ): boolean {
    return this.clientLatency.needsToolRenderMilestone(code, requestId, toolCallId);
  }

  public async hydrate(
    conversationId: string,
    submittedLatency?: Readonly<{
      requestId: string;
      startedAtMonotonicMs?: number;
    }>,
  ): Promise<void> {
    if (this.conversationId === conversationId && this.session && this.transport) {
      if (submittedLatency) {
        this.clientLatency.ensure({
          conversationId,
          requestId: submittedLatency.requestId,
          startedAtMonotonicMs: submittedLatency.startedAtMonotonicMs,
        });
      }
      this.recordLifecycle({
        code: "response_prepare_started",
        phase: "start",
        conversationId,
        ...(submittedLatency
          ? {
              requestId: submittedLatency.requestId,
              ...this.clientLatency.fields(submittedLatency.requestId),
            }
          : {}),
      });
      try {
        // A warm same-conversation start whose previous stream delivered a
        // settled idle run state already holds current authority; the
        // snapshot round trip would be pure pre-send latency. Any other run
        // state (active, unknown, missed idle frame) needs the full
        // resynchronizing connect to repair authority before dispatch.
        await this.transport.connect({
          reuseWarmAuthority: this.session.current.runState.state === "idle",
        });
        this.recordLifecycle({
          code: "response_prepare_completed",
          phase: "start",
          conversationId,
          ...(submittedLatency
            ? {
                requestId: submittedLatency.requestId,
                ...this.clientLatency.fields(submittedLatency.requestId),
              }
            : {}),
        });
        await this.pendingReconcile.catch(() => undefined);
        return;
      } catch (error) {
        this.recordLifecycle({
          code: "response_prepare_failed",
          phase: "start",
          conversationId,
          ...(submittedLatency
            ? {
                requestId: submittedLatency.requestId,
                ...this.clientLatency.fields(submittedLatency.requestId),
              }
            : {}),
          status: responseStatus(error),
          retryable: true,
        });
        throw managedException(
          error,
          "response_start_failed",
          "SystemSculpt could not restore this chat. Retry in a moment.",
        );
      }
    }
    if (this.active && !this.active.terminal) {
      throw new Error("Wait for the current response to finish before changing chats.");
    }
    this.disconnect();
    if (submittedLatency) {
      this.clientLatency.ensure({
        conversationId,
        requestId: submittedLatency.requestId,
        startedAtMonotonicMs: submittedLatency.startedAtMonotonicMs,
      });
    }
    const generation = ++this.generation;
    const transport = new AgentStreamingTransport({
      baseUrl: this.options.baseUrl,
      pluginVersion: this.options.pluginVersion,
      licenseKey: this.options.licenseKey,
      bootstrapRequest: () => {
        const request = parseThinAgentBootstrapRequest(this.options.bootstrapRequest());
        if (request.conversation_id !== conversationId) {
          throw new Error("This chat changed before SystemSculpt was ready.");
        }
        return request;
      },
      requestClient: this.requestClient,
      monotonicNow: this.monotonicNow,
      onTiming: (event) => {
        if (this.generation === generation) this.clientLatency.handleTransportTiming(event);
      },
      onSegmentSummary: (event) => {
        if (this.generation === generation) {
          this.clientLatency.handleTransportSegmentSummary(conversationId, event);
        }
      },
    });
    const session = new AgentSession<WireMessage>({
      conversationId,
      connection: transport,
      isAuthoritativeMessage: isWireMessage,
      onProtocolError: (error) => this.reportLocalIssue(error),
      onCommandError: (error) => this.handleCommandDeliveryError(error, generation),
      onCommandAck: (ack) => this.handleCommandAck(ack, generation),
      onQueueSnapshot: (snapshot) =>
        this.handleQueueSnapshot(snapshot, generation),
    });
    this.transport = transport;
    this.session = session;
    this.conversationId = conversationId;
    this.bindRecoveryEnvironment();
    this.connectionState = transport.state;
    this.detachSession = session.subscribe((snapshot) => {
      if (this.generation !== generation || this.session !== session) return;
      this.handleSessionSnapshot(snapshot);
    });
    this.detachConnectionState = transport.addConnectionStateListener((state) => {
      if (this.generation !== generation || this.transport !== transport) return;
      this.connectionState = state;
      this.handleConnectionState(state);
    });
    this.recordLifecycle({
      code: "response_prepare_started",
      phase: "start",
      conversationId,
      ...(submittedLatency
        ? {
            requestId: submittedLatency.requestId,
            ...this.clientLatency.fields(submittedLatency.requestId),
          }
        : {}),
    });
    try {
      await transport.connect();
      if (this.generation !== generation) return;
      this.recordLifecycle({
        code: "response_prepare_completed",
        phase: "start",
        conversationId,
        ...(submittedLatency
          ? {
              requestId: submittedLatency.requestId,
              ...this.clientLatency.fields(submittedLatency.requestId),
            }
          : {}),
      });
      await this.pendingReconcile.catch(() => undefined);
    } catch (error) {
      if (this.generation !== generation) return;
      this.recordLifecycle({
        code: "response_prepare_failed",
        phase: "start",
        conversationId,
        ...(submittedLatency
          ? {
              requestId: submittedLatency.requestId,
              ...this.clientLatency.fields(submittedLatency.requestId),
            }
          : {}),
        status: responseStatus(error),
        retryable: true,
      });
      throw managedException(
        error,
        "response_start_failed",
        "SystemSculpt could not restore this chat. Retry in a moment.",
      );
    }
  }

  public async start(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.active && !this.active.terminal) {
      const failure = {
        code: "response_in_progress",
        message: "SystemSculpt is already working.",
        retryable: true,
      } as const;
      this.capturePreflightFailure(input.conversationId, input.turnId, failure, {
        failureStage: "submission_admission",
        failureMechanism: "concurrent_run",
      });
      return this.failedResult(input.turnId, failure);
    }
    try {
      await this.hydrate(input.conversationId, {
        requestId: input.turnId,
        startedAtMonotonicMs: input.clientStartedAtMonotonicMs,
      });
    } catch (error) {
      const normalized = managedError(
        error,
        "response_start_failed",
        "SystemSculpt could not start the response.",
      );
      this.reportLocalIssue(normalized);
      this.capturePreflightFailure(
        input.conversationId,
        input.turnId,
        normalized,
        {
          failureStage: "response_prepare",
          failureMechanism: incidentFailureMechanism(
            normalized,
            "transport_or_protocol_failure",
          ),
        },
        true,
      );
      return this.failedResult(input.turnId, normalized);
    }
    const session = this.session;
    if (!session || session.current.runState.state !== "idle") {
      const failure = {
        code: "response_in_progress",
        message: "The previous response is still active.",
        retryable: true,
      } as const;
      this.capturePreflightFailure(input.conversationId, input.turnId, failure, {
        failureStage: "submission_admission",
        failureMechanism: "concurrent_run",
      });
      return this.failedResult(input.turnId, failure);
    }
    const active = this.createActiveRun({
      origin: "submitted",
      conversationId: input.conversationId,
      requestId: input.turnId,
      turnId: input.turnId,
      approvalPolicy: input.approvalPolicy ?? {},
      clientStartedAtMonotonicMs: input.clientStartedAtMonotonicMs,
    });
    this.active = active;
    this.recordLifecycle({
      code: "run_started",
      phase: "response",
      conversationId: input.conversationId,
      requestId: input.turnId,
      ...this.clientLatency.fields(input.turnId),
    });
    this.publishActive(active, true);
    let requestDispatchStarted = false;
    try {
      let contextRef: string | undefined;
      if (input.buildBody) {
        const body = await input.buildBody(active.abort.signal);
        contextRef = body?.context_ref;
      }
      if (active.cancelRequested || active.abort.signal.aborted) {
        return await active.completion;
      }
      if (input.beforeSend) {
        const historySync = this.clientLatency.createHistorySyncCorrelation("before_send", this.conversationId);
        this.clientLatency.recordHistorySync("history_sync_started", historySync);
        try {
          await input.beforeSend();
          this.clientLatency.recordHistorySync("history_sync_completed", historySync);
        } catch (error) {
          this.clientLatency.recordHistorySync("history_sync_failed", historySync);
          this.reportLocalIssue(error);
        }
      }
      if (active.cancelRequested || active.abort.signal.aborted) {
        return await active.completion;
      }
      active.serverAdmissionPossible = true;
      this.recordLifecycle({
        code: "request_dispatch_started",
        phase: "response",
        conversationId: input.conversationId,
        requestId: input.turnId,
        ...this.clientLatency.fields(input.turnId),
      });
      requestDispatchStarted = true;
      const delivery = await session.submit({
        request_id: input.turnId,
        user_message: input.message,
        ...(contextRef ? { context_ref: contextRef } : {}),
      });
      const supersededByRecovery = active.streamSupersededByRecovery;
      active.streamSupersededByRecovery = false;
      this.recordLifecycle({
        code: "request_dispatch_returned",
        phase: "response",
        conversationId: input.conversationId,
        requestId: input.turnId,
        ...this.clientLatency.fields(input.turnId),
      });
      if (
        delivery === "sent"
        && !supersededByRecovery
        && this.isIncompleteSubmitBoundary(active, session)
      ) {
        this.clientLatency.recordMilestone(
          "response_stream_ended_incomplete",
          input.turnId,
          this.monotonicNow(),
          {
            retryable: true,
            failureCode: "turn_stream_incomplete",
          },
        );
        this.transport?.markUnsynchronized();
      }
    } catch (error) {
      const definitelyRejected = wasDefinitelyRejected(error);
      if (!active.terminal && definitelyRejected) {
        active.serverAdmissionPossible = false;
      }
      if (!active.terminal && active.cancelRequested && definitelyRejected) {
        this.finishLocalCancellation(active);
      } else if (!active.terminal && !active.cancelRequested) {
        const normalized = managedError(
          error,
          "response_start_failed",
          "SystemSculpt could not start the response.",
        );
        this.recordLifecycle({
          code: "request_dispatch_failed",
          phase: "response",
          conversationId: input.conversationId,
          requestId: input.turnId,
          retryable: normalized.retryable,
          ...this.clientLatency.fields(input.turnId),
        });
        this.finishLocalFailure(active, normalized, {
          failureStage: requestDispatchStarted
            ? "request_dispatch"
            : "context_prepare",
          failureMechanism: requestDispatchStarted
            ? incidentFailureMechanism(
                normalized,
                "transport_or_protocol_failure",
              )
            : "preparation_failure",
        });
      }
    }
    return active.completion;
  }

  public async stageContext(
    rootMessageId: string,
    measuredContext: MeasuredThinAgentContext,
    signal?: AbortSignal,
  ): Promise<ThinAgentContextResponse> {
    const conversationId = this.conversationId ?? undefined;
    this.recordLifecycle({
      code: "context_prepare_started",
      phase: "start",
      ...(conversationId ? { conversationId } : {}),
      requestId: rootMessageId,
      ...this.clientLatency.fields(rootMessageId),
    });
    try {
      const bootstrap = await this.issueBootstrap();
      // The view measured every source while reading it, against the limits
      // it knew then. Bootstrap may have just negotiated lower ones, so the
      // measured sizes are checked again here, before any upload. Re-running
      // the untrusted contract parser instead would re-encode every text
      // block and rescan every image. The server still validates the staged
      // request.
      if (!isThinAgentContextWithinLimits(measuredContext, bootstrap.client_input_limits)) {
        throw Object.assign(new Error("Selected vault context is too large."), {
          code: "context_too_large",
          retryable: false,
        });
      }
      const url = new URL(THIN_AGENT_CONTEXT_PATH, this.options.baseUrl);
      const request = {
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        root_message_id: rootMessageId,
        context_sources: measuredContext.sources,
      };
      const response = await this.requestClient.request({
        url: url.toString(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.access.token}`,
          "x-plugin-version": this.options.pluginVersion,
        },
        body: request,
        signal,
        allowTransportFallback: true,
        responseEncoding: "arrayBuffer",
        maxResponseBytes: MAX_CONTEXT_RESPONSE_BYTES,
      });
      if (response.status !== 201) {
        if (response.status === 401) this.transport?.invalidateBootstrap();
        const payload = boundedErrorPayload(await response.text());
        const fallback = response.status === 413
          ? "Selected vault context is too large."
          : response.status === 401
            ? "Your SystemSculpt session expired. Retry this message."
            : `SystemSculpt could not prepare vault context (${response.status}).`;
        throw Object.assign(new Error(fallback), {
          code: response.status === 413 ? "context_too_large" : "context_prepare_failed",
          status: response.status,
          retryable:
            response.status === 401 ||
            response.status === 429 ||
            response.status >= 500,
          ...(payload.incidentId ? { requestId: payload.incidentId } : {}),
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_CONTEXT_RESPONSE_BYTES) {
        throw new Error("The prepared vault context is too large to use safely.");
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      const context = parseThinAgentContextResponse(value);
      this.recordLifecycle({
        code: "context_prepare_completed",
        phase: "start",
        conversationId: bootstrap.conversation_id,
        requestId: rootMessageId,
        ...this.clientLatency.fields(rootMessageId),
      });
      return context;
    } catch (error) {
      const cancelled = signal?.aborted
        || (error instanceof DOMException && error.name === "AbortError");
      this.recordLifecycle({
        code: cancelled ? "context_prepare_cancelled" : "context_prepare_failed",
        phase: "start",
        ...(conversationId ? { conversationId } : {}),
        requestId: rootMessageId,
        status: responseStatus(error),
        retryable: !cancelled,
        ...this.clientLatency.fields(rootMessageId),
      });
      throw error;
    }
  }

  private failToolAuthorization(
    active: ActiveRun,
    code: "client_tool_identity_mismatch" | "approval_identity_mismatch",
    message: string,
  ): void {
    if (active.terminal) return;
    this.finishLocalFailure(active, { code, message, retryable: false }, {
      failureStage: "tool_authorization",
      failureMechanism: "identity_mismatch",
    });
  }

  private ensureToolIdentity(active: ActiveRun, call: LocalToolCall): boolean {
    if (active.authorization.observe(call)) return true;
    this.failToolAuthorization(active, "client_tool_identity_mismatch",
      "A vault action changed after it was presented.");
    return false;
  }

  private registerApprovalId(active: ActiveRun, callId: string, approvalId: string): boolean {
    if (active.authorization.bindApproval(callId, approvalId)) return true;
    this.failToolAuthorization(active, "approval_identity_mismatch",
      "A vault approval identity changed before execution.");
    return false;
  }

  private validateCurrentToolBindings(active: ActiveRun): boolean {
    const evidence = active.projectionOwner.inspect(active.projection);
    const requested = new Map<string, string>();
    for (const call of evidence.requests) {
      if (!this.ensureToolIdentity(active, call)) return false;
      requested.set(call.callId, call.name);
    }
    for (const binding of evidence.bindings) {
      const requestedName = requested.get(binding.callId);
      if (!requestedName) continue;
      if (binding.name !== requestedName || (binding.state !== "input-streaming"
        && !active.authorization.matches(binding))) {
        this.failToolAuthorization(active, "client_tool_identity_mismatch",
          "A vault action changed after it was presented.");
        return false;
      }
      if (binding.approval
        && !this.registerApprovalId(active, binding.callId, binding.approval.id)) return false;
    }
    return true;
  }

  public respondToApproval(
    approvalId: string,
    approved: boolean,
    source: "manual" | "policy" = "manual",
  ): boolean {
    const active = this.active;
    const session = this.session;
    if (!active || !session || active.terminal) return false;
    const callId = active.authorization.callForApproval(approvalId);
    if (!callId || active.authorization.state(callId).decision) return false;
    const tool = this.findCurrentTool(active, callId);
    if (!tool || (tool.part.state !== "approval-requested"
      && tool.part.state !== "input-available"
      && !(tool.part.state === "approval-responded"
        && toolApproval(tool.part)?.approved === true))) return false;
    if (!this.ensureToolIdentity(active, tool)) return false;
    const decision = active.authorization.decide(approvalId, approved, source);
    if (!decision) return false;
    this.recordLifecycle({
      code: approved
        ? source === "policy"
          ? "approval_submitted_approved_policy"
          : "approval_submitted_approved_manual"
        : "approval_submitted_denied",
      phase: "approval",
      conversationId: active.conversationId,
      requestId: active.requestId,
      toolName: tool.name,
      toolCallId: callId,
      ...this.clientLatency.fields(active.requestId),
    });
    const serverRequested = tool.part.state === "approval-requested";
    if (serverRequested) {
      const delivery: PendingApprovalDelivery = {
        decision: Object.freeze({
          ...decision,
          requestId: active.requestId,
          callId,
        }),
        attemptedOpenEpoch: null,
        inFlight: false,
        acknowledged: false,
        acknowledgementRecorded: false,
      };
      this.pendingApprovalDeliveries.set(callId, delivery);
      this.deliverPendingApproval(active, delivery);
    } else if (approved) {
      this.startLocalTool(active, tool);
    }
    this.publishActive(active, true);
    return true;
  }

  public async cancel(): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    active.cancelRequested = true;
    active.abort.abort();
    if (!active.serverAdmissionPossible) {
      this.finishLocalCancellation(active);
      return;
    }
    this.pendingCancelRequestId = active.requestId;
    this.publishActive(active, true);
    // Cancellation is a server-owned state transition. Keep the run open
    // until a terminal event or snapshot proves that the server stopped it.
    // An uncertain HTTP result leaves the stable cancel identity pending for
    // replay after synchronization.
    await this.trySendPendingCancel();
  }

  public async detach(): Promise<void> {
    const active = this.active;
    const toolTasks = active ? [...active.toolTasks.values()] : [];
    if (active && !active.terminal) {
      active.abort.abort();
      this.updateActiveElapsed(active);
      active.terminal = {
        version: 1,
        run_id: active.serverRunId ?? `run_${"0".repeat(32)}`,
        root_message_id: active.turnId,
        outcome: "cancelled",
        code: "cancelled",
      };
      this.reconcileLocalTerminalDuration(active, true);
      const snapshot = active.projectionOwner.present(
        active.projection, this.presentationFacts(active), "local-cancellation",
      );
      this.recordLifecycle({
        code: "run_finished_cancelled",
        phase: "response",
        conversationId: active.conversationId,
        requestId: active.requestId,
        ...(active.serverRunId ? { serverRunId: active.serverRunId } : {}),
        ...this.clientLatency.fields(active.requestId),
      });
      active.resolve({ kind: "cancelled", snapshot });
      this.active = null;
    }
    this.disconnect();
    // Detach is the conversation-switch barrier. Do not confirm it while an
    // outgoing tool, terminal persistence, or history callback can still
    // reach shared view state after the next conversation attaches.
    await Promise.allSettled(toolTasks);
    await this.pendingFinalization.catch(() => undefined);
    await this.options.mutationJournal.idle();
    await this.pendingReconcile.catch(() => undefined);
  }

  public disconnect(): void {
    this.generation += 1;
    this.clearRunStallTimer();
    this.clearResynchronization();
    this.detachRecoveryEnvironment?.();
    this.detachRecoveryEnvironment = null;
    this.resynchronizationInFlight = false;
    this.runStalled = false;
    this.stallRecovery = null;
    this.detachSession?.();
    this.detachConnectionState?.();
    this.detachSession = null;
    this.detachConnectionState = null;
    this.session?.dispose();
    this.session = null;
    this.transport?.close();
    this.transport = null;
    this.connectionState = "idle";
    this.conversationId = null;
    this.projection = new ConversationProjection();
    this.reconciledKey = null;
    this.pendingDeliveries.clear();
    this.pendingApprovalDeliveries.clear();
    this.pendingCancelRequestId = null;
    this.pendingCancelInFlight = false;
    this.clientLatency.clear();
  }

  private createActiveRun(input: Readonly<{
    origin: ActiveRun["origin"];
    conversationId: string;
    requestId: string;
    turnId: string;
    approvalPolicy: ToolApprovalPolicy;
    clientStartedAtMonotonicMs?: number;
  }>): ActiveRun {
    let resolve!: (result: AgentRunResult) => void;
    const completion = new Promise<AgentRunResult>((settle) => {
      resolve = settle;
    });
    const active: ActiveRun = {
      token: {},
      origin: input.origin,
      conversationId: input.conversationId,
      requestId: input.requestId,
      turnId: input.turnId,
      approvalPolicy: input.approvalPolicy,
      abort: new AbortController(),
      completion,
      resolve,
      executingToolIds: new Set(),
      projection: this.projection.beginTurn(input, input.approvalPolicy),
      projectionOwner: this.projection,
      settledToolIds: new Set(),
      acknowledgedClientContinuationIds: new Set(),
      authorization: new VaultActionAuthorization(),
      toolTasks: new Map(),
      phase: input.origin === "recovered" ? "retrying" : "submitted",
      label: input.origin === "recovered" ? "Recovering" : "Starting",
      serverRunId: null,
      terminal: null,
      finalizing: false,
      cancelRequested: false,
      serverAdmissionPossible: input.origin === "recovered",
      serverQueued: false,
      streamSupersededByRecovery: false,
      elapsedMs: null,
    };
    if (input.origin === "submitted") {
      this.clientLatency.ensure({
        conversationId: input.conversationId,
        requestId: input.requestId,
        startedAtMonotonicMs: input.clientStartedAtMonotonicMs,
      });
    }
    return active;
  }

  private updateActiveElapsed(active: ActiveRun): void {
    if (active.terminal) return;
    const elapsedMs = this.clientLatency.elapsed(active.conversationId, active.requestId);
    if (elapsedMs === null || !Number.isFinite(elapsedMs)) return;
    active.elapsedMs = Math.max(0, Math.round(elapsedMs));
  }

  private reconcileLocalTerminalDuration(active: ActiveRun, restoreTail = false): void {
    if (active.elapsedMs === null || !this.options.reconcileHistory) return;
    const history = active.projectionOwner.history({
      kind: "local-interruption", turn: active.projection,
      terminal: active.terminal ?? undefined, elapsedMs: active.elapsedMs,
      restoreTail, now: this.now(),
    });
    void this.reconcileMessages(history, "terminal").catch(() => undefined);
  }

  private isIncompleteSubmitBoundary(
    active: ActiveRun,
    session: AgentSession<WireMessage>,
  ): boolean {
    if (this.active?.token !== active.token || active.terminal) return false;
    const snapshot = session.current;
    if (
      snapshot.runState.state === "waiting_for_client"
      && snapshot.runState.request_id === active.requestId
    ) return false;
    if (snapshot.queuedRequestIds.includes(active.requestId)
      || snapshot.cancelledQueuedRequestIds.includes(active.requestId)) return false;
    return true;
  }

  private handleSessionSnapshot(snapshot: AgentSessionSnapshot<WireMessage>): void {
    // The server itself reports whose turn it is. A projected phase cannot
    // stand in for that: between the run entering waiting_for_client and the
    // tool part rendering, the projection still reads as "thinking".
    this.awaitingClientWork = snapshot.runState.state === "waiting_for_client";
    // A reconnect temporarily projects the last known run as `unknown` while
    // the replacement snapshot is loading. That transport-only transition is
    // not server progress and must not cancel recovery for the dead stream.
    if (snapshot.runState.state !== "unknown") {
      const progressKey = runProgressKey(snapshot);
      if (progressKey !== this.runProgressKey) {
        this.runProgressKey = progressKey;
        this.noteServerProgress();
      }
    }
    // A terminal may still be persisting after disconnect replaced the live
    // conversation. Its old owner remains with the finalization task; fresh
    // authority must not adopt that owner's turn handle or retained overlays.
    const projecting = this.active?.projectionOwner === this.projection ? this.active : null;
    this.projection.observe(snapshot, projecting?.projection ?? null);
    const runState = snapshot.runState;
    let active = this.active;
    if (active) this.reconcileAcknowledgedContinuations(active);
    if (snapshot.terminal && active
      && snapshot.terminal.request_id === active.requestId) {
      this.acceptTerminal(active, snapshot.terminal.value, "session_terminal");
      return;
    }
    if (active && !active.terminal) {
      const persistedTerminal = active.projectionOwner.inspect(
        active.projection, "authoritative", active.serverRunId,
      ).terminal;
      if (persistedTerminal) {
        this.acceptTerminal(active, persistedTerminal, "message_reconstruction");
        return;
      }
    }
    if (
      active
      && snapshot.cancelledQueuedRequestIds.includes(active.requestId)
    ) {
      if (this.pendingCancelRequestId === active.requestId) {
        this.pendingCancelRequestId = null;
      }
      void this.reconcileMessages(this.projection.history({ kind: "presentation", now: this.now() }), "cancelled_queue")
        .catch(() => undefined);
      this.finishLocalCancellation(active);
      return;
    }
    if (
      active
      && active.serverRunId === null
      && (
        snapshot.queuedRequestIds.includes(active.requestId)
        || this.pendingCancelRequestId === active.requestId
      )
    ) {
      active.serverQueued = true;
      active.phase = "submitted";
      active.label = this.pendingCancelRequestId === active.requestId
        ? "Stopping"
        : "Queued";
    }
    if (runState.state === "running" || runState.state === "waiting_for_client") {
      if (!active) {
        active = this.createActiveRun({
          origin: "recovered",
          conversationId: this.conversationId!,
          requestId: runState.request_id,
          turnId: runState.root_message_id,
          approvalPolicy: {},
        });
        this.active = active;
        this.recordLifecycle({
          code: "run_started",
          phase: "response",
          conversationId: active.conversationId,
          requestId: active.requestId,
          serverRunId: runState.run_id,
        });
      }
      if (
        active.requestId !== runState.request_id
        || active.turnId !== runState.root_message_id
      ) {
        if (!active.serverQueued) {
          this.finishLocalFailure(active, {
            code: "response_state_mismatch",
            message: "SystemSculpt returned a mismatched response state.",
            retryable: true,
          }, {
            failureStage: "run_state_reconciliation",
            failureMechanism: "state_mismatch",
          });
          return;
        }
      } else {
        active.serverRunId = runState.run_id;
        active.serverQueued = false;
        active.phase = runState.state === "waiting_for_client" ? "waiting" : "working";
      }
    }
    if (
      active
      && !active.terminal
      && active.projectionOwner.inspect(active.projection).hasAssistant
    ) {
      this.clientLatency.recordMilestone(
        "response_first_assistant_snapshot_received",
        active.requestId,
        this.monotonicNow(),
      );
    }
    if (active?.serverQueued) {
      this.publishActive(active);
      void this.trySendPendingCancel();
      this.scheduleResynchronization(active);
      return;
    }
    this.reconcileAuthoritativePrefix(active);
    if (active && !active.terminal) {
      this.publishActive(active);
      void this.retryPendingDeliveries(active);
      this.retryPendingApprovals(active);
      this.processClientTools(active, runState.state === "waiting_for_client");
    } else if (runState.state === "idle") {
      this.publishHydratedTail();
    }
    void this.trySendPendingCancel();
  }

  private handleQueueSnapshot(
    snapshot: AgentQueueSnapshotEvent,
    generation: number,
  ): void {
    if (
      generation !== this.generation
      || this.conversationId !== snapshot.conversation_id
    ) return;
    const active = this.active;
    if (
      !active
      || active.terminal
      || active.serverRunId !== null
      || !snapshot.queue.items.some((item) =>
        item.request_id === active.requestId)
    ) return;
    active.serverQueued = true;
    active.phase = "submitted";
    active.label = "Queued";
    this.publishActive(active, true);
    void this.trySendPendingCancel();
  }

  private handleCommandDeliveryError(error: Error, generation: number): void {
    const normalized = managedError(
      error,
      "response_start_failed",
      "SystemSculpt could not start the response.",
    );
    const billingFailure = isAgentBillingFailure(normalized);
    const active = this.active;
    if (
      !billingFailure
      || generation !== this.generation
      || !active
      || active.terminal
    ) {
      this.reportLocalIssue(error);
      return;
    }
    active.serverAdmissionPossible = false;
    this.finishLocalFailure(active, normalized, {
      failureStage: "request_dispatch",
      failureMechanism: incidentFailureMechanism(
        normalized,
        "transport_or_protocol_failure",
      ),
    });
  }

  private handleCommandAck(
    ack: AgentCommandAckEvent,
    generation: number,
  ): void {
    if (
      generation !== this.generation
      || this.conversationId !== ack.conversation_id
      || ack.status !== "accepted"
    ) return;
    const session = this.session;
    const active = this.active;
    if (!session || !active || active.requestId !== ack.request_id) return;
    const commandSegmentOrdinal = this.clientLatency.commandAckSegmentOrdinal(
      active.requestId, ack.command_kind, "tool_call_id" in ack ? ack.tool_call_id : null,
    );
    if (ack.command_kind === "cancel") {
      // The acknowledgement confirms delivery, not the final outcome. A stale
      // queued projection can race with an already persisted terminal. Wait
      // for the preceding snapshot, a later resynchronization, or a terminal.
      return;
    }
    if (ack.command_kind === "client_tool_approval") {
      const pending = this.pendingApprovalDeliveries.get(ack.tool_call_id);
      if (!pending || pending.decision.requestId !== ack.request_id) return;
      if (
        !pending.inFlight
        || pending.attemptedOpenEpoch !== this.openEpoch
      ) return;
      pending.acknowledged = true;
      active.acknowledgedClientContinuationIds.add(ack.tool_call_id);
      if (!pending.acknowledgementRecorded) {
        pending.acknowledgementRecorded = true;
        const tool = this.findCurrentTool(active, ack.tool_call_id);
        this.recordLifecycle({
          code: pending.decision.approved
            ? "approval_acknowledged_approved"
            : "approval_acknowledged_denied",
          phase: "approval",
          conversationId: active.conversationId,
          requestId: active.requestId,
          ...(tool?.name ? { toolName: tool.name } : {}),
          toolCallId: ack.tool_call_id,
          ...this.clientLatency.fields(
            active.requestId,
            this.monotonicNow(),
            commandSegmentOrdinal,
          ),
        });
      }
      this.reconcileAcknowledgedContinuations(active);
      return;
    }

    if (ack.command_kind === "client_tool_result") {
      const pending = this.pendingDeliveries.get(ack.tool_call_id);
      if (!pending || pending.requestId !== ack.request_id) return;
      if (
        !pending.inFlight
        || pending.attemptedOpenEpoch !== this.openEpoch
      ) return;
      pending.acknowledged = true;
      active.settledToolIds.add(ack.tool_call_id);
      active.acknowledgedClientContinuationIds.add(ack.tool_call_id);
      if (!pending.acknowledgementRecorded) {
        pending.acknowledgementRecorded = true;
        this.recordLifecycle({
          code: pending.state === "output-available"
            ? "tool_result_acknowledged_succeeded"
            : "tool_result_acknowledged_failed",
          phase: "tool_execution",
          conversationId: active.conversationId,
          requestId: active.requestId,
          toolName: pending.call.name,
          toolCallId: ack.tool_call_id,
          ...(pending.toolExecutionOrdinal === undefined
            ? {}
            : { toolExecutionOrdinal: pending.toolExecutionOrdinal }),
          ...this.clientLatency.fields(
            active.requestId,
            this.monotonicNow(),
            commandSegmentOrdinal,
          ),
        });
      }
      this.reconcileAcknowledgedContinuations(active);
    }
  }

  private handleConnectionState(state: AgentConnectionState): void {
    const active = this.active;
    if (state === "open") {
      // Keep the backoff across a snapshot-only recovery cycle. Authoritative
      // run progress resets it; repeated command failures must not poll rapidly.
      this.clearResynchronization(false);
      this.openEpoch += 1;
      this.recordLifecycle({
        code: "session_opened",
        phase: "session",
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      });
      void this.trySendPendingCancel();
      if (active) {
        void this.retryPendingDeliveries(active);
        this.retryPendingApprovals(active);
        this.processClientTools(
          active,
          this.session?.current.runState.state === "waiting_for_client",
        );
      }
    } else if (state === "closed") {
      this.recordLifecycle({
        code: "session_closed",
        phase: "session",
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
      });
      if (active && !active.terminal && (
        !active.cancelRequested
        || this.pendingCancelRequestId === active.requestId
      )) {
        this.scheduleResynchronization(active);
      }
    }
    if (active && !active.terminal) this.publishActive(active, true);
  }

  private recoveryIsOnline(): boolean {
    return this.recoveryWindow.navigator?.onLine !== false;
  }

  private recoveryIsVisible(): boolean {
    return this.recoveryWindow.document?.visibilityState !== "hidden"
      && (this.options.recoveryEnvironment?.isVisible() ?? true);
  }

  private bindRecoveryEnvironment(): void {
    this.recoveryWindow = this.options.recoveryEnvironment?.ownerWindow() ?? window;
    let detachOwner = () => {};
    let online = this.recoveryIsOnline();
    let visible = this.recoveryIsVisible();
    const refresh = () => {
      const owner = this.options.recoveryEnvironment?.ownerWindow() ?? window;
      const migrated = this.recoveryWindow !== owner;
      if (migrated) {
        this.clearResynchronizationTimer();
        this.recoveryWindow = owner;
        bindOwner();
      }
      const nextOnline = this.recoveryIsOnline();
      const nextVisible = this.recoveryIsVisible();
      const changed = migrated || nextOnline !== online || nextVisible !== visible;
      const resume = nextOnline && nextVisible && (!online || !visible || migrated);
      online = nextOnline;
      visible = nextVisible;
      if (!changed || !this.resynchronizationPending) return;
      this.clearResynchronizationTimer();
      if (this.active) this.scheduleResynchronization(this.active, resume);
    };
    const bindOwner = () => {
      detachOwner();
      const owner = this.recoveryWindow;
      owner.addEventListener?.("online", refresh);
      owner.addEventListener?.("offline", refresh);
      owner.document?.addEventListener("visibilitychange", refresh);
      detachOwner = () => {
        owner.removeEventListener?.("online", refresh);
        owner.removeEventListener?.("offline", refresh);
        owner.document?.removeEventListener("visibilitychange", refresh);
      };
    };
    bindOwner();
    const detachSurface = this.options.recoveryEnvironment?.subscribe(refresh);
    refresh();
    this.detachRecoveryEnvironment = () => {
      detachSurface?.();
      detachOwner();
    };
  }

  private scheduleResynchronization(active: ActiveRun, immediate = false): void {
    const transport = this.transport;
    if (
      !transport
      || this.active?.token !== active.token
      || active.terminal
      || (active.cancelRequested
        && this.pendingCancelRequestId !== active.requestId)
    ) return;
    this.resynchronizationPending = true;
    if (
      !this.recoveryIsOnline()
      || this.resynchronizationTimer !== null
      || this.resynchronizationInFlight
    ) return;

    // Only actual attempts advance backoff. Hiding a view or going offline must
    // not count as a failed request, and snapshot-only success must not reset it.
    const attempt = this.resynchronizationAttempt;
    const exponentialDelay = Math.min(
      2_000 * (2 ** attempt),
      MAX_RESYNCHRONIZATION_DELAY_MS,
    );
    const configuredDelay = this.options.resynchronizationDelayMs
      ? this.options.resynchronizationDelayMs(attempt)
      : exponentialDelay * (0.5 + Math.random() * 0.5);
    let delay = immediate ? 0 : Number.isFinite(configuredDelay)
      ? Math.max(0, Math.min(configuredDelay, MAX_RESYNCHRONIZATION_DELAY_MS))
      : MAX_RESYNCHRONIZATION_DELAY_MS;
    if (!this.recoveryIsVisible()) delay = Math.max(delay, HIDDEN_RESYNCHRONIZATION_DELAY_MS);
    const generation = this.generation;
    this.resynchronizationTimer = this.recoveryWindow.setTimeout(() => {
      this.resynchronizationTimer = null;
      if (
        this.generation !== generation
        || this.transport !== transport
        || this.active?.token !== active.token
        || active.terminal
        || (active.cancelRequested
          && this.pendingCancelRequestId !== active.requestId)
      ) return;
      if (!this.recoveryIsOnline()) return;
      if (!this.recoveryIsVisible() && delay < HIDDEN_RESYNCHRONIZATION_DELAY_MS) {
        this.scheduleResynchronization(active);
        return;
      }
      const stallRecovery = this.currentStallRecovery(active);
      if (stallRecovery) active.streamSupersededByRecovery = true;
      this.resynchronizationAttempt += 1;
      this.resynchronizationInFlight = true;
      void (stallRecovery ? transport.forceReconnect() : transport.connect())
        .catch((error) => this.reportLocalIssue(error))
        .finally(() => {
          if (this.generation !== generation || this.transport !== transport) return;
          this.resynchronizationInFlight = false;
          if (
            this.currentStallRecovery(active)
            || transport.state !== "open"
          ) this.scheduleResynchronization(active);
        });
    }, delay);
  }

  private currentStallRecovery(active: ActiveRun): StallRecovery | null {
    const recovery = this.stallRecovery;
    return recovery
      && recovery.runToken === active.token
      && recovery.progressKey === this.runProgressKey
      && this.runStalled
      && this.active?.token === active.token
      && !active.terminal
      ? recovery
      : null;
  }

  private clearResynchronizationTimer(): void {
    if (this.resynchronizationTimer === null) return;
    this.recoveryWindow.clearTimeout(this.resynchronizationTimer);
    this.resynchronizationTimer = null;
  }

  private clearResynchronization(resetAttempt = true): void {
    this.clearResynchronizationTimer();
    this.resynchronizationPending = false;
    if (resetAttempt) this.resynchronizationAttempt = 0;
  }

  /**
   * Arms the run-liveness bound whenever the presentation claims the server is
   * working. Deliberately keyed on the projected phase: "waiting" covers
   * approval and local tool execution, which the user bounds, and "retrying"
   * covers connection trouble, which the connection watchdog already owns.
   */
  private syncRunStallWatchdog(snapshot: AgentConversationSnapshot): void {
    const clientOwnsWait = this.awaitingClientWork
      && !this.clientContinuationAwaitingServer();
    const awaitingServer = !this.runStalled
      && !clientOwnsWait
      && (snapshot.phase === "thinking" || snapshot.phase === "working");
    if (!awaitingServer) {
      this.clearRunStallTimer();
      return;
    }
    if (this.runStallTimer !== null) return;
    const generation = this.generation;
    this.runStallTimer = window.setTimeout(() => {
      this.runStallTimer = null;
      if (this.generation !== generation) return;
      const current = this.active;
      if (!current || current.terminal) return;
      this.runStalled = true;
      this.stallRecovery = {
        runToken: current.token,
        progressKey: this.runProgressKey,
      };
      this.reportLocalIssue(new Error(
        "The agent run produced no server activity for "
          + `${this.runStallGraceMs()}ms while the connection was healthy `
          + `(conversation ${this.conversationId ?? "unknown"}, `
          + `request ${current.requestId}, run ${current.serverRunId ?? "unassigned"}).`,
      ));
      this.recordLifecycle({
        code: "run_stalled",
        phase: "response",
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        requestId: current.requestId,
        ...(current.serverRunId ? { serverRunId: current.serverRunId } : {}),
        retryable: true,
      });
      this.publishActive(current, true);
      this.scheduleResynchronization(current);
    }, this.runStallGraceMs());
  }

  /**
   * `waiting_for_client` names the protocol boundary, not permanent ownership.
   * Once the current vault call's result or approval has been dispatched, the
   * client has answered and the server owns the next state transition. Older
   * settled calls cannot mask a newer approval or local execution because only
   * the final current vault call is considered here.
   */
  private clientContinuationAwaitingServer(): boolean {
    const active = this.active;
    if (!active || active.terminal) return false;
    const tools = active.projectionOwner.inspect(active.projection).tools
      .filter((tool) => tool.location === "vault");
    const current = tools[tools.length - 1];
    if (!current || active.executingToolIds.has(current.callId)) return false;
    const result = this.pendingDeliveries.get(current.callId);
    if (result?.requestId === active.requestId
      && (result.inFlight || result.attemptedOpenEpoch !== null)) return true;
    const approval = this.pendingApprovalDeliveries.get(current.callId);
    if (approval?.decision.requestId === active.requestId
      && (approval.inFlight || approval.attemptedOpenEpoch !== null)) return true;
    return active.acknowledgedClientContinuationIds.has(current.callId)
      || active.settledToolIds.has(current.callId);
  }

  private runStallGraceMs(): number {
    return this.options.runStallGraceMs ?? RUN_STALL_GRACE_MS;
  }

  private clearRunStallTimer(): void {
    if (this.runStallTimer === null) return;
    window.clearTimeout(this.runStallTimer);
    this.runStallTimer = null;
  }

  /**
   * Authoritative content moved, so the run is demonstrably alive. A new
   * synchronization alone must not count. Repeated snapshot reads during a stalled
   * run must not reset the bound or hide the failure.
   */
  private noteServerProgress(): void {
    const recoveringFromStall = this.stallRecovery !== null;
    this.stallRecovery = null;
    if (recoveringFromStall) this.clearResynchronization();
    else this.resynchronizationAttempt = 0;
    const wasStalled = this.runStalled;
    this.runStalled = false;
    this.clearRunStallTimer();
    if (!wasStalled) return;
    const active = this.active;
    if (active && !active.terminal) this.publishActive(active, true);
  }

  private processClientTools(active: ActiveRun, canSend: boolean): void {
    if (!canSend || active.terminal || active.cancelRequested) return;
    if (!this.validateCurrentToolBindings(active)) return;
    for (const tool of active.projectionOwner.inspect(active.projection).clientTools) {
      const callId = tool.callId;
      if (tool.location !== "vault") continue;
      const state = tool.part.state;
      if (state === "input-streaming") continue;
      if (!this.ensureToolIdentity(active, tool)) return;
      if (!this.reconcilePendingApproval(active, tool)) return;
      if (isAuthoritativeTerminalToolPart(tool.part)) {
        active.settledToolIds.add(callId);
        continue;
      }
      if (
        active.settledToolIds.has(callId)
        || active.toolTasks.has(callId)
        || this.pendingDeliveries.has(callId)
      ) continue;
      const approval = toolApproval(tool.part);
      if (approval?.id && !this.registerApprovalId(active, callId, approval.id)) return;
      if (state === "approval-requested") {
        if (!active.authorization.state(callId).approvalId
          && !this.registerApprovalId(active, callId, `approval:${callId}`)) return;
        if (!active.authorization.state(callId).decision) {
          this.recordLifecycle({
            code: "approval_presented",
            phase: "approval",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: tool.name,
            toolCallId: callId,
            ...this.clientLatency.fields(active.requestId),
          });
          if (!requiresUserApproval(tool.name, active.approvalPolicy)) {
            this.respondToApproval(active.authorization.state(callId).approvalId!, true, "policy");
          }
          continue;
        }
        continue;
      }
      if (state === "approval-responded") {
        if (approval?.approved === false) {
          active.settledToolIds.add(callId);
          continue;
        }
        if (approval?.approved !== true) continue;
        if (isMutatingTool(tool.name) && !active.authorization.state(callId).decision) {
          if (active.origin === "recovered") {
            // A completed local journal receipt can safely replay its result
            // after reload. startLocalTool uses an inspect-only path here and
            // fails closed before any new mutation when no receipt exists.
            this.startLocalTool(active, tool);
            continue;
          }
          if (requiresUserApproval(tool.name, active.approvalPolicy)) {
            this.failToolAuthorization(
              active,
              "approval_identity_mismatch",
              "This vault action has no matching local approval.",
            );
            return;
          }
          if (!this.respondToApproval(active.authorization.state(callId).approvalId!, true, "policy")) return;
          continue;
        }
        if (!active.authorization.allows(tool)) {
          this.failToolAuthorization(
            active,
            "approval_identity_mismatch",
            "This vault action has no matching local approval.",
          );
          return;
        }
        this.startLocalTool(active, tool);
        continue;
      }
      if (state === "input-available") {
        if (isMutatingTool(tool.name)) {
          const approvalId = active.authorization.state(callId).approvalId ?? `approval:${callId}`;
          if (!this.registerApprovalId(active, callId, approvalId)) return;
          const decision = active.authorization.state(callId).decision;
          if (!decision && !requiresUserApproval(tool.name, active.approvalPolicy)) {
            if (!this.respondToApproval(approvalId, true, "policy")) return;
            continue;
          }
          if (!decision) continue;
          if (!decision.approved) continue;
          if (!active.authorization.allows(tool)) {
            this.failToolAuthorization(
              active,
              "approval_identity_mismatch",
              "This vault action changed after local approval.",
            );
            return;
          }
        }
        this.startLocalTool(active, tool);
      }
    }
    this.publishActive(active);
  }

  private reconcilePendingApproval(active: ActiveRun, tool: ProjectedTool): boolean {
    const candidate = this.pendingApprovalDeliveries.get(tool.callId);
    const pending = candidate?.decision.requestId === active.requestId
      ? candidate
      : undefined;
    const local = active.authorization.state(tool.callId).decision;
    if (
      (local || pending) && !active.authorization.matches(tool)
    ) {
      this.failToolAuthorization(
        active,
        "approval_identity_mismatch",
        "This vault action changed after local approval.",
      );
      return false;
    }
    const approval = toolApproval(tool.part);
    const acknowledged = typeof approval?.approved === "boolean"
      ? approval.approved
      : tool.part.state === "output-denied"
        ? false
        : tool.part.state === "output-available" || tool.part.state === "output-error"
          ? true
          : undefined;
    if (acknowledged === undefined) return true;
    const localDecision = pending?.decision.approved ?? local?.approved;
    if (
      (localDecision !== undefined && acknowledged !== localDecision)
      || (
        acknowledged
        && localDecision === undefined
        && active.origin !== "recovered"
        && requiresUserApproval(tool.name, active.approvalPolicy)
      )
    ) {
      this.finishLocalFailure(active, {
        code: "approval_state_mismatch",
        message: "SystemSculpt returned a mismatched approval state.",
        retryable: false,
      }, {
        failureStage: "approval_reconciliation",
        failureMechanism: "state_mismatch",
      });
      return false;
    }
    // The assistant projection proves the decision is durable, not that the
    // matching command acknowledgement reached this response stream. Keep the
    // exact idempotent delivery until its explicit ACK arrives so a failed
    // stream can safely replay it without re-running local work.
    return true;
  }

  private deliverPendingApproval(
    active: ActiveRun,
    delivery: PendingApprovalDelivery,
  ): void {
    const session = this.session;
    if (
      !session
      || this.active?.token !== active.token
      || active.terminal
      || this.connectionState !== "open"
      || this.pendingApprovalDeliveries.get(delivery.decision.callId) !== delivery
      || delivery.inFlight
      || delivery.attemptedOpenEpoch === this.openEpoch
      || session.current.runState.state !== "waiting_for_client"
      || session.current.runState.request_id !== delivery.decision.requestId
    ) return;
    const tool = this.findCurrentTool(active, delivery.decision.callId);
    if (!tool || tool.location !== "vault") return;
    if (!this.reconcilePendingApproval(active, tool)) return;
    const replayingDurableDenial = delivery.decision.approved === false
      && (tool.part.state === "output-denied"
        || (tool.part.state === "approval-responded"
          && toolApproval(tool.part)?.approved === false));
    if (this.pendingApprovalDeliveries.get(delivery.decision.callId) !== delivery
      || (tool.part.state !== "approval-requested" && !replayingDurableDenial)) return;

    const attemptedEpoch = this.openEpoch;
    delivery.attemptedOpenEpoch = attemptedEpoch;
    delivery.acknowledged = false;
    delivery.inFlight = true;
    this.publishActive(active, true);
    void session.sendToolApproval({
      request_id: delivery.decision.requestId,
      tool_call_id: delivery.decision.callId,
      approved: delivery.decision.approved,
    }).then(() => {
      this.reconcileAcknowledgedContinuations(active);
      // forceReconnect retires an older reader only after the replacement
      // snapshot lands. Its stale promise resolves intentionally, so only the
      // same open epoch can treat that resolution as a clean command stream.
      if (this.openEpoch !== attemptedEpoch) return;
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingApprovalDeliveries.get(delivery.decision.callId) === delivery
      ) {
        // ACK is a delivery milestone, not continuation authority. A clean EOF
        // is safe only after the matching decision also appears in the
        // authoritative projection. Otherwise retain the exact decision and
        // obtain a fresh snapshot before replaying it through bounded backoff.
        delivery.attemptedOpenEpoch = null;
        this.transport?.markUnsynchronized();
      }
    }).catch((error) => {
      this.reconcileAcknowledgedContinuations(active);
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingApprovalDeliveries.get(delivery.decision.callId) === delivery
      ) {
        delivery.attemptedOpenEpoch = null;
        this.reportLocalIssue(error);
      }
    }).finally(() => {
      delivery.inFlight = false;
      if (this.active?.token === active.token && !active.terminal) {
        this.publishActive(active, true);
      }
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingApprovalDeliveries.get(delivery.decision.callId) === delivery
        && this.openEpoch !== attemptedEpoch
      ) {
        this.deliverPendingApproval(active, delivery);
      }
    });
  }

  private retryPendingApprovals(active: ActiveRun): void {
    if (
      this.connectionState !== "open"
      || this.session?.current.runState.state !== "waiting_for_client"
    ) return;
    for (const delivery of this.pendingApprovalDeliveries.values()) {
      if (delivery.decision.requestId !== active.requestId) continue;
      this.deliverPendingApproval(active, delivery);
    }
  }

  private startLocalTool(active: ActiveRun, tool: ProjectedTool): void {
    if (
      this.active?.token !== active.token
      || active.terminal
      || active.toolTasks.has(tool.callId)
      || active.settledToolIds.has(tool.callId)
      || this.pendingDeliveries.has(tool.callId)
    ) return;
    if (!this.ensureToolIdentity(active, tool)) return;
    const replayOnly = !active.authorization.allows(tool);
    if (replayOnly && !isMutatingTool(tool.name)) {
      this.failToolAuthorization(
        active,
        "approval_identity_mismatch",
        "This vault action has no matching local approval.",
      );
      return;
    }
    const call: LocalToolCall = {
      callId: tool.callId,
      name: tool.name,
      input: tool.input,
    };
    const toolExecutionOrdinal = this.clientLatency.ensureToolExecutionOrdinal(active, call.callId);
    active.executingToolIds.add(call.callId);
    this.recordLifecycle({
      code: "local_tool_started",
      phase: "tool_execution",
      conversationId: active.conversationId,
      requestId: active.requestId,
      toolName: call.name,
      toolCallId: call.callId,
      ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      ...this.clientLatency.fields(active.requestId),
    });
    this.publishActive(active, true);
    const task = this.executeLocalTool(active, call, replayOnly)
      .catch(this.reportLocalIssue.bind(this))
      .finally(() => {
        active.executingToolIds.delete(call.callId);
        active.toolTasks.delete(call.callId);
        if (this.active?.token === active.token && !active.terminal) {
          this.publishActive(active, true);
        }
      });
    active.toolTasks.set(call.callId, task);
  }

  private isCallAuthorizedImmediatelyBeforeExecution(
    active: ActiveRun,
    call: LocalToolCall,
  ): boolean {
    if (this.active?.token !== active.token || active.terminal || active.abort.signal.aborted) {
      return false;
    }
    const current = this.findCurrentTool(active, call.callId);
    if (
      !current
      || current.location !== "vault"
      || !active.authorization.matches(current)
      || !this.ensureToolIdentity(active, call)
      || !active.authorization.allows(call)
    ) {
      this.failToolAuthorization(
        active,
        "approval_identity_mismatch",
        "This vault action changed before execution.",
      );
      return false;
    }
    return true;
  }

  private async executeLocalTool(
    active: ActiveRun,
    call: LocalToolCall,
    replayOnly = false,
  ): Promise<void> {
    const toolExecutionOrdinal = this.clientLatency.ensureToolExecutionOrdinal(active, call.callId);
    let result: ToolCallResult;
    let presentationResult: ToolCallResult;
    let delivery: PendingToolDelivery;
    try {
      if (isMutatingTool(call.name)) {
        const claim = replayOnly
          ? await this.options.mutationJournal.inspect(
            active.conversationId,
            call.callId,
            call.name,
            call.input,
          )
          : await this.options.mutationJournal.claim(
            active.conversationId,
            call.callId,
            call.name,
            call.input,
          );
        if (claim.kind === "absent"
          || (replayOnly && claim.kind === "journal-unavailable")) {
          this.failToolAuthorization(
            active,
            "approval_identity_mismatch",
            "This vault action has no matching local approval.",
          );
          return;
        }
        if (claim.kind === "replay") {
          this.recordLifecycle({
            code: "mutation_replay_served",
            phase: "mutation_journal",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = claim.result as ToolCallResult;
        } else if (claim.kind === "outcome-unknown") {
          this.recordLifecycle({
            code: "mutation_outcome_unknown",
            phase: "mutation_journal",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = {
            success: false,
            error: {
              code: "TOOL_PREVIOUS_OUTCOME_UNKNOWN",
              message: "This vault action started previously, so it was not repeated automatically.",
            },
          };
        } else if (claim.kind === "conflict") {
          this.recordLifecycle({
            code: "mutation_call_conflict",
            phase: "mutation_journal",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = {
            success: false,
            error: {
              code: "TOOL_CALL_ID_CONFLICT",
              message: "This vault action could not be matched safely.",
            },
          };
        } else if (claim.kind === "journal-unavailable") {
          result = {
            success: false,
            error: {
              code: "TOOL_MUTATION_JOURNAL_UNAVAILABLE",
              message: "Vault changes are blocked because the mutation safety journal is unavailable.",
            },
          };
        } else {
          this.recordLifecycle({
            code: "mutation_execute_claimed",
            phase: "mutation_journal",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: call.name,
            toolCallId: call.callId,
          });
          if (!this.isCallAuthorizedImmediatelyBeforeExecution(active, call)) return;
          result = outputAsToolResult(
            toJsonValue(await this.options.executeLocalTool(call, active.abort.signal)),
          );
          try {
            await this.options.mutationJournal.complete(
              active.conversationId,
              call.callId,
              call.name,
              call.input,
              result,
            );
          } catch (error) {
            this.reportLocalIssue(error);
            this.recordLifecycle({
              code: "mutation_outcome_unknown",
              phase: "mutation_journal",
              conversationId: active.conversationId,
              requestId: active.requestId,
              toolName: call.name,
              toolCallId: call.callId,
            });
            result = {
              success: false,
              error: {
                code: "TOOL_MUTATION_OUTCOME_UNKNOWN",
                message: "The vault action returned, but its safety receipt could not be saved. Its outcome is unknown.",
              },
            };
          }
        }
      } else {
        result = outputAsToolResult(
          toJsonValue(await this.options.executeLocalTool(call, active.abort.signal)),
        );
      }
      const toolFailureClass = safeToolFailureClass(result);
      const toolCounts = countLocalToolOutcome(
        result.data,
        localToolOutcomeSchema(call.name),
      );
      result = safeOutboundVaultToolResult(result);
      presentationResult = result;
      const requestedItemCount = toolRequestedItemCount(call);
      this.recordLifecycle({
        code: result.success
          ? "local_tool_completed_succeeded"
          : "local_tool_completed_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: call.name,
        toolCallId: call.callId,
        toolOutcome: result.success ? "succeeded" : "failed",
        ...(result.success ? {} : { toolFailureClass }),
        ...(requestedItemCount === undefined
          ? {}
          : { toolItemCount: requestedItemCount }),
        toolCompletedItemCount: toolCounts.completed,
        toolFailedItemCount: toolCounts.failed,
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
        ...this.clientLatency.fields(active.requestId),
      });
      delivery = {
        requestId: active.requestId,
        call,
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
        state: "output-available",
        output: toJsonValue(result),
        attemptedOpenEpoch: null,
        inFlight: false,
        acknowledged: false,
        acknowledgementRecorded: false,
      };
    } catch {
      if (active.abort.signal.aborted || active.terminal) return;
      presentationResult = {
        success: false,
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: "The vault action failed.",
        },
      };
      this.recordLifecycle({
        code: "local_tool_completed_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: call.name,
        toolCallId: call.callId,
        toolOutcome: "failed",
        toolFailureClass: "execution_failed",
        ...(toolRequestedItemCount(call) === undefined
          ? {}
          : { toolItemCount: toolRequestedItemCount(call) }),
        toolCompletedItemCount: 0,
        toolFailedItemCount: toolRequestedItemCount(call) ?? 0,
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
        ...this.clientLatency.fields(active.requestId),
      });
      delivery = {
        requestId: active.requestId,
        call,
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
        state: "output-error",
        errorText: "The vault action failed.",
        attemptedOpenEpoch: null,
        inFlight: false,
        acknowledged: false,
        acknowledgementRecorded: false,
      };
    }
    // Local execution is complete before the continuation stream finishes.
    // Keep that truth visible while the server acknowledges the result and
    // resumes its own model loop; a vault tool is not still executing merely
    // because later assistant content is streaming on the same HTTP request.
    active.projectionOwner.recordLocalResult(active.projection, call, presentationResult);
    active.executingToolIds.delete(call.callId);
    if (this.active?.token === active.token && !active.terminal) {
      this.publishActive(active, true);
    }
    this.pendingDeliveries.set(call.callId, delivery);
    await this.deliverToolResult(active, delivery);
  }

  private async deliverToolResult(
    active: ActiveRun,
    delivery: PendingToolDelivery,
  ): Promise<void> {
    const session = this.session;
    if (
      !session
      || this.active?.token !== active.token
      || active.terminal
      || this.connectionState !== "open"
      || this.pendingDeliveries.get(delivery.call.callId) !== delivery
      || delivery.inFlight
      || delivery.attemptedOpenEpoch === this.openEpoch
      || session.current.runState.state !== "waiting_for_client"
      || session.current.runState.request_id !== delivery.requestId
    ) return;
    const attemptedEpoch = this.openEpoch;
    delivery.attemptedOpenEpoch = attemptedEpoch;
    delivery.acknowledged = false;
    delivery.inFlight = true;
    this.publishActive(active, true);
    try {
      if (delivery.state === "output-available") {
        await session.sendToolResult({
          request_id: delivery.requestId,
          tool_call_id: delivery.call.callId,
          tool_name: delivery.call.name,
          state: "output-available",
          output: delivery.output ?? null,
        });
      } else {
        await session.sendToolResult({
          request_id: delivery.requestId,
          tool_call_id: delivery.call.callId,
          tool_name: delivery.call.name,
          state: "output-error",
          error_text: delivery.errorText ?? "The vault action failed.",
        });
      }
      this.reconcileAcknowledgedContinuations(active);
      // A newer authoritative synchronization can intentionally retire this
      // reader after an ACK. That stale command resolves without an error, but
      // it is not a clean close for this delivery attempt; the new epoch must
      // inspect authority and, if still waiting, replay the stored result.
      if (this.openEpoch !== attemptedEpoch) return;
      const commandSegmentOrdinal = this.clientLatency.toolResultSegmentOrdinal(
        active.requestId, delivery.call.callId, delivery.toolExecutionOrdinal,
      );
      this.recordLifecycle({
        code: delivery.state === "output-available"
          ? "tool_result_command_stream_completed_output_available"
          : "tool_result_command_stream_completed_output_error",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: delivery.call.name,
        toolCallId: delivery.call.callId,
        ...(delivery.toolExecutionOrdinal === undefined
          ? {}
          : { toolExecutionOrdinal: delivery.toolExecutionOrdinal }),
        ...this.clientLatency.fields(
          active.requestId,
          this.monotonicNow(),
          commandSegmentOrdinal,
        ),
      });
      this.recordLifecycle({
        code: delivery.state === "output-available"
          ? "tool_result_sent_succeeded"
          : "tool_result_sent_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: delivery.call.name,
        toolCallId: delivery.call.callId,
        ...(delivery.toolExecutionOrdinal === undefined
          ? {}
          : { toolExecutionOrdinal: delivery.toolExecutionOrdinal }),
        ...this.clientLatency.fields(active.requestId),
      });
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingDeliveries.get(delivery.call.callId) === delivery
      ) {
        // ACK is a delivery milestone, not continuation authority. A clean EOF
        // is safe only after the matching tool result also appears in the
        // authoritative projection. Otherwise retain the exact result and
        // obtain a fresh snapshot before replaying it through bounded backoff.
        delivery.attemptedOpenEpoch = null;
        this.transport?.markUnsynchronized();
      }
    } catch (error) {
      this.reconcileAcknowledgedContinuations(active);
      if (this.openEpoch === attemptedEpoch) {
        const commandSegmentOrdinal = this.clientLatency.toolResultSegmentOrdinal(
          active.requestId, delivery.call.callId, delivery.toolExecutionOrdinal,
        );
        this.recordLifecycle({
          code: "tool_result_command_stream_failed",
          phase: "tool_execution",
          conversationId: active.conversationId,
          requestId: active.requestId,
          toolName: delivery.call.name,
          toolCallId: delivery.call.callId,
          failureCode: "command_stream_failed",
          ...(delivery.toolExecutionOrdinal === undefined
            ? {}
            : { toolExecutionOrdinal: delivery.toolExecutionOrdinal }),
          ...this.clientLatency.fields(
            active.requestId,
            this.monotonicNow(),
            commandSegmentOrdinal,
          ),
        });
      }
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingDeliveries.get(delivery.call.callId) === delivery
      ) {
        delivery.attemptedOpenEpoch = null;
        this.reportLocalIssue(error);
      }
    } finally {
      delivery.inFlight = false;
      if (this.active?.token === active.token && !active.terminal) {
        this.publishActive(active, true);
      }
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingDeliveries.get(delivery.call.callId) === delivery
        && this.openEpoch !== attemptedEpoch
      ) {
        await this.deliverToolResult(active, delivery);
      }
    }
  }

  private async retryPendingDeliveries(active: ActiveRun): Promise<void> {
    if (
      this.connectionState !== "open"
      || this.session?.current.runState.state !== "waiting_for_client"
    ) return;
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.requestId !== active.requestId) continue;
      await this.deliverToolResult(active, delivery);
    }
  }

  private findCurrentTool(active: ActiveRun, callId: string): ProjectedTool | null {
    return active.projectionOwner.inspect(active.projection).tools.find((tool) => tool.callId === callId) ?? null;
  }

  private findAuthoritativeTool(active: ActiveRun, callId: string): ProjectedTool | null {
    return active.projectionOwner.inspect(active.projection, "authoritative").tools
      .find((tool) => tool.callId === callId) ?? null;
  }

  private reconcileAcknowledgedContinuations(active: ActiveRun): void {
    if (this.active?.token !== active.token) return;
    for (const [callId, delivery] of this.pendingDeliveries) {
      if (
        delivery.requestId === active.requestId
        && delivery.acknowledged
        && this.hasAuthoritativeToolResultProjection(active, delivery)
      ) {
        this.pendingDeliveries.delete(callId);
      }
    }
    for (const [callId, delivery] of this.pendingApprovalDeliveries) {
      if (
        delivery.decision.requestId === active.requestId
        && delivery.acknowledged
        && this.hasAuthoritativeApprovalProjection(active, delivery)
      ) {
        this.pendingApprovalDeliveries.delete(callId);
      }
    }
  }

  private hasAuthoritativeToolResultProjection(
    active: ActiveRun,
    delivery: PendingToolDelivery,
  ): boolean {
    const tool = this.findAuthoritativeTool(active, delivery.call.callId);
    if (
      !tool
      || tool.location !== "vault"
      || !active.authorization.matches(tool)
      || !active.authorization.matches(delivery.call)
      || !active.authorization.matches({ ...tool, input: toolInput(tool.part) })
    ) return false;
    if (delivery.state === "output-error") {
      return tool.part.state === "output-error"
        && typeof tool.part.errorText === "string"
        && tool.part.errorText === (delivery.errorText ?? "The vault action failed.");
    }
    return tool.part.state === "output-available"
      && tool.part.preliminary !== true
      && Object.prototype.hasOwnProperty.call(tool.part, "output")
      && canonicalAgentToolInput(toJsonValue(tool.part.output))
        === canonicalAgentToolInput(delivery.output ?? null);
  }

  private hasAuthoritativeApprovalProjection(
    active: ActiveRun,
    delivery: PendingApprovalDelivery,
  ): boolean {
    const tool = this.findAuthoritativeTool(active, delivery.decision.callId);
    if (
      !tool
      || tool.location !== "vault"
      || !active.authorization.matches(tool)
      || !active.authorization.matches({ ...tool, input: toolInput(tool.part) })
    ) return false;
    const approval = toolApproval(tool.part);
    const carriesApproval = Object.prototype.hasOwnProperty.call(tool.part, "approval");
    if (carriesApproval && (
      !approval
      || approval.id !== delivery.decision.approvalId
      || approval.approved !== delivery.decision.approved
    )) return false;
    const projectedDecision = typeof approval?.approved === "boolean"
      ? approval.approved
      : tool.part.state === "output-denied"
        ? false
        : isAuthoritativeTerminalToolPart(tool.part)
          ? true
          : undefined;
    if (projectedDecision !== delivery.decision.approved) return false;
    return delivery.decision.approved
      ? tool.part.state === "approval-responded"
        || isAuthoritativeTerminalToolPart(tool.part)
      : tool.part.state === "approval-responded"
        || tool.part.state === "output-denied";
  }

  private captureFailedRun(
    active: ActiveRun,
    snapshot: AgentConversationSnapshot,
    failure: IncidentFailureScalars,
  ): void {
    try {
      captureFailedRun({
        conversationId: active.conversationId,
        requestId: active.requestId,
        origin: active.origin,
        phase: active.phase,
        elapsedMs: active.elapsedMs,
        executingLocalToolCount: active.executingToolIds.size,
        pendingToolTaskCount: active.toolTasks.size,
        serverQueued: active.serverQueued,
      }, snapshot, failure, {
        connectionState: this.connectionState,
        runStalled: this.runStalled,
        awaitingClientWork: this.awaitingClientWork,
        pendingCancel: this.pendingCancelRequestId === active.requestId,
        pendingToolDeliveryCount: this.pendingDeliveries.size,
        pendingApprovalDeliveryCount: this.pendingApprovalDeliveries.size,
      }, this.options.onIncidentCapture);
    } catch {
      // Diagnostics are observational. Reading run facts cannot affect a run.
    }
  }

  private capturePreflightFailure(
    conversationId: string,
    requestId: string,
    error: ManagedAgentError,
    taxonomy: Readonly<{
      failureStage: AgentIncidentFailureStage;
      failureMechanism: AgentIncidentFailureMechanism;
    }>,
    prepareFailureAlreadyRecorded: boolean = false,
  ): void {
    try {
      const callback = this.options.onIncidentCapture;
      if (
        !callback
        || !isThinAgentConversationId(conversationId)
        || !isThinAgentRequestId(requestId)
      ) return;
      if (!prepareFailureAlreadyRecorded) {
        this.recordLifecycle({
          code: "response_prepare_failed",
          phase: "start",
          conversationId,
          requestId,
          ...(error.status === undefined ? {} : { status: error.status }),
          retryable: error.retryable === true,
          ...this.clientLatency.fields(requestId),
        });
      }
      const rawElapsed = this.clientLatency.elapsed(conversationId, requestId);
      const elapsed = boundedIncidentElapsedMs(rawElapsed);
      const incidentCandidate = error.incidentId ?? error.requestId;
      const incidentId = isThinAgentIncidentId(incidentCandidate)
        ? incidentCandidate
        : undefined;
      const failureCode = normalizeAgentIncidentFailureCode(error.code, "client");
      const capture = Object.freeze({
        kind: "agent_run_failed",
        conversationId,
        requestId,
        failureAuthority: "client",
        failureStage: taxonomy.failureStage,
        failureMechanism: taxonomy.failureMechanism,
        terminalValidation: "unvalidated",
        terminalSource: "local_failure",
        hostProcessState: "responsive",
        chatViewState: "unknown",
        runOrigin: "submitted",
        runPhase: "submitted",
        connectionState: this.connectionState,
        ...(elapsed.value === undefined ? {} : { elapsedMs: elapsed.value }),
        elapsedMsTruncated: elapsed.truncated,
        ...(incidentId ? { incidentId } : {}),
        ...(failureCode ? { failureCode } : {}),
        retryable: error.retryable === true,
        assistantTextPartCount: 0,
        assistantTextStreamingPartCount: 0,
        assistantTextCompletePartCount: 0,
        assistantTextCharacterCount: 0,
        reasoningPartCount: 0,
        reasoningStreamingPartCount: 0,
        reasoningCompletePartCount: 0,
        reasoningCharacterCount: 0,
        assistantOutputPresentBeforeFailure: false,
        assistantOutputRetainedInFailedProjection: false,
        snapshotPartCount: 1,
        executingLocalToolCount: 0,
        pendingToolDeliveryCount: 0,
        pendingApprovalDeliveryCount: 0,
        pendingToolTaskCount: 0,
        serverQueued: false,
        runStalled: this.runStalled,
        awaitingClientWork: this.awaitingClientWork,
        pendingCancel: false,
        pendingRegenerate: false,
        countsTruncated: false,
      });
      try {
        callback(capture);
      } catch {
        // The failed lifecycle still records even if capture projection fails.
      }
      this.recordLifecycle({
        code: "run_finished_failed",
        phase: "response",
        conversationId,
        requestId,
        ...(error.status === undefined ? {} : { status: error.status }),
        retryable: error.retryable === true,
        ...(incidentId ? { incidentId } : {}),
        ...(failureCode ? { failureCode } : {}),
        ...this.clientLatency.fields(requestId),
      });
    } catch {
      // Preflight diagnostics cannot affect the user-visible failed result.
    }
  }

  private captureAuthoritativeFailure(
    active: ActiveRun,
    terminal: Extract<ThinAgentRunTerminalData, { outcome: "failed" }>,
    observedRunPhase: AgentRunPhase,
    terminalSource: Extract<
      AgentRunFailureCaptureEvent["terminalSource"],
      "session_terminal" | "message_reconstruction"
    >,
  ): void {
    if (
      !isThinAgentServerRunId(terminal.run_id)
      || !isThinAgentIncidentId(terminal.incident_id)
      || !isThinAgentFailureCode(terminal.code)
    ) return;
    try {
      this.captureFailedRun(
        active,
        active.projectionOwner.present(active.projection, {
          ...this.presentationFacts(active), terminal,
        }, "failure-evidence"),
        {
          failureAuthority: "server",
          failureStage: "response_terminal",
          failureMechanism: "service_terminal",
          terminalValidation: "validated",
          terminalSource,
          retryable: terminal.retryable,
          runPhase: observedRunPhase,
          serverRunId: terminal.run_id,
          incidentId: terminal.incident_id,
          failureCode: terminal.code,
        },
      );
    } catch {
      // Projection evidence is best effort and cannot affect terminal handling.
    }
  }

  private acceptTerminal(
    active: ActiveRun,
    terminal: ThinAgentRunTerminalData,
    terminalSource: Extract<
      AgentRunFailureCaptureEvent["terminalSource"],
      "session_terminal" | "message_reconstruction"
    >,
  ): void {
    if (
      this.active?.token !== active.token
      || active.terminal
      || terminal.root_message_id !== active.turnId
      || (active.serverRunId && terminal.run_id !== active.serverRunId)
    ) return;
    this.updateActiveElapsed(active);
    const observedRunPhase = active.phase;
    active.serverRunId = terminal.run_id;
    active.terminal = terminal;
    active.phase = terminal.outcome === "succeeded" ? "settling" : "complete";
    active.label = terminal.outcome === "succeeded" ? "Finishing" : "";
    const terminalSegmentOrdinal = this.clientLatency.acceptTerminal(active.requestId);
    this.recordLifecycle({
      code: terminal.outcome === "succeeded"
        ? "response_result_received_succeeded"
        : terminal.outcome === "cancelled"
          ? "response_result_received_cancelled"
          : "response_result_received_failed",
      phase: "response",
      conversationId: active.conversationId,
      requestId: active.requestId,
      serverRunId: terminal.run_id,
      ...(terminal.outcome === "failed"
        ? {
            retryable: terminal.retryable,
            incidentId: terminal.incident_id,
            failureCode: terminal.code,
          }
        : {}),
      ...this.clientLatency.fields(
        active.requestId,
        this.monotonicNow(),
        terminalSegmentOrdinal,
      ),
    });
    if (terminal.outcome === "failed") {
      this.captureAuthoritativeFailure(
        active,
        terminal,
        observedRunPhase,
        terminalSource,
      );
    }
    this.publishActive(active, true);
    const finalization = this.finalizeTerminal(active);
    this.pendingFinalization = finalization.then(
      () => undefined,
      () => undefined,
    );
    void finalization;
  }

  private async finalizeTerminal(active: ActiveRun): Promise<void> {
    if (active.finalizing || this.active?.token !== active.token || !active.terminal) return;
    active.finalizing = true;
    await Promise.allSettled(active.toolTasks.values());
    const terminal = active.terminal;
    const history = active.projectionOwner.history({
      kind: "terminal", turn: active.projection, terminal,
      elapsedMs: active.elapsedMs, tools: this.presentationFacts(active).tools, now: this.now(),
    });
    // The projection's durable graph is deeply frozen; persistence shares it.
    const assistantMessage = history?.assistant as ChatMessage | undefined;
    // One durable write per turn: terminal reconciliation writes the whole
    // authoritative turn first, so the assistant save below is a no-op unless
    // reconciliation was unavailable, deferred, or failed.
    await this.reconcileMessages(history, "terminal").catch(() => undefined);
    if (assistantMessage) {
      const durable = assistantMessage;
      this.recordLifecycle({
        code: "response_save_started",
        phase: "persistence",
        conversationId: active.conversationId,
        requestId: active.requestId,
        serverRunId: terminal.run_id,
        ...this.clientLatency.fields(active.requestId),
      });
      try {
        await this.options.persistAssistant(durable);
        this.recordLifecycle({
          code: "response_save_completed",
          phase: "persistence",
          conversationId: active.conversationId,
          requestId: active.requestId,
          serverRunId: terminal.run_id,
          ...this.clientLatency.fields(active.requestId),
        });
      } catch (error) {
        this.recordLifecycle({
          code: "response_save_failed",
          phase: "persistence",
          conversationId: active.conversationId,
          requestId: active.requestId,
          serverRunId: terminal.run_id,
          ...this.clientLatency.fields(active.requestId),
        });
        this.reportLocalIssue(error);
      }
    }
    const snapshot = active.projectionOwner.present(active.projection, this.presentationFacts(active));
    this.commitSnapshot(snapshot);
    const result: AgentRunResult = terminal.outcome === "succeeded"
      ? {
          kind: "completed",
          snapshot,
          ...(assistantMessage ? { message: assistantMessage } : {}),
        }
      : terminal.outcome === "cancelled"
        ? { kind: "cancelled", snapshot }
        : { kind: "failed", snapshot, error: terminalError(terminal) };
    this.completeActive(
      active,
      result,
      result.kind === "failed" ? "server" : undefined,
    );
    if (terminal.outcome === "succeeded") {
      // Credit balance is presentation metadata; the server remains the
      // authority for admitting the next billed turn. A slow balance lookup
      // must not keep an already-persisted terminal response mounted as active,
      // hold the composer lock, or block detach/New Chat behind finalization.
      // Start the refresh only after releasing the run so queued and user
      // follow-ups can proceed, and contain either synchronous or async errors.
      void Promise.resolve()
        .then(() => this.options.refreshCredits?.("post_terminal", {
          requestId: active.requestId,
          serverRunId: terminal.run_id,
        }))
        .catch((error) => this.reportLocalIssue(error));
    }
  }

  private completeActive(
    active: ActiveRun,
    result: AgentRunResult,
    failureAuthority?: "server" | "client",
  ): void {
    if (this.active?.token !== active.token) return;
    this.clearRunStallTimer();
    this.clearResynchronization();
    this.runStalled = false;
    this.stallRecovery = null;
    this.pendingDeliveries.clear();
    this.pendingApprovalDeliveries.clear();
    this.pendingCancelRequestId = null;
    this.pendingCancelInFlight = false;
    this.recordLifecycle({
      code: result.kind === "completed"
        ? "run_finished_completed"
        : result.kind === "cancelled"
          ? "run_finished_cancelled"
          : "run_finished_failed",
      phase: "response",
      conversationId: active.conversationId,
      requestId: active.requestId,
      ...(active.serverRunId ? { serverRunId: active.serverRunId } : {}),
      ...(result.kind === "failed"
        ? {
            retryable: result.error.retryable,
            failureCode: normalizeAgentIncidentFailureCode(
              result.error.code,
              failureAuthority ?? "server",
            ),
            ...(result.error.status === undefined
              ? {}
              : { status: result.error.status }),
            ...(result.error.incidentId
              ? { incidentId: result.error.incidentId }
              : {}),
          }
        : {}),
      ...this.clientLatency.fields(
        active.requestId,
        this.monotonicNow(),
        this.clientLatency.terminalSegmentOrdinal(active.requestId),
      ),
    });
    const billingFailure = result.kind === "failed" ? result.error : null;
    this.active = null;
    if (billingFailure) {
      // Queue the session-owned fresh read before the run consumer presents the
      // same billing error. The callback itself cannot run until this stack has
      // released `active`, and the view's generic refresh then joins it.
      this.refreshCreditsAfterBillingFailure(billingFailure, active);
    }
    active.resolve(result);
  }

  private refreshCreditsAfterBillingFailure(
    error: ManagedAgentError,
    active: ActiveRun,
  ): void {
    if (!isAgentBillingFailure(error)) return;
    void Promise.resolve()
      .then(() => this.options.refreshCredits?.("billing_failure", {
        requestId: active.requestId,
        ...(active.serverRunId ? { serverRunId: active.serverRunId } : {}),
      }))
      .catch((refreshError) => this.reportLocalIssue(refreshError));
  }

  private finishLocalCancellation(active: ActiveRun): void {
    if (this.active?.token !== active.token || active.terminal) return;
    this.updateActiveElapsed(active);
    active.terminal = {
      version: 1,
      run_id: active.serverRunId ?? `run_${"0".repeat(32)}`,
      root_message_id: active.turnId,
      outcome: "cancelled",
      code: "cancelled",
    };
    this.reconcileLocalTerminalDuration(active);
    const snapshot = active.projectionOwner.present(
      active.projection, this.presentationFacts(active), "local-cancellation",
    );
    this.commitSnapshot(snapshot);
    this.completeActive(active, { kind: "cancelled", snapshot });
  }

  private finishLocalFailure(
    active: ActiveRun,
    error: ManagedAgentError,
    taxonomy: Readonly<{
      failureStage: AgentIncidentFailureStage;
      failureMechanism: AgentIncidentFailureMechanism;
    }>,
  ): void {
    if (this.active?.token !== active.token || active.terminal) return;
    this.updateActiveElapsed(active);
    active.terminal = {
      version: 1,
      run_id: active.serverRunId ?? `run_${"0".repeat(32)}`,
      root_message_id: active.turnId,
      outcome: "failed",
      code: error.code,
      message: error.message,
      incident_id: /^incident_[a-f0-9]{32}$/u.test(error.requestId ?? "")
        ? error.requestId!
        : `incident_${"0".repeat(32)}`,
      retryable: error.retryable === true,
    };
    this.reconcileLocalTerminalDuration(active);
    const snapshot = active.projectionOwner.present(active.projection, this.presentationFacts(active));
    const incidentCandidate = error.incidentId ?? error.requestId;
    this.captureFailedRun(active, snapshot, {
      failureAuthority: "client",
      failureStage: taxonomy.failureStage,
      failureMechanism: taxonomy.failureMechanism,
      terminalValidation: "unvalidated",
      terminalSource: "local_failure",
      retryable: error.retryable === true,
      ...(isThinAgentServerRunId(active.serverRunId)
        ? { serverRunId: active.serverRunId }
        : {}),
      ...(isThinAgentIncidentId(incidentCandidate)
        ? { incidentId: incidentCandidate }
        : {}),
      ...(isThinAgentFailureCode(error.code)
        ? { failureCode: error.code }
        : {}),
    });
    this.commitSnapshot(snapshot);
    this.completeActive(active, { kind: "failed", snapshot, error }, "client");
    // Complete/release first so the session-owned billing refresh starts
    // before AgentChatView's generic error presentation sees the same 402.
    // The latter then joins the in-flight refresh instead of forcing another.
    this.reportLocalIssue(error);
  }

  private failedResult(turnId: string, error: ManagedAgentError): AgentRunResult {
    const snapshot = freezeSnapshot({
      runId: null,
      turnId,
      status: "failed",
      phase: "submitted",
      terminalError: error,
      messages: [],
      parts: [{
        id: `error:${turnId}`,
        kind: "error",
        error,
        retryable: error.retryable === true,
        retryMessageId: turnId,
        order: 0,
      }],
    });
    this.commitSnapshot(snapshot);
    return { kind: "failed", snapshot, error };
  }

  /*
   * Streamed frames arrive far faster than the 16 ms render window. The first
   * frame of a burst is presented at once; later frames only mark the run due,
   * and the projection is computed once when the window closes. A frame that
   * a first-projection latency milestone is waiting on is presented at once,
   * because that milestone must be measured while its frame is delivered.
   */
  private publishActive(active: ActiveRun, immediate = false): void {
    if (this.active?.token !== active.token) return;
    if (immediate) {
      this.commitSnapshot(this.presentActive(active));
    } else if (this.renderTimer === null) {
      this.scheduleSnapshot(this.presentActive(active));
    } else if (this.clientLatency.awaitsProjection(active.requestId)) {
      this.pendingActivePresentation = null;
      this.dispatchSnapshot(this.presentActive(active));
    } else {
      this.pendingActivePresentation = active;
    }
  }

  private presentActive(active: ActiveRun): AgentConversationSnapshot {
    this.updateActiveElapsed(active);
    const snapshot = active.projectionOwner.present(active.projection, this.presentationFacts(active));
    this.clientLatency.observeProjection(active.requestId, snapshot);
    this.syncRunStallWatchdog(snapshot);
    return snapshot;
  }

  private presentationFacts(active: ActiveRun): RunPresentation {
    const tools = active.projectionOwner.inspect(active.projection).tools.map((tool) => Object.freeze({
      call: Object.freeze({ callId: tool.callId, name: tool.name, input: tool.input }),
      identityConfirmed: active.authorization.matches(tool),
      ...active.authorization.state(tool.callId),
    }));
    return {
      serverRunId: active.serverRunId, phase: active.phase, label: active.label,
      terminal: active.terminal, cancelRequested: active.cancelRequested,
      serverQueued: active.serverQueued, elapsedMs: active.elapsedMs,
      connectionState: this.connectionState, runStalled: this.runStalled,
      tools: Object.freeze(tools),
      executingToolIds: Object.freeze([...active.executingToolIds]),
    };
  }

  private publishHydratedTail(): void {
    if (this.active) return;
    const tail = this.projection.hydratedTail(this.connectionState);
    if (tail) this.commitSnapshot(tail);
    else if (this.currentSnapshot.status !== "completed") this.commitSnapshot(initialSnapshot());
  }

  private scheduleSnapshot(snapshot: AgentConversationSnapshot): void {
    // Leading-edge throttle: the first snapshot of a burst paints with no
    // added latency and the timer stays armed purely as the coalescing
    // window for followers. A trailing debounce here would hold every first
    // streamed token for a frame before anything reached the renderer.
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      const due = this.pendingActivePresentation;
      this.pendingActivePresentation = null;
      if (due && this.active?.token === due.token) {
        this.dispatchSnapshot(this.presentActive(due));
      }
    }, 16);
    this.dispatchSnapshot(snapshot);
  }

  private commitSnapshot(snapshot: AgentConversationSnapshot): void {
    this.pendingActivePresentation = null;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.dispatchSnapshot(snapshot);
  }

  private dispatchSnapshot(snapshot: AgentConversationSnapshot): void {
    this.currentSnapshot = snapshot;
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); }
      catch (error) {
        this.listeners.delete(listener);
        this.reportLocalIssue(error);
      }
    }
  }

  private reconcileAuthoritativePrefix(active: ActiveRun | null): void {
    if (!this.options.reconcileHistory || active?.terminal) return;
    const history = this.projection.history({
      kind: "prefix", turn: active?.projection, now: this.now(),
    });
    void this.reconcileMessages(history, "authoritative_prefix").catch(() => undefined);
  }

  private reconcileMessages(
    history: HistoryProjection | null,
    historySyncKind: HistorySyncKind,
  ): Promise<void> {
    if (!history || !this.options.reconcileHistory) return Promise.resolve();
    const { key } = history;
    if (key === this.reconciledKey) return this.pendingReconcile;
    // The cached graph is deeply frozen, so persistence shares it by reference.
    const durable = history.messages as readonly ChatMessage[];
    this.reconciledKey = key;
    const correlation = this.clientLatency.createHistorySyncCorrelation(historySyncKind, this.conversationId);
    const task = this.pendingReconcile.then(() => {
      this.clientLatency.recordHistorySync("history_sync_started", correlation);
      return this.options.reconcileHistory!(durable);
    });
    this.pendingReconcile = task.then(
      () => {
        this.clientLatency.recordHistorySync("history_sync_completed", correlation);
      },
      (error) => {
        if (this.reconciledKey === key) {
          this.reconciledKey = null;
        }
        this.clientLatency.recordHistorySync("history_sync_failed", correlation);
        this.reportLocalIssue(error);
      },
    );
    return task;
  }

  private async trySendPendingCancel(): Promise<void> {
    const requestId = this.pendingCancelRequestId;
    const session = this.session;
    const active = this.active;
    if (!requestId || !session || !active || this.pendingCancelInFlight) return;
    const queued = active.requestId === requestId && active.serverQueued;
    if (!queued) {
      if (
        session.current.runState.state !== "running"
        && session.current.runState.state !== "waiting_for_client"
      ) return;
      if (session.current.runState.request_id !== requestId) return;
    }
    this.pendingCancelInFlight = true;
    try {
      await session.cancel({ request_id: requestId, queued });
      if (
        this.pendingCancelRequestId === requestId
        && this.active?.requestId === requestId
        && !this.active.terminal
      ) {
        this.scheduleResynchronization(this.active);
      }
    } catch (error) {
      this.reportLocalIssue(error);
    } finally {
      this.pendingCancelInFlight = false;
    }
  }

  private async issueBootstrap(): Promise<ThinAgentBootstrapResponse> {
    if (this.transport) {
      const bootstrap = await this.transport.bootstrap();
      this.options.updateInputLimits?.(bootstrap.client_input_limits);
      return bootstrap;
    }

    const licenseKey = this.options.licenseKey().trim();
    if (!licenseKey) throw planRequiredError("Chat");
    const request = parseThinAgentBootstrapRequest(this.options.bootstrapRequest());
    const response = await this.requestClient.request({
      url: new URL(THIN_AGENT_BOOTSTRAP_PATH, this.options.baseUrl).toString(),
      method: "POST",
      headers: { "x-plugin-version": this.options.pluginVersion },
      licenseKey,
      body: request,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 64 * 1024,
    });
    if (!response.ok) {
      const fallback = response.status === 429
        ? "SystemSculpt is receiving too many requests. Try again shortly."
        : `SystemSculpt could not start the response (${response.status}).`;
      throw Object.assign(new Error(fallback), {
        code: response.status === 429 ? "response_start_rate_limited" : "response_start_failed",
        status: response.status,
        retryable: response.status === 401 || response.status === 429 || response.status >= 500,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const bootstrap = parseThinAgentBootstrapResponse(value, {
      conversation_id: request.conversation_id,
    });
    this.options.updateInputLimits?.(bootstrap.client_input_limits);
    return bootstrap;
  }

  private reportLocalIssue(error: unknown): void {
    try { this.options.reportError?.(error); }
    catch { /* Error reporting is observational. */ }
  }
}