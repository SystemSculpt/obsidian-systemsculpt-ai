import {
  AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES,
  AGENT_INCIDENT_MAX_REPORT_BYTES,
  AGENT_INCIDENT_MAX_SCAN_BYTES,
  AGENT_INCIDENT_MAX_SCAN_CANDIDATES,
  AGENT_INCIDENT_SCHEMA_VERSION,
  AGENT_INCIDENT_STORE_PATH,
  AgentIncidentStore,
  AgentIncidentStoreError,
  type AgentIncidentStoreAdapter,
  type AgentIncidentStoreReport,
} from "../AgentIncidentStore";
import {
  AgentIncidentRecorder,
  type AgentIncidentCaptureContext,
  type ThinAgentLifecycleEvent,
} from "../AgentIncidentRecorder";
import {
  AGENT_INCIDENT_GROUPING_STRATEGY,
  buildAgentIncidentGroupingFingerprint,
  type AgentIncidentExportedFailureCode,
  type AgentIncidentFailureAuthority,
  type AgentIncidentFailureMechanism,
  type AgentIncidentFailureStage,
} from "../AgentIncidentSchema";

interface MemoryFile {
  data: string;
  ctime: number;
  mtime: number;
}

class MemoryAdapter implements AgentIncidentStoreAdapter {
  readonly files = new Map<string, MemoryFile>();
  readonly directories = new Set<string>();
  writeFailures = 0;
  removeFailures = new Set<string>();
  writeCalls = 0;
  renameCalls = 0;
  activeWrites = 0;
  maximumConcurrentWrites = 0;
  delayWrites = false;
  corruptWrites = false;
  clock = Date.parse("2026-08-13T12:00:00.000Z");

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const file = this.files.get(path);
    if (file) {
      return {
        type: "file",
        ctime: file.ctime,
        mtime: file.mtime,
        size: new TextEncoder().encode(file.data).byteLength,
      };
    }
    if (this.directories.has(path)) return { type: "folder", ctime: this.clock, mtime: this.clock, size: 0 };
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!this.directories.has(path)) throw new Error("missing-directory");
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")),
      folders: [...this.directories].filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")),
    };
  }

  async read(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error("missing-file");
    return file.data;
  }

  async write(path: string, data: string): Promise<void> {
    this.writeCalls += 1;
    this.activeWrites += 1;
    this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.activeWrites);
    try {
      if (this.delayWrites) await Promise.resolve();
      if (this.writeFailures > 0) {
        this.writeFailures -= 1;
        throw new Error("injected-write-failure");
      }
      const previous = this.files.get(path);
      this.files.set(path, {
        data: this.corruptWrites ? `${data}corrupt` : data,
        ctime: previous?.ctime ?? this.clock,
        mtime: this.clock,
      });
    } finally {
      this.activeWrites -= 1;
    }
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    if (this.removeFailures.has(path)) throw new Error("injected-remove-failure");
    this.files.delete(path);
  }

  async rename(path: string, newPath: string): Promise<void> {
    this.renameCalls += 1;
    const file = this.files.get(path);
    if (!file) throw new Error("missing-source");
    if (this.files.has(newPath)) throw new Error("target-exists");
    this.files.set(newPath, file);
    this.files.delete(path);
  }

  put(path: string, data: string, mtime = this.clock): void {
    this.files.set(path, { data, ctime: mtime, mtime });
  }
}

function incidentReport(
  sequence: number,
  createdAt = "2026-08-13T12:01:00.000Z",
  mutate?: (report: Record<string, unknown>) => void,
): AgentIncidentStoreReport {
  const runId = `run_${sequence.toString(16).padStart(32, "0")}`;
  const incidentIdValue = incidentId(sequence);
  const startedAt = "2026-08-13T12:00:00.000Z";
  const failedAt = "2026-08-13T12:00:35.695Z";
  const report: Record<string, unknown> = {
    schema_version: AGENT_INCIDENT_SCHEMA_VERSION,
    report_id: reportId(sequence),
    created_at: createdAt,
    incident: {
      classification: "operation_failure",
      impact: "run_failed",
      outcome: "failed",
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
      incident_id: incidentIdValue,
      failure_code: "response_capacity_unavailable",
      retryable: true,
      http_status: 503,
    },
    correlation: {
      run_id: runId,
      server_run_id: runId,
      server_latency_correlation_id: sequence.toString(16).padStart(32, "0"),
    },
    grouping: {
      strategy: AGENT_INCIDENT_GROUPING_STRATEGY,
      fingerprint: "",
    },
    environment: {
      plugin_version: "6.6.0",
      plugin_build_id: `sha256:${"5".repeat(64)}`,
      loaded_bundle_sha256: "6".repeat(64),
      obsidian_version: "1.13.0",
      host_type: "desktop",
      os_family: "macos",
    },
    run_summary: {
      started_at: startedAt,
      failed_at: failedAt,
      duration_ms: 35_695,
      duration_clock_domain: "client_turn_monotonic",
      terminal_receipt: "client_received_server_terminal",
      terminal_validation: "validated",
      host_process_state: "responsive",
      chat_view_state: "mounted",
      observed_lifecycle_event_count: 2,
      retained_timeline_event_count: 2,
      snapshot_part_count: 4,
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
      lifecycle_code_counts: [
        { code: "run_started", count: 1 },
        { code: "run_finished_failed", count: 1 },
      ],
      lifecycle_phase_counts: [{ phase: "response", count: 2 }],
    },
    run_state: {
      terminal_source: "session_terminal",
      run_origin: "submitted",
      run_phase: "complete",
      connection_state: "closed",
      executing_local_tool_count: 0,
      pending_tool_delivery_count: 0,
      pending_approval_delivery_count: 0,
      pending_tool_task_count: 0,
      server_queued: false,
      run_stalled: false,
      awaiting_client_work: false,
      pending_cancel: false,
      pending_regenerate: false,
      counts_truncated: false,
      elapsed_ms_truncated: false,
    },
    tools: [],
    timeline: [
      {
        ordinal: 1,
        timestamp: startedAt,
        source_sequence: 1,
        code: "run_started",
        phase: "response",
        run_id: runId,
        server_run_id: runId,
        server_latency_correlation_id: sequence.toString(16).padStart(32, "0"),
      },
      {
        ordinal: 2,
        timestamp: failedAt,
        source_sequence: 2,
        code: "run_finished_failed",
        phase: "response",
        run_id: runId,
        server_run_id: runId,
        status: 503,
        retryable: true,
        incident_id: incidentIdValue,
        failure_code: "response_capacity_unavailable",
        server_latency_correlation_id: sequence.toString(16).padStart(32, "0"),
        command_kind: "submit",
        command_segment_ordinal: 1,
      },
    ],
    transport_segments: [{
      command_kind: "submit",
      segment_ordinal: 1,
      close_reason: "clean_eof",
      duration_ms: 35_695,
      received_bytes: 8_192,
      raw_chunk_count: 24,
      sse_event_count: 18,
      accepted_frame_count: 18,
      delivered_frame_count: 18,
      metrics_truncated: false,
    }],
    rendering: {
      failure_surface_dom_committed: true,
      failure_surface_paint_opportunity_observed: true,
      before_terminal_publish: {
        render_state: "idle",
        render_pass_count: 5,
        pending_render_count: 0,
        last_render_duration_ms: 3,
        max_render_duration_ms: 8,
        first_dom_commit_observed: true,
        first_paint_opportunity_observed: true,
        registered_row_count: 2,
        renderer: {
          render_pass_count: 5,
          pending_render_pass_count: 0,
          last_render_duration_ms: 3,
          max_render_duration_ms: 8,
          historical_row_count: 1,
          historical_part_count: 2,
          active_part_count: 3,
          disclosure_count: 2,
          open_disclosure_count: 0,
          activity_disclosure_count: 1,
          reasoning_disclosure_count: 1,
          tool_disclosure_count: 0,
          overflow_disclosure_count: 0,
          pending_hydration_count: 0,
          rendering_enabled: true,
        },
        scroller: {
          mode: "end",
          distance_from_end_bucket: "at_end",
          registered_row_count: 2,
          pending_layout_mutation_count: 0,
          layout_mutation_pending: false,
          geometry_update_pending: false,
          programmatic_scroll_pending: false,
          submitted_prompt_anchor_active: false,
          destroyed: false,
        },
      },
      after_terminal_commit: {
      render_state: "idle",
      render_pass_count: 6,
      pending_render_count: 0,
      last_render_duration_ms: 3,
      max_render_duration_ms: 8,
      first_dom_commit_observed: true,
      first_paint_opportunity_observed: true,
      registered_row_count: 2,
      renderer: {
        render_pass_count: 6,
        pending_render_pass_count: 0,
        last_render_duration_ms: 3,
        max_render_duration_ms: 8,
        historical_row_count: 1,
        historical_part_count: 2,
        active_part_count: 4,
        disclosure_count: 2,
        open_disclosure_count: 0,
        activity_disclosure_count: 1,
        reasoning_disclosure_count: 1,
        tool_disclosure_count: 0,
        overflow_disclosure_count: 0,
        pending_hydration_count: 0,
        rendering_enabled: true,
      },
      scroller: {
        mode: "end",
        distance_from_end_bucket: "at_end",
        registered_row_count: 2,
        pending_layout_mutation_count: 0,
        layout_mutation_pending: false,
        geometry_update_pending: false,
        programmatic_scroll_pending: false,
        submitted_prompt_anchor_active: false,
        destroyed: false,
      },
      },
    },
    resource_samples: [{
      ordinal: 1,
      captured_at: "2026-08-13T12:00:35.690Z",
      heap_used_mb: 213.457,
      heap_limit_mb: 4096,
      rss_mb: 400,
      cpu_percent: 7.5,
      event_loop_lag_ms: 9,
      freeze_delta_ms: 0,
    }],
    capture_quality: {
      complete: true,
      truncated: false,
      limits: {
        maximum_events: 256,
        maximum_report_bytes: AGENT_INCIDENT_MAX_REPORT_BYTES,
        maximum_resource_samples: 12,
        maximum_tools: 64,
        maximum_transport_segments: 64,
        maximum_render_count: 1_000_000,
        maximum_render_duration_ms: 86_400_000,
      },
      report_bytes: 0,
      observed_event_count: 2,
      retained_event_count: 2,
      dropped_event_count: 0,
      dropped_events: { event_limit: 0, byte_limit: 0, after_terminal: 0 },
      dropped_resource_sample_count: 0,
      dropped_tool_summary_count: 0,
      dropped_transport_segment_count: 0,
      missing_fields: [],
      collection_failures: [],
    },
    privacy: {
      policy: "strict_allowlist_content_free",
      policy_version: "systemsculpt.incident-privacy/1",
      capture_implementation_version: "agent-incident-recorder/1",
      storage_target: "vault_local",
      host_sync: "may_sync_with_vault",
      automatic_upload: false,
      excluded_data_categories: [
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
      ],
    },
  };
  mutate?.(report);
  settleGrouping(report);
  settleReportBytes(report);
  return report as unknown as AgentIncidentStoreReport;
}

