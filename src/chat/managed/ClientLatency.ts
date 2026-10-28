import type { AgentChatTransportSegmentSummaryEvent } from "../../core/diagnostics/AgentIncidentCapture";
import type { PlatformResponseDeliveryMode } from "../../services/PlatformRequestClient";
import { isThinAgentConversationId, isThinAgentRequestId } from "../../utils/ThinAgentLifecycleSchema";
import type { AgentConversationSnapshot } from "../ChatConversation";
import type { AgentCommandKind } from "./Protocol";
import type { AgentTransportSegmentSummaryEvent, AgentTransportTimingEvent } from "./StreamingTransport";
import type { AgentLifecycleCode, AgentLifecycleInput, HistorySyncKind } from "./Lifecycle";

const MAX_RETAINED_LATENCY_RUNS = 8;
const MAX_RETAINED_LATENCY_SEGMENTS_PER_RUN = 512;
const MAX_TOOL_EXECUTIONS_PER_RUN = 512;
const MAX_HISTORY_SYNCS_PER_RUN = 2_048;
type ClientLatencyContext = {
  readonly conversationId: string;
  readonly requestId: string;
  readonly startedAtMonotonicMs: number;
  readonly milestones: Set<AgentLifecycleCode>;
  readonly segmentMilestones: Set<string>;
  readonly toolMilestones: Set<string>;
  readonly segments: Map<number, ClientLatencySegment>;
  readonly toolExecutionOrdinals: Map<string, number>;
  nextToolExecutionOrdinal: number;
  nextHistorySyncOrdinal: number;
  pendingAssistantProjectionOrdinal: number | null;
  pendingCommandAck: Readonly<{
    ordinal: number;
    commandKind: AgentCommandKind;
    toolCallId: string | null;
  }> | null;
  pendingTerminalOrdinal: number | null;
  terminalSegmentOrdinal: number | null;
  lastOffsetMs: number;
};

type ClientLatencySegment = {
  readonly ordinal: number;
  readonly commandKind: AgentCommandKind;
  readonly toolCallId: string | null;
  readonly toolExecutionOrdinal: number | null;
  toolName: string | null;
  latencyTraceId: string | null;
  responseDeliveryMode: PlatformResponseDeliveryMode | null;
};

export type ClientToolRenderCode = Extract<AgentLifecycleCode,
  | "local_tool_terminal_dom_committed"
  | "local_tool_terminal_paint_opportunity"
  | "continuation_content_dom_committed"
  | "continuation_content_paint_opportunity">;

type HistorySyncCorrelation = Readonly<{
  conversationId?: string;
  requestId?: string;
  historySyncKind: HistorySyncKind;
  historySyncOrdinal?: number;
}>;
type LatencyRun = Readonly<{
  conversationId: string;
  requestId: string;
  serverRunId: string | null;
}>;

type ClientLatencyOptions = Readonly<{
  monotonicNow: () => number;
  activeRun: () => LatencyRun | null;
  toolName: (requestId: string, toolCallId: string) => string | null;
  recordLifecycle: (input: AgentLifecycleInput) => void;
  onTransportSegmentSummary?: (event: AgentChatTransportSegmentSummaryEvent) => void;
}>;

/** Owns per-run timing correlation; diagnostics never grant execution authority. */
export class ClientLatency {
  private readonly contexts = new Map<string, ClientLatencyContext>();

  public constructor(private readonly options: ClientLatencyOptions) {}

  public clear(): void {
    this.contexts.clear();
  }

  public elapsed(conversationId: string, requestId: string): number | null {
    const context = this.contexts.get(requestId);
    return context?.conversationId === conversationId
      ? this.options.monotonicNow() - context.startedAtMonotonicMs
      : null;
  }

  public needsRenderMilestone(code: AgentLifecycleCode, requestId: string): boolean {
    const context = this.contexts.get(requestId);
    return Boolean(context && !context.milestones.has(code));
  }

  public needsToolRenderMilestone(
    code: ClientToolRenderCode, requestId: string, toolCallId: string,
  ): boolean {
    const context = this.contexts.get(requestId);
    const ordinal = context?.toolExecutionOrdinals.get(toolCallId);
    return Boolean(context && ordinal !== undefined
      && !context.toolMilestones.has(`${ordinal}:${code}`));
  }

