import { PlatformRequestClient } from "../../../services/PlatformRequestClient";
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
import { isFirstPartyToolName } from "../../../tools/toolNames";
import {
  collectSuccessfulToolArtifactPaths,
  collectToolArtifactPaths,
} from "../../../utils/toolArtifacts";
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
} from "./StreamingTransport";
import type {
  AgentJsonValue,
  AgentUserMessage,
} from "./Protocol";
import { AgentMutationJournal } from "./MutationJournal";

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
}>;

export type AgentLifecyclePhase =
  | "start"
  | "session"
  | "response"
  | "approval"
  | "tool_execution"
  | "mutation_journal"
  | "persistence"
  | "render"
  | "unknown";

export type AgentLifecycleCode =
  | "session_opened"
  | "session_closed"
  | "session_interrupted"
  | "session_failed"
  | "response_prepare_started"
  | "response_prepare_completed"
  | "response_prepare_failed"
  | "context_prepare_started"
  | "context_prepare_completed"
  | "context_prepare_cancelled"
  | "context_prepare_failed"
  | "submission_admitted"
  | "submission_queued"
  | "queued_submission_removed"
  | "queued_submission_promoted"
  | "stop_requested"
  | "stop_completed"
  | "historical_resubmit_started"
  | "historical_resubmit_committed"
  | "historical_resubmit_failed"
  | "conversation_reset"
  | "run_started"
  | "run_stalled"
  | "request_dispatch_started"
  | "request_dispatch_returned"
  | "request_dispatch_failed"
  | "phase_submitted"
  | "phase_thinking"
  | "phase_working"
  | "phase_waiting"
  | "phase_retrying"
  | "phase_settling"
  | "phase_complete"
  | "approval_presented"
  | "approval_submitted_approved_manual"
  | "approval_submitted_approved_policy"
  | "approval_submitted_denied"
  | "approval_acknowledged_approved"
  | "approval_acknowledged_denied"
  | "mutation_execute_claimed"
  | "mutation_replay_served"
  | "mutation_outcome_unknown"
  | "mutation_call_conflict"
  | "local_tool_started"
  | "local_tool_completed_succeeded"
  | "local_tool_completed_failed"
  | "tool_result_sent_succeeded"
  | "tool_result_sent_failed"
  | "tool_result_acknowledged_succeeded"
  | "tool_result_acknowledged_failed"
  | "response_result_received_succeeded"
  | "response_result_received_cancelled"
  | "response_result_received_failed"
  | "response_save_started"
  | "response_save_completed"
  | "response_save_failed"
  | "history_sync_started"
  | "history_sync_completed"
  | "history_sync_failed"
  | "run_finished_completed"
  | "run_finished_cancelled"
  | "run_finished_failed"
  | "diagnostics_truncated";

export type AgentLifecycleInput = Readonly<{
  code: AgentLifecycleCode;
  phase: AgentLifecyclePhase;
  conversationId?: string;
  requestId?: string;
  clientInstanceId?: string;
  pluginBuildId?: string;
  runId?: string;
  serverRunId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
}>;

export type AgentLifecycleRecord = AgentLifecycleInput & Readonly<{
  sequence: number;
  timestamp: number;
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
  refreshCredits?: () => Promise<void>;
  reportError?: (error: unknown) => void;
  onLifecycle?: (record: AgentLifecycleRecord) => void;
  requestClient?: RequestClient;
  runStallGraceMs?: number;
  now?: () => number;
}>;

/**
 * How long a live run may sit on a non-open connection before the soft
 * "Reconnecting" presentation escalates to an honest "Connection interrupted"
 * status. Short blips recover silently; a sustained outage must not keep
 * presenting as routine progress.
 */

/**
 * How long a live run may wait on the server with a healthy connection and no
 * new authoritative content before the presentation stops claiming progress.
 *
 * Connection health is the wrong signal for this: a run can die server-side
 * while the socket keeps reconnecting perfectly, which reads as an eternal
 * "Thinking". Generous on purpose, because a reasoning model legitimately
 * goes quiet for a long time; this only replaces a false progress claim with
 * an honest one and never terminates the run, which the server still owns.
 */
const RUN_STALL_GRACE_MS = 240_000;

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
  readonly settledToolIds: Set<string>;
  readonly approvalDecisions: Map<string, boolean>;
  readonly approvalIds: Map<string, string>;
  readonly toolTasks: Map<string, Promise<void>>;
  readonly baseMessageIds: ReadonlySet<string>;
  phase: AgentRunPhase;
  label: string;
  serverRunId: string | null;
  terminal: ThinAgentRunTerminalData | null;
  finalizing: boolean;
  cancelRequested: boolean;
};

