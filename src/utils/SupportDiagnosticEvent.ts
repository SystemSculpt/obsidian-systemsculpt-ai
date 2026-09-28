import {
  isThinAgentCommandKind,
  type ThinAgentCommandKind,
} from "../services/managed/ThinAgentV1Contract";
import { isFirstPartyToolName } from "../tools/toolNames";
import {
  boundedThinAgentIdentifier,
  boundedThinAgentTiming,
  isAgentLifecycleCode,
  isAgentLifecyclePhase,
  isCreditsRefreshReason,
  isHistorySyncKind,
  isToolDiagnosticFailureClass,
  isToolDiagnosticOutcome,
  boundedToolDiagnosticItemCount,
  isThinAgentClientInstanceId,
  isThinAgentConversationId,
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentLatencyTraceId,
  isThinAgentServerRunId,
  type AgentLifecyclePhase,
  type CreditsRefreshReason,
  type HistorySyncKind,
  type ToolDiagnosticFailureClass,
  type ToolDiagnosticOutcome,
} from "./ThinAgentLifecycleSchema";

export type SupportDiagnosticEvent = Readonly<{
  timestamp: string;
  severity: "info" | "error";
  code: string;
  phase: AgentLifecyclePhase;
  origin?: string;
  cause?: string;
  sequence?: number;
  conversation_id?: string;
  request_id?: string;
  client_instance_id?: string;
  plugin_build_id?: string;
  run_id?: string;
  server_run_id?: string;
  tool_name?: string;
  status?: number;
  retryable?: boolean;
  incident_id?: string;
  failure_code?: string;
  latency_trace_id?: string;
  command_kind?: ThinAgentCommandKind;
  command_segment_ordinal?: number;
  tool_execution_ordinal?: number;
  tool_outcome?: ToolDiagnosticOutcome;
  tool_failure_class?: ToolDiagnosticFailureClass;
  tool_item_count?: number;
  tool_completed_item_count?: number;
  tool_failed_item_count?: number;
  history_sync_kind?: HistorySyncKind;
  history_sync_ordinal?: number;
  response_delivery_mode?: "fetch_stream" | "request_url_buffered";
  client_monotonic_offset_ms?: number;
  client_clock_domain?: "client_turn_monotonic";
  server_timing_app_ms?: number;
  server_timing_auth_ms?: number;
  server_timing_clock_domain?: "server_response_headers_monotonic_duration";
  credits_refresh_reason?: CreditsRefreshReason;
  credits_refresh_sequence?: number;
  credits_refresh_transport?: "fetch" | "request_url";
  credits_refresh_elapsed_ms?: number;
  credits_refresh_clock_domain?: "client_refresh_monotonic_duration";
  credits_refresh_server_auth_ms?: number;
  credits_refresh_server_rate_limit_ms?: number;
  credits_refresh_server_balance_store_ms?: number;
  credits_refresh_server_total_ms?: number;
  credits_refresh_server_timing_clock_domain?:
    "server_response_headers_monotonic_duration";
}>;

type Scalar = string | number | boolean;
type LifecycleField = readonly [
  metadata: string,
  support: keyof SupportDiagnosticEvent | null,
  normalize: (value: unknown) => Scalar | undefined,
  localOnly?: true,
];
const accepted = <T extends Scalar>(guard: (value: unknown) => value is T) =>
  (value: unknown): T | undefined => guard(value) ? value : undefined;
const identifier = (value: unknown) => boundedThinAgentIdentifier(value, 160);
const positiveInteger = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
const boundedOrdinal = (maximum: number) => (value: unknown): number | undefined => {
  const ordinal = positiveInteger(value);
  return ordinal !== undefined && ordinal <= maximum ? ordinal : undefined;
};

