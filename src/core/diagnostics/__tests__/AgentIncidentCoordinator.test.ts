import type { ListedFiles, Stat } from "obsidian";
import {
  AgentIncidentCoordinator,
} from "../AgentIncidentCoordinator";
import {
  AgentIncidentRecorder,
  type AgentIncidentReport,
} from "../AgentIncidentRecorder";
import {
  AgentIncidentStore,
  type AgentIncidentStoreAdapter,
} from "../AgentIncidentStore";
import type { SupportDiagnosticEvent } from "../../../utils/PluginLogger";
import { isThinAgentRequestId } from "../../../utils/ThinAgentLifecycleSchema";
import type {
  AgentChatTransportSegmentSummaryEvent,
  AgentRunFailureCaptureEvent,
} from "../../../views/chatview/agent/ChatSession";

const BASE_TIME = Date.parse("2026-08-13T18:00:00.000Z");
const PLUGIN_BUILD_ID = `sha256:${"a".repeat(64)}`;
const LOADED_BUNDLE_SHA256 = "b".repeat(64);

interface MemoryFile {
  data: string;
  ctime: number;
  mtime: number;
}

class MemoryAdapter implements AgentIncidentStoreAdapter {
  public readonly files = new Map<string, MemoryFile>();
  public readonly directories = new Set<string>();
  public writeFailures = 0;
  public readFailures = 0;
  public initializeFailures = 0;
  public writeCalls = 0;
  public clock = BASE_TIME;
  private writeGate: Promise<void> | null = null;
  private releaseWriteGate: (() => void) | null = null;

  public async exists(path: string): Promise<boolean> {
    if (this.initializeFailures > 0) {
      this.initializeFailures -= 1;
      throw new Error("injected-initialize-failure");
    }
    return this.files.has(path) || this.directories.has(path);
  }

  public async stat(path: string): Promise<Stat | null> {
    const file = this.files.get(path);
    if (file) {
      return {
        type: "file",
        ctime: file.ctime,
        mtime: file.mtime,
        size: new TextEncoder().encode(file.data).byteLength,
      };
    }
    if (!this.directories.has(path)) return null;
    return { type: "folder", ctime: this.clock, mtime: this.clock, size: 0 };
  }

  public async list(path: string): Promise<ListedFiles> {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("injected-list-failure");
    }
    if (!this.directories.has(path)) throw new Error("missing-directory");
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((candidate) => (
        candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/")
      )),
      folders: [...this.directories].filter((candidate) => (
        candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/")
      )),
    };
  }

  public async read(path: string): Promise<string> {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("injected-read-failure");
    }
    const file = this.files.get(path);
    if (!file) throw new Error("missing-file");
    return file.data;
  }

  public async write(path: string, data: string): Promise<void> {
    this.writeCalls += 1;
    if (this.writeGate) await this.writeGate;
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      throw new Error("injected-write-failure");
    }
    const previous = this.files.get(path);
    this.files.set(path, {
      data,
      ctime: previous?.ctime ?? this.clock,
      mtime: this.clock,
    });
  }

  public async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  public async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  public async rename(path: string, newPath: string): Promise<void> {
    const file = this.files.get(path);
    if (!file) throw new Error("missing-source");
    this.files.set(newPath, file);
    this.files.delete(path);
  }

  public blockWrites(): void {
    if (this.writeGate) return;
    this.writeGate = new Promise((resolve) => {
      this.releaseWriteGate = resolve;
    });
  }

  public releaseWrites(): void {
    this.releaseWriteGate?.();
    this.releaseWriteGate = null;
    this.writeGate = null;
  }
}

type Correlation = Readonly<{
  conversationId: string;
  requestId: string;
  incidentId: string;
  runId: string;
}>;

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0").slice(-width);
}

function correlation(value: number): Correlation {
  const token = hex(value, 32);
  const request = hex(value, 30);
  return Object.freeze({
    conversationId: `conversation_${token}`,
    requestId: `user-${request.slice(0, 8)}-${request.slice(8, 12)}-4${request.slice(12, 15)}-8${request.slice(15, 18)}-${request.slice(18, 30)}`,
    incidentId: `incident_${token}`,
    runId: `run_${token}`,
  });
}

function reportId(value: number): string {
  return `report_${hex(value, 32)}`;
}

function lifecycle(
  ids: Correlation,
  code: SupportDiagnosticEvent["code"],
  sequence: number,
  extra: Partial<SupportDiagnosticEvent> = {},
): SupportDiagnosticEvent {
  return {
    timestamp: new Date(BASE_TIME + sequence).toISOString(),
    severity: "info",
    code,
    phase: code === "run_started" ? "start" : "response",
    sequence,
    conversation_id: ids.conversationId,
    request_id: ids.requestId,
    plugin_build_id: PLUGIN_BUILD_ID,
    run_id: ids.runId,
    server_run_id: ids.runId,
    ...(code === "run_finished_failed"
      ? {
          incident_id: ids.incidentId,
          failure_code: "response_capacity_unavailable",
          retryable: true,
          status: 503,
        }
      : {}),
    ...extra,
  };
}

