import {
  normalizeAgentIncidentFailureCode,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
} from "../../../core/diagnostics/AgentIncidentSchema";
import {
  PlatformRequestClient,
  type PlatformResponseDeliveryMode,
} from "../../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_CONTEXT_PATH,
  THIN_AGENT_CONTRACT_VERSION,
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  parseThinAgentContextRequest,
  parseThinAgentContextResponse,
  parseThinAgentDataPart,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
  type ThinAgentContextResponse,
  type ThinAgentContextSource,
  type ThinAgentRunTerminalData,
} from "../../../services/managed/ThinAgentV1Contract";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  type ThinAgentInputLimits,
} from "../../../services/managed/ThinAgentInputLimits";
import type { ChatMessage, MessagePart, MultiPartContent } from "../../../types";
import type { ToolCall, ToolCallResult } from "../../../types/toolCalls";
import {
  countLocalToolOutcome,
  localToolOutcomeSchema,
} from "../../../tools/LocalToolOutcome";
import { isFirstPartyToolName } from "../../../tools/toolNames";
import {
  collectSuccessfulToolArtifactPaths,
  collectToolArtifactPaths,
} from "../../../utils/toolArtifacts";
import {
  isThinAgentConversationId,
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentRequestId,
  isThinAgentServerRunId,
} from "../../../utils/ThinAgentLifecycleSchema";
import {
  isMutatingTool,
  requiresUserApproval,
  type ToolApprovalPolicy,
} from "../../../utils/toolPolicy";
import type {
  AgentConversationSnapshot,
  AgentPart,
  AgentRunPhase,
  AgentToolPart,
  ManagedAgentError,
  ToolResultSummary,
} from "../AgentConversation";
import {
  createTextAttachmentPart,
  createUnavailableAttachmentPart,
  parseAttachedTextContent,
} from "../attachments/ChatAttachmentContent";
import {
  AgentSession,
  type AgentCommandAckEvent,
  type AgentConnectionState,
  type AgentSessionSnapshot,
} from "./AuthoritativeSession";
import {
  AgentStreamingTransport,
  type AgentTransportSegmentCloseReason,
  type AgentTransportSegmentSummaryEvent,
  type AgentTransportTimingEvent,
} from "./StreamingTransport";
import type {
  AgentCommandKind,
  AgentJsonValue,
  AgentQueueSnapshotEvent,
  AgentUserMessage,
} from "./Protocol";
import {
  AgentMutationJournal,
  canonicalAgentToolInput,
} from "./MutationJournal";
import {
  AgentLifecycle,
  type AgentLifecycleCode,
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
  AgentLifecycleRecord,
} from "./Lifecycle";

type WirePart = Readonly<Record<string, unknown> & { type: string }>;

type WireMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  parts: readonly WirePart[];
}>;

type LocalToolCall = Readonly<{
  callId: string;
  name: string;
  input: AgentJsonValue;
}>;

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

type ToolTarget = Readonly<{
  name: string;
  input: AgentJsonValue;
}>;

type ToolTargetMap = ReadonlyMap<string, ToolTarget>;

type ProjectedTool = Readonly<{
  callId: string;
  name: string;
  input: AgentJsonValue;
  location: "server" | "vault";
  part: WirePart;
}>;

export type AgentRunResult =
  | Readonly<{
      kind: "completed";
      snapshot: AgentConversationSnapshot;
      message?: ChatMessage;
    }>
  | Readonly<{
      kind: "cancelled";
      snapshot: AgentConversationSnapshot;
    }>
  | Readonly<{
      kind: "failed";
      snapshot: AgentConversationSnapshot;
      error: ManagedAgentError;
    }>;

export type AgentRunInput = Readonly<{
  conversationId: string;
  turnId: string;
  message: AgentUserMessage;
  buildBody?: (
    signal: AbortSignal,
  ) => Promise<Readonly<{ context_ref?: string }> | undefined>;
  approvalPolicy?: ToolApprovalPolicy;
  beforeSend?: () => Promise<void>;
  clientStartedAtMonotonicMs?: number;
}>;

/**
 * Content-free evidence captured while a failed run still owns its state.
 *
 * This boundary intentionally exposes only purpose-specific identifiers,
 * validated enums, booleans, and bounded counts. It must never grow raw
 * messages, errors, tool identities, paths, URLs, inputs, or outputs.
 */
export type AgentRunFailureCaptureEvent = Readonly<{
  kind: "agent_run_failed";
  conversationId: string;
  requestId: string;
  failureAuthority: "server" | "client";
  failureStage: AgentIncidentFailureStage;
  failureMechanism: AgentIncidentFailureMechanism;
  terminalValidation: "validated" | "unvalidated";
  terminalSource: "session_terminal" | "message_reconstruction" | "local_failure";
  hostProcessState: "responsive";
  chatViewState: "unknown";
  runOrigin: "submitted" | "recovered";
  runPhase: AgentRunPhase;
  connectionState: AgentConnectionState;
  elapsedMs?: number;
  elapsedMsTruncated: boolean;
  serverRunId?: string;
  incidentId?: string;
  failureCode?: string;
  retryable: boolean;
  assistantTextPartCount: number;
  assistantTextStreamingPartCount: number;
  assistantTextCompletePartCount: number;
  assistantTextCharacterCount: number;
  reasoningPartCount: number;
  reasoningStreamingPartCount: number;
  reasoningCompletePartCount: number;
  reasoningCharacterCount: number;
  assistantOutputPresentBeforeFailure: boolean;
  assistantOutputRetainedInFailedProjection: boolean;
  snapshotPartCount: number;
  executingLocalToolCount: number;
  pendingToolDeliveryCount: number;
  pendingApprovalDeliveryCount: number;
  pendingToolTaskCount: number;
  serverQueued: boolean;
  runStalled: boolean;
  awaitingClientWork: boolean;
  pendingCancel: boolean;
  pendingRegenerate: boolean;
  countsTruncated: boolean;
}>;

/**
 * Content-free transport evidence for local incident capture.
 *
 * The conversation and request IDs are internal correlation keys. Persisted
 * reports must replace or omit them. Tool-call IDs never cross this boundary;
 * a locally established execution can contribute only its derived ordinal.
 */
export type AgentChatTransportSegmentSummaryEvent = Readonly<{
  conversationId: string;
  requestId: string;
  commandKind: AgentCommandKind;
  commandSegmentOrdinal: number;
  serverLatencyCorrelationId?: string;
  toolExecutionOrdinal?: number;
  closeReason: AgentTransportSegmentCloseReason;
  durationMs: number;
  receivedBytes: number;
  nonEmptyRawChunkCount: number;
  sseEventCount: number;
  acceptedFrameCount: number;
  deliveredFrameCount: number;
  metricsTruncated: boolean;
}>;

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
const MAX_RESYNCHRONIZATION_DELAY_MS = 5_000;
const MAX_RETAINED_LATENCY_RUNS = 8;
const MAX_RETAINED_LATENCY_SEGMENTS_PER_RUN = 512;
const MAX_TOOL_EXECUTIONS_PER_RUN = 512;
const MAX_HISTORY_SYNCS_PER_RUN = 2_048;
const MAX_INCIDENT_CAPTURE_COUNT = 100_000_000;
const MAX_INCIDENT_CAPTURE_ELAPSED_MS = 7 * 24 * 60 * 60 * 1_000;

type ToolIdentity = Readonly<{
  toolName: string;
  canonicalInput: string;
}>;

type LocalApprovalDecision = Readonly<{
  approvalId: string;
  approved: boolean;
  source: "manual" | "policy";
  identity: ToolIdentity;
}>;

type ApprovalBinding = Readonly<{
  callId: string;
  identity: ToolIdentity;
}>;

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
  readonly completedLocalToolResults: Map<string, ToolCallResult>;
  readonly settledToolIds: Set<string>;
  readonly acknowledgedClientContinuationIds: Set<string>;
  readonly toolIdentities: Map<string, ToolIdentity>;
  readonly approvalDecisions: Map<string, LocalApprovalDecision>;
  readonly approvalIds: Map<string, string>;
  readonly approvalCallIds: Map<string, string>;
  readonly approvalBindings: Map<string, ApprovalBinding>;
  readonly toolTasks: Map<string, Promise<void>>;
  readonly baseMessageIds: ReadonlySet<string>;
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
  // The turn's streamed assistant messages as last observed before a durable
  // session snapshot replaced the projection. A snapshot built before the
  // terminal fold can momentarily omit the streamed content of a run that is
  // ending; finalization restores this capture so cancellation never erases
  // content the user already watched stream.
  streamedTurnMessages: readonly WireMessage[];
};

type StallRecovery = Readonly<{
  runToken: object;
  progressKey: string;
}>;

type ClientLatencyContext = {
  readonly conversationId: string;
  readonly requestId: string;
  readonly startedAtMonotonicMs: number;
  readonly milestones: Set<AgentLifecycleCode>;
  readonly segmentMilestones: Set<string>;
  readonly toolMilestones: Set<string>;
  readonly segments: Map<number, ClientLatencySegment>;
  readonly toolExecutionOrdinals: Map<string, number>;
  nextToolExecutionOrdinal: number;
  nextHistorySyncOrdinal: number;
  pendingAssistantProjectionOrdinal: number | null;
  pendingCommandAck: Readonly<{
    ordinal: number;
    commandKind: AgentCommandKind;
    toolCallId: string | null;
  }> | null;
  pendingTerminalOrdinal: number | null;
  terminalSegmentOrdinal: number | null;
  lastOffsetMs: number;
};

type ClientLatencySegment = {
  readonly ordinal: number;
  readonly commandKind: AgentCommandKind;
  readonly toolCallId: string | null;
  readonly toolExecutionOrdinal: number | null;
  toolName: string | null;
  latencyTraceId: string | null;
  responseDeliveryMode: PlatformResponseDeliveryMode | null;
};

type PendingRegenerateDelivery = {
  readonly requestId: string;
  readonly rootMessageId: string;
  attemptedOpenEpoch: number | null;
  inFlight: boolean;
};

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

type PendingApprovalDecision = LocalApprovalDecision & Readonly<{
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

type ClientToolRenderCode = Extract<AgentLifecycleCode,
  | "local_tool_terminal_dom_committed"
  | "local_tool_terminal_paint_opportunity"
  | "continuation_content_dom_committed"
  | "continuation_content_paint_opportunity">;

type HistorySyncCorrelation = Readonly<{
  conversationId?: string;
  requestId?: string;
  historySyncKind: HistorySyncKind;
  historySyncOrdinal?: number;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const INTERNAL_SERVER_TOOL_NAMES = new Set(["set_context"]);
const MAX_SOURCE_URLS = 16;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_TITLE_LENGTH = 160;
const MAX_CONTEXT_RESPONSE_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wasDefinitelyRejected(error: unknown): boolean {
  return isRecord(error) && error.serverAdmissionPossible === false;
}

function isWirePart(value: unknown): value is WirePart {
  return isRecord(value)
    && typeof value.type === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value.type);
}

function isWireMessage(value: unknown): value is WireMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && SAFE_ID.test(value.id)
    && (value.role === "user" || value.role === "assistant")
    && Array.isArray(value.parts)
    && value.parts.length <= 2_048
    && value.parts.every(isWirePart);
}

function safeServiceMessage(_value: string | undefined, fallback: string): string {
  // Remote service text is not a stable client copy contract. Use only local,
  // first-party wording so upstream implementation details cannot reach UI.
  return fallback;
}

function managedError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ManagedAgentError {
  if (isRecord(error)) {
    const status = typeof error.status === "number" && Number.isInteger(error.status)
      ? error.status
      : undefined;
    const retryable = typeof error.retryable === "boolean"
      ? error.retryable
      : status === undefined || status === 401 || status === 429 || status >= 500;
    const code = typeof error.code === "string"
      && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code
      : fallbackCode;
    const requestId = typeof error.requestId === "string"
      && /^incident_[a-f0-9]{32}$/u.test(error.requestId)
      ? error.requestId
      : undefined;
    return {
      code,
      message: safeServiceMessage(
        typeof error.message === "string" ? error.message : undefined,
        fallbackMessage,
      ),
      ...(status === undefined ? {} : { status }),
      ...(requestId ? { requestId } : {}),
      ...(requestId ? { incidentId: requestId } : {}),
      retryable,
    };
  }
  return {
    code: fallbackCode,
    message: safeServiceMessage(
      error instanceof Error ? error.message : undefined,
      fallbackMessage,
    ),
    retryable: true,
  };
}

function terminalError(terminal: Extract<ThinAgentRunTerminalData, { outcome: "failed" }>): ManagedAgentError {
  const incidentId = /^incident_(?!0{32}$)[a-f0-9]{32}$/u.test(terminal.incident_id)
    ? terminal.incident_id
    : undefined;
  return {
    code: terminal.code,
    message: safeServiceMessage(
      terminal.message,
      "SystemSculpt could not complete the response.",
    ),
    ...(incidentId ? { requestId: incidentId } : {}),
    retryable: terminal.retryable,
    ...(incidentId ? { incidentId } : {}),
  };
}

function currentTurnMessages(
  messages: readonly WireMessage[],
  turnId: string,
): readonly WireMessage[] {
  const userIndex = messages.findIndex((message) =>
    message.role === "user" && message.id === turnId);
  if (userIndex < 0) return [];
  const nextUserOffset = messages.slice(userIndex + 1)
    .findIndex((message) => message.role === "user");
  const end = nextUserOffset < 0
    ? messages.length
    : userIndex + 1 + nextUserOffset;
  return messages.slice(userIndex + 1, end);
}

function toolCallId(part: WirePart): string | null {
  return typeof part.toolCallId === "string" && part.toolCallId.length > 0
    ? part.toolCallId
    : null;
}

