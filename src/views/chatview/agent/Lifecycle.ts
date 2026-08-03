import { isFirstPartyToolName } from "../../../tools/toolNames";

export const THIN_AGENT_LIFECYCLE_CODES = [
  "session_opened",
  "session_closed",
  "session_interrupted",
  "session_failed",
  "response_prepare_started",
  "response_prepare_completed",
  "response_prepare_failed",
  "context_prepare_started",
  "context_prepare_completed",
  "context_prepare_cancelled",
  "context_prepare_failed",
  "submission_admitted",
  "submission_queued",
  "queued_submission_removed",
  "queued_submission_promoted",
  "stop_requested",
  "stop_completed",
  "historical_resubmit_started",
  "historical_resubmit_committed",
  "historical_resubmit_failed",
  "conversation_reset",
  "run_started",
  "run_stalled",
  "request_dispatch_started",
  "request_dispatch_returned",
  "request_dispatch_failed",
  "phase_submitted",
  "phase_thinking",
  "phase_working",
  "phase_waiting",
  "phase_retrying",
  "phase_settling",
  "phase_complete",
  "approval_presented",
  "approval_submitted_approved_manual",
  "approval_submitted_approved_policy",
  "approval_submitted_denied",
  "approval_acknowledged_approved",
  "approval_acknowledged_denied",
  "mutation_execute_claimed",
  "mutation_replay_served",
  "mutation_outcome_unknown",
  "mutation_call_conflict",
  "local_tool_started",
  "local_tool_completed_succeeded",
  "local_tool_completed_failed",
  "tool_result_sent_succeeded",
  "tool_result_sent_failed",
  "tool_result_acknowledged_succeeded",
  "tool_result_acknowledged_failed",
  "response_result_received_succeeded",
  "response_result_received_cancelled",
  "response_result_received_failed",
  "response_save_started",
  "response_save_completed",
  "response_save_failed",
  "history_sync_started",
  "history_sync_completed",
  "history_sync_failed",
  "run_finished_completed",
  "run_finished_cancelled",
  "run_finished_failed",
  "diagnostics_truncated",
] as const;

export type AgentLifecycleCode = typeof THIN_AGENT_LIFECYCLE_CODES[number];

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

export type AgentLifecycleRecord = Readonly<{
  sequence: number;
  timestamp: number;
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

const CODE_SET = new Set<string>(THIN_AGENT_LIFECYCLE_CODES);
const CLIENT_INSTANCE_ID = /^client_[a-f0-9]{32}$/u;
const CONVERSATION_ID = /^conversation_[a-f0-9]{32}$/u;
const INCIDENT_ID = /^incident_[a-f0-9]{32}$/u;
const SERVER_RUN_ID = /^run_[a-f0-9]{32}$/u;
const PHASE_SET = new Set<string>([
  "start",
  "session",
  "response",
  "approval",
  "tool_execution",
  "mutation_journal",
  "persistence",
  "render",
  "unknown",
]);

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /^(?:data|file|https?|obsidian|wss?):/iu.test(value)
    || /^www\./iu.test(value)
  ) {
    return undefined;
  }
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value) ? value : undefined;
}

/**
 * Strict, content-free client lifecycle recorder. It copies only explicitly
 * allowlisted scalar fields and never serializes caller-owned objects.
 */
export class AgentLifecycle {
  private sequence = 0;

  constructor(
    private readonly persist: (record: AgentLifecycleRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public record(input: AgentLifecycleInput): AgentLifecycleRecord | null {
    if (!CODE_SET.has(input.code) || !PHASE_SET.has(input.phase)) return null;
    const conversationId = typeof input.conversationId === "string"
      && CONVERSATION_ID.test(input.conversationId)
      ? input.conversationId
      : undefined;
    const requestId = boundedIdentifier(input.requestId, 160);
    const clientInstanceId = typeof input.clientInstanceId === "string"
      && CLIENT_INSTANCE_ID.test(input.clientInstanceId)
      ? input.clientInstanceId
      : undefined;
    const pluginBuildId = boundedIdentifier(input.pluginBuildId, 160);
    const runId = boundedIdentifier(input.runId, 160);
    const serverRunId = typeof input.serverRunId === "string"
      && SERVER_RUN_ID.test(input.serverRunId)
      ? input.serverRunId
      : undefined;
    const toolName = isFirstPartyToolName(input.toolName)
      ? input.toolName
      : undefined;
    const toolCallId = boundedIdentifier(input.toolCallId, 160);
    const status = Number.isInteger(input.status)
      && input.status! >= 100
      && input.status! <= 599
      ? input.status
      : undefined;
    const incidentId = typeof input.incidentId === "string"
      && INCIDENT_ID.test(input.incidentId)
      ? input.incidentId
      : undefined;
    const record: AgentLifecycleRecord = Object.freeze({
      sequence: ++this.sequence,
      timestamp: this.now(),
      code: input.code,
      phase: input.phase,
      ...(conversationId ? { conversationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(clientInstanceId ? { clientInstanceId } : {}),
      ...(pluginBuildId ? { pluginBuildId } : {}),
      ...(runId ? { runId } : {}),
      ...(serverRunId ? { serverRunId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status === undefined ? {} : { status }),
      ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
      ...(incidentId ? { incidentId } : {}),
    });
    try {
      this.persist(record);
    } catch {
      // Lifecycle diagnostics must never alter the product flow.
    }
    return record;
  }

}