function settleGrouping(report: Record<string, unknown>): void {
  const incident = report.incident as Record<string, unknown>;
  const runState = report.run_state as Record<string, unknown> | undefined;
  report.grouping = {
    strategy: AGENT_INCIDENT_GROUPING_STRATEGY,
    fingerprint: buildAgentIncidentGroupingFingerprint({
      failureAuthority: incident.failure_authority as AgentIncidentFailureAuthority,
      ...(typeof incident.failure_stage === "string" && incident.failure_stage !== "not_recorded"
        ? { failureStage: incident.failure_stage as AgentIncidentFailureStage }
        : {}),
      ...(typeof incident.failure_mechanism === "string" && incident.failure_mechanism !== "not_recorded"
        ? { failureMechanism: incident.failure_mechanism as AgentIncidentFailureMechanism }
        : {}),
      ...(typeof incident.failure_code === "string"
        ? { failureCode: incident.failure_code as AgentIncidentExportedFailureCode }
        : {}),
      ...(typeof incident.http_status === "number"
        ? { httpStatus: incident.http_status }
        : {}),
      ...(runState?.terminal_source === "session_terminal"
        || runState?.terminal_source === "message_reconstruction"
        || runState?.terminal_source === "local_failure"
        ? { terminalSource: runState.terminal_source }
        : {}),
    }),
  };
}

function settleReportBytes(report: Record<string, unknown>): void {
  const capture = report.capture_quality as Record<string, unknown>;
  let expected = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    capture.report_bytes = expected;
    const next = utf8Bytes(canonicalJson(report));
    if (next === expected) return;
    expected = next;
  }
  throw new Error("report-byte-fixpoint-failed");
}

