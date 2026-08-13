import { isThinAgentCommandKind, type ThinAgentCommandKind } from "../../services/managed/ThinAgentV1Contract";
import { isFirstPartyToolName, type FirstPartyToolName } from "../../tools/toolNames";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import {
  boundedThinAgentTiming,
  boundedToolDiagnosticItemCount,
  isAgentLifecycleCode,
  isAgentLifecyclePhase,
  isCreditsRefreshReason,
  isHistorySyncKind,
  isThinAgentConversationId,
  isThinAgentIncidentId,
  isThinAgentLatencyTraceId,
  isThinAgentRequestId,
  isThinAgentServerRunId,
  isToolDiagnosticFailureClass,
  isToolDiagnosticOutcome,
  THIN_AGENT_LIFECYCLE_CODES,
  THIN_AGENT_LIFECYCLE_PHASES,
  type AgentLifecycleCode,
  type AgentLifecyclePhase,
  type CreditsRefreshReason,
  type HistorySyncKind,
  type ToolDiagnosticFailureClass,
  type ToolDiagnosticOutcome,
} from "../../utils/ThinAgentLifecycleSchema";
import { canonicalJsonStringify, utf8ByteLength } from "./AgentIncidentCanonicalJson";
import {
  AGENT_INCIDENT_CAPTURE_FAILURE_CODES,
  AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES,
  AGENT_INCIDENT_GROUPING_STRATEGY,
  AGENT_INCIDENT_MAX_COUNT,
  AGENT_INCIDENT_MAX_EVENTS,
  AGENT_INCIDENT_MAX_RENDER_COUNT,
  AGENT_INCIDENT_MAX_RENDER_DURATION_MS,
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_MAX_RESOURCE_SAMPLES,
  AGENT_INCIDENT_MAX_TOOL_ORDINAL,
  AGENT_INCIDENT_MAX_TOOLS,
  AGENT_INCIDENT_MAX_TRANSPORT_BYTES,
  AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT,
  AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
  AGENT_INCIDENT_MISSING_FIELD_CODES,
  AGENT_INCIDENT_SCHEMA_VERSION,
  AGENT_INCIDENT_TRANSPORT_SEGMENT_CLOSE_REASONS,
  buildAgentIncidentGroupingFingerprint,
  deriveAgentIncidentTerminalEvidence,
  isAgentIncidentFailureMechanism,
  isAgentIncidentFailureStage,
  normalizeAgentIncidentFailureCode,
  type AgentIncidentExportedFailureCode,
  type AgentIncidentFailureAuthority,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
  type AgentIncidentReportFailureMechanism,
  type AgentIncidentReportFailureStage,
  type AgentIncidentTerminalEvidence,
  type AgentIncidentTerminalValidation,
} from "./AgentIncidentSchema";

export {
  AGENT_INCIDENT_MAX_EVENTS,
  AGENT_INCIDENT_MAX_RENDER_COUNT,
  AGENT_INCIDENT_MAX_RENDER_DURATION_MS,
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_MAX_RESOURCE_SAMPLES,
  AGENT_INCIDENT_MAX_TOOLS,
  AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
  AGENT_INCIDENT_MISSING_FIELD_CODES,
  AGENT_INCIDENT_SCHEMA_VERSION,
} from "./AgentIncidentSchema";

export const AGENT_INCIDENT_MAX_ACTIVE_RUNS = 32;

const AGENT_INCIDENT_TIMELINE_PREFIX_EVENTS = 16;
const AGENT_INCIDENT_TOOL_PREFIX_SUMMARIES = 16;
const AGENT_INCIDENT_TRANSPORT_PREFIX_SEGMENTS = 16;
const AGENT_INCIDENT_TIMELINE_BYTE_BUDGET = 176 * 1_024;
const AGENT_INCIDENT_MAX_FROZEN_REPORTS = 20;
const AGENT_INCIDENT_MAX_SETTLED_CORRELATIONS = 64;
const AGENT_INCIDENT_MAX_CONTEXT_LIST_ITEMS = 64;
const REPORT_ID = /^report_[a-f0-9]{32}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const PLUGIN_BUILD_ID = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/u;
const RFC3339_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CAPTURE_FAILURE_CODES = AGENT_INCIDENT_CAPTURE_FAILURE_CODES;
const TRANSPORT_SEGMENT_CLOSE_REASONS = AGENT_INCIDENT_TRANSPORT_SEGMENT_CLOSE_REASONS;
const EXCLUDED_DATA_CATEGORIES = AGENT_INCIDENT_EXCLUDED_DATA_CATEGORIES;

const TRANSPORT_SEGMENT_CLOSE_REASON_SET = new Set<string>(
  TRANSPORT_SEGMENT_CLOSE_REASONS,
);

const CAPTURE_FAILURE_CODE_SET = new Set<string>(CAPTURE_FAILURE_CODES);

export type AgentIncidentCaptureFailureCode = typeof CAPTURE_FAILURE_CODES[number];
export type AgentIncidentMissingFieldCode = typeof AGENT_INCIDENT_MISSING_FIELD_CODES[number];
export type AgentIncidentTerminalReceipt =
  | "client_received_server_terminal"
  | "client_emitted_local_failure"
  | "unknown";
export type ThinAgentLifecycleEvent = SupportDiagnosticEvent;

export type AgentIncidentCorrelationInput = Readonly<{
  conversationId: string;
  requestId: string;
}>;

export type AgentIncidentEnvironmentInput = Readonly<{
  pluginVersion?: string;
  pluginBuildId?: string;
  loadedBundleSha256?: string;
  obsidianVersion?: string;
  hostType?: "desktop" | "mobile" | "unknown";
  osFamily?: "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
}>;

export type AgentIncidentResourceSampleInput = Readonly<{
  captured_at: string;
  heap_used_mb?: number;
  heap_limit_mb?: number;
  rss_mb?: number;
  cpu_percent?: number;
  event_loop_lag_ms?: number;
  freeze_delta_ms?: number;
}>;

export type AgentIncidentTransportSegmentCloseReason =
  typeof TRANSPORT_SEGMENT_CLOSE_REASONS[number];

export type AgentIncidentTransportSegmentInput = Readonly<{
  commandKind: ThinAgentCommandKind;
  commandSegmentOrdinal: number;
  serverLatencyCorrelationId?: string;
  toolExecutionOrdinal?: number;
  closeReason: AgentIncidentTransportSegmentCloseReason;
  durationMs: number;
  receivedBytes: number;
  nonEmptyRawChunkCount: number;
  sseEventCount: number;
  acceptedFrameCount: number;
  deliveredFrameCount: number;
  metricsTruncated: boolean;
}>;

export type AgentIncidentRunStateInput = Readonly<{
  terminalSource: "session_terminal" | "message_reconstruction" | "local_failure";
  runOrigin: "submitted" | "recovered";
  runPhase: "submitted" | "thinking" | "working" | "waiting" | "retrying" | "settling" | "complete";
  connectionState: "idle" | "connecting" | "open" | "closed";
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
  elapsedMsTruncated: boolean;
}>;

export type AgentIncidentRenderingInput = Readonly<{
  renderState: "idle" | "frame_pending" | "queued" | "rendering" | "rendering_with_pending";
  renderPassCount: number;
  pendingRenderCount: number;
  lastRenderDurationMs: number;
  maxRenderDurationMs: number;
  firstDomCommitObserved: boolean;
  firstPaintOpportunityObserved: boolean;
  registeredRowCount: number;
  renderer: Readonly<{
    renderPassCount: number;
    pendingRenderPassCount: number;
    lastRenderDurationMs: number;
    maxRenderDurationMs: number;
    historicalRowCount: number;
    historicalPartCount: number;
    activePartCount: number;
    disclosureCount: number;
    openDisclosureCount: number;
    activityDisclosureCount: number;
    reasoningDisclosureCount: number;
    toolDisclosureCount: number;
    overflowDisclosureCount: number;
    pendingHydrationCount: number;
    renderingEnabled: boolean;
  }>;
  scroller: Readonly<{
    mode: "end" | "manual";
    distanceFromEndBucket: "at_end" | "near_end" | "within_viewport" | "far_from_end" | "unknown";
    registeredRowCount: number;
    pendingLayoutMutationCount: number;
    layoutMutationPending: boolean;
    geometryUpdatePending: boolean;
    programmaticScrollPending: boolean;
    submittedPromptAnchorActive: boolean;
    destroyed: boolean;
  }>;
}>;

export type AgentIncidentCaptureContext = Readonly<{
  failureAuthority?: AgentIncidentFailureAuthority;
  failureStage?: AgentIncidentFailureStage;
  failureMechanism?: AgentIncidentFailureMechanism;
  terminalValidation?: Exclude<AgentIncidentTerminalValidation, "not_recorded">;
  hostProcessState?: "responsive" | "unknown";
  chatViewState?: "mounted" | "detached" | "unknown";
  assistantTextPartCount?: number;
  assistantTextStreamingPartCount?: number;
  assistantTextCompletePartCount?: number;
  assistantTextCharacterCount?: number;
  reasoningPartCount?: number;
  reasoningStreamingPartCount?: number;
  reasoningCompletePartCount?: number;
  reasoningCharacterCount?: number;
  assistantOutputPresentBeforeFailure?: boolean;
  assistantOutputRetainedInFailedProjection?: boolean;
  snapshotPartCount?: number;
  elapsedMs?: number;
  collectionFailures?: readonly AgentIncidentCaptureFailureCode[];
  environment?: AgentIncidentEnvironmentInput;
  runState?: AgentIncidentRunStateInput;
  rendering?: AgentIncidentRenderingEvidenceInput;
}>;

export type AgentIncidentRenderingEvidenceInput = Readonly<{
  beforeTerminalPublish?: AgentIncidentRenderingInput;
  afterTerminalCommit?: AgentIncidentRenderingInput;
  failureSurfaceDomCommitted: boolean;
  failureSurfacePaintOpportunityObserved: boolean;
}>;

export type AgentIncidentTimelineEvent = Readonly<{
  ordinal: number;
  timestamp: string;
  source_sequence?: number;
  code: AgentLifecycleCode;
  phase: AgentLifecyclePhase;
  run_id?: string;
  server_run_id?: string;
  status?: number;
  retryable?: boolean;
  incident_id?: string;
  failure_code?: AgentIncidentExportedFailureCode;
  server_latency_correlation_id?: string;
  command_kind?: ThinAgentCommandKind;
  command_segment_ordinal?: number;
  tool_execution_ordinal?: number;
  tool_name?: FirstPartyToolName;
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
  credits_refresh_server_timing_clock_domain?: "server_response_headers_monotonic_duration";
}>;

export type AgentIncidentToolSummary = Readonly<{
  ordinal: number;
  tool_name?: FirstPartyToolName;
  started_at?: string;
  completed_at?: string;
  outcome?: ToolDiagnosticOutcome;
  failure_class?: ToolDiagnosticFailureClass;
  requested_item_count?: number;
  completed_item_count?: number;
  failed_item_count?: number;
  result_delivery?: "succeeded" | "failed" | "not_observed";
  result_acknowledgement?: "succeeded" | "failed" | "not_observed";
  terminal_dom_committed: boolean;
  terminal_paint_opportunity_observed: boolean;
  lifecycle_event_count: number;
}>;

export type AgentIncidentResourceSample = Readonly<{
  ordinal: number;
  captured_at: string;
  heap_used_mb?: number;
  heap_limit_mb?: number;
  rss_mb?: number;
  cpu_percent?: number;
  event_loop_lag_ms?: number;
  freeze_delta_ms?: number;
}>;

export type AgentIncidentTransportSegment = Readonly<{
  command_kind: ThinAgentCommandKind;
  segment_ordinal: number;
  server_latency_correlation_id?: string;
  tool_execution_ordinal?: number;
  close_reason: AgentIncidentTransportSegmentCloseReason;
  duration_ms: number;
  received_bytes: number;
  raw_chunk_count: number;
  sse_event_count: number;
  accepted_frame_count: number;
  delivered_frame_count: number;
  metrics_truncated: boolean;
}>;

export type AgentIncidentRunState = Readonly<{
  terminal_source: "session_terminal" | "message_reconstruction" | "local_failure";
  run_origin: "submitted" | "recovered";
  run_phase: "submitted" | "thinking" | "working" | "waiting" | "retrying" | "settling" | "complete";
  connection_state: "idle" | "connecting" | "open" | "closed";
  executing_local_tool_count: number;
  pending_tool_delivery_count: number;
  pending_approval_delivery_count: number;
  pending_tool_task_count: number;
  server_queued: boolean;
  run_stalled: boolean;
  awaiting_client_work: boolean;
  pending_cancel: boolean;
  pending_regenerate: boolean;
  counts_truncated: boolean;
  elapsed_ms_truncated: boolean;
}>;

