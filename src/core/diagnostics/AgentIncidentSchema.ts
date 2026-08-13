import { isThinAgentFailureCode } from "../../utils/ThinAgentLifecycleSchema";

export const AGENT_INCIDENT_SCHEMA_VERSION = "systemsculpt.incident/2" as const;
export const AGENT_INCIDENT_MAX_EVENTS = 256;
export const AGENT_INCIDENT_MAX_REPORT_BYTES = 256 * 1_024;
export const AGENT_INCIDENT_MAX_RESOURCE_SAMPLES = 12;
export const AGENT_INCIDENT_MAX_TOOLS = 64;
export const AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS = 64;
export const AGENT_INCIDENT_MAX_RENDER_COUNT = 1_000_000;
export const AGENT_INCIDENT_MAX_RENDER_DURATION_MS = 86_400_000;
export const AGENT_INCIDENT_MAX_TRANSPORT_BYTES = 64 * 1024 * 1024;
export const AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT = 10_000;
export const AGENT_INCIDENT_MAX_COUNT = 100_000_000;
export const AGENT_INCIDENT_MAX_TOOL_ORDINAL = 512;
export const AGENT_INCIDENT_GROUPING_STRATEGY = "systemsculpt.failure-contract/1" as const;

export type AgentIncidentFailureAuthority = "server" | "client" | "unknown";
export type AgentIncidentTerminalValidation = "validated" | "unvalidated" | "validation_failed" | "not_recorded";
export type AgentIncidentTerminalEvidence = "server_protocol_validated" | "client_observed" | "unvalidated";
export type AgentIncidentTerminalSource = "session_terminal" | "message_reconstruction" | "local_failure" | "not_recorded";
export type AgentIncidentHttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "not_recorded";
export const AGENT_INCIDENT_FAILURE_STAGES = Object.freeze([
  "submission_admission",
  "response_prepare",
  "context_prepare",
  "request_dispatch",
  "response_terminal",
  "run_state_reconciliation",
  "tool_authorization",
  "approval_reconciliation",
] as const);
export type AgentIncidentFailureStage = typeof AGENT_INCIDENT_FAILURE_STAGES[number];
export type AgentIncidentReportFailureStage = AgentIncidentFailureStage | "not_recorded";

export const AGENT_INCIDENT_FAILURE_MECHANISMS = Object.freeze([
  "concurrent_run",
  "service_terminal",
  "http_rejection",
  "transport_or_protocol_failure",
  "preparation_failure",
  "state_mismatch",
  "identity_mismatch",
] as const);
export type AgentIncidentFailureMechanism = typeof AGENT_INCIDENT_FAILURE_MECHANISMS[number];
export type AgentIncidentReportFailureMechanism = AgentIncidentFailureMechanism | "not_recorded";

const AGENT_INCIDENT_FAILURE_STAGE_SET: ReadonlySet<string> = new Set(
  AGENT_INCIDENT_FAILURE_STAGES,
);
const AGENT_INCIDENT_FAILURE_MECHANISM_SET: ReadonlySet<string> = new Set(
  AGENT_INCIDENT_FAILURE_MECHANISMS,
);

export function isAgentIncidentFailureStage(
  value: unknown,
): value is AgentIncidentFailureStage {
  return typeof value === "string" && AGENT_INCIDENT_FAILURE_STAGE_SET.has(value);
}

export function isAgentIncidentFailureMechanism(
  value: unknown,
): value is AgentIncidentFailureMechanism {
  return typeof value === "string" && AGENT_INCIDENT_FAILURE_MECHANISM_SET.has(value);
}

export const AGENT_INCIDENT_EXPORTED_FAILURE_CODES = Object.freeze([
  "agent_turn_failed",
  "approval_failed",
  "command_stream_failed",
  "context_prepare_failed",
  "context_too_large",
  "context_window_exhausted",
  "history_sync_failed",
  "insufficient_credits",
  "invalid_response_data",
  "invalid_turn_context",
  "local_tool_result_failed",
  "message_save_failed",
  "response_capacity_unavailable",
  "response_display_failed",
  "response_failed",
  "response_finished_with_pending_vault_action",
  "response_in_progress",
  "response_interrupted",
  "response_save_failed",
  "response_start_failed",
  "response_start_rate_limited",
  "response_state_update_failed",
  "selected_context_unavailable",
  "service_accounting_unavailable",
  "service_cost_unavailable",
  "service_outcome_unknown",
  "service_rate_limited",
  "service_temporarily_unavailable",
  "session_expired",
  "session_history_load_failed",
  "session_interrupted",
  "tool_call_id_conflict",
  "tool_mutation_journal_unavailable",
  "tool_mutation_outcome_unknown",
  "tool_result_display_failed",
  "unknown_client_failure",
  "unknown_server_failure",
  "web_search_unavailable",
] as const);

export type AgentIncidentExportedFailureCode =
  typeof AGENT_INCIDENT_EXPORTED_FAILURE_CODES[number];