// This closed inventory owns accepted scalars, exported names, and persistence
// privacy. Callers never enumerate input objects or supply projection callbacks.
const LIFECYCLE_FIELDS: readonly LifecycleField[] = [
  ["sequence", "sequence", positiveInteger],
  ["timestamp", null, value => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined],
  ["conversationId", "conversation_id", accepted(isThinAgentConversationId), true],
  ["requestId", "request_id", identifier, true],
  ["clientInstanceId", "client_instance_id", accepted(isThinAgentClientInstanceId), true],
  ["pluginBuildId", "plugin_build_id", identifier],
  ["runId", "run_id", identifier],
  ["serverRunId", "server_run_id", accepted(isThinAgentServerRunId)],
  ["toolName", "tool_name", accepted(isFirstPartyToolName)],
  ["toolCallId", null, identifier, true],
  ["status", "status", value => Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? value as number : undefined],
  ["retryable", "retryable", value => typeof value === "boolean" ? value : undefined],
  ["incidentId", "incident_id", accepted(isThinAgentIncidentId)],
  ["failureCode", "failure_code", accepted(isThinAgentFailureCode)],
  ["latencyTraceId", "latency_trace_id", accepted(isThinAgentLatencyTraceId)],
  ["commandKind", "command_kind", accepted(isThinAgentCommandKind)],
  ["commandSegmentOrdinal", "command_segment_ordinal", positiveInteger],
  ["toolExecutionOrdinal", "tool_execution_ordinal", boundedOrdinal(512)],
  ["toolOutcome", "tool_outcome", accepted(isToolDiagnosticOutcome)],
  ["toolFailureClass", "tool_failure_class", accepted(isToolDiagnosticFailureClass)],
  ["toolItemCount", "tool_item_count", boundedToolDiagnosticItemCount],
  ["toolCompletedItemCount", "tool_completed_item_count", boundedToolDiagnosticItemCount],
  ["toolFailedItemCount", "tool_failed_item_count", boundedToolDiagnosticItemCount],
  ["historySyncKind", "history_sync_kind", accepted(isHistorySyncKind)],
  ["historySyncOrdinal", "history_sync_ordinal", boundedOrdinal(2048)],
  ["responseDeliveryMode", "response_delivery_mode", value => value === "fetch_stream" || value === "request_url_buffered" ? value : undefined],
  ["clientMonotonicOffsetMs", "client_monotonic_offset_ms", boundedThinAgentTiming],
  ["serverTimingAppMs", "server_timing_app_ms", boundedThinAgentTiming],
  ["serverTimingAuthMs", "server_timing_auth_ms", boundedThinAgentTiming],
  ["creditsRefreshReason", "credits_refresh_reason", accepted(isCreditsRefreshReason)],
  ["creditsRefreshSequence", "credits_refresh_sequence", positiveInteger],
  ["creditsRefreshTransport", "credits_refresh_transport", value => value === "fetch" || value === "request_url" ? value : undefined],
  ["creditsRefreshElapsedMs", "credits_refresh_elapsed_ms", boundedThinAgentTiming],
  ["creditsRefreshServerAuthMs", "credits_refresh_server_auth_ms", boundedThinAgentTiming],
  ["creditsRefreshServerRateLimitMs", "credits_refresh_server_rate_limit_ms", boundedThinAgentTiming],
  ["creditsRefreshServerBalanceStoreMs", "credits_refresh_server_balance_store_ms", boundedThinAgentTiming],
  ["creditsRefreshServerTotalMs", "credits_refresh_server_total_ms", boundedThinAgentTiming],
];
const CLOCK_DOMAINS = [
  ["clientClockDomain", "client_clock_domain", "client_turn_monotonic", ["clientMonotonicOffsetMs"]],
  ["serverTimingClockDomain", "server_timing_clock_domain", "server_response_headers_monotonic_duration", ["serverTimingAppMs", "serverTimingAuthMs"]],
  ["creditsRefreshClockDomain", "credits_refresh_clock_domain", "client_refresh_monotonic_duration", ["creditsRefreshElapsedMs"]],
  ["creditsRefreshServerTimingClockDomain", "credits_refresh_server_timing_clock_domain", "server_response_headers_monotonic_duration", ["creditsRefreshServerAuthMs", "creditsRefreshServerRateLimitMs", "creditsRefreshServerBalanceStoreMs", "creditsRefreshServerTotalMs"]],
] as const;

type LifecycleProjection = Readonly<{
  persisted: Record<string, unknown>;
  fields: Omit<SupportDiagnosticEvent, "timestamp" | "severity">;
}>;

/** Read every allowlisted input once, then derive disk and in-memory views. */
export function projectLifecycleMetadata(input: Record<string, unknown>): LifecycleProjection | null {
  try {
    const code = input.code;
    const phase = input.phase;
    if (!isAgentLifecycleCode(code) || !isAgentLifecyclePhase(phase)) return null;
    const persisted: Record<string, unknown> = { code, phase };
    const fields: Record<string, Scalar> = { code, phase };
    for (const [metadataKey, supportKey, normalize, localOnly] of LIFECYCLE_FIELDS) {
      const value = normalize(input[metadataKey]);
      if (value === undefined) continue;
      if (!localOnly) persisted[metadataKey] = value;
      if (supportKey) fields[supportKey] = value;
    }
    for (const [metadataKey, supportKey, domain, timingKeys] of CLOCK_DOMAINS) {
      if (!timingKeys.some(key => persisted[key] !== undefined)) continue;
      persisted[metadataKey] = domain;
      fields[supportKey] = domain;
    }
    return { persisted, fields: fields as LifecycleProjection["fields"] };
  } catch {
    // Hostile getters and revoked proxies cannot affect the product lifecycle.
    return null;
  }
}

/** Snapshot public events without reading arbitrary properties or getters twice. */
export function snapshotSupportDiagnosticEvent(event: SupportDiagnosticEvent): SupportDiagnosticEvent | null {
  try {
    const snapshot: Record<string, unknown> = {};
    for (const key of ["timestamp", "severity", "code", "phase", "origin", "cause"] as const) {
      snapshot[key] = event[key];
    }
    for (const [, supportKey] of LIFECYCLE_FIELDS) {
      if (supportKey) snapshot[supportKey] = event[supportKey];
    }
    for (const [, supportKey] of CLOCK_DOMAINS) snapshot[supportKey] = event[supportKey];
    return Object.freeze(snapshot) as SupportDiagnosticEvent;
  } catch {
    return null;
  }
}
