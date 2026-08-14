import { createHash } from "node:crypto";
import * as Obsidian from "obsidian";
import type { ListedFiles, Stat } from "obsidian";
import type { ChatMessage } from "../../../types";
import type { PlatformRequestInput } from "../../../services/PlatformRequestClient";
import type { ThinAgentBootstrapRequest } from "../../../services/managed/ThinAgentV1Contract";
import {
  AgentIncidentCoordinator,
} from "../../../core/diagnostics/AgentIncidentCoordinator";
import {
  AgentIncidentRecorder,
  type AgentIncidentRenderingInput,
} from "../../../core/diagnostics/AgentIncidentRecorder";
import {
  AGENT_INCIDENT_STORE_PATH,
  AgentIncidentStore,
  type AgentIncidentStoreAdapter,
} from "../../../core/diagnostics/AgentIncidentStore";
import {
  PluginLogger,
  type SupportDiagnosticEvent,
} from "../../../utils/PluginLogger";
import { ChatMarkdownSerializer } from "../storage/ChatMarkdownSerializer";
import { AgentTranscriptRepository } from "../AgentTranscriptRepository";
import type {
  AgentChatTransportSegmentSummaryEvent,
  AgentRunFailureCaptureEvent,
} from "../agent/ChatSession";
import { AgentChatSession } from "../agent/ChatSession";
import { AgentMutationJournal } from "../agent/MutationJournal";
import { THIN_AGENT_EVENT_TYPE } from "../agent/Protocol";
import { AgentChatView } from "../AgentChatView";

const CONVERSATION_ID = `conversation_${"1".repeat(32)}`;
const REQUEST_ID = "user-76712c65-86b6-4408-8dfc-6de89d79a479";
const SERVER_RUN_ID = `run_${"2".repeat(32)}`;
const INCIDENT_ID = "incident_19248b678a7244738b144be8cc9d2791";
const REPORT_ID = `report_${"4".repeat(32)}`;
const TRACE_ID = "5".repeat(32);
const PLUGIN_BUILD_ID = `sha256:${"6".repeat(64)}`;
const LOADED_BUNDLE_SHA256 = "7".repeat(64);
const STARTED_AT_MS = Date.parse("2026-08-13T14:30:00.000Z");
const FAILED_AT_MS = Date.parse("2026-08-13T14:29:55.000Z");
const CREATED_AT_MS = Date.parse("2026-08-13T15:00:00.000Z");
const RUN_DURATION_MS = 35_695;
const CLIENT_ID = `client_${"8".repeat(32)}`;
const SESSION_ID = `session_${"9".repeat(32)}`;
const ACCESS_TOKEN = `access_token_${"a".repeat(32)}`;

const PRIVATE = Object.freeze({
  prompt: "CANARY_prompt_4fd82d7a",
  assistant: "CANARY_assistant_3c0f1401",
  reasoning: "CANARY_reasoning_749ad820",
  relativePath: "CANARY/path/private-note.md",
  absolutePath: "/Users/CANARY_username/private-vault/private-note.md",
  filename: "CANARY_filename_private-note.md",
  fileContents: "CANARY_file_contents_d988239c",
  toolInput: "CANARY_tool_input_0e7e47bf",
  toolOutput: "CANARY_tool_output_d6e24cd1",
  toolCallId: "call_CANARY_tool_call_id_12ecf5d0",
  rawError: "CANARY_raw_error_18899b48",
  stack: "CANARY_stack_bbd03a1c",
  terminalMessage: "CANARY_terminal_message_a8afbb4d",
  searchQuery: "CANARY_search_query_bf4600f3",
  url: "https://private.example/CANARY_url_9dd22723?secret=yes",
  header: "Bearer CANARY_header_b86764c8",
  token: "CANARY_token_5cfdb898",
  license: "CANARY_license_f656cd6f",
  vaultName: "CANARY_vault_name_1242555e",
  username: "CANARY_username_7bde8d5a",
  hostname: "CANARY_hostname_2750f06e.local",
  pluginId: "CANARY_plugin_id_6297c6e8",
  theme: "CANARY_theme_74a3b5fa",
  snippet: "CANARY_snippet_85c017f5",
});

const PRIVATE_VALUES = Object.freeze(Object.values(PRIVATE));

type FailureMode =
  | "none"
  | "lifecycle_projection"
  | "resource_capture"
  | "recorder_finalization"
  | "store_rejection"
  | "clipboard";

interface MemoryFile {
  data: string;
  ctime: number;
  mtime: number;
}

class MemoryIncidentAdapter implements AgentIncidentStoreAdapter {
  public readonly files = new Map<string, MemoryFile>();
  public readonly directories = new Set<string>();
  public failWrites = false;
  public clock = CREATED_AT_MS;

  public async exists(path: string): Promise<boolean> {
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
    return {
      type: "folder",
      ctime: this.clock,
      mtime: this.clock,
      size: 0,
    };
  }

