import { isFirstPartyToolName } from "../../../tools/toolNames";
import { isThinAgentCommandKind } from "../../../services/managed/ThinAgentV1Contract";
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
  type AgentLifecycleCode,
  type AgentLifecyclePhase,
  type CreditsRefreshReason,
  type HistorySyncKind,
  type ToolDiagnosticFailureClass,
  type ToolDiagnosticOutcome,
} from "../../../utils/ThinAgentLifecycleSchema";
import type { AgentCommandKind } from "./Protocol";

export {
  CREDITS_REFRESH_REASONS,
  HISTORY_SYNC_KINDS,
  THIN_AGENT_LIFECYCLE_CODES,
  THIN_AGENT_LIFECYCLE_PHASES,
} from "../../../utils/ThinAgentLifecycleSchema";
export type {
  AgentLifecycleCode,
  AgentLifecyclePhase,
  CreditsRefreshReason,
  HistorySyncKind,
} from "../../../utils/ThinAgentLifecycleSchema";

const MAX_TOOL_EXECUTION_ORDINAL = 512;
const MAX_HISTORY_SYNC_ORDINAL = 2_048;

export type AgentLifecycleInput = Readonly<{
  code: AgentLifecycleCode;
  phase: AgentLifecyclePhase;
  conversationId?: string;
  requestId?: string;
  clientInstanceId?: string;
  pluginBuildId?: string;
  runId?: string;
  serverRunId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
  failureCode?: string;
  latencyTraceId?: string;
  commandKind?: AgentCommandKind;
  commandSegmentOrdinal?: number;
  toolExecutionOrdinal?: number;
  toolOutcome?: ToolDiagnosticOutcome;
  toolFailureClass?: ToolDiagnosticFailureClass;
  toolItemCount?: number;
  toolCompletedItemCount?: number;
  toolFailedItemCount?: number;
  historySyncKind?: HistorySyncKind;
  historySyncOrdinal?: number;
  responseDeliveryMode?: "fetch_stream" | "request_url_buffered";
  clientMonotonicOffsetMs?: number;
  serverTimingAppMs?: number;
  serverTimingAuthMs?: number;
  creditsRefreshReason?: CreditsRefreshReason;
  creditsRefreshSequence?: number;
  creditsRefreshTransport?: "fetch" | "request_url";
  creditsRefreshElapsedMs?: number;
  creditsRefreshServerAuthMs?: number;
  creditsRefreshServerRateLimitMs?: number;
  creditsRefreshServerBalanceStoreMs?: number;
  creditsRefreshServerTotalMs?: number;
}>;

export type AgentLifecycleRecord = Readonly<{
  sequence: number;
  timestamp: number;
  code: AgentLifecycleCode;
  phase: AgentLifecyclePhase;
  conversationId?: string;
  requestId?: string;
  clientInstanceId?: string;
  pluginBuildId?: string;
  runId?: string;
  serverRunId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
  failureCode?: string;
  latencyTraceId?: string;
  commandKind?: AgentCommandKind;
  commandSegmentOrdinal?: number;
  toolExecutionOrdinal?: number;
  toolOutcome?: ToolDiagnosticOutcome;
  toolFailureClass?: ToolDiagnosticFailureClass;
  toolItemCount?: number;
  toolCompletedItemCount?: number;
  toolFailedItemCount?: number;
  historySyncKind?: HistorySyncKind;
  historySyncOrdinal?: number;
  responseDeliveryMode?: "fetch_stream" | "request_url_buffered";
  clientMonotonicOffsetMs?: number;
  clientClockDomain?: "client_turn_monotonic";
  serverTimingAppMs?: number;
  serverTimingAuthMs?: number;
  serverTimingClockDomain?: "server_response_headers_monotonic_duration";
  creditsRefreshReason?: CreditsRefreshReason;
  creditsRefreshSequence?: number;
  creditsRefreshTransport?: "fetch" | "request_url";
  creditsRefreshElapsedMs?: number;
  creditsRefreshClockDomain?: "client_refresh_monotonic_duration";
  creditsRefreshServerAuthMs?: number;
  creditsRefreshServerRateLimitMs?: number;
  creditsRefreshServerBalanceStoreMs?: number;
  creditsRefreshServerTotalMs?: number;
  creditsRefreshServerTimingClockDomain?: "server_response_headers_monotonic_duration";
}>;

