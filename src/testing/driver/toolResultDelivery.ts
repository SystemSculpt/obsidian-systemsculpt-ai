import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import {
DriverActionError
} from "./actionCore";
import {
canonicalToolCallId,
type ToolContinuationObservation,
type ToolLifecycleCapture,
type ToolLifecycleRecord,
type ToolResultDeliveryEvidence,
type ToolSupportEvidence,
} from "./toolLifecycleState";

/** Content-free diagnostics and command acknowledgement evidence for captured tools. */

const TOOL_RESULT_ACK_CODES = new Set([
  "tool_result_acknowledged_succeeded",
  "tool_result_acknowledged_failed",
]);

const TOOL_RESULT_SENT_CODES = new Set([
  "tool_result_sent_succeeded",
  "tool_result_sent_failed",
]);

export function supportDiagnosticKey(event: SupportDiagnosticEvent): string {
  return JSON.stringify([
    event.timestamp,
    event.sequence ?? null,
    event.code,
    event.request_id ?? null,
    event.tool_execution_ordinal ?? null,
    event.command_segment_ordinal ?? null,
  ]);
}

function positiveSafeOrdinal(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
    ? value as number
    : null;
}

function appendDiagnosticOrdinal(
  values: readonly number[],
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): readonly number[] {
  const ordinal = positiveSafeOrdinal(value, maximum);
  return ordinal === null ? values : [...values, ordinal];
}

export function readSupportDiagnostics(
  reader: (() => readonly SupportDiagnosticEvent[]) | null,
): Readonly<{
  available: boolean;
  events: readonly SupportDiagnosticEvent[];
}> {
  if (!reader) return { available: false, events: [] };
  try {
    return { available: true, events: reader().slice(-500) };
  } catch {
    return { available: false, events: [] };
  }
}