  public async list(path: string): Promise<ListedFiles> {
    if (!this.directories.has(path)) throw new Error("missing incident directory");
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((candidate) =>
        candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/")),
      folders: [...this.directories].filter((candidate) =>
        candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/")),
    };
  }

  public async read(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error("missing incident file");
    return file.data;
  }

  public async write(path: string, data: string): Promise<void> {
    if (this.failWrites) throw new Error("CANARY_store_write_error_8db1c07c");
    const prior = this.files.get(path);
    this.files.set(path, {
      data,
      ctime: prior?.ctime ?? this.clock,
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
    if (!file) throw new Error("missing temporary incident file");
    this.files.set(newPath, file);
    this.files.delete(path);
  }
}

class FirstWriteGatedIncidentAdapter extends MemoryIncidentAdapter {
  private releaseFirstWritePromise!: () => void;
  private markFirstWriteStarted!: () => void;
  private firstWritePending = true;
  public readonly firstWriteStarted = new Promise<void>((resolve) => {
    this.markFirstWriteStarted = resolve;
  });
  private readonly firstWriteRelease = new Promise<void>((resolve) => {
    this.releaseFirstWritePromise = resolve;
  });

  public override async write(path: string, data: string): Promise<void> {
    if (this.firstWritePending) {
      this.firstWritePending = false;
      this.markFirstWriteStarted();
      await this.firstWriteRelease;
    }
    await super.write(path, data);
  }

  public releaseFirstWrite(): void {
    this.releaseFirstWritePromise();
  }
}

function captureFailureWithRenderedSurface(
  coordinator: AgentIncidentCoordinator,
  event: AgentRunFailureCaptureEvent,
): Readonly<{ reportId: string }> | null {
  const receipt = coordinator.captureFailure(event, completeRendering());
  for (const milestone of ["dom_committed", "paint_opportunity_observed"] as const) {
    coordinator.recordFailureSurfaceRendering({
      conversationId: event.conversationId,
      requestId: event.requestId,
      milestone,
      rendering: completeRendering(),
    });
  }
  return receipt;
}

function installNoEgressProbe(): Readonly<{
  fetch: jest.Mock;
  request: jest.Mock;
  requestUrl: jest.Mock;
  sendBeacon: jest.Mock;
  webSocket: jest.Mock;
  xmlHttpRequest: jest.Mock;
  restore: () => void;
}> {
  const restorers: Array<() => void> = [];
  const replaceProperty = (
    target: object,
    key: PropertyKey,
    value: unknown,
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value,
    });
    restorers.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  };
  const fetch = jest.fn(async () => {
    throw new Error("Incident diagnostics must not use fetch.");
  });
  replaceProperty(globalThis, "fetch", fetch);
  if (window !== globalThis) replaceProperty(window, "fetch", fetch);

  const obsidianRuntime = jest.requireMock("obsidian") as Record<string, unknown>;
  const request = jest.fn(async () => {
    throw new Error("Incident diagnostics must not use Obsidian request.");
  });
  replaceProperty(obsidianRuntime, "request", request);
  const requestUrl = Obsidian.requestUrl as unknown as jest.Mock;
  const priorRequestUrlImplementation = requestUrl.getMockImplementation();
  requestUrl.mockClear();
  requestUrl.mockImplementation(async () => {
    throw new Error("Incident diagnostics must not use Obsidian requestUrl.");
  });

  const xmlHttpRequest = jest.fn();
  const webSocket = jest.fn();
  for (const target of window === globalThis
    ? [globalThis]
    : [globalThis, window]) {
    replaceProperty(target, "XMLHttpRequest", xmlHttpRequest);
    replaceProperty(target, "WebSocket", webSocket);
  }

  const sendBeacon = jest.fn(() => true);
  const navigatorTargets = new Set<object>();
  for (const target of window === globalThis
    ? [globalThis]
    : [globalThis, window]) {
    let ownerNavigator = (target as { navigator?: object }).navigator;
    if (!ownerNavigator) {
      ownerNavigator = {};
      replaceProperty(target, "navigator", ownerNavigator);
    }
    if (navigatorTargets.has(ownerNavigator)) continue;
    navigatorTargets.add(ownerNavigator);
    replaceProperty(ownerNavigator, "sendBeacon", sendBeacon);
  }

  return {
    fetch,
    request,
    requestUrl,
    sendBeacon,
    webSocket,
    xmlHttpRequest,
    restore: () => {
      for (const restore of restorers.reverse()) restore();
      if (priorRequestUrlImplementation) {
        requestUrl.mockImplementation(priorRequestUrlImplementation);
      } else {
        requestUrl.mockReset();
      }
      requestUrl.mockClear();
    },
  };
}

function createAgentChatViewCopyBridge(): Readonly<{
  copy: (reportId: string) => Promise<boolean>;
  writeText: jest.Mock;
}> {
  const writeText = jest.fn(async (_text: string): Promise<void> => undefined);
  const host = {
    ownerDocument: {
      defaultView: {
        navigator: { clipboard: { writeText } },
      },
    },
  } as unknown as Node;
  const view = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, unknown>;
  Object.assign(view, {
    workspace: { element: host },
  });
  return {
    copy: (reportId) => (view as unknown as {
      copyIncidentReport: (
        reportId: string,
      ) => Promise<boolean>;
    }).copyIncidentReport(reportId),
    writeText,
  };
}

function createPluginLogger(): Readonly<{
  logger: PluginLogger;
  localLogWrites: string[];
}> {
  const localLogWrites: string[] = [];
  const plugin = {
    settings: { debugMode: false, logLevel: 0 },
    isPluginUnloading: () => false,
    storage: {
      appendToFile: async (_directory: string, _file: string, data: string) => {
        localLogWrites.push(data);
        return { success: true };
      },
      getPath: (directory: string, file: string) => `${directory}/${file}`,
    },
    app: { vault: { adapter: { stat: async () => null } } },
    getErrorCollector: () => null,
  };
  return {
    logger: new PluginLogger(plugin as never),
    localLogWrites,
  };
}

function completeRendering(): AgentIncidentRenderingInput {
  return {
    renderState: "idle",
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
      historicalPartCount: 0,
      activePartCount: 5,
      disclosureCount: 5,
      openDisclosureCount: 0,
      activityDisclosureCount: 1,
      reasoningDisclosureCount: 1,
      toolDisclosureCount: 3,
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
      submittedPromptAnchorActive: true,
      destroyed: false,
    },
  };
}

function failureCapture(partial: ChatMessage): AgentRunFailureCaptureEvent {
  return {
    kind: "agent_run_failed",
    conversationId: CONVERSATION_ID,
    requestId: REQUEST_ID,
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
    elapsedMs: RUN_DURATION_MS,
    elapsedMsTruncated: false,
    serverRunId: SERVER_RUN_ID,
    incidentId: INCIDENT_ID,
    failureCode: "response_capacity_unavailable",
    retryable: true,
    assistantTextPartCount: 1,
    assistantTextStreamingPartCount: 1,
    assistantTextCompletePartCount: 0,
    assistantTextCharacterCount: String(partial.content).length,
    reasoningPartCount: 1,
    reasoningStreamingPartCount: 1,
    reasoningCompletePartCount: 0,
    reasoningCharacterCount: PRIVATE.reasoning.length,
    assistantOutputPresentBeforeFailure: true,
    assistantOutputRetainedInFailedProjection: true,
    snapshotPartCount: 8,
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
  };
}

function terminalTransport(): AgentChatTransportSegmentSummaryEvent {
  return {
    conversationId: CONVERSATION_ID,
    requestId: REQUEST_ID,
    commandKind: "submit",
    commandSegmentOrdinal: 1,
    serverLatencyCorrelationId: TRACE_ID,
    closeReason: "clean_eof",
    durationMs: RUN_DURATION_MS,
    receivedBytes: 24_901,
    nonEmptyRawChunkCount: 47,
    sseEventCount: 31,
    acceptedFrameCount: 31,
    deliveredFrameCount: 31,
    metricsTruncated: false,
  };
}

function privateMetadata(): Record<string, unknown> {
  return {
    prompt: PRIVATE.prompt,
    assistantText: PRIVATE.assistant,
    reasoning: PRIVATE.reasoning,
    path: PRIVATE.absolutePath,
    relativePath: PRIVATE.relativePath,
    filename: PRIVATE.filename,
    fileContents: PRIVATE.fileContents,
    toolInput: { secret: PRIVATE.toolInput },
    toolOutput: { secret: PRIVATE.toolOutput },
    error: PRIVATE.rawError,
    stack: PRIVATE.stack,
    message: PRIVATE.terminalMessage,
    query: PRIVATE.searchQuery,
    url: PRIVATE.url,
    headers: { authorization: PRIVATE.header },
    token: PRIVATE.token,
    licenseKey: PRIVATE.license,
    vaultName: PRIVATE.vaultName,
    username: PRIVATE.username,
    hostname: PRIVATE.hostname,
    pluginId: PRIVATE.pluginId,
    theme: PRIVATE.theme,
    snippet: PRIVATE.snippet,
  };
}

function partialMessages(): ChatMessage[] {
  return [
    {
      role: "user",
      message_id: REQUEST_ID,
      content: PRIVATE.prompt,
    },
    {
      role: "assistant",
      message_id: "assistant-production-partial",
      content: `${PRIVATE.assistant}\nTrailing incomplete sentence`,
      reasoning: PRIVATE.reasoning,
      streaming: true,
      terminalOutcome: "failed",
      terminalIncidentId: INCIDENT_ID,
      terminalFailureCode: "response_capacity_unavailable",
      terminalRetryable: true,
      terminalServerRunId: SERVER_RUN_ID,
      responseDurationMs: RUN_DURATION_MS,
    },
  ];
}

class IncidentPipelineHarness {
  public readonly adapter: MemoryIncidentAdapter;
  public readonly recorder: AgentIncidentRecorder;
  public readonly store: AgentIncidentStore;
  public readonly coordinator: AgentIncidentCoordinator;
  public readonly logger: PluginLogger;
  public readonly localLogWrites: string[];
  public readonly supportEvents: SupportDiagnosticEvent[] = [];
  public readonly copiedBytes: string[] = [];
  public readonly errorCallbacks: unknown[] = [];
  public durableMarkdown = "";
  public failedResult: Readonly<Record<string, unknown>> | null = null;
  public retryCalls = 0;
  public failedCard: Readonly<{
    retry: () => boolean;
    copyReport: () => Promise<boolean>;
  }> | null = null;