function toolName(part: WirePart): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName.length > 0
      ? part.toolName
      : null;
  }
  return part.type.startsWith("tool-") && part.type.length > 5
    ? part.type.slice(5)
    : null;
}

function toolInput(part: WirePart): AgentJsonValue {
  return toJsonValue(part.input ?? null);
}

function toolOutput(part: WirePart): unknown {
  return part.output;
}

function toolApproval(part: WirePart): Readonly<{ id: string; approved?: boolean }> | null {
  if (!isRecord(part.approval) || typeof part.approval.id !== "string") return null;
  return {
    id: part.approval.id,
    ...(typeof part.approval.approved === "boolean"
      ? { approved: part.approval.approved }
      : {}),
  };
}

function collectClientToolTargets(messages: readonly WireMessage[]): ToolTargetMap {
  // The provider stream assembles a tool part when its input STARTS streaming,
  // while the explicit client-tool request part is appended once the input is
  // complete — so within one authoritative message the tool part usually
  // precedes its request part. Authorization therefore runs in two passes:
  // every request part is gathered first, then tool parts are matched against
  // them, so intra-message part order can never demote a requested vault tool
  // to server-owned.
  const requested = new Map<string, ToolTarget>();
  const authorized = new Map<string, ToolTarget>();
  const serverOwned = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const parsed = parseThinAgentDataPart(part);
      if (
        parsed?.kind !== "known"
        || parsed.type !== "data-systemsculpt-client-tool-request"
      ) continue;
      const callId = parsed.data.tool_call_id;
      const name = parsed.data.tool_name;
      const existing = requested.get(callId);
      if (
        serverOwned.has(callId)
        || !isFirstPartyToolName(name)
        || (existing && (
          existing.name !== name
          || canonicalAgentToolInput(existing.input)
            !== canonicalAgentToolInput(parsed.data.input)
        ))
      ) {
        requested.delete(callId);
        serverOwned.add(callId);
      } else {
        requested.set(callId, Object.freeze({ name, input: parsed.data.input }));
      }
    }
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (parseThinAgentDataPart(part)?.kind === "known") continue;
      const callId = toolCallId(part);
      const name = toolName(part);
      if (!callId || !name) continue;
      const target = requested.get(callId);
      if (
        serverOwned.has(callId)
        || !isFirstPartyToolName(name)
        || !target
        || target.name !== name
      ) {
        requested.delete(callId);
        authorized.delete(callId);
        serverOwned.add(callId);
      } else {
        authorized.set(callId, target);
      }
    }
  }
  return authorized;
}

function canonicalTools(
  messages: readonly WireMessage[],
  targets: ToolTargetMap,
): ReadonlyMap<string, ProjectedTool & { messageId: string; partIndex: number }> {
  const tools = new Map<string, ProjectedTool & { messageId: string; partIndex: number }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    message.parts.forEach((part, partIndex) => {
      const callId = toolCallId(part);
      const name = toolName(part);
      if (!callId || !name) return;
      const target = targets.get(callId);
      const projected = {
        callId,
        name,
        input: target?.input ?? toolInput(part),
        location: target?.name === name ? "vault" as const : "server" as const,
        part,
        messageId: message.id,
        partIndex,
      };
      const current = tools.get(callId);
      if (!current || toolStateRank(part) >= toolStateRank(current.part)) {
        tools.set(callId, current
          ? { ...projected, messageId: current.messageId, partIndex: current.partIndex }
          : projected);
      }
    });
  }
  return tools;
}

function toolStateRank(part: WirePart): number {
  switch (part.state) {
    case "input-streaming": return 0;
    case "input-available": return 1;
    case "approval-requested": return 2;
    case "approval-responded": return 3;
    case "output-available":
      return part.preliminary === true ? 4 : 5;
    case "output-denied":
    case "output-error":
      return 5;
    default:
      return 0;
  }
}

function isAuthoritativeTerminalToolPart(part: WirePart): boolean {
  return part.state === "output-error"
    || part.state === "output-denied"
    || (part.state === "output-available" && part.preliminary !== true);
}

function outputAsToolResult(output: unknown): ToolCallResult {
  return isRecord(output) && typeof output.success === "boolean"
    ? output as unknown as ToolCallResult
    : { success: true, data: output };
}

function toolResultArtifacts(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "callId" | "name" | "location" | "input">,
): ToolResultSummary["artifacts"] {
  if (tool.location !== "vault") return undefined;
  const input = isRecord(tool.input) ? tool.input : {};
  const paths = result.success
    ? collectToolArtifactPaths(tool.name, input, result.data)
    : collectSuccessfulToolArtifactPaths(tool.name, result.data);
  return paths.length > 0
    ? paths.map((path) => ({
        id: `${tool.callId}:artifact:${path}`,
        kind: "vault_file" as const,
        title: path.split("/").pop() || path,
        path,
      }))
    : undefined;
}

function defaultToolFailureMessage(
  tool: Pick<ProjectedTool, "name" | "location">,
): string {
  if (tool.location === "vault") return "The vault action failed.";
  return tool.name === "web_search"
    ? "Web search failed."
    : "The server action failed.";
}

function sanitizeVaultResultData(
  value: AgentJsonValue,
  key = "",
): AgentJsonValue {
  if (
    typeof value === "string"
    && /^(?:cause|error(?:s|Text)?|message(?:s)?|reason(?:s)?|stack)$/i.test(key)
  ) return "The vault action failed.";
  if (Array.isArray(value)) {
    // Keep the owning field while walking an array. Otherwise a structured
    // payload such as `open.errors: ["/private/vault failure"]` loses the
    // `errors` key at the array boundary and leaks raw local failure text.
    // Entries remain in place so safe counts and sibling path metadata keep
    // their exact shape for Partial/Failed presentation.
    return value.map((entry) => sanitizeVaultResultData(entry, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeVaultResultData(entry as AgentJsonValue, entryKey),
    ]));
  }
  return value;
}

function safeOutboundVaultToolResult(result: ToolCallResult): ToolCallResult {
  const data = result.data === undefined
    ? undefined
    : sanitizeVaultResultData(toJsonValue(result.data));
  if (result.success) {
    return {
      success: true,
      ...(data !== undefined ? { data } : {}),
    };
  }
  return {
    success: false,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: "The vault action failed.",
    },
    ...(data !== undefined ? { data } : {}),
  };
}

function safeToolResult(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "name" | "location">,
): ToolCallResult {
  if (tool.location !== "server" || result.success) return result;
  return {
    success: false,
    error: {
      code: "TOOL_EXECUTION_FAILED",
      message: defaultToolFailureMessage(tool),
    },
  };
}

function toolResultSummary(
  result: ToolCallResult,
  tool: Pick<ProjectedTool, "callId" | "name" | "location" | "input">,
): ToolResultSummary {
  const artifacts = toolResultArtifacts(result, tool);
  return result.success
    ? {
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      }
    : {
        summary: result.error?.message ?? defaultToolFailureMessage(tool),
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      };
}

function toolIdentity(tool: Pick<ProjectedTool, "name" | "input">): ToolIdentity {
  return Object.freeze({
    toolName: tool.name,
    canonicalInput: canonicalAgentToolInput(tool.input),
  });
}

function sameToolIdentity(left: ToolIdentity, right: ToolIdentity): boolean {
  return left.toolName === right.toolName
    && left.canonicalInput === right.canonicalInput;
}

function projectedToolResult(
  tool: ProjectedTool,
  active: ActiveRun,
): ToolCallResult | undefined {
  const authoritative = isAuthoritativeTerminalToolPart(tool.part);
  if (authoritative && tool.part.state === "output-available") {
    return safeToolResult(outputAsToolResult(toolOutput(tool.part)), tool);
  }
  if (
    tool.location === "vault"
    && !authoritative
  ) {
    const identity = active.toolIdentities.get(tool.callId);
    if (!identity || !sameToolIdentity(identity, toolIdentity(tool))) {
      return undefined;
    }
    return active.completedLocalToolResults.get(tool.callId);
  }
  return undefined;
}

function discardSupersededLocalToolResults(
  active: ActiveRun,
  tools: ReadonlyMap<string, ProjectedTool>,
): void {
  for (const callId of active.completedLocalToolResults.keys()) {
    const tool = tools.get(callId);
    const identity = active.toolIdentities.get(callId);
    if (
      !tool
      || tool.location !== "vault"
      || !identity
      || !sameToolIdentity(identity, toolIdentity(tool))
    ) continue;
    if (isAuthoritativeTerminalToolPart(tool.part)) {
      active.completedLocalToolResults.delete(callId);
    }
  }
}

function projectedToolState(
  tool: ProjectedTool,
  active: ActiveRun,
  result = projectedToolResult(tool, active),
): AgentToolPart["state"] {
  if (tool.part.state === "output-error") return "failed";
  if (tool.part.state === "output-denied") return "denied";
  if (result) return result.success ? "succeeded" : "failed";
  if (active.executingToolIds.has(tool.callId)) return "running";
  const decision = active.approvalDecisions.get(tool.callId);
  const locallyApproved = decision?.approved === true
    && sameToolIdentity(decision.identity, toolIdentity(tool));
  if (tool.location === "server") {
    switch (tool.part.state) {
      case "input-streaming": return "input-streaming";
      case "output-available":
        return tool.part.preliminary === true
          ? "running"
          : outputAsToolResult(toolOutput(tool.part)).success ? "succeeded" : "failed";
      case "output-error": return "failed";
      case "output-denied": return "denied";
      default: return "running";
    }
  }
  switch (tool.part.state) {
    case "input-streaming": return "input-streaming";
    case "input-available":
      return requiresUserApproval(tool.name, active.approvalPolicy)
        ? decision === undefined
          ? "approval-required"
          : locallyApproved
            ? "approved"
            : "denied"
        : "input-ready";
    case "approval-requested":
      return decision === undefined
        ? "approval-required"
        : locallyApproved
          ? "approved"
          : "denied";
    case "approval-responded":
      if (toolApproval(tool.part)?.approved === false) return "denied";
      return requiresUserApproval(tool.name, active.approvalPolicy)
        ? locallyApproved ? "approved" : "approval-required"
        : "approved";
    case "output-available":
      return tool.part.preliminary === true
        ? "running"
        : outputAsToolResult(toolOutput(tool.part)).success ? "succeeded" : "failed";
    case "output-error": return "failed";
    case "output-denied": return "denied";
    default: return "input-ready";
  }
}

function toolFailure(
  tool: ProjectedTool,
  result: ToolCallResult | undefined,
): ManagedAgentError | undefined {
  const part = tool.part;
  if (part.state === "output-error") {
    return {
      code: "TOOL_EXECUTION_FAILED",
      message: tool.location === "server"
        ? defaultToolFailureMessage(tool)
        : typeof part.errorText === "string"
          ? part.errorText
          : defaultToolFailureMessage(tool),
    };
  }
  if (result && !result.success) {
    return {
      code: result.error?.code ?? "TOOL_EXECUTION_FAILED",
      message: result.error?.message ?? defaultToolFailureMessage(tool),
    };
  }
  return undefined;
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_SOURCE_URL_LENGTH) return null;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function markdownSourceTitle(value: unknown, fallback: string): string {
  const title = typeof value === "string" ? value : "";
  return (title.trim() || fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SOURCE_TITLE_LENGTH)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]<>])/g, "\\$1");
}

function nativeSourceMarkdown(messages: readonly WireMessage[]): string {
  const seen = new Set<string>();
  const sources: Array<Readonly<{ url: string; title: string }>> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "source-url") continue;
      const url = safeSourceUrl(part.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: markdownSourceTitle(part.title, url) });
      if (sources.length >= MAX_SOURCE_URLS) break;
    }
    if (sources.length >= MAX_SOURCE_URLS) break;
  }
  return sources.length > 0
    ? `### Sources\n\n${sources.map(({ title, url }) => `- [${title}](<${url}>)`).join("\n")}`
    : "";
}

function freezeSnapshot(snapshot: AgentConversationSnapshot): AgentConversationSnapshot {
  return Object.freeze({
    ...snapshot,
    messages: Object.freeze(snapshot.messages.map((message) => Object.freeze({
      ...message,
      partIds: Object.freeze([...message.partIds]),
    }))),
    parts: Object.freeze(snapshot.parts.map((part) => Object.freeze(part))),
  });
}

function partProgressToken(part: WirePart): readonly unknown[] {
  const approval = isRecord(part.approval) ? part.approval : null;
  const output = isRecord(part.output) ? part.output : null;
  return [
    part.type,
    typeof part.text === "string" ? part.text.length : null,
    typeof part.state === "string" ? part.state : null,
    toolCallId(part),
    typeof approval?.id === "string" ? approval.id : null,
    typeof approval?.approved === "boolean" ? approval.approved : null,
    typeof part.preliminary === "boolean" ? part.preliminary : null,
    Object.prototype.hasOwnProperty.call(part, "output"),
    typeof output?.success === "boolean" ? output.success : null,
    Object.prototype.hasOwnProperty.call(part, "error"),
  ];
}

/**
 * Content-free "did the server produce anything new" fingerprint.
 *
 * Run cursors need not advance for accepted assistant replacements. Track the
 * latest assistant's semantic part state as well, so text/reasoning growth and
 * tool approval/result transitions cancel a stalled recovery immediately.
 */
function runProgressKey(
  snapshot: AgentSessionSnapshot<WireMessage>,
): string {
  const messages = snapshot.messages;
  let assistant: WireMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistant = messages[index];
      break;
    }
  }
  const parts = assistant?.parts ?? [];
  const runState = snapshot.runState;
  const runId = "run_id" in runState ? runState.run_id : "";
  return JSON.stringify([
    runState.state,
    runState.cursor,
    runId,
    messages.length,
    assistant?.id ?? null,
    parts.map(partProgressToken),
  ]);
}

