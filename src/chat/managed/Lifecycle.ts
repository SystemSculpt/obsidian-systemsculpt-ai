import { projectLifecycleMetadata } from "../../utils/SupportDiagnosticEvent";
import type {
  AgentLifecycleCode,
  AgentLifecyclePhase,
  CreditsRefreshReason,
  HistorySyncKind,
  ToolDiagnosticFailureClass,
  ToolDiagnosticOutcome,
} from "../../utils/ThinAgentLifecycleSchema";
import type { AgentCommandKind } from "./Protocol";

export type {
  AgentLifecycleCode,
  AgentLifecyclePhase,
  CreditsRefreshReason,
  HistorySyncKind,
} from "../../utils/ThinAgentLifecycleSchema";

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

export type AgentLifecycleRecord = AgentLifecycleInput & Readonly<{
  sequence: number;
  timestamp: number;
  clientClockDomain?: "client_turn_monotonic";
  serverTimingClockDomain?: "server_response_headers_monotonic_duration";
  creditsRefreshClockDomain?: "client_refresh_monotonic_duration";
  creditsRefreshServerTimingClockDomain?: "server_response_headers_monotonic_duration";
}>;

/**
 * Strict, content-free client lifecycle recorder. The shared scalar inventory
 * snapshots and validates once; downstream consumers reuse that frozen record.
 */
export class AgentLifecycle {
  private sequence = 0;

  constructor(
    private readonly persist: (record: AgentLifecycleRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public record(input: AgentLifecycleInput): AgentLifecycleRecord | null {
    const projection = projectLifecycleMetadata(input, () => ({
      sequence: this.sequence + 1,
      timestamp: this.now(),
    }));
    if (!projection) return null;
    const record = projection.metadata as AgentLifecycleRecord;
    this.sequence = record.sequence;
    try {
      this.persist(record);
    } catch {
      // Lifecycle diagnostics must never alter the product flow.
    }
    return record;
  }
}