type PendingToolDelivery = {
  readonly requestId: string;
  readonly call: LocalToolCall;
  readonly state: "output-available" | "output-error";
  readonly output?: AgentJsonValue;
  readonly errorText?: string;
  attemptedOpenEpoch: number | null;
  inFlight: boolean;
};

type PendingApprovalDecision = Readonly<{
  requestId: string;
  callId: string;
  approved: boolean;
}>;

type PendingApprovalDelivery = {
  readonly decision: PendingApprovalDecision;
  attemptedOpenEpoch: number | null;
  inFlight: boolean;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const INTERNAL_SERVICE_WORDING =
  /\b(?:agent connection|connection ticket|websocket|socket|stream|transport|bootstrap|protocol|provider|openrouter|cloudflare|think|pi|ai sdk)\b/iu;
const INTERNAL_SERVER_TOOL_NAMES = new Set(["set_context"]);
const MAX_NATIVE_SOURCE_URLS = 16;
const MAX_NATIVE_SOURCE_URL_LENGTH = 2_048;
const MAX_NATIVE_SOURCE_TITLE_LENGTH = 160;
const MAX_CONTEXT_RESPONSE_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function safeServiceMessage(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized
    && normalized.length <= 512
    && !INTERNAL_SERVICE_WORDING.test(normalized)
    ? normalized
    : fallback;
}

function managedError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): ManagedAgentError {
  if (isRecord(error)) {
    const code = typeof error.code === "string"
      && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code)
      && !INTERNAL_SERVICE_WORDING.test(error.code.replace(/[_-]+/g, " "))
      ? error.code
      : fallbackCode;
    const status = typeof error.status === "number" && Number.isInteger(error.status)
      ? error.status
      : undefined;
    const retryable = typeof error.retryable === "boolean"
      ? error.retryable
      : status === undefined || status === 401 || status === 429 || status >= 500;
    return {
      code,
      message: safeServiceMessage(
        typeof error.message === "string" ? error.message : undefined,
        fallbackMessage,
      ),
      ...(status === undefined ? {} : { status }),
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
  return {
    code: terminal.code,
    message: safeServiceMessage(
      terminal.message,
      "SystemSculpt could not complete the response.",
    ),
    requestId: terminal.incident_id,
    retryable: terminal.retryable,
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
          || JSON.stringify(existing.input) !== JSON.stringify(parsed.data.input)
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
        summary: result.error?.message ?? "The vault action failed.",
        data: result.data,
        ...(artifacts ? { artifacts } : {}),
      };
}

function projectedToolState(
  tool: ProjectedTool,
  active: ActiveRun,
): AgentToolPart["state"] {
  if (active.executingToolIds.has(tool.callId)) return "running";
  const decision = active.approvalDecisions.get(tool.callId);
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
      return isMutatingTool(tool.name) && requiresUserApproval(tool.name, active.approvalPolicy)
        ? decision === undefined ? "approval-required" : decision ? "approved" : "denied"
        : "input-ready";
    case "approval-requested":
      return decision === undefined ? "approval-required" : decision ? "approved" : "denied";
    case "approval-responded":
      return toolApproval(tool.part)?.approved === false ? "denied" : "approved";
    case "output-available":
      return tool.part.preliminary === true
        ? "running"
        : outputAsToolResult(toolOutput(tool.part)).success ? "succeeded" : "failed";
    case "output-error": return "failed";
    case "output-denied": return "denied";
    default: return "input-ready";
  }
}

function toolFailure(part: WirePart): ManagedAgentError | undefined {
  if (part.state === "output-error") {
    return {
      code: "TOOL_EXECUTION_FAILED",
      message: typeof part.errorText === "string"
        ? part.errorText
        : "The vault action failed.",
    };
  }
  if (part.state === "output-available" && part.preliminary !== true) {
    const result = outputAsToolResult(toolOutput(part));
    if (!result.success) {
      return {
        code: result.error?.code ?? "TOOL_EXECUTION_FAILED",
        message: result.error?.message ?? "The vault action failed.",
      };
    }
  }
  return undefined;
}

function safeNativeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_NATIVE_SOURCE_URL_LENGTH) return null;
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
    .slice(0, MAX_NATIVE_SOURCE_TITLE_LENGTH)
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
      const url = safeNativeSourceUrl(part.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: markdownSourceTitle(part.title, url) });
      if (sources.length >= MAX_NATIVE_SOURCE_URLS) break;
    }
    if (sources.length >= MAX_NATIVE_SOURCE_URLS) break;
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

/**
 * Cheap "did the server produce anything new" fingerprint.
 *
 * Counts alone would miss a long single text stream, whose deltas only grow
 * the trailing part in place, so the trailing part's text length is included.
 */
