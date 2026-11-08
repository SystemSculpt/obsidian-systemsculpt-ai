import type { ChatMessage } from "../../types";
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
  terminalFailureMessage?: string;
  terminalRetryable: boolean;
  terminalServerRunId?: string;
}>;

type FailedTerminalReceiptCandidate = Readonly<{
  terminalOutcome?: unknown;
  terminalReportId?: unknown;
  terminalIncidentId?: unknown;
  terminalFailureCode?: unknown;
  terminalFailureMessage?: unknown;
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
  // Native agents have no hosted incident/report identity. Keep their error
  // text separate from the assistant's answer and from content-free diagnostics.
  if (/^local_(?:claude|codex)_(?:failed|usage_limit)$/u.test(candidate.terminalFailureCode)) {
    if (typeof candidate.terminalFailureMessage !== "string"
      || candidate.terminalReportId !== undefined
      || candidate.terminalIncidentId !== undefined
      || candidate.terminalServerRunId !== undefined) return null;
    return {
      terminalOutcome: "failed",
      terminalFailureCode: candidate.terminalFailureCode,
      terminalFailureMessage: candidate.terminalFailureMessage,
      terminalRetryable: candidate.terminalRetryable,
    };
  }
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


/** Carry local report receipts only onto still-present failed or unanswered turns. */
export function preserveContentFreeLocalFailedReceipts(
  incoming: readonly ChatMessage[],
  local: readonly ChatMessage[],
): ChatMessage[] {
  const receipts = new Map<string, NormalizedFailedTerminalReceipt>();
  let localTurnId: string | null = null;
  for (const message of local) {
    if (message.role === "user") {
      localTurnId = message.message_id;
      continue;
    }
    const receipt = normalizeFailedTerminalReceipt(message);
    if (localTurnId && receipt?.terminalReportId) receipts.set(localTurnId, receipt);
  }
  const next = [...incoming];
  for (const [turnId, receipt] of receipts) {
    const userIndex = next.findIndex((message) =>
      message.role === "user" && message.message_id === turnId);
    if (userIndex < 0) continue;
    let turnEnd = userIndex + 1;
    while (turnEnd < next.length && next[turnEnd].role === "assistant") turnEnd += 1;
    let failedIndex = -1;
    for (let index = turnEnd - 1; index > userIndex; index -= 1) {
      if (next[index].role === "assistant" && normalizeFailedTerminalReceipt(next[index])) {
        failedIndex = index;
        break;
      }
    }
    if (failedIndex >= 0) {
      next[failedIndex] = {
        ...next[failedIndex],
        terminalReportId: receipt.terminalReportId,
      };
      continue;
    }
    if (turnEnd > userIndex + 1) continue;
    next.splice(turnEnd, 0, {
      role: "assistant",
      message_id: `failure-${receipt.terminalReportId}`,
      content: "",
      terminalOutcome: "failed",
      terminalReportId: receipt.terminalReportId,
      terminalFailureCode: receipt.terminalFailureCode,
      terminalRetryable: receipt.terminalRetryable,
    });
  }
  return next;
}