  public toolResultSegmentOrdinal(
    requestId: string, toolCallId: string, toolExecutionOrdinal: number | undefined,
  ): number | undefined {
    const context = this.contexts.get(requestId);
    return context && toolExecutionOrdinal !== undefined
      ? this.latestToolResultSegmentOrdinal(context, toolCallId, toolExecutionOrdinal)
      : undefined;
  }

  public commandAckSegmentOrdinal(
    requestId: string, commandKind: AgentCommandKind, toolCallId: string | null,
  ): number | undefined {
    const pending = this.contexts.get(requestId)?.pendingCommandAck;
    return pending && pending.commandKind === commandKind && pending.toolCallId === toolCallId
      ? pending.ordinal
      : undefined;
  }

  public acceptTerminal(requestId: string): number | undefined {
    const context = this.contexts.get(requestId);
    const ordinal = context?.pendingTerminalOrdinal ?? undefined;
    if (context && ordinal !== undefined) context.terminalSegmentOrdinal = ordinal;
    return ordinal;
  }

  public terminalSegmentOrdinal(requestId: string): number | undefined {
    return this.contexts.get(requestId)?.terminalSegmentOrdinal ?? undefined;
  }

  public awaitsProjection(requestId: string): boolean {
    const context = this.contexts.get(requestId);
    return context !== undefined && (context.pendingAssistantProjectionOrdinal !== null
      || !context.milestones.has("response_first_content_projected"));
  }

  public observeProjection(requestId: string, snapshot: AgentConversationSnapshot): void {
    const context = this.contexts.get(requestId);
    const pendingAssistantProjectionOrdinal = context?.pendingAssistantProjectionOrdinal ?? null;
    if (pendingAssistantProjectionOrdinal !== null && snapshot.messages.length > 0) {
      this.recordMilestone("response_first_assistant_snapshot_projected", requestId,
        this.options.monotonicNow(), {}, pendingAssistantProjectionOrdinal);
      context!.pendingAssistantProjectionOrdinal = null;
    }
    if (snapshot.parts.some((part) =>
      part.kind === "text" || part.kind === "reasoning" || part.kind === "tool")) {
      this.recordMilestone("response_first_content_projected", requestId, this.options.monotonicNow());
    }
  }

  private retain(input: Readonly<{
    conversationId: string;
    requestId: string;
    startedAtMonotonicMs?: number;
  }>): void {
    const fallback = this.options.monotonicNow();
    const startedAtMonotonicMs = typeof input.startedAtMonotonicMs === "number"
      && Number.isFinite(input.startedAtMonotonicMs)
      ? input.startedAtMonotonicMs
      : fallback;
    this.contexts.delete(input.requestId);
    this.contexts.set(input.requestId, {
      conversationId: input.conversationId,
      requestId: input.requestId,
      startedAtMonotonicMs,
      milestones: new Set(),
      segmentMilestones: new Set(),
      toolMilestones: new Set(),
      segments: new Map(),
      toolExecutionOrdinals: new Map(),
      nextToolExecutionOrdinal: 0,
      nextHistorySyncOrdinal: 0,
      pendingAssistantProjectionOrdinal: null,
      pendingCommandAck: null,
      pendingTerminalOrdinal: null,
      terminalSegmentOrdinal: null,
      lastOffsetMs: 0,
    });
    while (this.contexts.size > MAX_RETAINED_LATENCY_RUNS) {
      const oldest = this.contexts.keys().next().value;
      if (!oldest) break;
      this.contexts.delete(oldest);
    }
  }

  public ensure(input: Readonly<{
    conversationId: string;
    requestId: string;
    startedAtMonotonicMs?: number;
  }>): void {
    const existing = this.contexts.get(input.requestId);
    if (existing?.conversationId === input.conversationId) return;
    this.retain(input);
  }

  public ensureToolExecutionOrdinal(
    active: LatencyRun,
    toolCallId: string,
  ): number | undefined {
    const context = this.contexts.get(active.requestId);
    if (!context || context.conversationId !== active.conversationId) return undefined;
    const existing = context.toolExecutionOrdinals.get(toolCallId);
    if (existing !== undefined) return existing;
    if (context.nextToolExecutionOrdinal >= MAX_TOOL_EXECUTIONS_PER_RUN) return undefined;
    const ordinal = ++context.nextToolExecutionOrdinal;
    context.toolExecutionOrdinals.set(toolCallId, ordinal);
    return ordinal;
  }