export type AgentIncidentRenderingSnapshot = Readonly<{
  render_state: "idle" | "frame_pending" | "queued" | "rendering" | "rendering_with_pending";
  render_pass_count: number;
  pending_render_count: number;
  last_render_duration_ms: number;
  max_render_duration_ms: number;
  first_dom_commit_observed: boolean;
  first_paint_opportunity_observed: boolean;
  registered_row_count: number;
  renderer: Readonly<{
    render_pass_count: number;
    pending_render_pass_count: number;
    last_render_duration_ms: number;
    max_render_duration_ms: number;
    historical_row_count: number;
    historical_part_count: number;
    active_part_count: number;
    disclosure_count: number;
    open_disclosure_count: number;
    activity_disclosure_count: number;
    reasoning_disclosure_count: number;
    tool_disclosure_count: number;
    overflow_disclosure_count: number;
    pending_hydration_count: number;
    rendering_enabled: boolean;
  }>;
  scroller: Readonly<{
    mode: "end" | "manual";
    distance_from_end_bucket: "at_end" | "near_end" | "within_viewport" | "far_from_end" | "unknown";
    registered_row_count: number;
    pending_layout_mutation_count: number;
    layout_mutation_pending: boolean;
    geometry_update_pending: boolean;
    programmatic_scroll_pending: boolean;
    submitted_prompt_anchor_active: boolean;
    destroyed: boolean;
  }>;
}>;

export type AgentIncidentRenderingEvidence = Readonly<{
  before_terminal_publish?: AgentIncidentRenderingSnapshot;
  after_terminal_commit?: AgentIncidentRenderingSnapshot;
  failure_surface_dom_committed: boolean;
  failure_surface_paint_opportunity_observed: boolean;
}>;

export type AgentIncidentReport = Readonly<{
  schema_version: typeof AGENT_INCIDENT_SCHEMA_VERSION;
  report_id: string;
  created_at: string;
  incident: Readonly<{
    classification: "operation_failure";
    impact: "run_failed";
    outcome: "failed";
    severity_text: "ERROR";
    severity_number: 17;
    failure_authority: AgentIncidentFailureAuthority;
    origin: "agent_terminal" | "agent_local_failure";
    terminal_evidence: AgentIncidentTerminalEvidence;
    artifact_integrity: "unauthenticated_client_record";
    evidence_scope: "client_observation_only";
    causal_assessment: "not_established";
    observation_source: "server_protocol_terminal" | "server_http_response" | "client_runtime";
    failure_stage: AgentIncidentReportFailureStage;
    failure_mechanism: AgentIncidentReportFailureMechanism;
    incident_id?: string;
    failure_code?: AgentIncidentExportedFailureCode;
    retryable?: boolean;
    http_status?: number;
  }>;
  correlation: Readonly<{
    run_id?: string;
    server_run_id?: string;
    server_latency_correlation_id?: string;
  }>;
  grouping: Readonly<{
    strategy: typeof AGENT_INCIDENT_GROUPING_STRATEGY;
    fingerprint: string;
  }>;
  environment: Readonly<{
    plugin_version?: string;
    plugin_build_id?: string;
    loaded_bundle_sha256?: string;
    obsidian_version?: string;
    host_type?: "desktop" | "mobile" | "unknown";
    os_family?: "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
  }>;
  run_summary: Readonly<{
    started_at?: string;
    failed_at: string;
    duration_ms?: number;
    duration_clock_domain?: "client_turn_monotonic" | "client_wall_clock_observed";
    terminal_receipt: AgentIncidentTerminalReceipt;
    terminal_validation: "validated" | "unvalidated" | "validation_failed" | "not_recorded";
    host_process_state: "responsive" | "unknown";
    chat_view_state: "mounted" | "detached" | "unknown";
    observed_lifecycle_event_count: number;
    retained_timeline_event_count: number;
    snapshot_part_count?: number;
    partial_output: Readonly<{
      assistant_text_part_count?: number;
      assistant_text_streaming_part_count?: number;
      assistant_text_complete_part_count?: number;
      assistant_text_character_count?: number;
      reasoning_part_count?: number;
      reasoning_streaming_part_count?: number;
      reasoning_complete_part_count?: number;
      reasoning_character_count?: number;
      assistant_output_present_before_failure?: boolean;
      assistant_output_retained_in_failed_projection?: boolean;
    }>;
    lifecycle_code_counts: readonly Readonly<{ code: AgentLifecycleCode; count: number }>[];
    lifecycle_phase_counts: readonly Readonly<{ phase: AgentLifecyclePhase; count: number }>[];
  }>;
  run_state?: AgentIncidentRunState;
  tools: readonly AgentIncidentToolSummary[];
  timeline: readonly AgentIncidentTimelineEvent[];
  transport_segments: readonly AgentIncidentTransportSegment[];
  rendering?: AgentIncidentRenderingEvidence;
  resource_samples: readonly AgentIncidentResourceSample[];
  capture_quality: Readonly<{
    complete: boolean;
    truncated: boolean;
    limits: Readonly<{
      maximum_events: number;
      maximum_report_bytes: number;
      maximum_resource_samples: number;
      maximum_tools: number;
      maximum_transport_segments: number;
      maximum_render_count: number;
      maximum_render_duration_ms: number;
    }>;
    report_bytes: number;
    observed_event_count: number;
    retained_event_count: number;
    dropped_event_count: number;
    dropped_events: Readonly<{
      event_limit: number;
      byte_limit: number;
      after_terminal: number;
    }>;
    dropped_resource_sample_count: number;
    dropped_tool_summary_count: number;
    dropped_transport_segment_count: number;
    missing_fields: readonly AgentIncidentMissingFieldCode[];
    collection_failures: readonly Readonly<{
      code: AgentIncidentCaptureFailureCode;
      count: number;
    }>[];
  }>;
  privacy: Readonly<{
    policy: "strict_allowlist_content_free";
    policy_version: "systemsculpt.incident-privacy/1";
    capture_implementation_version: "agent-incident-recorder/1";
    storage_target: "vault_local";
    host_sync: "may_sync_with_vault";
    automatic_upload: false;
    excluded_data_categories: readonly string[];
  }>;
}>;

type RecorderOptions = Readonly<{
  now?: () => number;
  createReportId?: () => string;
  maximumFrozenReports?: number;
}>;

type SafeCorrelation = Readonly<{
  conversationId: string;
  requestId: string;
}>;

type ProjectedLifecycleEvent = Readonly<{
  correlation: SafeCorrelation;
  pluginBuildId?: string;
  timeline: Omit<AgentIncidentTimelineEvent, "ordinal">;
}>;

type MutableEnvironment = {
  plugin_version?: string;
  plugin_build_id?: string;
  loaded_bundle_sha256?: string;
  obsidian_version?: string;
  host_type?: "desktop" | "mobile" | "unknown";
  os_family?: "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
};

type MutableToolSummary = {
  ordinal: number;
  tool_name?: FirstPartyToolName;
  started_at?: string;
  completed_at?: string;
  outcome?: ToolDiagnosticOutcome;
  failure_class?: ToolDiagnosticFailureClass;
  requested_item_count?: number;
  completed_item_count?: number;
  failed_item_count?: number;
  result_delivery?: "succeeded" | "failed" | "not_observed";
  result_acknowledgement?: "succeeded" | "failed" | "not_observed";
  terminal_dom_committed: boolean;
  terminal_paint_opportunity_observed: boolean;
  lifecycle_event_count: number;
  item_counts_invalid: boolean;
};

type DroppedEvents = {
  event_limit: number;
  byte_limit: number;
  after_terminal: number;
};

type StableIdentifierField = "runId" | "serverRunId";

type ActiveIncident = {
  readonly correlation: SafeCorrelation;
  readonly timeline: AgentIncidentTimelineEvent[];
  timelineBytes: number;
  nextTimelineOrdinal: number;
  observedEventCount: number;
  readonly droppedEvents: DroppedEvents;
  droppedResourceSampleCount: number;
  droppedToolSummaryCount: number;
  droppedTransportSegmentCount: number;
  readonly environment: MutableEnvironment;
  readonly resources: AgentIncidentResourceSample[];
  nextResourceOrdinal: number;
  readonly transportSegments: AgentIncidentTransportSegment[];
  readonly tools: Map<number, MutableToolSummary>;
  readonly droppedToolOrdinals: Set<number>;
  readonly codeCounts: Map<AgentLifecycleCode, number>;
  readonly phaseCounts: Map<AgentLifecyclePhase, number>;
  readonly collectionFailures: Map<AgentIncidentCaptureFailureCode, number>;
  readonly explicitMissingFields: Set<AgentIncidentMissingFieldCode>;
  readonly conflictedIdentifiers: Set<StableIdentifierField>;
  readonly serverLatencyCorrelationIdsBySegment: Map<number, string>;
  readonly conflictedServerLatencyCorrelationSegments: Set<number>;
  startedAt?: string;
  terminal?: AgentIncidentTimelineEvent;
  reservedReportId?: string;
  runId?: string;
  serverRunId?: string;
  terminalValidation?: Exclude<AgentIncidentTerminalValidation, "not_recorded">;
  failureAuthority?: AgentIncidentFailureAuthority;
  failureStage?: AgentIncidentFailureStage;
  failureMechanism?: AgentIncidentFailureMechanism;
  hostProcessState?: "responsive" | "unknown";
  chatViewState?: "mounted" | "detached" | "unknown";
  assistantTextPartCount?: number;
  assistantTextStreamingPartCount?: number;
  assistantTextCompletePartCount?: number;
  assistantTextCharacterCount?: number;
  reasoningPartCount?: number;
  reasoningStreamingPartCount?: number;
  reasoningCompletePartCount?: number;
  reasoningCharacterCount?: number;
  assistantOutputPresentBeforeFailure?: boolean;
  assistantOutputRetainedInFailedProjection?: boolean;
  snapshotPartCount?: number;
  elapsedMs?: number;
  runState?: AgentIncidentRunState;
  rendering?: AgentIncidentRenderingEvidence;
};

/**
 * Records one content-free diagnostic chronology per conversation request.
 * Caller objects never enter recorder state. Every retained value is rebuilt
 * from a bounded scalar allowlist before the failed report is frozen.
 */
export class AgentIncidentRecorder {
  private readonly active = new Map<string, ActiveIncident>();
  private readonly frozenByReportId = new Map<string, AgentIncidentReport>();
  private readonly frozenByIncidentId = new Map<string, AgentIncidentReport>();
  private readonly frozenByCorrelation = new Map<string, AgentIncidentReport>();
  private readonly frozenCorrelationByReportId = new Map<string, string>();
  private readonly frozenOrder: string[] = [];
  private readonly settledNonFailure = new Set<string>();
  private readonly settledNonFailureOrder: string[] = [];
  private readonly now: () => number;
  private readonly createReportId: () => string;
  private readonly maximumFrozenReports: number;

  public constructor(options: RecorderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createReportId = options.createReportId ?? randomReportId;
    this.maximumFrozenReports = boundedFrozenReportLimit(options.maximumFrozenReports);
  }

  public record(event: ThinAgentLifecycleEvent): boolean {
    try {
      const projected = projectLifecycleEvent(event);
      if (!projected) return false;
      const key = correlationKey(projected.correlation);
      if (this.frozenByCorrelation.has(key) || this.settledNonFailure.has(key)) return false;
      const state = this.active.get(key) ?? this.createActive(projected.correlation);
      state.observedEventCount = addBoundedCount(state.observedEventCount, 1);
      if (state.terminal) {
        state.droppedEvents.after_terminal = addBoundedCount(state.droppedEvents.after_terminal, 1);
        return false;
      }

      state.nextTimelineOrdinal = addBoundedCount(state.nextTimelineOrdinal, 1);
      const timelineEvent = Object.freeze({
        ordinal: state.nextTimelineOrdinal,
        ...projected.timeline,
      });
      this.captureCorrelationFields(state, timelineEvent, projected.pluginBuildId);
      this.captureLifecycleSummary(state, timelineEvent);
      this.captureToolSummary(state, timelineEvent);
      this.appendTimeline(state, timelineEvent);
      if (timelineEvent.code === "run_finished_completed" || timelineEvent.code === "run_finished_cancelled") {
        this.active.delete(key);
        this.rememberNonFailureSettlement(key);
      } else if (timelineEvent.code === "run_finished_failed") {
        state.terminal = timelineEvent;
      }
      return true;
    } catch {
      return false;
    }
  }