  public constructor(public readonly mode: FailureMode, adapter = new MemoryIncidentAdapter()) {
    this.adapter = adapter;
    this.adapter.failWrites = mode === "store_rejection";
    this.recorder = new AgentIncidentRecorder({
      now: () => CREATED_AT_MS,
      createReportId: () => REPORT_ID,
    });
    if (mode === "recorder_finalization") {
      jest.spyOn(this.recorder, "finalize").mockImplementation(() => {
        throw new Error("CANARY_recorder_finalization_error_c43e672c");
      });
    }
    this.store = new AgentIncidentStore(this.adapter, { now: () => CREATED_AT_MS });
    const { logger, localLogWrites } = createPluginLogger();
    this.logger = logger;
    this.localLogWrites = localLogWrites;
    this.coordinator = new AgentIncidentCoordinator({
      recorder: this.recorder,
      store: this.store,
      environmentProvider: () => ({
        pluginVersion: "6.6.0",
        pluginBuildId: PLUGIN_BUILD_ID,
        loadedBundleSha256: LOADED_BUNDLE_SHA256,
        obsidianVersion: "1.13.0",
        hostType: "desktop",
        osFamily: "macos",
        username: PRIVATE.username,
        hostname: PRIVATE.hostname,
        vaultName: PRIVATE.vaultName,
        pluginId: PRIVATE.pluginId,
      } as never),
      resourceSamplesProvider: () => {
        if (mode === "resource_capture") {
          throw new Error("CANARY_resource_capture_error_40894274");
        }
        return [
          {
            captured_at: "2026-08-13T14:29:54.500Z",
            heap_used_mb: 211,
            heap_limit_mb: 4_096,
            rss_mb: 389,
            cpu_percent: 7,
            event_loop_lag_ms: 4,
            freeze_delta_ms: 0,
            note: PRIVATE.fileContents,
          },
          {
            captured_at: "2026-08-13T14:29:55.000Z",
            heap_used_mb: 215,
            heap_limit_mb: 4_096,
            rss_mb: 392,
            cpu_percent: 8,
            event_loop_lag_ms: 9,
            freeze_delta_ms: 0,
            path: PRIVATE.absolutePath,
          },
        ] as never;
      },
    });
  }

  public async initialize(): Promise<void> {
    await this.coordinator.initialize();
  }

  public recordLifecycle(
    code: string,
    phase: string,
    observedAtMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      if (this.mode === "lifecycle_projection" && code === "run_finished_failed") {
        throw new Error("CANARY_lifecycle_projection_error_944b31cd");
      }
      jest.setSystemTime(observedAtMs);
      const projected = this.logger.lifecycle({
        code,
        phase,
        conversationId: CONVERSATION_ID,
        requestId: REQUEST_ID,
        clientInstanceId: CLIENT_ID,
        pluginBuildId: PLUGIN_BUILD_ID,
        ...privateMetadata(),
        ...extra,
      });
      if (!projected) return;
      this.supportEvents.push(projected);
      this.coordinator.recordLifecycle(projected);
    } catch {
      // The production bridge treats diagnostics as observational.
    }
  }

  public recordTerminalTransport(): void {
    const event = {
      ...terminalTransport(),
      headers: { authorization: PRIVATE.header },
      url: PRIVATE.url,
      toolCallId: PRIVATE.toolCallId,
    } as unknown as AgentChatTransportSegmentSummaryEvent;
    this.coordinator.recordTransport(event);
  }

  public establishFailedProductState(messages: ChatMessage[]): void {
    this.durableMarkdown = ChatMarkdownSerializer.serializeMessages(messages);
    this.failedResult = Object.freeze({
      kind: "failed",
      snapshot: Object.freeze({ messages: Object.freeze([...messages]) }),
      error: Object.freeze({
        code: "response_capacity_unavailable",
        retryable: true,
        incidentId: INCIDENT_ID,
      }),
    });
    this.failedCard = Object.freeze({
      retry: () => {
        this.retryCalls += 1;
        return true;
      },
      copyReport: () => this.copyReport(),
    });
  }

  public captureFailure(partial: ChatMessage): void {
    const event = {
      ...failureCapture(partial),
      rawError: PRIVATE.rawError,
      stack: PRIVATE.stack,
      prompt: PRIVATE.prompt,
      assistantText: PRIVATE.assistant,
      reasoning: PRIVATE.reasoning,
      toolInput: PRIVATE.toolInput,
      toolOutput: PRIVATE.toolOutput,
      theme: PRIVATE.theme,
      snippet: PRIVATE.snippet,
    } as unknown as AgentRunFailureCaptureEvent;
    captureFailureWithRenderedSurface(this.coordinator, event);
  }

  public async drain(): Promise<void> {
    await this.coordinator.drain();
    await this.logger.flushNow();
  }

  public async copyReport(): Promise<boolean> {
    try {
      const serialized = await this.coordinator.loadSerializedByIncidentId(INCIDENT_ID);
      if (!serialized) return false;
      if (this.mode === "clipboard") {
        throw new Error("CANARY_clipboard_error_a0e2d22f");
      }
      this.copiedBytes.push(serialized);
      return true;
    } catch {
      return false;
    }
  }

  public dispose(): void {
    this.logger.dispose();
  }
}

function recordProductionChronology(pipeline: IncidentPipelineHarness): void {
  let sequence = 1;
  pipeline.recordLifecycle("run_started", "start", STARTED_AT_MS, {
    sequence: sequence++,
    runId: SERVER_RUN_ID,
    serverRunId: SERVER_RUN_ID,
    latencyTraceId: TRACE_ID,
  });
  pipeline.recordLifecycle("phase_thinking", "response", STARTED_AT_MS + 10, {
    sequence: sequence++,
    runId: SERVER_RUN_ID,
    serverRunId: SERVER_RUN_ID,
  });
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const offset = 100 + ordinal * 100;
    pipeline.recordLifecycle("local_tool_started", "tool_execution", STARTED_AT_MS + offset, {
      sequence: sequence++,
      runId: SERVER_RUN_ID,
      serverRunId: SERVER_RUN_ID,
      toolName: "read",
      toolCallId: `${PRIVATE.toolCallId}_${ordinal}`,
      toolExecutionOrdinal: ordinal,
    });
    pipeline.recordLifecycle("local_tool_completed_failed", "tool_execution", STARTED_AT_MS + offset + 10, {
      sequence: sequence++,
      runId: SERVER_RUN_ID,
      serverRunId: SERVER_RUN_ID,
      toolName: "read",
      toolCallId: `${PRIVATE.toolCallId}_${ordinal}`,
      toolExecutionOrdinal: ordinal,
      toolOutcome: "failed",
      toolFailureClass: "partial_failure",
      toolItemCount: 4,
      toolCompletedItemCount: 3,
      toolFailedItemCount: 1,
    });
    pipeline.recordLifecycle("tool_result_sent_succeeded", "tool_execution", STARTED_AT_MS + offset + 20, {
      sequence: sequence++,
      runId: SERVER_RUN_ID,
      serverRunId: SERVER_RUN_ID,
      toolName: "read",
      toolCallId: `${PRIVATE.toolCallId}_${ordinal}`,
      toolExecutionOrdinal: ordinal,
    });
  }
  pipeline.recordTerminalTransport();
  const messages = partialMessages();
  pipeline.establishFailedProductState(messages);
  pipeline.captureFailure(messages[1]!);
  // The wall clock moves backward. Duration still comes from the monotonic run clock.
  pipeline.recordLifecycle("run_finished_failed", "response", FAILED_AT_MS, {
    sequence: sequence++,
    runId: SERVER_RUN_ID,
    serverRunId: SERVER_RUN_ID,
    incidentId: INCIDENT_ID,
    failureCode: "response_capacity_unavailable",
    retryable: true,
    status: 503,
    commandKind: "submit",
    commandSegmentOrdinal: 1,
  });
}

function expectAutomaticLifecycleWritePrivacy(pipeline: IncidentPipelineHarness): void {
  expect(pipeline.supportEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      conversation_id: CONVERSATION_ID,
      request_id: REQUEST_ID,
      client_instance_id: CLIENT_ID,
      run_id: SERVER_RUN_ID,
      server_run_id: SERVER_RUN_ID,
      latency_trace_id: TRACE_ID,
    }),
  ]));
  const automaticLogBytes = [
    JSON.stringify(pipeline.logger.getRecentEntries()),
    JSON.stringify(pipeline.logger.getSupportDiagnostics()),
    ...pipeline.localLogWrites,
  ].join("\n");
  for (const privateIdentifier of [
    CONVERSATION_ID,
    REQUEST_ID,
    CLIENT_ID,
    PRIVATE.toolCallId,
  ]) {
    expect(automaticLogBytes).not.toContain(privateIdentifier);
  }
  for (const retainedCorrelation of [SERVER_RUN_ID, TRACE_ID, INCIDENT_ID]) {
    expect(automaticLogBytes).toContain(retainedCorrelation);
  }
}