  private latestToolResultSegmentOrdinal(
    context: ClientLatencyContext,
    toolCallId: string,
    toolExecutionOrdinal: number,
    requireAssistantProjection = false,
  ): number | undefined {
    const segments = [...context.segments.values()]
      .sort((left, right) => right.ordinal - left.ordinal);
    return segments.find((segment) =>
      segment.commandKind === "client_tool_result"
      && segment.toolCallId === toolCallId
      && segment.toolExecutionOrdinal === toolExecutionOrdinal
      && (!requireAssistantProjection || context.segmentMilestones.has(
        `${segment.ordinal}:response_first_assistant_snapshot_projected`,
      )))?.ordinal;
  }

  public recordToolRenderMilestone(
    code: ClientToolRenderCode,
    requestId: string,
    toolCallId: string,
    observedAtMonotonicMs: number,
  ): void {
    const context = this.contexts.get(requestId);
    const toolExecutionOrdinal = context?.toolExecutionOrdinals.get(toolCallId);
    if (!context || toolExecutionOrdinal === undefined) return;
    const milestone = `${toolExecutionOrdinal}:${code}`;
    if (context.toolMilestones.has(milestone)) return;
    const continuation = code === "continuation_content_dom_committed"
      || code === "continuation_content_paint_opportunity";
    const commandSegmentOrdinal = this.latestToolResultSegmentOrdinal(
      context,
      toolCallId,
      toolExecutionOrdinal,
      continuation,
    );
    context.toolMilestones.add(milestone);
    const active = this.options.activeRun();
    const serverRunId = active?.requestId === requestId ? active.serverRunId : null;
    this.options.recordLifecycle({
      code,
      phase: "render",
      conversationId: context.conversationId,
      requestId,
      ...(serverRunId ? { serverRunId } : {}),
      toolExecutionOrdinal,
      ...this.fields(
        requestId,
        observedAtMonotonicMs,
        commandSegmentOrdinal,
      ),
    });
  }

  public createHistorySyncCorrelation(
    historySyncKind: HistorySyncKind,
    conversationId: string | null,
  ): HistorySyncCorrelation {
    const active = this.options.activeRun();
    conversationId = active?.conversationId ?? conversationId;
    if (!active) return { ...(conversationId ? { conversationId } : {}), historySyncKind };
    const context = this.contexts.get(active.requestId);
    if (!context || context.nextHistorySyncOrdinal >= MAX_HISTORY_SYNCS_PER_RUN) {
      return { conversationId: active.conversationId, historySyncKind };
    }
    const historySyncOrdinal = ++context.nextHistorySyncOrdinal;
    return {
      conversationId: active.conversationId,
      requestId: active.requestId,
      historySyncKind,
      historySyncOrdinal,
    };
  }

  public recordHistorySync(
    code: Extract<AgentLifecycleCode,
      "history_sync_started" | "history_sync_completed" | "history_sync_failed">,
    correlation: HistorySyncCorrelation,
  ): void {
    this.options.recordLifecycle({
      code,
      phase: "persistence",
      ...correlation,
      ...(correlation.requestId ? this.fields(correlation.requestId) : {}),
    });
  }

  public fields(
    requestId: string,
    observedAtMonotonicMs = this.options.monotonicNow(),
    commandSegmentOrdinal?: number,
  ): Readonly<{
    latencyTraceId?: string;
    commandKind?: AgentCommandKind;
    commandSegmentOrdinal?: number;
    toolExecutionOrdinal?: number;
    responseDeliveryMode?: PlatformResponseDeliveryMode;
    clientMonotonicOffsetMs?: number;
  }> {
    const context = this.contexts.get(requestId);
    if (!context || !Number.isFinite(observedAtMonotonicMs)) return {};
    // Segment identity is intentionally opt-in. Multiple /turn streams for one
    // logical request can overlap, so a global "last callback" pointer would
    // let a late callback relabel DOM, paint, tool, or terminal milestones.
    const segment = commandSegmentOrdinal === undefined
      ? undefined
      : context.segments.get(commandSegmentOrdinal);
    const offset = Math.max(
      context.lastOffsetMs,
      observedAtMonotonicMs - context.startedAtMonotonicMs,
      0,
    );
    context.lastOffsetMs = offset;
    return {
      ...(segment?.latencyTraceId
        ? { latencyTraceId: segment.latencyTraceId }
        : {}),
      ...(segment
        ? {
            commandKind: segment.commandKind,
            commandSegmentOrdinal: segment.ordinal,
          }
        : {}),
      ...(typeof segment?.toolExecutionOrdinal === "number"
        ? { toolExecutionOrdinal: segment.toolExecutionOrdinal }
        : {}),
      ...(segment?.responseDeliveryMode
        ? { responseDeliveryMode: segment.responseDeliveryMode }
        : {}),
      clientMonotonicOffsetMs: offset,
    };
  }

