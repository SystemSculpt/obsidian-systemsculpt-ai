import {
  AGENT_INCIDENT_MISSING_FIELD_CODES,
  AgentIncidentRecorder,
  type AgentIncidentCaptureContext,
  type AgentIncidentEnvironmentInput,
  type AgentIncidentMissingFieldCode,
  type AgentIncidentRenderingEvidenceInput,
  type AgentIncidentRenderingInput,
  type AgentIncidentReport,
  type AgentIncidentRunStateInput,
  type AgentIncidentTransportSegmentInput,
  type ThinAgentLifecycleEvent,
} from "../AgentIncidentRecorder";
import {
  AgentIncidentStore,
  type AgentIncidentStoreAdapter,
} from "../AgentIncidentStore";
import { canonicalJsonStringify, utf8ByteLength } from "../AgentIncidentCanonicalJson";

const CONVERSATION_ID = `conversation_${"1".repeat(32)}`;
const REQUEST_ID = "user-76712c65-86b6-4408-8dfc-6de89d79a479";
const SERVER_RUN_ID = `run_${"2".repeat(32)}`;
const INCIDENT_ID = `incident_${"3".repeat(32)}`;
const REPORT_ID = `report_${"4".repeat(32)}`;
const PLUGIN_BUILD_ID = `sha256:${"5".repeat(64)}`;

const SERIALIZE_ONLY_ADAPTER: AgentIncidentStoreAdapter = {
  exists: async () => false,
  stat: async () => null,
  list: async () => ({ files: [], folders: [] }),
  read: async () => "",
  write: async () => undefined,
  mkdir: async () => undefined,
  remove: async () => undefined,
};

const STORE = new AgentIncidentStore(SERIALIZE_ONLY_ADAPTER);

function completeRunState(): AgentIncidentRunStateInput {
  return {
    terminalSource: "session_terminal",
    runOrigin: "submitted",
    runPhase: "complete",
    connectionState: "closed",
    executingLocalToolCount: 0,
    pendingToolDeliveryCount: 0,
    pendingApprovalDeliveryCount: 0,
    pendingToolTaskCount: 0,
    serverQueued: false,
    runStalled: false,
    awaitingClientWork: false,
    pendingCancel: false,
    pendingRegenerate: false,
    countsTruncated: false,
    elapsedMsTruncated: false,
  };
}

function completeRendering(renderPassCount: number): AgentIncidentRenderingInput {
  return {
    renderState: "idle",
    renderPassCount,
    pendingRenderCount: 0,
    lastRenderDurationMs: 3,
    maxRenderDurationMs: 8,
    firstDomCommitObserved: true,
    firstPaintOpportunityObserved: true,
    registeredRowCount: 2,
    renderer: {
      renderPassCount,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 3,
      maxRenderDurationMs: 8,
      historicalRowCount: 1,
      historicalPartCount: 2,
      activePartCount: 3,
      disclosureCount: 2,
      openDisclosureCount: 0,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 0,
      overflowDisclosureCount: 0,
      pendingHydrationCount: 0,
      renderingEnabled: true,
    },
    scroller: {
      mode: "end",
      distanceFromEndBucket: "at_end",
      registeredRowCount: 2,
      pendingLayoutMutationCount: 0,
      layoutMutationPending: false,
      geometryUpdatePending: false,
      programmaticScrollPending: false,
      submittedPromptAnchorActive: false,
      destroyed: false,
    },
  };
}

function renderingEvidence(
  missing: ReadonlySet<AgentIncidentMissingFieldCode>,
): AgentIncidentRenderingEvidenceInput {
  const afterTerminalCommitMissing = missing.has("rendering_after_terminal_commit");
  const failureSurfaceDomCommitted = !afterTerminalCommitMissing
    && !missing.has("failure_surface_dom_commit");
  return {
    ...(missing.has("rendering_before_terminal_publish")
      ? {}
      : { beforeTerminalPublish: completeRendering(5) }),
    ...(missing.has("rendering_after_terminal_commit")
      ? {}
      : { afterTerminalCommit: completeRendering(6) }),
    failureSurfaceDomCommitted,
    failureSurfacePaintOpportunityObserved: failureSurfaceDomCommitted
      && !missing.has("failure_surface_paint_opportunity"),
  };
}

