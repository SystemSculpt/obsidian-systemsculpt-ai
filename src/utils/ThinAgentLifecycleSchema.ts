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
  "composer_unlocked",
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
  "command_segment_dispatch_started",
  "response_available",
  "response_first_body_chunk_observed",
  "response_first_sse_frame_parsed",
  "response_first_assistant_sse_frame_parsed",
  "response_first_assistant_snapshot_received",
  "response_first_assistant_snapshot_projected",
  "response_first_content_projected",
  "response_stream_ended_incomplete",
  "response_first_dom_committed",
  "response_first_paint_opportunity",
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
  "local_tool_terminal_dom_committed",
  "local_tool_terminal_paint_opportunity",
  "continuation_content_dom_committed",
  "continuation_content_paint_opportunity",
  "tool_result_sent_succeeded",
  "tool_result_sent_failed",
  "tool_result_command_stream_completed_output_available",
  "tool_result_command_stream_completed_output_error",
  "tool_result_command_stream_failed",
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
  "credits_refresh_started",
  "credits_refresh_succeeded",
  "credits_refresh_failed",
  "diagnostics_truncated",
] as const;

export type AgentLifecycleCode = typeof THIN_AGENT_LIFECYCLE_CODES[number];

export const THIN_AGENT_LIFECYCLE_PHASES = [
  "start",
  "session",
  "response",
  "approval",
  "tool_execution",
  "mutation_journal",
  "persistence",
  "render",
  "account",
  "unknown",
] as const;

export type AgentLifecyclePhase = typeof THIN_AGENT_LIFECYCLE_PHASES[number];

export const CREDITS_REFRESH_REASONS = [
  "view_open",
  "post_terminal",
  "billing_failure",
  "settings_update",
  "unspecified",
] as const;

export type CreditsRefreshReason = typeof CREDITS_REFRESH_REASONS[number];

export const HISTORY_SYNC_KINDS = [
  "before_send",
  "authoritative_prefix",
  "cancelled_queue",
  "terminal",
] as const;

export type HistorySyncKind = typeof HISTORY_SYNC_KINDS[number];

export const TOOL_DIAGNOSTIC_OUTCOMES = [
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const;

export type ToolDiagnosticOutcome = typeof TOOL_DIAGNOSTIC_OUTCOMES[number];

export const TOOL_DIAGNOSTIC_FAILURE_CLASSES = [
  "partial_failure",
  "operation_failed",
  "execution_failed",
  "cancelled",
  "journal_unavailable",
  "outcome_unknown",
  "identity_mismatch",
  "invalid_input",
  "unknown",
] as const;

export type ToolDiagnosticFailureClass =
  typeof TOOL_DIAGNOSTIC_FAILURE_CLASSES[number];

const LIFECYCLE_CODE_SET: ReadonlySet<string> = new Set(
  THIN_AGENT_LIFECYCLE_CODES,
);
const LIFECYCLE_PHASE_SET: ReadonlySet<string> = new Set(
  THIN_AGENT_LIFECYCLE_PHASES,
);
const CREDITS_REFRESH_REASON_SET: ReadonlySet<string> = new Set(
  CREDITS_REFRESH_REASONS,
);
const HISTORY_SYNC_KIND_SET: ReadonlySet<string> = new Set(HISTORY_SYNC_KINDS);
const TOOL_DIAGNOSTIC_OUTCOME_SET: ReadonlySet<string> = new Set(
  TOOL_DIAGNOSTIC_OUTCOMES,
);
const TOOL_DIAGNOSTIC_FAILURE_CLASS_SET: ReadonlySet<string> = new Set(
  TOOL_DIAGNOSTIC_FAILURE_CLASSES,
);
const CLIENT_INSTANCE_ID = /^client_[a-f0-9]{32}$/u;
const CONVERSATION_ID = /^conversation_[a-f0-9]{32}$/u;
const REQUEST_ID = /^user-(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[0-9]{10,16}-[a-z0-9]{5,20})$/u;
const INCIDENT_ID = /^incident_(?!0{32}$)[a-f0-9]{32}$/u;
const SERVER_RUN_ID = /^run_(?!0{32}$)[a-f0-9]{32}$/u;
const LATENCY_TRACE_ID = /^[a-f0-9]{32}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1_000;

export function isAgentLifecycleCode(
  value: unknown,
): value is AgentLifecycleCode {
  return typeof value === "string" && LIFECYCLE_CODE_SET.has(value);
}

export function isAgentLifecyclePhase(
  value: unknown,
): value is AgentLifecyclePhase {
  return typeof value === "string" && LIFECYCLE_PHASE_SET.has(value);
}

export function isCreditsRefreshReason(
  value: unknown,
): value is CreditsRefreshReason {
  return typeof value === "string" && CREDITS_REFRESH_REASON_SET.has(value);
}

export function isHistorySyncKind(value: unknown): value is HistorySyncKind {
  return typeof value === "string" && HISTORY_SYNC_KIND_SET.has(value);
}

export function isToolDiagnosticOutcome(
  value: unknown,
): value is ToolDiagnosticOutcome {
  return typeof value === "string" && TOOL_DIAGNOSTIC_OUTCOME_SET.has(value);
}

export function isToolDiagnosticFailureClass(
  value: unknown,
): value is ToolDiagnosticFailureClass {
  return typeof value === "string"
    && TOOL_DIAGNOSTIC_FAILURE_CLASS_SET.has(value);
}

export function boundedToolDiagnosticItemCount(
  value: unknown,
): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= 10_000
    ? value as number
    : undefined;
}

export function boundedThinAgentIdentifier(
  value: unknown,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /^(?:data|file|https?|obsidian|wss?):/iu.test(value)
    || /^www\./iu.test(value)
  ) {
    return undefined;
  }
  return SAFE_IDENTIFIER.test(value) ? value : undefined;
}

export function boundedThinAgentTiming(value: unknown): number | undefined {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > MAX_TIMING_MS
  ) return undefined;
  return Math.round(value * 1_000) / 1_000;
}

export function isThinAgentClientInstanceId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_INSTANCE_ID.test(value);
}

export function isThinAgentConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

export function isThinAgentRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export function isThinAgentIncidentId(value: unknown): value is string {
  return typeof value === "string" && INCIDENT_ID.test(value);
}

export function isThinAgentServerRunId(value: unknown): value is string {
  return typeof value === "string" && SERVER_RUN_ID.test(value);
}

export function isThinAgentLatencyTraceId(value: unknown): value is string {
  return typeof value === "string" && LATENCY_TRACE_ID.test(value);
}

export function isThinAgentFailureCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_FAILURE_CODE.test(value);
}