  public attachEnvironment(
    correlation: AgentIncidentCorrelationInput,
    environment: AgentIncidentEnvironmentInput,
  ): boolean {
    try {
      const state = this.activeState(correlation);
      if (!state || state.terminal === undefined && state.observedEventCount === 0) return false;
      if (copyEnvironment(state.environment, environment)) return true;
      incrementFailure(state, "environment_unavailable");
      return false;
    } catch {
      return false;
    }
  }

  public attachResourceSamples(
    correlation: AgentIncidentCorrelationInput,
    samples: readonly AgentIncidentResourceSampleInput[],
  ): boolean {
    try {
      const state = this.activeState(correlation);
      if (!state || !Array.isArray(samples)) return false;
      const sampleCount = samples.length;
      const startIndex = Math.max(0, sampleCount - AGENT_INCIDENT_MAX_RESOURCE_SAMPLES);
      if (startIndex > 0) {
        state.nextResourceOrdinal = addBoundedCount(state.nextResourceOrdinal, startIndex);
        state.droppedResourceSampleCount = addBoundedCount(state.droppedResourceSampleCount, startIndex);
      }
      for (let index = startIndex; index < sampleCount; index += 1) {
        let sample: AgentIncidentResourceSampleInput;
        try {
          sample = samples[index];
        } catch {
          state.droppedResourceSampleCount = addBoundedCount(state.droppedResourceSampleCount, 1);
          incrementFailure(state, "resource_sample_invalid");
          continue;
        }
        state.nextResourceOrdinal = addBoundedCount(state.nextResourceOrdinal, 1);
        const projected = projectResourceSample(sample, state.nextResourceOrdinal);
        if (!projected) {
          state.droppedResourceSampleCount = addBoundedCount(state.droppedResourceSampleCount, 1);
          incrementFailure(state, "resource_sample_invalid");
          continue;
        }
        state.resources.push(Object.freeze(projected));
        while (state.resources.length > AGENT_INCIDENT_MAX_RESOURCE_SAMPLES) {
          state.resources.shift();
          state.droppedResourceSampleCount = addBoundedCount(state.droppedResourceSampleCount, 1);
        }
      }
      return true;
    } catch {
      const state = this.activeState(correlation);
      if (state) incrementFailure(state, "resource_sample_unavailable");
      return false;
    }
  }