export function currentRunSupportEvidence(capture: ToolLifecycleCapture): Readonly<ToolSupportEvidence> {
  const diagnosticRead = readSupportDiagnostics(capture.readSupportDiagnostics);
  const current = diagnosticRead.events
    .filter((event) => !capture.supportDiagnosticBaseline.has(supportDiagnosticKey(event)));
  const deliveries = new Map<string, ToolResultDeliveryEvidence>();
  for (const event of current) {
    const toolExecutionOrdinal = positiveSafeOrdinal(event.tool_execution_ordinal, 512);
    const relevant = event.code === "local_tool_started"
      || TOOL_RESULT_SENT_CODES.has(event.code)
      || TOOL_RESULT_ACK_CODES.has(event.code)
      || event.code === "command_segment_dispatch_started";
    if (!relevant || toolExecutionOrdinal === null) continue;
    const requestId = typeof event.request_id === "string" ? event.request_id : null;
    const key = JSON.stringify([requestId, toolExecutionOrdinal]);
    const evidence = deliveries.get(key) ?? {
      acknowledgementFailedCount: 0,
      acknowledgementFailedSequences: [],
      acknowledgementFailedSegmentOrdinals: [],
      acknowledgementSucceededCount: 0,
      acknowledgementSucceededSequences: [],
      acknowledgementSucceededSegmentOrdinals: [],
      invalidCommandKindCount: 0,
      localToolStartedCount: 0,
      localToolStartedSequences: [],
      requestId,
      sendAttemptCount: 0,
      sendAttemptSequences: [],
      sendAttemptSegmentOrdinals: [],
      sentFailedCount: 0,
      sentFailedSequences: [],
      sentFailedSegmentOrdinals: [],
      sentSucceededCount: 0,
      sentSucceededSequences: [],
      sentSucceededSegmentOrdinals: [],
      toolExecutionOrdinal,
    };
    if (event.code === "local_tool_started") {
      evidence.localToolStartedCount += 1;
      evidence.localToolStartedSequences = appendDiagnosticOrdinal(
        evidence.localToolStartedSequences,
        event.sequence,
      );
    } else if (
      (
        event.code === "command_segment_dispatch_started"
        || TOOL_RESULT_ACK_CODES.has(event.code)
      )
      && event.command_kind !== "client_tool_result"
    ) {
      evidence.invalidCommandKindCount += 1;
    }
    if (
      event.code === "command_segment_dispatch_started"
      && event.command_kind === "client_tool_result"
    ) {
      evidence.sendAttemptCount += 1;
      evidence.sendAttemptSequences = appendDiagnosticOrdinal(
        evidence.sendAttemptSequences,
        event.sequence,
      );
      evidence.sendAttemptSegmentOrdinals = appendDiagnosticOrdinal(
        evidence.sendAttemptSegmentOrdinals,
        event.command_segment_ordinal,
      );
    }
    if (event.code === "tool_result_sent_succeeded") {
      evidence.sentSucceededCount += 1;
      evidence.sentSucceededSequences = appendDiagnosticOrdinal(
        evidence.sentSucceededSequences,
        event.sequence,
      );
      evidence.sentSucceededSegmentOrdinals = appendDiagnosticOrdinal(
        evidence.sentSucceededSegmentOrdinals,
        event.command_segment_ordinal,
      );
    }
    if (event.code === "tool_result_sent_failed") {
      evidence.sentFailedCount += 1;
      evidence.sentFailedSequences = appendDiagnosticOrdinal(
        evidence.sentFailedSequences,
        event.sequence,
      );
      evidence.sentFailedSegmentOrdinals = appendDiagnosticOrdinal(
        evidence.sentFailedSegmentOrdinals,
        event.command_segment_ordinal,
      );
    }
    if (
      event.code === "tool_result_acknowledged_succeeded"
    ) {
      evidence.acknowledgementSucceededCount += 1;
      evidence.acknowledgementSucceededSequences = appendDiagnosticOrdinal(
        evidence.acknowledgementSucceededSequences,
        event.sequence,
      );
      evidence.acknowledgementSucceededSegmentOrdinals = appendDiagnosticOrdinal(
        evidence.acknowledgementSucceededSegmentOrdinals,
        event.command_segment_ordinal,
      );
    }
    if (
      event.code === "tool_result_acknowledged_failed"
    ) {
      evidence.acknowledgementFailedCount += 1;
      evidence.acknowledgementFailedSequences = appendDiagnosticOrdinal(
        evidence.acknowledgementFailedSequences,
        event.sequence,
      );
      evidence.acknowledgementFailedSegmentOrdinals = appendDiagnosticOrdinal(
        evidence.acknowledgementFailedSegmentOrdinals,
        event.command_segment_ordinal,
      );
    }
    deliveries.set(key, evidence);
  }
  const toolResultDeliveryEvidence = Object.freeze([...deliveries.values()]
    .map((evidence) => Object.freeze({
      ...evidence,
      acknowledgementFailedSequences: Object.freeze([...evidence.acknowledgementFailedSequences]),
      acknowledgementFailedSegmentOrdinals: Object.freeze([
        ...evidence.acknowledgementFailedSegmentOrdinals,
      ]),
      acknowledgementSucceededSequences: Object.freeze([
        ...evidence.acknowledgementSucceededSequences,
      ]),
      acknowledgementSucceededSegmentOrdinals: Object.freeze([
        ...evidence.acknowledgementSucceededSegmentOrdinals,
      ]),
      localToolStartedSequences: Object.freeze([...evidence.localToolStartedSequences]),
      sendAttemptSequences: Object.freeze([...evidence.sendAttemptSequences]),
      sendAttemptSegmentOrdinals: Object.freeze([...evidence.sendAttemptSegmentOrdinals]),
      sentFailedSequences: Object.freeze([...evidence.sentFailedSequences]),
      sentFailedSegmentOrdinals: Object.freeze([...evidence.sentFailedSegmentOrdinals]),
      sentSucceededSequences: Object.freeze([...evidence.sentSucceededSequences]),
      sentSucceededSegmentOrdinals: Object.freeze([...evidence.sentSucceededSegmentOrdinals]),
    })));
  return {
    localToolExecutionCount: current
      .filter((event) => event.code === "local_tool_started")
      .length,
    supportDiagnosticsAvailable: diagnosticRead.available,
    toolResultAcknowledgedCount: current
      .filter((event) => TOOL_RESULT_ACK_CODES.has(event.code))
      .length,
    toolResultDeliveryEvidence,
    toolResultSentCount: current
      .filter((event) => TOOL_RESULT_SENT_CODES.has(event.code))
      .length,
  };
}