function parseDurableMessages(markdown: string): ChatMessage[] {
  const parsed = (ChatMarkdownSerializer as unknown as {
    parseSequentialFormat(content: string): {
      success: boolean;
      messages: ChatMessage[];
    };
  }).parseSequentialFormat(markdown);
  expect(parsed.success).toBe(true);
  return parsed.messages;
}

function expectDurableFailedPartial(pipeline: IncidentPipelineHarness): void {
  expect(pipeline.failedResult).toMatchObject({
    kind: "failed",
    error: {
      code: "response_capacity_unavailable",
      retryable: true,
      incidentId: INCIDENT_ID,
    },
  });
  const messages = parseDurableMessages(pipeline.durableMarkdown);
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({
    role: "assistant",
    terminalOutcome: "failed",
    terminalIncidentId: INCIDENT_ID,
    terminalFailureCode: "response_capacity_unavailable",
    terminalRetryable: true,
    terminalServerRunId: SERVER_RUN_ID,
    responseDurationMs: RUN_DURATION_MS,
  });
  expect(String(messages[1]!.content).trim()).toBe(
    `${PRIVATE.assistant}\nTrailing incomplete sentence`,
  );
}

function expectNoPrivateDiagnostics(values: readonly string[]): void {
  for (const value of values) {
    for (const canary of PRIVATE_VALUES) {
      expect(value).not.toContain(canary);
      expect(value).not.toContain(createHash("sha256").update(canary).digest("hex"));
    }
  }
}

function agentBootstrapRequest(): ThinAgentBootstrapRequest {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    client_id: CLIENT_ID,
    plugin_build_id: PLUGIN_BUILD_ID,
    capability_manifest: {
      contract_version: "thin-agent-capabilities-v1",
      capabilities: [{ id: "obsidian.vault", version: 1 }],
    },
  };
}

function agentBootstrapResponse(): Record<string, unknown> {
  return {
    contract_version: "thin-agent-v1",
    conversation_id: CONVERSATION_ID,
    session: { id: SESSION_ID },
    access: {
      token: ACCESS_TOKEN,
      expires_at: "2030-01-01T00:01:00.000Z",
    },
    accepted_capabilities: [{ id: "obsidian.vault", version: 1 }],
    client_input_limits: {
      image_mime_types: ["image/png", "image/jpeg", "image/webp"],
      max_content_blocks_per_message: 16,
      max_images_per_turn: 6,
      max_image_bytes: 6_291_456,
      max_total_image_bytes: 16_777_216,
      max_text_bytes_per_block: 1_048_576,
      max_total_text_bytes: 2_097_152,
      max_document_bytes: 26_214_400,
    },
  };
}

function agentEvent(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: THIN_AGENT_EVENT_TYPE,
    version: 1,
    kind,
    conversation_id: CONVERSATION_ID,
    ...fields,
  };
}

function agentIdleSnapshot(): Record<string, unknown> {
  return agentEvent("session_snapshot", {
    messages: [],
    run_state: { version: 1, cursor: 0, state: "idle" },
    queued_request_ids: [],
    cancelled_queued_request_ids: [],
  });
}

function realSessionFailureFrames(): readonly Record<string, unknown>[] {
  return [
    agentEvent("run_state", {
      run_state: {
        version: 1,
        cursor: 1,
        state: "running",
        request_id: REQUEST_ID,
        run_id: SERVER_RUN_ID,
        root_message_id: REQUEST_ID,
      },
    }),
    agentEvent("assistant_snapshot", {
      request_id: REQUEST_ID,
      message: {
        id: "assistant-real-session-partial",
        role: "assistant",
        parts: [
          { type: "text", text: PRIVATE.assistant, state: "streaming" },
          { type: "reasoning", text: PRIVATE.reasoning, state: "streaming" },
        ],
      },
    }),
    agentEvent("terminal", {
      request_id: REQUEST_ID,
      terminal: {
        version: 1,
        run_id: SERVER_RUN_ID,
        root_message_id: REQUEST_ID,
        outcome: "failed",
        code: "response_capacity_unavailable",
        message: PRIVATE.terminalMessage,
        incident_id: INCIDENT_ID,
        retryable: true,
      },
    }),
  ];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(
  frames: readonly unknown[],
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    },
  );
}

function mutationJournal(): AgentMutationJournal {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  return new AgentMutationJournal({
    exists: async (path: string) => files.has(path) || directories.has(path),
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing mutation record");
      return value;
    },
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async (path: string) => { directories.add(path); },
    list: async (path: string) => ({
      files: [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)),
      folders: [],
    }),
    remove: async (path: string) => { files.delete(path); },
  }, ".systemsculpt/test-mutations.json", () => CREATED_AT_MS);
}