type AgentLifecycleInputSnapshot = {
  readonly [Key in keyof AgentLifecycleInput]: AgentLifecycleInput[Key];
};

function snapshotAgentLifecycleInput(
  input: AgentLifecycleInput,
): AgentLifecycleInputSnapshot {
  return {
    code: input.code,
    phase: input.phase,
    conversationId: input.conversationId,
    requestId: input.requestId,
    clientInstanceId: input.clientInstanceId,
    pluginBuildId: input.pluginBuildId,
    runId: input.runId,
    serverRunId: input.serverRunId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    status: input.status,
    retryable: input.retryable,
    incidentId: input.incidentId,
    failureCode: input.failureCode,
    latencyTraceId: input.latencyTraceId,
    commandKind: input.commandKind,
    commandSegmentOrdinal: input.commandSegmentOrdinal,
    toolExecutionOrdinal: input.toolExecutionOrdinal,
    toolOutcome: input.toolOutcome,
    toolFailureClass: input.toolFailureClass,
    toolItemCount: input.toolItemCount,
    toolCompletedItemCount: input.toolCompletedItemCount,
    toolFailedItemCount: input.toolFailedItemCount,
    historySyncKind: input.historySyncKind,
    historySyncOrdinal: input.historySyncOrdinal,
    responseDeliveryMode: input.responseDeliveryMode,
    clientMonotonicOffsetMs: input.clientMonotonicOffsetMs,
    serverTimingAppMs: input.serverTimingAppMs,
    serverTimingAuthMs: input.serverTimingAuthMs,
    creditsRefreshReason: input.creditsRefreshReason,
    creditsRefreshSequence: input.creditsRefreshSequence,
    creditsRefreshTransport: input.creditsRefreshTransport,
    creditsRefreshElapsedMs: input.creditsRefreshElapsedMs,
    creditsRefreshServerAuthMs: input.creditsRefreshServerAuthMs,
    creditsRefreshServerRateLimitMs: input.creditsRefreshServerRateLimitMs,
    creditsRefreshServerBalanceStoreMs: input.creditsRefreshServerBalanceStoreMs,
    creditsRefreshServerTotalMs: input.creditsRefreshServerTotalMs,
  };
}

/**
 * Strict, content-free client lifecycle recorder. It copies only explicitly
 * allowlisted scalar fields and never serializes caller-owned objects.
 */
export class AgentLifecycle {
  private sequence = 0;

