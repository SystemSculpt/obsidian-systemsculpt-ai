import {
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentServerRunId,
} from "../../utils/ThinAgentLifecycleSchema";

export type NormalizedFailedTerminalReceipt = Readonly<{
  terminalOutcome: "failed";
  terminalReportId?: string;
  terminalIncidentId?: string;
  terminalFailureCode: string;
  terminalRetryable: boolean;
  terminalServerRunId?: string;
}>;

type FailedTerminalReceiptCandidate = Readonly<{
  terminalOutcome?: unknown;
  terminalReportId?: unknown;
  terminalIncidentId?: unknown;
  terminalFailureCode?: unknown;
  terminalRetryable?: unknown;
  terminalServerRunId?: unknown;
}>;

const LOCAL_REPORT_ID = /^report_(?!0{32}$)[a-f0-9]{32}$/u;

export function isLocalReportId(value: unknown): value is string {
  return typeof value === "string" && LOCAL_REPORT_ID.test(value);
}

export function normalizeFailedTerminalReceipt(
  candidate: FailedTerminalReceiptCandidate,
): NormalizedFailedTerminalReceipt | null {
  if (
    candidate.terminalOutcome !== "failed"
    || !isThinAgentFailureCode(candidate.terminalFailureCode)
    || typeof candidate.terminalRetryable !== "boolean"
  ) return null;
  const terminalReportId = isLocalReportId(candidate.terminalReportId)
    ? candidate.terminalReportId
    : undefined;
  const terminalIncidentId = isThinAgentIncidentId(candidate.terminalIncidentId)
    ? candidate.terminalIncidentId
    : undefined;
  const terminalServerRunId = isThinAgentServerRunId(candidate.terminalServerRunId)
    ? candidate.terminalServerRunId
    : undefined;
  const hasAnyServerReceipt = candidate.terminalIncidentId !== undefined
    || candidate.terminalServerRunId !== undefined;
  const validServerReceipt = terminalIncidentId !== undefined
    && terminalServerRunId !== undefined;
  if (
    (!terminalReportId && !validServerReceipt)
    || (hasAnyServerReceipt && !validServerReceipt)
  ) return null;

  return {
    terminalOutcome: "failed",
    ...(terminalReportId ? { terminalReportId } : {}),
    ...(terminalIncidentId ? { terminalIncidentId } : {}),
    terminalFailureCode: candidate.terminalFailureCode,
    terminalRetryable: candidate.terminalRetryable,
    ...(terminalServerRunId ? { terminalServerRunId } : {}),
  };
}