export interface BoundToolResultDeliveryScope {
  requestId: string;
  startedEvidence: readonly ToolResultDeliveryEvidence[];
}

export function bindToolResultDeliveryScope(
  continuation: ToolSupportEvidence,
  records: readonly ToolLifecycleRecord[],
  expectedToolCallCount: number,
  expectedRequestId?: string | null,
  requireExpectedRequest = false,
): BoundToolResultDeliveryScope {
  const canonicalIds = records.map((record) => canonicalToolCallId(record.partKey));
  if (
    canonicalIds.some((callId) => callId === null)
    || new Set(canonicalIds).size !== canonicalIds.length
  ) {
    throw new DriverActionError(
      "Every-tool result delivery proof requires distinct canonical DOM call identity.",
    );
  }
  const observedRequestIds = [...new Set(continuation.toolResultDeliveryEvidence
    .filter((evidence) => evidence.localToolStartedCount > 0)
    .map((evidence) => evidence.requestId)
    .filter((requestId): requestId is string => requestId !== null))];
  const expectedRequestObserved = typeof expectedRequestId === "string"
    && observedRequestIds.includes(expectedRequestId);
  if (requireExpectedRequest && !expectedRequestObserved) {
    throw new DriverActionError(
      "Every-tool result delivery proof could not bind the current tool surface to one request.",
    );
  }
  const candidateRequestIds = expectedRequestObserved
    ? [expectedRequestId]
    : observedRequestIds.filter((requestId) => continuation.toolResultDeliveryEvidence
      .filter((evidence) =>
        evidence.requestId === requestId && evidence.localToolStartedCount > 0)
      .length === expectedToolCallCount);
  const requestId = candidateRequestIds
    .map((candidate) => ({
      requestId: candidate,
      latestSequence: Math.max(
        0,
        ...continuation.toolResultDeliveryEvidence
          .filter((evidence) => evidence.requestId === candidate)
          .flatMap((evidence) => evidence.localToolStartedSequences),
      ),
    }))
    .sort((left, right) => right.latestSequence - left.latestSequence)[0]?.requestId ?? null;
  if (!requestId) {
    throw new DriverActionError(
      "Every-tool result delivery proof could not bind the current tool surface to one request.",
    );
  }
  const requestEvidence = continuation.toolResultDeliveryEvidence
    .filter((evidence) => evidence.requestId === requestId);
  const startedEvidence = requestEvidence
    .filter((evidence) => evidence.localToolStartedCount > 0)
    .sort((left, right) => left.toolExecutionOrdinal - right.toolExecutionOrdinal);
  if (startedEvidence.length !== expectedToolCallCount) {
    throw new DriverActionError(
      "Current-turn tool calls do not match content-free result-delivery diagnostics: "
        + `${JSON.stringify({
          expectedToolCallCount,
          startedToolCallCount: startedEvidence.length,
        })}.`,
    );
  }
  const deliveryWithoutStart = requestEvidence.some((evidence) =>
    evidence.localToolStartedCount === 0
    && (
      evidence.localToolStartedCount > 0
      || evidence.sendAttemptCount > 0
      || evidence.sentSucceededCount + evidence.sentFailedCount > 0
      || evidence.acknowledgementSucceededCount + evidence.acknowledgementFailedCount > 0
    ));
  if (deliveryWithoutStart) {
    throw new DriverActionError(
      "Current-turn result-delivery diagnostics contain a tool without one observed local start.",
    );
  }
  return { requestId, startedEvidence };
}