describe("ChatView incident report regression integration", () => {
  it("creates a restart-safe local report for a bootstrap network failure with no server ID", async () => {
    const localReportId = `report_${"d".repeat(32)}`;
    const adapter = new FirstWriteGatedIncidentAdapter();
    const egress = installNoEgressProbe();
    const recorder = new AgentIncidentRecorder({
      now: () => CREATED_AT_MS,
      createReportId: () => localReportId,
    });
    const store = new AgentIncidentStore(adapter, { now: () => CREATED_AT_MS });
    const coordinator = new AgentIncidentCoordinator({ recorder, store });
    const { logger, localLogWrites } = createPluginLogger();
    const captures: AgentRunFailureCaptureEvent[] = [];
    const callbackOrder: string[] = [];
    const reportedErrors: unknown[] = [];
    const copiedBytes: string[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    const privateNetworkError = Object.assign(new Error(PRIVATE.rawError), {
      stack: PRIVATE.stack,
      url: PRIVATE.url,
      path: PRIVATE.absolutePath,
      headers: { authorization: PRIVATE.header },
    });
    const request = jest.fn(async (): Promise<Response> => {
      throw privateNetworkError;
    });
    let receiptId: string | undefined;
    let monotonicNow = 9_000;
    const session = new AgentChatSession({
      baseUrl: "https://systemsculpt.test",
      pluginVersion: "6.6.0",
      licenseKey: () => PRIVATE.license,
      bootstrapRequest: agentBootstrapRequest,
      mutationJournal: mutationJournal(),
      executeLocalTool: async () => ({ success: true, data: { ok: true } }),
      persistAssistant: async () => undefined,
      reconcileHistory: async () => undefined,
      reportError: (error) => { reportedErrors.push(error); },
      onLifecycle: (record) => {
        const projected = logger.lifecycle({ ...record });
        if (!projected) return;
        coordinator.recordLifecycle(projected);
        if (record.code === "run_finished_failed") callbackOrder.push("lifecycle");
      },
      onIncidentCapture: (event) => {
        callbackOrder.push("capture");
        captures.push(event);
        receiptId = captureFailureWithRenderedSurface(coordinator, event)?.reportId;
      },
      requestClient: { request },
      now: () => CREATED_AT_MS,
      monotonicNow: () => {
        monotonicNow += 25;
        return monotonicNow;
      },
      resynchronizationDelayMs: () => 0,
    });
    try {
      await coordinator.initialize();
      const result = await session.start({
        conversationId: CONVERSATION_ID,
        turnId: REQUEST_ID,
        message: {
          id: REQUEST_ID,
          role: "user",
          parts: [{ type: "text", text: PRIVATE.prompt }],
        },
        clientStartedAtMonotonicMs: 9_000,
      });
      await adapter.firstWriteStarted;
      await logger.flushNow();

      expect(result).toMatchObject({
        kind: "failed",
        error: {
          code: "response_start_failed",
          retryable: true,
        },
        snapshot: {
          status: "failed",
          parts: [expect.objectContaining({ kind: "error", retryable: true })],
        },
      });
      if (result.kind !== "failed") throw new Error("Expected a failed run.");
      expect(result.error).not.toHaveProperty("incidentId");
      expect(result.error).not.toHaveProperty("requestId");
      expect(receiptId).toBe(localReportId);
      expect(captures).toEqual([expect.objectContaining({
        failureAuthority: "client",
        terminalValidation: "unvalidated",
        terminalSource: "local_failure",
        failureCode: "response_start_failed",
        retryable: true,
      })]);
      expect(captures[0]).not.toHaveProperty("incidentId");
      expect(callbackOrder).toEqual(["capture", "lifecycle"]);

      const report = recorder.getByReportId(localReportId);
      expect(report).toMatchObject({
        report_id: localReportId,
        incident: {
          classification: "operation_failure",
          impact: "run_failed",
          outcome: "failed",
          failure_authority: "client",
          origin: "agent_local_failure",
          failure_code: "response_start_failed",
          retryable: true,
        },
      });
      expect(report!.incident).not.toHaveProperty("incident_id");
      const inMemoryCopy = await coordinator.loadReportForCopy(localReportId);
      expect(inMemoryCopy).toEqual({
        serialized: store.serialize(report!),
        durability: "memory_fallback",
      });
      copiedBytes.push(inMemoryCopy!.serialized);
      const beforeSaveBridge = createAgentChatViewCopyBridge();
      await expect(beforeSaveBridge.copy(localReportId))
        .resolves.toBe(true);
      expect(beforeSaveBridge.writeText).toHaveBeenCalledTimes(1);
      expect(beforeSaveBridge.writeText).toHaveBeenCalledWith(localReportId);
      const finalPath = `${AGENT_INCIDENT_STORE_PATH}/${localReportId}.json`;
      expect(adapter.files.has(finalPath)).toBe(false);

      adapter.releaseFirstWrite();
      await coordinator.drain();
      expect(adapter.files.get(finalPath)?.data).toBe(inMemoryCopy!.serialized);
      expect(adapter.files.has(`${finalPath}.tmp`)).toBe(false);
      const persistedCopy = await coordinator.loadReportForCopy(localReportId);
      expect(persistedCopy).toEqual({
        serialized: inMemoryCopy!.serialized,
        durability: "persisted",
      });

      const chatId = "2026-08-13 15-00-00";
      let transcriptVersion = 1;
      let durableTranscript = ChatMarkdownSerializer.serializeMessages([{
        role: "user",
        message_id: REQUEST_ID,
        content: PRIVATE.prompt,
      }]);
      let receiptWriteCount = 0;
      let markFirstReceiptWriteRejected!: () => void;
      const firstReceiptWriteRejected = new Promise<void>((resolve) => {
        markFirstReceiptWriteRejected = resolve;
      });
      const transcriptStorage = {
        loadChat: jest.fn(async (id: string) => id === chatId ? {
          id,
          title: "Failed local run",
          version: transcriptVersion,
          messages: parseDurableMessages(durableTranscript),
          context_files: [],
        } : null),
        saveChat: jest.fn(async (
          id: string,
          messages: ChatMessage[],
        ) => {
          expect(id).toBe(chatId);
          receiptWriteCount += 1;
          if (receiptWriteCount === 1) {
            markFirstReceiptWriteRejected();
            throw new Error("vault receipt write rejected");
          }
          durableTranscript = ChatMarkdownSerializer.serializeMessages(messages);
          transcriptVersion += 1;
          return { version: transcriptVersion };
        }),
      };
      const transcript = new AgentTranscriptRepository(
        transcriptStorage as never,
        () => ({
          title: "Failed local run",
          contextFiles: new Set<string>(),
          chatFontSize: "medium",
          approvalMode: "ask",
        }),
      );
      await transcript.load(chatId);
      const closeView = Object.create(AgentChatView.prototype) as AgentChatView & Record<string, unknown>;
      const closeTransition = {
        kind: "transition",
        settled: false,
        resolveFinished: jest.fn(),
      };
      Object.assign(closeView, {
        transcript,
        pendingLocalReportIds: new Map([[REQUEST_ID, localReportId]]),
        plugin: { getLogger: () => logger },
        chatId,
        chatTitle: "Failed local run",
        chatVersion: transcriptVersion,
        draftKey: chatId,
        closing: false,
        closed: false,
        closeBarrier: null,
        activeSubmissionOperation: null,
        conversationOriginToken: "origin-before-close",
        queueDrainSuppressionDepth: 0,
        agentSessionBinding: null,
        agent: { detach: jest.fn(async () => undefined) },
        beginConversationTransition: jest.fn(() => closeTransition),
        finishSubmissionOperation: jest.fn(),
        queuedFollowUps: [],
        queueHydrated: false,
        queuePersistence: Promise.resolve(),
        workspace: {
          setRunPending: jest.fn(),
          setBanner: jest.fn(),
          setTitle: jest.fn(),
        },
      });
      const failedResult = {
        kind: "failed" as const,
        snapshot: {
          runId: "run-local-receipt-close",
          turnId: REQUEST_ID,
          status: "failed" as const,
          messages: [],
          parts: [],
        },
        error: {
          code: "response_start_failed",
          message: "The local run failed.",
          retryable: true,
          reportId: localReportId,
        },
      };

      jest.useFakeTimers({ now: CREATED_AT_MS });
      try {
        (closeView as any).scheduleLocalFailedReceiptPersistence(failedResult);
        await firstReceiptWriteRejected;
        for (let index = 0; index < 20 && jest.getTimerCount() === 0; index += 1) {
          await Promise.resolve();
        }
        expect(transcriptStorage.saveChat).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
        expect((closeView as any).pendingLocalReportIds.get(REQUEST_ID))
          .toBe(localReportId);
        expect(durableTranscript).not.toContain(localReportId);

        await expect(closeView.onClose()).resolves.toBeUndefined();

        expect(transcriptStorage.saveChat).toHaveBeenCalledTimes(2);
        for (const [savedChatId, savedMessages] of transcriptStorage.saveChat.mock.calls) {
          expect(savedChatId).toBe(chatId);
          expect(savedMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
              terminalOutcome: "failed",
              terminalReportId: localReportId,
              terminalFailureCode: "response_start_failed",
              terminalRetryable: true,
            }),
          ]));
        }
        expect((closeView as any).pendingLocalReportIds.has(REQUEST_ID))
          .toBe(false);
        expect(durableTranscript).toContain(localReportId);
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(transcriptStorage.saveChat).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }

      const restartedTranscript = new AgentTranscriptRepository(
        transcriptStorage as never,
        () => ({}),
      );
      const restoredTranscript = await restartedTranscript.load(chatId);
      const restoredReceipt = restoredTranscript?.messages.find((message) =>
        message.role === "assistant" && message.terminalOutcome === "failed");
      expect(restoredReceipt).toMatchObject({
        content: "",
        terminalOutcome: "failed",
        terminalReportId: localReportId,
        terminalFailureCode: "response_start_failed",
        terminalRetryable: true,
      });
      const restoredReportId = restoredReceipt?.terminalReportId;
      expect(restoredReportId).toBe(localReportId);

      const restarted = new AgentIncidentCoordinator({
        recorder: new AgentIncidentRecorder(),
        store: new AgentIncidentStore(adapter, { now: () => CREATED_AT_MS }),
      });
      await restarted.initialize();
      await expect(restarted.loadReportForCopy(restoredReportId!)).resolves.toEqual({
        serialized: inMemoryCopy!.serialized,
        durability: "persisted",
      });
      await expect(restarted.loadReportForCopy(`report_${"e".repeat(32)}`))
        .resolves.toBeNull();
      const restartedCopy = await restarted.loadReportForCopy(restoredReportId!);
      copiedBytes.push(restartedCopy!.serialized);
      const restartedBridge = createAgentChatViewCopyBridge();
      await expect(restartedBridge.copy(restoredReportId!)).resolves.toBe(true);
      expect(restartedBridge.writeText).toHaveBeenCalledTimes(1);
      expect(restartedBridge.writeText).toHaveBeenCalledWith(restoredReportId);
      await expect(restartedBridge.copy(`report_${"e".repeat(32)}`))
        .resolves.toBe(true);
      expect(restartedBridge.writeText).toHaveBeenCalledTimes(2);
      const reportText = JSON.stringify(report);
      expect(reportText).not.toContain(CONVERSATION_ID);
      expect(reportText).not.toContain(REQUEST_ID);
      expect(report!.incident).not.toHaveProperty("incident_id");
      expectNoPrivateDiagnostics([
        reportText,
        inMemoryCopy!.serialized,
        ...copiedBytes,
        JSON.stringify(captures),
        JSON.stringify(reportedErrors),
        JSON.stringify(logger.getSupportDiagnostics()),
        JSON.stringify(localLogWrites),
      ]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(egress.fetch).not.toHaveBeenCalled();
      expect(egress.request).not.toHaveBeenCalled();
      expect(egress.requestUrl).not.toHaveBeenCalled();
      expect(egress.xmlHttpRequest).not.toHaveBeenCalled();
      expect(egress.webSocket).not.toHaveBeenCalled();
      expect(egress.sendBeacon).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
    } finally {
      adapter.releaseFirstWrite();
      process.off("unhandledRejection", onUnhandledRejection);
      await session.detach();
      await coordinator.closeAdmissionAndDrain();
      logger.dispose();
      egress.restore();
    }
  });

  it("turns a bootstrap 503 into a copyable local incident without leaking the response body", async () => {
    const adapter = new MemoryIncidentAdapter();
    const recorder = new AgentIncidentRecorder({
      now: () => CREATED_AT_MS,
      createReportId: () => `report_${"b".repeat(32)}`,
    });
    const store = new AgentIncidentStore(adapter, { now: () => CREATED_AT_MS });
    const coordinator = new AgentIncidentCoordinator({
      recorder,
      store,
      environmentProvider: () => ({
        pluginVersion: "6.6.0",
        pluginBuildId: PLUGIN_BUILD_ID,
        loadedBundleSha256: LOADED_BUNDLE_SHA256,
        obsidianVersion: "1.13.0",
        hostType: "desktop",
        osFamily: "macos",
      }),
      resourceSamplesProvider: () => [],
    });
    const { logger, localLogWrites } = createPluginLogger();
    const supportEvents: SupportDiagnosticEvent[] = [];
    const captures: AgentRunFailureCaptureEvent[] = [];
    const callbackOrder: string[] = [];
    const reportedErrors: unknown[] = [];
    const copiedBytes: string[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    const privateResponseBody = JSON.stringify({
      error: {
        code: "response_capacity_unavailable",
        incident_id: INCIDENT_ID,
        message: PRIVATE.rawError,
        stack: PRIVATE.stack,
      },
      details: privateMetadata(),
    });
    const request = jest.fn(async (input: PlatformRequestInput): Promise<Response> => {
      if (!String(input.url).includes("/agent/bootstrap")) {
        throw new Error("unexpected request after failed bootstrap");
      }
      return new Response(privateResponseBody, {
        status: 503,
        statusText: PRIVATE.terminalMessage,
        headers: { "content-type": "application/json" },
      });
    });
    let monotonicNow = 4_000;
    const session = new AgentChatSession({
      baseUrl: "https://systemsculpt.test",
      pluginVersion: "6.6.0",
      licenseKey: () => PRIVATE.license,
      bootstrapRequest: agentBootstrapRequest,
      mutationJournal: mutationJournal(),
      executeLocalTool: async () => ({ success: true, data: { ok: true } }),
      persistAssistant: async () => undefined,
      reconcileHistory: async () => undefined,
      reportError: (error) => { reportedErrors.push(error); },
      onLifecycle: (record) => {
        const projected = logger.lifecycle({ ...record });
        if (!projected) return;
        supportEvents.push(projected);
        coordinator.recordLifecycle(projected);
        if (record.code === "run_finished_failed") callbackOrder.push("lifecycle");
      },
      onIncidentCapture: (event) => {
        callbackOrder.push("capture");
        captures.push(event);
        captureFailureWithRenderedSurface(coordinator, event);
      },
      requestClient: { request },
      now: () => CREATED_AT_MS,
      monotonicNow: () => {
        monotonicNow += 25;
        return monotonicNow;
      },
      resynchronizationDelayMs: () => 0,
    });
    try {
      await coordinator.initialize();
      const result = await session.start({
        conversationId: CONVERSATION_ID,
        turnId: REQUEST_ID,
        message: {
          id: REQUEST_ID,
          role: "user",
          parts: [{ type: "text", text: PRIVATE.prompt }],
        },
        clientStartedAtMonotonicMs: 4_000,
      });
      await coordinator.drain();
      await logger.flushNow();
      await Promise.resolve();
      await Promise.resolve();

      expect(result).toMatchObject({
        kind: "failed",
        error: {
          code: "response_capacity_unavailable",
          message: "SystemSculpt could not start the response.",
          status: 503,
          retryable: true,
          requestId: INCIDENT_ID,
          incidentId: INCIDENT_ID,
        },
        snapshot: {
          status: "failed",
          terminalError: {
            code: "response_capacity_unavailable",
            status: 503,
            requestId: INCIDENT_ID,
            incidentId: INCIDENT_ID,
          },
          parts: [expect.objectContaining({
            kind: "error",
            retryable: true,
            retryMessageId: REQUEST_ID,
            error: expect.objectContaining({
              requestId: INCIDENT_ID,
              incidentId: INCIDENT_ID,
            }),
          })],
        },
      });
      expect(captures).toEqual([expect.objectContaining({
        kind: "agent_run_failed",
        failureAuthority: "client",
        terminalValidation: "unvalidated",
        terminalSource: "local_failure",
        runOrigin: "submitted",
        runPhase: "submitted",
        incidentId: INCIDENT_ID,
        failureCode: "response_capacity_unavailable",
        retryable: true,
        assistantTextPartCount: 0,
        reasoningPartCount: 0,
      })]);
      expect(callbackOrder).toEqual(["capture", "lifecycle"]);

      const report = recorder.getByIncidentId(INCIDENT_ID);
      expect(report).toMatchObject({
        incident: {
          classification: "operation_failure",
          outcome: "failed",
          failure_authority: "client",
          origin: "agent_local_failure",
          incident_id: INCIDENT_ID,
          failure_code: "response_capacity_unavailable",
          retryable: true,
          http_status: 503,
        },
        run_summary: {
          terminal_validation: "unvalidated",
          host_process_state: "responsive",
          partial_output: {
            assistant_text_part_count: 0,
            assistant_text_character_count: 0,
            reasoning_part_count: 0,
            reasoning_character_count: 0,
          },
        },
        run_state: {
          terminal_source: "local_failure",
          run_origin: "submitted",
          run_phase: "submitted",
        },
      });
      const storedBytes = await coordinator.loadSerializedByIncidentId(INCIDENT_ID);
      expect(storedBytes).not.toBeNull();
      expect(storedBytes).toBe(store.serialize(report!));
      const copyReport = async (): Promise<boolean> => {
        const serialized = await coordinator.loadSerializedByIncidentId(INCIDENT_ID);
        if (!serialized) return false;
        copiedBytes.push(serialized);
        return true;
      };
      await expect(copyReport()).resolves.toBe(true);
      expect(copiedBytes).toEqual([storedBytes]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toEqual([]);
      expectNoPrivateDiagnostics([
        JSON.stringify(result),
        JSON.stringify(captures),
        JSON.stringify(report),
        JSON.stringify(supportEvents),
        JSON.stringify(logger.getSupportDiagnostics()),
        JSON.stringify(localLogWrites),
        JSON.stringify(reportedErrors),
        storedBytes!,
        ...copiedBytes,
        ...[...adapter.files.values()].map((file) => file.data),
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await session.detach();
      await coordinator.drain();
      logger.dispose();
    }
  });

  it("routes a real AgentChatSession failed stream through the incident coordinator", async () => {
    const adapter = new MemoryIncidentAdapter();
    const recorder = new AgentIncidentRecorder({
      now: () => CREATED_AT_MS,
      createReportId: () => `report_${"a".repeat(32)}`,
    });
    const store = new AgentIncidentStore(adapter, { now: () => CREATED_AT_MS });
    const coordinator = new AgentIncidentCoordinator({
      recorder,
      store,
      environmentProvider: () => ({
        pluginVersion: "6.6.0",
        pluginBuildId: PLUGIN_BUILD_ID,
        loadedBundleSha256: LOADED_BUNDLE_SHA256,
        obsidianVersion: "1.13.0",
        hostType: "desktop",
        osFamily: "macos",
      }),
      resourceSamplesProvider: () => [{
        captured_at: "2026-08-13T14:29:55.000Z",
        heap_used_mb: 213,
        heap_limit_mb: 4_096,
        rss_mb: 390,
        cpu_percent: 7.5,
        event_loop_lag_ms: 9,
        freeze_delta_ms: 0,
      }],
    });
    const { logger } = createPluginLogger();
    const supportEvents: SupportDiagnosticEvent[] = [];
    const callbackOrder: string[] = [];
    const transportEvents: AgentChatTransportSegmentSummaryEvent[] = [];
    const persistedAssistant: ChatMessage[] = [];
    let reconciledHistory: readonly ChatMessage[] = [];
    const request = jest.fn(async (input: PlatformRequestInput): Promise<Response> => {
      const url = String(input.url);
      if (url.includes("/agent/bootstrap")) return jsonResponse(agentBootstrapResponse());
      if (url.includes("/get-messages")) return jsonResponse(agentIdleSnapshot());
      if (url.includes("/agent/turn")) {
        return sseResponse(realSessionFailureFrames(), {
          "x-systemsculpt-agent-latency-trace": TRACE_ID,
        });
      }
      throw new Error("unexpected real-session request");
    });
    let monotonicNow = 1_000;
    const session = new AgentChatSession({
      baseUrl: "https://systemsculpt.test",
      pluginVersion: "6.6.0",
      licenseKey: () => PRIVATE.license,
      bootstrapRequest: agentBootstrapRequest,
      mutationJournal: mutationJournal(),
      executeLocalTool: async () => ({ success: true, data: { ok: true } }),
      persistAssistant: async (message) => { persistedAssistant.push(message); },
      reconcileHistory: async (messages) => { reconciledHistory = messages; },
      reportError: () => undefined,
      onLifecycle: (record) => {
        const projected = logger.lifecycle({ ...record });
        if (!projected) return;
        supportEvents.push(projected);
        coordinator.recordLifecycle(projected);
        if (record.code === "run_finished_failed") callbackOrder.push("lifecycle");
      },
      onIncidentCapture: (event) => {
        callbackOrder.push("capture");
        captureFailureWithRenderedSurface(coordinator, event);
      },
      onTransportSegmentSummary: (event) => {
        callbackOrder.push("transport");
        transportEvents.push(event);
        coordinator.recordTransport(event);
      },
      requestClient: { request },
      now: () => CREATED_AT_MS,
      monotonicNow: () => {
        monotonicNow += 25;
        return monotonicNow;
      },
      resynchronizationDelayMs: () => 0,
    });
    try {
      await coordinator.initialize();
      await session.hydrate(CONVERSATION_ID);
      const result = await session.start({
        conversationId: CONVERSATION_ID,
        turnId: REQUEST_ID,
        message: {
          id: REQUEST_ID,
          role: "user",
          parts: [{ type: "text", text: PRIVATE.prompt }],
        },
        clientStartedAtMonotonicMs: 1_000,
      });
      await coordinator.drain();
      await logger.flushNow();

      expect(result).toMatchObject({
        kind: "failed",
        error: {
          code: "response_capacity_unavailable",
          retryable: true,
          incidentId: INCIDENT_ID,
        },
        snapshot: {
          status: "failed",
          parts: expect.arrayContaining([
            expect.objectContaining({ kind: "text", markdown: PRIVATE.assistant }),
            expect.objectContaining({ kind: "reasoning", summary: PRIVATE.reasoning }),
          ]),
        },
      });
      expect(callbackOrder).toEqual(["capture", "transport", "lifecycle"]);
      expect(transportEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          requestId: REQUEST_ID,
          commandKind: "submit",
          commandSegmentOrdinal: 1,
          closeReason: "clean_eof",
        }),
      ]));
      expect(persistedAssistant).toHaveLength(0);
      expect(reconciledHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: PRIVATE.assistant,
          terminalOutcome: "failed",
          terminalIncidentId: INCIDENT_ID,
          terminalFailureCode: "response_capacity_unavailable",
          terminalRetryable: true,
          terminalServerRunId: SERVER_RUN_ID,
          messageParts: expect.arrayContaining([
            expect.objectContaining({
              type: "content",
              data: PRIVATE.assistant,
            }),
            expect.objectContaining({
              type: "reasoning",
              data: PRIVATE.reasoning,
            }),
          ]),
        }),
      ]));

      const report = recorder.getByIncidentId(INCIDENT_ID);
      expect(report).toMatchObject({
        incident: {
          classification: "operation_failure",
          incident_id: INCIDENT_ID,
          failure_code: "response_capacity_unavailable",
          retryable: true,
        },
        run_summary: {
          terminal_validation: "validated",
          partial_output: {
            assistant_text_part_count: 1,
            assistant_text_character_count: PRIVATE.assistant.length,
            reasoning_part_count: 1,
            reasoning_character_count: PRIVATE.reasoning.length,
          },
        },
        rendering: {
          failure_surface_dom_committed: true,
          failure_surface_paint_opportunity_observed: true,
          before_terminal_publish: {
            renderer: { tool_disclosure_count: 3 },
            scroller: { mode: "end" },
          },
          after_terminal_commit: {
            renderer: { tool_disclosure_count: 3 },
            scroller: { mode: "end" },
          },
        },
        transport_segments: [expect.objectContaining({
          command_kind: "submit",
          segment_ordinal: 1,
          close_reason: "clean_eof",
          sse_event_count: 3,
          accepted_frame_count: 3,
          delivered_frame_count: 3,
          metrics_truncated: false,
        })],
      });
      const serialized = await coordinator.loadSerializedByIncidentId(INCIDENT_ID);
      expect(serialized).not.toBeNull();
      expect(serialized).toBe(store.serialize(report!));
      expectNoPrivateDiagnostics([
        serialized!,
        JSON.stringify(report),
        JSON.stringify(supportEvents),
        JSON.stringify(transportEvents),
      ]);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      await session.detach();
      await coordinator.drain();
      logger.dispose();
    }
  });

  it("keeps live lifecycle identifiers out of every automatic logger write", async () => {
    jest.useFakeTimers({ now: STARTED_AT_MS });
    const pipeline = new IncidentPipelineHarness("none");
    try {
      await pipeline.initialize();
      recordProductionChronology(pipeline);
      await pipeline.drain();

      expectAutomaticLifecycleWritePrivacy(pipeline);
    } finally {
      pipeline.dispose();
      jest.useRealTimers();
    }
  });

  it("persists and copies canonical evidence for the production partial-output failure", async () => {
    jest.useFakeTimers({ now: STARTED_AT_MS });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const pipeline = new IncidentPipelineHarness("none");
    try {
      await pipeline.initialize();
      recordProductionChronology(pipeline);
      expect(pipeline.copiedBytes).toHaveLength(0);
      await pipeline.drain();

      expectDurableFailedPartial(pipeline);
      const report = pipeline.recorder.getByIncidentId(INCIDENT_ID);
      expect(report).not.toBeNull();
      expect(report).toMatchObject({
        schema_version: "systemsculpt.incident/2",
        report_id: REPORT_ID,
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
          incident_id: INCIDENT_ID,
          failure_code: "response_capacity_unavailable",
          retryable: true,
          http_status: 503,
        },
        correlation: {
          run_id: SERVER_RUN_ID,
          server_run_id: SERVER_RUN_ID,
          server_latency_correlation_id: TRACE_ID,
        },
        grouping: {
          strategy: "systemsculpt.failure-contract/1",
          fingerprint: "systemsculpt.failure-contract/1|authority=server|stage=response_terminal|mechanism=service_terminal|failure=response_capacity_unavailable|status=5xx|terminal=session_terminal",
        },
        environment: {
          plugin_version: "6.6.0",
          plugin_build_id: PLUGIN_BUILD_ID,
          loaded_bundle_sha256: LOADED_BUNDLE_SHA256,
          obsidian_version: "1.13.0",
          host_type: "desktop",
          os_family: "macos",
        },
        run_summary: {
          started_at: new Date(STARTED_AT_MS).toISOString(),
          failed_at: new Date(FAILED_AT_MS).toISOString(),
          duration_ms: RUN_DURATION_MS,
          duration_clock_domain: "client_turn_monotonic",
          terminal_receipt: "client_received_server_terminal",
          terminal_validation: "validated",
          partial_output: {
            assistant_text_part_count: 1,
            assistant_text_streaming_part_count: 1,
            assistant_text_complete_part_count: 0,
            assistant_text_character_count: String(partialMessages()[1]!.content).length,
            reasoning_part_count: 1,
            reasoning_streaming_part_count: 1,
            reasoning_complete_part_count: 0,
            reasoning_character_count: PRIVATE.reasoning.length,
            assistant_output_present_before_failure: true,
            assistant_output_retained_in_failed_projection: true,
          },
        },
        run_state: {
          terminal_source: "session_terminal",
          run_origin: "submitted",
          run_phase: "working",
          connection_state: "open",
          run_stalled: false,
        },
        transport_segments: [{
          command_kind: "submit",
          segment_ordinal: 1,
          close_reason: "clean_eof",
          duration_ms: RUN_DURATION_MS,
          received_bytes: 24_901,
          metrics_truncated: false,
        }],
        rendering: {
          failure_surface_dom_committed: true,
          failure_surface_paint_opportunity_observed: true,
          before_terminal_publish: {
            render_state: "idle",
            render_pass_count: 18,
            renderer: {
              disclosure_count: 5,
              open_disclosure_count: 0,
              reasoning_disclosure_count: 1,
              tool_disclosure_count: 3,
            },
            scroller: {
              mode: "end",
              distance_from_end_bucket: "at_end",
            },
          },
          after_terminal_commit: {
            render_state: "idle",
            render_pass_count: 18,
            renderer: {
              disclosure_count: 5,
              open_disclosure_count: 0,
              reasoning_disclosure_count: 1,
              tool_disclosure_count: 3,
            },
            scroller: {
              mode: "end",
              distance_from_end_bucket: "at_end",
            },
          },
        },
        resource_samples: [
          expect.objectContaining({ heap_used_mb: 211, cpu_percent: 7 }),
          expect.objectContaining({ heap_used_mb: 215, cpu_percent: 8, event_loop_lag_ms: 9 }),
        ],
        privacy: {
          policy: "strict_allowlist_content_free",
          storage_target: "vault_local",
          host_sync: "may_sync_with_vault",
          automatic_upload: false,
        },
      });
      expect(report!.run_summary.failed_at < report!.run_summary.started_at!).toBe(true);
      expect(report!.tools.map((tool) => tool.ordinal)).toEqual([1, 2, 3]);
      expect(report!.tools.reduce((sum, tool) => sum + (tool.requested_item_count ?? 0), 0)).toBe(12);
      expect(report!.tools.reduce((sum, tool) => sum + (tool.completed_item_count ?? 0), 0)).toBe(9);
      expect(report!.tools.reduce((sum, tool) => sum + (tool.failed_item_count ?? 0), 0)).toBe(3);
      expect(report!.tools).toEqual(report!.tools.map((tool) => expect.objectContaining({
        tool_name: "read",
        outcome: "failed",
        failure_class: "partial_failure",
        result_delivery: "succeeded",
      })));
      const terminalIndex = report!.timeline.findIndex((event) => event.code === "run_finished_failed");
      const toolFailureIndexes = report!.timeline
        .map((event, index) => event.code === "local_tool_completed_failed" ? index : -1)
        .filter((index) => index >= 0);
      expect(toolFailureIndexes).toHaveLength(3);
      expect(toolFailureIndexes.every((index) => index < terminalIndex)).toBe(true);
      expect(report!.incident.failure_code).toBe("response_capacity_unavailable");
      expect(report!.incident).not.toHaveProperty("cause");
      expect(report!.timeline.every((event) => !("tool_call_id" in event))).toBe(true);
      expect(JSON.stringify(report)).not.toContain(CONVERSATION_ID);
      expect(JSON.stringify(report)).not.toContain(REQUEST_ID);

      const firstStoreBytes = await pipeline.coordinator.loadSerializedByIncidentId(INCIDENT_ID);
      expect(firstStoreBytes).not.toBeNull();
      const restarted = new AgentIncidentCoordinator({
        recorder: new AgentIncidentRecorder(),
        store: new AgentIncidentStore(pipeline.adapter, { now: () => CREATED_AT_MS }),
      });
      await restarted.initialize();
      const copiedAfterRestart: string[] = [];
      expect(copiedAfterRestart).toHaveLength(0);
      const restartedBytes = await restarted.loadSerializedByIncidentId(INCIDENT_ID);
      expect(restartedBytes).toBe(firstStoreBytes);
      copiedAfterRestart.push(restartedBytes!);
      expect(copiedAfterRestart[0]).toBe(firstStoreBytes);

      expectNoPrivateDiagnostics([
        JSON.stringify(report),
        JSON.stringify(pipeline.supportEvents),
        JSON.stringify(pipeline.logger.getSupportDiagnostics()),
        firstStoreBytes!,
        copiedAfterRestart[0]!,
        JSON.stringify(pipeline.errorCallbacks),
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    } finally {
      pipeline.dispose();
      jest.useRealTimers();
    }
  });

  it.each([
    ["lifecycle projection", "lifecycle_projection", false],
    ["resource capture", "resource_capture", true],
    ["recorder finalization", "recorder_finalization", false],
    ["store rejection", "store_rejection", true],
    ["clipboard", "clipboard", false],
  ] as const)("keeps the failed ChatView usable after %s failure", async (_label, mode, expectedCopy) => {
    jest.useFakeTimers({ now: STARTED_AT_MS });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    const pipeline = new IncidentPipelineHarness(mode);
    try {
      await pipeline.initialize();
      recordProductionChronology(pipeline);
      await pipeline.drain();
      await Promise.resolve();
      await Promise.resolve();

      expectDurableFailedPartial(pipeline);
      expect(pipeline.failedCard).not.toBeNull();
      expect(pipeline.failedCard!.retry()).toBe(true);
      expect(pipeline.retryCalls).toBe(1);
      if (mode === "lifecycle_projection") {
        await pipeline.coordinator.closeAdmissionAndDrain();
        await expect(pipeline.failedCard!.copyReport()).resolves.toBe(expectedCopy);
      } else {
        const copyResult = pipeline.failedCard!.copyReport();
        await jest.advanceTimersByTimeAsync(1_500);
        await expect(copyResult).resolves.toBe(expectedCopy);
      }
      expect(pipeline.errorCallbacks).toEqual([]);
      expect(unhandledRejections).toEqual([]);
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();

      const report = pipeline.recorder.getByIncidentId(INCIDENT_ID);
      const diagnosticSurfaces = [
        JSON.stringify(report),
        JSON.stringify(pipeline.supportEvents),
        JSON.stringify(pipeline.logger.getSupportDiagnostics()),
        ...pipeline.copiedBytes,
        ...[...pipeline.adapter.files.values()].map((file) => file.data),
        JSON.stringify(pipeline.errorCallbacks),
      ];
      expectNoPrivateDiagnostics(diagnosticSurfaces);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      pipeline.dispose();
      jest.useRealTimers();
    }
  });
});
