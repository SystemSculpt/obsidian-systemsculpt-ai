import {
  AGENT_INCIDENT_MAX_EVENTS,
  AGENT_INCIDENT_MAX_ACTIVE_RUNS,
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_MAX_RESOURCE_SAMPLES,
  AGENT_INCIDENT_MAX_TOOLS,
  AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS,
  AgentIncidentRecorder,
  type AgentIncidentCaptureContext,
  type AgentIncidentRenderingInput,
  type AgentIncidentReport,
  type AgentIncidentRunStateInput,
  type AgentIncidentTransportSegmentInput,
  type ThinAgentLifecycleEvent,
} from "../AgentIncidentRecorder";
import {
  AGENT_INCIDENT_EXPORTED_FAILURE_CODES,
  normalizeAgentIncidentFailureCode,
} from "../AgentIncidentSchema";

const CONVERSATION_ID = `conversation_${"1".repeat(32)}`;
const REQUEST_ID = "user-76712c65-86b6-4408-8dfc-6de89d79a479";
const SERVER_RUN_ID = `run_${"2".repeat(32)}`;
const INCIDENT_ID = `incident_${"3".repeat(32)}`;
const REPORT_ID = `report_${"4".repeat(32)}`;
const PLUGIN_BUILD_ID = `sha256:${"5".repeat(64)}`;
const ZERO_INCIDENT_ID = `incident_${"0".repeat(32)}`;
const ZERO_REPORT_ID = `report_${"0".repeat(32)}`;
const ZERO_RUN_ID = `run_${"0".repeat(32)}`;

function completeRunState(
  extra: Partial<AgentIncidentRunStateInput> = {},
): AgentIncidentRunStateInput {
  return {
    terminalSource: "session_terminal",
    runOrigin: "submitted",
    runPhase: "settling",
    connectionState: "open",
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
    ...extra,
  };
}

function completeRendering(
  extra: Partial<AgentIncidentRenderingInput> = {},
): AgentIncidentRenderingInput {
  return {
    renderState: "idle",
    renderPassCount: 8,
    pendingRenderCount: 0,
    lastRenderDurationMs: 7,
    maxRenderDurationMs: 12,
    firstDomCommitObserved: true,
    firstPaintOpportunityObserved: true,
    registeredRowCount: 2,
    renderer: {
      renderPassCount: 8,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 7,
      maxRenderDurationMs: 12,
      historicalRowCount: 1,
      historicalPartCount: 3,
      activePartCount: 2,
      disclosureCount: 3,
      openDisclosureCount: 0,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 1,
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
    ...extra,
  };
}

function completeRenderingEvidence() {
  return {
    beforeTerminalPublish: completeRendering({
      firstDomCommitObserved: true,
      firstPaintOpportunityObserved: true,
    }),
    afterTerminalCommit: completeRendering({
      renderPassCount: 9,
      firstDomCommitObserved: true,
      firstPaintOpportunityObserved: true,
    }),
    failureSurfaceDomCommitted: true,
    failureSurfacePaintOpportunityObserved: true,
  };
}

function transportSegment(
  segmentOrdinal = 1,
  extra: Partial<AgentIncidentTransportSegmentInput> = {},
): AgentIncidentTransportSegmentInput {
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
    ...extra,
  };
}

function event(
  code: ThinAgentLifecycleEvent["code"],
  sequence: number,
  extra: Partial<ThinAgentLifecycleEvent> = {},
): ThinAgentLifecycleEvent {
  return {
    timestamp: new Date(Date.UTC(2026, 7, 13, 14, 0, 0, sequence)).toISOString(),
    severity: "info",
    code,
    phase: code.includes("tool") ? "tool_execution" : "response",
    sequence,
    conversation_id: CONVERSATION_ID,
    request_id: REQUEST_ID,
    plugin_build_id: PLUGIN_BUILD_ID,
    ...extra,
  };
}

function completeContext(extra: Partial<AgentIncidentCaptureContext> = {}): AgentIncidentCaptureContext {
  return {
    failureAuthority: "server",
    failureStage: "response_terminal",
    failureMechanism: "service_terminal",
    terminalValidation: "validated",
    hostProcessState: "responsive",
    chatViewState: "mounted",
    assistantTextPartCount: 1,
    assistantTextStreamingPartCount: 1,
    assistantTextCompletePartCount: 0,
    assistantTextCharacterCount: 91,
    reasoningPartCount: 2,
    reasoningStreamingPartCount: 1,
    reasoningCompletePartCount: 1,
    reasoningCharacterCount: 420,
    assistantOutputPresentBeforeFailure: true,
    assistantOutputRetainedInFailedProjection: true,
    snapshotPartCount: 7,
    elapsedMs: 35_695,
    runState: completeRunState(),
    rendering: completeRenderingEvidence(),
    environment: {
      pluginVersion: "6.6.0",
      pluginBuildId: PLUGIN_BUILD_ID,
      loadedBundleSha256: "6".repeat(64),
      obsidianVersion: "1.13.0",
      hostType: "desktop",
      osFamily: "macos",
    },
    ...extra,
  };
}

function recordFailure(recorder: AgentIncidentRecorder): void {
  expect(recorder.record(event("run_started", 1, {
    run_id: SERVER_RUN_ID,
    server_run_id: SERVER_RUN_ID,
    latency_trace_id: "7".repeat(32),
  }))).toBe(true);
  expect(recorder.record(event("run_finished_failed", 9, {
    timestamp: "2026-08-13T14:00:35.695Z",
    run_id: SERVER_RUN_ID,
    server_run_id: SERVER_RUN_ID,
    incident_id: INCIDENT_ID,
    failure_code: "response_capacity_unavailable",
    retryable: true,
    status: 503,
  }))).toBe(true);
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value as Record<string, unknown>)) {
    expectDeeplyFrozen(child, seen);
  }
}

function reportBytes(report: AgentIncidentReport): number {
  return new TextEncoder().encode(JSON.stringify(report)).byteLength;
}