const AGENT_INCIDENT_EXPORTED_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  AGENT_INCIDENT_EXPORTED_FAILURE_CODES,
);

export function isAgentIncidentExportedFailureCode(
  value: unknown,
): value is AgentIncidentExportedFailureCode {
  return typeof value === "string"
    && AGENT_INCIDENT_EXPORTED_FAILURE_CODE_SET.has(value);
}

export function normalizeAgentIncidentFailureCode(
  value: unknown,
  authority: "server" | "client",
): AgentIncidentExportedFailureCode | undefined {
  if (!isThinAgentFailureCode(value)) return undefined;
  if (isAgentIncidentExportedFailureCode(value)) return value;
  return authority === "client"
    ? "unknown_client_failure"
    : "unknown_server_failure";
}

export function deriveAgentIncidentTerminalEvidence(
  authority: AgentIncidentFailureAuthority,
  terminalValidation: AgentIncidentTerminalValidation,
): AgentIncidentTerminalEvidence {
  if (authority === "server" && terminalValidation === "validated") {
    return "server_protocol_validated";
  }
  return authority === "client" ? "client_observed" : "unvalidated";
}

export function agentIncidentHttpStatusClass(
  status: number | undefined,
): AgentIncidentHttpStatusClass {
  if (!Number.isInteger(status) || status === undefined || status < 100 || status > 599) {
    return "not_recorded";
  }
  return `${Math.floor(status / 100)}xx` as AgentIncidentHttpStatusClass;
}

export function buildAgentIncidentGroupingFingerprint(input: Readonly<{
  failureAuthority: AgentIncidentFailureAuthority;
  failureStage?: AgentIncidentFailureStage;
  failureMechanism?: AgentIncidentFailureMechanism;
  failureCode?: AgentIncidentExportedFailureCode;
  httpStatus?: number;
  terminalSource?: Exclude<AgentIncidentTerminalSource, "not_recorded">;
}>): string {
  return [
    AGENT_INCIDENT_GROUPING_STRATEGY,
    `authority=${input.failureAuthority}`,
    `stage=${input.failureStage ?? "not_recorded"}`,
    `mechanism=${input.failureMechanism ?? "not_recorded"}`,
    `failure=${input.failureCode ?? "not_recorded"}`,
    `status=${agentIncidentHttpStatusClass(input.httpStatus)}`,
    `terminal=${input.terminalSource ?? "not_recorded"}`,
  ].join("|");
}

export const AGENT_INCIDENT_CAPTURE_FAILURE_CODES = Object.freeze([
  "clock_unavailable",
  "environment_unavailable",
  "report_size_reduction",
  "rendering_snapshot_invalid",
  "resource_sample_invalid",
  "resource_sample_unavailable",
  "run_state_invalid",
  "snapshot_summary_unavailable",
  "terminal_context_unavailable",
  "tool_count_inconsistent",
  "tool_identity_conflict",
  "tool_summary_limit",
  "transport_segment_invalid",
] as const);

export const AGENT_INCIDENT_MISSING_FIELD_CODES = Object.freeze([
  "assistant_text_character_count",
  "assistant_text_complete_part_count",
  "assistant_text_part_count",
  "assistant_text_streaming_part_count",
  "assistant_output_present_before_failure",
  "assistant_output_retained_in_failed_projection",
  "chat_view_state",
  "duration_ms",
  "environment_host_type",
  "environment_loaded_bundle_sha256",
  "environment_obsidian_version",
  "environment_os_family",
  "environment_plugin_build_id",
  "environment_plugin_version",
  "failure_authority",
  "failure_code",
  "failure_mechanism",
  "failure_stage",
  "host_process_state",
  "reasoning_character_count",
  "reasoning_complete_part_count",
  "reasoning_part_count",
  "reasoning_streaming_part_count",
  "rendering",
  "rendering_after_terminal_commit",
  "rendering_before_terminal_publish",
  "failure_surface_dom_commit",
  "failure_surface_paint_opportunity",
  "resource_samples",
  "run_state",
  "run_started",
  "server_incident_id",
  "server_run_id",
  "terminal_validation",
  "terminal_transport_segment",
  "tool_execution_ordinal",
  "transport_segments",
] as const);

export const AGENT_INCIDENT_TRANSPORT_SEGMENT_CLOSE_REASONS = Object.freeze([
  "clean_eof",
  "aborted",
  "superseded",
  "request_failed",
  "response_rejected",
  "read_failed",
  "decode_failed",
  "invalid_event",
  "oversized_event",
  "delivery_failed",
  "stream_failed",
] as const);

export const AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES = Object.freeze([
  "prompt_text",
  "assistant_text",
  "reasoning_text",
  "vault_names",
  "paths_and_filenames",
  "file_contents",
  "tool_arguments_and_results",
  "tool_call_ids",
  "search_queries",
  "urls",
  "provider_and_model_names",
  "license_and_account_data",
  "tokens_and_headers",
  "raw_errors_and_stacks",
  "hostnames_usernames_and_device_ids",
  "conversation_and_request_ids",
] as const);