function canonicalJson(value: unknown): string {
  const visit = (current: unknown): unknown => {
    if (!current || typeof current !== "object") return current;
    if (Array.isArray(current)) return current.map(visit);
    return Object.fromEntries(Object.keys(current as Record<string, unknown>)
      .sort()
      .map((key) => [key, visit((current as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(visit(value));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function reverseObjectKeys(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse()
    .map(([key, child]) => [key, reverseObjectKeys(child)]));
}

function reportId(sequence: number): string {
  return `report_${sequence.toString(16).padStart(32, "0")}`;
}

function incidentId(sequence: number): string {
  return `incident_${sequence.toString(16).padStart(32, "0")}`;
}

function reportPath(sequence: number): string {
  return `${AGENT_INCIDENT_STORE_PATH}/${reportId(sequence)}.json`;
}

describe("AgentIncidentStore", () => {
  it("round-trips an actual recorder report through canonical save and restart", async () => {
    const adapter = new MemoryAdapter();
    const conversationId = `conversation_${"1".repeat(32)}`;
    const requestId = "user-76712c65-86b6-4408-8dfc-6de89d79a479";
    const serverRunId = `run_${"2".repeat(32)}`;
    const serverIncidentId = incidentId(190);
    const recorder = new AgentIncidentRecorder({
      now: () => Date.parse("2026-08-13T12:01:00.000Z"),
      createReportId: () => reportId(190),
    });
    const lifecycle = (
      code: ThinAgentLifecycleEvent["code"],
      sequence: number,
      extra: Partial<ThinAgentLifecycleEvent> = {},
    ): ThinAgentLifecycleEvent => ({
      timestamp: new Date(Date.UTC(2026, 7, 13, 12, 0, 0, sequence)).toISOString(),
      severity: "info",
      code,
      phase: "response",
      sequence,
      conversation_id: conversationId,
      request_id: requestId,
      plugin_build_id: `sha256:${"5".repeat(64)}`,
      ...extra,
    });

    expect(recorder.record(lifecycle("run_started", 1, {
      run_id: serverRunId,
      server_run_id: serverRunId,
      latency_trace_id: "7".repeat(32),
    }))).toBe(true);
    expect(recorder.record(lifecycle("run_finished_failed", 2, {
      timestamp: "2026-08-13T12:00:35.695Z",
      run_id: serverRunId,
      server_run_id: serverRunId,
      incident_id: serverIncidentId,
      failure_code: "response_capacity_unavailable",
      retryable: true,
      status: 503,
    }))).toBe(true);
    expect(recorder.attachResourceSamples(
      { conversationId, requestId },
      [{
        captured_at: "2026-08-13T12:00:35.690Z",
        heap_used_mb: 213.457,
        heap_limit_mb: 4096,
        rss_mb: 400,
        cpu_percent: 7.5,
        event_loop_lag_ms: 9,
        freeze_delta_ms: 0,
      }],
    )).toBe(true);
    expect(recorder.attachTransportSegment(
      { conversationId, requestId },
      {
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        closeReason: "clean_eof",
        durationMs: 35_695,
        receivedBytes: 8_192,
        nonEmptyRawChunkCount: 24,
        sseEventCount: 18,
        acceptedFrameCount: 18,
        deliveredFrameCount: 18,
        metricsTruncated: false,
      },
    )).toBe(true);
    const context: AgentIncidentCaptureContext = {
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
      snapshotPartCount: 4,
      elapsedMs: 35_695,
      environment: {
        pluginVersion: "6.6.0",
        pluginBuildId: `sha256:${"5".repeat(64)}`,
        loadedBundleSha256: "6".repeat(64),
        obsidianVersion: "1.13.0",
        hostType: "desktop",
        osFamily: "macos",
      },
      runState: {
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
      },
      rendering: {
        beforeTerminalPublish: {
          renderState: "idle",
          renderPassCount: 5,
          pendingRenderCount: 0,
          lastRenderDurationMs: 3,
          maxRenderDurationMs: 8,
          firstDomCommitObserved: true,
          firstPaintOpportunityObserved: true,
          registeredRowCount: 2,
          renderer: {
            renderPassCount: 5,
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
        },
        afterTerminalCommit: {
        renderState: "idle",
        renderPassCount: 6,
        pendingRenderCount: 0,
        lastRenderDurationMs: 3,
        maxRenderDurationMs: 8,
        firstDomCommitObserved: true,
        firstPaintOpportunityObserved: true,
        registeredRowCount: 2,
        renderer: {
          renderPassCount: 6,
          pendingRenderPassCount: 0,
          lastRenderDurationMs: 3,
          maxRenderDurationMs: 8,
          historicalRowCount: 1,
          historicalPartCount: 2,
          activePartCount: 4,
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
        },
        failureSurfaceDomCommitted: true,
        failureSurfacePaintOpportunityObserved: true,
      },
    };
    const report = recorder.finalize({ conversationId, requestId }, context);

    expect(report).not.toBeNull();
    expect(report?.privacy.excluded_data_categories).toContain("conversation_and_request_ids");
    const firstStore = new AgentIncidentStore(adapter);
    const saved = await firstStore.save(report!);
    const restartedStore = new AgentIncidentStore(adapter);
    const restored = await restartedStore.loadByIncidentId(serverIncidentId);

    expect(restored?.serialized).toBe(saved.serialized);
    expect(restored?.serialized).toBe(firstStore.serialize(report!));
    expect(restored?.report).toEqual(report);
    expect(restored?.serialized).not.toContain(conversationId);
    expect(restored?.serialized).not.toContain(requestId);
  });

  it("atomically saves canonical bytes and restores them by either ID after restart", async () => {
    const adapter = new MemoryAdapter();
    const firstStore = new AgentIncidentStore(adapter);
    const source = incidentReport(1);

    const saved = await firstStore.save(source);

    expect(saved.created).toBe(true);
    expect(saved.serialized).toBe(firstStore.serialize(source));
    expect(saved.serialized).toBe(firstStore.serialize(reverseObjectKeys(source) as AgentIncidentStoreReport));
    expect(saved.serialized.startsWith('{"capture_quality"')).toBe(true);
    expect(saved.sizeBytes).toBe(utf8Bytes(saved.serialized));
    expect(saved.serialized).toContain('"capture_quality"');
    expect(adapter.renameCalls).toBe(1);
    expect(adapter.files.has(`${reportPath(1)}.tmp`)).toBe(false);
    expect(adapter.files.get(reportPath(1))?.data).toBe(saved.serialized);

    const restartedStore = new AgentIncidentStore(adapter);
    const byReport = await restartedStore.loadByReportId(reportId(1));
    const byIncident = await restartedStore.loadByIncidentId(incidentId(1));

    expect(byReport?.serialized).toBe(saved.serialized);
    expect(byIncident?.serialized).toBe(saved.serialized);
    expect(byReport?.report.report_id).toBe(reportId(1));
    expect(Object.isFrozen(byReport?.report)).toBe(true);
    expect(Object.isFrozen((byReport?.report as unknown as { timeline: unknown[] }).timeline)).toBe(true);
  });

  it("fails closed before writing when atomic rename is unavailable", async () => {
    const adapter = new MemoryAdapter();
    adapter.rename = undefined;
    const store = new AgentIncidentStore(adapter);

    await expect(store.save(incidentReport(2)))
      .rejects.toMatchObject({ code: "persistence_unavailable" });

    expect(adapter.writeCalls).toBe(0);
    expect(adapter.files.has(reportPath(2))).toBe(false);
    expect(adapter.files.has(`${reportPath(2)}.tmp`)).toBe(false);
  });

  it("retries failed writes within a fixed bound", async () => {
    const adapter = new MemoryAdapter();
    adapter.writeFailures = 2;
    const store = new AgentIncidentStore(adapter, { writeAttempts: 3 });

    await expect(store.save(incidentReport(3))).resolves.toMatchObject({ created: true });
    expect(adapter.writeCalls).toBe(3);

    const unavailable = new MemoryAdapter();
    unavailable.writeFailures = 10;
    const unavailableStore = new AgentIncidentStore(unavailable, { writeAttempts: 3 });
    await expect(unavailableStore.save(incidentReport(4))).rejects.toMatchObject({ code: "persistence_unavailable" });
    expect(unavailable.writeCalls).toBe(3);
    expect(unavailable.files.has(reportPath(4))).toBe(false);
  });

  it("keeps report IDs immutable and treats an identical save as idempotent", async () => {
    const adapter = new MemoryAdapter();
    const store = new AgentIncidentStore(adapter);
    const original = incidentReport(5);
    const first = await store.save(original);
    const second = await store.save(original);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const conflict = incidentReport(5, undefined, (report) => {
      (report.incident as Record<string, unknown>).retryable = false;
      ((report.timeline as Array<Record<string, unknown>>)[1]).retryable = false;
    });
    await expect(store.save(conflict)).rejects.toMatchObject({ code: "duplicate_report_id" });
    expect((await store.loadByReportId(reportId(5)))?.serialized).toBe(first.serialized);
  });

  it("rejects unsafe identifiers before any adapter path access", async () => {
    const adapter = new MemoryAdapter();
    const store = new AgentIncidentStore(adapter);
    const existsSpy = jest.spyOn(adapter, "exists");

    await expect(store.loadByReportId("../../data")).rejects.toMatchObject({ code: "invalid_identifier" });
    await expect(store.loadByIncidentId("incident/../../data")).rejects.toMatchObject({ code: "invalid_identifier" });
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it("isolates corrupt files without blocking valid report recovery", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.put(reportPath(6), "{not-json");
    const seed = new AgentIncidentStore(adapter);
    const valid = seed.serialize(incidentReport(7));
    adapter.put(reportPath(7), valid);

    const restarted = new AgentIncidentStore(adapter);
    const loaded = await restarted.loadByIncidentId(incidentId(7));

    expect(loaded?.report.report_id).toBe(reportId(7));
    expect(adapter.files.has(reportPath(6))).toBe(false);
    expect(adapter.files.has(`${reportPath(6)}.corrupt`)).toBe(true);
    await expect(restarted.loadByReportId(reportId(6))).resolves.toBeNull();
  });

  it("removes a corrupt source when every bounded isolation name already exists", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.put(reportPath(8), "{not-json");
    for (let suffix = 0; suffix < 5; suffix += 1) {
      const corruptPath = suffix === 0
        ? `${reportPath(8)}.corrupt`
        : `${reportPath(8)}.corrupt-${String(suffix)}`;
      adapter.put(corruptPath, `existing-${String(suffix)}`);
    }

    const result = await new AgentIncidentStore(adapter).initialize();

    expect(adapter.files.has(reportPath(8))).toBe(false);
    for (let suffix = 0; suffix < 5; suffix += 1) {
      const corruptPath = suffix === 0
        ? `${reportPath(8)}.corrupt`
        : `${reportPath(8)}.corrupt-${String(suffix)}`;
      expect(adapter.files.get(corruptPath)?.data).toBe(`existing-${String(suffix)}`);
    }
    expect(result.scanComplete).toBe(true);
    expect(result.limitsSatisfied).toBe(true);
  });

  it("removes interrupted temporary writes during initialization", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.put(`${reportPath(8)}.tmp`, "partial");

    const result = await new AgentIncidentStore(adapter).initialize();

    expect(adapter.files.has(`${reportPath(8)}.tmp`)).toBe(false);
    expect(result.removedArtifacts).toBe(1);
  });

  it("retains only the newest 20 valid reports", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const store = new AgentIncidentStore(adapter, { now: () => now });

    for (let sequence = 1; sequence <= 22; sequence += 1) {
      const createdAt = new Date(now - (22 - sequence) * 1000).toISOString();
      await store.save(incidentReport(sequence, createdAt));
    }

    await expect(store.loadByReportId(reportId(1))).resolves.toBeNull();
    await expect(store.loadByReportId(reportId(2))).resolves.toBeNull();
    await expect(store.loadByReportId(reportId(3))).resolves.not.toBeNull();
    expect([...adapter.files.keys()].filter((path) => path.endsWith(".json"))).toHaveLength(20);
  });

  it("preserves the report being saved when future and tied timestamps make ordering ambiguous", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    adapter.clock = now + 365 * 24 * 60 * 60 * 1000;
    const store = new AgentIncidentStore(adapter, { now: () => now, maxReports: 1 });
    const tiedCreatedAt = new Date(now).toISOString();

    await expect(store.save(incidentReport(240, tiedCreatedAt))).resolves.toMatchObject({ created: true });
    const saved = await store.save(incidentReport(241, tiedCreatedAt));

    expect(saved.created).toBe(true);
    expect(saved.report.report_id).toBe(reportId(241));
    await expect(store.loadByReportId(reportId(241))).resolves.toMatchObject({
      report: { report_id: reportId(241) },
    });
    await expect(store.loadByReportId(reportId(240))).resolves.toBeNull();
  });

  it("removes reports and artifacts after 14 days", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    adapter.clock = now;
    const oldDate = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    const seed = new AgentIncidentStore(adapter, { now: () => now });
    const oldSerialized = seed.serialize(incidentReport(23, oldDate));
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.put(reportPath(23), oldSerialized, Date.parse(oldDate));
    adapter.put(`${reportPath(23)}.corrupt`, "isolated", Date.parse(oldDate));

    const result = await new AgentIncidentStore(adapter, { now: () => now }).initialize();

    expect(result.removedReports).toBe(1);
    expect(result.removedArtifacts).toBe(1);
    expect(adapter.files.size).toBe(0);
  });

  it("uses canonical report time when filesystem timestamps move forward or backward", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const stale = now - 15 * 24 * 60 * 60 * 1000;
    const recent = now - 60 * 60 * 1000;
    const future = now + 365 * 24 * 60 * 60 * 1000;
    const store = new AgentIncidentStore(adapter, { now: () => now });
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);

    const staleReport = store.serialize(incidentReport(230, new Date(stale).toISOString()));
    const recentReport = store.serialize(incidentReport(231, new Date(recent).toISOString()));
    adapter.files.set(reportPath(230), { data: staleReport, ctime: stale, mtime: future });
    adapter.files.set(reportPath(231), { data: recentReport, ctime: recent, mtime: stale });
    adapter.files.set(`${reportPath(230)}.corrupt`, { data: "stale", ctime: stale, mtime: future });
    adapter.files.set(`${reportPath(231)}.corrupt`, { data: "recent", ctime: recent, mtime: stale });

    const result = await new AgentIncidentStore(adapter, { now: () => now }).initialize();

    expect(adapter.files.has(reportPath(230))).toBe(false);
    expect(adapter.files.has(reportPath(231))).toBe(true);
    expect(result.removedReports).toBe(1);
    expect(result.retainedReports).toBe(1);
    expect(result.limitsSatisfied).toBe(true);
  });

  it("uses parseable report time for corrupt artifacts before filesystem fallback", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const stale = now - 15 * 24 * 60 * 60 * 1000;
    const recent = now - 60 * 60 * 1000;
    const future = now + 365 * 24 * 60 * 60 * 1000;
    const store = new AgentIncidentStore(adapter, { now: () => now });
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);

    const staleCorrupt = JSON.stringify({ created_at: new Date(stale).toISOString(), invalid: true });
    const recentCorrupt = JSON.stringify({ created_at: new Date(recent).toISOString(), invalid: true });
    adapter.files.set(`${reportPath(230)}.corrupt`, { data: staleCorrupt, ctime: stale, mtime: future });
    adapter.files.set(`${reportPath(231)}.corrupt`, { data: recentCorrupt, ctime: recent, mtime: stale });

    const result = await new AgentIncidentStore(adapter, { now: () => now }).initialize();

    expect(adapter.files.has(`${reportPath(230)}.corrupt`)).toBe(false);
    expect(adapter.files.has(`${reportPath(231)}.corrupt`)).toBe(true);
    expect(result.removedArtifacts).toBe(1);
    expect(result.limitsSatisfied).toBe(true);
  });

  it("uses bounded filesystem time only when a corrupt artifact has no parseable report time", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const stale = now - 15 * 24 * 60 * 60 * 1000;
    const recent = now - 60 * 60 * 1000;
    const future = now + 365 * 24 * 60 * 60 * 1000;
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.files.set(`${reportPath(232)}.corrupt`, { data: "invalid", ctime: stale, mtime: future });
    adapter.files.set(`${reportPath(233)}.corrupt`, { data: "invalid", ctime: recent, mtime: stale });

    const result = await new AgentIncidentStore(adapter, { now: () => now }).initialize();

    expect(adapter.files.has(`${reportPath(232)}.corrupt`)).toBe(false);
    expect(adapter.files.has(`${reportPath(233)}.corrupt`)).toBe(true);
    expect(result.removedArtifacts).toBe(1);
    expect(result.retainedReports).toBe(0);
    expect(result.retainedBytes).toBe(utf8Bytes("invalid"));
    expect(result.limitsSatisfied).toBe(true);
  });

  it("does not refresh future report or artifact timestamps on later retention runs", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const later = now + 24 * 60 * 60 * 1000;
    const future = now + 365 * 24 * 60 * 60 * 1000;
    const futureDate = new Date(future).toISOString();
    const store = new AgentIncidentStore(adapter, { now: () => now });
    const report = store.serialize(incidentReport(250, futureDate));
    const reportArtifactPath = `${reportPath(251)}.corrupt`;
    const unknownArtifactPath = `${AGENT_INCIDENT_STORE_PATH}/future-artifact.bin`;
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    adapter.files.set(reportPath(250), { data: report, ctime: future, mtime: future });
    adapter.files.set(reportArtifactPath, {
      data: JSON.stringify({ created_at: futureDate, invalid: true }),
      ctime: future,
      mtime: future,
    });
    adapter.files.set(unknownArtifactPath, { data: "invalid", ctime: future, mtime: future });
    for (const path of [reportPath(250), reportArtifactPath, unknownArtifactPath]) {
      adapter.removeFailures.add(path);
    }

    const first = await store.initialize();

    expect(first.limitsSatisfied).toBe(false);
    expect(first.cleanupFailures).toBe(3);
    expect(adapter.files.has(reportPath(250))).toBe(true);
    expect(adapter.files.has(reportArtifactPath)).toBe(true);
    expect(adapter.files.has(unknownArtifactPath)).toBe(true);

    adapter.removeFailures.clear();
    const second = await new AgentIncidentStore(adapter, { now: () => later }).initialize();

    expect(second.removedReports).toBe(1);
    expect(second.removedArtifacts).toBe(2);
    expect(second.limitsSatisfied).toBe(true);
    expect(adapter.files.has(reportPath(250))).toBe(false);
    expect(adapter.files.has(reportArtifactPath)).toBe(false);
    expect(adapter.files.has(unknownArtifactPath)).toBe(false);
  });

  it.each(["stat", "read"] as const)(
    "marks a report %s failure as an incomplete retention scan and incident lookup",
    async (operation) => {
      const adapter = new MemoryAdapter();
      adapter.directories.add(".systemsculpt");
      adapter.directories.add(".systemsculpt/diagnostics");
      adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
      const store = new AgentIncidentStore(adapter);
      adapter.put(reportPath(260), store.serialize(incidentReport(260)));
      if (operation === "stat") {
        jest.spyOn(adapter, "stat").mockImplementation(async (path) => {
          if (path === reportPath(260)) throw new Error("injected-stat-failure");
          return null;
        });
      } else {
        const read = adapter.read.bind(adapter);
        jest.spyOn(adapter, "read").mockImplementation(async (path) => {
          if (path === reportPath(260)) throw new Error("injected-read-failure");
          return read(path);
        });
      }

      const result = await store.initialize();

      expect(result.scanComplete).toBe(false);
      expect(result.limitsSatisfied).toBe(false);
      expect(result.cleanupFailures).toBe(1);
      expect(adapter.files.has(reportPath(260))).toBe(true);
      await expect(store.loadByReportId(reportId(260)))
        .rejects.toMatchObject({ code: "lookup_incomplete" });
      await expect(store.loadByIncidentId(incidentId(260)))
        .rejects.toMatchObject({ code: "lookup_incomplete" });
    },
  );

  it("bounds directory entry inspection and sorting work", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    const files = Array.from(
      { length: AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES + 1 },
      (_, index) => `${AGENT_INCIDENT_STORE_PATH}/artifact-${String(index).padStart(4, "0")}.bin`,
    );
    Object.defineProperty(files, AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES, {
      configurable: true,
      get: () => { throw new Error("directory-entry-bound-exceeded"); },
    });
    jest.spyOn(adapter, "list").mockResolvedValue({ files, folders: [] });
    const statSpy = jest.spyOn(adapter, "stat");

    const result = await new AgentIncidentStore(adapter).initialize();

    expect(statSpy).toHaveBeenCalledTimes(AGENT_INCIDENT_MAX_SCAN_CANDIDATES);
    expect(result.scanComplete).toBe(false);
    expect(result.inspectedCandidates).toBe(AGENT_INCIDENT_MAX_SCAN_CANDIDATES);
    expect(result.skippedCandidates).toBeGreaterThan(0);
    expect(result.limitsSatisfied).toBe(false);
  });

  it("stops reading hostile report candidates at the cumulative byte budget", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    const hostilePayload = `{${"x".repeat(AGENT_INCIDENT_MAX_REPORT_BYTES - 1)}`;
    for (let sequence = 1_000; sequence < 1_000 + AGENT_INCIDENT_MAX_DIRECTORY_ENTRIES; sequence += 1) {
      adapter.put(reportPath(sequence), hostilePayload);
    }
    const readSpy = jest.spyOn(adapter, "read");

    const result = await new AgentIncidentStore(adapter).initialize();

    expect(readSpy).toHaveBeenCalledTimes(AGENT_INCIDENT_MAX_SCAN_BYTES / AGENT_INCIDENT_MAX_REPORT_BYTES);
    expect(result.scanComplete).toBe(false);
    expect(result.inspectedBytes).toBe(AGENT_INCIDENT_MAX_SCAN_BYTES);
    expect(result.skippedCandidates).toBeGreaterThan(0);
    expect(result.limitsSatisfied).toBe(false);
  });

  it("prioritizes owned reports before unrelated artifacts within the bounded scan", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    for (let index = 0; index < AGENT_INCIDENT_MAX_SCAN_CANDIDATES; index += 1) {
      adapter.put(`${AGENT_INCIDENT_STORE_PATH}/0000-artifact-${String(index).padStart(4, "0")}.bin`, "x");
    }
    adapter.put(reportPath(2_100), new AgentIncidentStore(adapter).serialize(incidentReport(2_100)));

    await expect(new AgentIncidentStore(adapter).loadByIncidentId(incidentId(2_100)))
      .resolves.toMatchObject({ report: { report_id: reportId(2_100) } });
  });

  it("does not report an exhaustive incident miss when owned reports exceed the scan bound", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    const serializer = new AgentIncidentStore(adapter);
    adapter.put(reportPath(2_101), serializer.serialize(incidentReport(2_101)));
    adapter.put(reportPath(2_102), serializer.serialize(incidentReport(2_102)));

    await expect(new AgentIncidentStore(adapter, { maxScanCandidates: 1 })
      .loadByIncidentId(incidentId(2_102)))
      .rejects.toMatchObject({ code: "lookup_incomplete" });
  });

  it("yields to the host between scan batches", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    for (let index = 0; index < 33; index += 1) {
      adapter.put(`${AGENT_INCIDENT_STORE_PATH}/artifact-${String(index).padStart(4, "0")}.bin`, "x");
    }
    const yieldToHost = jest.fn(async () => undefined);

    const result = await new AgentIncidentStore(adapter, { yieldToHost }).initialize();

    expect(yieldToHost).toHaveBeenCalledTimes(2);
    expect(result.scanComplete).toBe(true);
    expect(result.inspectedCandidates).toBe(33);
  });

  it("removes the oldest reports until the 10 MiB-style byte bound is met", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    const measuringStore = new AgentIncidentStore(adapter);
    const first = incidentReport(24, new Date(now - 2000).toISOString());
    const second = incidentReport(25, new Date(now - 1000).toISOString());
    const third = incidentReport(26, new Date(now).toISOString());
    const limit = new TextEncoder().encode(measuringStore.serialize(second)).byteLength
      + new TextEncoder().encode(measuringStore.serialize(third)).byteLength;
    const store = new AgentIncidentStore(adapter, { now: () => now, maxTotalBytes: limit });

    await store.save(first);
    await store.save(second);
    const result = await store.save(third);

    expect(result.retention.limitsSatisfied).toBe(true);
    await expect(store.loadByReportId(reportId(24))).resolves.toBeNull();
    await expect(store.loadByReportId(reportId(25))).resolves.not.toBeNull();
    await expect(store.loadByReportId(reportId(26))).resolves.not.toBeNull();
    expect(result.retention.retainedBytes).toBeLessThanOrEqual(limit);
  });

  it("rejects oversized, cyclic, accessor-backed, and unsupported-schema reports", async () => {
    const adapter = new MemoryAdapter();
    const smallStore = new AgentIncidentStore(adapter, { maxReportBytes: 512 });
    await expect(smallStore.save(incidentReport(27))).rejects.toMatchObject({ code: "report_too_large" });

    const store = new AgentIncidentStore(adapter);

    const cyclic = incidentReport(28) as AgentIncidentStoreReport & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => store.serialize(cyclic)).toThrow(AgentIncidentStoreError);

    const accessor = incidentReport(29) as AgentIncidentStoreReport & { secret?: string };
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "do-not-read" });
    expect(() => store.serialize(accessor)).toThrow(AgentIncidentStoreError);

    const wrongSchema = { ...incidentReport(30), schema_version: "systemsculpt.incident/999" };
    await expect(store.save(wrongSchema as never)).rejects.toMatchObject({ code: "invalid_report" });
  });

  it("rejects unknown fields at every representative report level before writing", async () => {
    const mutations: Array<(report: Record<string, unknown>) => void> = [
      (report) => { report.prompt = "privacy-canary"; },
      (report) => { (report.incident as Record<string, unknown>).detail = "privacy-canary"; },
      (report) => { (report.correlation as Record<string, unknown>).conversation_id = "privacy-canary"; },
      (report) => { (report.environment as Record<string, unknown>).vault_name = "privacy-canary"; },
      (report) => { (report.run_summary as Record<string, unknown>).message = "privacy-canary"; },
      (report) => { ((report.run_summary as Record<string, unknown>).partial_output as Record<string, unknown>).text = "privacy-canary"; },
      (report) => { (report.run_state as Record<string, unknown>).request_id = "privacy-canary"; },
      (report) => { ((report.timeline as Array<Record<string, unknown>>)[0]).path = "privacy-canary"; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).tool_call_id = "privacy-canary"; },
      (report) => { (report.rendering as Record<string, unknown>).message = "privacy-canary"; },
      (report) => { ((((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).renderer) as Record<string, unknown>).text = "privacy-canary"; },
      (report) => { ((((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).scroller) as Record<string, unknown>).row_id = "privacy-canary"; },
      (report) => { ((report.resource_samples as Array<Record<string, unknown>>)[0]).note = "privacy-canary"; },
      (report) => { (report.capture_quality as Record<string, unknown>).raw_error = "privacy-canary"; },
      (report) => { ((report.capture_quality as Record<string, unknown>).limits as Record<string, unknown>).maximum_paths = 1; },
      (report) => { (report.privacy as Record<string, unknown>).extra = "privacy-canary"; },
    ];

    for (let index = 0; index < mutations.length; index += 1) {
      const adapter = new MemoryAdapter();
      const store = new AgentIncidentStore(adapter);
      await expect(store.save(incidentReport(100 + index, undefined, mutations[index])))
        .rejects.toMatchObject({ code: "invalid_report" });
      expect(adapter.writeCalls).toBe(0);
    }
  });

  it("recomputes completeness from canonical evidence and rejects tampered claims", async () => {
    const mutations: Array<(report: Record<string, unknown>) => void> = [
      (report) => { delete (report.environment as Record<string, unknown>).plugin_version; },
      (report) => { delete report.run_state; },
      (report) => { delete report.rendering; },
      (report) => { report.resource_samples = []; },
      (report) => { report.transport_segments = []; },
      (report) => {
        delete (((report.run_summary as Record<string, unknown>).partial_output) as Record<string, unknown>)
          .reasoning_character_count;
      },
    ];

    for (let index = 0; index < mutations.length; index += 1) {
      const adapter = new MemoryAdapter();
      const store = new AgentIncidentStore(adapter);
      await expect(store.save(incidentReport(250 + index, undefined, mutations[index])))
        .rejects.toMatchObject({ code: "invalid_report" });
      expect(adapter.writeCalls).toBe(0);
    }
  });

  it("correlates terminal transport evidence by command kind, segment, and tool ordinal", async () => {
    const matching = incidentReport(256, undefined, (report) => {
      const terminal = (report.timeline as Array<Record<string, unknown>>)[1];
      terminal.command_kind = "submit";
      terminal.command_segment_ordinal = 1;
    });
    await expect(new AgentIncidentStore(new MemoryAdapter()).save(matching))
      .resolves.toMatchObject({ created: true });

    const mismatched = incidentReport(257, undefined, (report) => {
      const terminal = (report.timeline as Array<Record<string, unknown>>)[1];
      terminal.command_kind = "client_tool_result";
      terminal.command_segment_ordinal = 1;
      terminal.tool_execution_ordinal = 1;
      const capture = report.capture_quality as Record<string, unknown>;
      capture.complete = false;
      capture.missing_fields = ["terminal_transport_segment"];
    });
    await expect(new AgentIncidentStore(new MemoryAdapter()).save(mismatched))
      .resolves.toMatchObject({ created: true });

    const tampered = incidentReport(258, undefined, (report) => {
      const terminal = (report.timeline as Array<Record<string, unknown>>)[1];
      terminal.command_kind = "client_tool_result";
      terminal.command_segment_ordinal = 1;
      terminal.tool_execution_ordinal = 1;
    });
    await expect(new AgentIncidentStore(new MemoryAdapter()).save(tampered))
      .rejects.toMatchObject({ code: "invalid_report" });
  });

  it("recomputes terminal transport from a failed receipt and from reconstructed failure evidence", async () => {
    const fromReceipt = incidentReport(259, undefined, (report) => {
      const timeline = report.timeline as Array<Record<string, unknown>>;
      const terminal = timeline[1];
      delete terminal.command_kind;
      delete terminal.command_segment_ordinal;
      terminal.ordinal = 3;
      timeline.splice(1, 0, {
        ordinal: 2,
        timestamp: "2026-08-13T12:00:30.000Z",
        source_sequence: 2,
        code: "response_result_received_failed",
        phase: "response",
        run_id: (report.correlation as Record<string, unknown>).run_id,
        server_run_id: (report.correlation as Record<string, unknown>).server_run_id,
        server_latency_correlation_id:
          (report.correlation as Record<string, unknown>).server_latency_correlation_id,
        command_kind: "submit",
        command_segment_ordinal: 2,
      });
      const summary = report.run_summary as Record<string, unknown>;
      summary.observed_lifecycle_event_count = 3;
      summary.retained_timeline_event_count = 3;
      (summary.lifecycle_code_counts as unknown[]).splice(1, 0, {
        code: "response_result_received_failed",
        count: 1,
      });
      (summary.lifecycle_phase_counts as Array<Record<string, unknown>>)[0].count = 3;
      const capture = report.capture_quality as Record<string, unknown>;
      capture.observed_event_count = 3;
      capture.retained_event_count = 3;
      capture.complete = false;
      capture.missing_fields = ["terminal_transport_segment"];
    });
    await expect(new AgentIncidentStore(new MemoryAdapter()).save(fromReceipt))
      .resolves.toMatchObject({ created: true });

    const reconstructed = incidentReport(260, undefined, (report) => {
      const terminal = (report.timeline as Array<Record<string, unknown>>)[1];
      delete terminal.command_kind;
      delete terminal.command_segment_ordinal;
      (report.run_state as Record<string, unknown>).terminal_source = "message_reconstruction";
      const capture = report.capture_quality as Record<string, unknown>;
      capture.complete = false;
      capture.missing_fields = ["terminal_transport_segment"];
    });
    await expect(new AgentIncidentStore(new MemoryAdapter()).save(reconstructed))
      .resolves.toMatchObject({ created: true });
  });

  it("never invokes getters or toJSON and rejects proxies, symbols, unsupported prototypes, and malformed Unicode", () => {
    const store = new AgentIncidentStore(new MemoryAdapter());
    let getterCalls = 0;
    let toJsonCalls = 0;

    const accessor = incidentReport(120) as AgentIncidentStoreReport & { secret?: string };
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "privacy-canary";
      },
    });
    expect(() => store.serialize(accessor)).toThrow(AgentIncidentStoreError);
    expect(getterCalls).toBe(0);

    const hostileToJson = incidentReport(121) as AgentIncidentStoreReport & { toJSON?: () => unknown };
    Object.defineProperty(hostileToJson, "toJSON", {
      enumerable: true,
      value: () => {
        toJsonCalls += 1;
        return { prompt: "privacy-canary" };
      },
    });
    expect(() => store.serialize(hostileToJson)).toThrow(AgentIncidentStoreError);
    expect(toJsonCalls).toBe(0);

    const symbolBacked = incidentReport(122) as AgentIncidentStoreReport & Record<symbol, unknown>;
    symbolBacked[Symbol("secret")] = "privacy-canary";
    expect(() => store.serialize(symbolBacked)).toThrow(AgentIncidentStoreError);

    const proxied = new Proxy(incidentReport(123), {
      ownKeys: () => { throw new Error("privacy-canary"); },
    });
    expect(() => store.serialize(proxied)).toThrow(AgentIncidentStoreError);

    const dated = incidentReport(124) as AgentIncidentStoreReport & { environment: Date };
    dated.environment = new Date();
    expect(() => store.serialize(dated)).toThrow(AgentIncidentStoreError);

    const malformedUnicode = incidentReport(125) as AgentIncidentStoreReport & { environment: { plugin_version: string } };
    malformedUnicode.environment.plugin_version = "6.6.0\ud800";
    expect(() => store.serialize(malformedUnicode)).toThrow(AgentIncidentStoreError);
  });

  it("never invokes inherited toJSON hooks and preserves canonical bytes", () => {
    const store = new AgentIncidentStore(new MemoryAdapter());
    const report = incidentReport(126);
    const expected = store.serialize(report);
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let arrayCalls = 0;
    let objectCalls = 0;
    let actual = "";

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
      actual = store.serialize(report);
    } finally {
      if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
      if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }

    expect(arrayCalls).toBe(0);
    expect(objectCalls).toBe(0);
    expect(actual).toBe(expected);
    expect(JSON.parse(actual)).toMatchObject({ report_id: reportId(126) });
    expect(actual).not.toContain("private_array_canary");
    expect(actual).not.toContain("private_object_canary");
  });

  it("rejects zero IDs, unknown failure codes, and contradictory terminal facts", async () => {
    const store = new AgentIncidentStore(new MemoryAdapter());

    await expect(store.save(incidentReport(130, undefined, (report) => {
      report.report_id = `report_${"0".repeat(32)}`;
    }))).rejects.toMatchObject({ code: "invalid_identifier" });
    await expect(store.save(incidentReport(131, undefined, (report) => {
      (report.incident as Record<string, unknown>).incident_id = `incident_${"0".repeat(32)}`;
    }))).rejects.toMatchObject({ code: "invalid_identifier" });
    await expect(store.save(incidentReport(132, undefined, (report) => {
      (report.correlation as Record<string, unknown>).server_run_id = `run_${"0".repeat(32)}`;
    }))).rejects.toMatchObject({ code: "invalid_report" });
    await expect(store.save(incidentReport(133, undefined, (report) => {
      (report.correlation as Record<string, unknown>).server_latency_correlation_id = "0".repeat(32);
    }))).rejects.toMatchObject({ code: "invalid_report" });
    await expect(store.save(incidentReport(134, undefined, (report) => {
      (report.incident as Record<string, unknown>).failure_code = "privacy_canary_failure";
      ((report.timeline as Array<Record<string, unknown>>)[1]).failure_code = "privacy_canary_failure";
    }))).rejects.toMatchObject({ code: "invalid_report" });
    await expect(store.save(incidentReport(135, undefined, (report) => {
      (report.incident as Record<string, unknown>).retryable = false;
    }))).rejects.toMatchObject({ code: "invalid_report" });
    await expect(store.save(incidentReport(136, undefined, (report) => {
      const incident = report.incident as Record<string, unknown>;
      incident.failure_authority = "client";
      incident.origin = "agent_local_failure";
      incident.terminal_evidence = "client_observed";
      incident.observation_source = "client_runtime";
      incident.failure_code = "unknown_client_failure";
      ((report.timeline as Array<Record<string, unknown>>)[1]).failure_code = "unknown_client_failure";
      const summary = report.run_summary as Record<string, unknown>;
      summary.terminal_receipt = "client_emitted_local_failure";
      summary.terminal_validation = "unvalidated";
      (report.run_state as Record<string, unknown>).terminal_source = "local_failure";
    }))).resolves.toMatchObject({ created: true });
  });

  it("enforces the closed terminal provenance matrix", async () => {
    const validMutations: Array<(report: Record<string, unknown>) => void> = [
      () => undefined,
      (report) => {
        (report.run_state as Record<string, unknown>).terminal_source = "message_reconstruction";
      },
      (report) => {
        const incident = report.incident as Record<string, unknown>;
        incident.failure_authority = "client";
        incident.origin = "agent_local_failure";
        incident.terminal_evidence = "client_observed";
        incident.observation_source = "client_runtime";
        const summary = report.run_summary as Record<string, unknown>;
        summary.terminal_receipt = "client_emitted_local_failure";
        summary.terminal_validation = "unvalidated";
        (report.run_state as Record<string, unknown>).terminal_source = "local_failure";
      },
      (report) => {
        const incident = report.incident as Record<string, unknown>;
        incident.failure_authority = "unknown";
        incident.terminal_evidence = "unvalidated";
        incident.observation_source = "client_runtime";
        const summary = report.run_summary as Record<string, unknown>;
        summary.terminal_receipt = "unknown";
        summary.terminal_validation = "not_recorded";
        const capture = report.capture_quality as Record<string, unknown>;
        capture.complete = false;
        capture.missing_fields = ["failure_authority", "terminal_validation"];
      },
      (report) => {
        delete report.run_state;
        (report.run_summary as Record<string, unknown>).terminal_receipt = "unknown";
        const capture = report.capture_quality as Record<string, unknown>;
        capture.complete = false;
        capture.missing_fields = ["run_state"];
      },
    ];
    for (let index = 0; index < validMutations.length; index += 1) {
      await expect(new AgentIncidentStore(new MemoryAdapter()).save(
        incidentReport(300 + index, undefined, validMutations[index]),
      )).resolves.toMatchObject({ created: true });
    }

    const invalidMutations: Array<(report: Record<string, unknown>) => void> = [
      (report) => { (report.run_summary as Record<string, unknown>).terminal_receipt = "received"; },
      (report) => { (report.run_summary as Record<string, unknown>).terminal_receipt = "client_emitted_local_failure"; },
      (report) => { (report.run_summary as Record<string, unknown>).terminal_receipt = "unknown"; },
      (report) => { (report.run_state as Record<string, unknown>).terminal_source = "local_failure"; },
      (report) => {
        const incident = report.incident as Record<string, unknown>;
        incident.failure_authority = "client";
        incident.origin = "agent_local_failure";
        incident.terminal_evidence = "client_observed";
      },
      (report) => {
        delete report.run_state;
        (report.run_summary as Record<string, unknown>).terminal_receipt = "client_received_server_terminal";
        const capture = report.capture_quality as Record<string, unknown>;
        capture.complete = false;
        capture.missing_fields = ["run_state"];
      },
    ];
    for (let index = 0; index < invalidMutations.length; index += 1) {
      await expect(new AgentIncidentStore(new MemoryAdapter()).save(
        incidentReport(310 + index, undefined, invalidMutations[index]),
      )).rejects.toMatchObject({ code: "invalid_report" });
    }
  });

  it("rejects conflicting timeline correlation and extended-year timestamps", () => {
    const store = new AgentIncidentStore(new MemoryAdapter());
    expect(() => store.serialize(incidentReport(137, undefined, (report) => {
      ((report.timeline as Array<Record<string, unknown>>)[1]).server_run_id = `run_${"f".repeat(32)}`;
    }))).toThrow(AgentIncidentStoreError);
    expect(() => store.serialize(incidentReport(138, "+010000-01-01T00:00:00.000Z")))
      .toThrow(AgentIncidentStoreError);
    expect(() => store.serialize(incidentReport(139, "9999-12-31T23:59:59.999Z")))
      .not.toThrow();
  });

  it("validates the versioned grouping fingerprint and ignores unique correlation facts", () => {
    const first = incidentReport(1370) as unknown as Record<string, unknown>;
    const second = incidentReport(1371) as unknown as Record<string, unknown>;
    const firstGrouping = first.grouping as Record<string, unknown>;
    const secondGrouping = second.grouping as Record<string, unknown>;

    expect(firstGrouping.fingerprint).toBe(secondGrouping.fingerprint);

    firstGrouping.fingerprint = "systemsculpt.failure-contract/1|authority=server|stage=response_terminal|mechanism=service_terminal|failure=response_failed|status=5xx|terminal=session_terminal";
    settleReportBytes(first);
    expect(() => new AgentIncidentStore(new MemoryAdapter()).serialize(
      first as unknown as AgentIncidentStoreReport,
    )).toThrow(AgentIncidentStoreError);

    secondGrouping.strategy = "systemsculpt.failure-contract/2";
    settleReportBytes(second);
    expect(() => new AgentIncidentStore(new MemoryAdapter()).serialize(
      second as unknown as AgentIncidentStoreReport,
    )).toThrow(AgentIncidentStoreError);
  });

  it("groups HTTP failures by status class and validates evidence truth fields", () => {
    const sameClass = incidentReport(1380, undefined, (report) => {
      (report.incident as Record<string, unknown>).http_status = 500;
      ((report.timeline as Array<Record<string, unknown>>)[1]).status = 500;
    }) as unknown as Record<string, unknown>;
    const baseline = incidentReport(1381) as unknown as Record<string, unknown>;
    const differentClass = incidentReport(1382, undefined, (report) => {
      (report.incident as Record<string, unknown>).http_status = 404;
      ((report.timeline as Array<Record<string, unknown>>)[1]).status = 404;
    }) as unknown as Record<string, unknown>;

    expect((sameClass.grouping as Record<string, unknown>).fingerprint)
      .toBe((baseline.grouping as Record<string, unknown>).fingerprint);
    expect((differentClass.grouping as Record<string, unknown>).fingerprint)
      .not.toBe((baseline.grouping as Record<string, unknown>).fingerprint);

    const incident = baseline.incident as Record<string, unknown>;
    incident.terminal_evidence = "client_observed";
    settleReportBytes(baseline);
    expect(() => new AgentIncidentStore(new MemoryAdapter()).serialize(
      baseline as unknown as AgentIncidentStoreReport,
    )).toThrow(AgentIncidentStoreError);
  });

  it("rejects unknown failure taxonomy and contradictory partial-output facts", () => {
    const mutations: Array<(report: Record<string, unknown>) => void> = [
      (report) => {
        (report.incident as Record<string, unknown>).failure_stage = "private_stage";
      },
      (report) => {
        (report.incident as Record<string, unknown>).failure_mechanism = "private_mechanism";
      },
      (report) => {
        const partial = (report.run_summary as Record<string, unknown>).partial_output as Record<string, unknown>;
        partial.assistant_output_present_before_failure = false;
      },
      (report) => {
        const partial = (report.run_summary as Record<string, unknown>).partial_output as Record<string, unknown>;
        partial.assistant_output_retained_in_failed_projection = true;
        delete partial.assistant_output_present_before_failure;
      },
      (report) => {
        const partial = (report.run_summary as Record<string, unknown>).partial_output as Record<string, unknown>;
        partial.assistant_text_streaming_part_count = 0;
      },
    ];

    for (let index = 0; index < mutations.length; index += 1) {
      expect(() => new AgentIncidentStore(new MemoryAdapter()).serialize(
        incidentReport(1390 + index, undefined, mutations[index]),
      )).toThrow(AgentIncidentStoreError);
    }
  });

  it("rejects contradictory tool totals and accepts a consistent bounded tool summary", async () => {
    const tool = {
      ordinal: 1,
      tool_name: "read",
      outcome: "failed",
      failure_class: "partial_failure",
      requested_item_count: 4,
      completed_item_count: 3,
      failed_item_count: 1,
      result_delivery: "failed",
      result_acknowledgement: "not_observed",
      terminal_dom_committed: true,
      terminal_paint_opportunity_observed: true,
      lifecycle_event_count: 1,
    };
    const store = new AgentIncidentStore(new MemoryAdapter());
    await expect(store.save(incidentReport(140, undefined, (report) => {
      report.tools = [{ ...tool, requested_item_count: 3 }];
    }))).rejects.toMatchObject({ code: "invalid_report" });
    await expect(store.save(incidentReport(141, undefined, (report) => {
      report.tools = [tool];
    }))).resolves.toMatchObject({ created: true });
  });

  it("accepts tool completion before start when the wall clock moves backward", async () => {
    const adapter = new MemoryAdapter();
    const store = new AgentIncidentStore(adapter);
    const report = incidentReport(142, undefined, (candidate) => {
      candidate.tools = [{
        ordinal: 1,
        tool_name: "read",
        started_at: "2026-08-13T12:00:10.000Z",
        completed_at: "2026-08-13T11:59:55.000Z",
        outcome: "succeeded",
        result_delivery: "succeeded",
        result_acknowledgement: "succeeded",
        terminal_dom_committed: true,
        terminal_paint_opportunity_observed: true,
        lifecycle_event_count: 1,
      }];
    });

    await expect(store.save(report)).resolves.toMatchObject({ created: true });
    await expect(store.loadByReportId(reportId(142))).resolves.toMatchObject({
      report: { tools: [{ completed_at: "2026-08-13T11:59:55.000Z" }] },
    });
  });

  it("accepts the exact bounded transport, run-state, and rendering schema", async () => {
    const store = new AgentIncidentStore(new MemoryAdapter());
    const report = incidentReport(145, undefined, (candidate) => {
      candidate.transport_segments = [{
        command_kind: "client_tool_result",
        segment_ordinal: 100_000_000,
        tool_execution_ordinal: 512,
        close_reason: "stream_failed",
        duration_ms: 604_800_000,
        received_bytes: 64 * 1024 * 1024,
        raw_chunk_count: 10_000,
        sse_event_count: 10_000,
        accepted_frame_count: 10_000,
        delivered_frame_count: 10_000,
        metrics_truncated: true,
      }];
      const terminal = (candidate.timeline as Array<Record<string, unknown>>)[1];
      terminal.command_kind = "client_tool_result";
      terminal.command_segment_ordinal = 100_000_000;
      terminal.tool_execution_ordinal = 512;
      const renderingEvidence = candidate.rendering as Record<string, unknown>;
      const rendering = renderingEvidence.after_terminal_commit as Record<string, unknown>;
      rendering.render_pass_count = 1_000_000;
      rendering.last_render_duration_ms = 86_400_000;
      const renderer = rendering.renderer as Record<string, unknown>;
      renderer.historical_part_count = 1_000_000;
      renderer.max_render_duration_ms = 86_400_000;
      const scroller = rendering.scroller as Record<string, unknown>;
      scroller.pending_layout_mutation_count = 1_000_000;
      const capture = candidate.capture_quality as Record<string, unknown>;
      capture.complete = false;
      capture.truncated = true;
    });

    await expect(store.save(report)).resolves.toMatchObject({ created: true });
  });

  it("rejects invalid transport, run-state, rendering, and capture bounds before writing", async () => {
    const mutations: Array<(report: Record<string, unknown>) => void> = [
      (report) => { delete report.transport_segments; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).command_kind = "private_command"; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).segment_ordinal = 0; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).tool_execution_ordinal = 513; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).close_reason = "private_failure"; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).duration_ms = 1.2345; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).received_bytes = 64 * 1024 * 1024 + 1; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).raw_chunk_count = 10_001; },
      (report) => { ((report.transport_segments as Array<Record<string, unknown>>)[0]).metrics_truncated = "true"; },
      (report) => { (report.run_state as Record<string, unknown>).terminal_source = "private_source"; },
      (report) => { (report.run_state as Record<string, unknown>).executing_local_tool_count = 100_000_001; },
      (report) => { (report.run_state as Record<string, unknown>).counts_truncated = "false"; },
      (report) => { (((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).render_state) = "private_state"; },
      (report) => { (((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).render_pass_count) = 1_000_001; },
      (report) => { (((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).last_render_duration_ms) = 86_400_001; },
      (report) => { (((((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).renderer) as Record<string, unknown>).rendering_enabled) = 1; },
      (report) => { (((((report.rendering as Record<string, unknown>).after_terminal_commit as Record<string, unknown>).scroller) as Record<string, unknown>).distance_from_end_bucket) = "private_distance"; },
      (report) => { (((report.capture_quality as Record<string, unknown>).limits) as Record<string, unknown>).maximum_transport_segments = 65; },
      (report) => { (report.capture_quality as Record<string, unknown>).dropped_transport_segment_count = 1; },
    ];

    for (let index = 0; index < mutations.length; index += 1) {
      const adapter = new MemoryAdapter();
      const store = new AgentIncidentStore(adapter);
      await expect(store.save(incidentReport(200 + index, undefined, mutations[index])))
        .rejects.toMatchObject({ code: "invalid_report" });
      expect(adapter.writeCalls).toBe(0);
    }
  });

  it("serializes concurrent store instances and preserves immutable report IDs", async () => {
    const adapter = new MemoryAdapter();
    adapter.delayWrites = true;
    const firstStore = new AgentIncidentStore(adapter);
    const secondStore = new AgentIncidentStore(adapter);
    const report = incidentReport(150);

    const [first, second] = await Promise.all([firstStore.save(report), secondStore.save(report)]);

    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.serialized).toBe(second.serialized);
    expect(adapter.maximumConcurrentWrites).toBe(1);

    const conflict = incidentReport(150, undefined, (candidate) => {
      (candidate.incident as Record<string, unknown>).retryable = false;
      ((candidate.timeline as Array<Record<string, unknown>>)[1]).retryable = false;
    });
    await expect(secondStore.save(conflict)).rejects.toMatchObject({ code: "duplicate_report_id" });
  });

  it("isolates valid but noncanonical disk JSON instead of copying different bytes", async () => {
    const adapter = new MemoryAdapter();
    adapter.directories.add(".systemsculpt");
    adapter.directories.add(".systemsculpt/diagnostics");
    adapter.directories.add(AGENT_INCIDENT_STORE_PATH);
    const store = new AgentIncidentStore(adapter);
    const canonical = store.serialize(incidentReport(160));
    const noncanonical = JSON.stringify(reverseObjectKeys(JSON.parse(canonical)));
    expect(noncanonical).not.toBe(canonical);
    adapter.put(reportPath(160), noncanonical);

    await expect(new AgentIncidentStore(adapter).loadByReportId(reportId(160))).resolves.toBeNull();
    expect(adapter.files.has(reportPath(160))).toBe(false);
    expect(adapter.files.has(`${reportPath(160)}.corrupt`)).toBe(true);
  });

  it("rejects unverifiable writes after the bounded retry count", async () => {
    const adapter = new MemoryAdapter();
    adapter.corruptWrites = true;
    const store = new AgentIncidentStore(adapter, { writeAttempts: 3 });

    await expect(store.save(incidentReport(170))).rejects.toMatchObject({ code: "persistence_unavailable" });
    expect(adapter.writeCalls).toBe(3);
    expect(adapter.files.has(reportPath(170))).toBe(false);
    expect(adapter.files.has(`${reportPath(170)}.tmp`)).toBe(false);
  });

  it("reports retention limits as unsatisfied when an old report cannot be removed", async () => {
    const adapter = new MemoryAdapter();
    const store = new AgentIncidentStore(adapter, { maxReports: 1 });
    await store.save(incidentReport(180));
    adapter.clock += 1000;
    adapter.removeFailures.add(reportPath(180));

    const result = await store.save(incidentReport(181));

    expect(result.retention.limitsSatisfied).toBe(false);
    expect(result.retention.cleanupFailures).toBe(1);
    expect(result.retention.retainedReports).toBe(2);
  });
});
