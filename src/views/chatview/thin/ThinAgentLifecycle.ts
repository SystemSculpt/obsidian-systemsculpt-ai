export const THIN_AGENT_LIFECYCLE_CODES = [
  "session_opened",
  "session_closed",
  "session_interrupted",
  "session_failed",
  "response_prepare_started",
  "response_prepare_completed",
  "response_prepare_failed",
  "context_prepare_started",
  "context_prepare_completed",
  "context_prepare_cancelled",
  "context_prepare_failed",
  "submission_admitted",
  "submission_queued",
  "queued_submission_removed",
  "queued_submission_promoted",
  "stop_requested",
  "stop_completed",
  "historical_resubmit_started",
  "historical_resubmit_committed",
  "historical_resubmit_failed",
  "conversation_reset",
  "run_started",
  "phase_submitted",
  "phase_thinking",
  "phase_working",
  "phase_waiting",
  "phase_retrying",
  "phase_settling",
  "phase_complete",
  "approval_presented",
  "approval_submitted_approved",
  "approval_submitted_denied",
  "approval_acknowledged_approved",
  "approval_acknowledged_denied",
  "local_tool_started",
  "local_tool_completed_succeeded",
  "local_tool_completed_failed",
  "tool_result_sent_succeeded",
  "tool_result_sent_failed",
  "response_resume_scheduled",
  "response_resume_started",
  "response_resume_completed",
  "response_resume_failed",
  "response_result_received_succeeded",
  "response_result_received_cancelled",
  "response_result_received_failed",
  "response_save_started",
  "response_save_completed",
  "response_save_failed",
  "history_sync_started",
  "history_sync_completed",
  "history_sync_failed",
  "run_finished_completed",
  "run_finished_cancelled",
  "run_finished_failed",
] as const;

export type ThinAgentLifecycleCode = typeof THIN_AGENT_LIFECYCLE_CODES[number];

export type ThinAgentLifecyclePhase =
  | "start"
  | "session"
  | "response"
  | "approval"
  | "tool_execution"
  | "mutation_journal"
  | "persistence"
  | "render"
  | "unknown";

export type ThinAgentLifecycleInput = Readonly<{
  code: ThinAgentLifecycleCode;
  phase: ThinAgentLifecyclePhase;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
}>;

export type ThinAgentLifecycleRecord = Readonly<{
  sequence: number;
  timestamp: number;
  code: ThinAgentLifecycleCode;
  phase: ThinAgentLifecyclePhase;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
}>;

export type ThinAgentLifecycleDiagnosticFrame = Readonly<{
  type: "systemsculpt.client_diagnostic.v1";
  payload: Readonly<{
    version: 1;
    severity: "info";
    code: ThinAgentLifecycleCode;
    phase: ThinAgentLifecyclePhase;
    run_id?: string;
    tool_name?: string;
    tool_call_id?: string;
    status?: number;
    retryable?: boolean;
    incident_id?: string;
  }>;
}>;

const CODE_SET = new Set<string>(THIN_AGENT_LIFECYCLE_CODES);
const INCIDENT_ID = /^incident_[a-f0-9]{32}$/u;
const PHASE_SET = new Set<string>([
  "start",
  "session",
  "response",
  "approval",
  "tool_execution",
  "mutation_journal",
  "persistence",
  "render",
  "unknown",
]);

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.slice(0, maximum);
  return /^[A-Za-z0-9_.:-]+$/.test(normalized) ? normalized : undefined;
}

/**
 * Strict, content-free client lifecycle recorder. It copies only explicitly
 * allowlisted scalar fields and never serializes caller-owned objects.
 */
export class ThinAgentLifecycle {
  private sequence = 0;

  constructor(
    private readonly persist: (record: ThinAgentLifecycleRecord) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public record(input: ThinAgentLifecycleInput): ThinAgentLifecycleRecord | null {
    if (!CODE_SET.has(input.code) || !PHASE_SET.has(input.phase)) return null;
    const runId = boundedIdentifier(input.runId, 160);
    const toolName = boundedIdentifier(input.toolName, 64);
    const toolCallId = boundedIdentifier(input.toolCallId, 160);
    const status = Number.isInteger(input.status)
      && input.status! >= 100
      && input.status! <= 599
      ? input.status
      : undefined;
    const incidentId = typeof input.incidentId === "string"
      && INCIDENT_ID.test(input.incidentId)
      ? input.incidentId
      : undefined;
    const record: ThinAgentLifecycleRecord = Object.freeze({
      sequence: ++this.sequence,
      timestamp: this.now(),
      code: input.code,
      phase: input.phase,
      ...(runId ? { runId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status === undefined ? {} : { status }),
      ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
      ...(incidentId ? { incidentId } : {}),
    });
    try {
      this.persist(record);
    } catch {
      // Lifecycle diagnostics must never alter the product flow.
    }
    return record;
  }

  public diagnosticFrame(
    record: ThinAgentLifecycleRecord,
  ): ThinAgentLifecycleDiagnosticFrame {
    return Object.freeze({
      type: "systemsculpt.client_diagnostic.v1",
      payload: Object.freeze({
        version: 1,
        severity: "info",
        code: record.code,
        phase: record.phase,
        ...(record.runId ? { run_id: record.runId } : {}),
        ...(record.toolName ? { tool_name: record.toolName } : {}),
        ...(record.toolCallId ? { tool_call_id: record.toolCallId } : {}),
        ...(record.status === undefined ? {} : { status: record.status }),
        ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
        ...(record.incidentId ? { incident_id: record.incidentId } : {}),
      }),
    });
  }
}