describe("AgentIncidentRecorder", () => {
  it.each(["server", "client"] as const)(
    "preserves every exported failure code for %s authority",
    (authority) => {
      expect(Object.isFrozen(AGENT_INCIDENT_EXPORTED_FAILURE_CODES)).toBe(true);
      for (const code of AGENT_INCIDENT_EXPORTED_FAILURE_CODES) {
        expect(normalizeAgentIncidentFailureCode(code, authority)).toBe(code);
      }
    },
  );

  it.each([
    ["server", "unknown_server_failure"],
    ["client", "unknown_client_failure"],
  ] as const)(
    "uses the %s authority fallback for an unrecognized safe code",
    (authority, fallback) => {
      expect(normalizeAgentIncidentFailureCode(
        "future_failure_code",
        authority,
      )).toBe(fallback);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "UPPER_CASE",
    "contains-hyphen",
    "a".repeat(65),
    503,
  ])("rejects malformed failure code %p for both authorities", (code) => {
    expect(normalizeAgentIncidentFailureCode(code, "server")).toBeUndefined();
    expect(normalizeAgentIncidentFailureCode(code, "client")).toBeUndefined();
  });

  it("freezes a deterministic content-free failed-run report", () => {
    const recorder = new AgentIncidentRecorder({
      now: () => Date.UTC(2026, 7, 13, 14, 1),
      createReportId: () => REPORT_ID,
    });
    expect(recorder.record(event("run_started", 1, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: "7".repeat(32),
    }))).toBe(true);
    expect(recorder.record(event("local_tool_started", 2, {
      tool_name: "read",
      tool_execution_ordinal: 1,
    }))).toBe(true);
    expect(recorder.record(event("local_tool_completed_failed", 3, {
      tool_name: "read",
      tool_execution_ordinal: 1,
      tool_outcome: "failed",
      tool_failure_class: "partial_failure",
      tool_item_count: 4,
      tool_completed_item_count: 3,
      tool_failed_item_count: 1,
    }))).toBe(true);
    expect(recorder.record(event("tool_result_sent_failed", 4, {
      tool_name: "read",
      tool_execution_ordinal: 1,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 5, {
      timestamp: "2026-08-13T14:00:35.695Z",
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
      retryable: true,
      status: 503,
      command_segment_ordinal: 1,
    }))).toBe(true);
    expect(recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(1),
    )).toBe(true);
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      [{
        captured_at: "2026-08-13T14:00:35.690Z",
        heap_used_mb: 213.4567,
        heap_limit_mb: 4096,
        rss_mb: 400,
        cpu_percent: 7.5,
        event_loop_lag_ms: 9,
      }],
    )).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );
    expect(report).toMatchObject({
      schema_version: "systemsculpt.incident/2",
      report_id: REPORT_ID,
      incident: {
        classification: "operation_failure",
        impact: "run_failed",
        severity_text: "ERROR",
        severity_number: 17,
        failure_authority: "server",
        origin: "agent_terminal",
        terminal_evidence: "server_protocol_validated",
        artifact_integrity: "unauthenticated_client_record",
        evidence_scope: "client_observation_only",
        causal_assessment: "not_established",
        observation_source: "server_protocol_terminal",
        failure_stage: "response_terminal",
        failure_mechanism: "service_terminal",
        incident_id: INCIDENT_ID,
        failure_code: "response_capacity_unavailable",
        retryable: true,
        http_status: 503,
      },
      correlation: {
        run_id: SERVER_RUN_ID,
        server_run_id: SERVER_RUN_ID,
      },
      grouping: {
        strategy: "systemsculpt.failure-contract/1",
        fingerprint: "systemsculpt.failure-contract/1|authority=server|stage=response_terminal|mechanism=service_terminal|failure=response_capacity_unavailable|status=5xx|terminal=session_terminal",
      },
      run_summary: {
        duration_ms: 35_695,
        duration_clock_domain: "client_turn_monotonic",
        terminal_receipt: "client_received_server_terminal",
        terminal_validation: "validated",
        observed_lifecycle_event_count: 5,
        partial_output: {
          assistant_text_part_count: 1,
          assistant_text_streaming_part_count: 1,
          assistant_text_complete_part_count: 0,
          assistant_text_character_count: 91,
          reasoning_part_count: 2,
          reasoning_streaming_part_count: 1,
          reasoning_complete_part_count: 1,
          reasoning_character_count: 420,
          assistant_output_present_before_failure: true,
          assistant_output_retained_in_failed_projection: true,
        },
      },
      run_state: {
        terminal_source: "session_terminal",
        run_origin: "submitted",
        run_phase: "settling",
        connection_state: "open",
      },
      tools: [{
        ordinal: 1,
        tool_name: "read",
        outcome: "failed",
        failure_class: "partial_failure",
        requested_item_count: 4,
        completed_item_count: 3,
        failed_item_count: 1,
        result_delivery: "failed",
      }],
      transport_segments: [{
        command_kind: "submit",
        segment_ordinal: 1,
        close_reason: "response_rejected",
        duration_ms: 35_695,
        received_bytes: 4_096,
        raw_chunk_count: 8,
        sse_event_count: 7,
        accepted_frame_count: 6,
        delivered_frame_count: 6,
        metrics_truncated: false,
      }],
      rendering: {
        before_terminal_publish: {
          render_state: "idle",
          render_pass_count: 8,
          first_dom_commit_observed: true,
          first_paint_opportunity_observed: true,
          renderer: {
            disclosure_count: 3,
            rendering_enabled: true,
          },
          scroller: {
            mode: "end",
            distance_from_end_bucket: "at_end",
          },
        },
        after_terminal_commit: { render_pass_count: 9 },
        failure_surface_dom_committed: true,
        failure_surface_paint_opportunity_observed: true,
      },
      resource_samples: [{
        ordinal: 1,
        captured_at: "2026-08-13T14:00:35.690Z",
        heap_used_mb: 213.457,
        cpu_percent: 7.5,
      }],
      capture_quality: {
        complete: true,
        truncated: false,
        missing_fields: [],
        collection_failures: [],
      },
      privacy: {
        policy: "strict_allowlist_content_free",
        storage_target: "vault_local",
        host_sync: "may_sync_with_vault",
        automatic_upload: false,
      },
    });
    expect(report).not.toBeNull();
    expectDeeplyFrozen(report);
    expect(reportBytes(report!)).toBe(report!.capture_quality.report_bytes);
    expect(reportBytes(report!)).toBeLessThan(AGENT_INCIDENT_MAX_REPORT_BYTES);
    const frozenBytes = JSON.stringify(report);
    expect(() => {
      (report!.tools as unknown as unknown[]).push({ ordinal: 2 });
    }).toThrow(TypeError);
    expect(JSON.stringify(report)).toBe(frozenBytes);
    expect(recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      { failureAuthority: "client" },
    )).toBe(report);
    expect(recorder.getByReportId(REPORT_ID)).toBe(report);
    expect(recorder.getByIncidentId(INCIDENT_ID)).toBe(report);
  });

  it("does not invoke inherited toJSON hooks while sizing reports", () => {
    const recorder = new AgentIncidentRecorder({
      now: () => Date.UTC(2026, 7, 13, 14, 1),
      createReportId: () => REPORT_ID,
    });
    recordFailure(recorder);
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let arrayCalls = 0;
    let objectCalls = 0;
    let report: AgentIncidentReport | null = null;

    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => {
          arrayCalls += 1;
          return { private_array_canary: true };
        },
      });
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => {
          objectCalls += 1;
          return { private_object_canary: true };
        },
      });
      report = recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      );
    } finally {
      if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
      if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }

    expect(arrayCalls).toBe(0);
    expect(objectCalls).toBe(0);
    expect(report).not.toBeNull();
    expect(reportBytes(report!)).toBe(report!.capture_quality.report_bytes);
    expect(JSON.stringify(report)).not.toContain("private_array_canary");
    expect(JSON.stringify(report)).not.toContain("private_object_canary");
  });

  it("keeps the first transport window plus the newest segments without exporting live join keys", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    for (let ordinal = 1; ordinal <= AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS + 1; ordinal += 1) {
      const hostile = {
        ...transportSegment(ordinal, {
          commandKind: ordinal % 2 === 0 ? "client_tool_result" : "submit",
          toolExecutionOrdinal: ordinal <= 512 ? ordinal : undefined,
        }),
        conversationId: "conversation-private-canary",
        requestId: "request-private-canary",
        toolCallId: "tool-call-private-canary",
        path: "/private/transport/path-canary",
      } as unknown as AgentIncidentTransportSegmentInput;
      expect(recorder.attachTransportSegment(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        hostile,
      )).toBe(true);
    }
    expect(recorder.record(event("run_finished_failed", 2, {
      command_segment_ordinal: AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS + 1,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.transport_segments).toHaveLength(AGENT_INCIDENT_MAX_TRANSPORT_SEGMENTS);
    expect(report.transport_segments.map((segment) => segment.segment_ordinal)).toEqual([
      ...Array.from({ length: 16 }, (_, index) => index + 1),
      ...Array.from({ length: 48 }, (_, index) => index + 18),
    ]);
    expect(report.transport_segments[0]).toEqual({
      command_kind: "submit",
      segment_ordinal: 1,
      tool_execution_ordinal: 1,
      close_reason: "response_rejected",
      duration_ms: 35_695,
      received_bytes: 4_096,
      raw_chunk_count: 8,
      sse_event_count: 7,
      accepted_frame_count: 6,
      delivered_frame_count: 6,
      metrics_truncated: false,
    });
    expect(report.capture_quality).toMatchObject({
      truncated: true,
      dropped_transport_segment_count: 1,
    });
    expect(report.capture_quality.missing_fields).not.toContain("terminal_transport_segment");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("conversation-private-canary");
    expect(serialized).not.toContain("request-private-canary");
    expect(serialized).not.toContain("tool-call-private-canary");
    expect(serialized).not.toContain("transport/path-canary");
  });

  it("fails closed on invalid and hostile transport summaries", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    expect(recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(0),
    )).toBe(false);
    expect(recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(1, { receivedBytes: 64 * 1024 * 1024 + 1 }),
    )).toBe(false);
    const revoked = Proxy.revocable(transportSegment(2), {});
    revoked.revoke();
    expect(() => recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      revoked.proxy,
    )).not.toThrow();
    expect(recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      revoked.proxy,
    )).toBe(false);
    let getterReads = 0;
    const changing = transportSegment(3) as { closeReason: string };
    Object.defineProperty(changing, "closeReason", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterReads === 1 ? "clean_eof" : "private-close-reason-canary";
      },
    });
    expect(recorder.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      changing as AgentIncidentTransportSegmentInput,
    )).toBe(true);
    expect(getterReads).toBe(1);
    expect(recorder.record(event("run_finished_failed", 2, {
      command_segment_ordinal: 3,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(report.transport_segments).toHaveLength(1);
    expect(report.transport_segments[0].close_reason).toBe("clean_eof");
    expect(report.capture_quality.collection_failures).toContainEqual({
      code: "transport_segment_invalid",
      count: 4,
    });
    expect(JSON.stringify(report)).not.toContain("private-close-reason-canary");
  });

  it("does not retain forbidden fields from hostile lifecycle, context, or resource objects", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const canaries = [
      "secret prompt",
      "secret assistant",
      "secret reasoning",
      "Private.md",
      "/Users/private/Vault/Private.md",
      "https://private.example",
      "license-secret",
      "raw provider stack",
      "tool-call-secret",
      "private search query",
      "private-machine.local",
    ];
    const hostile = {
      ...event("local_tool_started", 1, {
        tool_name: "read",
        tool_execution_ordinal: 1,
      }),
      prompt: canaries[0],
      content: canaries[1],
      reasoning: canaries[2],
      fileName: canaries[3],
      path: canaries[4],
      url: canaries[5],
      licenseKey: canaries[6],
      stack: canaries[7],
      tool_call_id: canaries[8],
      query: canaries[9],
      hostname: canaries[10],
      input: { secret: canaries[0] },
      output: { secret: canaries[1] },
      model: "private-model",
      provider: "private-provider",
    } as unknown as ThinAgentLifecycleEvent;
    expect(recorder.record(hostile)).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      incident_id: INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
    }))).toBe(true);
    const hostileContext = {
      ...completeContext(),
      prompt: canaries[0],
      error: { stack: canaries[7] },
      environment: {
        ...completeContext().environment,
        hostname: canaries[10],
        vaultName: "Private Vault",
        username: "private-user",
      },
    } as unknown as AgentIncidentCaptureContext;
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      [{
        captured_at: "2026-08-13T14:00:00.000Z",
        heap_used_mb: 211,
        note: canaries[3],
        path: canaries[4],
      } as unknown as Parameters<AgentIncidentRecorder["attachResourceSamples"]>[1][number]],
    )).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      hostileContext,
    );
    const serialized = JSON.stringify(report);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("private-model");
    expect(serialized).not.toContain("private-provider");
    expect(report?.timeline.every((item) => !("tool_call_id" in item))).toBe(true);
    expect(serialized).not.toContain("client_instance_id");
  });

  it("projects the full rendering, scroll, and failed-run state from closed scalar allowlists", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);
    const runState = {
      ...completeRunState({
        terminalSource: "message_reconstruction",
        runOrigin: "recovered",
        runPhase: "retrying",
        connectionState: "closed",
        executingLocalToolCount: 2,
        pendingToolDeliveryCount: 3,
        pendingApprovalDeliveryCount: 4,
        pendingToolTaskCount: 5,
        serverQueued: true,
        runStalled: true,
        awaitingClientWork: true,
        pendingCancel: true,
        pendingRegenerate: true,
        countsTruncated: true,
        elapsedMsTruncated: true,
      }),
      prompt: "private-run-state-prompt-canary",
      toolCallId: "private-run-state-call-canary",
    } as unknown as AgentIncidentRunStateInput;
    const renderingSnapshot = {
      ...completeRendering({
        renderState: "rendering_with_pending",
        pendingRenderCount: 2,
      }),
      messageText: "private-render-content-canary",
      renderer: {
        ...completeRendering().renderer,
        sourcePath: "/private/render/path-canary",
      },
      scroller: {
        ...completeRendering().scroller,
        rowId: "private-scroll-row-canary",
        mode: "manual",
        distanceFromEndBucket: "far_from_end",
        pendingLayoutMutationCount: 1,
        layoutMutationPending: true,
      },
    } as unknown as AgentIncidentRenderingInput;
    const rendering = {
      beforeTerminalPublish: completeRendering(),
      afterTerminalCommit: renderingSnapshot,
      failureSurfaceDomCommitted: true,
      failureSurfacePaintOpportunityObserved: true,
    };
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({ runState, rendering }),
    )!;

    expect(report.run_state).toEqual({
      terminal_source: "message_reconstruction",
      run_origin: "recovered",
      run_phase: "retrying",
      connection_state: "closed",
      executing_local_tool_count: 2,
      pending_tool_delivery_count: 3,
      pending_approval_delivery_count: 4,
      pending_tool_task_count: 5,
      server_queued: true,
      run_stalled: true,
      awaiting_client_work: true,
      pending_cancel: true,
      pending_regenerate: true,
      counts_truncated: true,
      elapsed_ms_truncated: true,
    });
    expect(report.rendering).toMatchObject({
      after_terminal_commit: {
        render_state: "rendering_with_pending",
        pending_render_count: 2,
        renderer: {
          historical_row_count: 1,
          historical_part_count: 3,
          active_part_count: 2,
          reasoning_disclosure_count: 1,
          tool_disclosure_count: 1,
        },
        scroller: {
          mode: "manual",
          distance_from_end_bucket: "far_from_end",
          pending_layout_mutation_count: 1,
          layout_mutation_pending: true,
        },
      },
      failure_surface_dom_committed: true,
      failure_surface_paint_opportunity_observed: true,
    });
    expectDeeplyFrozen(report.run_state);
    expectDeeplyFrozen(report.rendering);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("private-run-state");
    expect(serialized).not.toContain("private-render");
    expect(serialized).not.toContain("private-scroll");
  });

  it("marks invalid rendering and run-state evidence missing without throwing", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);
    const invalidRunState = completeRunState({
      executingLocalToolCount: 100_000_001,
    });
    const throwingRenderer = new Proxy(completeRendering().renderer, {
      get: () => {
        throw new Error("private-render-getter-canary");
      },
    });
    const invalidRendering = {
      beforeTerminalPublish: completeRendering(),
      afterTerminalCommit: {
        ...completeRendering(),
        renderer: throwingRenderer,
      },
      failureSurfaceDomCommitted: true,
      failureSurfacePaintOpportunityObserved: true,
    };
    let report: AgentIncidentReport | null = null;
    expect(() => {
      report = recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext({
          runState: invalidRunState,
          rendering: invalidRendering,
        }),
      );
    }).not.toThrow();

    expect(report).not.toBeNull();
    expect(report!.run_state).toBeUndefined();
    expect(report!.rendering).toBeUndefined();
    expect(report!.capture_quality.missing_fields).toEqual(expect.arrayContaining([
      "run_state",
      "rendering",
      "transport_segments",
    ]));
    expect(report!.capture_quality.collection_failures).toEqual(expect.arrayContaining([
      { code: "run_state_invalid", count: 1 },
      { code: "rendering_snapshot_invalid", count: 1 },
    ]));
    expect(JSON.stringify(report)).not.toContain("private-render-getter-canary");
  });

  it("never enumerates, serializes, or follows hostile caller-owned values", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const privateSymbol = Symbol("private-symbol-canary");
    const cycle: Record<string, unknown> = { secret: "cycle-secret-canary" };
    cycle.self = cycle;
    let forbiddenGetterReads = 0;
    let toJSONCalls = 0;
    const source = {
      ...event("run_started", 1, {
        run_id: SERVER_RUN_ID,
        server_run_id: SERVER_RUN_ID,
      }),
      cycle,
      [privateSymbol]: "symbol-secret-canary",
      toJSON: () => {
        toJSONCalls += 1;
        throw new Error("tojson-secret-canary");
      },
    } as unknown as ThinAgentLifecycleEvent;
    Object.defineProperty(source, "prompt", {
      enumerable: true,
      get: () => {
        forbiddenGetterReads += 1;
        throw new Error("getter-secret-canary");
      },
    });
    const noEnumeration = new Proxy(source, {
      ownKeys: () => {
        throw new Error("ownkeys-secret-canary");
      },
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor-secret-canary");
      },
    });

    expect(recorder.record(noEnumeration)).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
    }))).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );

    expect(forbiddenGetterReads).toBe(0);
    expect(toJSONCalls).toBe(0);
    const serialized = JSON.stringify(report);
    expect(toJSONCalls).toBe(0);
    expect(serialized).not.toContain("cycle-secret-canary");
    expect(serialized).not.toContain("symbol-secret-canary");
    expect(serialized).not.toContain("getter-secret-canary");
    expect(serialized).not.toContain("tojson-secret-canary");
  });

  it("fails closed when allowed getters or proxies throw without blocking the failed-run report", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const timestampFailure = new Proxy(event("run_started", 1), {
      get: (target, property, receiver) => {
        if (property === "timestamp") throw new Error("timestamp-secret-canary");
        return Reflect.get(target, property, receiver);
      },
    });
    const correlationFailure = new Proxy(event("run_started", 1), {
      get: (target, property, receiver) => {
        if (property === "conversation_id") throw new Error("correlation-secret-canary");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => recorder.record(timestampFailure)).not.toThrow();
    expect(recorder.record(timestampFailure)).toBe(false);
    expect(() => recorder.record(correlationFailure)).not.toThrow();
    expect(recorder.record(correlationFailure)).toBe(false);

    recordFailure(recorder);
    const hostileEnvironment = new Proxy({}, {
      get: () => {
        throw new Error("environment-secret-canary");
      },
    }) as AgentIncidentCaptureContext["environment"];
    expect(recorder.attachEnvironment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      hostileEnvironment!,
    )).toBe(false);
    const throwingSample = new Proxy({}, {
      get: () => {
        throw new Error("resource-secret-canary");
      },
    }) as Parameters<AgentIncidentRecorder["attachResourceSamples"]>[1][number];
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      [throwingSample, { captured_at: "2026-08-13T14:00:35.690Z", cpu_percent: 8 }],
    )).toBe(true);
    const hostileContext = new Proxy({}, {
      get: () => {
        throw new Error("context-secret-canary");
      },
    }) as AgentIncidentCaptureContext;

    let report: AgentIncidentReport | null = null;
    expect(() => {
      report = recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        hostileContext,
      );
    }).not.toThrow();
    expect(report).not.toBeNull();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-canary");
    expect(report!.resource_samples).toHaveLength(1);
    expect(report!.capture_quality.collection_failures).toEqual(expect.arrayContaining([
      { code: "environment_unavailable", count: 1 },
      { code: "resource_sample_invalid", count: 1 },
      { code: "terminal_context_unavailable", count: 1 },
    ]));
    expect(() => recorder.finalize(
      new Proxy({} as AgentIncidentCaptureContext & { conversationId: string; requestId: string }, {
        get: () => {
          throw new Error("correlation-input-secret-canary");
        },
      }),
    )).not.toThrow();
    expect(recorder.getByReportId(Symbol("report-secret") as unknown as string)).toBeNull();
  });

  it("ignores removed caller-supplied missing-field declarations without reading them", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);
    const context = completeContext() as AgentIncidentCaptureContext & {
      missingFields?: readonly string[];
    };
    let reads = 0;
    Object.defineProperty(context, "missingFields", {
      enumerable: true,
      get: () => {
        reads += 1;
        return ["tool_execution_ordinal"];
      },
    });

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      context,
    );

    expect(reads).toBe(0);
    expect(report?.capture_quality.missing_fields).not.toContain("tool_execution_ordinal");
  });

  it("rejects filename-like correlation IDs and normalizes unknown failure codes", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record({
      ...event("run_started", 1),
      request_id: "Private.md",
    })).toBe(false);
    expect(recorder.record({
      ...event("run_started", 1),
      plugin_build_id: "Private.md",
      run_id: "Private.md",
    })).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      incident_id: INCIDENT_ID,
      failure_code: "customer_secret_phrase",
    }))).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );
    expect(report?.incident.failure_code).toBe("unknown_server_failure");
    expect(report?.environment.plugin_build_id).toBe(PLUGIN_BUILD_ID);
    expect(report?.correlation.run_id).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("customer_secret_phrase");
    expect(JSON.stringify(report)).not.toContain("Private.md");
  });

  it("preserves the closed client failure fallback code", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      incident_id: INCIDENT_ID,
      failure_code: "unknown_client_failure",
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        failureAuthority: "client",
        terminalValidation: "unvalidated",
        runState: completeRunState({ terminalSource: "local_failure" }),
      }),
    );

    expect(report?.incident).toMatchObject({
      failure_authority: "client",
      origin: "agent_local_failure",
      terminal_evidence: "client_observed",
      failure_code: "unknown_client_failure",
    });
    expect(report?.run_summary.terminal_receipt).toBe("client_emitted_local_failure");
    expect(report?.run_state?.terminal_source).toBe("local_failure");
  });

  it("does not claim a server receipt for a local preflight-style failure", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("response_prepare_failed", 1))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      failure_code: "context_prepare_failed",
      retryable: false,
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        failureAuthority: "client",
        terminalValidation: "unvalidated",
        runState: completeRunState({
          terminalSource: "local_failure",
          runPhase: "submitted",
        }),
      }),
    );

    expect(report).toMatchObject({
      incident: {
        failure_authority: "client",
        origin: "agent_local_failure",
        terminal_evidence: "client_observed",
        artifact_integrity: "unauthenticated_client_record",
        evidence_scope: "client_observation_only",
        causal_assessment: "not_established",
        observation_source: "client_runtime",
      },
      run_summary: { terminal_receipt: "client_emitted_local_failure" },
      run_state: { terminal_source: "local_failure" },
    });
    expect(JSON.stringify(report)).not.toContain("client_received_server_terminal");
  });

  it("records a server receipt for a validated server failure", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );

    expect(report).toMatchObject({
      incident: {
        failure_authority: "server",
        origin: "agent_terminal",
        terminal_evidence: "server_protocol_validated",
      },
      run_summary: { terminal_receipt: "client_received_server_terminal" },
      run_state: { terminal_source: "session_terminal" },
    });
  });

  it("separates an observed HTTP rejection from a client-emitted failure", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("response_prepare_failed", 1, {
      status: 503,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      status: 503,
      failure_code: "response_start_failed",
      retryable: true,
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        failureAuthority: "client",
        failureStage: "response_prepare",
        failureMechanism: "http_rejection",
        terminalValidation: "unvalidated",
        runState: completeRunState({
          terminalSource: "local_failure",
          runPhase: "submitted",
        }),
      }),
    );

    expect(report).toMatchObject({
      incident: {
        failure_authority: "client",
        observation_source: "server_http_response",
        causal_assessment: "not_established",
        http_status: 503,
      },
      run_summary: {
        terminal_receipt: "client_emitted_local_failure",
      },
    });
  });

  it("uses unknown receipt evidence when provenance conflicts", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        failureAuthority: "server",
        runState: completeRunState({ terminalSource: "local_failure" }),
      }),
    );

    expect(report?.run_summary.terminal_receipt).toBe("unknown");
    expect(report?.run_state).toBeUndefined();
    expect(report?.capture_quality.collection_failures).toContainEqual({
      code: "run_state_invalid",
      count: 1,
    });
  });

  it("rejects all-zero server identifiers and unsafe generated report IDs", () => {
    let reportIdAttempt = 0;
    const recorder = new AgentIncidentRecorder({
      createReportId: () => {
        reportIdAttempt += 1;
        if (reportIdAttempt === 1) throw new Error("report-id-generator-failed");
        if (reportIdAttempt === 2) return ZERO_REPORT_ID;
        return REPORT_ID;
      },
    });
    expect(recorder.record(event("run_started", 1, {
      run_id: ZERO_RUN_ID,
      server_run_id: ZERO_RUN_ID,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 2, {
      run_id: ZERO_RUN_ID,
      server_run_id: ZERO_RUN_ID,
      incident_id: ZERO_INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );

    expect(report?.report_id).toBe(REPORT_ID);
    expect(report?.incident.incident_id).toBeUndefined();
    expect(report?.correlation.run_id).toBeUndefined();
    expect(report?.correlation.server_run_id).toBeUndefined();
    expect(report?.capture_quality.missing_fields).toEqual(expect.arrayContaining([
      "server_incident_id",
      "server_run_id",
    ]));
    expect(recorder.getByIncidentId(ZERO_INCIDENT_ID)).toBeNull();
    expect(recorder.getByReportId(ZERO_REPORT_ID)).toBeNull();
    expect(reportIdAttempt).toBe(3);
  });

  it("uses only secure randomness, retries all-zero output, and fails closed when crypto is unavailable", () => {
    const mathRandom = jest.spyOn(Math, "random");
    const getRandomValues = jest.spyOn(window.crypto, "getRandomValues");
    try {
      let secureCalls = 0;
      getRandomValues.mockImplementation((array) => {
        secureCalls += 1;
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
          secureCalls === 1 ? 0 : 1,
        );
        return array;
      });
      const recorder = new AgentIncidentRecorder({ createReportId: () => ZERO_REPORT_ID });
      recordFailure(recorder);
      const report = recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      );
      expect(report?.report_id).toBe(`report_${"01".repeat(16)}`);
      expect(secureCalls).toBe(2);
      expect(mathRandom).not.toHaveBeenCalled();

      getRandomValues.mockImplementation(() => {
        throw new Error("secure-random-unavailable");
      });
      const unavailable = new AgentIncidentRecorder({ createReportId: () => ZERO_REPORT_ID });
      recordFailure(unavailable);
      expect(() => unavailable.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      )).not.toThrow();
      expect(unavailable.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      )).toBeNull();
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      getRandomValues.mockRestore();
      mathRandom.mockRestore();
    }
  });

  it("reserves one final report ID and releases reservations with active state", () => {
    let nextReport = 4;
    const recorder = new AgentIncidentRecorder({
      createReportId: () => `report_${String(nextReport++).repeat(32).slice(0, 32)}`,
    });
    expect(recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBeNull();
    expect(recorder.record(event("run_started", 1))).toBe(true);
    const reserved = recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID });
    expect(reserved).toBe(REPORT_ID);
    expect(recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBe(reserved);
    expect(nextReport).toBe(5);
    expect(recorder.record(event("run_finished_failed", 2, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );
    expect(report?.report_id).toBe(reserved);
    expect(recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBeNull();

    const completedRequest = "user-11111111-1111-4111-8111-111111111111";
    expect(recorder.record({ ...event("run_started", 1), request_id: completedRequest })).toBe(true);
    expect(recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: completedRequest }))
      .toBe(`report_${"5".repeat(32)}`);
    expect(recorder.record({
      ...event("run_finished_completed", 2),
      request_id: completedRequest,
    })).toBe(true);
    expect(recorder.reserveReportId({ conversationId: CONVERSATION_ID, requestId: completedRequest }))
      .toBeNull();
    expect(recorder.reserveReportId({
      conversationId: CONVERSATION_ID,
      requestId: "Private.md",
    })).toBeNull();
    expect(recorder.reserveReportId(new Proxy({
      conversationId: CONVERSATION_ID,
      requestId: REQUEST_ID,
    }, {
      get: () => { throw new Error("private-reservation-canary"); },
    }))).toBeNull();
  });

  it("contains a throwing reservation generator and frees an evicted active reservation", () => {
    let calls = 0;
    const fallback = new AgentIncidentRecorder({
      createReportId: () => {
        calls += 1;
        if (calls === 1) throw new Error("reservation-generator-failed");
        return REPORT_ID;
      },
    });
    expect(fallback.record(event("run_started", 1))).toBe(true);
    expect(fallback.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBe(REPORT_ID);
    expect(calls).toBe(2);

    const bounded = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(bounded.record(event("run_started", 1))).toBe(true);
    expect(bounded.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBe(REPORT_ID);
    for (let index = 0; index < AGENT_INCIDENT_MAX_ACTIVE_RUNS; index += 1) {
      const requestId = `user-${String(index).padStart(10, "0")}-abcde`;
      expect(bounded.record({ ...event("run_started", index + 2), request_id: requestId })).toBe(true);
    }
    expect(bounded.reserveReportId({ conversationId: CONVERSATION_ID, requestId: REQUEST_ID }))
      .toBeNull();
  });

  it("reads changing allowlisted getters once, rejects revoked proxies, and trusts monotonic duration", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const changing = event("run_started", 1, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: "0".repeat(32),
    }) as { conversation_id?: string } & ThinAgentLifecycleEvent;
    let conversationReads = 0;
    Object.defineProperty(changing, "conversation_id", {
      configurable: true,
      enumerable: true,
      get: () => {
        conversationReads += 1;
        return conversationReads === 1 ? CONVERSATION_ID : `conversation_${"9".repeat(32)}`;
      },
    });
    expect(recorder.record(changing)).toBe(true);
    expect(conversationReads).toBe(1);
    expect(recorder.record(event("run_finished_failed", 2, {
      timestamp: "2026-08-13T13:59:00.000Z",
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    let authorityReads = 0;
    const context = completeContext({ elapsedMs: 35_695 }) as { failureAuthority?: string };
    Object.defineProperty(context, "failureAuthority", {
      configurable: true,
      enumerable: true,
      get: () => {
        authorityReads += 1;
        return authorityReads === 1 ? "client" : "server";
      },
    });
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      context as AgentIncidentCaptureContext,
    )!;
    expect(authorityReads).toBe(1);
    expect(report.incident).toMatchObject({
      failure_authority: "client",
      origin: "agent_local_failure",
      terminal_evidence: "client_observed",
    });
    expect(report.correlation.server_latency_correlation_id).toBeUndefined();
    expect(report.run_summary).toMatchObject({
      duration_ms: 35_695,
      duration_clock_domain: "client_turn_monotonic",
    });

    const revokedEvent = Proxy.revocable(event("run_started", 1), {});
    revokedEvent.revoke();
    expect(() => recorder.record(revokedEvent.proxy)).not.toThrow();
    expect(recorder.record(revokedEvent.proxy)).toBe(false);
  });

  it("removes conflicting stable identifiers from correlation and every timeline event", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const secondRunId = `run_${"8".repeat(32)}`;
    const secondTraceId = "9".repeat(32);
    expect(recorder.record(event("run_started", 1, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: "7".repeat(32),
    }))).toBe(true);
    expect(recorder.record(event("phase_working", 2, {
      run_id: secondRunId,
      server_run_id: secondRunId,
      latency_trace_id: secondTraceId,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 3, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.correlation).toEqual({});
    expect(report.timeline.every((entry) => (
      entry.run_id === undefined
      && entry.server_run_id === undefined
      && entry.server_latency_correlation_id === undefined
    ))).toBe(true);
    expect(report.capture_quality.collection_failures).toContainEqual({
      code: "terminal_context_unavailable",
      count: 2,
    });
    expect(report.capture_quality.missing_fields).toContain("server_run_id");
  });

  it("rejects extended-year lifecycle timestamps and falls back from an extended-year report clock", () => {
    const recorder = new AgentIncidentRecorder({
      createReportId: () => REPORT_ID,
      now: () => Date.parse("+010000-01-01T00:00:00.000Z"),
    });
    expect(recorder.record(event("run_started", 1, {
      timestamp: "+010000-01-01T00:00:00.000Z",
    }))).toBe(false);
    recordFailure(recorder);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(report.capture_quality.collection_failures).toContainEqual({
      code: "clock_unavailable",
      count: 1,
    });
  });

  it("isolates concurrent requests and only finalizes failed terminals", () => {
    const otherRequest = "user-11111111-1111-4111-8111-111111111111";
    let reportNumber = 4;
    const recorder = new AgentIncidentRecorder({
      createReportId: () => `report_${String(reportNumber++).repeat(32).slice(0, 32)}`,
    });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    expect(recorder.record({
      ...event("run_started", 1),
      request_id: otherRequest,
    })).toBe(true);
    expect(recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )).toBeNull();
    expect(recorder.record(event("run_finished_failed", 2, { incident_id: INCIDENT_ID }))).toBe(true);
    const first = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );
    expect(JSON.stringify(first)).not.toContain(CONVERSATION_ID);
    expect(JSON.stringify(first)).not.toContain(REQUEST_ID);
    expect(recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: otherRequest },
      completeContext(),
    )).toBeNull();
  });

  it("keeps interleaved conversation and request evidence strictly separated", () => {
    const secondConversation = `conversation_${"8".repeat(32)}`;
    const secondRequest = "user-88888888-8888-4888-8888-888888888888";
    const secondIncident = `incident_${"9".repeat(32)}`;
    let nextReport = 1;
    const recorder = new AgentIncidentRecorder({
      createReportId: () => `report_${(nextReport++).toString(16).padStart(32, "0")}`,
    });
    const forSecond = (source: ThinAgentLifecycleEvent): ThinAgentLifecycleEvent => ({
      ...source,
      conversation_id: secondConversation,
      request_id: secondRequest,
    });

    expect(recorder.record(event("run_started", 1, { server_run_id: SERVER_RUN_ID }))).toBe(true);
    expect(recorder.record(forSecond(event("run_started", 1)))).toBe(true);
    expect(recorder.record(event("local_tool_started", 2, {
      tool_execution_ordinal: 1,
      tool_name: "read",
    }))).toBe(true);
    expect(recorder.record(forSecond(event("phase_thinking", 2)))).toBe(true);
    expect(recorder.record(forSecond(event("run_finished_failed", 3, {
      incident_id: secondIncident,
      failure_code: "response_capacity_unavailable",
    })))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 3, {
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);

    const second = recorder.finalize(
      { conversationId: secondConversation, requestId: secondRequest },
      completeContext(),
    );
    const first = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );

    expect(JSON.stringify(first)).not.toContain(CONVERSATION_ID);
    expect(JSON.stringify(first)).not.toContain(REQUEST_ID);
    expect(first?.incident.incident_id).toBe(INCIDENT_ID);
    expect(first?.tools).toHaveLength(1);
    expect(first?.timeline.map((item) => item.source_sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(second)).not.toContain(secondConversation);
    expect(JSON.stringify(second)).not.toContain(secondRequest);
    expect(second?.incident.incident_id).toBe(secondIncident);
    expect(second?.tools).toHaveLength(0);
    expect(second?.timeline.map((item) => item.source_sequence)).toEqual([1, 2, 3]);
    expect(recorder.getByIncidentId(INCIDENT_ID)).toBe(first);
    expect(recorder.getByIncidentId(secondIncident)).toBe(second);
  });

  it.each(["run_finished_completed", "run_finished_cancelled"] as const)(
    "never creates an incident after a %s terminal",
    (terminalCode) => {
      const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
      expect(recorder.record(event("run_started", 1))).toBe(true);
      expect(recorder.record(event(terminalCode, 2))).toBe(true);
      expect(recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      )).toBeNull();
      expect(recorder.record(event("run_finished_failed", 3, {
        incident_id: INCIDENT_ID,
        failure_code: "response_failed",
      }))).toBe(false);
      expect(recorder.finalize(
        { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
        completeContext(),
      )).toBeNull();
      expect(recorder.getByIncidentId(INCIDENT_ID)).toBeNull();
    },
  );

  it("groups tools by bounded execution ordinal and rejects contradictory count summaries", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    expect(recorder.record(event("local_tool_started", 2, {
      tool_execution_ordinal: 2,
      tool_name: "read",
      tool_item_count: 2,
    }))).toBe(true);
    expect(recorder.record(event("local_tool_completed_failed", 3, {
      tool_execution_ordinal: 2,
      tool_name: "read",
      tool_outcome: "failed",
      tool_failure_class: "partial_failure",
      tool_item_count: 2,
      tool_completed_item_count: 2,
      tool_failed_item_count: 1,
    }))).toBe(true);
    expect(recorder.record(event("tool_result_acknowledged_failed", 4, {
      tool_execution_ordinal: 2,
      tool_name: "write",
    }))).toBe(true);
    expect(recorder.record(event("local_tool_started", 5, {
      tool_execution_ordinal: 513,
      tool_name: "write",
    }))).toBe(true);
    expect(recorder.record(event("local_tool_started", 6, {
      tool_execution_ordinal: 1,
      tool_name: "search",
      tool_item_count: 10_001,
      tool_completed_item_count: -1,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 7, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );

    expect(report?.tools.map((tool) => tool.ordinal)).toEqual([1, 2]);
    expect(report?.tools[1]).toMatchObject({
      ordinal: 2,
      tool_name: "read",
      outcome: "failed",
      failure_class: "partial_failure",
      result_acknowledgement: "failed",
    });
    expect(report?.tools[1]).not.toHaveProperty("requested_item_count");
    expect(report?.tools[1]).not.toHaveProperty("completed_item_count");
    expect(report?.tools[1]).not.toHaveProperty("failed_item_count");
    expect(report?.tools[0]).not.toHaveProperty("requested_item_count");
    expect(report?.capture_quality.missing_fields).toContain("tool_execution_ordinal");
    expect(report?.capture_quality.collection_failures).toEqual(expect.arrayContaining([
      { code: "tool_count_inconsistent", count: 1 },
      { code: "tool_identity_conflict", count: 1 },
    ]));
  });

  it("retains the first tool window plus the newest tools within the hard cap", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1))).toBe(true);
    for (let ordinal = 1; ordinal <= AGENT_INCIDENT_MAX_TOOLS + 1; ordinal += 1) {
      expect(recorder.record(event("local_tool_started", ordinal + 1, {
        tool_execution_ordinal: ordinal,
        tool_name: "read",
      }))).toBe(true);
    }
    expect(recorder.record(event("run_finished_failed", AGENT_INCIDENT_MAX_TOOLS + 3, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(report.tools).toHaveLength(AGENT_INCIDENT_MAX_TOOLS);
    expect(report.tools.map((tool) => tool.ordinal)).toEqual([
      ...Array.from({ length: 16 }, (_, index) => index + 1),
      ...Array.from({ length: 48 }, (_, index) => index + 18),
    ]);
    expect(report.capture_quality).toMatchObject({
      truncated: true,
      dropped_tool_summary_count: 1,
    });
    expect(report.capture_quality.collection_failures).toContainEqual({
      code: "tool_summary_limit",
      count: 1,
    });
  });

  it("bounds active correlations and caller-provided list iteration", () => {
    let nextReport = 1;
    const recorder = new AgentIncidentRecorder({
      createReportId: () => `report_${(nextReport++).toString(16).padStart(32, "0")}`,
    });
    const request = (index: number): string => `user-${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
    for (let index = 1; index <= AGENT_INCIDENT_MAX_ACTIVE_RUNS + 1; index += 1) {
      expect(recorder.record({
        ...event("run_started", index),
        request_id: request(index),
      })).toBe(true);
    }
    const lastRequest = request(AGENT_INCIDENT_MAX_ACTIVE_RUNS + 1);
    expect(recorder.record({
      ...event("run_finished_failed", 50, { incident_id: INCIDENT_ID, failure_code: "response_failed" }),
      request_id: lastRequest,
    })).toBe(true);
    const retained = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: lastRequest },
      completeContext(),
    )!;
    expect(retained.capture_quality.missing_fields).not.toContain("run_started");
    expect(recorder.record({
      ...event("run_finished_failed", 51, { failure_code: "response_failed" }),
      request_id: request(1),
    })).toBe(true);
    const evicted = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: request(1) },
      completeContext(),
    )!;
    expect(evicted.capture_quality.missing_fields).toContain("run_started");

    const listRecorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(listRecorder);
    let sampleReads = 0;
    const hugeSamples = new Proxy(new Array(100_000), {
      get: (target, property, receiver) => {
        if (typeof property === "string" && /^\d+$/u.test(property)) sampleReads += 1;
        return Reflect.get(target, property, receiver);
      },
    }) as Parameters<AgentIncidentRecorder["attachResourceSamples"]>[1];
    expect(listRecorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      hugeSamples,
    )).toBe(true);
    let failureCodeReads = 0;
    const hugeFailures = new Proxy(new Array(100_000).fill("clock_unavailable"), {
      get: (target, property, receiver) => {
        if (typeof property === "string" && /^\d+$/u.test(property)) failureCodeReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(listRecorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        collectionFailures: hugeFailures,
      }),
    )).not.toBeNull();
    expect(sampleReads).toBeLessThanOrEqual(AGENT_INCIDENT_MAX_RESOURCE_SAMPLES);
    expect(failureCodeReads).toBeLessThanOrEqual(64);
  });

  it("keeps the terminal, caps the timeline, and reports every dropped event", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    for (let sequence = 1; sequence <= AGENT_INCIDENT_MAX_EVENTS + 25; sequence += 1) {
      expect(recorder.record(event(sequence === 1 ? "run_started" : "phase_working", sequence))).toBe(true);
    }
    expect(recorder.record(event("run_finished_failed", AGENT_INCIDENT_MAX_EVENTS + 26, {
      incident_id: INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
    }))).toBe(true);
    expect(recorder.record(event("phase_retrying", AGENT_INCIDENT_MAX_EVENTS + 27))).toBe(false);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    );
    expect(report?.timeline).toHaveLength(AGENT_INCIDENT_MAX_EVENTS);
    expect(report?.timeline.at(-1)?.code).toBe("run_finished_failed");
    expect(report?.capture_quality).toMatchObject({
      truncated: true,
      observed_event_count: AGENT_INCIDENT_MAX_EVENTS + 27,
      retained_event_count: AGENT_INCIDENT_MAX_EVENTS,
      dropped_event_count: 27,
      dropped_events: {
        event_limit: 26,
        after_terminal: 1,
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(
      AGENT_INCIDENT_MAX_REPORT_BYTES,
    );
  });

  it("enforces the timeline byte budget before the report-size ceiling", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    const denseFields: Partial<ThinAgentLifecycleEvent> = {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_capacity_unavailable",
      latency_trace_id: "7".repeat(32),
      command_kind: "client_tool_result",
      command_segment_ordinal: 1,
      tool_execution_ordinal: 1,
      tool_name: "multi_edit",
      tool_outcome: "outcome_unknown",
      tool_failure_class: "outcome_unknown",
      tool_item_count: 10_000,
      tool_completed_item_count: 5_000,
      tool_failed_item_count: 5_000,
      history_sync_kind: "authoritative_prefix",
      history_sync_ordinal: 1,
      response_delivery_mode: "request_url_buffered",
      client_monotonic_offset_ms: 604_800_000,
      server_timing_app_ms: 604_800_000,
      server_timing_auth_ms: 604_800_000,
      credits_refresh_reason: "billing_failure",
      credits_refresh_sequence: 1,
      credits_refresh_transport: "request_url",
      credits_refresh_elapsed_ms: 604_800_000,
      credits_refresh_server_auth_ms: 604_800_000,
      credits_refresh_server_rate_limit_ms: 604_800_000,
      credits_refresh_server_balance_store_ms: 604_800_000,
      credits_refresh_server_total_ms: 604_800_000,
      status: 503,
      retryable: true,
    };
    for (let sequence = 1; sequence <= AGENT_INCIDENT_MAX_EVENTS; sequence += 1) {
      expect(recorder.record(event(sequence === 1 ? "run_started" : "phase_working", sequence, {
        ...denseFields,
        command_segment_ordinal: sequence,
        history_sync_ordinal: sequence,
        credits_refresh_sequence: sequence,
      }))).toBe(true);
    }
    expect(recorder.record(event("run_finished_failed", AGENT_INCIDENT_MAX_EVENTS + 1, denseFields))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.capture_quality.dropped_events.byte_limit).toBeGreaterThan(0);
    expect(report.capture_quality.dropped_events.event_limit).toBe(0);
    expect(report.capture_quality.retained_event_count).toBeLessThan(AGENT_INCIDENT_MAX_EVENTS);
    expect(report.timeline.at(-1)?.code).toBe("run_finished_failed");
    expect(report.capture_quality.report_bytes).toBe(reportBytes(report));
    expect(report.capture_quality.report_bytes).toBeLessThanOrEqual(AGENT_INCIDENT_MAX_REPORT_BYTES);
  });

  it("retains only the newest bounded resource window and accounts for invalid samples", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);
    const samples = Array.from({ length: AGENT_INCIDENT_MAX_RESOURCE_SAMPLES + 5 }, (_, index) => ({
      captured_at: new Date(Date.UTC(2026, 7, 13, 14, 0, index)).toISOString(),
      heap_used_mb: 200 + index + 0.12345,
      cpu_percent: index,
      event_loop_lag_ms: index,
    }));
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      [{ captured_at: "not-iso", cpu_percent: 2 }],
    )).toBe(true);
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      samples,
    )).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.resource_samples).toHaveLength(AGENT_INCIDENT_MAX_RESOURCE_SAMPLES);
    expect(report.resource_samples[0].ordinal).toBe(7);
    expect(report.resource_samples.at(-1)?.ordinal).toBe(AGENT_INCIDENT_MAX_RESOURCE_SAMPLES + 6);
    expect(report.resource_samples[0].heap_used_mb).toBe(205.123);
    expect(report.capture_quality).toMatchObject({
      truncated: true,
      dropped_resource_sample_count: 6,
    });
    expect(report.capture_quality.collection_failures).toContainEqual({
      code: "resource_sample_invalid",
      count: 1,
    });
  });

  it("lists missing and collection-failure evidence instead of implying complete capture", () => {
    const recorder = new AgentIncidentRecorder({
      createReportId: () => REPORT_ID,
      now: () => Number.NaN,
    });
    recordFailure(recorder);
    expect(recorder.attachResourceSamples(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      [{ captured_at: "not-a-time", cpu_percent: 8 }],
    )).toBe(true);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      { collectionFailures: ["environment_unavailable"] },
    );
    expect(report?.capture_quality.complete).toBe(false);
    expect(report?.capture_quality.missing_fields).toEqual(expect.arrayContaining([
      "terminal_validation",
      "resource_samples",
      "environment_plugin_version",
    ]));
    expect(report?.capture_quality.collection_failures).toEqual(expect.arrayContaining([
      { code: "clock_unavailable", count: 1 },
      { code: "environment_unavailable", count: 1 },
      { code: "resource_sample_invalid", count: 1 },
    ]));
  });

  it("distinguishes missing transport history from a missing terminal segment", () => {
    const withWrongSegment = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(withWrongSegment.record(event("run_started", 1))).toBe(true);
    expect(withWrongSegment.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(4),
    )).toBe(true);
    expect(withWrongSegment.record(event("run_finished_failed", 2, {
      command_segment_ordinal: 5,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const wrong = withWrongSegment.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(wrong.capture_quality.missing_fields).toContain("terminal_transport_segment");
    expect(wrong.capture_quality.missing_fields).not.toContain("transport_segments");

    const withWrongCorrelation = new AgentIncidentRecorder({
      createReportId: () => `report_${"9".repeat(32)}`,
    });
    expect(withWrongCorrelation.record(event("run_started", 1))).toBe(true);
    expect(withWrongCorrelation.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(5, { commandKind: "submit" }),
    )).toBe(true);
    expect(withWrongCorrelation.record(event("run_finished_failed", 2, {
      command_kind: "client_tool_result",
      command_segment_ordinal: 5,
      tool_execution_ordinal: 1,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const wrongCorrelation = withWrongCorrelation.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(wrongCorrelation.capture_quality.missing_fields).toContain("terminal_transport_segment");

    const withoutTerminalOrdinal = new AgentIncidentRecorder({
      createReportId: () => `report_${"8".repeat(32)}`,
    });
    recordFailure(withoutTerminalOrdinal);
    const absent = withoutTerminalOrdinal.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(absent.capture_quality.missing_fields).toContain("transport_segments");
    expect(absent.capture_quality.missing_fields).toContain("terminal_transport_segment");
  });

  it("uses the failed receipt transport reference and marks reconstructed transport unavailable", () => {
    const fromReceipt = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(fromReceipt.record(event("run_started", 1))).toBe(true);
    expect(fromReceipt.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(4),
    )).toBe(true);
    expect(fromReceipt.record(event("response_result_received_failed", 2, {
      command_kind: "submit",
      command_segment_ordinal: 5,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    expect(fromReceipt.record(event("run_finished_failed", 3, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const receiptReport = fromReceipt.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    expect(receiptReport.capture_quality.missing_fields).toContain("terminal_transport_segment");
    expect(receiptReport.capture_quality.missing_fields).not.toContain("transport_segments");

    const reconstructed = new AgentIncidentRecorder({
      createReportId: () => `report_${"a".repeat(32)}`,
    });
    expect(reconstructed.record(event("run_started", 1))).toBe(true);
    expect(reconstructed.attachTransportSegment(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      transportSegment(4),
    )).toBe(true);
    expect(reconstructed.record(event("run_finished_failed", 2, {
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
    }))).toBe(true);
    const reconstructedReport = reconstructed.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({ runState: completeRunState({ terminalSource: "message_reconstruction" }) }),
    )!;
    expect(reconstructedReport.capture_quality.missing_fields).toContain("terminal_transport_segment");
    expect(reconstructedReport.capture_quality.missing_fields).not.toContain("transport_segments");
  });

  it("uses one content-free grouping fingerprint across unique report and release evidence", () => {
    const firstRecorder = new AgentIncidentRecorder({
      createReportId: () => REPORT_ID,
      now: () => Date.parse("2026-08-13T14:01:00.000Z"),
    });
    recordFailure(firstRecorder);
    const first = firstRecorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    const secondRecorder = new AgentIncidentRecorder({
      createReportId: () => `report_${"9".repeat(32)}`,
      now: () => Date.parse("2026-08-14T16:12:00.000Z"),
    });
    recordFailure(secondRecorder);
    const second = secondRecorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext({
        environment: {
          pluginVersion: "6.6.1",
          pluginBuildId: `sha256:${"8".repeat(64)}`,
          loadedBundleSha256: "9".repeat(64),
          obsidianVersion: "1.13.4",
          hostType: "desktop",
          osFamily: "macos",
        },
      }),
    )!;

    expect(first.report_id).not.toBe(second.report_id);
    expect(first.created_at).not.toBe(second.created_at);
    expect(first.environment.plugin_version).not.toBe(second.environment.plugin_version);
    expect(first.grouping).toEqual({
      strategy: "systemsculpt.failure-contract/1",
      fingerprint: "systemsculpt.failure-contract/1|authority=server|stage=response_terminal|mechanism=service_terminal|failure=response_capacity_unavailable|status=5xx|terminal=session_terminal",
    });
    expect(second.grouping).toEqual(first.grouping);
  });

  it("exports honest evidence names without legacy trace, paint, or confidence claims", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    recordFailure(recorder);
    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.incident).toMatchObject({
      failure_authority: "server",
      terminal_evidence: "server_protocol_validated",
      artifact_integrity: "unauthenticated_client_record",
      evidence_scope: "client_observation_only",
      causal_assessment: "not_established",
      observation_source: "server_protocol_terminal",
    });
    expect(report.incident).not.toHaveProperty("authority");
    expect(report.incident).not.toHaveProperty("confidence");
    expect(report.incident).not.toHaveProperty("handled");
    expect(report.incident).not.toHaveProperty("synthetic");
    expect(report.correlation).not.toHaveProperty(
      "server_latency_correlation_id",
    );
    expect(report.correlation).not.toHaveProperty("latency_trace_id");
    expect(report.rendering).toHaveProperty(
      "failure_surface_paint_opportunity_observed",
      true,
    );
    expect(report.rendering).not.toHaveProperty("failure_surface_paint_observed");
    expect(report.privacy).toHaveProperty("storage_target", "vault_local");
    expect(report.privacy).not.toHaveProperty("storage");
  });

  it("keeps request correlation IDs scoped to each command segment", () => {
    const recorder = new AgentIncidentRecorder({ createReportId: () => REPORT_ID });
    expect(recorder.record(event("run_started", 1, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: "7".repeat(32),
      command_kind: "submit",
      command_segment_ordinal: 1,
    }))).toBe(true);
    expect(recorder.record(event("phase_working", 2, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: "8".repeat(32),
      command_kind: "client_tool_result",
      command_segment_ordinal: 2,
      tool_execution_ordinal: 1,
    }))).toBe(true);
    expect(recorder.record(event("run_finished_failed", 3, {
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      incident_id: INCIDENT_ID,
      failure_code: "response_failed",
      latency_trace_id: "8".repeat(32),
      command_kind: "client_tool_result",
      command_segment_ordinal: 2,
      tool_execution_ordinal: 1,
    }))).toBe(true);

    const report = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;

    expect(report.correlation.server_latency_correlation_id).toBe("8".repeat(32));
    expect(report.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command_segment_ordinal: 1,
        server_latency_correlation_id: "7".repeat(32),
      }),
      expect.objectContaining({
        command_segment_ordinal: 2,
        server_latency_correlation_id: "8".repeat(32),
      }),
    ]));
  });

  it("evicts old in-memory reports without mixing incident lookups", () => {
    let reportIndex = 1;
    const recorder = new AgentIncidentRecorder({
      maximumFrozenReports: 1,
      createReportId: () => `report_${reportIndex.toString(16).padStart(32, "0")}`,
    });
    recordFailure(recorder);
    const first = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: REQUEST_ID },
      completeContext(),
    )!;
    reportIndex += 1;
    const otherRequest = "user-22222222-2222-4222-8222-222222222222";
    const otherIncident = `incident_${"8".repeat(32)}`;
    recorder.record({ ...event("run_started", 1), request_id: otherRequest });
    recorder.record({
      ...event("run_finished_failed", 2),
      request_id: otherRequest,
      incident_id: otherIncident,
    });
    const second = recorder.finalize(
      { conversationId: CONVERSATION_ID, requestId: otherRequest },
      completeContext(),
    )!;
    expect(recorder.getByReportId(first.report_id)).toBeNull();
    expect(recorder.getByIncidentId(INCIDENT_ID)).toBeNull();
    expect(recorder.getByReportId(second.report_id)).toBe(second);
    expect(recorder.getByIncidentId(otherIncident)).toBe(second);
  });
});