function runProgressKey(
  snapshot: AgentSessionSnapshot<WireMessage>,
): string {
  const messages = snapshot.messages;
  const last = messages[messages.length - 1];
  const parts = last?.parts ?? [];
  const trailingText: unknown = parts[parts.length - 1]?.text;
  const text = typeof trailingText === "string" ? trailingText.length : 0;
  const runState = snapshot.runState;
  const runId = "run_id" in runState ? runState.run_id : "";
  return `${runState.state}:${runId}:${messages.length}:${parts.length}:${text}`;
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
      const state = projectedToolState(tool, active);
      const result = tool.part.state === "output-available" && tool.part.preliminary !== true
        ? outputAsToolResult(toolOutput(tool.part))
        : undefined;
      const approval = toolApproval(tool.part);
      const syntheticApprovalId = active.approvalIds.get(callId);
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
        ...(toolFailure(tool.part) ? { error: toolFailure(tool.part) } : {}),
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
  } else if (parts.some((part) =>
    part.kind === "tool" && part.state === "approval-required")) {
    status = "waiting";
    phase = "waiting";
    label = "Waiting for approval";
    waitingReason = "approval";
  } else if (runStalled) {
    // The socket is healthy but the server has sent nothing for a long time.
    // Keep the run open (only the server may end it) and stop implying work
    // is happening.
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
    phase,
    ...(label ? { statusLabel: label } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(error ? { terminalError: error } : {}),
    messages: Object.freeze(projectedMessages),
    parts: Object.freeze(parts),
  });
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
  if (state === "output-available" && tool.part.preliminary !== true) {
    const result = outputAsToolResult(toolOutput(tool.part));
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
  if (state === "output-error" || state === "output-denied") {
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
              message: typeof tool.part.errorText === "string"
                ? tool.part.errorText
                : "The vault action failed.",
            },
      },
      ...(tool.location === "server" ? { executedOn: "server" as const } : {}),
    };
  }
  return null;
}