function projectRun(
  active: ActiveRun,
  messages: readonly WireMessage[],
  connectionState: AgentConnectionState,
  runStalled = false,
): AgentConversationSnapshot {
  const turnMessages = currentTurnMessages(messages, active.turnId);
  const targets = collectClientToolTargets(turnMessages);
  const tools = canonicalTools(turnMessages, targets);
  discardSupersededLocalToolResults(active, tools);
  const parts: AgentPart[] = [];
  const projectedMessages: AgentConversationSnapshot["messages"][number][] = [];
  let order = 0;
  const assistantMessages = turnMessages.filter((message) => message.role === "assistant");
  const sourceMarkdown = nativeSourceMarkdown(assistantMessages);
  const finalAssistantId = assistantMessages[assistantMessages.length - 1]?.id;

  for (const message of assistantMessages) {
    const partIds: string[] = [];
    message.parts.forEach((part, partIndex) => {
      if (part.type === "text" && typeof part.text === "string") {
        const id = `text:${message.id}:${partIndex}`;
        partIds.push(id);
        parts.push({
          id,
          kind: "text",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          markdown: part.text,
          order: order++,
        });
        return;
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        const id = `reasoning:${message.id}:${partIndex}`;
        partIds.push(id);
        parts.push({
          id,
          kind: "reasoning",
          messageId: message.id,
          state: part.state === "streaming" ? "streaming" : "complete",
          summary: part.text,
          order: order++,
        });
        return;
      }
      const callId = toolCallId(part);
      if (!callId) return;
      const tool = tools.get(callId);
      if (!tool || tool.messageId !== message.id || tool.partIndex !== partIndex
        || INTERNAL_SERVER_TOOL_NAMES.has(tool.name)) return;
      const id = `tool:${callId}`;
      const result = projectedToolResult(tool, active);
      const state = projectedToolState(tool, active, result);
      const approval = toolApproval(tool.part);
      const syntheticApprovalId = active.approvalIds.get(callId);
      const failure = toolFailure(tool, result);
      partIds.push(id);
      parts.push({
        id,
        kind: "tool",
        messageId: message.id,
        callId,
        name: tool.name,
        location: tool.location,
        input: tool.input,
        state,
        ...(approval?.id || syntheticApprovalId
          ? { approvalId: approval?.id ?? syntheticApprovalId }
          : {}),
        ...(result ? { output: toolResultSummary(result, tool) } : {}),
        ...(failure ? { error: failure } : {}),
        order: order++,
      });
    });
    if (sourceMarkdown && message.id === finalAssistantId) {
      const id = `sources:${message.id}`;
      partIds.push(id);
      parts.push({
        id,
        kind: "text",
        messageId: message.id,
        state: "complete",
        markdown: sourceMarkdown,
        order: order++,
      });
    }
    projectedMessages.push(Object.freeze({
      id: message.id,
      role: "assistant" as const,
      partIds: Object.freeze(partIds),
    }));
  }

  let status: AgentConversationSnapshot["status"] = "running";
  let phase = active.phase;
  let label = active.label;
  let waitingReason: AgentConversationSnapshot["waitingReason"];
  let error: ManagedAgentError | undefined;
  if (active.terminal?.outcome === "succeeded") {
    status = "completed";
    phase = "complete";
    label = "";
  } else if (active.terminal?.outcome === "cancelled") {
    status = "cancelled";
    phase = "complete";
    label = "Stopped";
  } else if (active.terminal?.outcome === "failed") {
    status = "failed";
    error = terminalError(active.terminal);
  } else if (active.cancelRequested) {
    label = "Stopping";
  } else if (connectionState !== "open") {
    phase = "retrying";
    label = connectionState === "connecting" ? "Starting" : "Reconnecting";
  } else if (active.serverQueued) {
    phase = "submitted";
    label = "Queued";
  } else if (parts.some((part) =>
    part.kind === "tool" && part.state === "approval-required")) {
    status = "waiting";
    phase = "waiting";
    label = "Waiting for approval";
    waitingReason = "approval";
  } else if (runStalled) {
    // Synchronization is healthy, but the server has sent no run progress.
    // Keep the run open because only the server may end it.
    phase = "retrying";
    label = "Still waiting on the server";
  } else if (active.executingToolIds.size > 0) {
    status = "waiting";
    phase = "waiting";
    label = "Working in your vault";
    waitingReason = "local_tool";
  } else if (parts.some((part) => part.kind === "text" && part.state === "streaming")) {
    phase = "working";
    label = "Responding";
  } else if (parts.some((part) => part.kind === "tool")) {
    phase = "working";
    label = "Working";
  } else {
    phase = "thinking";
    label = "Thinking";
  }
  if (error) {
    parts.push({
      id: `error:${active.turnId}`,
      kind: "error",
      error,
      retryable: error.retryable === true,
      retryMessageId: active.turnId,
      order: order++,
    });
  }
  return freezeSnapshot({
    runId: active.serverRunId,
    turnId: active.turnId,
    status,
    ...(active.elapsedMs === null ? {} : { elapsedMs: active.elapsedMs }),
    phase,
    ...(label ? { statusLabel: label } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(error ? { terminalError: error } : {}),
    messages: Object.freeze(projectedMessages),
    parts: Object.freeze(parts),
  });
}

type IncidentSnapshotCounts = Readonly<{
  assistantTextPartCount: number;
  assistantTextStreamingPartCount: number;
  assistantTextCompletePartCount: number;
  assistantTextCharacterCount: number;
  reasoningPartCount: number;
  reasoningStreamingPartCount: number;
  reasoningCompletePartCount: number;
  reasoningCharacterCount: number;
  assistantOutputPresentBeforeFailure: boolean;
  assistantOutputRetainedInFailedProjection: boolean;
  snapshotPartCount: number;
  truncated: boolean;
}>;

type IncidentFailureScalars = Readonly<{
  failureAuthority: "server" | "client";
  failureStage: AgentIncidentFailureStage;
  failureMechanism: AgentIncidentFailureMechanism;
  terminalValidation: "validated" | "unvalidated";
  terminalSource: AgentRunFailureCaptureEvent["terminalSource"];
  retryable: boolean;
  runPhase?: AgentRunPhase;
  serverRunId?: string;
  incidentId?: string;
  failureCode?: string;
}>;

function addIncidentCount(
  current: number,
  addition: number,
): Readonly<{ value: number; truncated: boolean }> {
  if (
    !Number.isSafeInteger(addition)
    || addition < 0
    || current > MAX_INCIDENT_CAPTURE_COUNT - addition
  ) {
    return { value: MAX_INCIDENT_CAPTURE_COUNT, truncated: true };
  }
  return { value: current + addition, truncated: false };
}

function incidentSnapshotCounts(
  snapshot: AgentConversationSnapshot,
): IncidentSnapshotCounts {
  let assistantTextPartCount = 0;
  let assistantTextStreamingPartCount = 0;
  let assistantTextCompletePartCount = 0;
  let assistantTextCharacterCount = 0;
  let reasoningPartCount = 0;
  let reasoningStreamingPartCount = 0;
  let reasoningCompletePartCount = 0;
  let reasoningCharacterCount = 0;
  let assistantOutputPresentBeforeFailure = false;
  let truncated = snapshot.parts.length > MAX_INCIDENT_CAPTURE_COUNT;
  for (const part of snapshot.parts) {
    if (part.kind === "text") {
      const parts = addIncidentCount(assistantTextPartCount, 1);
      const streamingParts = part.state === "streaming"
        ? addIncidentCount(assistantTextStreamingPartCount, 1)
        : { value: assistantTextStreamingPartCount, truncated: false };
      const completeParts = part.state === "complete"
        ? addIncidentCount(assistantTextCompletePartCount, 1)
        : { value: assistantTextCompletePartCount, truncated: false };
      const characters = addIncidentCount(
        assistantTextCharacterCount,
        part.markdown.length,
      );
      assistantTextPartCount = parts.value;
      assistantTextStreamingPartCount = streamingParts.value;
      assistantTextCompletePartCount = completeParts.value;
      assistantTextCharacterCount = characters.value;
      assistantOutputPresentBeforeFailure = assistantOutputPresentBeforeFailure
        || (Number.isSafeInteger(part.markdown.length) && part.markdown.length > 0);
      truncated = truncated
        || parts.truncated
        || streamingParts.truncated
        || completeParts.truncated
        || characters.truncated;
    } else if (part.kind === "reasoning") {
      const parts = addIncidentCount(reasoningPartCount, 1);
      const streamingParts = part.state === "streaming"
        ? addIncidentCount(reasoningStreamingPartCount, 1)
        : { value: reasoningStreamingPartCount, truncated: false };
      const completeParts = part.state === "complete"
        ? addIncidentCount(reasoningCompletePartCount, 1)
        : { value: reasoningCompletePartCount, truncated: false };
      const characters = addIncidentCount(
        reasoningCharacterCount,
        part.summary.length,
      );
      reasoningPartCount = parts.value;
      reasoningStreamingPartCount = streamingParts.value;
      reasoningCompletePartCount = completeParts.value;
      reasoningCharacterCount = characters.value;
      truncated = truncated
        || parts.truncated
        || streamingParts.truncated
        || completeParts.truncated
        || characters.truncated;
    }
  }
  return {
    assistantTextPartCount,
    assistantTextStreamingPartCount,
    assistantTextCompletePartCount,
    assistantTextCharacterCount,
    reasoningPartCount,
    reasoningStreamingPartCount,
    reasoningCompletePartCount,
    reasoningCharacterCount,
    assistantOutputPresentBeforeFailure,
    assistantOutputRetainedInFailedProjection:
      snapshot.status === "failed" && assistantOutputPresentBeforeFailure,
    snapshotPartCount: Math.min(
      snapshot.parts.length,
      MAX_INCIDENT_CAPTURE_COUNT,
    ),
    truncated,
  };
}

function boundedIncidentPendingCount(
  value: number,
): Readonly<{ value: number; truncated: boolean }> {
  return value > MAX_TOOL_EXECUTIONS_PER_RUN
    ? { value: MAX_TOOL_EXECUTIONS_PER_RUN, truncated: true }
    : { value, truncated: false };
}

function boundedIncidentElapsedMs(
  value: number | null,
): Readonly<{ value?: number; truncated: boolean }> {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return { truncated: false };
  }
  if (value > MAX_INCIDENT_CAPTURE_ELAPSED_MS) {
    return { value: MAX_INCIDENT_CAPTURE_ELAPSED_MS, truncated: true };
  }
  return { value: Math.round(value), truncated: false };
}

// Must not exceed the protocol codec's MAX_JSON_DEPTH: content beyond the
// protocol bound drops here so a deep result degrades instead of failing the
// whole client_tool_result command at encode time.
const TOOL_JSON_MAX_DEPTH = 16;
const OMITTED_JSON_VALUE = Symbol("systemsculpt-omitted-json-value");

/**
 * Tool results are arbitrary JavaScript values produced by local tool
 * implementations, so this boundary must mirror JSON.stringify semantics
 * rather than throw: an undefined optional field, a NaN, a Date, a function,
 * or a cycle anywhere in a result must never fail the whole tool delivery.
 * Undefined, functions, symbols, bigints, and cyclic references drop from
 * records and become null in arrays; non-finite numbers become null; toJSON
 * is honored.
 */
function toJsonValue(value: unknown): AgentJsonValue {
  const cloned = jsonSafeClone(value, new WeakSet(), 0, false);
  return cloned === OMITTED_JSON_VALUE ? null : cloned;
}