function captureContext(
  missing: ReadonlySet<AgentIncidentMissingFieldCode>,
): AgentIncidentCaptureContext {
  const environment: AgentIncidentEnvironmentInput = {
    ...(missing.has("environment_plugin_version") ? {} : { pluginVersion: "6.6.0" }),
    ...(missing.has("environment_plugin_build_id") ? {} : { pluginBuildId: PLUGIN_BUILD_ID }),
    ...(missing.has("environment_loaded_bundle_sha256") ? {} : { loadedBundleSha256: "6".repeat(64) }),
    ...(missing.has("environment_obsidian_version") ? {} : { obsidianVersion: "1.13.0" }),
    ...(missing.has("environment_host_type") ? {} : { hostType: "desktop" as const }),
    ...(missing.has("environment_os_family") ? {} : { osFamily: "macos" as const }),
  };
  return {
    ...(missing.has("failure_authority") ? {} : { failureAuthority: "server" as const }),
    ...(missing.has("failure_stage") ? {} : { failureStage: "response_terminal" as const }),
    ...(missing.has("failure_mechanism") ? {} : { failureMechanism: "service_terminal" as const }),
    ...(missing.has("terminal_validation") ? {} : { terminalValidation: "validated" as const }),
    ...(missing.has("host_process_state") ? {} : { hostProcessState: "responsive" as const }),
    ...(missing.has("chat_view_state") ? {} : { chatViewState: "mounted" as const }),
    ...(missing.has("assistant_text_part_count") ? {} : { assistantTextPartCount: 1 }),
    ...(missing.has("assistant_text_streaming_part_count") ? {} : { assistantTextStreamingPartCount: 1 }),
    ...(missing.has("assistant_text_complete_part_count") ? {} : { assistantTextCompletePartCount: 0 }),
    ...(missing.has("assistant_text_character_count") ? {} : { assistantTextCharacterCount: 91 }),
    ...(missing.has("reasoning_part_count") ? {} : { reasoningPartCount: 2 }),
    ...(missing.has("reasoning_streaming_part_count") ? {} : { reasoningStreamingPartCount: 1 }),
    ...(missing.has("reasoning_complete_part_count") ? {} : { reasoningCompletePartCount: 1 }),
    ...(missing.has("reasoning_character_count") ? {} : { reasoningCharacterCount: 420 }),
    ...(missing.has("assistant_output_present_before_failure") ? {} : { assistantOutputPresentBeforeFailure: true }),
    ...(missing.has("assistant_output_retained_in_failed_projection")
      ? {}
      : { assistantOutputRetainedInFailedProjection: !missing.has("assistant_output_present_before_failure") }),
    snapshotPartCount: 4,
    ...(missing.has("duration_ms") ? {} : { elapsedMs: 35_695 }),
    environment,
    ...(missing.has("run_state") ? {} : { runState: completeRunState() }),
    ...(missing.has("rendering") ? {} : { rendering: renderingEvidence(missing) }),
  };
}

function transportSegment(segmentOrdinal: number): AgentIncidentTransportSegmentInput {
  return {
    commandKind: "submit",
    commandSegmentOrdinal: segmentOrdinal,
    closeReason: "response_rejected",
    durationMs: 35_695,
    receivedBytes: 4_096,
    nonEmptyRawChunkCount: 8,
    sseEventCount: 7,
    acceptedFrameCount: 6,
    deliveredFrameCount: 6,
    metricsTruncated: false,
  };
}