function failure(
  ids: Correlation,
  extra: Partial<AgentRunFailureCaptureEvent> = {},
): AgentRunFailureCaptureEvent {
  return {
    kind: "agent_run_failed",
    conversationId: ids.conversationId,
    requestId: ids.requestId,
    failureAuthority: "server",
    failureStage: "response_terminal",
    failureMechanism: "service_terminal",
    terminalValidation: "validated",
    terminalSource: "session_terminal",
    hostProcessState: "responsive",
    chatViewState: "unknown",
    runOrigin: "submitted",
    runPhase: "working",
    connectionState: "open",
    elapsedMs: 35_695,
    elapsedMsTruncated: false,
    serverRunId: ids.runId,
    incidentId: ids.incidentId,
    failureCode: "response_capacity_unavailable",
    retryable: true,
    assistantTextPartCount: 2,
    assistantTextStreamingPartCount: 1,
    assistantTextCompletePartCount: 1,
    assistantTextCharacterCount: 144,
    reasoningPartCount: 3,
    reasoningStreamingPartCount: 2,
    reasoningCompletePartCount: 1,
    reasoningCharacterCount: 610,
    assistantOutputPresentBeforeFailure: true,
    assistantOutputRetainedInFailedProjection: true,
    snapshotPartCount: 9,
    executingLocalToolCount: 1,
    pendingToolDeliveryCount: 2,
    pendingApprovalDeliveryCount: 3,
    pendingToolTaskCount: 4,
    serverQueued: true,
    runStalled: true,
    awaitingClientWork: true,
    pendingCancel: true,
    pendingRegenerate: true,
    countsTruncated: true,
    ...extra,
  };
}

function rendering() {
  return {
    renderState: "idle" as const,
    renderPassCount: 18,
    pendingRenderCount: 0,
    lastRenderDurationMs: 4,
    maxRenderDurationMs: 12,
    firstDomCommitObserved: true,
    firstPaintOpportunityObserved: true,
    registeredRowCount: 2,
    renderer: {
      renderPassCount: 18,
      pendingRenderPassCount: 0,
      lastRenderDurationMs: 4,
      maxRenderDurationMs: 12,
      historicalRowCount: 1,
      historicalPartCount: 3,
      activePartCount: 5,
      disclosureCount: 4,
      openDisclosureCount: 0,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 2,
      overflowDisclosureCount: 0,
      pendingHydrationCount: 0,
      renderingEnabled: true,
    },
    scroller: {
      mode: "end" as const,
      distanceFromEndBucket: "at_end" as const,
      registeredRowCount: 2,
      pendingLayoutMutationCount: 0,
      layoutMutationPending: false,
      geometryUpdatePending: false,
      programmaticScrollPending: false,
      submittedPromptAnchorActive: true,
      destroyed: false,
    },
  };
}

function recordFailureSurface(
  coordinator: AgentIncidentCoordinator,
  ids: Correlation,
): void {
  coordinator.recordFailureSurfaceRendering({
    conversationId: ids.conversationId,
    requestId: ids.requestId,
    milestone: "dom_committed",
    rendering: {
      ...rendering(),
      renderPassCount: 19,
    },
  });
  coordinator.recordFailureSurfaceRendering({
    conversationId: ids.conversationId,
    requestId: ids.requestId,
    milestone: "paint_opportunity_observed",
    rendering: {
      ...rendering(),
      renderPassCount: 19,
    },
  });
}

function transport(ids: Correlation): AgentChatTransportSegmentSummaryEvent {
  return {
    conversationId: ids.conversationId,
    requestId: ids.requestId,
    commandKind: "submit",
    commandSegmentOrdinal: 1,
    toolExecutionOrdinal: 2,
    closeReason: "response_rejected",
    durationMs: 35_695,
    receivedBytes: 8_192,
    nonEmptyRawChunkCount: 17,
    sseEventCount: 16,
    acceptedFrameCount: 15,
    deliveredFrameCount: 14,
    metricsTruncated: false,
  };
}

function environmentProvider() {
  return {
    pluginVersion: "6.6.0",
    pluginBuildId: PLUGIN_BUILD_ID,
    loadedBundleSha256: LOADED_BUNDLE_SHA256,
    obsidianVersion: "1.13.4",
    hostType: "desktop" as const,
    osFamily: "macos" as const,
  };
}

function resourceSamplesProvider() {
  return [{
    captured_at: "2026-08-13T18:00:35.695Z",
    heap_used_mb: 218,
    heap_limit_mb: 4_096,
    rss_mb: 405,
    cpu_percent: 8,
    event_loop_lag_ms: 9,
    freeze_delta_ms: 0,
  }];
}

function realHarness(adapter = new MemoryAdapter()) {
  let nextReport = 1;
  const recorder = new AgentIncidentRecorder({
    now: () => BASE_TIME + 60_000,
    createReportId: () => reportId(nextReport++),
  });
  const store = new AgentIncidentStore(adapter, { now: () => BASE_TIME + 60_000 });
  const coordinator = new AgentIncidentCoordinator({
    recorder,
    store,
    environmentProvider,
    resourceSamplesProvider,
    failureSurfaceWaitMs: 1,
  });
  return { adapter, recorder, store, coordinator };
}