function jsonSafeClone(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  skipToJson: boolean,
): AgentJsonValue | typeof OMITTED_JSON_VALUE {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") return OMITTED_JSON_VALUE;
  if (ancestors.has(value) || depth >= TOOL_JSON_MAX_DEPTH) return OMITTED_JSON_VALUE;
  if (!skipToJson) {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      try {
        return jsonSafeClone(toJson.call(value), ancestors, depth, true);
      } catch {
        return OMITTED_JSON_VALUE;
      }
    }
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => {
        const cloned = jsonSafeClone(entry, ancestors, depth + 1, false);
        return cloned === OMITTED_JSON_VALUE ? null : cloned;
      }));
    }
    const output: Record<string, AgentJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = jsonSafeClone(entry, ancestors, depth + 1, false);
      if (cloned !== OMITTED_JSON_VALUE) output[key] = cloned;
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function textFromDataUrl(url: string): string {
  const comma = url.indexOf(",");
  if (comma < 0 || !/;base64$/iu.test(url.slice(0, comma))) {
    throw new Error("Unsupported text file URL.");
  }
  const binary = atob(url.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function durableUserMessage(message: WireMessage): ChatMessage {
  const parts: MultiPartContent[] = [];
  let hasFile = false;
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (
      part.type === "file"
      && typeof part.mediaType === "string"
      && typeof part.url === "string"
    ) {
      hasFile = true;
      if (part.mediaType.startsWith("image/")) {
        parts.push({ type: "image_url", image_url: { url: part.url } });
      } else {
        const name = typeof part.filename === "string" && part.filename.trim()
          ? part.filename.trim()
          : "attachment";
        try {
          const decoded = textFromDataUrl(part.url);
          parts.push(parseAttachedTextContent(decoded)
            ? { type: "text", text: decoded }
            : createTextAttachmentPart(
                name,
                part.mediaType,
                new TextEncoder().encode(decoded),
              ));
        } catch {
          parts.push(createUnavailableAttachmentPart(name, part.mediaType));
        }
      }
    }
  }
  return {
    role: "user",
    message_id: message.id,
    content: hasFile
      ? parts
      : parts
          .filter((part): part is Extract<MultiPartContent, { type: "text" }> =>
            part.type === "text")
          .map((part) => part.text)
          .join(""),
  };
}

function durableTool(
  tool: ProjectedTool,
  timestamp: number,
): ToolCall | null {
  const state = tool.part.state;
  if (!isAuthoritativeTerminalToolPart(tool.part)) return null;
  if (state === "output-available") {
    const result = safeToolResult(
      outputAsToolResult(toolOutput(tool.part)),
      tool,
    );
    return {
      id: tool.callId,
      messageId: "",
      request: {
        id: tool.callId,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
      },
      state: result.success ? "completed" : "failed",
      timestamp,
      result,
      ...(tool.location === "server" ? { executedOn: "server" as const } : {}),
    };
  }
  return {
    id: tool.callId,
    messageId: "",
    request: {
      id: tool.callId,
      type: "function",
      function: { name: tool.name, arguments: JSON.stringify(tool.input ?? {}) },
    },
    state: "failed",
    timestamp,
    result: {
      success: false,
      error: state === "output-denied"
        ? { code: "USER_DENIED", message: "The user denied this vault action." }
        : {
            code: "TOOL_EXECUTION_FAILED",
            message: tool.location === "server"
              ? defaultToolFailureMessage(tool)
              : typeof tool.part.errorText === "string"
                ? tool.part.errorText
                : "The vault action failed.",
          },
    },
    ...(tool.location === "server" ? { executedOn: "server" as const } : {}),
  };
}

function durableAssistantMessage(
  message: WireMessage,
  sequence: readonly WireMessage[],
  now: number,
  appendSources: boolean,
  responseDurationMs?: number,
): ChatMessage | null {
  const targets = collectClientToolTargets(sequence);
  const tools = canonicalTools(sequence, targets);
  const messageParts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let content = "";
  let order = 0;
  message.parts.forEach((part, partIndex) => {
    const timestamp = now + order;
    if (part.type === "text" && typeof part.text === "string") {
      content += part.text;
      messageParts.push({
        id: `text:${message.id}:${partIndex}`,
        type: "content",
        timestamp,
        data: part.text,
      });
      order += 1;
      return;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      messageParts.push({
        id: `reasoning:${message.id}:${partIndex}`,
        type: "reasoning",
        timestamp,
        data: part.text,
      });
      order += 1;
      return;
    }
    const callId = toolCallId(part);
    if (!callId) return;
    const tool = tools.get(callId);
    if (!tool || tool.messageId !== message.id || tool.partIndex !== partIndex
      || INTERNAL_SERVER_TOOL_NAMES.has(tool.name)) return;
    const durable = durableTool(tool, timestamp);
    if (!durable) return;
    durable.messageId = message.id;
    toolCalls.push(durable);
    messageParts.push({
      id: `tool:${callId}`,
      type: "tool_call",
      timestamp,
      data: durable,
    });
    order += 1;
  });
  if (appendSources) {
    const sources = nativeSourceMarkdown(sequence);
    if (sources) {
      content += content ? `\n\n${sources}` : sources;
      messageParts.push({
        id: `sources:${message.id}`,
        type: "content",
        timestamp: now + order,
        data: sources,
      });
    }
  }
  const hasTerminal = message.parts.some((part) => {
    const parsed = parseThinAgentDataPart(part);
    return parsed?.kind === "known"
      && parsed.type === "data-systemsculpt-run-terminal";
  });
  if (!content && messageParts.length === 0 && hasTerminal) return null;
  return {
    role: "assistant",
    message_id: message.id,
    content,
    ...(responseDurationMs === undefined ? {} : { responseDurationMs }),
    ...(messageParts.length > 0 ? { messageParts } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

type DurableTerminalMetadata =
  | Readonly<{ terminalOutcome: "cancelled" }>
  | Readonly<{
      terminalOutcome: "failed";
      terminalIncidentId: string;
      terminalFailureCode: string;
      terminalRetryable: boolean;
      terminalServerRunId: string;
    }>;

function durableTerminalMetadata(
  terminal: ThinAgentRunTerminalData,
): DurableTerminalMetadata | null {
  if (terminal.outcome === "cancelled") {
    return { terminalOutcome: "cancelled" };
  }
  if (
    terminal.outcome !== "failed"
    || !isThinAgentIncidentId(terminal.incident_id)
    || terminal.incident_id === `incident_${"0".repeat(32)}`
    || !isThinAgentFailureCode(terminal.code)
    || !isThinAgentServerRunId(terminal.run_id)
    || terminal.run_id === `run_${"0".repeat(32)}`
  ) return null;
  return {
    terminalOutcome: "failed",
    terminalIncidentId: terminal.incident_id,
    terminalFailureCode: terminal.code,
    terminalRetryable: terminal.retryable,
    terminalServerRunId: terminal.run_id,
  };
}

/**
 * Validated terminal presentation data carried by an assistant wire sequence,
 * whether folded into a streamed message or stored as a marker sibling.
 */
function sequenceTerminalMetadata(
  sequence: readonly WireMessage[],
  rootMessageId: string | null,
): Readonly<{ messageId: string; metadata: DurableTerminalMetadata }> | null {
  if (rootMessageId === null) return null;
  for (let messageIndex = sequence.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = sequence[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const parsed = parseThinAgentDataPart(message.parts[partIndex]);
      if (
        parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal"
        && parsed.data.root_message_id === rootMessageId
      ) {
        const metadata = durableTerminalMetadata(parsed.data);
        return metadata ? { messageId: message.id, metadata } : null;
      }
    }
  }
  return null;
}

type DurableTurnPresentation = Readonly<{
  rootMessageId: string;
  responseDurationMs: number;
}>;

function durableServerHistory(
  messages: readonly WireMessage[],
  now: number,
  turnPresentation?: DurableTurnPresentation,
): ChatMessage[] {
  const output: ChatMessage[] = [];
  let rootMessageId: string | null = null;
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === "user") {
      output.push(durableUserMessage(message));
      rootMessageId = message.id;
      index += 1;
      continue;
    }
    const start = index;
    while (index < messages.length && messages[index]!.role === "assistant") index += 1;
    const sequence = messages.slice(start, index);
    const terminal = sequenceTerminalMetadata(sequence, rootMessageId);
    const sequenceStart = output.length;
    sequence.forEach((assistant, sequenceIndex) => {
      const durable = durableAssistantMessage(
        assistant,
        sequence,
        now + (start + sequenceIndex) * 1_000,
        sequenceIndex === sequence.length - 1,
      );
      if (durable) output.push(durable);
    });
    if (
      output.length === sequenceStart
      && terminal?.metadata.terminalOutcome === "failed"
    ) {
      output.push({
        role: "assistant",
        message_id: terminal.messageId,
        content: "",
        ...terminal.metadata,
      });
    } else if (terminal && output.length > sequenceStart) {
      const tail = output[output.length - 1]!;
      output[output.length - 1] = { ...tail, ...terminal.metadata };
    }
    if (
      turnPresentation
      && rootMessageId === turnPresentation.rootMessageId
      && output.length > sequenceStart
    ) {
      const tail = output[output.length - 1]!;
      output[output.length - 1] = {
        ...tail,
        responseDurationMs: turnPresentation.responseDurationMs,
      };
    }
  }
  return output;
}

function hasDurableAssistantContent(
  messages: readonly ChatMessage[],
  rootMessageId: string,
): boolean {
  // durableServerHistory emits only user and assistant messages. It mirrors
  // tool parts into tool_calls and text parts into the string content field.
  const rootIndex = messages.findIndex((message) =>
    message.role === "user" && message.message_id === rootMessageId);
  if (rootIndex < 0) return false;
  for (let index = rootIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if ((message.tool_calls?.length ?? 0) > 0) return true;
    if (message.messageParts?.some((part) =>
      part.type === "reasoning" && part.data.trim().length > 0)) return true;
    if (typeof message.content === "string" && message.content.trim().length > 0) return true;
  }
  return false;
}

/**
 * Build the terminal-only durability view of authoritative history.
 *
 * The server can legitimately finish after accepting a client tool result
 * while its last assistant snapshot still contains only the original
 * `input-available` part (or an SDK `preliminary` echo). Live projection keeps
 * the locally settled result visible from ActiveRun, but persistence otherwise
 * consumes that stale wire part and drops the tool on save/reconcile.
 *
 * Only the exact vault call that executed locally may be upgraded. A final
 * wire outcome remains authoritative, server-owned tools are never touched,
 * and the stored execution identity must still match the current request.
 */
function overlayCompletedLocalToolResults(
  messages: readonly WireMessage[],
  active: Pick<
    ActiveRun,
    "turnId" | "completedLocalToolResults" | "toolIdentities"
  >,
): readonly WireMessage[] {
  if (active.completedLocalToolResults.size === 0) return messages;
  const turn = currentTurnMessages(messages, active.turnId);
  const targets = collectClientToolTargets(turn);
  const tools = canonicalTools(turn, targets);
  const replacements = new Map<WirePart, WirePart>();

  for (const [callId, result] of active.completedLocalToolResults) {
    const tool = tools.get(callId);
    const identity = active.toolIdentities.get(callId);
    if (
      !tool
      || tool.location !== "vault"
      || !identity
      || !sameToolIdentity(identity, toolIdentity(tool))
      || isAuthoritativeTerminalToolPart(tool.part)
    ) continue;

    const safeResult = safeOutboundVaultToolResult(result);
    replacements.set(tool.part, Object.freeze({
      ...tool.part,
      state: "output-available",
      output: toJsonValue(safeResult),
      preliminary: false,
    }));
  }

  if (replacements.size === 0) return messages;
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      const replacement = replacements.get(part);
      if (!replacement) return part;
      changed = true;
      return replacement;
    });
    return changed
      ? Object.freeze({ ...message, parts: Object.freeze(parts) })
      : message;
  });
}

function terminalFromMessages(
  messages: readonly WireMessage[],
  rootMessageId: string,
  runId?: string | null,
): ThinAgentRunTerminalData | null {
  const turn = currentTurnMessages(messages, rootMessageId);
  for (let messageIndex = turn.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = turn[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const parsed = parseThinAgentDataPart(message.parts[partIndex]);
      if (
        parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal"
        && parsed.data.root_message_id === rootMessageId
        && (!runId || parsed.data.run_id === runId)
      ) return parsed.data;
    }
  }
  return null;
}

/**
 * Reinstate the streamed assistant tail of an interrupted run into the final
 * durable projection. A durable session snapshot built between cancellation
 * and the server's terminal fold can omit content that already streamed;
 * finalization is the last owner able to keep that content durable. When the
 * projection carries no run-terminal part, the terminal is folded into the
 * restored tail so restored history still knows the turn ended early.
 */
function restoreInterruptedTurnTail(
  messages: readonly WireMessage[],
  active: Pick<ActiveRun, "turnId" | "streamedTurnMessages">,
  terminal: ThinAgentRunTerminalData,
): readonly WireMessage[] {
  const rootIndex = messages.findIndex((message) => message.id === active.turnId);
  if (rootIndex < 0) return messages;
  let end = rootIndex + 1;
  while (end < messages.length && messages[end]!.role !== "user") end += 1;
  const turn = messages.slice(rootIndex + 1, end);
  const present = new Set(turn.map((message) => message.id));
  const missing = active.streamedTurnMessages.filter((message) =>
    message.role === "assistant" && !present.has(message.id));
  const restored = [...turn, ...missing];
  if (restored.length === 0) {
    if (terminal.outcome !== "failed") return messages;
    restored.push({
      id: `terminal:${terminal.run_id}`,
      role: "assistant",
      parts: [],
    });
  }
  const hasTerminalPart = restored.some((message) =>
    message.parts.some((part) => {
      const parsed = parseThinAgentDataPart(part);
      return parsed?.kind === "known"
        && parsed.type === "data-systemsculpt-run-terminal";
    }));
  if (missing.length === 0 && hasTerminalPart) return messages;
  if (!hasTerminalPart) {
    const last = restored[restored.length - 1]!;
    restored[restored.length - 1] = {
      ...last,
      parts: [
        ...last.parts,
        {
          type: "data-systemsculpt-run-terminal",
          id: `terminal:${terminal.run_id}`,
          data: terminal,
        },
      ],
    };
  }
  return [
    ...messages.slice(0, rootIndex + 1),
    ...restored,
    ...messages.slice(end),
  ];
}

function latestUserId(messages: readonly WireMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return messages[index]!.id;
  }
  return null;
}

function initialSnapshot(): AgentConversationSnapshot {
  return freezeSnapshot({
    runId: null,
    turnId: null,
    status: "idle",
    messages: [],
    parts: [],
  });
}

function responseStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number"
    ? error.status
    : undefined;
}

function incidentFailureMechanism(
  error: Pick<ManagedAgentError, "status">,
  fallback: AgentIncidentFailureMechanism,
): AgentIncidentFailureMechanism {
  return Number.isInteger(error.status)
    && error.status !== undefined
    && error.status >= 400
    && error.status <= 599
    ? "http_rejection"
    : fallback;
}

function boundedErrorPayload(text: string): Readonly<{
  message?: string;
  incidentId?: string;
}> {
  if (text.length > 4_096) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) return {};
    const nested = isRecord(value.error) ? value.error : {};
    const rawMessage = nested.message ?? value.message;
    const rawIncident = nested.incident_id ?? value.incident_id;
    return {
      ...(typeof rawMessage === "string" ? { message: rawMessage } : {}),
      ...(typeof rawIncident === "string" && /^incident_[a-f0-9]{32}$/u.test(rawIncident)
        ? { incidentId: rawIncident }
        : {}),
    };
  } catch {
    return {};
  }
}