  public recordMilestone(
    code: AgentLifecycleCode,
    requestId: string,
    observedAtMonotonicMs: number,
    extra: Readonly<{
      status?: number;
      retryable?: boolean;
      failureCode?: string;
      serverTimingAppMs?: number;
      serverTimingAuthMs?: number;
      responseDeliveryMode?: PlatformResponseDeliveryMode;
      toolName?: string;
      toolCallId?: string;
      toolExecutionOrdinal?: number;
    }> = {},
    commandSegmentOrdinal?: number,
  ): void {
    const context = this.contexts.get(requestId);
    if (!context) return;
    const segmentMilestone = commandSegmentOrdinal === undefined
      ? null
      : `${commandSegmentOrdinal}:${code}`;
    const milestones = segmentMilestone === null
      ? context.milestones
      : context.segmentMilestones;
    const milestone = segmentMilestone ?? code;
    if (milestones.has(milestone)) return;
    milestones.add(milestone);
    const active = this.options.activeRun();
    const serverRunId = active?.requestId === requestId ? active.serverRunId : null;
    this.options.recordLifecycle({
      code,
      phase: code === "response_first_dom_committed"
        || code === "response_first_paint_opportunity"
        || code === "local_tool_terminal_dom_committed"
        || code === "local_tool_terminal_paint_opportunity"
        || code === "continuation_content_dom_committed"
        || code === "continuation_content_paint_opportunity"
        ? "render"
        : "response",
      conversationId: context.conversationId,
      requestId,
      ...(serverRunId ? { serverRunId } : {}),
      ...extra,
      ...this.fields(
        requestId,
        observedAtMonotonicMs,
        commandSegmentOrdinal,
      ),
    });
  }