  constructor(
    private readonly persist: (record: AgentLifecycleRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public record(input: AgentLifecycleInput): AgentLifecycleRecord | null {
    let record: AgentLifecycleRecord;
    try {
      const snapshot = snapshotAgentLifecycleInput(input);
      if (!isAgentLifecycleCode(snapshot.code) || !isAgentLifecyclePhase(snapshot.phase)) {
        return null;
      }
      const conversationId = isThinAgentConversationId(snapshot.conversationId)
        ? snapshot.conversationId
        : undefined;
      const requestId = boundedThinAgentIdentifier(snapshot.requestId, 160);
      const clientInstanceId = isThinAgentClientInstanceId(snapshot.clientInstanceId)
        ? snapshot.clientInstanceId
        : undefined;
      const pluginBuildId = boundedThinAgentIdentifier(snapshot.pluginBuildId, 160);
      const runId = boundedThinAgentIdentifier(snapshot.runId, 160);
      const serverRunId = isThinAgentServerRunId(snapshot.serverRunId)
        ? snapshot.serverRunId
        : undefined;
      const toolName = isFirstPartyToolName(snapshot.toolName)
        ? snapshot.toolName
        : undefined;
      const toolCallId = boundedThinAgentIdentifier(snapshot.toolCallId, 160);
      const status = Number.isInteger(snapshot.status)
        && snapshot.status! >= 100
        && snapshot.status! <= 599
        ? snapshot.status
        : undefined;
      const incidentId = isThinAgentIncidentId(snapshot.incidentId)
        ? snapshot.incidentId
        : undefined;
      const failureCode = isThinAgentFailureCode(snapshot.failureCode)
        ? snapshot.failureCode
        : undefined;
      const latencyTraceId = isThinAgentLatencyTraceId(snapshot.latencyTraceId)
        ? snapshot.latencyTraceId
        : undefined;
      const commandKind = isThinAgentCommandKind(snapshot.commandKind)
        ? snapshot.commandKind
        : undefined;
      const commandSegmentOrdinal = Number.isSafeInteger(snapshot.commandSegmentOrdinal)
        && snapshot.commandSegmentOrdinal! > 0
        ? snapshot.commandSegmentOrdinal
        : undefined;
      const toolExecutionOrdinal = Number.isSafeInteger(snapshot.toolExecutionOrdinal)
        && snapshot.toolExecutionOrdinal! > 0
        && snapshot.toolExecutionOrdinal! <= MAX_TOOL_EXECUTION_ORDINAL
        ? snapshot.toolExecutionOrdinal
        : undefined;
      const toolOutcome = isToolDiagnosticOutcome(snapshot.toolOutcome)
        ? snapshot.toolOutcome
        : undefined;
      const toolFailureClass = isToolDiagnosticFailureClass(snapshot.toolFailureClass)
        ? snapshot.toolFailureClass
        : undefined;
      const toolItemCount = boundedToolDiagnosticItemCount(snapshot.toolItemCount);
      const toolCompletedItemCount = boundedToolDiagnosticItemCount(
        snapshot.toolCompletedItemCount,
      );
      const toolFailedItemCount = boundedToolDiagnosticItemCount(
        snapshot.toolFailedItemCount,
      );
      const historySyncKind = isHistorySyncKind(snapshot.historySyncKind)
        ? snapshot.historySyncKind
        : undefined;
      const historySyncOrdinal = Number.isSafeInteger(snapshot.historySyncOrdinal)
        && snapshot.historySyncOrdinal! > 0
        && snapshot.historySyncOrdinal! <= MAX_HISTORY_SYNC_ORDINAL
        ? snapshot.historySyncOrdinal
        : undefined;
      const responseDeliveryMode = snapshot.responseDeliveryMode === "fetch_stream"
        || snapshot.responseDeliveryMode === "request_url_buffered"
        ? snapshot.responseDeliveryMode
        : undefined;
      const clientMonotonicOffsetMs = boundedThinAgentTiming(
        snapshot.clientMonotonicOffsetMs,
      );
      const serverTimingAppMs = boundedThinAgentTiming(snapshot.serverTimingAppMs);
      const serverTimingAuthMs = boundedThinAgentTiming(snapshot.serverTimingAuthMs);
      const creditsRefreshReason = isCreditsRefreshReason(snapshot.creditsRefreshReason)
        ? snapshot.creditsRefreshReason
        : undefined;
      const creditsRefreshSequence = Number.isSafeInteger(snapshot.creditsRefreshSequence)
        && snapshot.creditsRefreshSequence! > 0
        ? snapshot.creditsRefreshSequence
        : undefined;
      const creditsRefreshTransport = snapshot.creditsRefreshTransport === "fetch"
        || snapshot.creditsRefreshTransport === "request_url"
        ? snapshot.creditsRefreshTransport
        : undefined;
      const creditsRefreshElapsedMs = boundedThinAgentTiming(
        snapshot.creditsRefreshElapsedMs,
      );
      const creditsRefreshServerAuthMs = boundedThinAgentTiming(
        snapshot.creditsRefreshServerAuthMs,
      );
      const creditsRefreshServerRateLimitMs = boundedThinAgentTiming(
        snapshot.creditsRefreshServerRateLimitMs,
      );
      const creditsRefreshServerBalanceStoreMs = boundedThinAgentTiming(
        snapshot.creditsRefreshServerBalanceStoreMs,
      );
      const creditsRefreshServerTotalMs = boundedThinAgentTiming(
        snapshot.creditsRefreshServerTotalMs,
      );
      const nextSequence = this.sequence + 1;
      record = Object.freeze({
      sequence: nextSequence,
      timestamp: this.now(),
      code: snapshot.code,
      phase: snapshot.phase,
      ...(conversationId ? { conversationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(clientInstanceId ? { clientInstanceId } : {}),
      ...(pluginBuildId ? { pluginBuildId } : {}),
      ...(runId ? { runId } : {}),
      ...(serverRunId ? { serverRunId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status === undefined ? {} : { status }),
      ...(typeof snapshot.retryable === "boolean" ? { retryable: snapshot.retryable } : {}),
      ...(incidentId ? { incidentId } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(latencyTraceId ? { latencyTraceId } : {}),
      ...(commandKind ? { commandKind } : {}),
      ...(commandSegmentOrdinal === undefined ? {} : { commandSegmentOrdinal }),
      ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
      ...(toolOutcome ? { toolOutcome } : {}),
      ...(toolFailureClass ? { toolFailureClass } : {}),
      ...(toolItemCount === undefined ? {} : { toolItemCount }),
      ...(toolCompletedItemCount === undefined ? {} : { toolCompletedItemCount }),
      ...(toolFailedItemCount === undefined ? {} : { toolFailedItemCount }),
      ...(historySyncKind ? { historySyncKind } : {}),
      ...(historySyncOrdinal === undefined ? {} : { historySyncOrdinal }),
      ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
      ...(clientMonotonicOffsetMs === undefined
        ? {}
        : {
            clientMonotonicOffsetMs,
            clientClockDomain: "client_turn_monotonic" as const,
          }),
      ...(serverTimingAppMs === undefined ? {} : { serverTimingAppMs }),
      ...(serverTimingAuthMs === undefined ? {} : { serverTimingAuthMs }),
      ...(serverTimingAppMs === undefined && serverTimingAuthMs === undefined
        ? {}
        : { serverTimingClockDomain: "server_response_headers_monotonic_duration" as const }),
      ...(creditsRefreshReason ? { creditsRefreshReason } : {}),
      ...(creditsRefreshSequence === undefined ? {} : { creditsRefreshSequence }),
      ...(creditsRefreshTransport ? { creditsRefreshTransport } : {}),
      ...(creditsRefreshElapsedMs === undefined
        ? {}
        : {
            creditsRefreshElapsedMs,
            creditsRefreshClockDomain: "client_refresh_monotonic_duration" as const,
          }),
      ...(creditsRefreshServerAuthMs === undefined ? {} : { creditsRefreshServerAuthMs }),
      ...(creditsRefreshServerRateLimitMs === undefined
        ? {}
        : { creditsRefreshServerRateLimitMs }),
      ...(creditsRefreshServerBalanceStoreMs === undefined
        ? {}
        : { creditsRefreshServerBalanceStoreMs }),
      ...(creditsRefreshServerTotalMs === undefined ? {} : { creditsRefreshServerTotalMs }),
      ...(creditsRefreshServerAuthMs === undefined
        && creditsRefreshServerRateLimitMs === undefined
        && creditsRefreshServerBalanceStoreMs === undefined
        && creditsRefreshServerTotalMs === undefined
        ? {}
        : {
            creditsRefreshServerTimingClockDomain:
              "server_response_headers_monotonic_duration" as const,
          }),
      });
      this.sequence = nextSequence;
    } catch {
      // Hostile inputs and unavailable clocks cannot affect the product flow.
      return null;
    }
    try {
      this.persist(record);
    } catch {
      // Lifecycle diagnostics must never alter the product flow.
    }
    return record;
  }

}