function durableAssistantMessage(
  message: WireMessage,
  sequence: readonly WireMessage[],
  now: number,
  appendSources: boolean,
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
    ...(messageParts.length > 0 ? { messageParts } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function durableServerHistory(messages: readonly WireMessage[], now: number): ChatMessage[] {
  const output: ChatMessage[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === "user") {
      output.push(durableUserMessage(message));
      index += 1;
      continue;
    }
    const start = index;
    while (index < messages.length && messages[index]!.role === "assistant") index += 1;
    const sequence = messages.slice(start, index);
    sequence.forEach((assistant, sequenceIndex) => {
      const durable = durableAssistantMessage(
        assistant,
        sequence,
        now + (start + sequenceIndex) * 1_000,
        sequenceIndex === sequence.length - 1,
      );
      if (durable) output.push(durable);
    });
  }
  return output;
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
  private pendingCancelRequestId: string | null = null;
  private readonly pendingDeliveries = new Map<string, PendingToolDelivery>();
  private readonly pendingApprovalDeliveries = new Map<string, PendingApprovalDelivery>();
  private inputLimits: ThinAgentInputLimits = DEFAULT_THIN_AGENT_INPUT_LIMITS;
  private lifecycleSequence = 0;
  private renderTimer: number | null = null;
  private pendingSnapshot: AgentConversationSnapshot | null = null;
  private pendingReconcile: Promise<void> = Promise.resolve();
  private reconciledKey: string | null = null;
  private generation = 0;
  private openEpoch = 0;

  public constructor(private readonly options: AgentChatSessionOptions) {
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
    this.now = options.now ?? Date.now;
  }

  public getSnapshot(): AgentConversationSnapshot {
    return this.currentSnapshot;
  }

  public subscribe(listener: (snapshot: AgentConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public recordLifecycle(input: AgentLifecycleInput): void {
    const record: AgentLifecycleRecord = Object.freeze({
      ...input,
      sequence: ++this.lifecycleSequence,
      timestamp: this.now(),
    });
    // Lifecycle records stay local. Pushing them to the server was a socket
    // side channel, and the server treated them as non-authoritative log
    // enrichment that never affected a run.
    try { this.options.onLifecycle?.(record); }
    catch { /* Diagnostics never alter product behavior. */ }
  }

  public async hydrate(conversationId: string): Promise<void> {
    if (this.conversationId === conversationId && this.session && this.transport) {
      await this.transport.connect();
      return;
    }
    if (this.active && !this.active.terminal) {
      throw new Error("Wait for the current response to finish before changing chats.");
    }
    this.disconnect();
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
    });
    const session = new AgentSession<WireMessage>({
      conversationId,
      connection: transport,
      isAuthoritativeMessage: isWireMessage,
      onProtocolError: (error) => this.reportLocalIssue(error),
      onCommandError: (error) => this.reportLocalIssue(error),
      onCommandAck: (ack) => this.handleCommandAck(ack, generation),
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
    this.recordLifecycle({ code: "response_prepare_started", phase: "start", conversationId });
    try {
      await transport.connect();
      if (this.generation !== generation) return;
      this.recordLifecycle({ code: "response_prepare_completed", phase: "start", conversationId });
      await this.pendingReconcile.catch(() => undefined);
    } catch (error) {
      if (this.generation !== generation) return;
      this.recordLifecycle({
        code: "response_prepare_failed",
        phase: "start",
        conversationId,
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
      return this.failedResult(
        input.turnId,
        { code: "response_in_progress", message: "SystemSculpt is already working.", retryable: true },
      );
    }
    try {
      await this.hydrate(input.conversationId);
    } catch (error) {
      const normalized = managedError(
        error,
        "response_start_failed",
        "SystemSculpt could not start the response.",
      );
      this.reportLocalIssue(normalized);
      return this.failedResult(input.turnId, normalized);
    }
    const session = this.session;
    if (!session || session.current.runState.state !== "idle") {
      return this.failedResult(input.turnId, {
        code: "response_in_progress",
        message: "The previous response is still active.",
        retryable: true,
      });
    }
    const active = this.createActiveRun({
      origin: "submitted",
      conversationId: input.conversationId,
      requestId: input.turnId,
      turnId: input.turnId,
      approvalPolicy: input.approvalPolicy ?? {},
    });
    this.active = active;
    this.recordLifecycle({
      code: "run_started",
      phase: "response",
      conversationId: input.conversationId,
      requestId: input.turnId,
    });
    this.publishActive(active, true);
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
        try {
          await input.beforeSend();
        } catch (error) {
          this.recordLifecycle({
            code: "history_sync_failed",
            phase: "persistence",
            conversationId: input.conversationId,
            requestId: input.turnId,
          });
          this.reportLocalIssue(error);
        }
      }
      if (active.cancelRequested || active.abort.signal.aborted) {
        return await active.completion;
      }
      this.recordLifecycle({
        code: "request_dispatch_started",
        phase: "response",
        conversationId: input.conversationId,
        requestId: input.turnId,
      });
      await session.submit({
        request_id: input.turnId,
        user_message: input.message,
        ...(contextRef ? { context_ref: contextRef } : {}),
      });
      this.recordLifecycle({
        code: "request_dispatch_returned",
        phase: "response",
        conversationId: input.conversationId,
        requestId: input.turnId,
      });
    } catch (error) {
      if (!active.terminal && !active.cancelRequested) {
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
        });
        this.finishLocalFailure(active, normalized);
      }
    }
    return active.completion;
  }

  public async regenerate(input: Readonly<{
    conversationId: string;
    requestId: string;
    rootMessageId: string;
  }>): Promise<AgentRunResult> {
    await this.hydrate(input.conversationId);
    const session = this.session;
    if (!session || session.current.runState.state !== "idle") {
      return this.failedResult(input.rootMessageId, {
        code: "response_in_progress",
        message: "The previous response is still active.",
        retryable: true,
      });
    }
    const active = this.createActiveRun({
      origin: "submitted",
      conversationId: input.conversationId,
      requestId: input.requestId,
      turnId: input.rootMessageId,
      approvalPolicy: {},
    });
    this.active = active;
    this.publishActive(active, true);
    try {
      await session.regenerate({
        request_id: input.requestId,
        root_message_id: input.rootMessageId,
      });
    } catch (error) {
      this.finishLocalFailure(active, managedError(
        error,
        "response_start_failed",
        "SystemSculpt could not retry the response.",
      ));
    }
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
    });
    try {
      const bootstrap = await this.issueBootstrap();
      const url = new URL(THIN_AGENT_CONTEXT_PATH, this.options.baseUrl);
      url.searchParams.set("access_token", bootstrap.access.token);
      const request = parseThinAgentContextRequest({
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        root_message_id: rootMessageId,
        context_sources: contextSources,
      }, this.inputLimits);
      const response = await this.requestClient.request({
        url: url.toString(),
        method: "POST",
        headers: { "x-plugin-version": this.options.pluginVersion },
        body: request,
        signal,
        preserveResponseHeaders: true,
        allowTransportFallback: true,
        responseEncoding: "arrayBuffer",
        maxResponseBytes: MAX_CONTEXT_RESPONSE_BYTES,
      });
      if (response.status !== 201) {
        const payload = boundedErrorPayload(await response.text());
        const fallback = response.status === 413
          ? "Selected vault context is too large."
          : response.status === 401
            ? "Your SystemSculpt session expired. Retry this message."
            : `SystemSculpt could not prepare vault context (${response.status}).`;
        throw Object.assign(new Error(safeServiceMessage(payload.message, fallback)), {
          code: response.status === 413 ? "context_too_large" : "context_prepare_failed",
          status: response.status,
          retryable: response.status === 401 || response.status >= 500,
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
      });
      throw error;
    }
  }

  public respondToApproval(
    approvalId: string,
    approved: boolean,
    source: "manual" | "policy" = "manual",
  ): boolean {
    const active = this.active;
    const session = this.session;
    if (!active || !session || active.terminal) return false;
    const callId = [...active.approvalIds.entries()]
      .find(([, candidate]) => candidate === approvalId)?.[0];
    if (!callId || active.approvalDecisions.has(callId)) return false;
    const tool = this.findCurrentTool(active, callId);
    if (!tool || (tool.part.state !== "approval-requested"
      && tool.part.state !== "input-available")) return false;
    active.approvalDecisions.set(callId, approved);
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
    });
    const serverRequested = tool.part.state === "approval-requested";
    if (serverRequested) {
      const delivery: PendingApprovalDelivery = {
        decision: Object.freeze({
          requestId: active.requestId,
          callId,
          approved,
        }),
        attemptedOpenEpoch: null,
        inFlight: false,
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
    this.pendingCancelRequestId = active.requestId;
    this.publishActive(active, true);
    await this.trySendPendingCancel();
    const terminal: ThinAgentRunTerminalData = {
      version: 1,
      run_id: active.serverRunId ?? `run_${"0".repeat(32)}`,
      root_message_id: active.turnId,
      outcome: "cancelled",
      code: "cancelled",
    };
    active.terminal = terminal;
    this.completeActive(active, { kind: "cancelled", snapshot: projectRun(
      active,
      this.authoritativeMessages,
      this.connectionState,
    ) });
  }

  public async detach(): Promise<void> {
    const active = this.active;
    if (active && !active.terminal) {
      active.abort.abort();
      active.terminal = {
        version: 1,
        run_id: active.serverRunId ?? `run_${"0".repeat(32)}`,
        root_message_id: active.turnId,
        outcome: "cancelled",
        code: "cancelled",
      };
      const snapshot = projectRun(
        active,
        this.authoritativeMessages,
        this.connectionState,
      );
      active.resolve({ kind: "cancelled", snapshot });
      this.active = null;
    }
    this.disconnect();
    await this.options.mutationJournal.idle();
    await this.pendingReconcile.catch(() => undefined);
  }

  public disconnect(): void {
    this.generation += 1;
    this.clearRunStallTimer();
    this.runStalled = false;
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
    this.pendingDeliveries.clear();
    this.pendingApprovalDeliveries.clear();
  }

  private createActiveRun(input: Readonly<{
    origin: ActiveRun["origin"];
    conversationId: string;
    requestId: string;
    turnId: string;
    approvalPolicy: ToolApprovalPolicy;
  }>): ActiveRun {
    let resolve!: (result: AgentRunResult) => void;
    const completion = new Promise<AgentRunResult>((settle) => {
      resolve = settle;
    });
    return {
      token: {},
      ...input,
      abort: new AbortController(),
      completion,
      resolve,
      executingToolIds: new Set(),
      settledToolIds: new Set(),
      approvalDecisions: new Map(),
      approvalIds: new Map(),
      toolTasks: new Map(),
      baseMessageIds: new Set(this.authoritativeMessages.map((message) => message.id)),
      phase: input.origin === "recovered" ? "retrying" : "submitted",
      label: input.origin === "recovered" ? "Recovering" : "Starting",
      serverRunId: null,
      terminal: null,
      finalizing: false,
      cancelRequested: false,
    };
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
    const progressKey = runProgressKey(snapshot);
    if (progressKey !== this.runProgressKey) {
      this.runProgressKey = progressKey;
      this.noteServerProgress();
    }
    this.authoritativeMessages = snapshot.messages;
    this.presentationMessages = this.messagesWithOptimisticUser(snapshot);
    const runState = snapshot.runState;
    let active = this.active;
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
        this.finishLocalFailure(active, {
          code: "response_state_mismatch",
          message: "SystemSculpt returned a mismatched response state.",
          retryable: true,
        });
        return;
      }
      active.serverRunId = runState.run_id;
      active.phase = runState.state === "waiting_for_client" ? "waiting" : "working";
    }
    if (snapshot.terminal && active
      && snapshot.terminal.request_id === active.requestId) {
      this.acceptTerminal(active, snapshot.terminal.value);
      return;
    }
    if (active && !active.terminal) {
      const persistedTerminal = terminalFromMessages(
        snapshot.messages,
        active.turnId,
        active.serverRunId,
      );
      if (persistedTerminal) {
        this.acceptTerminal(active, persistedTerminal);
        return;
      }
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
    void this.trySendPendingCancel();
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
    if (!session || !active || active.terminal || active.requestId !== ack.request_id) return;
    const runState = session.current.runState;
    if (
      (runState.state !== "running" && runState.state !== "waiting_for_client")
      || runState.request_id !== ack.request_id
      || (active.serverRunId !== null && active.serverRunId !== runState.run_id)
    ) return;

    if (ack.command_kind === "client_tool_approval") {
      const pending = this.pendingApprovalDeliveries.get(ack.tool_call_id);
      if (!pending || pending.decision.requestId !== ack.request_id) return;
      this.pendingApprovalDeliveries.delete(ack.tool_call_id);
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
      });
      return;
    }

    if (ack.command_kind === "client_tool_result") {
      const pending = this.pendingDeliveries.get(ack.tool_call_id);
      if (!pending || pending.requestId !== ack.request_id) return;
      this.pendingDeliveries.delete(ack.tool_call_id);
      active.settledToolIds.add(ack.tool_call_id);
      this.recordLifecycle({
        code: pending.state === "output-available"
          ? "tool_result_acknowledged_succeeded"
          : "tool_result_acknowledged_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: pending.call.name,
        toolCallId: ack.tool_call_id,
      });
    }
  }

  private handleConnectionState(state: AgentConnectionState): void {
    const active = this.active;
    if (state === "open") {
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
    }
    if (active && !active.terminal) this.publishActive(active, true);
  }

  /**
   * Arms the run-liveness bound whenever the presentation claims the server is
   * working. Deliberately keyed on the projected phase: "waiting" covers
   * approval and local tool execution, which the user bounds, and "retrying"
   * covers connection trouble, which the connection watchdog already owns.
   */
  private syncRunStallWatchdog(snapshot: AgentConversationSnapshot): void {
    const awaitingServer = !this.runStalled
      && !this.awaitingClientWork
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
    }, this.runStallGraceMs());
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
   * Authoritative content moved, so the run is demonstrably alive. Reconnects
   * alone must not count: during a server-side stall the transport can keep
   * reconnecting cleanly forever, which would reset the bound and hide exactly
   * the failure it exists to catch.
   */
  private noteServerProgress(): void {
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
    const targets = collectClientToolTargets(turnMessages);
    const tools = canonicalTools(turnMessages, targets);
    for (const [callId, target] of targets) {
      const tool = tools.get(callId);
      if (!tool || tool.location !== "vault" || tool.name !== target.name) continue;
      if (!this.reconcilePendingApproval(active, tool)) return;
      const state = tool.part.state;
      if (
        (state === "output-available" && tool.part.preliminary !== true)
        || state === "output-error"
        || state === "output-denied"
      ) {
        active.settledToolIds.add(callId);
        this.pendingDeliveries.delete(callId);
        continue;
      }
      if (
        active.settledToolIds.has(callId)
        || active.toolTasks.has(callId)
        || this.pendingDeliveries.has(callId)
      ) continue;
      const approval = toolApproval(tool.part);
      if (approval?.id) active.approvalIds.set(callId, approval.id);
      if (state === "approval-requested") {
        if (!active.approvalIds.has(callId)) {
          active.approvalIds.set(callId, `approval:${callId}`);
        }
        if (!active.approvalDecisions.has(callId)) {
          this.recordLifecycle({
            code: "approval_presented",
            phase: "approval",
            conversationId: active.conversationId,
            requestId: active.requestId,
            toolName: tool.name,
            toolCallId: callId,
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
        active.approvalDecisions.set(callId, true);
        this.startLocalTool(active, tool);
        continue;
      }
      if (state === "input-available") {
        if (isMutatingTool(tool.name)
          && requiresUserApproval(tool.name, active.approvalPolicy)) {
          const approvalId = active.approvalIds.get(callId) ?? `approval:${callId}`;
          active.approvalIds.set(callId, approvalId);
          if (!active.approvalDecisions.has(callId)) continue;
          if (active.approvalDecisions.get(callId) !== true) continue;
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
    const approval = toolApproval(tool.part);
    const acknowledged = typeof approval?.approved === "boolean"
      ? approval.approved
      : tool.part.state === "output-denied"
        ? false
        : tool.part.state === "output-available" || tool.part.state === "output-error"
          ? true
          : undefined;
    if (acknowledged === undefined) return true;
    const localDecision = pending?.decision.approved
      ?? active.approvalDecisions.get(tool.callId);
    if (localDecision !== undefined && acknowledged !== localDecision) {
      this.finishLocalFailure(active, {
        code: "approval_state_mismatch",
        message: "SystemSculpt returned a mismatched approval state.",
        retryable: true,
      });
      return false;
    }
    if (!pending) return true;
    this.pendingApprovalDeliveries.delete(tool.callId);
    this.recordLifecycle({
      code: acknowledged
        ? "approval_acknowledged_approved"
        : "approval_acknowledged_denied",
      phase: "approval",
      conversationId: active.conversationId,
      requestId: active.requestId,
      toolName: tool.name,
      toolCallId: tool.callId,
    });
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
    if (this.pendingApprovalDeliveries.get(delivery.decision.callId) !== delivery
      || tool.part.state !== "approval-requested") return;

    const attemptedEpoch = this.openEpoch;
    delivery.attemptedOpenEpoch = attemptedEpoch;
    delivery.inFlight = true;
    void session.sendToolApproval({
      request_id: delivery.decision.requestId,
      tool_call_id: delivery.decision.callId,
      approved: delivery.decision.approved,
    }).catch((error) => {
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
    const call: LocalToolCall = {
      callId: tool.callId,
      name: tool.name,
      input: tool.input,
    };
    active.executingToolIds.add(call.callId);
    this.recordLifecycle({
      code: "local_tool_started",
      phase: "tool_execution",
      conversationId: active.conversationId,
      requestId: active.requestId,
      toolName: call.name,
      toolCallId: call.callId,
    });
    this.publishActive(active, true);
    const task = this.executeLocalTool(active, call)
      .catch((error) => this.reportLocalIssue(error))
      .finally(() => {
        active.executingToolIds.delete(call.callId);
        active.toolTasks.delete(call.callId);
        if (this.active?.token === active.token && !active.terminal) {
          this.publishActive(active, true);
        }
      });
    active.toolTasks.set(call.callId, task);
  }

  private async executeLocalTool(active: ActiveRun, call: LocalToolCall): Promise<void> {
    let result: ToolCallResult;
    let delivery: PendingToolDelivery;
    try {
      if (isMutatingTool(call.name)) {
        const claim = await this.options.mutationJournal.claim(
          active.conversationId,
          call.callId,
          call.name,
          call.input,
        );
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
      this.recordLifecycle({
        code: result.success
          ? "local_tool_completed_succeeded"
          : "local_tool_completed_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: call.name,
        toolCallId: call.callId,
      });
      delivery = {
        requestId: active.requestId,
        call,
        state: "output-available",
        output: toJsonValue(result),
        attemptedOpenEpoch: null,
        inFlight: false,
      };
    } catch (error) {
      if (active.abort.signal.aborted || active.terminal) return;
      this.recordLifecycle({
        code: "local_tool_completed_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: call.name,
        toolCallId: call.callId,
      });
      delivery = {
        requestId: active.requestId,
        call,
        state: "output-error",
        errorText: (error instanceof Error ? error.message : "The vault action failed.")
          .slice(0, 4_096),
        attemptedOpenEpoch: null,
        inFlight: false,
      };
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
    delivery.inFlight = true;
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
      this.recordLifecycle({
        code: delivery.state === "output-available"
          ? "tool_result_sent_succeeded"
          : "tool_result_sent_failed",
        phase: "tool_execution",
        conversationId: active.conversationId,
        requestId: active.requestId,
        toolName: delivery.call.name,
        toolCallId: delivery.call.callId,
      });
    } catch (error) {
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

  private acceptTerminal(active: ActiveRun, terminal: ThinAgentRunTerminalData): void {
    if (
      this.active?.token !== active.token
      || active.terminal
      || terminal.root_message_id !== active.turnId
      || (active.serverRunId && terminal.run_id !== active.serverRunId)
    ) return;
    active.serverRunId = terminal.run_id;
    active.terminal = terminal;
    active.phase = terminal.outcome === "succeeded" ? "settling" : "complete";
    active.label = terminal.outcome === "succeeded" ? "Finishing" : "";
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
        ? { retryable: terminal.retryable, incidentId: terminal.incident_id }
        : {}),
    });
    this.publishActive(active, true);
    void this.finalizeTerminal(active);
  }

  private async finalizeTerminal(active: ActiveRun): Promise<void> {
    if (active.finalizing || this.active?.token !== active.token || !active.terminal) return;
    active.finalizing = true;
    await Promise.allSettled(active.toolTasks.values());
    const terminal = active.terminal;
    let assistantMessage: ChatMessage | undefined;
    if (terminal.outcome === "succeeded") {
      const turn = currentTurnMessages(this.presentationMessages, active.turnId);
      const assistant = [...turn].reverse().find((message) => message.role === "assistant");
      if (assistant) {
        const durable = durableAssistantMessage(
          assistant,
          turn.filter((message) => message.role === "assistant"),
          this.now(),
          true,
        );
        if (durable) {
          assistantMessage = durable;
          this.recordLifecycle({
            code: "response_save_started",
            phase: "persistence",
            conversationId: active.conversationId,
            requestId: active.requestId,
            serverRunId: terminal.run_id,
          });
          try {
            await this.options.persistAssistant(durable);
            this.recordLifecycle({
              code: "response_save_completed",
              phase: "persistence",
              conversationId: active.conversationId,
              requestId: active.requestId,
              serverRunId: terminal.run_id,
            });
          } catch (error) {
            this.recordLifecycle({
              code: "response_save_failed",
              phase: "persistence",
              conversationId: active.conversationId,
              requestId: active.requestId,
              serverRunId: terminal.run_id,
            });
            this.reportLocalIssue(error);
          }
        }
      }
    }
    await this.reconcileMessages(this.presentationMessages).catch(() => undefined);
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
    this.completeActive(active, result);
    if (terminal.outcome === "succeeded") {
      void this.options.refreshCredits?.().catch((error) => this.reportLocalIssue(error));
    }
  }

  private completeActive(active: ActiveRun, result: AgentRunResult): void {
    if (this.active?.token !== active.token) return;
    this.clearRunStallTimer();
    this.runStalled = false;
    this.pendingDeliveries.clear();
    this.pendingApprovalDeliveries.clear();
    this.pendingCancelRequestId = null;
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
      ...(result.kind === "failed" ? { retryable: result.error.retryable } : {}),
    });
    this.active = null;
    active.resolve(result);
  }

  private finishLocalFailure(active: ActiveRun, error: ManagedAgentError): void {
    if (this.active?.token !== active.token || active.terminal) return;
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
    const snapshot = projectRun(
      active,
      this.presentationMessages,
      this.connectionState,
    );
    this.commitSnapshot(snapshot);
    this.reportLocalIssue(error);
    this.completeActive(active, { kind: "failed", snapshot, error });
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
    const snapshot = projectRun(
      active,
      this.presentationMessages,
      this.connectionState,
      this.runStalled,
    );
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
    this.pendingSnapshot = snapshot;
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      const next = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (next) this.commitSnapshot(next);
    }, 16);
  }

  private commitSnapshot(snapshot: AgentConversationSnapshot): void {
    this.pendingSnapshot = null;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
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
    void this.reconcileMessages(messages).catch(() => undefined);
  }

  private reconcileMessages(messages: readonly WireMessage[]): Promise<void> {
    if (!this.options.reconcileHistory) return Promise.resolve();
    // An empty fresh or fork snapshot is not an instruction to erase a local
    // cache. Wait until the server has published an authoritative root.
    if (messages.length === 0) return Promise.resolve();
    const key = JSON.stringify(messages);
    if (key === this.reconciledKey) return this.pendingReconcile;
    this.reconciledKey = key;
    const conversationId = this.conversationId;
    const durable = durableServerHistory(messages, this.now());
    this.recordLifecycle({
      code: "history_sync_started",
      phase: "persistence",
      ...(conversationId ? { conversationId } : {}),
    });
    const task = this.pendingReconcile.then(() =>
      this.options.reconcileHistory!(durable));
    this.pendingReconcile = task.then(
      () => {
        this.recordLifecycle({
          code: "history_sync_completed",
          phase: "persistence",
          ...(conversationId ? { conversationId } : {}),
        });
      },
      (error) => {
        if (this.reconciledKey === key) this.reconciledKey = null;
        this.recordLifecycle({
          code: "history_sync_failed",
          phase: "persistence",
          ...(conversationId ? { conversationId } : {}),
        });
        this.reportLocalIssue(error);
      },
    );
    return task;
  }

  private async trySendPendingCancel(): Promise<void> {
    const requestId = this.pendingCancelRequestId;
    const session = this.session;
    if (!requestId || !session) return;
    if (
      session.current.runState.state !== "running"
      && session.current.runState.state !== "waiting_for_client"
    ) return;
    if (session.current.runState.request_id !== requestId) return;
    try {
      await session.cancel({ request_id: requestId });
      this.pendingCancelRequestId = null;
    } catch (error) {
      this.reportLocalIssue(error);
    }
  }

  private async issueBootstrap(): Promise<ThinAgentBootstrapResponse> {
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