function recorderReport(
  missingFields: readonly AgentIncidentMissingFieldCode[],
): AgentIncidentReport {
  const missing = new Set(missingFields);
  const recorder = new AgentIncidentRecorder({
    now: () => Date.parse("2026-08-13T14:01:00.000Z"),
    createReportId: () => REPORT_ID,
  });
  const correlation = { conversationId: CONVERSATION_ID, requestId: REQUEST_ID };
  const event = (
    code: ThinAgentLifecycleEvent["code"],
    sequence: number,
    extra: Partial<ThinAgentLifecycleEvent> = {},
  ): ThinAgentLifecycleEvent => ({
    timestamp: new Date(Date.UTC(2026, 7, 13, 14, 0, 0, sequence)).toISOString(),
    severity: "info",
    code,
    phase: code.includes("tool") ? "tool_execution" : "response",
    sequence,
    conversation_id: CONVERSATION_ID,
    request_id: REQUEST_ID,
    ...(missing.has("environment_plugin_build_id") ? {} : { plugin_build_id: PLUGIN_BUILD_ID }),
    ...extra,
  });

  if (!missing.has("run_started")) {
    expect(recorder.record(event("run_started", 1, {
      run_id: SERVER_RUN_ID,
      ...(missing.has("server_run_id") ? {} : { server_run_id: SERVER_RUN_ID }),
      latency_trace_id: "7".repeat(32),
    }))).toBe(true);
  }
  if (missing.has("tool_execution_ordinal")) {
    expect(recorder.record(event("local_tool_started", 2, { tool_name: "read" }))).toBe(true);
  }
  expect(recorder.record(event("run_finished_failed", 9, {
    timestamp: "2026-08-13T14:00:35.695Z",
    run_id: SERVER_RUN_ID,
    ...(missing.has("server_run_id") ? {} : { server_run_id: SERVER_RUN_ID }),
    ...(missing.has("server_incident_id") ? {} : { incident_id: INCIDENT_ID }),
    ...(missing.has("failure_code") ? {} : { failure_code: "response_capacity_unavailable" }),
    retryable: true,
    status: 503,
    command_kind: "submit",
    command_segment_ordinal: 1,
  }))).toBe(true);

  if (!missing.has("transport_segments")) {
    expect(recorder.attachTransportSegment(
      correlation,
      transportSegment(missing.has("terminal_transport_segment") ? 2 : 1),
    )).toBe(true);
  }
  if (!missing.has("resource_samples")) {
    expect(recorder.attachResourceSamples(correlation, [{
      captured_at: "2026-08-13T14:00:35.690Z",
      heap_used_mb: 213.457,
      heap_limit_mb: 4_096,
      rss_mb: 400,
      cpu_percent: 7.5,
      event_loop_lag_ms: 9,
      freeze_delta_ms: 0,
    }])).toBe(true);
  }

  const report = recorder.finalize(correlation, captureContext(missing));
  expect(report).not.toBeNull();
  return report!;
}

function expectExactRecorderStoreBytes(report: AgentIncidentReport): void {
  const recorderBytes = canonicalJsonStringify(report);
  const storeBytes = STORE.serialize(report);

  expect(storeBytes).toBe(recorderBytes);
  expect(utf8ByteLength(storeBytes)).toBe(report.capture_quality.report_bytes);
}

describe("Agent incident recorder-to-store missing-field contract", () => {
  it("serializes a complete recorder report", () => {
    const report = recorderReport([]);

    expect(report.capture_quality.missing_fields).toEqual([]);
    expectExactRecorderStoreBytes(report);
  });

  it.each(AGENT_INCIDENT_MISSING_FIELD_CODES)(
    "serializes a recorder report with missing field %s",
    (missingField) => {
      const report = recorderReport([missingField]);

      expect(report.capture_quality.missing_fields).toContain(missingField);
      expect(report.capture_quality.missing_fields).toEqual(
        AGENT_INCIDENT_MISSING_FIELD_CODES.filter((field) => (
          report.capture_quality.missing_fields.includes(field)
        )),
      );
      expectExactRecorderStoreBytes(report);
    },
  );

  it("serializes representative missing-field combinations in canonical order", () => {
    const requested = [
      "reasoning_character_count",
      "rendering_after_terminal_commit",
      "resource_samples",
      "terminal_transport_segment",
    ] as const;
    const expected = [
      "reasoning_character_count",
      "rendering_after_terminal_commit",
      "failure_surface_dom_commit",
      "failure_surface_paint_opportunity",
      "resource_samples",
      "terminal_transport_segment",
    ] as const;
    const report = recorderReport(requested);

    expect(report.capture_quality.missing_fields).toEqual(expected);
    expectExactRecorderStoreBytes(report);
  });

  it("serializes a report missing every closed-schema field in canonical order", () => {
    const report = recorderReport(AGENT_INCIDENT_MISSING_FIELD_CODES);

    expect(report.capture_quality.missing_fields).toEqual(AGENT_INCIDENT_MISSING_FIELD_CODES);
    expectExactRecorderStoreBytes(report);
  });
});