export function resultDeliveryCommandProof(
  evidence: ToolResultDeliveryEvidence,
): Readonly<{
  acknowledgementCount: number;
  acknowledgementSequence: number | null;
  commandSegmentOrdinal: number | null;
  localStartSequence: number | null;
  valid: boolean;
}> {
  const acknowledgementCount = evidence.acknowledgementSucceededCount
    + evidence.acknowledgementFailedCount;
  const acknowledgementSequences = [
    ...evidence.acknowledgementSucceededSequences,
    ...evidence.acknowledgementFailedSequences,
  ];
  const acknowledgementSegments = [
    ...evidence.acknowledgementSucceededSegmentOrdinals,
    ...evidence.acknowledgementFailedSegmentOrdinals,
  ];
  const commandSegmentOrdinal = evidence.sendAttemptSegmentOrdinals.length === 1
    ? evidence.sendAttemptSegmentOrdinals[0] ?? null
    : null;
  const localStartSequence = evidence.localToolStartedSequences.length === 1
    ? evidence.localToolStartedSequences[0] ?? null
    : null;
  const sendAttemptSequence = evidence.sendAttemptSequences.length === 1
    ? evidence.sendAttemptSequences[0] ?? null
    : null;
  const acknowledgementSequence = acknowledgementSequences.length === 1
    ? acknowledgementSequences[0] ?? null
    : null;
  const valid = evidence.invalidCommandKindCount === 0
    && evidence.localToolStartedCount === 1
    && evidence.localToolStartedSequences.length === 1
    && evidence.sendAttemptCount === 1
    && evidence.sendAttemptSequences.length === 1
    && evidence.sendAttemptSegmentOrdinals.length === 1
    && acknowledgementCount === 1
    && acknowledgementSequences.length === 1
    && acknowledgementSegments.length === 1
    && commandSegmentOrdinal !== null
    && acknowledgementSegments[0] === commandSegmentOrdinal
    && localStartSequence !== null
    && sendAttemptSequence !== null
    && acknowledgementSequence !== null
    && localStartSequence < sendAttemptSequence
    && sendAttemptSequence < acknowledgementSequence;
  return {
    acknowledgementCount,
    acknowledgementSequence,
    commandSegmentOrdinal,
    localStartSequence,
    valid,
  };
}

function acknowledgedToolResultState(
  evidence: ToolResultDeliveryEvidence,
): "succeeded" | "failed" | null {
  if (
    evidence.acknowledgementSucceededCount === 1
    && evidence.acknowledgementFailedCount === 0
  ) return "succeeded";
  if (
    evidence.acknowledgementFailedCount === 1
    && evidence.acknowledgementSucceededCount === 0
  ) return "failed";
  return null;
}

export function proveEveryToolResultAcknowledgement(
  capture: ToolLifecycleCapture,
  continuation: ToolContinuationObservation,
  records: readonly ToolLifecycleRecord[],
  expectedToolCallCount: number,
): readonly Record<string, unknown>[] {
  if (
    !capture.supportDiagnosticBaselineAvailable
    || !continuation.supportDiagnosticsAvailable
  ) {
    throw new DriverActionError(
      "Every-tool result acknowledgement proof requires content-free support diagnostics.",
    );
  }
  const scope = bindToolResultDeliveryScope(
    continuation,
    records,
    expectedToolCallCount,
  );
  const proof = scope.startedEvidence.map((evidence) => {
    const sendCompletionCount = evidence.sentSucceededCount + evidence.sentFailedCount;
    const acknowledgementCount = evidence.acknowledgementSucceededCount
      + evidence.acknowledgementFailedCount;
    const commandProof = resultDeliveryCommandProof(evidence);
    return {
      acknowledgementCount,
      acknowledgedResultState: acknowledgedToolResultState(evidence),
      commandOrderingProven: commandProof.valid,
      localStartCount: evidence.localToolStartedCount,
      sendAttemptCount: evidence.sendAttemptCount,
      sendCompletionCountAtContinuation: sendCompletionCount,
      sendFailureCompletionCountAtContinuation: evidence.sentFailedCount,
      toolExecutionOrdinal: evidence.toolExecutionOrdinal,
    };
  });
  const invalid = proof.filter((entry) =>
    entry.localStartCount !== 1
    || entry.sendAttemptCount !== 1
    || entry.acknowledgementCount !== 1
    || entry.acknowledgedResultState === null
    || entry.commandOrderingProven !== true
    || entry.sendFailureCompletionCountAtContinuation !== 0);
  if (invalid.length > 0) {
    throw new DriverActionError(
      "Every current-turn client tool must have exactly one result-send attempt and one matching "
        + `acknowledgement, with no failed send completion before continuation: ${JSON.stringify(
          invalid,
        )}.`,
    );
  }
  return proof;
}

