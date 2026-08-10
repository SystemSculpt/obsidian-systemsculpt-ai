import { isFirstPartyToolName } from "../../../tools/toolNames";
import { isThinAgentCommandKind } from "../../../services/managed/ThinAgentV1Contract";
import {
  boundedThinAgentIdentifier,
  boundedThinAgentTiming,
  isAgentLifecycleCode,
  isAgentLifecyclePhase,
  isCreditsRefreshReason,
  isHistorySyncKind,
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
    if (!isAgentLifecycleCode(input.code) || !isAgentLifecyclePhase(input.phase)) {
      return null;
    }
    const conversationId = isThinAgentConversationId(input.conversationId)
      ? input.conversationId
      : undefined;
    const requestId = boundedThinAgentIdentifier(input.requestId, 160);
    const clientInstanceId = isThinAgentClientInstanceId(input.clientInstanceId)
      ? input.clientInstanceId
      : undefined;
    const pluginBuildId = boundedThinAgentIdentifier(input.pluginBuildId, 160);
    const runId = boundedThinAgentIdentifier(input.runId, 160);
    const serverRunId = isThinAgentServerRunId(input.serverRunId)
      ? input.serverRunId
      : undefined;
    const toolName = isFirstPartyToolName(input.toolName)
      ? input.toolName
      : undefined;
    const toolCallId = boundedThinAgentIdentifier(input.toolCallId, 160);
    const status = Number.isInteger(input.status)
      && input.status! >= 100
      && input.status! <= 599
      ? input.status
      : undefined;
    const incidentId = isThinAgentIncidentId(input.incidentId)
      ? input.incidentId
      : undefined;
    const failureCode = isThinAgentFailureCode(input.failureCode)
      ? input.failureCode
      : undefined;
    const latencyTraceId = isThinAgentLatencyTraceId(input.latencyTraceId)
      ? input.latencyTraceId
      : undefined;
    const commandKind = isThinAgentCommandKind(input.commandKind)
      ? input.commandKind
      : undefined;
    const commandSegmentOrdinal = Number.isSafeInteger(input.commandSegmentOrdinal)
      && input.commandSegmentOrdinal! > 0
      ? input.commandSegmentOrdinal
      : undefined;
    const toolExecutionOrdinal = Number.isSafeInteger(input.toolExecutionOrdinal)
      && input.toolExecutionOrdinal! > 0
      && input.toolExecutionOrdinal! <= MAX_TOOL_EXECUTION_ORDINAL
      ? input.toolExecutionOrdinal
      : undefined;
    const historySyncKind = isHistorySyncKind(input.historySyncKind)
      ? input.historySyncKind
      : undefined;
    const historySyncOrdinal = Number.isSafeInteger(input.historySyncOrdinal)
      && input.historySyncOrdinal! > 0
      && input.historySyncOrdinal! <= MAX_HISTORY_SYNC_ORDINAL
      ? input.historySyncOrdinal
      : undefined;
    const responseDeliveryMode = input.responseDeliveryMode === "fetch_stream"
      || input.responseDeliveryMode === "request_url_buffered"
      ? input.responseDeliveryMode
      : undefined;
    const clientMonotonicOffsetMs = boundedThinAgentTiming(
      input.clientMonotonicOffsetMs,
    );
    const serverTimingAppMs = boundedThinAgentTiming(input.serverTimingAppMs);
    const serverTimingAuthMs = boundedThinAgentTiming(input.serverTimingAuthMs);
    const creditsRefreshReason = isCreditsRefreshReason(input.creditsRefreshReason)
      ? input.creditsRefreshReason
      : undefined;
    const creditsRefreshSequence = Number.isSafeInteger(input.creditsRefreshSequence)
      && input.creditsRefreshSequence! > 0
      ? input.creditsRefreshSequence
      : undefined;
    const creditsRefreshTransport = input.creditsRefreshTransport === "fetch"
      || input.creditsRefreshTransport === "request_url"
      ? input.creditsRefreshTransport
      : undefined;
    const creditsRefreshElapsedMs = boundedThinAgentTiming(input.creditsRefreshElapsedMs);
    const creditsRefreshServerAuthMs = boundedThinAgentTiming(
      input.creditsRefreshServerAuthMs,
    );
    const creditsRefreshServerRateLimitMs = boundedThinAgentTiming(
      input.creditsRefreshServerRateLimitMs,
    );
    const creditsRefreshServerBalanceStoreMs = boundedThinAgentTiming(
      input.creditsRefreshServerBalanceStoreMs,
    );
    const creditsRefreshServerTotalMs = boundedThinAgentTiming(
      input.creditsRefreshServerTotalMs,
    );
    const record: AgentLifecycleRecord = Object.freeze({
      sequence: ++this.sequence,
      timestamp: this.now(),
      code: input.code,
      phase: input.phase,
      ...(conversationId ? { conversationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(clientInstanceId ? { clientInstanceId } : {}),
      ...(pluginBuildId ? { pluginBuildId } : {}),
      ...(runId ? { runId } : {}),
      ...(serverRunId ? { serverRunId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status === undefined ? {} : { status }),
      ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
      ...(incidentId ? { incidentId } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(latencyTraceId ? { latencyTraceId } : {}),
      ...(commandKind ? { commandKind } : {}),
      ...(commandSegmentOrdinal === undefined ? {} : { commandSegmentOrdinal }),
      ...(toolExecutionOrdinal === undefined ? {} : { toolExecutionOrdinal }),
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
    try {
      this.persist(record);
    } catch {
      // Lifecycle diagnostics must never alter the product flow.
    }
    return record;
  }

}