export class AgentChatSession {
  private readonly requestClient: RequestClient;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly listeners = new Set<(snapshot: AgentConversationSnapshot) => void>();
  private transport: AgentStreamingTransport | null = null;
  private session: AgentSession<WireMessage> | null = null;
  private detachSession: (() => void) | null = null;
  private detachConnectionState: (() => void) | null = null;
  private conversationId: string | null = null;
  private authoritativeMessages: readonly WireMessage[] = Object.freeze([]);
  private presentationMessages: readonly WireMessage[] = Object.freeze([]);
  private connectionState: AgentConnectionState = "idle";
  private runStalled = false;
  private runStallTimer: number | null = null;
  private runProgressKey = "";
  private awaitingClientWork = false;
  private currentSnapshot: AgentConversationSnapshot = initialSnapshot();
  private active: ActiveRun | null = null;
  private pendingRegenerate: PendingRegenerateDelivery | null = null;
  private pendingCancelRequestId: string | null = null;
  private pendingCancelInFlight = false;
  private readonly pendingDeliveries = new Map<string, PendingToolDelivery>();
  private readonly pendingApprovalDeliveries = new Map<string, PendingApprovalDelivery>();
  private inputLimits: ThinAgentInputLimits = DEFAULT_THIN_AGENT_INPUT_LIMITS;
  private readonly lifecycle: AgentLifecycle;
  private renderTimer: number | null = null;
  private pendingSnapshot: AgentConversationSnapshot | null = null;
  private pendingReconcile: Promise<void> = Promise.resolve();
  private pendingFinalization: Promise<void> = Promise.resolve();
  private reconciledKey: string | null = null;
  private reconciledMessages: readonly WireMessage[] | null = null;
  private generation = 0;
  private openEpoch = 0;
  private resynchronizationTimer: number | null = null;
  private resynchronizationInFlight = false;
  private resynchronizationAttempt = 0;
  private stallRecovery: StallRecovery | null = null;
  private readonly clientLatency = new Map<string, ClientLatencyContext>();

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
      ? this.clientLatencyFields(input.requestId)
      : {};
    this.lifecycle.record({ ...input, ...latency });
  }

  public recordClientRenderMilestone(
    code: "response_first_dom_committed" | "response_first_paint_opportunity",
    requestId: string,
    observedAtMonotonicMs: number,
  ): void {
    this.recordClientLatencyMilestone(code, requestId, observedAtMonotonicMs);
  }

  public needsClientRenderMilestone(
    code: "response_first_dom_committed" | "response_first_paint_opportunity",
    requestId: string,
  ): boolean {
    const context = this.clientLatency.get(requestId);
    return Boolean(context && !context.milestones.has(code));
  }

  public recordClientToolRenderMilestone(
    code: ClientToolRenderCode,
    requestId: string,
    toolCallId: string,
    observedAtMonotonicMs: number,
  ): void {
    this.recordClientToolLatencyMilestone(
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
    const context = this.clientLatency.get(requestId);
    const ordinal = context?.toolExecutionOrdinals.get(toolCallId);
    return Boolean(
      context
      && ordinal !== undefined
      && !context.toolMilestones.has(`${ordinal}:${code}`),
    );
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
        this.ensureClientLatency({
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
              ...this.clientLatencyFields(submittedLatency.requestId),
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
                ...this.clientLatencyFields(submittedLatency.requestId),
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
                ...this.clientLatencyFields(submittedLatency.requestId),
              }
            : {}),
          status: responseStatus(error),
          retryable: true,
        });
        throw managedError(
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
      this.ensureClientLatency({
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
        if (this.generation === generation) this.handleTransportTiming(event);
      },
      onSegmentSummary: (event) => {
        if (this.generation === generation) {
          this.handleTransportSegmentSummary(conversationId, event);
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
            ...this.clientLatencyFields(submittedLatency.requestId),
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
              ...this.clientLatencyFields(submittedLatency.requestId),
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
              ...this.clientLatencyFields(submittedLatency.requestId),
            }
          : {}),
        status: responseStatus(error),
        retryable: true,
      });
      throw managedError(
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
      ...this.clientLatencyFields(input.turnId),
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
        const historySync = this.createHistorySyncCorrelation("before_send");
        this.recordHistorySyncLifecycle("history_sync_started", historySync);
        try {
          await input.beforeSend();
          this.recordHistorySyncLifecycle("history_sync_completed", historySync);
        } catch (error) {
          this.recordHistorySyncLifecycle("history_sync_failed", historySync);
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
        ...this.clientLatencyFields(input.turnId),
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
        ...this.clientLatencyFields(input.turnId),
      });
      if (
        delivery === "sent"
        && !supersededByRecovery
        && this.isIncompleteSubmitBoundary(active, session)
      ) {
        this.recordClientLatencyMilestone(
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
          ...this.clientLatencyFields(input.turnId),
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

  public async regenerate(input: Readonly<{
    conversationId: string;
    requestId: string;
    rootMessageId: string;
  }>): Promise<AgentRunResult> {
    try {
      await this.hydrate(input.conversationId, { requestId: input.requestId });
    } catch (error) {
      const normalized = managedError(
        error,
        "response_start_failed",
        "SystemSculpt could not start the response.",
      );
      this.reportLocalIssue(normalized);
      this.capturePreflightFailure(
        input.conversationId,
        input.requestId,
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
      return this.failedResult(input.rootMessageId, normalized);
    }
    const session = this.session;
    if (!session || session.current.runState.state !== "idle") {
      const failure = {
        code: "response_in_progress",
        message: "The previous response is still active.",
        retryable: true,
      } as const;
      this.capturePreflightFailure(input.conversationId, input.requestId, failure, {
        failureStage: "submission_admission",
        failureMechanism: "concurrent_run",
      });
      return this.failedResult(input.rootMessageId, failure);
    }
    const active = this.createActiveRun({
      origin: "submitted",
      conversationId: input.conversationId,
      requestId: input.requestId,
      turnId: input.rootMessageId,
      approvalPolicy: {},
    });
    this.active = active;
    this.pendingRegenerate = {
      requestId: input.requestId,
      rootMessageId: input.rootMessageId,
      attemptedOpenEpoch: null,
      inFlight: false,
    };
    this.publishActive(active, true);
    active.serverAdmissionPossible = true;
    await this.trySendPendingRegenerate(active);
    return active.completion;
  }

  public async stageContext(
    rootMessageId: string,
    contextSources: readonly ThinAgentContextSource[],
    signal?: AbortSignal,
  ): Promise<ThinAgentContextResponse> {
    const conversationId = this.conversationId ?? undefined;
    this.recordLifecycle({
      code: "context_prepare_started",
      phase: "start",
      ...(conversationId ? { conversationId } : {}),
      requestId: rootMessageId,
      ...this.clientLatencyFields(rootMessageId),
    });
    try {
      const bootstrap = await this.issueBootstrap();
      const url = new URL(THIN_AGENT_CONTEXT_PATH, this.options.baseUrl);
      const request = parseThinAgentContextRequest({
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        root_message_id: rootMessageId,
        context_sources: contextSources,
      }, this.inputLimits);
      const response = await this.requestClient.request({
        url: url.toString(),
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.access.token}`,
          "x-plugin-version": this.options.pluginVersion,
        },
        body: request,
        signal,
        preserveResponseHeaders: true,
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
        throw Object.assign(new Error(safeServiceMessage(payload.message, fallback)), {
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
        ...this.clientLatencyFields(rootMessageId),
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
        ...this.clientLatencyFields(rootMessageId),
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

  private ensureIdentity(
    active: ActiveRun,
    callId: string,
    candidate: ToolIdentity,
  ): ToolIdentity | null {
    const existing = active.toolIdentities.get(callId);
    if (existing && !sameToolIdentity(existing, candidate)) {
      this.failToolAuthorization(
        active,
        "client_tool_identity_mismatch",
        "A vault action changed after it was presented.",
      );
      return null;
    }
    if (!existing) active.toolIdentities.set(callId, candidate);
    return existing ?? candidate;
  }

  private ensureToolIdentity(
    active: ActiveRun,
    tool: ProjectedTool,
  ): ToolIdentity | null {
    return this.ensureIdentity(active, tool.callId, toolIdentity(tool));
  }

  private registerApprovalId(
    active: ActiveRun,
    callId: string,
    approvalId: string,
  ): boolean {
    const identity = active.toolIdentities.get(callId);
    const existingId = active.approvalIds.get(callId);
    const existingCall = active.approvalCallIds.get(approvalId);
    const existingBinding = active.approvalBindings.get(approvalId);
    if (
      !identity
      || approvalId.length === 0
      || (existingId !== undefined && existingId !== approvalId)
      || (existingCall !== undefined && existingCall !== callId)
      || (existingBinding !== undefined && (
        existingBinding.callId !== callId
        || !sameToolIdentity(existingBinding.identity, identity)
      ))
    ) {
      this.failToolAuthorization(
        active,
        "approval_identity_mismatch",
        "A vault approval identity changed before execution.",
      );
      return false;
    }
    active.approvalIds.set(callId, approvalId);
    active.approvalCallIds.set(approvalId, callId);
    if (!existingBinding) {
      active.approvalBindings.set(approvalId, Object.freeze({
        callId,
        identity,
      }));
    }
    return true;
  }

  private validateCurrentToolBindings(
    active: ActiveRun,
    messages: readonly WireMessage[],
  ): boolean {
    const requested = new Map<string, ToolIdentity>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        const parsed = parseThinAgentDataPart(part);
        if (
          parsed?.kind !== "known"
          || parsed.type !== "data-systemsculpt-client-tool-request"
        ) continue;
        const callId = parsed.data.tool_call_id;
        const identity = Object.freeze({
          toolName: parsed.data.tool_name,
          canonicalInput: canonicalAgentToolInput(parsed.data.input),
        });
        const current = requested.get(callId);
        if (
          (current && !sameToolIdentity(current, identity))
          || !this.ensureIdentity(active, callId, identity)
        ) return false;
        requested.set(callId, identity);
      }
    }
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (parseThinAgentDataPart(part)?.kind === "known") continue;
        const callId = toolCallId(part);
        const name = toolName(part);
        if (!callId || !name) continue;
        const identity = requested.get(callId);
        if (!identity) continue;
        if (
          name !== identity.toolName
          || (part.state !== "input-streaming"
            && canonicalAgentToolInput(toolInput(part)) !== identity.canonicalInput)
        ) {
          this.failToolAuthorization(
            active,
            "client_tool_identity_mismatch",
            "A vault action changed after it was presented.",
          );
          return false;
        }
        const approval = toolApproval(part);
        if (approval && !this.registerApprovalId(active, callId, approval.id)) return false;
      }
    }
    return true;
  }

  private hasMatchingLocalApproval(
    active: ActiveRun,
    callId: string,
    identity: ToolIdentity,
  ): boolean {
    if (!isMutatingTool(identity.toolName)) return true;
    const decision = active.approvalDecisions.get(callId);
    return decision?.approved === true
      && sameToolIdentity(decision.identity, identity)
      && active.approvalIds.get(callId) === decision.approvalId
      && active.approvalCallIds.get(decision.approvalId) === callId;
  }

  public respondToApproval(
    approvalId: string,
    approved: boolean,
    source: "manual" | "policy" = "manual",
  ): boolean {
    const active = this.active;
    const session = this.session;
    if (!active || !session || active.terminal) return false;
    const callId = active.approvalCallIds.get(approvalId);
    if (!callId || active.approvalDecisions.has(callId)) return false;
    const tool = this.findCurrentTool(active, callId);
    if (!tool || (tool.part.state !== "approval-requested"
      && tool.part.state !== "input-available"
      && !(tool.part.state === "approval-responded"
        && toolApproval(tool.part)?.approved === true))) return false;
    const identity = this.ensureToolIdentity(active, tool);
    if (!identity) return false;
    const decision: LocalApprovalDecision = Object.freeze({
      approvalId,
      approved,
      source,
      identity,
    });
    active.approvalDecisions.set(callId, decision);
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
      ...this.clientLatencyFields(active.requestId),
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
      this.presentationMessages = restoreInterruptedTurnTail(
        this.presentationMessages,
        active,
        active.terminal,
      );
      this.reconcileLocalTerminalDuration(active);
      const snapshot = projectRun(
        active,
        this.authoritativeMessages,
        this.connectionState,
      );
      this.recordLifecycle({
        code: "run_finished_cancelled",
        phase: "response",
        conversationId: active.conversationId,
        requestId: active.requestId,
        ...(active.serverRunId ? { serverRunId: active.serverRunId } : {}),
        ...this.clientLatencyFields(active.requestId),
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
    this.authoritativeMessages = Object.freeze([]);
    this.presentationMessages = Object.freeze([]);
    this.reconciledKey = null;
    this.reconciledMessages = null;
    this.pendingRegenerate = null;
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
      completedLocalToolResults: new Map(),
      settledToolIds: new Set(),
      acknowledgedClientContinuationIds: new Set(),
      toolIdentities: new Map(),
      approvalDecisions: new Map(),
      approvalIds: new Map(),
      approvalCallIds: new Map(),
      approvalBindings: new Map(),
      toolTasks: new Map(),
      baseMessageIds: new Set(this.authoritativeMessages.map((message) => message.id)),
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
      streamedTurnMessages: Object.freeze([]),
    };
    if (input.origin === "submitted") {
      this.ensureClientLatency({
        conversationId: input.conversationId,
        requestId: input.requestId,
        startedAtMonotonicMs: input.clientStartedAtMonotonicMs,
      });
    }
    return active;
  }

  private retainClientLatency(input: Readonly<{
    conversationId: string;
    requestId: string;
    startedAtMonotonicMs?: number;
  }>): void {
    const fallback = this.monotonicNow();
    const startedAtMonotonicMs = typeof input.startedAtMonotonicMs === "number"
      && Number.isFinite(input.startedAtMonotonicMs)
      ? input.startedAtMonotonicMs
      : fallback;
    this.clientLatency.delete(input.requestId);
    this.clientLatency.set(input.requestId, {
      conversationId: input.conversationId,
      requestId: input.requestId,
      startedAtMonotonicMs,
      milestones: new Set(),
      segmentMilestones: new Set(),
      toolMilestones: new Set(),
      segments: new Map(),
      toolExecutionOrdinals: new Map(),
      nextToolExecutionOrdinal: 0,
      nextHistorySyncOrdinal: 0,
      pendingAssistantProjectionOrdinal: null,
      pendingCommandAck: null,
      pendingTerminalOrdinal: null,
      terminalSegmentOrdinal: null,
      lastOffsetMs: 0,
    });
    while (this.clientLatency.size > MAX_RETAINED_LATENCY_RUNS) {
      const oldest = this.clientLatency.keys().next().value;
      if (!oldest) break;
      this.clientLatency.delete(oldest);
    }
  }

  private ensureClientLatency(input: Readonly<{
    conversationId: string;
    requestId: string;
    startedAtMonotonicMs?: number;
  }>): void {
    const existing = this.clientLatency.get(input.requestId);
    if (existing?.conversationId === input.conversationId) return;
    this.retainClientLatency(input);
  }

  private updateActiveElapsed(active: ActiveRun): void {
    if (active.terminal) return;
    const context = this.clientLatency.get(active.requestId);
    if (!context || context.conversationId !== active.conversationId) return;
    const elapsedMs = this.monotonicNow() - context.startedAtMonotonicMs;
    if (!Number.isFinite(elapsedMs)) return;
    active.elapsedMs = Math.max(0, Math.round(elapsedMs));
  }

  private reconcileLocalTerminalDuration(active: ActiveRun): void {
    if (active.elapsedMs === null || !this.options.reconcileHistory) return;
    const turnPresentation: DurableTurnPresentation = {
      rootMessageId: active.turnId,
      responseDurationMs: active.elapsedMs,
    };
    const durable = durableServerHistory(
      this.presentationMessages,
      this.now(),
      turnPresentation,
    );
    if (!hasDurableAssistantContent(durable, active.turnId)) return;
    void this.reconcileMessages(
      this.presentationMessages,
      "terminal",
      turnPresentation,
    ).catch(() => undefined);
  }

  private ensureToolExecutionOrdinal(
    active: ActiveRun,
    toolCallId: string,
  ): number | undefined {
    const context = this.clientLatency.get(active.requestId);
    if (!context || context.conversationId !== active.conversationId) return undefined;
    const existing = context.toolExecutionOrdinals.get(toolCallId);
    if (existing !== undefined) return existing;
    if (context.nextToolExecutionOrdinal >= MAX_TOOL_EXECUTIONS_PER_RUN) return undefined;
    const ordinal = ++context.nextToolExecutionOrdinal;
    context.toolExecutionOrdinals.set(toolCallId, ordinal);
    return ordinal;
  }

  private latestToolResultSegmentOrdinal(
    context: ClientLatencyContext,
    toolCallId: string,
    toolExecutionOrdinal: number,
    requireAssistantProjection = false,
  ): number | undefined {
    const segments = [...context.segments.values()]
      .sort((left, right) => right.ordinal - left.ordinal);
    return segments.find((segment) =>
      segment.commandKind === "client_tool_result"
      && segment.toolCallId === toolCallId
      && segment.toolExecutionOrdinal === toolExecutionOrdinal
      && (!requireAssistantProjection || context.segmentMilestones.has(
        `${segment.ordinal}:response_first_assistant_snapshot_projected`,
      )))?.ordinal;
  }

  private recordClientToolLatencyMilestone(
    code: ClientToolRenderCode,
    requestId: string,
    toolCallId: string,
    observedAtMonotonicMs: number,
  ): void {
    const context = this.clientLatency.get(requestId);
    const toolExecutionOrdinal = context?.toolExecutionOrdinals.get(toolCallId);
    if (!context || toolExecutionOrdinal === undefined) return;
    const milestone = `${toolExecutionOrdinal}:${code}`;
    if (context.toolMilestones.has(milestone)) return;
    const continuation = code === "continuation_content_dom_committed"
      || code === "continuation_content_paint_opportunity";
    const commandSegmentOrdinal = this.latestToolResultSegmentOrdinal(
      context,
      toolCallId,
      toolExecutionOrdinal,
      continuation,
    );
    context.toolMilestones.add(milestone);
    const active = this.active?.requestId === requestId ? this.active : null;
    this.recordLifecycle({
      code,
      phase: "render",
      conversationId: context.conversationId,
      requestId,
      ...(active?.serverRunId ? { serverRunId: active.serverRunId } : {}),
      toolExecutionOrdinal,
      ...this.clientLatencyFields(
        requestId,
        observedAtMonotonicMs,
        commandSegmentOrdinal,
      ),
    });
  }

  private createHistorySyncCorrelation(
    historySyncKind: HistorySyncKind,
  ): HistorySyncCorrelation {
    const active = this.active;
    const conversationId = active?.conversationId ?? this.conversationId ?? undefined;
    if (!active) return { ...(conversationId ? { conversationId } : {}), historySyncKind };
    const context = this.clientLatency.get(active.requestId);
    if (!context || context.nextHistorySyncOrdinal >= MAX_HISTORY_SYNCS_PER_RUN) {
      return { conversationId: active.conversationId, historySyncKind };
    }
    const historySyncOrdinal = ++context.nextHistorySyncOrdinal;
    return {
      conversationId: active.conversationId,
      requestId: active.requestId,
      historySyncKind,
      historySyncOrdinal,
    };
  }

  private recordHistorySyncLifecycle(
    code: Extract<AgentLifecycleCode,
      "history_sync_started" | "history_sync_completed" | "history_sync_failed">,
    correlation: HistorySyncCorrelation,
  ): void {
    this.recordLifecycle({
      code,
      phase: "persistence",
      ...correlation,
      ...(correlation.requestId
        ? this.clientLatencyFields(correlation.requestId)
        : {}),
    });
  }

  private clientLatencyFields(
    requestId: string,
    observedAtMonotonicMs = this.monotonicNow(),
    commandSegmentOrdinal?: number,
  ): Readonly<{
    latencyTraceId?: string;
    commandKind?: AgentCommandKind;
    commandSegmentOrdinal?: number;
    toolExecutionOrdinal?: number;
    responseDeliveryMode?: PlatformResponseDeliveryMode;
    clientMonotonicOffsetMs?: number;
  }> {
    const context = this.clientLatency.get(requestId);
    if (!context || !Number.isFinite(observedAtMonotonicMs)) return {};
    // Segment identity is intentionally opt-in. Multiple /turn streams for one
    // logical request can overlap, so a global "last callback" pointer would
    // let a late callback relabel DOM, paint, tool, or terminal milestones.
    const segment = commandSegmentOrdinal === undefined
      ? undefined
      : context.segments.get(commandSegmentOrdinal);
    const offset = Math.max(
      context.lastOffsetMs,
      observedAtMonotonicMs - context.startedAtMonotonicMs,
      0,
    );
    context.lastOffsetMs = offset;
    return {
      ...(segment?.latencyTraceId
        ? { latencyTraceId: segment.latencyTraceId }
        : {}),
      ...(segment
        ? {
            commandKind: segment.commandKind,
            commandSegmentOrdinal: segment.ordinal,
          }
        : {}),
      ...(typeof segment?.toolExecutionOrdinal === "number"
        ? { toolExecutionOrdinal: segment.toolExecutionOrdinal }
        : {}),
      ...(segment?.responseDeliveryMode
        ? { responseDeliveryMode: segment.responseDeliveryMode }
        : {}),
      clientMonotonicOffsetMs: offset,
    };
  }

  private recordClientLatencyMilestone(
    code: AgentLifecycleCode,
    requestId: string,
    observedAtMonotonicMs: number,
    extra: Readonly<{
      status?: number;
      retryable?: boolean;
      failureCode?: string;
      serverTimingAppMs?: number;
      serverTimingAuthMs?: number;
      responseDeliveryMode?: PlatformResponseDeliveryMode;
      toolName?: string;
      toolCallId?: string;
      toolExecutionOrdinal?: number;
    }> = {},
    commandSegmentOrdinal?: number,
  ): void {
    const context = this.clientLatency.get(requestId);
    if (!context) return;
    const segmentMilestone = commandSegmentOrdinal === undefined
      ? null
      : `${commandSegmentOrdinal}:${code}`;
    const milestones = segmentMilestone === null
      ? context.milestones
      : context.segmentMilestones;
    const milestone = segmentMilestone ?? code;
    if (milestones.has(milestone)) return;
    milestones.add(milestone);
    const active = this.active?.requestId === requestId ? this.active : null;
    this.recordLifecycle({
      code,
      phase: code === "response_first_dom_committed"
        || code === "response_first_paint_opportunity"
        || code === "local_tool_terminal_dom_committed"
        || code === "local_tool_terminal_paint_opportunity"
        || code === "continuation_content_dom_committed"
        || code === "continuation_content_paint_opportunity"
        ? "render"
        : "response",
      conversationId: context.conversationId,
      requestId,
      ...(active?.serverRunId ? { serverRunId: active.serverRunId } : {}),
      ...extra,
      ...this.clientLatencyFields(
        requestId,
        observedAtMonotonicMs,
        commandSegmentOrdinal,
      ),
    });
  }

  private handleTransportTiming(event: AgentTransportTimingEvent): void {
    const context = this.clientLatency.get(event.requestId);
    if (!context) return;
    const active = this.active?.requestId === event.requestId ? this.active : null;
    // A transport callback may carry an unknown or adversarial call ID. Only
    // a locally started execution establishes the export ordinal; exact IDs
    // can join that existing map but can never create a new ordinal here.
    const toolExecutionOrdinal = event.toolCallId
      ? context.toolExecutionOrdinals.get(event.toolCallId)
      : undefined;
    const existing = context.segments.get(event.commandSegmentOrdinal);
    if (existing && existing.commandKind !== event.commandKind) return;
    const segment: ClientLatencySegment = existing ?? {
      ordinal: event.commandSegmentOrdinal,
      commandKind: event.commandKind,
      toolCallId: event.toolCallId ?? null,
      toolExecutionOrdinal: toolExecutionOrdinal ?? null,
      toolName: null,
      latencyTraceId: null,
      responseDeliveryMode: null,
    };
    if (existing && existing.toolCallId !== (event.toolCallId ?? null)) return;
    if (
      existing
      && existing.toolExecutionOrdinal !== (toolExecutionOrdinal ?? null)
    ) return;
    if (segment.toolCallId && segment.toolName === null) {
      segment.toolName = active
        ? this.findCurrentTool(active, segment.toolCallId)?.name ?? null
        : null;
    }
    if (event.latencyTraceId) segment.latencyTraceId = event.latencyTraceId;
    if (event.responseDeliveryMode) {
      segment.responseDeliveryMode = event.responseDeliveryMode;
    }
    context.segments.set(segment.ordinal, segment);
    while (context.segments.size > MAX_RETAINED_LATENCY_SEGMENTS_PER_RUN) {
      const oldest = context.segments.keys().next().value;
      if (oldest === undefined) break;
      context.segments.delete(oldest);
      for (const code of [
        "command_segment_dispatch_started",
        "response_available",
        "response_first_body_chunk_observed",
        "response_first_sse_frame_parsed",
        "response_first_assistant_sse_frame_parsed",
        "response_first_assistant_snapshot_projected",
      ] as const) {
        context.segmentMilestones.delete(`${oldest}:${code}`);
      }
    }
    if (event.milestone === "assistant_sse_frame_delivery_completed") {
      if (context.pendingAssistantProjectionOrdinal === event.commandSegmentOrdinal) {
        context.pendingAssistantProjectionOrdinal = null;
      }
      return;
    }
    if (event.milestone === "command_ack_sse_frame_delivery_completed") {
      if (context.pendingCommandAck?.ordinal === event.commandSegmentOrdinal) {
        context.pendingCommandAck = null;
      }
      return;
    }
    if (event.milestone === "terminal_sse_frame_delivery_completed") {
      if (context.pendingTerminalOrdinal === event.commandSegmentOrdinal) {
        context.pendingTerminalOrdinal = null;
      }
      return;
    }
    if (event.milestone === "command_ack_sse_frame") {
      context.pendingCommandAck = {
        ordinal: event.commandSegmentOrdinal,
        commandKind: event.commandKind,
        toolCallId: event.toolCallId ?? null,
      };
      return;
    }
    if (event.milestone === "terminal_sse_frame") {
      context.pendingTerminalOrdinal = event.commandSegmentOrdinal;
      return;
    }
    if (event.milestone === "first_assistant_sse_frame") {
      context.pendingAssistantProjectionOrdinal = event.commandSegmentOrdinal;
    }
    const code = event.milestone === "command_dispatch_started"
      ? "command_segment_dispatch_started"
      : event.milestone === "response_available"
        ? "response_available"
        : event.milestone === "first_body_chunk"
          ? "response_first_body_chunk_observed"
          : event.milestone === "first_assistant_sse_frame"
            ? "response_first_assistant_sse_frame_parsed"
            : "response_first_sse_frame_parsed";
    this.recordClientLatencyMilestone(
      code,
      event.requestId,
      event.observedAtMonotonicMs,
      {
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.serverTimingAppMs === undefined
          ? {}
          : { serverTimingAppMs: event.serverTimingAppMs }),
        ...(event.serverTimingAuthMs === undefined
          ? {}
          : { serverTimingAuthMs: event.serverTimingAuthMs }),
        ...(event.responseDeliveryMode
          ? { responseDeliveryMode: event.responseDeliveryMode }
          : {}),
        ...(segment.toolName ? { toolName: segment.toolName } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      },
      event.commandSegmentOrdinal,
    );
  }

  private handleTransportSegmentSummary(
    conversationId: string,
    event: AgentTransportSegmentSummaryEvent,
  ): void {
    try {
      const requestId = event.requestId;
      if (
        !isThinAgentConversationId(conversationId)
        || !isThinAgentRequestId(requestId)
      ) return;
      const context = this.clientLatency.get(requestId);
      const segment = context?.conversationId === conversationId
        ? context.segments.get(event.commandSegmentOrdinal)
        : undefined;
      const toolExecutionOrdinal = segment?.commandKind === event.commandKind
        && segment.toolCallId === (event.toolCallId ?? null)
        ? segment.toolExecutionOrdinal ?? undefined
        : undefined;
      const safeEvent: AgentChatTransportSegmentSummaryEvent = Object.freeze({
        conversationId,
        requestId,
        commandKind: event.commandKind,
        commandSegmentOrdinal: event.commandSegmentOrdinal,
        ...(segment?.latencyTraceId
          ? { serverLatencyCorrelationId: segment.latencyTraceId }
          : {}),
        ...(toolExecutionOrdinal === undefined
          ? {}
          : { toolExecutionOrdinal }),
        closeReason: event.closeReason,
        durationMs: event.durationMs,
        receivedBytes: event.receivedBytes,
        nonEmptyRawChunkCount: event.nonEmptyRawChunkCount,
        sseEventCount: event.sseEventCount,
        acceptedFrameCount: event.acceptedFrameCount,
        deliveredFrameCount: event.deliveredFrameCount,
        metricsTruncated: event.metricsTruncated,
      });
      this.options.onTransportSegmentSummary?.(safeEvent);
    } catch {
      // Incident evidence is observational and cannot affect the run.
    }
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

  private messagesWithOptimisticUser(
    snapshot: AgentSessionSnapshot<WireMessage>,
  ): readonly WireMessage[] {
    const optimistic = snapshot.optimisticUser;
    if (!optimistic) return snapshot.messages;
    if (snapshot.messages.some((message) => message.id === optimistic.message.id)) {
      return snapshot.messages;
    }
    const active = this.active;
    if (
      !active
      || active.origin !== "submitted"
      || active.requestId !== optimistic.request_id
      || active.turnId !== optimistic.message.id
    ) return snapshot.messages;

    const firstNewAssistant = snapshot.messages.findIndex((message) =>
      message.role === "assistant" && !active.baseMessageIds.has(message.id));
    const insertionIndex = firstNewAssistant < 0
      ? snapshot.messages.length
      : firstNewAssistant;
    return Object.freeze([
      ...snapshot.messages.slice(0, insertionIndex),
      optimistic.message,
      ...snapshot.messages.slice(insertionIndex),
    ]);
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
    // Capture the streamed tail before the wholesale replacement below. Only
    // a non-empty capture is kept: a snapshot that omits the run's streamed
    // assistant content must never downgrade what already streamed.
    const capturing = this.active;
    if (capturing && !capturing.terminal) {
      const streamed = currentTurnMessages(
        this.presentationMessages,
        capturing.turnId,
      ).filter((message) => message.role === "assistant");
      if (streamed.length > 0) capturing.streamedTurnMessages = streamed;
    }
    this.authoritativeMessages = snapshot.messages;
    this.presentationMessages = this.messagesWithOptimisticUser(snapshot);
    const runState = snapshot.runState;
    let active = this.active;
    if (active) this.reconcileAcknowledgedContinuations(active);
    if (snapshot.terminal && active
      && snapshot.terminal.request_id === active.requestId) {
      this.acceptTerminal(active, snapshot.terminal.value, "session_terminal");
      return;
    }
    if (active && !active.terminal) {
      const baseMessageIds = active.baseMessageIds;
      const terminalMessages = active.serverRunId
        ? snapshot.messages
        : snapshot.messages.filter((message) =>
          !baseMessageIds.has(message.id));
      const persistedTerminal = terminalFromMessages(
        terminalMessages,
        active.turnId,
        active.serverRunId,
      );
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
      void this.reconcileMessages(this.presentationMessages, "cancelled_queue")
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
        if (this.pendingRegenerate?.requestId === active.requestId) {
          this.pendingRegenerate = null;
        }
      }
    }
    if (
      active
      && !active.terminal
      && currentTurnMessages(this.presentationMessages, active.turnId)
        .some((message) => message.role === "assistant")
    ) {
      this.recordClientLatencyMilestone(
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
      this.publishHydratedTail(this.presentationMessages);
    }
    if (active && !active.terminal) {
      void this.trySendPendingRegenerate(active);
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
    const latency = this.clientLatency.get(active.requestId);
    const pendingAck = latency?.pendingCommandAck;
    const acknowledgedToolCallId = "tool_call_id" in ack ? ack.tool_call_id : null;
    const commandSegmentOrdinal = pendingAck
      && pendingAck.commandKind === ack.command_kind
      && pendingAck.toolCallId === acknowledgedToolCallId
      ? pendingAck.ordinal
      : undefined;
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
          ...this.clientLatencyFields(
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
          ...this.clientLatencyFields(
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
      if (active) void this.trySendPendingRegenerate(active);
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

  private scheduleResynchronization(active: ActiveRun): void {
    const transport = this.transport;
    if (
      !transport
      || this.active?.token !== active.token
      || active.terminal
      || (active.cancelRequested
        && this.pendingCancelRequestId !== active.requestId)
      || this.resynchronizationTimer !== null
      || this.resynchronizationInFlight
    ) return;

    const attempt = this.resynchronizationAttempt++;
    const exponentialDelay = Math.min(
      250 * (2 ** attempt),
      MAX_RESYNCHRONIZATION_DELAY_MS,
    );
    const configuredDelay = this.options.resynchronizationDelayMs
      ? this.options.resynchronizationDelayMs(attempt)
      : exponentialDelay * (0.5 + Math.random() * 0.5);
    const delay = Number.isFinite(configuredDelay)
      ? Math.max(0, Math.min(configuredDelay, MAX_RESYNCHRONIZATION_DELAY_MS))
      : MAX_RESYNCHRONIZATION_DELAY_MS;
    const generation = this.generation;
    this.resynchronizationTimer = window.setTimeout(() => {
      this.resynchronizationTimer = null;
      if (
        this.generation !== generation
        || this.transport !== transport
        || this.active?.token !== active.token
        || active.terminal
        || (active.cancelRequested
          && this.pendingCancelRequestId !== active.requestId)
      ) return;
      const stallRecovery = this.currentStallRecovery(active);
      if (stallRecovery) active.streamSupersededByRecovery = true;
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

  private clearResynchronization(resetAttempt = true): void {
    if (this.resynchronizationTimer !== null) {
      window.clearTimeout(this.resynchronizationTimer);
      this.resynchronizationTimer = null;
    }
    this.resynchronizationInFlight = false;
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
    const turn = currentTurnMessages(this.presentationMessages, active.turnId);
    const targets = collectClientToolTargets(turn);
    const tools = [...canonicalTools(turn, targets).values()]
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
    const turnMessages = currentTurnMessages(this.presentationMessages, active.turnId);
    if (!this.validateCurrentToolBindings(active, turnMessages)) return;
    const targets = collectClientToolTargets(turnMessages);
    const tools = canonicalTools(turnMessages, targets);
    for (const [callId, target] of targets) {
      const tool = tools.get(callId);
      if (!tool || tool.location !== "vault" || tool.name !== target.name) continue;
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
        if (!active.approvalIds.has(callId)
          && !this.registerApprovalId(active, callId, `approval:${callId}`)) return;
        if (!active.approvalDecisions.has(callId)) {
          this.recordLifecycle({
            code: "approval_presented",
            phase: "approval",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: tool.name,
            toolCallId: callId,
            ...this.clientLatencyFields(active.requestId),
          });
          if (!requiresUserApproval(tool.name, active.approvalPolicy)) {
            this.respondToApproval(active.approvalIds.get(callId)!, true, "policy");
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
        const identity = toolIdentity(tool);
        if (isMutatingTool(tool.name) && !active.approvalDecisions.has(callId)) {
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
          if (!this.respondToApproval(active.approvalIds.get(callId)!, true, "policy")) return;
          continue;
        }
        if (!this.hasMatchingLocalApproval(active, callId, identity)) {
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
          const approvalId = active.approvalIds.get(callId) ?? `approval:${callId}`;
          if (!this.registerApprovalId(active, callId, approvalId)) return;
          const decision = active.approvalDecisions.get(callId);
          if (!decision && !requiresUserApproval(tool.name, active.approvalPolicy)) {
            if (!this.respondToApproval(approvalId, true, "policy")) return;
            continue;
          }
          if (!decision) continue;
          if (!decision.approved) continue;
          if (!this.hasMatchingLocalApproval(active, callId, toolIdentity(tool))) {
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
    const currentIdentity = toolIdentity(tool);
    const local = active.approvalDecisions.get(tool.callId);
    if (
      (local && !sameToolIdentity(local.identity, currentIdentity))
      || (pending && !sameToolIdentity(pending.decision.identity, currentIdentity))
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
    const identity = this.ensureToolIdentity(active, tool);
    if (!identity) return;
    const replayOnly = !this.hasMatchingLocalApproval(active, tool.callId, identity);
    if (replayOnly && !isMutatingTool(identity.toolName)) {
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
    const toolExecutionOrdinal = this.ensureToolExecutionOrdinal(active, call.callId);
    active.executingToolIds.add(call.callId);
    this.recordLifecycle({
      code: "local_tool_started",
      phase: "tool_execution",
      conversationId: active.conversationId,
      requestId: active.requestId,
      toolName: call.name,
      toolCallId: call.callId,
      ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      ...this.clientLatencyFields(active.requestId),
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
    const expected = toolIdentity({ name: call.name, input: call.input });
    if (
      !current
      || current.location !== "vault"
      || !sameToolIdentity(toolIdentity(current), expected)
      || !this.ensureIdentity(active, call.callId, expected)
      || !this.hasMatchingLocalApproval(active, call.callId, expected)
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
    const toolExecutionOrdinal = this.ensureToolExecutionOrdinal(active, call.callId);
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
        ...this.clientLatencyFields(active.requestId),
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
    } catch (error) {
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
        ...this.clientLatencyFields(active.requestId),
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
    active.completedLocalToolResults.set(call.callId, presentationResult);
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
      const latency = this.clientLatency.get(active.requestId);
      const commandSegmentOrdinal = latency && delivery.toolExecutionOrdinal !== undefined
        ? this.latestToolResultSegmentOrdinal(
            latency,
            delivery.call.callId,
            delivery.toolExecutionOrdinal,
          )
        : undefined;
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
        ...this.clientLatencyFields(
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
        ...this.clientLatencyFields(active.requestId),
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
        const latency = this.clientLatency.get(active.requestId);
        const commandSegmentOrdinal = latency
          && delivery.toolExecutionOrdinal !== undefined
          ? this.latestToolResultSegmentOrdinal(
              latency,
              delivery.call.callId,
              delivery.toolExecutionOrdinal,
            )
          : undefined;
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
          ...this.clientLatencyFields(
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
    const turn = currentTurnMessages(this.presentationMessages, active.turnId);
    const targets = collectClientToolTargets(turn);
    return canonicalTools(turn, targets).get(callId) ?? null;
  }

  private findAuthoritativeTool(active: ActiveRun, callId: string): ProjectedTool | null {
    const turn = currentTurnMessages(this.authoritativeMessages, active.turnId);
    const targets = collectClientToolTargets(turn);
    return canonicalTools(turn, targets).get(callId) ?? null;
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
      || !sameToolIdentity(toolIdentity(tool), toolIdentity(delivery.call))
      || canonicalAgentToolInput(toolInput(tool.part))
        !== canonicalAgentToolInput(delivery.call.input)
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
      || !sameToolIdentity(toolIdentity(tool), delivery.decision.identity)
      || canonicalAgentToolInput(toolInput(tool.part))
        !== delivery.decision.identity.canonicalInput
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
      const callback = this.options.onIncidentCapture;
      if (
        !callback
        || !isThinAgentConversationId(active.conversationId)
        || !isThinAgentRequestId(active.requestId)
      ) return;
      const content = incidentSnapshotCounts(snapshot);
      const executingLocalTools = boundedIncidentPendingCount(
        active.executingToolIds.size,
      );
      const pendingToolDeliveries = boundedIncidentPendingCount(
        this.pendingDeliveries.size,
      );
      const pendingApprovalDeliveries = boundedIncidentPendingCount(
        this.pendingApprovalDeliveries.size,
      );
      const pendingToolTasks = boundedIncidentPendingCount(
        active.toolTasks.size,
      );
      const elapsed = boundedIncidentElapsedMs(active.elapsedMs);
      const serverRunId = isThinAgentServerRunId(failure.serverRunId)
        ? failure.serverRunId
        : undefined;
      const incidentId = isThinAgentIncidentId(failure.incidentId)
        ? failure.incidentId
        : undefined;
      const failureCode = normalizeAgentIncidentFailureCode(
        failure.failureCode,
        failure.failureAuthority,
      );
      const capture = Object.freeze({
        kind: "agent_run_failed",
        conversationId: active.conversationId,
        requestId: active.requestId,
        failureAuthority: failure.failureAuthority,
        failureStage: failure.failureStage,
        failureMechanism: failure.failureMechanism,
        terminalValidation: failure.terminalValidation,
        terminalSource: failure.terminalSource,
        hostProcessState: "responsive",
        chatViewState: "unknown",
        runOrigin: active.origin,
        runPhase: failure.runPhase ?? active.phase,
        connectionState: this.connectionState,
        ...(elapsed.value === undefined ? {} : { elapsedMs: elapsed.value }),
        elapsedMsTruncated: elapsed.truncated,
        ...(serverRunId ? { serverRunId } : {}),
        ...(incidentId ? { incidentId } : {}),
        ...(failureCode ? { failureCode } : {}),
        retryable: failure.retryable,
        assistantTextPartCount: content.assistantTextPartCount,
        assistantTextStreamingPartCount: content.assistantTextStreamingPartCount,
        assistantTextCompletePartCount: content.assistantTextCompletePartCount,
        assistantTextCharacterCount: content.assistantTextCharacterCount,
        reasoningPartCount: content.reasoningPartCount,
        reasoningStreamingPartCount: content.reasoningStreamingPartCount,
        reasoningCompletePartCount: content.reasoningCompletePartCount,
        reasoningCharacterCount: content.reasoningCharacterCount,
        assistantOutputPresentBeforeFailure:
          content.assistantOutputPresentBeforeFailure,
        assistantOutputRetainedInFailedProjection:
          content.assistantOutputRetainedInFailedProjection,
        snapshotPartCount: content.snapshotPartCount,
        executingLocalToolCount: executingLocalTools.value,
        pendingToolDeliveryCount: pendingToolDeliveries.value,
        pendingApprovalDeliveryCount: pendingApprovalDeliveries.value,
        pendingToolTaskCount: pendingToolTasks.value,
        serverQueued: active.serverQueued,
        runStalled: this.runStalled,
        awaitingClientWork: this.awaitingClientWork,
        pendingCancel: this.pendingCancelRequestId === active.requestId,
        pendingRegenerate: this.pendingRegenerate?.requestId === active.requestId,
        countsTruncated: content.truncated
          || executingLocalTools.truncated
          || pendingToolDeliveries.truncated
          || pendingApprovalDeliveries.truncated
          || pendingToolTasks.truncated,
      });
      try {
        callback(capture);
      } catch {
        // The failed lifecycle still records even if capture projection fails.
      }
    } catch {
      // Diagnostics are observational. Capture failure cannot affect a run.
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
          ...this.clientLatencyFields(requestId),
        });
      }
      const latency = this.clientLatency.get(requestId);
      const rawElapsed = latency?.conversationId === conversationId
        ? this.monotonicNow() - latency.startedAtMonotonicMs
        : null;
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
        ...this.clientLatencyFields(requestId),
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
      const messages = restoreInterruptedTurnTail(
        this.presentationMessages,
        active,
        terminal,
      );
      const projectionActive: ActiveRun = {
        ...active,
        completedLocalToolResults: new Map(active.completedLocalToolResults),
      };
      this.captureFailedRun(
        active,
        projectRun(
          projectionActive,
          messages,
          this.connectionState,
          this.runStalled,
        ),
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
    const terminalSegmentOrdinal = this.clientLatency.get(active.requestId)
      ?.pendingTerminalOrdinal ?? undefined;
    const latencyContext = this.clientLatency.get(active.requestId);
    if (latencyContext && terminalSegmentOrdinal !== undefined) {
      latencyContext.terminalSegmentOrdinal = terminalSegmentOrdinal;
    }
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
      ...this.clientLatencyFields(
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
    if (terminal.outcome !== "succeeded") {
      this.presentationMessages = restoreInterruptedTurnTail(
        this.presentationMessages,
        active,
        terminal,
      );
    }
    const durableMessages = overlayCompletedLocalToolResults(
      this.presentationMessages,
      active,
    );
    let assistantMessage: ChatMessage | undefined;
    if (terminal.outcome === "succeeded") {
      const turn = currentTurnMessages(durableMessages, active.turnId);
      const assistant = [...turn].reverse().find((message) => message.role === "assistant");
      if (assistant) {
        const durable = durableAssistantMessage(
          assistant,
          turn.filter((message) => message.role === "assistant"),
          this.now(),
          true,
          active.elapsedMs ?? undefined,
        );
        if (durable) {
          assistantMessage = durable;
          this.recordLifecycle({
            code: "response_save_started",
            phase: "persistence",
            conversationId: active.conversationId,
            requestId: active.requestId,
            serverRunId: terminal.run_id,
            ...this.clientLatencyFields(active.requestId),
          });
          try {
            await this.options.persistAssistant(durable);
            this.recordLifecycle({
              code: "response_save_completed",
              phase: "persistence",
              conversationId: active.conversationId,
              requestId: active.requestId,
              serverRunId: terminal.run_id,
              ...this.clientLatencyFields(active.requestId),
            });
          } catch (error) {
            this.recordLifecycle({
              code: "response_save_failed",
              phase: "persistence",
              conversationId: active.conversationId,
              requestId: active.requestId,
              serverRunId: terminal.run_id,
              ...this.clientLatencyFields(active.requestId),
            });
            this.reportLocalIssue(error);
          }
        }
      }
    }
    await this.reconcileMessages(
      durableMessages,
      "terminal",
      active.elapsedMs === null
        ? undefined
        : {
            rootMessageId: active.turnId,
            responseDurationMs: active.elapsedMs,
          },
    ).catch(() => undefined);
    const snapshot = projectRun(
      active,
      this.presentationMessages,
      this.connectionState,
    );
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
    this.pendingRegenerate = null;
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
      ...this.clientLatencyFields(
        active.requestId,
        this.monotonicNow(),
        this.clientLatency.get(active.requestId)?.terminalSegmentOrdinal ?? undefined,
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
    const snapshot = projectRun(
      active,
      this.authoritativeMessages,
      this.connectionState,
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
    const snapshot = projectRun(
      active,
      this.presentationMessages,
      this.connectionState,
    );
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

  private publishActive(active: ActiveRun, immediate = false): void {
    if (this.active?.token !== active.token) return;
    this.updateActiveElapsed(active);
    const snapshot = projectRun(
      active,
      this.presentationMessages,
      this.connectionState,
      this.runStalled,
    );
    const latency = this.clientLatency.get(active.requestId);
    const pendingAssistantProjectionOrdinal =
      latency?.pendingAssistantProjectionOrdinal ?? null;
    if (pendingAssistantProjectionOrdinal !== null && snapshot.messages.length > 0) {
      this.recordClientLatencyMilestone(
        "response_first_assistant_snapshot_projected",
        active.requestId,
        this.monotonicNow(),
        {},
        pendingAssistantProjectionOrdinal,
      );
      latency!.pendingAssistantProjectionOrdinal = null;
    }
    if (snapshot.parts.some((part) =>
      part.kind === "text" || part.kind === "reasoning" || part.kind === "tool")) {
      this.recordClientLatencyMilestone(
        "response_first_content_projected",
        active.requestId,
        this.monotonicNow(),
      );
    }
    this.syncRunStallWatchdog(snapshot);
    if (immediate) this.commitSnapshot(snapshot);
    else this.scheduleSnapshot(snapshot);
  }

  private publishHydratedTail(messages: readonly WireMessage[]): void {
    if (this.active) return;
    const rootId = latestUserId(messages);
    const terminal = rootId ? terminalFromMessages(messages, rootId) : null;
    if (!rootId || !terminal || terminal.outcome === "succeeded") {
      if (this.currentSnapshot.status !== "completed") this.commitSnapshot(initialSnapshot());
      return;
    }
    const active = this.createActiveRun({
      origin: "recovered",
      conversationId: this.conversationId ?? "conversation_00000000000000000000000000000000",
      requestId: rootId,
      turnId: rootId,
      approvalPolicy: {},
    });
    active.serverRunId = terminal.run_id;
    active.terminal = terminal;
    this.commitSnapshot(projectRun(active, messages, this.connectionState, false));
  }

  private scheduleSnapshot(snapshot: AgentConversationSnapshot): void {
    if (this.renderTimer !== null) {
      this.pendingSnapshot = snapshot;
      return;
    }
    // Leading-edge throttle: the first snapshot of a burst paints with no
    // added latency and the timer stays armed purely as the coalescing
    // window for followers. A trailing debounce here would hold every first
    // streamed token for a frame before anything reached the renderer.
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      const next = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (next) this.dispatchSnapshot(next);
    }, 16);
    this.dispatchSnapshot(snapshot);
  }

  private commitSnapshot(snapshot: AgentConversationSnapshot): void {
    this.pendingSnapshot = null;
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
    if (!this.options.reconcileHistory) return;
    // A run that already holds its terminal is finalizing: its durable write
    // belongs to finalizeTerminal. Reconciling the bare prefix here would
    // momentarily rewrite history without the finished turn — a visible
    // clear/rebuild flicker at the final paint boundary, and real content
    // loss if the process dies between the two writes.
    if (active?.terminal) return;
    const rootIndex = active
      ? this.authoritativeMessages.findIndex((message) =>
          message.role === "user" && message.id === active.turnId)
      : -1;
    const messages = rootIndex >= 0
      ? this.authoritativeMessages.slice(0, rootIndex + 1)
      : active
        ? this.authoritativeMessages.filter((message) =>
            active.baseMessageIds.has(message.id))
        : this.authoritativeMessages;
    void this.reconcileMessages(messages, "authoritative_prefix")
      .catch(() => undefined);
  }

  private reconcileMessages(
    messages: readonly WireMessage[],
    historySyncKind: HistorySyncKind,
    turnPresentation?: DurableTurnPresentation,
  ): Promise<void> {
    if (!this.options.reconcileHistory) return Promise.resolve();
    // An empty fresh or fork snapshot is not an instruction to erase a local
    // cache. Wait until the server has published an authoritative root.
    if (messages.length === 0) return Promise.resolve();
    // Authoritative messages are frozen and reused by reference across
    // publishes, so during streaming the reconciled prefix repeats with
    // identical elements on every delta. The reference comparison dedupes
    // those without serializing the whole history per frame; the serialized
    // key remains the authority when references differ (a session snapshot
    // legitimately replaces every message object with equal content).
    const previous = this.reconciledMessages;
    if (
      !turnPresentation
      && previous
      && previous.length === messages.length
      && messages.every((message, index) => message === previous[index])
    ) return this.pendingReconcile;
    const messageKey = JSON.stringify(messages);
    const key = turnPresentation
      ? `${messageKey}\n${JSON.stringify(turnPresentation)}`
      : messageKey;
    if (key === this.reconciledKey) {
      this.reconciledMessages = messages;
      return this.pendingReconcile;
    }
    this.reconciledKey = key;
    this.reconciledMessages = messages;
    const durable = durableServerHistory(messages, this.now(), turnPresentation);
    const correlation = this.createHistorySyncCorrelation(historySyncKind);
    const task = this.pendingReconcile.then(() => {
      this.recordHistorySyncLifecycle("history_sync_started", correlation);
      return this.options.reconcileHistory!(durable);
    });
    this.pendingReconcile = task.then(
      () => {
        this.recordHistorySyncLifecycle("history_sync_completed", correlation);
      },
      (error) => {
        if (this.reconciledKey === key) {
          this.reconciledKey = null;
          this.reconciledMessages = null;
        }
        this.recordHistorySyncLifecycle("history_sync_failed", correlation);
        this.reportLocalIssue(error);
      },
    );
    return task;
  }

  private async trySendPendingRegenerate(active: ActiveRun): Promise<void> {
    const delivery = this.pendingRegenerate;
    const session = this.session;
    if (
      !delivery
      || !session
      || delivery.inFlight
      || delivery.attemptedOpenEpoch === this.openEpoch
      || this.active?.token !== active.token
      || active.terminal
      || active.requestId !== delivery.requestId
      || active.turnId !== delivery.rootMessageId
      || this.connectionState !== "open"
      || session.current.runState.state !== "idle"
    ) return;
    const attemptedEpoch = this.openEpoch;
    delivery.attemptedOpenEpoch = attemptedEpoch;
    delivery.inFlight = true;
    try {
      await session.regenerate({
        request_id: delivery.requestId,
        root_message_id: delivery.rootMessageId,
      });
      if (this.pendingRegenerate === delivery) {
        this.pendingRegenerate = null;
      }
    } catch (error) {
      if (
        this.active?.token !== active.token
        || active.terminal
        || this.pendingRegenerate !== delivery
      ) return;
      delivery.attemptedOpenEpoch = null;
      if (wasDefinitelyRejected(error)) {
        this.pendingRegenerate = null;
        active.serverAdmissionPossible = false;
        if (active.cancelRequested) {
          this.finishLocalCancellation(active);
        } else {
          const normalized = managedError(
            error,
            "response_start_failed",
            "SystemSculpt could not retry the response.",
          );
          this.finishLocalFailure(active, normalized, {
            failureStage: "request_dispatch",
            failureMechanism: incidentFailureMechanism(
              normalized,
              "transport_or_protocol_failure",
            ),
          });
        }
      } else {
        this.reportLocalIssue(error);
        this.scheduleResynchronization(active);
      }
    } finally {
      delivery.inFlight = false;
      if (
        this.active?.token === active.token
        && !active.terminal
        && this.pendingRegenerate === delivery
        && this.openEpoch !== attemptedEpoch
      ) {
        await this.trySendPendingRegenerate(active);
      }
    }
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
      this.inputLimits = bootstrap.client_input_limits;
      this.options.updateInputLimits?.(this.inputLimits);
      return bootstrap;
    }

    const licenseKey = this.options.licenseKey().trim();
    if (!licenseKey) throw new Error("Add your SystemSculpt license to start a response.");
    const request = parseThinAgentBootstrapRequest(this.options.bootstrapRequest());
    const response = await this.requestClient.request({
      url: new URL(THIN_AGENT_BOOTSTRAP_PATH, this.options.baseUrl).toString(),
      method: "POST",
      headers: { "x-plugin-version": this.options.pluginVersion },
      licenseKey,
      body: request,
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 64 * 1024,
    });
    if (!response.ok) {
      const payload = boundedErrorPayload(await response.text());
      const fallback = response.status === 429
        ? "SystemSculpt is receiving too many requests. Try again shortly."
        : `SystemSculpt could not start the response (${response.status}).`;
      throw Object.assign(new Error(safeServiceMessage(payload.message, fallback)), {
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
    this.inputLimits = bootstrap.client_input_limits;
    this.options.updateInputLimits?.(this.inputLimits);
    return bootstrap;
  }

  private reportLocalIssue(error: unknown): void {
    try { this.options.reportError?.(error); }
    catch { /* Error reporting is observational. */ }
  }
}