function begin(coordinator: AgentIncidentCoordinator, ids: Correlation): void {
  coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
  coordinator.recordTransport(transport(ids));
}

function finish(coordinator: AgentIncidentCoordinator, ids: Correlation): void {
  coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 9));
  recordFailureSurface(coordinator, ids);
}

function fakeReport(value: number): AgentIncidentReport {
  return {
    report_id: reportId(value),
    incident: { incident_id: correlation(value).incidentId },
  } as AgentIncidentReport;
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeDependencies(options: {
  finalize?: (ids: Readonly<{ conversationId: string; requestId: string }>) => AgentIncidentReport | null;
  initialize?: () => Promise<unknown>;
  save?: (report: AgentIncidentReport) => Promise<unknown>;
  load?: (incidentId: string) => Promise<unknown>;
} = {}) {
  const recorder = {
    record: jest.fn(() => true),
    reserveReportId: jest.fn((ids: Readonly<{ conversationId: string }>) => {
      const suffix = ids.conversationId.slice(-32);
      return `report_${suffix}`;
    }),
    attachEnvironment: jest.fn(() => true),
    attachResourceSamples: jest.fn(() => true),
    attachTransportSegment: jest.fn(() => true),
    finalize: jest.fn((ids: Readonly<{ conversationId: string; requestId: string }>) => (
      options.finalize?.(ids) ?? null
    )),
  };
  const store = {
    initialize: jest.fn(options.initialize ?? (async () => undefined)),
    serialize: jest.fn((report: AgentIncidentReport) => `canonical:${report.report_id}`),
    save: jest.fn(options.save ?? (async () => undefined)),
    loadByIncidentId: jest.fn(options.load ?? (async () => null)),
    loadByReportId: jest.fn(options.load ?? (async () => null)),
  };
  const coordinator = new AgentIncidentCoordinator({
    recorder: recorder as unknown as AgentIncidentRecorder,
    store: store as unknown as AgentIncidentStore,
  });
  return { coordinator, recorder, store };
}

describe("AgentIncidentCoordinator", () => {
  it.each([
    ["user-01234567-89ab-4cde-8fab-0123456789ab", true],
    ["user-1700000000-abcde", true],
    ["user-00000000-0000-0000-0000-000000000000", false],
    ["user-01234567-89ab-9cde-8fab-0123456789ab", false],
    ["request-private", false],
  ])("keeps shared, recorder, and coordinator request-ID acceptance aligned for %s", (
    requestId,
    expected,
  ) => {
    const base = correlation(200);
    const ids = { ...base, requestId };
    const { coordinator, recorder } = realHarness();

    expect(isThinAgentRequestId(requestId)).toBe(expected);
    expect(recorder.record(lifecycle(ids, "run_started", 1))).toBe(expected);
    expect(recorder.reserveReportId(ids) !== null).toBe(expected);
    expect(coordinator.captureFailure(failure(ids)) !== null).toBe(expected);
  });

  it("finalizes capture-before-terminal with complete run, rendering, resource, and transport evidence", async () => {
    const ids = correlation(1);
    const { coordinator, recorder } = realHarness();
    await coordinator.initialize();
    begin(coordinator, ids);

    coordinator.captureFailure(failure(ids), rendering(), { chatViewState: "mounted" });
    expect(recorder.getByIncidentId(ids.incidentId)).toBeNull();
    finish(coordinator, ids);
    await coordinator.drain();

    const report = recorder.getByIncidentId(ids.incidentId);
    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      incident: {
        incident_id: ids.incidentId,
        failure_authority: "server",
        terminal_evidence: "server_protocol_validated",
      },
      run_summary: {
        terminal_validation: "validated",
        host_process_state: "responsive",
        chat_view_state: "mounted",
        duration_ms: 35_695,
        snapshot_part_count: 9,
        partial_output: {
          assistant_text_part_count: 2,
          assistant_text_character_count: 144,
          reasoning_part_count: 3,
          reasoning_character_count: 610,
        },
      },
      run_state: {
        terminal_source: "session_terminal",
        run_origin: "submitted",
        run_phase: "working",
        connection_state: "open",
        executing_local_tool_count: 1,
        pending_tool_delivery_count: 2,
        pending_approval_delivery_count: 3,
        pending_tool_task_count: 4,
        server_queued: true,
        run_stalled: true,
        awaiting_client_work: true,
        pending_cancel: true,
        pending_regenerate: true,
        counts_truncated: true,
        elapsed_ms_truncated: false,
      },
      environment: {
        plugin_version: "6.6.0",
        plugin_build_id: PLUGIN_BUILD_ID,
        loaded_bundle_sha256: LOADED_BUNDLE_SHA256,
        obsidian_version: "1.13.4",
        host_type: "desktop",
        os_family: "macos",
      },
      rendering: {
        before_terminal_publish: {
          render_pass_count: 18,
          first_dom_commit_observed: true,
          first_paint_opportunity_observed: true,
          renderer: { disclosure_count: 4, open_disclosure_count: 0 },
          scroller: { mode: "end", distance_from_end_bucket: "at_end" },
        },
        after_terminal_commit: {
          render_pass_count: 19,
          first_dom_commit_observed: true,
          first_paint_opportunity_observed: true,
          renderer: { disclosure_count: 4, open_disclosure_count: 0 },
          scroller: { mode: "end", distance_from_end_bucket: "at_end" },
        },
        failure_surface_dom_committed: true,
        failure_surface_paint_opportunity_observed: true,
      },
      transport_segments: [{
        command_kind: "submit",
        segment_ordinal: 1,
        tool_execution_ordinal: 2,
        close_reason: "response_rejected",
        duration_ms: 35_695,
        received_bytes: 8_192,
        raw_chunk_count: 17,
        sse_event_count: 16,
        accepted_frame_count: 15,
        delivered_frame_count: 14,
        metrics_truncated: false,
      }],
      resource_samples: [expect.objectContaining({ heap_used_mb: 218, event_loop_lag_ms: 9 })],
    });
    expect(JSON.stringify(report)).not.toContain(ids.conversationId);
    expect(JSON.stringify(report)).not.toContain(ids.requestId);
    const copied = await coordinator.loadSerializedByReportId(report!.report_id);
    const copiedReport = JSON.parse(copied!) as AgentIncidentReport;
    expect(copiedReport.rendering).toEqual(report!.rendering);
    expect(copiedReport.capture_quality.missing_fields).not.toContain("rendering");
    expect(copiedReport.capture_quality.missing_fields).not.toContain(
      "rendering_after_terminal_commit",
    );
    expect(copiedReport.capture_quality.collection_failures).not.toContainEqual(
      expect.objectContaining({ code: "rendering_snapshot_invalid" }),
    );
  });

  it("finalizes terminal-before-capture only after capture arrives", async () => {
    const ids = correlation(2);
    const { coordinator, recorder } = realHarness();
    begin(coordinator, ids);
    finish(coordinator, ids);
    expect(recorder.getByIncidentId(ids.incidentId)).toBeNull();

    coordinator.captureFailure(failure(ids), rendering());
    await coordinator.drain();

    expect(recorder.getByIncidentId(ids.incidentId)).toMatchObject({
      incident: { incident_id: ids.incidentId },
      run_state: { run_phase: "working" },
    });
  });

  it("keeps two interleaved correlation pairs isolated", async () => {
    const first = correlation(3);
    const second = correlation(4);
    const { coordinator, recorder } = realHarness();
    begin(coordinator, first);
    begin(coordinator, second);
    coordinator.captureFailure(failure(first, {
      assistantTextCharacterCount: 111,
      pendingToolTaskCount: 7,
    }), rendering());
    coordinator.captureFailure(failure(second, {
      assistantTextCharacterCount: 222,
      pendingToolTaskCount: 8,
    }), rendering());

    finish(coordinator, second);
    finish(coordinator, first);
    await coordinator.drain();

    expect(recorder.getByIncidentId(first.incidentId)).toMatchObject({
      run_summary: { partial_output: { assistant_text_character_count: 111 } },
      run_state: { pending_tool_task_count: 7 },
    });
    expect(recorder.getByIncidentId(second.incidentId)).toMatchObject({
      run_summary: { partial_output: { assistant_text_character_count: 222 } },
      run_state: { pending_tool_task_count: 8 },
    });
  });

  it.each(["run_finished_completed", "run_finished_cancelled"] as const)(
    "clears pending failure state after %s",
    async (terminalCode) => {
      const ids = correlation(terminalCode === "run_finished_completed" ? 5 : 6);
      const { coordinator, recorder } = realHarness();
      begin(coordinator, ids);
      coordinator.captureFailure(failure(ids), rendering());
      coordinator.recordLifecycle(lifecycle(ids, terminalCode, 8));
      finish(coordinator, ids);
      await coordinator.drain();

      expect(recorder.getByIncidentId(ids.incidentId)).toBeNull();
      await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBeNull();
    },
  );

  it("contains environment and resource provider failures and records capture quality", async () => {
    const ids = correlation(7);
    const adapter = new MemoryAdapter();
    const recorder = new AgentIncidentRecorder({
      now: () => BASE_TIME,
      createReportId: () => reportId(7),
    });
    const store = new AgentIncidentStore(adapter);
    const coordinator = new AgentIncidentCoordinator({
      recorder,
      store,
      environmentProvider: () => { throw new Error("private-environment-error"); },
      resourceSamplesProvider: () => { throw new Error("private-resource-error"); },
    });
    begin(coordinator, ids);

    expect(() => coordinator.captureFailure(failure(ids), rendering())).not.toThrow();
    expect(() => finish(coordinator, ids)).not.toThrow();
    await expect(coordinator.drain()).resolves.toBeUndefined();

    const failures = recorder.getByIncidentId(ids.incidentId)?.capture_quality.collection_failures;
    expect(failures).toEqual(expect.arrayContaining([
      { code: "environment_unavailable", count: 1 },
      { code: "resource_sample_unavailable", count: 1 },
    ]));
  });

  it("contains recorder attachment and finalization failures", async () => {
    const ids = correlation(8);
    const { coordinator, recorder } = fakeDependencies();
    recorder.attachEnvironment.mockImplementation(() => { throw new Error("attach-environment"); });
    recorder.attachResourceSamples.mockImplementation(() => { throw new Error("attach-resources"); });
    recorder.finalize.mockImplementation(() => { throw new Error("finalize"); });
    const withProviders = new AgentIncidentCoordinator({
      recorder: recorder as unknown as AgentIncidentRecorder,
      store: ({
        initialize: async () => undefined,
        serialize: () => "unused",
        save: async () => undefined,
        loadByIncidentId: async () => null,
      }) as unknown as AgentIncidentStore,
      environmentProvider,
      resourceSamplesProvider,
    });

    expect(() => withProviders.recordLifecycle(lifecycle(ids, "run_started", 1))).not.toThrow();
    expect(() => withProviders.captureFailure(failure(ids), rendering())).not.toThrow();
    expect(() => withProviders.recordLifecycle(lifecycle(ids, "run_finished_failed", 2))).not.toThrow();
    await expect(withProviders.drain()).resolves.toBeUndefined();
  });

  it("keeps exact canonical memory bytes available before and after a delayed save, then after restart", async () => {
    const ids = correlation(9);
    const adapter = new MemoryAdapter();
    const { coordinator, recorder, store } = realHarness(adapter);
    await coordinator.initialize();
    adapter.blockWrites();
    begin(coordinator, ids);
    const receipt = coordinator.captureFailure(failure(ids), rendering());
    finish(coordinator, ids);

    expect(receipt).toEqual({ reportId: reportId(1) });
    const readyBytes = coordinator.loadSerializedByReportId(receipt!.reportId);
    await Promise.resolve();
    const report = recorder.getByIncidentId(ids.incidentId);
    expect(report).not.toBeNull();
    const expected = store.serialize(report!);
    await expect(readyBytes).resolves.toBe(expected);
    await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    await expect(coordinator.loadReportForCopy(receipt!.reportId)).resolves.toEqual({
      serialized: expected,
      durability: "memory_fallback",
    });
    expect(adapter.files.size).toBe(0);

    adapter.releaseWrites();
    await coordinator.drain();
    await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    await expect(coordinator.loadReportForCopy(receipt!.reportId)).resolves.toEqual({
      serialized: expected,
      durability: "persisted",
    });

    const restarted = new AgentIncidentCoordinator({
      recorder: new AgentIncidentRecorder(),
      store: new AgentIncidentStore(adapter),
    });
    await restarted.initialize();
    await expect(restarted.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    await expect(restarted.loadReportForCopy(receipt!.reportId)).resolves.toEqual({
      serialized: expected,
      durability: "persisted",
    });
  });

  it("keeps memory fallback after save rejection without an unhandled rejection", async () => {
    const ids = correlation(10);
    const adapter = new MemoryAdapter();
    adapter.writeFailures = 20;
    const { coordinator } = realHarness(adapter);
    begin(coordinator, ids);
    const receipt = coordinator.captureFailure(failure(ids), rendering());
    finish(coordinator, ids);
    const expected = await coordinator.loadSerializedByIncidentId(ids.incidentId);

    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(expected).not.toBeNull();
    await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    await expect(coordinator.loadReportForCopy(receipt!.reportId)).resolves.toEqual({
      serialized: expected,
      durability: "memory_fallback",
    });
    const restarted = new AgentIncidentCoordinator({
      recorder: new AgentIncidentRecorder(),
      store: new AgentIncidentStore(adapter),
    });
    await expect(restarted.loadReportForCopy(receipt!.reportId)).resolves.toBeNull();
  });

  it("returns null when store initialization or restart lookup rejects", async () => {
    const ids = correlation(11);
    const initialization = createDeferred<void>();
    initialization.reject(new Error("initialize-rejected"));
    const first = fakeDependencies({ initialize: () => initialization.promise });
    await expect(first.coordinator.initialize()).resolves.toBeUndefined();
    await expect(first.coordinator.drain()).resolves.toBeUndefined();

    const second = fakeDependencies({ load: async () => { throw new Error("load-rejected"); } });
    await expect(second.coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBeNull();
  });

  it("caches exact restart bytes so later store failure cannot remove copy readiness", async () => {
    const ids = correlation(13);
    const expected = `stored-canonical:${reportId(13)}`;
    let loadCount = 0;
    const { coordinator, store } = fakeDependencies({
      load: async () => {
        loadCount += 1;
        if (loadCount > 1) throw new Error("store-became-unavailable");
        return {
          report: fakeReport(13),
          serialized: expected,
          sizeBytes: expected.length,
        };
      },
    });

    await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    await expect(coordinator.loadSerializedByIncidentId(ids.incidentId)).resolves.toBe(expected);
    expect(store.loadByIncidentId).toHaveBeenCalledTimes(1);
  });

  it("lets an early copy lookup wait for a pending report", async () => {
    const ids = correlation(12);
    const { coordinator, recorder, store } = realHarness();
    await coordinator.initialize();
    begin(coordinator, ids);
    coordinator.captureFailure(failure(ids), rendering());

    const copy = coordinator.loadSerializedByIncidentId(ids.incidentId);
    await Promise.resolve();
    finish(coordinator, ids);
    const copied = await copy;
    expect(copied).not.toBeNull();
    expect(copied).toBe(store.serialize(recorder.getByIncidentId(ids.incidentId)!));
  });

  it("evicts the oldest pending capture after 32 correlations", async () => {
    const first = correlation(20);
    const last = correlation(52);
    const { coordinator, recorder } = fakeDependencies();
    for (let value = 20; value <= 52; value += 1) {
      coordinator.captureFailure(failure(correlation(value)));
    }

    coordinator.recordLifecycle(lifecycle(first, "run_finished_failed", 1));
    expect(recorder.finalize).not.toHaveBeenCalled();
    coordinator.recordLifecycle(lifecycle(last, "run_finished_failed", 2));
    recordFailureSurface(coordinator, last);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.finalize).toHaveBeenCalledTimes(1);
    expect(recorder.finalize).toHaveBeenCalledWith(
      { conversationId: last.conversationId, requestId: last.requestId },
      expect.objectContaining({ assistantTextPartCount: 2 }),
    );
    await coordinator.closeAdmissionAndDrain();
  });

  it("retains only the newest 20 canonical reports in memory", async () => {
    const { coordinator } = fakeDependencies({
      finalize: (ids) => {
        const match = /([a-f0-9]{32})$/u.exec(ids.conversationId);
        return match ? fakeReport(Number.parseInt(match[1]!.slice(-4), 16)) : null;
      },
    });
    for (let value = 100; value <= 120; value += 1) {
      const ids = correlation(value);
      coordinator.captureFailure(failure(ids));
      coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", value));
      recordFailureSurface(coordinator, ids);
    }

    await expect(coordinator.loadSerializedByIncidentId(correlation(100).incidentId)).resolves.toBeNull();
    await expect(coordinator.loadSerializedByIncidentId(correlation(101).incidentId)).resolves.toBe(`canonical:${reportId(101)}`);
    await expect(coordinator.loadSerializedByIncidentId(correlation(120).incidentId)).resolves.toBe(`canonical:${reportId(120)}`);
  });

  it("drain waits for tracked initialization and save work and never rejects", async () => {
    const ids = correlation(121);
    const initialization = createDeferred<void>();
    const save = createDeferred<void>();
    const { coordinator } = fakeDependencies({
      initialize: () => initialization.promise,
      finalize: () => fakeReport(121),
      save: () => save.promise,
    });
    void coordinator.initialize();
    coordinator.captureFailure(failure(ids));
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 1));
    recordFailureSurface(coordinator, ids);

    let drained = false;
    const draining = coordinator.drain().then(() => { drained = true; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    initialization.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    save.reject(new Error("save-rejected"));
    await expect(draining).resolves.toBeUndefined();
    expect(drained).toBe(true);
  });

  it("drain waits for initialization when no report save exists", async () => {
    const initialization = createDeferred<void>();
    const { coordinator } = fakeDependencies({
      initialize: () => initialization.promise,
    });
    void coordinator.initialize();

    let drained = false;
    const draining = coordinator.drain().then(() => { drained = true; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    initialization.resolve();
    await expect(draining).resolves.toBeUndefined();
    expect(drained).toBe(true);
  });

  it("does not finalize an accepted failed terminal without its failure capture", async () => {
    const ids = correlation(124);
    const { coordinator, recorder, store } = fakeDependencies({
      finalize: () => fakeReport(124),
    });
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 1));

    await expect(coordinator.drain()).resolves.toBeUndefined();

    expect(recorder.finalize).not.toHaveBeenCalled();
    expect(store.serialize).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("contains canonical serialization failure and does not start persistence", async () => {
    const ids = correlation(125);
    const { coordinator, store } = fakeDependencies({
      finalize: () => fakeReport(125),
    });
    store.serialize.mockImplementation(() => { throw new Error("serialize-failed"); });
    coordinator.captureFailure(failure(ids));

    expect(() => coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 1))).not.toThrow();
    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("contains recorder record and transport attachment failures", async () => {
    const ids = correlation(126);
    const { coordinator, recorder } = fakeDependencies({
      finalize: () => fakeReport(126),
    });
    recorder.record.mockImplementation(() => { throw new Error("record-failed"); });
    recorder.attachTransportSegment.mockImplementation(() => { throw new Error("transport-failed"); });

    expect(() => coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 1))).not.toThrow();
    expect(() => coordinator.recordTransport(transport(ids))).not.toThrow();
    expect(() => coordinator.captureFailure(failure(ids))).not.toThrow();
    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(recorder.finalize).not.toHaveBeenCalled();
  });

  it("settles report readiness as unavailable when failed lifecycle projection is not accepted", async () => {
    const ids = correlation(128);
    const { coordinator, recorder } = fakeDependencies();
    recorder.record.mockReturnValue(false);
    const receipt = coordinator.captureFailure(failure(ids));

    const copy = coordinator.loadReportForCopy(receipt!.reportId);
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 1));

    await expect(copy).resolves.toBeNull();
    expect(recorder.finalize).not.toHaveBeenCalled();
    await coordinator.closeAdmissionAndDrain();
  });

  it("rejects invalid and all-zero correlation and incident IDs without throwing", async () => {
    const ids = correlation(127);
    const { coordinator, recorder } = fakeDependencies();
    const invalidConversation = failure(ids, { conversationId: "conversation_private" });
    const invalidRequest = failure(ids, { requestId: "request-private" });

    expect(() => coordinator.captureFailure(invalidConversation)).not.toThrow();
    expect(() => coordinator.captureFailure(invalidRequest)).not.toThrow();
    expect(() => coordinator.recordLifecycle({
      ...lifecycle(ids, "run_finished_failed", 1),
      conversation_id: `conversation_${"0".repeat(31)}`,
    })).not.toThrow();
    expect(recorder.finalize).not.toHaveBeenCalled();
    await expect(coordinator.loadSerializedByIncidentId("incident-private")).resolves.toBeNull();
    await expect(coordinator.loadSerializedByIncidentId(`incident_${"0".repeat(32)}`)).resolves.toBeNull();
  });

  it("does not throw or retain hostile lifecycle, capture, transport, rendering, or provider getters", async () => {
    const ids = correlation(122);
    const { coordinator, recorder } = fakeDependencies();
    const throwing = () => { throw new Error("hostile-getter"); };
    const hostileLifecycle = Object.defineProperty({}, "conversation_id", { get: throwing });
    const hostileFailure = Object.defineProperty({}, "kind", { get: throwing });
    const hostileTransport = Object.defineProperty({}, "conversationId", { get: throwing });
    const hostileRendering = Object.defineProperty({}, "renderer", { get: throwing });

    expect(() => coordinator.recordLifecycle(hostileLifecycle as SupportDiagnosticEvent)).not.toThrow();
    expect(() => coordinator.captureFailure(hostileFailure as AgentRunFailureCaptureEvent)).not.toThrow();
    expect(() => coordinator.recordTransport(hostileTransport as AgentChatTransportSegmentSummaryEvent)).not.toThrow();
    expect(() => coordinator.captureFailure(failure(ids), hostileRendering as ReturnType<typeof rendering>)).not.toThrow();
    await expect(coordinator.loadSerializedByIncidentId(Object.defineProperty({}, "toString", { get: throwing }) as unknown as string)).resolves.toBeNull();
    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(recorder.finalize).not.toHaveBeenCalled();
  });

  it("projects transport through an explicit scalar allowlist", () => {
    const ids = correlation(123);
    const { coordinator, recorder } = fakeDependencies();
    const event = {
      ...transport(ids),
      url: "https://private.example/secret",
      headers: { authorization: "secret" },
      toolCallId: "secret-call-id",
    } as unknown as AgentChatTransportSegmentSummaryEvent;

    coordinator.recordTransport(event);

    expect(recorder.attachTransportSegment).toHaveBeenCalledWith(
      { conversationId: ids.conversationId, requestId: ids.requestId },
      {
        commandKind: "submit",
        commandSegmentOrdinal: 1,
        toolExecutionOrdinal: 2,
        closeReason: "response_rejected",
        durationMs: 35_695,
        receivedBytes: 8_192,
        nonEmptyRawChunkCount: 17,
        sseEventCount: 16,
        acceptedFrameCount: 15,
        deliveredFrameCount: 14,
        metricsTruncated: false,
      },
    );
  });

  it("reserves one stable report ID and copies a client-only failure by report ID", async () => {
    const ids = correlation(130);
    const { coordinator, recorder, store } = realHarness();
    coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
    const receipt = coordinator.captureFailure(failure(ids, {
      incidentId: undefined,
      failureAuthority: "client",
      terminalValidation: "unvalidated",
      terminalSource: "local_failure",
    }), rendering(), { chatViewState: "mounted" });
    const repeated = coordinator.captureFailure(failure(ids, {
      incidentId: undefined,
      failureAuthority: "client",
      terminalValidation: "unvalidated",
      terminalSource: "local_failure",
    }), rendering(), { chatViewState: "mounted" });
    expect(receipt).toEqual({ reportId: reportId(1) });
    expect(repeated).toEqual(receipt);

    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2, {
      incident_id: undefined,
      failure_code: "response_display_failed",
    }));
    const copied = await coordinator.loadSerializedByReportId(receipt!.reportId);
    const report = recorder.getByReportId(receipt!.reportId);

    expect(report).toMatchObject({
      report_id: receipt!.reportId,
      incident: {
        failure_authority: "client",
        origin: "agent_local_failure",
        terminal_evidence: "client_observed",
      },
    });
    expect(report!.incident).not.toHaveProperty("incident_id");
    expect(copied).toBe(store.serialize(report!));
  });

  it("retries canonical serialization only during explicit report copy", async () => {
    const ids = correlation(131);
    const { coordinator, store } = fakeDependencies({
      finalize: () => fakeReport(131),
    });
    store.serialize
      .mockImplementationOnce(() => { throw new Error("serialize-once"); })
      .mockImplementation((report: AgentIncidentReport) => `canonical:${report.report_id}`);
    coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
    const receipt = coordinator.captureFailure(failure(ids));
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2));
    recordFailureSurface(coordinator, ids);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.serialize).toHaveBeenCalledTimes(1);

    await expect(coordinator.loadSerializedByReportId(receipt!.reportId)).resolves.toBe(
      `canonical:${reportId(131)}`,
    );
    expect(store.serialize).toHaveBeenCalledTimes(2);
  });

  it("includes a terminal transport summary observed before the failed terminal", async () => {
    const ids = correlation(132);
    const { coordinator, recorder } = realHarness();
    begin(coordinator, ids);
    coordinator.captureFailure(failure(ids), rendering());
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2, {
      command_segment_ordinal: 1,
    }));
    await coordinator.drain();

    expect(recorder.getByIncidentId(ids.incidentId)?.transport_segments).toEqual([
      expect.objectContaining({ segment_ordinal: 1, close_reason: "response_rejected" }),
    ]);
  });

  it("waits off the settlement stack for a terminal transport summary observed after the terminal", async () => {
    const ids = correlation(133);
    const { coordinator, recorder } = realHarness();
    coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
    coordinator.captureFailure(failure(ids), rendering());
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2, {
      command_segment_ordinal: 1,
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.getByIncidentId(ids.incidentId)).toBeNull();

    coordinator.recordTransport(transport(ids));
    await coordinator.drain();

    expect(recorder.getByIncidentId(ids.incidentId)?.transport_segments).toEqual([
      expect.objectContaining({ segment_ordinal: 1 }),
    ]);
  });

  it("finalizes with explicit missing evidence when the terminal transport summary never arrives", async () => {
    const ids = correlation(134);
    const adapter = new MemoryAdapter();
    const recorder = new AgentIncidentRecorder({
      now: () => BASE_TIME,
      createReportId: () => reportId(134),
    });
    const coordinator = new AgentIncidentCoordinator({
      recorder,
      store: new AgentIncidentStore(adapter),
      terminalSegmentWaitMs: 1,
    });
    coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
    coordinator.captureFailure(failure(ids), rendering());
    coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2, {
      command_segment_ordinal: 1,
    }));

    await coordinator.drain();

    const report = recorder.getByIncidentId(ids.incidentId);
    expect(report).not.toBeNull();
    expect(report!.transport_segments).toEqual([]);
    expect(report!.capture_quality.missing_fields).toContain("terminal_transport_segment");
  });

  it("closes admission before draining already accepted terminal and capture work", async () => {
    const accepted = correlation(135);
    const rejected = correlation(136);
    const { coordinator, recorder } = realHarness();
    coordinator.recordLifecycle(lifecycle(accepted, "run_started", 1));
    const receipt = coordinator.captureFailure(failure(accepted), rendering());
    coordinator.recordLifecycle(lifecycle(accepted, "run_finished_failed", 2));

    const closing = coordinator.closeAdmissionAndDrain();
    expect(coordinator.getStatus().admissionState).toBe("closed");
    expect(coordinator.captureFailure(failure(rejected), rendering())).toBeNull();
    coordinator.recordLifecycle(lifecycle(rejected, "run_started", 3));
    coordinator.recordLifecycle(lifecycle(rejected, "run_finished_failed", 4));
    coordinator.recordTransport(transport(rejected));
    await closing;

    expect(recorder.getByReportId(receipt!.reportId)).not.toBeNull();
    expect(recorder.getByIncidentId(rejected.incidentId)).toBeNull();
    expect(coordinator.getStatus().pendingRunCount).toBe(0);
  });

  it("bounds hundreds of saves behind a blocked adapter and preserves newest memory copies", async () => {
    const adapter = new MemoryAdapter();
    adapter.blockWrites();
    let nextReport = 200;
    const recorder = new AgentIncidentRecorder({
      now: () => BASE_TIME,
      createReportId: () => reportId(nextReport++),
    });
    const coordinator = new AgentIncidentCoordinator({
      recorder,
      store: new AgentIncidentStore(adapter),
      drainTimeoutMs: 5,
    });
    let newestReceipt: Readonly<{ reportId: string }> | null = null;
    for (let value = 200; value < 450; value += 1) {
      const ids = correlation(value);
      coordinator.recordLifecycle(lifecycle(ids, "run_started", 1));
      newestReceipt = coordinator.captureFailure(failure(ids));
      coordinator.recordLifecycle(lifecycle(ids, "run_finished_failed", 2));
      recordFailureSurface(coordinator, ids);
      await Promise.resolve();
      await Promise.resolve();
    }

    const blocked = coordinator.getStatus();
    expect(blocked.pendingRunCount).toBe(0);
    expect(blocked.memoryReportCount).toBe(20);
    expect(blocked.pendingSaveCount).toBeLessThanOrEqual(20);
    expect(blocked.droppedSaveCount).toBeGreaterThan(200);
    await expect(coordinator.loadReportForCopy(newestReceipt!.reportId)).resolves.toMatchObject({
      durability: "memory_fallback",
    });

    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(coordinator.getStatus().pendingSaveCount).toBeLessThanOrEqual(20);
    adapter.releaseWrites();
    for (
      let attempt = 0;
      attempt < 100 && coordinator.getStatus().pendingSaveCount > 0;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    expect(coordinator.getStatus().pendingSaveCount).toBe(0);
    await expect(coordinator.loadReportForCopy(newestReceipt!.reportId)).resolves.toMatchObject({
      durability: "persisted",
    });
  });
});