export function inspectEveryToolResultSendCompletion(
  capture: ToolLifecycleCapture,
  continuation: ToolContinuationObservation,
  records: readonly ToolLifecycleRecord[],
  expectedToolCallCount: number,
): readonly Record<string, unknown>[] | null {
  if (
    !capture.supportDiagnosticBaselineAvailable
    || !continuation.supportDiagnosticsAvailable
  ) {
    throw new DriverActionError(
      "Every-tool send-completion proof requires content-free support diagnostics.",
    );
  }
  const scope = bindToolResultDeliveryScope(
    continuation,
    records,
    expectedToolCallCount,
  );
  const current = currentRunSupportEvidence(capture);
  if (!current.supportDiagnosticsAvailable) {
    throw new DriverActionError(
      "Current support diagnostics are unavailable for send-completion proof.",
    );
  }
  const startedOrdinals = new Set(
    scope.startedEvidence.map((evidence) => evidence.toolExecutionOrdinal),
  );
  const requestEvidence = current.toolResultDeliveryEvidence
    .filter((evidence) => evidence.requestId === scope.requestId);
  if (requestEvidence.some((evidence) =>
    !startedOrdinals.has(evidence.toolExecutionOrdinal)
    && (
      evidence.sendAttemptCount > 0
      || evidence.sentSucceededCount + evidence.sentFailedCount > 0
      || evidence.acknowledgementSucceededCount + evidence.acknowledgementFailedCount > 0
    ))) {
    throw new DriverActionError(
      "Completed result-delivery diagnostics contain an unbound current-request tool.",
    );
  }

  let pending = false;
  const proof = scope.startedEvidence.map((atContinuation) => {
    const evidence = requestEvidence.find((candidate) =>
      candidate.toolExecutionOrdinal === atContinuation.toolExecutionOrdinal);
    if (!evidence) {
      pending = true;
      return {
        acknowledgementCount: 0,
        localStartCount: 0,
        resultState: null,
        sendAttemptCount: 0,
        sendCompletionCount: 0,
        toolExecutionOrdinal: atContinuation.toolExecutionOrdinal,
      };
    }
    const acknowledgementCount = evidence.acknowledgementSucceededCount
      + evidence.acknowledgementFailedCount;
    const sendCompletionCount = evidence.sentSucceededCount + evidence.sentFailedCount;
    const acknowledgedState = acknowledgedToolResultState(evidence);
    const sentState = evidence.sentSucceededCount === 1 && evidence.sentFailedCount === 0
      ? "succeeded"
      : evidence.sentFailedCount === 1 && evidence.sentSucceededCount === 0
        ? "failed"
        : null;
    if (
      evidence.localToolStartedCount > 1
      || evidence.sendAttemptCount > 1
      || acknowledgementCount > 1
      || sendCompletionCount > 1
      || (
        sendCompletionCount === 1
        && (acknowledgedState === null || sentState !== acknowledgedState)
      )
    ) {
      throw new DriverActionError(
        "A current-turn client tool has duplicate or mismatched send-completion evidence.",
      );
    }
    if (
      evidence.localToolStartedCount !== 1
      || evidence.sendAttemptCount !== 1
      || acknowledgementCount !== 1
      || sendCompletionCount !== 1
    ) pending = true;
    return {
      acknowledgementCount,
      localStartCount: evidence.localToolStartedCount,
      resultState: sentState,
      sendAttemptCount: evidence.sendAttemptCount,
      sendCompletionCount,
      toolExecutionOrdinal: evidence.toolExecutionOrdinal,
    };
  });
  return pending ? null : proof;
}