  public handleTransportTiming(event: AgentTransportTimingEvent): void {
    const context = this.contexts.get(event.requestId);
    if (!context) return;

    // A transport callback may carry an unknown or adversarial call ID. Only
    // a locally started execution establishes the export ordinal; exact IDs
    // can join that existing map but can never create a new ordinal here.
    const toolExecutionOrdinal = event.toolCallId
      ? context.toolExecutionOrdinals.get(event.toolCallId)
      : undefined;
    const existing = context.segments.get(event.commandSegmentOrdinal);
    if (existing && existing.commandKind !== event.commandKind) return;
    const segment: ClientLatencySegment = existing ?? {
      ordinal: event.commandSegmentOrdinal,
      commandKind: event.commandKind,
      toolCallId: event.toolCallId ?? null,
      toolExecutionOrdinal: toolExecutionOrdinal ?? null,
      toolName: null,
      latencyTraceId: null,
      responseDeliveryMode: null,
    };
    if (existing && existing.toolCallId !== (event.toolCallId ?? null)) return;
    if (
      existing
      && existing.toolExecutionOrdinal !== (toolExecutionOrdinal ?? null)
    ) return;
    if (segment.toolCallId && segment.toolName === null) {
      segment.toolName = this.options.toolName(event.requestId, segment.toolCallId);
    }
    if (event.latencyTraceId) segment.latencyTraceId = event.latencyTraceId;
    if (event.responseDeliveryMode) {
      segment.responseDeliveryMode = event.responseDeliveryMode;
    }
    context.segments.set(segment.ordinal, segment);
    while (context.segments.size > MAX_RETAINED_LATENCY_SEGMENTS_PER_RUN) {
      const oldest = context.segments.keys().next().value;
      if (oldest === undefined) break;
      context.segments.delete(oldest);
      for (const code of [
        "command_segment_dispatch_started",
        "response_available",
        "response_first_body_chunk_observed",
        "response_first_sse_frame_parsed",
        "response_first_assistant_sse_frame_parsed",
        "response_first_assistant_snapshot_projected",
      ] as const) {
        context.segmentMilestones.delete(`${oldest}:${code}`);
      }
    }
    if (event.milestone === "assistant_sse_frame_delivery_completed") {
      if (context.pendingAssistantProjectionOrdinal === event.commandSegmentOrdinal) {
        context.pendingAssistantProjectionOrdinal = null;
      }
      return;
    }
    if (event.milestone === "command_ack_sse_frame_delivery_completed") {
      if (context.pendingCommandAck?.ordinal === event.commandSegmentOrdinal) {
        context.pendingCommandAck = null;
      }
      return;
    }
    if (event.milestone === "terminal_sse_frame_delivery_completed") {
      if (context.pendingTerminalOrdinal === event.commandSegmentOrdinal) {
        context.pendingTerminalOrdinal = null;
      }
      return;
    }
    if (event.milestone === "command_ack_sse_frame") {
      context.pendingCommandAck = {
        ordinal: event.commandSegmentOrdinal,
        commandKind: event.commandKind,
        toolCallId: event.toolCallId ?? null,
      };
      return;
    }
    if (event.milestone === "terminal_sse_frame") {
      context.pendingTerminalOrdinal = event.commandSegmentOrdinal;
      return;
    }
    if (event.milestone === "first_assistant_sse_frame") {
      context.pendingAssistantProjectionOrdinal = event.commandSegmentOrdinal;
    }
    const code = event.milestone === "command_dispatch_started"
      ? "command_segment_dispatch_started"
      : event.milestone === "response_available"
        ? "response_available"
        : event.milestone === "first_body_chunk"
          ? "response_first_body_chunk_observed"
          : event.milestone === "first_assistant_sse_frame"
            ? "response_first_assistant_sse_frame_parsed"
            : "response_first_sse_frame_parsed";
    this.recordMilestone(
      code,
      event.requestId,
      event.observedAtMonotonicMs,
      {
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.serverTimingAppMs === undefined
          ? {}
          : { serverTimingAppMs: event.serverTimingAppMs }),
        ...(event.serverTimingAuthMs === undefined
          ? {}
          : { serverTimingAuthMs: event.serverTimingAuthMs }),
        ...(event.responseDeliveryMode
          ? { responseDeliveryMode: event.responseDeliveryMode }
          : {}),
        ...(segment.toolName ? { toolName: segment.toolName } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      },
      event.commandSegmentOrdinal,
    );
  }

  public handleTransportSegmentSummary(
    conversationId: string,
    event: AgentTransportSegmentSummaryEvent,
  ): void {
    try {
      const requestId = event.requestId;
      if (
        !isThinAgentConversationId(conversationId)
        || !isThinAgentRequestId(requestId)
      ) return;
      const context = this.contexts.get(requestId);
      const segment = context?.conversationId === conversationId
        ? context.segments.get(event.commandSegmentOrdinal)
        : undefined;
      const toolExecutionOrdinal = segment?.commandKind === event.commandKind
        && segment.toolCallId === (event.toolCallId ?? null)
        ? segment.toolExecutionOrdinal ?? undefined
        : undefined;
      const safeEvent: AgentChatTransportSegmentSummaryEvent = Object.freeze({
        conversationId,
        requestId,
        commandKind: event.commandKind,
        commandSegmentOrdinal: event.commandSegmentOrdinal,
        ...(segment?.latencyTraceId
          ? { serverLatencyCorrelationId: segment.latencyTraceId }
          : {}),
        ...(toolExecutionOrdinal === undefined
          ? {}
          : { toolExecutionOrdinal }),
        closeReason: event.closeReason,
        durationMs: event.durationMs,
        receivedBytes: event.receivedBytes,
        nonEmptyRawChunkCount: event.nonEmptyRawChunkCount,
        sseEventCount: event.sseEventCount,
        acceptedFrameCount: event.acceptedFrameCount,
        deliveredFrameCount: event.deliveredFrameCount,
        metricsTruncated: event.metricsTruncated,
      });
      this.options.onTransportSegmentSummary?.(safeEvent);
    } catch {
      // Incident evidence is observational and cannot affect the run.
    }
  }

}