  public attachTransportSegment(
    correlation: AgentIncidentCorrelationInput,
    input: AgentIncidentTransportSegmentInput,
  ): boolean {
    try {
      const state = this.activeState(correlation);
      if (!state) return false;
      const segment = projectTransportSegment(input);
      if (!segment) {
        incrementFailure(state, "transport_segment_invalid");
        return false;
      }
      setSegmentCorrelationIdentifier(
        state,
        segment.segment_ordinal,
        segment.server_latency_correlation_id,
      );
      state.transportSegments.push(Object.freeze(segment));
      while (state.transportSegments.length > AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS) {
        state.transportSegments.splice(AGENT_INCIDENT_TRANSPORT_PREFIX_SEGMENTS, 1);
        state.droppedTransportSegmentCount = addBoundedCount(
          state.droppedTransportSegmentCount,
          1,
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  public reserveReportId(correlation: AgentIncidentCorrelationInput): string | null {
    try {
      const safeCorrelation = sanitizeCorrelation(correlation);
      if (!safeCorrelation) return null;
      const key = correlationKey(safeCorrelation);
      const state = this.active.get(key);
      if (!state || this.frozenByCorrelation.has(key) || this.settledNonFailure.has(key)) return null;
      if (state.reservedReportId) return state.reservedReportId;
      const reportId = this.allocateReportId();
      state.reservedReportId = reportId;
      return reportId;
    } catch {
      return null;
    }
  }

  public finalize(
    correlation: AgentIncidentCorrelationInput,
    context: AgentIncidentCaptureContext = {},
  ): AgentIncidentReport | null {
    try {
      const safeCorrelation = sanitizeCorrelation(correlation);
      if (!safeCorrelation) return null;
      const key = correlationKey(safeCorrelation);
      const existing = this.frozenByCorrelation.get(key);
      if (existing) return existing;
      const state = this.active.get(key);
      if (!state?.terminal || state.terminal.code !== "run_finished_failed") return null;

      this.applyCaptureContext(state, context);
      const reportId = state.reservedReportId ?? this.allocateReportId();
      const createdAt = safeNowIso(this.now);
      if (!createdAt.usedProvidedClock) incrementFailure(state, "clock_unavailable");
      const report = this.buildBoundedReport(state, reportId, createdAt.iso);
      this.active.delete(key);
      this.rememberReport(key, report);
      return report;
    } catch {
      return null;
    }
  }

  public getByReportId(reportId: string): AgentIncidentReport | null {
    return typeof reportId === "string" && REPORT_ID.test(reportId)
      ? this.frozenByReportId.get(reportId) ?? null
      : null;
  }

  public getByIncidentId(incidentId: string): AgentIncidentReport | null {
    return isNonzeroIncidentId(incidentId)
      ? this.frozenByIncidentId.get(incidentId) ?? null
      : null;
  }

  public getReportByReportId(reportId: string): AgentIncidentReport | null {
    return this.getByReportId(reportId);
  }

  public getReportByIncidentId(incidentId: string): AgentIncidentReport | null {
    return this.getByIncidentId(incidentId);
  }

  private createActive(correlation: SafeCorrelation): ActiveIncident {
    while (this.active.size >= AGENT_INCIDENT_MAX_ACTIVE_RUNS) {
      const oldestKey = this.active.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.active.delete(oldestKey);
    }
    const state: ActiveIncident = {
      correlation,
      timeline: [],
      timelineBytes: 0,
      nextTimelineOrdinal: 0,
      observedEventCount: 0,
      droppedEvents: { event_limit: 0, byte_limit: 0, after_terminal: 0 },
      droppedResourceSampleCount: 0,
      droppedToolSummaryCount: 0,
      droppedTransportSegmentCount: 0,
      environment: {},
      resources: [],
      nextResourceOrdinal: 0,
      transportSegments: [],
      tools: new Map(),
      droppedToolOrdinals: new Set(),
      codeCounts: new Map(),
      phaseCounts: new Map(),
      collectionFailures: new Map(),
      explicitMissingFields: new Set(),
      conflictedIdentifiers: new Set(),
      serverLatencyCorrelationIdsBySegment: new Map(),
      conflictedServerLatencyCorrelationSegments: new Set(),
    };
    this.active.set(correlationKey(correlation), state);
    return state;
  }

  private activeState(correlation: AgentIncidentCorrelationInput): ActiveIncident | null {
    const safe = sanitizeCorrelation(correlation);
    return safe ? this.active.get(correlationKey(safe)) ?? null : null;
  }

  private captureCorrelationFields(
    state: ActiveIncident,
    event: AgentIncidentTimelineEvent,
    pluginBuildId: string | undefined,
  ): void {
    setStableIdentifier(state, "runId", event.run_id);
    setStableIdentifier(state, "serverRunId", event.server_run_id);
    setSegmentCorrelationIdentifier(
      state,
      event.command_segment_ordinal,
      event.server_latency_correlation_id,
    );
    if (pluginBuildId && !state.environment.plugin_build_id) {
      state.environment.plugin_build_id = pluginBuildId;
    }
  }

  private captureLifecycleSummary(state: ActiveIncident, event: AgentIncidentTimelineEvent): void {
    state.codeCounts.set(event.code, addBoundedCount(state.codeCounts.get(event.code) ?? 0, 1));
    state.phaseCounts.set(event.phase, addBoundedCount(state.phaseCounts.get(event.phase) ?? 0, 1));
    if (event.code === "run_started" && !state.startedAt) state.startedAt = event.timestamp;
  }

  private captureToolSummary(state: ActiveIncident, event: AgentIncidentTimelineEvent): void {
    if (!isToolLifecycleCode(event.code)) return;
    const ordinal = event.tool_execution_ordinal;
    if (ordinal === undefined) {
      state.explicitMissingFields.add("tool_execution_ordinal");
      return;
    }
    if (state.droppedToolOrdinals.has(ordinal)) return;
    let tool = state.tools.get(ordinal);
    if (!tool) {
      tool = {
        ordinal,
        terminal_dom_committed: false,
        terminal_paint_opportunity_observed: false,
        lifecycle_event_count: 0,
        item_counts_invalid: false,
      };
      state.tools.set(ordinal, tool);
      this.trimToolSummaries(state);
      if (!state.tools.has(ordinal)) return;
    }
    tool.lifecycle_event_count = addBoundedCount(tool.lifecycle_event_count, 1);
    if (event.tool_name) {
      if (tool.tool_name && tool.tool_name !== event.tool_name) {
        incrementFailure(state, "tool_identity_conflict");
      } else {
        tool.tool_name = event.tool_name;
      }
    }
    if (event.code === "local_tool_started" && !tool.started_at) tool.started_at = event.timestamp;
    if (event.code === "local_tool_completed_succeeded" || event.code === "local_tool_completed_failed") {
      tool.completed_at = event.timestamp;
    }
    if (event.tool_outcome) tool.outcome = event.tool_outcome;
    if (event.tool_failure_class) tool.failure_class = event.tool_failure_class;
    this.captureToolItemCounts(state, tool, event);
    if (event.code === "tool_result_sent_succeeded") tool.result_delivery = "succeeded";
    if (event.code === "tool_result_sent_failed" || event.code === "tool_result_command_stream_failed") tool.result_delivery = "failed";
    if (event.code === "tool_result_acknowledged_succeeded") tool.result_acknowledgement = "succeeded";
    if (event.code === "tool_result_acknowledged_failed") tool.result_acknowledgement = "failed";
    if (event.code === "local_tool_terminal_dom_committed") tool.terminal_dom_committed = true;
    if (event.code === "local_tool_terminal_paint_opportunity") {
      tool.terminal_paint_opportunity_observed = true;
    }
  }

  private trimToolSummaries(state: ActiveIncident): void {
    while (state.tools.size > AGENT_INCIDENT_MAX_TOOLS) {
      const ordered = [...state.tools.keys()].sort((left, right) => left - right);
      const droppedOrdinal = ordered[AGENT_INCIDENT_TOOL_PREFIX_SUMMARIES];
      if (droppedOrdinal === undefined) return;
      state.tools.delete(droppedOrdinal);
      state.droppedToolOrdinals.add(droppedOrdinal);
      state.droppedToolSummaryCount = addBoundedCount(state.droppedToolSummaryCount, 1);
      incrementFailure(state, "tool_summary_limit");
    }
  }

  private captureToolItemCounts(
    state: ActiveIncident,
    tool: MutableToolSummary,
    event: AgentIncidentTimelineEvent,
  ): void {
    if (tool.item_counts_invalid) return;
    const requested = event.tool_item_count ?? tool.requested_item_count;
    const completed = event.tool_completed_item_count ?? tool.completed_item_count;
    const failed = event.tool_failed_item_count ?? tool.failed_item_count;
    if (toolItemCountsContradict(requested, completed, failed)) {
      delete tool.requested_item_count;
      delete tool.completed_item_count;
      delete tool.failed_item_count;
      tool.item_counts_invalid = true;
      incrementFailure(state, "tool_count_inconsistent");
      return;
    }
    if (event.tool_item_count !== undefined) tool.requested_item_count = event.tool_item_count;
    if (event.tool_completed_item_count !== undefined) tool.completed_item_count = event.tool_completed_item_count;
    if (event.tool_failed_item_count !== undefined) tool.failed_item_count = event.tool_failed_item_count;
  }

  private appendTimeline(state: ActiveIncident, event: AgentIncidentTimelineEvent): void {
    state.timeline.push(event);
    state.timelineBytes += jsonBytes(event);
    while (state.timeline.length > AGENT_INCIDENT_MAX_EVENTS) {
      this.dropTimelineEvent(state, "event_limit");
    }
    while (
      state.timelineBytes > AGENT_INCIDENT_TIMELINE_BYTE_BUDGET
      && state.timeline.length > AGENT_INCIDENT_TIMELINE_PREFIX_EVENTS + 1
    ) {
      this.dropTimelineEvent(state, "byte_limit");
    }
  }

  private dropTimelineEvent(state: ActiveIncident, reason: "event_limit" | "byte_limit"): void {
    const removalIndex = state.timeline.length > AGENT_INCIDENT_TIMELINE_PREFIX_EVENTS
      ? AGENT_INCIDENT_TIMELINE_PREFIX_EVENTS
      : 0;
    const [removed] = state.timeline.splice(removalIndex, 1);
    if (!removed) return;
    state.timelineBytes = Math.max(0, state.timelineBytes - jsonBytes(removed));
    state.droppedEvents[reason] = addBoundedCount(state.droppedEvents[reason], 1);
  }

  private applyCaptureContext(state: ActiveIncident, context: AgentIncidentCaptureContext): void {
    try {
      const environment = context.environment;
      const failureAuthority = context.failureAuthority;
      const failureStage = context.failureStage;
      const failureMechanism = context.failureMechanism;
      const terminalValidation = context.terminalValidation;
      const hostProcessState = context.hostProcessState;
      const chatViewState = context.chatViewState;
      const assistantTextPartCount = context.assistantTextPartCount;
      const assistantTextStreamingPartCount = context.assistantTextStreamingPartCount;
      const assistantTextCompletePartCount = context.assistantTextCompletePartCount;
      const assistantTextCharacterCount = context.assistantTextCharacterCount;
      const reasoningPartCount = context.reasoningPartCount;
      const reasoningStreamingPartCount = context.reasoningStreamingPartCount;
      const reasoningCompletePartCount = context.reasoningCompletePartCount;
      const reasoningCharacterCount = context.reasoningCharacterCount;
      const assistantOutputPresentBeforeFailure = context.assistantOutputPresentBeforeFailure;
      const assistantOutputRetainedInFailedProjection = context.assistantOutputRetainedInFailedProjection;
      const snapshotPartCount = context.snapshotPartCount;
      const elapsedMs = context.elapsedMs;
      const collectionFailures = context.collectionFailures;
      const runState = context.runState;
      const rendering = context.rendering;
      if (environment && !copyEnvironment(state.environment, environment)) {
        incrementFailure(state, "environment_unavailable");
      }
      if (isFailureAuthority(failureAuthority)) state.failureAuthority = failureAuthority;
      if (isAgentIncidentFailureStage(failureStage)) state.failureStage = failureStage;
      if (isAgentIncidentFailureMechanism(failureMechanism)) {
        state.failureMechanism = failureMechanism;
      }
      if (isTerminalValidation(terminalValidation)) state.terminalValidation = terminalValidation;
      if (hostProcessState === "responsive" || hostProcessState === "unknown") {
        state.hostProcessState = hostProcessState;
      }
      if (chatViewState === "mounted" || chatViewState === "detached" || chatViewState === "unknown") {
        state.chatViewState = chatViewState;
      }
      state.assistantTextPartCount = boundedCount(assistantTextPartCount);
      state.assistantTextStreamingPartCount = boundedCount(
        assistantTextStreamingPartCount,
      );
      state.assistantTextCompletePartCount = boundedCount(
        assistantTextCompletePartCount,
      );
      state.assistantTextCharacterCount = boundedCount(assistantTextCharacterCount);
      state.reasoningPartCount = boundedCount(reasoningPartCount);
      state.reasoningStreamingPartCount = boundedCount(
        reasoningStreamingPartCount,
      );
      state.reasoningCompletePartCount = boundedCount(reasoningCompletePartCount);
      state.reasoningCharacterCount = boundedCount(reasoningCharacterCount);
      if (typeof assistantOutputPresentBeforeFailure === "boolean") {
        state.assistantOutputPresentBeforeFailure = assistantOutputPresentBeforeFailure;
      }
      if (typeof assistantOutputRetainedInFailedProjection === "boolean") {
        state.assistantOutputRetainedInFailedProjection
          = assistantOutputRetainedInFailedProjection;
      }
      state.snapshotPartCount = boundedCount(snapshotPartCount);
      state.elapsedMs = boundedThinAgentTiming(elapsedMs);
      if (runState) {
        const projectedRunState = projectRunState(runState);
        if (
          projectedRunState
          && isRunStateCompatibleWithFailureAuthority(
            projectedRunState,
            state.failureAuthority,
          )
        ) state.runState = deepFreeze(projectedRunState);
        else incrementFailure(state, "run_state_invalid");
      }
      if (rendering) {
        const projectedRendering = projectRenderingEvidence(rendering);
        if (projectedRendering) state.rendering = deepFreeze(projectedRendering);
        else incrementFailure(state, "rendering_snapshot_invalid");
      }
      copyCaptureFailureCodes(state, collectionFailures);
    } catch {
      incrementFailure(state, "terminal_context_unavailable");
    }
  }

  private buildBoundedReport(state: ActiveIncident, reportId: string, createdAt: string): AgentIncidentReport {
    let report = buildReport(state, reportId, createdAt, 0);
    let size = jsonBytes(report);
    while (
      size > AGENT_INCIDENT_MAX_REPORT_BYTES
      && state.timeline.length > AGENT_INCIDENT_TIMELINE_PREFIX_EVENTS + 1
    ) {
      this.dropTimelineEvent(state, "byte_limit");
      incrementFailure(state, "report_size_reduction");
      report = buildReport(state, reportId, createdAt, 0);
      size = jsonBytes(report);
    }
    while (
      size > AGENT_INCIDENT_MAX_REPORT_BYTES
      && state.transportSegments.length > AGENT_INCIDENT_TRANSPORT_PREFIX_SEGMENTS
    ) {
      state.transportSegments.splice(AGENT_INCIDENT_TRANSPORT_PREFIX_SEGMENTS, 1);
      state.droppedTransportSegmentCount = addBoundedCount(
        state.droppedTransportSegmentCount,
        1,
      );
      incrementFailure(state, "report_size_reduction");
      report = buildReport(state, reportId, createdAt, 0);
      size = jsonBytes(report);
    }
    while (size > AGENT_INCIDENT_MAX_REPORT_BYTES && state.resources.length > 0) {
      state.resources.shift();
      state.droppedResourceSampleCount = addBoundedCount(state.droppedResourceSampleCount, 1);
      incrementFailure(state, "report_size_reduction");
      report = buildReport(state, reportId, createdAt, 0);
      size = jsonBytes(report);
    }
    if (size > AGENT_INCIDENT_MAX_REPORT_BYTES && state.rendering) {
      state.rendering = undefined;
      incrementFailure(state, "report_size_reduction");
      report = buildReport(state, reportId, createdAt, 0);
      size = jsonBytes(report);
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      report = buildReport(state, reportId, createdAt, size);
      const nextSize = jsonBytes(report);
      if (nextSize === size) break;
      size = nextSize;
    }
    return deepFreeze(report);
  }

  private allocateReportId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let candidate: string;
      try {
        candidate = this.createReportId();
      } catch {
        continue;
      }
      if (isNonzeroReportId(candidate) && !this.isReportIdAllocated(candidate)) return candidate;
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = randomReportId();
      if (isNonzeroReportId(candidate) && !this.isReportIdAllocated(candidate)) return candidate;
    }
    throw new Error("Secure incident report ID generation failed.");
  }

  private isReportIdAllocated(reportId: string): boolean {
    if (this.frozenByReportId.has(reportId)) return true;
    for (const state of this.active.values()) {
      if (state.reservedReportId === reportId) return true;
    }
    return false;
  }

  private rememberReport(key: string, report: AgentIncidentReport): void {
    this.frozenByReportId.set(report.report_id, report);
    this.frozenByCorrelation.set(key, report);
    this.frozenCorrelationByReportId.set(report.report_id, key);
    if (report.incident.incident_id) {
      this.frozenByIncidentId.set(report.incident.incident_id, report);
    }
    this.frozenOrder.push(report.report_id);
    while (this.frozenOrder.length > this.maximumFrozenReports) {
      const oldestId = this.frozenOrder.shift();
      if (!oldestId) break;
      const oldest = this.frozenByReportId.get(oldestId);
      if (!oldest) continue;
      this.frozenByReportId.delete(oldestId);
      const oldestKey = this.frozenCorrelationByReportId.get(oldestId);
      this.frozenCorrelationByReportId.delete(oldestId);
      if (oldestKey && this.frozenByCorrelation.get(oldestKey) === oldest) this.frozenByCorrelation.delete(oldestKey);
      const incidentId = oldest.incident.incident_id;
      if (incidentId && this.frozenByIncidentId.get(incidentId) === oldest) {
        this.frozenByIncidentId.delete(incidentId);
      }
    }
  }

  private rememberNonFailureSettlement(key: string): void {
    this.settledNonFailure.add(key);
    this.settledNonFailureOrder.push(key);
    while (this.settledNonFailureOrder.length > AGENT_INCIDENT_MAX_SETTLED_CORRELATIONS) {
      const oldest = this.settledNonFailureOrder.shift();
      if (oldest) this.settledNonFailure.delete(oldest);
    }
  }
}

function projectLifecycleEvent(event: ThinAgentLifecycleEvent): ProjectedLifecycleEvent | null {
  try {
    if (!event) return null;
    const raw = {
      timestamp: event.timestamp,
      severity: event.severity,
      code: event.code,
      phase: event.phase,
      sequence: event.sequence,
      conversationId: event.conversation_id,
      requestId: event.request_id,
      pluginBuildId: event.plugin_build_id,
      runId: event.run_id,
      serverRunId: event.server_run_id,
      status: event.status,
      retryable: event.retryable,
      incidentId: event.incident_id,
      failureCode: event.failure_code,
      latencyTraceId: event.latency_trace_id,
      commandKind: event.command_kind,
      commandSegmentOrdinal: event.command_segment_ordinal,
      toolExecutionOrdinal: event.tool_execution_ordinal,
      toolName: event.tool_name,
      toolOutcome: event.tool_outcome,
      toolFailureClass: event.tool_failure_class,
      toolItemCount: event.tool_item_count,
      toolCompletedItemCount: event.tool_completed_item_count,
      toolFailedItemCount: event.tool_failed_item_count,
      historySyncKind: event.history_sync_kind,
      historySyncOrdinal: event.history_sync_ordinal,
      responseDeliveryMode: event.response_delivery_mode,
      clientMonotonicOffsetMs: event.client_monotonic_offset_ms,
      serverTimingAppMs: event.server_timing_app_ms,
      serverTimingAuthMs: event.server_timing_auth_ms,
      creditsRefreshReason: event.credits_refresh_reason,
      creditsRefreshSequence: event.credits_refresh_sequence,
      creditsRefreshTransport: event.credits_refresh_transport,
      creditsRefreshElapsedMs: event.credits_refresh_elapsed_ms,
      creditsRefreshServerAuthMs: event.credits_refresh_server_auth_ms,
      creditsRefreshServerRateLimitMs: event.credits_refresh_server_rate_limit_ms,
      creditsRefreshServerBalanceStoreMs: event.credits_refresh_server_balance_store_ms,
      creditsRefreshServerTotalMs: event.credits_refresh_server_total_ms,
    };
    if (raw.severity !== "info" || !isAgentLifecycleCode(raw.code) || !isAgentLifecyclePhase(raw.phase)) return null;
    const timestamp = normalizeIsoTimestamp(raw.timestamp);
    if (!timestamp) return null;
    const correlation = sanitizeCorrelation({
      conversationId: raw.conversationId ?? "",
      requestId: raw.requestId ?? "",
    });
    if (!correlation) return null;
    const runId = isThinAgentServerRunId(raw.runId) ? raw.runId : undefined;
    const serverRunId = isThinAgentServerRunId(raw.serverRunId) ? raw.serverRunId : undefined;
    const incidentId = isNonzeroIncidentId(raw.incidentId) ? raw.incidentId : undefined;
    const failureCode = normalizeAgentIncidentFailureCode(
      raw.failureCode,
      "server",
    );
    const latencyTraceId = isNonzeroLatencyTraceId(raw.latencyTraceId) ? raw.latencyTraceId : undefined;
    const toolName = isFirstPartyToolName(raw.toolName) ? raw.toolName : undefined;
    const commandKind = isThinAgentCommandKind(raw.commandKind) ? raw.commandKind : undefined;
    const toolOutcome = isToolDiagnosticOutcome(raw.toolOutcome) ? raw.toolOutcome : undefined;
    const toolFailureClass = isToolDiagnosticFailureClass(raw.toolFailureClass) ? raw.toolFailureClass : undefined;
    const historySyncKind = isHistorySyncKind(raw.historySyncKind) ? raw.historySyncKind : undefined;
    const creditsRefreshReason = isCreditsRefreshReason(raw.creditsRefreshReason) ? raw.creditsRefreshReason : undefined;
    const clientMonotonicOffsetMs = boundedThinAgentTiming(raw.clientMonotonicOffsetMs);
    const serverTimingAppMs = boundedThinAgentTiming(raw.serverTimingAppMs);
    const serverTimingAuthMs = boundedThinAgentTiming(raw.serverTimingAuthMs);
    const creditsRefreshElapsedMs = boundedThinAgentTiming(raw.creditsRefreshElapsedMs);
    const creditsRefreshServerAuthMs = boundedThinAgentTiming(raw.creditsRefreshServerAuthMs);
    const creditsRefreshServerRateLimitMs = boundedThinAgentTiming(raw.creditsRefreshServerRateLimitMs);
    const creditsRefreshServerBalanceStoreMs = boundedThinAgentTiming(raw.creditsRefreshServerBalanceStoreMs);
    const creditsRefreshServerTotalMs = boundedThinAgentTiming(raw.creditsRefreshServerTotalMs);
    const toolItemCount = boundedToolDiagnosticItemCount(raw.toolItemCount);
    const toolCompletedItemCount = boundedToolDiagnosticItemCount(raw.toolCompletedItemCount);
    const toolFailedItemCount = boundedToolDiagnosticItemCount(raw.toolFailedItemCount);
    const sourceSequence = positiveInteger(raw.sequence);
    const status = httpStatus(raw.status);
    const commandSegmentOrdinal = positiveInteger(raw.commandSegmentOrdinal);
    const toolExecutionOrdinal = boundedOrdinal(raw.toolExecutionOrdinal, AGENT_INCIDENT_MAX_TOOL_ORDINAL);
    const historySyncOrdinal = positiveInteger(raw.historySyncOrdinal);
    const creditsRefreshSequence = positiveInteger(raw.creditsRefreshSequence);
    const responseDeliveryMode = raw.responseDeliveryMode === "fetch_stream" || raw.responseDeliveryMode === "request_url_buffered"
      ? raw.responseDeliveryMode
      : undefined;
    const creditsRefreshTransport = raw.creditsRefreshTransport === "fetch" || raw.creditsRefreshTransport === "request_url"
      ? raw.creditsRefreshTransport
      : undefined;

    const pluginBuildId = safePluginBuildId(raw.pluginBuildId);
    return {
      correlation,
      ...(pluginBuildId ? { pluginBuildId } : {}),
      timeline: {
        timestamp,
        code: raw.code,
        phase: raw.phase,
        ...(sourceSequence === undefined ? {} : { source_sequence: sourceSequence }),
        ...(runId ? { run_id: runId } : {}),
        ...(serverRunId ? { server_run_id: serverRunId } : {}),
        ...(status === undefined ? {} : { status }),
        ...(typeof raw.retryable === "boolean" ? { retryable: raw.retryable } : {}),
        ...(incidentId ? { incident_id: incidentId } : {}),
        ...(failureCode ? { failure_code: failureCode } : {}),
        ...(latencyTraceId && commandSegmentOrdinal !== undefined
          ? { server_latency_correlation_id: latencyTraceId }
          : {}),
        ...(commandKind ? { command_kind: commandKind } : {}),
        ...(commandSegmentOrdinal === undefined ? {} : { command_segment_ordinal: commandSegmentOrdinal }),
        ...(toolExecutionOrdinal === undefined ? {} : { tool_execution_ordinal: toolExecutionOrdinal }),
        ...(toolName ? { tool_name: toolName } : {}),
        ...(toolOutcome ? { tool_outcome: toolOutcome } : {}),
        ...(toolFailureClass ? { tool_failure_class: toolFailureClass } : {}),
        ...(toolItemCount === undefined ? {} : { tool_item_count: toolItemCount }),
        ...(toolCompletedItemCount === undefined ? {} : { tool_completed_item_count: toolCompletedItemCount }),
        ...(toolFailedItemCount === undefined ? {} : { tool_failed_item_count: toolFailedItemCount }),
        ...(historySyncKind ? { history_sync_kind: historySyncKind } : {}),
        ...(historySyncOrdinal === undefined ? {} : { history_sync_ordinal: historySyncOrdinal }),
        ...(responseDeliveryMode ? { response_delivery_mode: responseDeliveryMode } : {}),
        ...(clientMonotonicOffsetMs === undefined
          ? {}
          : { client_monotonic_offset_ms: clientMonotonicOffsetMs, client_clock_domain: "client_turn_monotonic" as const }),
        ...(serverTimingAppMs === undefined ? {} : { server_timing_app_ms: serverTimingAppMs }),
        ...(serverTimingAuthMs === undefined ? {} : { server_timing_auth_ms: serverTimingAuthMs }),
        ...(serverTimingAppMs === undefined && serverTimingAuthMs === undefined
          ? {}
          : { server_timing_clock_domain: "server_response_headers_monotonic_duration" as const }),
        ...(creditsRefreshReason ? { credits_refresh_reason: creditsRefreshReason } : {}),
        ...(creditsRefreshSequence === undefined ? {} : { credits_refresh_sequence: creditsRefreshSequence }),
        ...(creditsRefreshTransport ? { credits_refresh_transport: creditsRefreshTransport } : {}),
        ...(creditsRefreshElapsedMs === undefined
          ? {}
          : { credits_refresh_elapsed_ms: creditsRefreshElapsedMs, credits_refresh_clock_domain: "client_refresh_monotonic_duration" as const }),
        ...(creditsRefreshServerAuthMs === undefined ? {} : { credits_refresh_server_auth_ms: creditsRefreshServerAuthMs }),
        ...(creditsRefreshServerRateLimitMs === undefined ? {} : { credits_refresh_server_rate_limit_ms: creditsRefreshServerRateLimitMs }),
        ...(creditsRefreshServerBalanceStoreMs === undefined ? {} : { credits_refresh_server_balance_store_ms: creditsRefreshServerBalanceStoreMs }),
        ...(creditsRefreshServerTotalMs === undefined ? {} : { credits_refresh_server_total_ms: creditsRefreshServerTotalMs }),
        ...(creditsRefreshServerAuthMs === undefined
          && creditsRefreshServerRateLimitMs === undefined
          && creditsRefreshServerBalanceStoreMs === undefined
          && creditsRefreshServerTotalMs === undefined
          ? {}
          : { credits_refresh_server_timing_clock_domain: "server_response_headers_monotonic_duration" as const }),
      },
    };
  } catch {
    return null;
  }
}

function buildReport(
  state: ActiveIncident,
  reportId: string,
  createdAt: string,
  reportBytes: number,
): AgentIncidentReport {
  const terminal = state.terminal!;
  const missingFields = collectMissingFields(state);
  const collectionFailures = CAPTURE_FAILURE_CODES.flatMap((code) => {
    const count = state.collectionFailures.get(code) ?? 0;
    return count > 0 ? [{ code, count }] : [];
  });
  const droppedEventCount = state.droppedEvents.event_limit
    + state.droppedEvents.byte_limit
    + state.droppedEvents.after_terminal;
  const truncated = droppedEventCount > 0
    || state.droppedResourceSampleCount > 0
    || state.droppedToolSummaryCount > 0
    || state.droppedTransportSegmentCount > 0
    || state.runState?.counts_truncated === true
    || state.runState?.elapsed_ms_truncated === true
    || state.transportSegments.some((segment) => segment.metrics_truncated);
  const terminalServerLatencyCorrelationId = serverLatencyCorrelationIdForTerminal(state);
  const tools = [...state.tools.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((tool): AgentIncidentToolSummary => ({
      ordinal: tool.ordinal,
      ...(tool.tool_name ? { tool_name: tool.tool_name } : {}),
      ...(tool.started_at ? { started_at: tool.started_at } : {}),
      ...(tool.completed_at ? { completed_at: tool.completed_at } : {}),
      ...(tool.outcome ? { outcome: tool.outcome } : {}),
      ...(tool.failure_class ? { failure_class: tool.failure_class } : {}),
      ...(tool.requested_item_count === undefined ? {} : { requested_item_count: tool.requested_item_count }),
      ...(tool.completed_item_count === undefined ? {} : { completed_item_count: tool.completed_item_count }),
      ...(tool.failed_item_count === undefined ? {} : { failed_item_count: tool.failed_item_count }),
      result_delivery: tool.result_delivery ?? "not_observed",
      result_acknowledgement: tool.result_acknowledgement ?? "not_observed",
      terminal_dom_committed: tool.terminal_dom_committed,
      terminal_paint_opportunity_observed: tool.terminal_paint_opportunity_observed,
      lifecycle_event_count: tool.lifecycle_event_count,
    }));

  return {
    schema_version: AGENT_INCIDENT_SCHEMA_VERSION,
    report_id: reportId,
    created_at: createdAt,
    incident: {
      classification: "operation_failure",
      impact: "run_failed",
      outcome: "failed",
      severity_text: "ERROR",
      severity_number: 17,
      failure_authority: state.failureAuthority ?? "unknown",
      origin: state.failureAuthority === "client" ? "agent_local_failure" : "agent_terminal",
      terminal_evidence: deriveAgentIncidentTerminalEvidence(
        state.failureAuthority ?? "unknown",
        state.terminalValidation ?? "not_recorded",
      ),
      artifact_integrity: "unauthenticated_client_record",
      evidence_scope: "client_observation_only",
      causal_assessment: "not_established",
      observation_source: state.failureAuthority === "server"
        ? "server_protocol_terminal"
        : state.failureMechanism === "http_rejection" && terminal.status !== undefined
          ? "server_http_response"
          : "client_runtime",
      failure_stage: state.failureStage ?? "not_recorded",
      failure_mechanism: state.failureMechanism ?? "not_recorded",
      ...(terminal.incident_id ? { incident_id: terminal.incident_id } : {}),
      ...(terminal.failure_code ? { failure_code: terminal.failure_code } : {}),
      ...(typeof terminal.retryable === "boolean" ? { retryable: terminal.retryable } : {}),
      ...(terminal.status === undefined ? {} : { http_status: terminal.status }),
    },
    correlation: {
      ...(state.runId ? { run_id: state.runId } : {}),
      ...(state.serverRunId ? { server_run_id: state.serverRunId } : {}),
      ...(terminalServerLatencyCorrelationId
        ? { server_latency_correlation_id: terminalServerLatencyCorrelationId }
        : {}),
    },
    grouping: {
      strategy: AGENT_INCIDENT_GROUPING_STRATEGY,
      fingerprint: buildAgentIncidentGroupingFingerprint({
        failureAuthority: state.failureAuthority ?? "unknown",
        ...(state.failureStage ? { failureStage: state.failureStage } : {}),
        ...(state.failureMechanism
          ? { failureMechanism: state.failureMechanism }
          : {}),
        ...(terminal.failure_code ? { failureCode: terminal.failure_code } : {}),
        ...(terminal.status === undefined ? {} : { httpStatus: terminal.status }),
        ...(state.runState ? { terminalSource: state.runState.terminal_source } : {}),
      }),
    },
    environment: { ...state.environment },
    run_summary: {
      ...(state.startedAt ? { started_at: state.startedAt } : {}),
      failed_at: terminal.timestamp,
      ...(state.elapsedMs === undefined
        ? {}
        : { duration_ms: state.elapsedMs, duration_clock_domain: "client_turn_monotonic" as const }),
      terminal_receipt: terminalReceipt(state),
      terminal_validation: state.terminalValidation ?? "not_recorded",
      host_process_state: state.hostProcessState ?? "unknown",
      chat_view_state: state.chatViewState ?? "unknown",
      observed_lifecycle_event_count: state.observedEventCount,
      retained_timeline_event_count: state.timeline.length,
      ...(state.snapshotPartCount === undefined ? {} : { snapshot_part_count: state.snapshotPartCount }),
      partial_output: {
        ...(state.assistantTextPartCount === undefined ? {} : { assistant_text_part_count: state.assistantTextPartCount }),
        ...(state.assistantTextStreamingPartCount === undefined
          ? {}
          : { assistant_text_streaming_part_count: state.assistantTextStreamingPartCount }),
        ...(state.assistantTextCompletePartCount === undefined
          ? {}
          : { assistant_text_complete_part_count: state.assistantTextCompletePartCount }),
        ...(state.assistantTextCharacterCount === undefined ? {} : { assistant_text_character_count: state.assistantTextCharacterCount }),
        ...(state.reasoningPartCount === undefined ? {} : { reasoning_part_count: state.reasoningPartCount }),
        ...(state.reasoningStreamingPartCount === undefined
          ? {}
          : { reasoning_streaming_part_count: state.reasoningStreamingPartCount }),
        ...(state.reasoningCompletePartCount === undefined
          ? {}
          : { reasoning_complete_part_count: state.reasoningCompletePartCount }),
        ...(state.reasoningCharacterCount === undefined ? {} : { reasoning_character_count: state.reasoningCharacterCount }),
        ...(state.assistantOutputPresentBeforeFailure === undefined
          ? {}
          : { assistant_output_present_before_failure: state.assistantOutputPresentBeforeFailure }),
        ...(state.assistantOutputRetainedInFailedProjection === undefined
          ? {}
          : { assistant_output_retained_in_failed_projection: state.assistantOutputRetainedInFailedProjection }),
      },
      lifecycle_code_counts: THIN_AGENT_LIFECYCLE_CODES.flatMap((code) => {
        const count = state.codeCounts.get(code) ?? 0;
        return count > 0 ? [{ code, count }] : [];
      }),
      lifecycle_phase_counts: THIN_AGENT_LIFECYCLE_PHASES.flatMap((phase) => {
        const count = state.phaseCounts.get(phase) ?? 0;
        return count > 0 ? [{ phase, count }] : [];
      }),
    },
    ...(state.runState ? { run_state: state.runState } : {}),
    tools,
    timeline: timelineForReport(state),
    transport_segments: transportSegmentsForReport(state),
    ...(state.rendering ? { rendering: state.rendering } : {}),
    resource_samples: [...state.resources],
    capture_quality: {
      complete: !truncated && missingFields.length === 0 && collectionFailures.length === 0,
      truncated,
      limits: {
        maximum_events: AGENT_INCIDENT_MAX_EVENTS,
        maximum_report_bytes: AGENT_INCIDENT_MAX_REPORT_BYTES,
        maximum_resource_samples: AGENT_INCIDENT_MAX_RESOURCE_SAMPLES,
        maximum_tools: AGENT_INCIDENT_MAX_TOOLS,
        maximum_transport_segments: AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
        maximum_render_count: AGENT_INCIDENT_MAX_RENDER_COUNT,
        maximum_render_duration_ms: AGENT_INCIDENT_MAX_RENDER_DURATION_MS,
      },
      report_bytes: reportBytes,
      observed_event_count: state.observedEventCount,
      retained_event_count: state.timeline.length,
      dropped_event_count: droppedEventCount,
      dropped_events: { ...state.droppedEvents },
      dropped_resource_sample_count: state.droppedResourceSampleCount,
      dropped_tool_summary_count: state.droppedToolSummaryCount,
      dropped_transport_segment_count: state.droppedTransportSegmentCount,
      missing_fields: missingFields,
      collection_failures: collectionFailures,
    },
    privacy: {
      policy: "strict_allowlist_content_free",
      policy_version: "systemsculpt.incident-privacy/1",
      capture_implementation_version: "agent-incident-recorder/1",
      storage_target: "vault_local",
      host_sync: "may_sync_with_vault",
      automatic_upload: false,
      excluded_data_categories: [...EXCLUDED_DATA_CATEGORIES],
    },
  };
}

function terminalReceipt(state: ActiveIncident): AgentIncidentTerminalReceipt {
  const terminalSource = state.runState?.terminal_source;
  if (
    state.failureAuthority === "server"
    && (terminalSource === "session_terminal" || terminalSource === "message_reconstruction")
  ) return "client_received_server_terminal";
  if (state.failureAuthority === "client" && terminalSource === "local_failure") {
    return "client_emitted_local_failure";
  }
  return "unknown";
}

function isRunStateCompatibleWithFailureAuthority(
  runState: AgentIncidentRunState,
  failureAuthority: ActiveIncident["failureAuthority"],
): boolean {
  if (runState.terminal_source === "local_failure") {
    return failureAuthority === "client";
  }
  return failureAuthority !== "client";
}

function timelineForReport(state: ActiveIncident): AgentIncidentTimelineEvent[] {
  if (
    state.conflictedIdentifiers.size === 0
    && state.conflictedServerLatencyCorrelationSegments.size === 0
  ) return [...state.timeline];
  return state.timeline.map((event) => {
    const projected = { ...event } as {
      -readonly [Key in keyof AgentIncidentTimelineEvent]: AgentIncidentTimelineEvent[Key];
    };
    if (state.conflictedIdentifiers.has("runId")) delete projected.run_id;
    if (state.conflictedIdentifiers.has("serverRunId")) delete projected.server_run_id;
    if (state.conflictedServerLatencyCorrelationSegments.has(
      event.command_segment_ordinal ?? 0,
    )) {
      delete projected.server_latency_correlation_id;
    }
    return projected;
  });
}

function transportSegmentsForReport(
  state: ActiveIncident,
): AgentIncidentTransportSegment[] {
  return state.transportSegments.map((segment) => {
    const serverLatencyCorrelationId = state.serverLatencyCorrelationIdsBySegment.get(
      segment.segment_ordinal,
    );
    return {
      ...segment,
      ...(serverLatencyCorrelationId
        ? { server_latency_correlation_id: serverLatencyCorrelationId }
        : {}),
    };
  });
}

function serverLatencyCorrelationIdForTerminal(
  state: ActiveIncident,
): string | undefined {
  const terminalTransport = terminalTransportReference(state.timeline);
  if (terminalTransport) {
    return state.serverLatencyCorrelationIdsBySegment.get(
      terminalTransport.segmentOrdinal,
    );
  }
  if (state.conflictedServerLatencyCorrelationSegments.size > 0) {
    return undefined;
  }
  const values = new Set(state.serverLatencyCorrelationIdsBySegment.values());
  return values.size === 1 ? values.values().next().value : undefined;
}

function collectMissingFields(state: ActiveIncident): AgentIncidentMissingFieldCode[] {
  const missing = new Set(state.explicitMissingFields);
  if (!state.startedAt) missing.add("run_started");
  if (!state.terminal?.incident_id) missing.add("server_incident_id");
  if (!state.terminal?.failure_code) missing.add("failure_code");
  if (!state.serverRunId) missing.add("server_run_id");
  if (!state.failureAuthority || state.failureAuthority === "unknown") missing.add("failure_authority");
  if (!state.failureStage) missing.add("failure_stage");
  if (!state.failureMechanism) missing.add("failure_mechanism");
  if (!state.terminalValidation) missing.add("terminal_validation");
  if (!state.hostProcessState || state.hostProcessState === "unknown") missing.add("host_process_state");
  if (!state.chatViewState || state.chatViewState === "unknown") missing.add("chat_view_state");
  if (state.elapsedMs === undefined) missing.add("duration_ms");
  if (state.assistantTextPartCount === undefined) missing.add("assistant_text_part_count");
  if (state.assistantTextStreamingPartCount === undefined) missing.add("assistant_text_streaming_part_count");
  if (state.assistantTextCompletePartCount === undefined) missing.add("assistant_text_complete_part_count");
  if (state.assistantTextCharacterCount === undefined) missing.add("assistant_text_character_count");
  if (state.reasoningPartCount === undefined) missing.add("reasoning_part_count");
  if (state.reasoningStreamingPartCount === undefined) missing.add("reasoning_streaming_part_count");
  if (state.reasoningCompletePartCount === undefined) missing.add("reasoning_complete_part_count");
  if (state.reasoningCharacterCount === undefined) missing.add("reasoning_character_count");
  if (state.assistantOutputPresentBeforeFailure === undefined) {
    missing.add("assistant_output_present_before_failure");
  }
  if (state.assistantOutputRetainedInFailedProjection === undefined) {
    missing.add("assistant_output_retained_in_failed_projection");
  }
  if (!state.runState) missing.add("run_state");
  if (!state.rendering) missing.add("rendering");
  if (!state.rendering?.before_terminal_publish) {
    missing.add("rendering_before_terminal_publish");
  }
  if (!state.rendering?.after_terminal_commit) {
    missing.add("rendering_after_terminal_commit");
  }
  if (!state.rendering?.failure_surface_dom_committed) {
    missing.add("failure_surface_dom_commit");
  }
  if (!state.rendering?.failure_surface_paint_opportunity_observed) {
    missing.add("failure_surface_paint_opportunity");
  }
  if (state.resources.length === 0) missing.add("resource_samples");
  if (state.transportSegments.length === 0) missing.add("transport_segments");
  const terminalTransport = terminalTransportReference(state.timeline);
  if (!terminalTransport || !state.transportSegments.some((segment) => (
    segment.segment_ordinal === terminalTransport.segmentOrdinal
    && (terminalTransport.commandKind === undefined || segment.command_kind === terminalTransport.commandKind)
    && (
      terminalTransport.toolExecutionOrdinal === undefined
      || segment.tool_execution_ordinal === terminalTransport.toolExecutionOrdinal
    )
  ))) {
    missing.add("terminal_transport_segment");
  }
  if (!state.environment.plugin_version) missing.add("environment_plugin_version");
  if (!state.environment.plugin_build_id) missing.add("environment_plugin_build_id");
  if (!state.environment.loaded_bundle_sha256) missing.add("environment_loaded_bundle_sha256");
  if (!state.environment.obsidian_version) missing.add("environment_obsidian_version");
  if (!state.environment.host_type || state.environment.host_type === "unknown") missing.add("environment_host_type");
  if (!state.environment.os_family || state.environment.os_family === "unknown") missing.add("environment_os_family");
  return AGENT_INCIDENT_MISSING_FIELD_CODES.filter((field) => missing.has(field));
}

function terminalTransportReference(
  timeline: readonly AgentIncidentTimelineEvent[],
): Readonly<{
  segmentOrdinal: number;
  commandKind?: ThinAgentCommandKind;
  toolExecutionOrdinal?: number;
}> | null {
  let segmentOrdinal: number | undefined;
  let commandKind: ThinAgentCommandKind | undefined;
  let toolExecutionOrdinal: number | undefined;
  for (const event of timeline) {
    if (event.code !== "response_result_received_failed" && event.code !== "run_finished_failed") continue;
    if (event.command_segment_ordinal === undefined) continue;
    if (segmentOrdinal !== undefined && segmentOrdinal !== event.command_segment_ordinal) return null;
    if (commandKind !== undefined && event.command_kind !== undefined && commandKind !== event.command_kind) return null;
    if (
      toolExecutionOrdinal !== undefined
      && event.tool_execution_ordinal !== undefined
      && toolExecutionOrdinal !== event.tool_execution_ordinal
    ) return null;
    segmentOrdinal = event.command_segment_ordinal;
    commandKind = commandKind ?? event.command_kind;
    toolExecutionOrdinal = toolExecutionOrdinal ?? event.tool_execution_ordinal;
  }
  return segmentOrdinal === undefined
    ? null
    : {
        segmentOrdinal,
        ...(commandKind === undefined ? {} : { commandKind }),
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      };
}

function projectTransportSegment(
  input: AgentIncidentTransportSegmentInput,
): AgentIncidentTransportSegment | null {
  try {
    if (!input) return null;
    const raw = {
      commandKind: input.commandKind,
      segmentOrdinal: input.commandSegmentOrdinal,
      serverLatencyCorrelationId: input.serverLatencyCorrelationId,
      toolExecutionOrdinal: input.toolExecutionOrdinal,
      closeReason: input.closeReason,
      durationMs: input.durationMs,
      receivedBytes: input.receivedBytes,
      rawChunkCount: input.nonEmptyRawChunkCount,
      sseEventCount: input.sseEventCount,
      acceptedFrameCount: input.acceptedFrameCount,
      deliveredFrameCount: input.deliveredFrameCount,
      metricsTruncated: input.metricsTruncated,
    };
    const segmentOrdinal = boundedOrdinal(raw.segmentOrdinal, AGENT_INCIDENT_MAX_COUNT);
    const serverLatencyCorrelationId = isNonzeroLatencyTraceId(
      raw.serverLatencyCorrelationId,
    )
      ? raw.serverLatencyCorrelationId
      : undefined;
    const toolExecutionOrdinal = raw.toolExecutionOrdinal === undefined
      ? undefined
      : boundedOrdinal(raw.toolExecutionOrdinal, AGENT_INCIDENT_MAX_TOOL_ORDINAL);
    const durationMs = boundedThinAgentTiming(raw.durationMs);
    const receivedBytes = boundedWholeNumber(raw.receivedBytes, AGENT_INCIDENT_MAX_TRANSPORT_BYTES);
    const rawChunkCount = boundedWholeNumber(
      raw.rawChunkCount,
      AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT,
    );
    const sseEventCount = boundedWholeNumber(
      raw.sseEventCount,
      AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT,
    );
    const acceptedFrameCount = boundedWholeNumber(
      raw.acceptedFrameCount,
      AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT,
    );
    const deliveredFrameCount = boundedWholeNumber(
      raw.deliveredFrameCount,
      AGENT_INCIDENT_MAX_TRANSPORT_OBSERVATION_COUNT,
    );
    if (
      !isThinAgentCommandKind(raw.commandKind)
      || segmentOrdinal === undefined
      || raw.serverLatencyCorrelationId !== undefined
        && serverLatencyCorrelationId === undefined
      || raw.toolExecutionOrdinal !== undefined && toolExecutionOrdinal === undefined
      || !isTransportSegmentCloseReason(raw.closeReason)
      || durationMs === undefined
      || receivedBytes === undefined
      || rawChunkCount === undefined
      || sseEventCount === undefined
      || acceptedFrameCount === undefined
      || deliveredFrameCount === undefined
      || typeof raw.metricsTruncated !== "boolean"
    ) return null;
    return {
      command_kind: raw.commandKind,
      segment_ordinal: segmentOrdinal,
      ...(serverLatencyCorrelationId
        ? { server_latency_correlation_id: serverLatencyCorrelationId }
        : {}),
      ...(toolExecutionOrdinal === undefined ? {} : { tool_execution_ordinal: toolExecutionOrdinal }),
      close_reason: raw.closeReason,
      duration_ms: durationMs,
      received_bytes: receivedBytes,
      raw_chunk_count: rawChunkCount,
      sse_event_count: sseEventCount,
      accepted_frame_count: acceptedFrameCount,
      delivered_frame_count: deliveredFrameCount,
      metrics_truncated: raw.metricsTruncated,
    };
  } catch {
    return null;
  }
}

function projectRunState(input: AgentIncidentRunStateInput): AgentIncidentRunState | null {
  try {
    if (!input) return null;
    const raw = {
      terminalSource: input.terminalSource,
      runOrigin: input.runOrigin,
      runPhase: input.runPhase,
      connectionState: input.connectionState,
      executingLocalToolCount: input.executingLocalToolCount,
      pendingToolDeliveryCount: input.pendingToolDeliveryCount,
      pendingApprovalDeliveryCount: input.pendingApprovalDeliveryCount,
      pendingToolTaskCount: input.pendingToolTaskCount,
      serverQueued: input.serverQueued,
      runStalled: input.runStalled,
      awaitingClientWork: input.awaitingClientWork,
      pendingCancel: input.pendingCancel,
      pendingRegenerate: input.pendingRegenerate,
      countsTruncated: input.countsTruncated,
      elapsedMsTruncated: input.elapsedMsTruncated,
    };
    const executingLocalToolCount = boundedCount(raw.executingLocalToolCount);
    const pendingToolDeliveryCount = boundedCount(raw.pendingToolDeliveryCount);
    const pendingApprovalDeliveryCount = boundedCount(raw.pendingApprovalDeliveryCount);
    const pendingToolTaskCount = boundedCount(raw.pendingToolTaskCount);
    if (
      !isTerminalSource(raw.terminalSource)
      || !isRunOrigin(raw.runOrigin)
      || !isRunPhase(raw.runPhase)
      || !isConnectionState(raw.connectionState)
      || executingLocalToolCount === undefined
      || pendingToolDeliveryCount === undefined
      || pendingApprovalDeliveryCount === undefined
      || pendingToolTaskCount === undefined
      || typeof raw.serverQueued !== "boolean"
      || typeof raw.runStalled !== "boolean"
      || typeof raw.awaitingClientWork !== "boolean"
      || typeof raw.pendingCancel !== "boolean"
      || typeof raw.pendingRegenerate !== "boolean"
      || typeof raw.countsTruncated !== "boolean"
      || typeof raw.elapsedMsTruncated !== "boolean"
    ) return null;
    return {
      terminal_source: raw.terminalSource,
      run_origin: raw.runOrigin,
      run_phase: raw.runPhase,
      connection_state: raw.connectionState,
      executing_local_tool_count: executingLocalToolCount,
      pending_tool_delivery_count: pendingToolDeliveryCount,
      pending_approval_delivery_count: pendingApprovalDeliveryCount,
      pending_tool_task_count: pendingToolTaskCount,
      server_queued: raw.serverQueued,
      run_stalled: raw.runStalled,
      awaiting_client_work: raw.awaitingClientWork,
      pending_cancel: raw.pendingCancel,
      pending_regenerate: raw.pendingRegenerate,
      counts_truncated: raw.countsTruncated,
      elapsed_ms_truncated: raw.elapsedMsTruncated,
    };
  } catch {
    return null;
  }
}

function projectRenderingSnapshot(
  input: AgentIncidentRenderingInput,
): AgentIncidentRenderingSnapshot | null {
  try {
    if (!input) return null;
    const rendererInput = input.renderer;
    const scrollerInput = input.scroller;
    if (!rendererInput || !scrollerInput) return null;
    const raw = {
      renderState: input.renderState,
      renderPassCount: input.renderPassCount,
      pendingRenderCount: input.pendingRenderCount,
      lastRenderDurationMs: input.lastRenderDurationMs,
      maxRenderDurationMs: input.maxRenderDurationMs,
      firstDomCommitObserved: input.firstDomCommitObserved,
      firstPaintOpportunityObserved: input.firstPaintOpportunityObserved,
      registeredRowCount: input.registeredRowCount,
    };
    const renderer = {
      renderPassCount: rendererInput.renderPassCount,
      pendingRenderPassCount: rendererInput.pendingRenderPassCount,
      lastRenderDurationMs: rendererInput.lastRenderDurationMs,
      maxRenderDurationMs: rendererInput.maxRenderDurationMs,
      historicalRowCount: rendererInput.historicalRowCount,
      historicalPartCount: rendererInput.historicalPartCount,
      activePartCount: rendererInput.activePartCount,
      disclosureCount: rendererInput.disclosureCount,
      openDisclosureCount: rendererInput.openDisclosureCount,
      activityDisclosureCount: rendererInput.activityDisclosureCount,
      reasoningDisclosureCount: rendererInput.reasoningDisclosureCount,
      toolDisclosureCount: rendererInput.toolDisclosureCount,
      overflowDisclosureCount: rendererInput.overflowDisclosureCount,
      pendingHydrationCount: rendererInput.pendingHydrationCount,
      renderingEnabled: rendererInput.renderingEnabled,
    };
    const scroller = {
      mode: scrollerInput.mode,
      distanceFromEndBucket: scrollerInput.distanceFromEndBucket,
      registeredRowCount: scrollerInput.registeredRowCount,
      pendingLayoutMutationCount: scrollerInput.pendingLayoutMutationCount,
      layoutMutationPending: scrollerInput.layoutMutationPending,
      geometryUpdatePending: scrollerInput.geometryUpdatePending,
      programmaticScrollPending: scrollerInput.programmaticScrollPending,
      submittedPromptAnchorActive: scrollerInput.submittedPromptAnchorActive,
      destroyed: scrollerInput.destroyed,
    };
    const renderPassCount = boundedRenderCount(raw.renderPassCount);
    const pendingRenderCount = boundedRenderCount(raw.pendingRenderCount);
    const lastRenderDurationMs = boundedRenderDuration(raw.lastRenderDurationMs);
    const maxRenderDurationMs = boundedRenderDuration(raw.maxRenderDurationMs);
    const registeredRowCount = boundedRenderCount(raw.registeredRowCount);
    const rendererRenderPassCount = boundedRenderCount(renderer.renderPassCount);
    const rendererPendingRenderPassCount = boundedRenderCount(renderer.pendingRenderPassCount);
    const rendererLastRenderDurationMs = boundedRenderDuration(renderer.lastRenderDurationMs);
    const rendererMaxRenderDurationMs = boundedRenderDuration(renderer.maxRenderDurationMs);
    const historicalRowCount = boundedRenderCount(renderer.historicalRowCount);
    const historicalPartCount = boundedRenderCount(renderer.historicalPartCount);
    const activePartCount = boundedRenderCount(renderer.activePartCount);
    const disclosureCount = boundedRenderCount(renderer.disclosureCount);
    const openDisclosureCount = boundedRenderCount(renderer.openDisclosureCount);
    const activityDisclosureCount = boundedRenderCount(renderer.activityDisclosureCount);
    const reasoningDisclosureCount = boundedRenderCount(renderer.reasoningDisclosureCount);
    const toolDisclosureCount = boundedRenderCount(renderer.toolDisclosureCount);
    const overflowDisclosureCount = boundedRenderCount(renderer.overflowDisclosureCount);
    const pendingHydrationCount = boundedRenderCount(renderer.pendingHydrationCount);
    const scrollerRegisteredRowCount = boundedRenderCount(scroller.registeredRowCount);
    const pendingLayoutMutationCount = boundedRenderCount(scroller.pendingLayoutMutationCount);
    if (
      !isRenderState(raw.renderState)
      || renderPassCount === undefined
      || pendingRenderCount === undefined
      || lastRenderDurationMs === undefined
      || maxRenderDurationMs === undefined
      || registeredRowCount === undefined
      || rendererRenderPassCount === undefined
      || rendererPendingRenderPassCount === undefined
      || rendererLastRenderDurationMs === undefined
      || rendererMaxRenderDurationMs === undefined
      || historicalRowCount === undefined
      || historicalPartCount === undefined
      || activePartCount === undefined
      || disclosureCount === undefined
      || openDisclosureCount === undefined
      || activityDisclosureCount === undefined
      || reasoningDisclosureCount === undefined
      || toolDisclosureCount === undefined
      || overflowDisclosureCount === undefined
      || pendingHydrationCount === undefined
      || scrollerRegisteredRowCount === undefined
      || pendingLayoutMutationCount === undefined
      || typeof raw.firstDomCommitObserved !== "boolean"
      || typeof raw.firstPaintOpportunityObserved !== "boolean"
      || typeof renderer.renderingEnabled !== "boolean"
      || !isScrollMode(scroller.mode)
      || !isScrollDistanceBucket(scroller.distanceFromEndBucket)
      || typeof scroller.layoutMutationPending !== "boolean"
      || typeof scroller.geometryUpdatePending !== "boolean"
      || typeof scroller.programmaticScrollPending !== "boolean"
      || typeof scroller.submittedPromptAnchorActive !== "boolean"
      || typeof scroller.destroyed !== "boolean"
    ) return null;
    return {
      render_state: raw.renderState,
      render_pass_count: renderPassCount,
      pending_render_count: pendingRenderCount,
      last_render_duration_ms: lastRenderDurationMs,
      max_render_duration_ms: maxRenderDurationMs,
      first_dom_commit_observed: raw.firstDomCommitObserved,
      first_paint_opportunity_observed: raw.firstPaintOpportunityObserved,
      registered_row_count: registeredRowCount,
      renderer: {
        render_pass_count: rendererRenderPassCount,
        pending_render_pass_count: rendererPendingRenderPassCount,
        last_render_duration_ms: rendererLastRenderDurationMs,
        max_render_duration_ms: rendererMaxRenderDurationMs,
        historical_row_count: historicalRowCount,
        historical_part_count: historicalPartCount,
        active_part_count: activePartCount,
        disclosure_count: disclosureCount,
        open_disclosure_count: openDisclosureCount,
        activity_disclosure_count: activityDisclosureCount,
        reasoning_disclosure_count: reasoningDisclosureCount,
        tool_disclosure_count: toolDisclosureCount,
        overflow_disclosure_count: overflowDisclosureCount,
        pending_hydration_count: pendingHydrationCount,
        rendering_enabled: renderer.renderingEnabled,
      },
      scroller: {
        mode: scroller.mode,
        distance_from_end_bucket: scroller.distanceFromEndBucket,
        registered_row_count: scrollerRegisteredRowCount,
        pending_layout_mutation_count: pendingLayoutMutationCount,
        layout_mutation_pending: scroller.layoutMutationPending,
        geometry_update_pending: scroller.geometryUpdatePending,
        programmatic_scroll_pending: scroller.programmaticScrollPending,
        submitted_prompt_anchor_active: scroller.submittedPromptAnchorActive,
        destroyed: scroller.destroyed,
      },
    };
  } catch {
    return null;
  }
}

function projectRenderingEvidence(
  input: AgentIncidentRenderingEvidenceInput,
): AgentIncidentRenderingEvidence | null {
  try {
    if (!input) return null;
    const beforeInput = input.beforeTerminalPublish;
    const afterInput = input.afterTerminalCommit;
    const failureSurfaceDomCommitted = input.failureSurfaceDomCommitted;
    const failureSurfacePaintOpportunityObserved = input.failureSurfacePaintOpportunityObserved;
    if (
      typeof failureSurfaceDomCommitted !== "boolean"
      || typeof failureSurfacePaintOpportunityObserved !== "boolean"
      || (failureSurfacePaintOpportunityObserved && !failureSurfaceDomCommitted)
    ) return null;
    const before = beforeInput === undefined
      ? undefined
      : projectRenderingSnapshot(beforeInput);
    const after = afterInput === undefined
      ? undefined
      : projectRenderingSnapshot(afterInput);
    if (
      (beforeInput !== undefined && before === null)
      || (afterInput !== undefined && after === null)
      || (failureSurfaceDomCommitted && after === undefined)
    ) return null;
    return {
      ...(before ? { before_terminal_publish: before } : {}),
      ...(after ? { after_terminal_commit: after } : {}),
      failure_surface_dom_committed: failureSurfaceDomCommitted,
      failure_surface_paint_opportunity_observed: failureSurfacePaintOpportunityObserved,
    };
  } catch {
    return null;
  }
}

function copyEnvironment(target: MutableEnvironment, input: AgentIncidentEnvironmentInput): boolean {
  try {
    const raw = {
      pluginVersion: input.pluginVersion,
      pluginBuildId: input.pluginBuildId,
      loadedBundleSha256: input.loadedBundleSha256,
      obsidianVersion: input.obsidianVersion,
      hostType: input.hostType,
      osFamily: input.osFamily,
    };
    const pluginVersion = safeVersion(raw.pluginVersion);
    const pluginBuildId = safePluginBuildId(raw.pluginBuildId);
    const loadedBundleSha256 = typeof raw.loadedBundleSha256 === "string" && SHA_256.test(raw.loadedBundleSha256)
      ? raw.loadedBundleSha256
      : undefined;
    const obsidianVersion = safeVersion(raw.obsidianVersion);
    const hostType = raw.hostType === "desktop" || raw.hostType === "mobile" || raw.hostType === "unknown"
      ? raw.hostType
      : undefined;
    const osFamily = raw.osFamily === "macos"
      || raw.osFamily === "windows"
      || raw.osFamily === "linux"
      || raw.osFamily === "ios"
      || raw.osFamily === "android"
      || raw.osFamily === "unknown"
      ? raw.osFamily
      : undefined;
    if (pluginVersion) target.plugin_version = pluginVersion;
    if (pluginBuildId) target.plugin_build_id = pluginBuildId;
    if (loadedBundleSha256) target.loaded_bundle_sha256 = loadedBundleSha256;
    if (obsidianVersion) target.obsidian_version = obsidianVersion;
    if (hostType) target.host_type = hostType;
    if (osFamily) target.os_family = osFamily;
    return true;
  } catch {
    return false;
  }
}

function projectResourceSample(
  sample: AgentIncidentResourceSampleInput,
  ordinal: number,
): Omit<AgentIncidentResourceSample, never> | null {
  try {
    if (!sample) return null;
    const raw = {
      capturedAt: sample.captured_at,
      heapUsedMB: sample.heap_used_mb,
      heapLimitMB: sample.heap_limit_mb,
      rssMB: sample.rss_mb,
      cpuPercent: sample.cpu_percent,
      eventLoopLagMs: sample.event_loop_lag_ms,
      freezeDeltaMs: sample.freeze_delta_ms,
    };
    const capturedAt = normalizeIsoTimestamp(raw.capturedAt);
    if (!capturedAt) return null;
    const heapUsedMB = boundedMetric(raw.heapUsedMB, 1_000_000);
    const heapLimitMB = boundedMetric(raw.heapLimitMB, 1_000_000);
    const rssMB = boundedMetric(raw.rssMB, 1_000_000);
    const cpuPercent = boundedMetric(raw.cpuPercent, 10_000);
    const eventLoopLagMs = boundedThinAgentTiming(raw.eventLoopLagMs);
    const freezeDeltaMs = boundedThinAgentTiming(raw.freezeDeltaMs);
    return {
      ordinal,
      captured_at: capturedAt,
      ...(heapUsedMB === undefined ? {} : { heap_used_mb: heapUsedMB }),
      ...(heapLimitMB === undefined ? {} : { heap_limit_mb: heapLimitMB }),
      ...(rssMB === undefined ? {} : { rss_mb: rssMB }),
      ...(cpuPercent === undefined ? {} : { cpu_percent: cpuPercent }),
      ...(eventLoopLagMs === undefined ? {} : { event_loop_lag_ms: eventLoopLagMs }),
      ...(freezeDeltaMs === undefined ? {} : { freeze_delta_ms: freezeDeltaMs }),
    };
  } catch {
    return null;
  }
}

function sanitizeCorrelation(input: AgentIncidentCorrelationInput): SafeCorrelation | null {
  try {
    if (!input) return null;
    const conversationId = input.conversationId;
    const rawRequestId = input.requestId;
    if (!isThinAgentConversationId(conversationId)) return null;
    if (!isThinAgentRequestId(rawRequestId)) return null;
    return Object.freeze({ conversationId, requestId: rawRequestId });
  } catch {
    return null;
  }
}

function correlationKey(correlation: SafeCorrelation): string {
  return `${correlation.conversationId}\n${correlation.requestId}`;
}

function setStableIdentifier(
  state: ActiveIncident,
  field: StableIdentifierField,
  value: string | undefined,
): void {
  if (!value || state.conflictedIdentifiers.has(field)) return;
  if (state[field] && state[field] !== value) {
    delete state[field];
    state.conflictedIdentifiers.add(field);
    incrementFailure(state, "terminal_context_unavailable");
    return;
  }
  state[field] = value;
}

function setSegmentCorrelationIdentifier(
  state: ActiveIncident,
  segmentOrdinal: number | undefined,
  value: string | undefined,
): void {
  const scopedOrdinal = segmentOrdinal ?? 0;
  if (
    !value
    || state.conflictedServerLatencyCorrelationSegments.has(scopedOrdinal)
  ) return;
  const current = state.serverLatencyCorrelationIdsBySegment.get(scopedOrdinal);
  if (current && current !== value) {
    state.serverLatencyCorrelationIdsBySegment.delete(scopedOrdinal);
    state.conflictedServerLatencyCorrelationSegments.add(scopedOrdinal);
    incrementFailure(state, "terminal_context_unavailable");
    return;
  }
  state.serverLatencyCorrelationIdsBySegment.set(scopedOrdinal, value);
}

function incrementFailure(state: ActiveIncident, code: AgentIncidentCaptureFailureCode): void {
  state.collectionFailures.set(code, addBoundedCount(state.collectionFailures.get(code) ?? 0, 1));
}

function addBoundedCount(value: number, increment: number): number {
  return Math.min(AGENT_INCIDENT_MAX_COUNT, value + increment);
}

function copyCaptureFailureCodes(
  state: ActiveIncident,
  values: readonly AgentIncidentCaptureFailureCode[] | undefined,
): void {
  if (!Array.isArray(values)) return;
  const count = Math.min(values.length, AGENT_INCIDENT_MAX_CONTEXT_LIST_ITEMS);
  for (let index = 0; index < count; index += 1) {
    const code = values[index];
    if (CAPTURE_FAILURE_CODE_SET.has(code)) incrementFailure(state, code);
  }
}

function toolItemCountsContradict(
  requested: number | undefined,
  completed: number | undefined,
  failed: number | undefined,
): boolean {
  if (requested === undefined) return false;
  if (completed !== undefined && completed > requested) return true;
  if (failed !== undefined && failed > requested) return true;
  return completed !== undefined && failed !== undefined && completed + failed > requested;
}

function isToolLifecycleCode(code: AgentLifecycleCode): boolean {
  return code.startsWith("local_tool_")
    || code.startsWith("tool_result_")
    || code.startsWith("mutation_");
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !RFC3339_UTC_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = new Date(parsed).toISOString();
  return normalized === value ? normalized : null;
}

function timestampToIso(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  try {
    const normalized = new Date(value).toISOString();
    return RFC3339_UTC_TIMESTAMP.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function safeNowIso(now: () => number): { iso: string; usedProvidedClock: boolean } {
  try {
    const value = now();
    const iso = timestampToIso(value);
    if (iso) return { iso, usedProvidedClock: true };
  } catch {
    // Use the runtime clock only for the report envelope fallback.
  }
  return { iso: new Date().toISOString(), usedProvidedClock: false };
}

function safeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && VERSION.test(value) ? value : undefined;
}

function safePluginBuildId(value: unknown): string | undefined {
  return typeof value === "string" && PLUGIN_BUILD_ID.test(value) ? value : undefined;
}

function isTransportSegmentCloseReason(
  value: unknown,
): value is AgentIncidentTransportSegmentCloseReason {
  return typeof value === "string" && TRANSPORT_SEGMENT_CLOSE_REASON_SET.has(value);
}

function isTerminalSource(value: unknown): value is AgentIncidentRunState["terminal_source"] {
  return value === "session_terminal" || value === "message_reconstruction" || value === "local_failure";
}

function isRunOrigin(value: unknown): value is AgentIncidentRunState["run_origin"] {
  return value === "submitted" || value === "recovered";
}

function isRunPhase(value: unknown): value is AgentIncidentRunState["run_phase"] {
  return value === "submitted"
    || value === "thinking"
    || value === "working"
    || value === "waiting"
    || value === "retrying"
    || value === "settling"
    || value === "complete";
}

function isConnectionState(value: unknown): value is AgentIncidentRunState["connection_state"] {
  return value === "idle" || value === "connecting" || value === "open" || value === "closed";
}

function isRenderState(value: unknown): value is AgentIncidentRenderingSnapshot["render_state"] {
  return value === "idle"
    || value === "frame_pending"
    || value === "queued"
    || value === "rendering"
    || value === "rendering_with_pending";
}

function isScrollMode(value: unknown): value is AgentIncidentRenderingSnapshot["scroller"]["mode"] {
  return value === "end" || value === "manual";
}

function isScrollDistanceBucket(
  value: unknown,
): value is AgentIncidentRenderingSnapshot["scroller"]["distance_from_end_bucket"] {
  return value === "at_end"
    || value === "near_end"
    || value === "within_viewport"
    || value === "far_from_end"
    || value === "unknown";
}

function boundedWholeNumber(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? value as number
    : undefined;
}

function boundedRenderCount(value: unknown): number | undefined {
  return boundedWholeNumber(value, AGENT_INCIDENT_MAX_RENDER_COUNT);
}

function boundedRenderDuration(value: unknown): number | undefined {
  return boundedWholeNumber(value, AGENT_INCIDENT_MAX_RENDER_DURATION_MS);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function boundedOrdinal(value: unknown, maximum: number): number | undefined {
  const ordinal = positiveInteger(value);
  return ordinal !== undefined && ordinal <= maximum ? ordinal : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? value as number
    : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= AGENT_INCIDENT_MAX_COUNT
    ? value as number
    : undefined;
}

function boundedMetric(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Math.round(value * 1_000) / 1_000
    : undefined;
}

function isFailureAuthority(value: unknown): value is "server" | "client" | "unknown" {
  return value === "server" || value === "client" || value === "unknown";
}

function isTerminalValidation(value: unknown): value is "validated" | "unvalidated" | "validation_failed" {
  return value === "validated" || value === "unvalidated" || value === "validation_failed";
}

function isNonzeroIncidentId(value: unknown): value is string {
  return isThinAgentIncidentId(value) && value !== `incident_${"0".repeat(32)}`;
}

function isNonzeroLatencyTraceId(value: unknown): value is string {
  return isThinAgentLatencyTraceId(value) && value !== "0".repeat(32);
}

function isNonzeroReportId(value: unknown): value is string {
  return typeof value === "string" && REPORT_ID.test(value) && value !== `report_${"0".repeat(32)}`;
}

function boundedFrozenReportLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 100
    ? value as number
    : AGENT_INCIDENT_MAX_FROZEN_REPORTS;
}

function randomReportId(): string {
  const bytes = new Uint8Array(16);
  const cryptography = typeof window !== "undefined" ? window.crypto : undefined;
  if (!cryptography?.getRandomValues) throw new Error("Secure randomness is unavailable.");
  cryptography.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `report_${hex}`;
}

function jsonBytes(value: unknown): number {
  return utf8ByteLength(canonicalJsonStringify(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
