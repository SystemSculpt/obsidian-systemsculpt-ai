import type { App } from "obsidian";

import { sha256HexFromBytesPortable } from "../../utils/sha256";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import { canonicalAgentToolInput } from "../../chat/managed/MutationJournal";
import { FILESYSTEM_LIMITS } from "../../tools/vault/constants";
import { chatContainer, isVisible, resolveTarget } from "./locators";
import {
  type ActionContext,
  activeChatView,
  DriverActionError,
  type DriverActionHandlers,
  sleep,
  throwIfActionCancelled,
} from "./actionCore";

/**
 * Tool lifecycle capture for the chat. A capture watches the live chat DOM
 * from the moment it begins; the assertions then prove each tool's states,
 * its result delivery and the continuation that follows it.
 */

function continuationContentMetadata(text: string): Readonly<{
  characters: number;
  sha256: string;
}> {
  const normalized = text.trim();
  return {
    characters: normalized.length,
    sha256: `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(normalized))}`,
  };
}

const TOOL_LIFECYCLE_STATES = [
  "input-streaming",
  "input-ready",
  "approval-required",
  "approved",
  "running",
  "succeeded",
  "partial",
  "failed",
  "denied",
  "cancelled",
  "outcome-unknown",
] as const;

type ToolLifecycleState = typeof TOOL_LIFECYCLE_STATES[number];

const TOOL_TERMINAL_ICONS: Partial<Record<ToolLifecycleState, string>> = {
  succeeded: "check",
  partial: "x",
  failed: "x",
  denied: "x",
  cancelled: "x",
  "outcome-unknown": "x",
};

interface ToolLifecycleTransition {
  mutationBatch: number;
  observedSequence: number;
  state: ToolLifecycleState;
  observedAtMs: number;
}

interface ToolVisualTransition {
  mutationBatch: number;
  observedAtMs: number;
  observedSequence: number;
  /** Terminal, icon-consistent, AND the whole surface is quiet. */
  settled: boolean;
  /**
   * Terminal and icon-consistent for this row alone. A later
   * sequential tool legitimately re-busies the shared tail status while it
   * executes, which must not retroactively unsettle an already-terminal row.
   */
  rowSettled: boolean;
}

interface ToolDomObservation {
  mutationBatch: number;
  observedAtMs: number;
  observedSequence: number;
}

interface ToolSupportEvidence {
  localToolExecutionCount: number;
  supportDiagnosticsAvailable: boolean;
  toolResultAcknowledgedCount: number;
  toolResultDeliveryEvidence: readonly ToolResultDeliveryEvidence[];
  toolResultSentCount: number;
}

interface ToolContinuationObservation extends ToolDomObservation, ToolSupportEvidence {
  partKey: string;
  turnId: string | null;
}

interface ToolRegistrationObservation extends ToolDomObservation, ToolSupportEvidence {}

interface ToolResponseErrorObservation extends ToolDomObservation {
  turnId: string | null;
}

type ToolContinuationEntry = [HTMLElement, ToolContinuationObservation];

interface ToolResultDeliveryEvidence {
  acknowledgementFailedCount: number;
  acknowledgementFailedSequences: readonly number[];
  acknowledgementFailedSegmentOrdinals: readonly number[];
  acknowledgementSucceededCount: number;
  acknowledgementSucceededSequences: readonly number[];
  acknowledgementSucceededSegmentOrdinals: readonly number[];
  localToolStartedCount: number;
  localToolStartedSequences: readonly number[];
  invalidCommandKindCount: number;
  requestId: string | null;
  sendAttemptCount: number;
  sendAttemptSequences: readonly number[];
  sendAttemptSegmentOrdinals: readonly number[];
  sentFailedCount: number;
  sentFailedSequences: readonly number[];
  sentFailedSegmentOrdinals: readonly number[];
  sentSucceededCount: number;
  sentSucceededSequences: readonly number[];
  sentSucceededSegmentOrdinals: readonly number[];
  toolExecutionOrdinal: number;
}

interface ToolSurfaceTransition extends ToolDomObservation {
  terminalToolCallCount: number;
  toolCallCount: number;
  toolRowCount: number;
}

interface ToolLifecycleRecord {
  callCount: number;
  callCountTransitions: Array<ToolDomObservation & { callCount: number }>;
  canonicalInput: string | null;
  element: HTMLElement;
  identityConflict: boolean;
  label: string | null;
  partKey: string;
  registeredAt: ToolRegistrationObservation | null;
  toolName: string | null;
  transitions: ToolLifecycleTransition[];
  turnId: string | null;
  visualTransitions: ToolVisualTransition[];
}

interface ToolLifecycleCapture {
  container: HTMLElement;
  continuationKeysByElement: Map<HTMLElement, string>;
  continuationObservations: Map<HTMLElement, ToolContinuationObservation>;
  ignoredPartKeys: Set<string>;
  ignoredResponseErrorElements: Set<HTMLElement>;
  ignoredToolElements: Set<HTMLElement>;
  mutationBatch: number;
  mutationSequence: number;
  nextRenderedContinuationKey: number;
  nextRenderedPartKey: number;
  nextRenderedTurnId: number;
  observer: MutationObserver;
  partKeysByElement: Map<HTMLElement, string>;
  records: Map<string, ToolLifecycleRecord>;
  renderedTurnIds: Map<HTMLElement, string>;
  readSupportDiagnostics: (() => readonly SupportDiagnosticEvent[]) | null;
  readToolIdentities: (() => ReadonlyMap<string, Readonly<{
    canonicalInput: string;
    toolName: string;
  }>> | null) | null;
  responseErrorObservations: Map<HTMLElement, ToolResponseErrorObservation>;
  startedAtMs: number;
  supportDiagnosticBaselineAvailable: boolean;
  supportDiagnosticBaseline: Set<string>;
  surfaceTransitions: Map<string, ToolSurfaceTransition[]>;
}

export const toolLifecycleCaptures = new WeakMap<App, ToolLifecycleCapture>();

function toolLifecycleState(element: HTMLElement): ToolLifecycleState | null {
  return TOOL_LIFECYCLE_STATES.find((state) => element.classList.contains(`is-${state}`)) ?? null;
}

function toolCallCount(element: HTMLElement): number {
  const parsed = Number(element.dataset.toolCount ?? "1");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function exactTerminalRowCallCount(element: HTMLElement): number | null {
  const rawCount = element.getAttribute("data-tool-count");
  const grouped = element.classList.contains("is-grouped");
  if (rawCount === null) return grouped ? null : 1;
  if (!grouped || !/^[1-9]\d*$/u.test(rawCount)) return null;
  const count = Number(rawCount);
  return Number.isSafeInteger(count) && count > 1 && String(count) === rawCount
    ? count
    : null;
}

export function toolRowSnapshot(element: HTMLElement): Record<string, unknown> {
  const stateIcon = element.querySelector<HTMLElement>(".systemsculpt-agent-tool-state-icon");
  return {
    partKey: element.dataset.partKey ?? null,
    callCount: toolCallCount(element),
    label: element.querySelector(".systemsculpt-agent-tool-label")?.textContent?.trim() ?? null,
    state: toolLifecycleState(element),
    stateIcon: stateIcon?.dataset.iconState ?? null,
  };
}

function ownerWindowNow(container: HTMLElement): number {
  return container.ownerDocument.defaultView?.performance.now() ?? performance.now();
}

const TOOL_RESULT_ACK_CODES = new Set([
  "tool_result_acknowledged_succeeded",
  "tool_result_acknowledged_failed",
]);

const TOOL_RESULT_SENT_CODES = new Set([
  "tool_result_sent_succeeded",
  "tool_result_sent_failed",
]);

function supportDiagnosticKey(event: SupportDiagnosticEvent): string {
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

function readSupportDiagnostics(
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

function currentRunSupportEvidence(capture: ToolLifecycleCapture): Readonly<ToolSupportEvidence> {
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

function capturedContinuationEntries(
  capture: ToolLifecycleCapture,
): ToolContinuationEntry[] {
  const logical = new Map<string, ToolContinuationEntry>();
  const observed = [...capture.continuationObservations]
    .sort((left, right) => left[1].observedSequence - right[1].observedSequence);
  for (const entry of observed) {
    const [element, observation] = entry;
    const key = JSON.stringify([observation.turnId, observation.partKey]);
    const existing = logical.get(key);
    if (!existing) {
      logical.set(key, entry);
      continue;
    }
    const preferredElement = element.isConnected && capture.container.contains(element)
      ? element
      : existing[0];
    logical.set(key, [preferredElement, existing[1]]);
  }
  const entries = [...logical.values()];
  const consumed = new Set<ToolContinuationEntry>();
  const rebound: ToolContinuationEntry[] = [];
  for (const historical of entries) {
    const [historicalElement, historicalObservation] = historical;
    if (
      !historicalElement.isConnected
      || !capture.container.contains(historicalElement)
      || !historicalObservation.partKey.startsWith("rendered-continuation:")
    ) continue;
    const historicalText = (historicalElement.textContent ?? "").trim();
    const live = entries.find((candidate) => {
      if (candidate === historical || consumed.has(candidate)) return false;
      const [candidateElement, candidateObservation] = candidate;
      return !candidateElement.isConnected
        && candidateObservation.turnId === historicalObservation.turnId
        && !candidateObservation.partKey.startsWith("rendered-continuation:")
        && (candidateElement.textContent ?? "").trim() === historicalText;
    });
    if (!live) continue;
    consumed.add(live);
    consumed.add(historical);
    rebound.push([historicalElement, live[1]]);
  }
  // Reopening a saved chat re-renders every settled turn into fresh elements,
  // leaving the prior render generation behind as disconnected twins. A
  // disconnected rendered part whose turn currently shows exactly the same
  // text in a connected element is that superseded generation, not extra
  // content — drop it. Genuine duplication keeps both copies connected and a
  // genuine content change breaks the exact-text match, so both still fail.
  const connectedTexts = new Map<string | null, Set<string>>();
  for (const [element, observation] of [
    ...entries.filter((entry) => !consumed.has(entry)),
    ...rebound,
  ]) {
    if (!element.isConnected || !capture.container.contains(element)) continue;
    const texts = connectedTexts.get(observation.turnId) ?? new Set<string>();
    texts.add((element.textContent ?? "").trim());
    connectedTexts.set(observation.turnId, texts);
  }
  for (const entry of entries) {
    if (consumed.has(entry)) continue;
    const [element, observation] = entry;
    if (element.isConnected && capture.container.contains(element)) continue;
    if (!observation.partKey.startsWith("rendered-continuation:")) continue;
    if (
      connectedTexts.get(observation.turnId)?.has((element.textContent ?? "").trim())
    ) consumed.add(entry);
  }
  return [...entries.filter((entry) => !consumed.has(entry)), ...rebound]
    .sort((left, right) => left[1].observedSequence - right[1].observedSequence);
}

function matchingContinuationEntries(
  capture: ToolLifecycleCapture,
  expectedText: string,
  textMode: "contains" | "equals",
): ToolContinuationEntry[] {
  return capturedContinuationEntries(capture).filter(([textPart, observation]) => {
    if (!observation.turnId) return false;
    const text = (textPart.textContent ?? "").trim();
    return textMode === "equals" ? text === expectedText : text.includes(expectedText);
  });
}

function continuationObservationMetadata(
  entry: ToolContinuationEntry,
): Readonly<{
  characters: number;
  observedSequence: number;
  sha256: string;
}> {
  const [textPart, observation] = entry;
  return {
    ...continuationContentMetadata(textPart.textContent ?? ""),
    observedSequence: observation.observedSequence,
  };
}

function continuationTimeoutError(
  capture: ToolLifecycleCapture,
  expectedText: string,
  timeoutMs: number,
  assertion: string,
): DriverActionError {
  const observed = capturedContinuationEntries(capture);
  const expected = continuationContentMetadata(expectedText);
  if (observed.length === 0) {
    return new DriverActionError(
      `${assertion}: continuation absent within ${String(timeoutMs)}ms; `
        + `expected=${JSON.stringify(expected)}.`,
    );
  }
  return new DriverActionError(
    `${assertion}: continuation present but mismatched within ${String(timeoutMs)}ms; `
      + `expected=${JSON.stringify(expected)}; actual=${JSON.stringify(
        observed.slice(-3).map((entry) => {
          const [element, observation] = entry;
          return {
            ...continuationObservationMetadata(entry),
            connected: element.isConnected && capture.container.contains(element),
            partKey: observation.partKey,
            turnId: observation.turnId,
            sameTurnRecords: [...capture.records.values()]
              .filter((record) => record.turnId === observation.turnId).length,
          };
        }),
      )}.`,
  );
}

interface BoundToolResultDeliveryScope {
  requestId: string;
  startedEvidence: readonly ToolResultDeliveryEvidence[];
}

function orderedToolLifecycleRecords(
  records: readonly ToolLifecycleRecord[],
): ToolLifecycleRecord[] {
  return [...records].sort((left, right) => {
    const leftSequence = left.registeredAt?.observedSequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right.registeredAt?.observedSequence ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence;
  });
}

function firstCapturedToolCallCount(record: ToolLifecycleRecord): number {
  return record.callCountTransitions[0]?.callCount ?? record.callCount;
}

function bindToolResultDeliveryScope(
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

function resultDeliveryCommandProof(
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

function proveEveryToolResultAcknowledgement(
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

function inspectEveryToolResultSendCompletion(
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

function developmentAgentPendingCounts(ctx: ActionContext): Readonly<{
  pendingApprovalCount: number;
  pendingClientToolCount: number;
}> {
  const agent = activeChatView(ctx)?.agent;
  const deliveries = agent?.pendingDeliveries;
  const approvals = agent?.pendingApprovalDeliveries;
  if (!agent || !deliveries || !approvals) {
    throw new DriverActionError(
      "The live ChatSession pending-tool projection is unavailable.",
    );
  }
  const pendingClientToolIds = new Set<string>(deliveries.keys());
  for (const callId of agent.active?.executingToolIds ?? []) {
    pendingClientToolIds.add(callId);
  }
  for (const callId of agent.active?.toolTasks?.keys() ?? []) {
    pendingClientToolIds.add(callId);
  }
  return {
    pendingApprovalCount: approvals.size,
    pendingClientToolCount: pendingClientToolIds.size,
  };
}

function nextToolObservation(
  capture: ToolLifecycleCapture,
  mutationBatch = capture.mutationBatch + 1,
): ToolDomObservation {
  capture.mutationBatch = Math.max(capture.mutationBatch, mutationBatch);
  capture.mutationSequence += 1;
  return {
    mutationBatch,
    observedAtMs: Math.max(0, ownerWindowNow(capture.container) - capture.startedAtMs),
    observedSequence: capture.mutationSequence,
  };
}

function capturedTurnId(
  capture: ToolLifecycleCapture,
  assistantTurn: HTMLElement | null,
): string | null {
  if (!assistantTurn) return null;
  const liveTurnId = assistantTurn.dataset.turnId;
  if (liveTurnId) return liveTurnId;
  const existing = capture.renderedTurnIds.get(assistantTurn);
  if (existing) return existing;
  capture.nextRenderedTurnId += 1;
  const renderedTurnId = `rendered-turn:${String(capture.nextRenderedTurnId)}`;
  capture.renderedTurnIds.set(assistantTurn, renderedTurnId);
  return renderedTurnId;
}

function capturedPartKey(capture: ToolLifecycleCapture, element: HTMLElement): string {
  const existing = capture.partKeysByElement.get(element);
  if (existing) return existing;
  const renderedPartKey = element.dataset.partKey;
  if (renderedPartKey) {
    capture.partKeysByElement.set(element, renderedPartKey);
    return renderedPartKey;
  }
  capture.nextRenderedPartKey += 1;
  const syntheticPartKey = `rendered-tool:${String(capture.nextRenderedPartKey)}`;
  capture.partKeysByElement.set(element, syntheticPartKey);
  return syntheticPartKey;
}

export function canonicalToolCallId(partKey: string): string | null {
  if (!partKey.startsWith("tool:")) return null;
  const callId = partKey.slice("tool:".length);
  return callId.length > 0 ? callId : null;
}

function refreshCapturedToolIdentity(
  capture: ToolLifecycleCapture,
  record: ToolLifecycleRecord,
): void {
  const toolCallId = canonicalToolCallId(record.partKey);
  const identity = toolCallId ? capture.readToolIdentities?.()?.get(toolCallId) : null;
  if (!identity) return;
  if (record.toolName === null && record.canonicalInput === null) {
    record.toolName = identity.toolName;
    record.canonicalInput = identity.canonicalInput;
    return;
  }
  if (
    record.toolName !== identity.toolName
    || record.canonicalInput !== identity.canonicalInput
  ) record.identityConflict = true;
}

function registrationObservation(
  capture: ToolLifecycleCapture,
  observation: ToolDomObservation,
  supportEvidence = currentRunSupportEvidence(capture),
): ToolRegistrationObservation {
  return { ...observation, ...supportEvidence };
}

function registerCapturedTools(capture: ToolLifecycleCapture): void {
  for (const element of capture.container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-tool",
  )) {
    if (capture.ignoredToolElements.has(element)) continue;
    const renderedPartKey = element.dataset.partKey;
    if (renderedPartKey && capture.ignoredPartKeys.has(renderedPartKey)) continue;
    const partKey = capturedPartKey(capture, element);
    const assistantTurn = element.closest<HTMLElement>(
      ".systemsculpt-agent-turn.is-assistant",
    );
    const existing = capture.records.get(partKey);
    if (existing) {
      const existingIsCurrent = existing.element.isConnected
        && capture.container.contains(existing.element);
      if (!existingIsCurrent) {
        existing.element = element;
        existing.label = element.querySelector(".systemsculpt-agent-tool-label")
          ?.textContent?.trim() ?? existing.label;
        const replacementTurnId = capturedTurnId(capture, assistantTurn);
        if (!existing.turnId || existing.turnId.startsWith("rendered-turn:")) {
          existing.turnId = replacementTurnId;
        }
      }
      refreshCapturedToolIdentity(capture, existing);
      continue;
    }
    const record: ToolLifecycleRecord = {
      callCount: toolCallCount(element),
      callCountTransitions: [],
      canonicalInput: null,
      element,
      identityConflict: false,
      partKey,
      label: element.querySelector(".systemsculpt-agent-tool-label")?.textContent?.trim() ?? null,
      registeredAt: null,
      toolName: null,
      transitions: [],
      turnId: capturedTurnId(capture, assistantTurn),
      visualTransitions: [],
    };
    refreshCapturedToolIdentity(capture, record);
    capture.records.set(partKey, record);
  }
}

function capturedToolRowSnapshot(record: ToolLifecycleRecord): Record<string, unknown> {
  return {
    ...toolRowSnapshot(record.element),
    partKey: record.partKey,
  };
}

function toolRowIsVisuallyTerminal(element: HTMLElement): boolean {
  const snapshot = toolRowSnapshot(element);
  const state = snapshot.state as ToolLifecycleState | null;
  return state !== null
    && TOOL_TERMINAL_ICONS[state] === snapshot.stateIcon;
}

function toolIsVisuallySettled(element: HTMLElement, container: HTMLElement): boolean {
  const agentStatus = container.querySelector(".systemsculpt-agent-tail-status")
    ?.getAttribute("data-status") ?? null;
  return toolRowIsVisuallyTerminal(element) && agentStatus !== "Working in vault";
}

function mutationElement(node: Node): Element | null {
  return node.instanceOf(Element) ? node : node.parentElement;
}

function mutationAssistantTurn(
  mutation: MutationRecord,
  candidate: HTMLElement,
): HTMLElement | null {
  const candidateTurn = candidate.closest<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant",
  );
  if (candidateTurn) return candidateTurn;
  const target = mutationElement(mutation.target);
  if (target?.matches(".systemsculpt-agent-turn.is-assistant")) {
    return target as HTMLElement;
  }
  return target?.closest<HTMLElement>(".systemsculpt-agent-turn.is-assistant") ?? null;
}

function mutationTouchesTool(mutation: MutationRecord, tool: HTMLElement): boolean {
  const target = mutationElement(mutation.target);
  if (target && (target === tool || tool.contains(target))) return true;
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
    const element = mutationElement(node);
    return element !== null
      && (element === tool || element.contains(tool) || tool.contains(element));
  });
}

function mutationTouchesTailStatus(mutation: MutationRecord): boolean {
  const candidates = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes];
  return candidates.some((node) => {
    const element = mutationElement(node);
    return element?.matches(".systemsculpt-agent-tail-status") === true
      || (element?.closest(".systemsculpt-agent-tail-status") ?? null) !== null
      || (element?.querySelector(".systemsculpt-agent-tail-status") ?? null) !== null;
  });
}

interface ObservedMutation {
  mutation: MutationRecord;
  observation: ToolDomObservation;
}

interface SpecificMutationObservation {
  observation: ToolDomObservation;
  specificity: number;
  turnId?: string | null;
}

function preferSpecificMutation(
  current: SpecificMutationObservation | undefined,
  candidate: SpecificMutationObservation,
): SpecificMutationObservation {
  let preferred: SpecificMutationObservation;
  if (!current || candidate.specificity > current.specificity) preferred = candidate;
  else if (
    candidate.specificity === current.specificity
    && candidate.observation.observedSequence < current.observation.observedSequence
  ) preferred = candidate;
  else preferred = current;
  if (preferred.turnId == null) {
    const retainedTurnId = current?.turnId ?? candidate.turnId;
    if (retainedTurnId != null) return { ...preferred, turnId: retainedTurnId };
  }
  return preferred;
}

function addedAncestorSpecificity(node: Node, descendant: HTMLElement): number {
  if (!node.instanceOf(Element) || !node.contains(descendant)) return 0;
  let distance = 0;
  let cursor: Node | null = descendant;
  while (cursor && cursor !== node) {
    cursor = cursor.parentNode;
    distance += 1;
  }
  return cursor === node ? Math.max(1, 100 - distance) : 0;
}

function toolIntroductionSpecificity(
  mutation: MutationRecord,
  tool: HTMLElement,
): number {
  let specificity = 0;
  for (const node of mutation.addedNodes) {
    if (node === tool) return 1000;
    specificity = Math.max(specificity, addedAncestorSpecificity(node, tool));
  }
  const target = mutationElement(mutation.target);
  if (target === tool) specificity = Math.max(specificity, 50);
  else if (target && tool.contains(target)) specificity = Math.max(specificity, 40);
  return specificity;
}

function continuationMutationSpecificity(
  mutation: MutationRecord,
  textPart: HTMLElement,
): number {
  const target = mutationElement(mutation.target);
  if (
    mutation.type === "characterData"
    && target
    && (target === textPart || textPart.contains(target))
  ) return mutation.oldValue?.trim().length === 0 ? 2000 : 500;
  let specificity = 0;
  for (const node of mutation.addedNodes) {
    if (node === textPart) specificity = Math.max(specificity, 1000);
    else if (textPart.contains(node)) {
      const firstContentNode = textPart.firstChild;
      specificity = Math.max(specificity, node === firstContentNode ? 2000 : 500);
    } else {
      specificity = Math.max(specificity, addedAncestorSpecificity(node, textPart));
    }
  }
  if (target === textPart) specificity = Math.max(specificity, 50);
  else if (target && textPart.contains(target)) specificity = Math.max(specificity, 40);
  return specificity;
}

function continuationCandidatesForMutation(mutation: MutationRecord): Set<HTMLElement> {
  const candidates = new Set<HTMLElement>();
  const collect = (node: Node): void => {
    const element = mutationElement(node);
    const closest = element?.closest<HTMLElement>(".systemsculpt-agent-part.is-text");
    if (closest) candidates.add(closest);
    if (element?.matches(".systemsculpt-agent-part.is-text")) {
      candidates.add(element as HTMLElement);
    }
    for (const textPart of element?.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-part.is-text",
    ) ?? []) {
      candidates.add(textPart);
    }
  };
  collect(mutation.target);
  for (const node of mutation.addedNodes) collect(node);
  return candidates;
}

function capturedContinuationPartKey(
  capture: ToolLifecycleCapture,
  textPart: HTMLElement,
): string {
  const existing = capture.continuationKeysByElement.get(textPart);
  if (existing) return existing;
  const renderedPartKey = textPart.dataset.partKey;
  if (renderedPartKey) {
    capture.continuationKeysByElement.set(textPart, renderedPartKey);
    return renderedPartKey;
  }
  capture.nextRenderedContinuationKey += 1;
  const synthetic = `rendered-continuation:${String(capture.nextRenderedContinuationKey)}`;
  capture.continuationKeysByElement.set(textPart, synthetic);
  return synthetic;
}

function recordContinuationMutations(
  capture: ToolLifecycleCapture,
  mutations: readonly ObservedMutation[],
): void {
  const candidates = new Map<HTMLElement, SpecificMutationObservation>();
  for (const { mutation, observation } of mutations) {
    for (const textPart of continuationCandidatesForMutation(mutation)) {
      if (
        capture.continuationObservations.has(textPart)
        || (textPart.textContent ?? "").trim().length === 0
      ) continue;
      const specificity = continuationMutationSpecificity(mutation, textPart);
      if (specificity === 0) continue;
      candidates.set(textPart, preferSpecificMutation(candidates.get(textPart), {
        observation,
        specificity,
        turnId: capturedTurnId(capture, mutationAssistantTurn(mutation, textPart)),
      }));
    }
  }
  for (const [textPart, candidate] of candidates) {
    const assistantTurn = textPart.closest<HTMLElement>(
      ".systemsculpt-agent-turn.is-assistant",
    );
    const supportEvidence = currentRunSupportEvidence(capture);
    capture.continuationObservations.set(textPart, {
      ...candidate.observation,
      ...supportEvidence,
      partKey: capturedContinuationPartKey(capture, textPart),
      turnId: candidate.turnId ?? capturedTurnId(capture, assistantTurn),
    });
  }
}

function responseErrorCandidatesForMutation(mutation: MutationRecord): Set<HTMLElement> {
  const candidates = new Set<HTMLElement>();
  const collect = (node: Node): void => {
    const element = mutationElement(node);
    const closest = element?.closest<HTMLElement>(
      ".systemsculpt-agent-part.is-error",
    );
    if (closest) candidates.add(closest);
    for (const errorPart of element?.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-part.is-error",
    ) ?? []) {
      candidates.add(errorPart);
    }
  };
  collect(mutation.target);
  for (const node of mutation.addedNodes) collect(node);
  return candidates;
}

function recordResponseErrorMutations(
  capture: ToolLifecycleCapture,
  mutations: readonly ObservedMutation[],
): void {
  const candidates = new Map<HTMLElement, SpecificMutationObservation>();
  for (const { mutation, observation } of mutations) {
    for (const errorPart of responseErrorCandidatesForMutation(mutation)) {
      if (
        capture.ignoredResponseErrorElements.has(errorPart)
        || capture.responseErrorObservations.has(errorPart)
      ) continue;
      const specificity = toolIntroductionSpecificity(mutation, errorPart);
      if (specificity === 0) continue;
      candidates.set(errorPart, preferSpecificMutation(candidates.get(errorPart), {
        observation,
        specificity,
        turnId: capturedTurnId(capture, mutationAssistantTurn(mutation, errorPart)),
      }));
    }
  }
  for (const [errorPart, candidate] of candidates) {
    const assistantTurn = errorPart.closest<HTMLElement>(
      ".systemsculpt-agent-turn.is-assistant",
    );
    capture.responseErrorObservations.set(errorPart, {
      ...candidate.observation,
      turnId: candidate.turnId ?? capturedTurnId(capture, assistantTurn),
    });
  }
}

function registerCurrentResponseErrors(
  capture: ToolLifecycleCapture,
  fallback?: ToolDomObservation,
): void {
  for (const errorPart of capture.container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-error",
  )) {
    if (
      capture.ignoredResponseErrorElements.has(errorPart)
      || capture.responseErrorObservations.has(errorPart)
    ) continue;
    const assistantTurn = errorPart.closest<HTMLElement>(
      ".systemsculpt-agent-turn.is-assistant",
    );
    capture.responseErrorObservations.set(errorPart, {
      ...(fallback ?? nextToolObservation(capture)),
      turnId: capturedTurnId(capture, assistantTurn),
    });
  }
}

function latestToolRecordObservation(record: ToolLifecycleRecord): ToolDomObservation | null {
  const observations: ToolDomObservation[] = [
    ...record.transitions,
    ...record.visualTransitions,
    ...record.callCountTransitions,
  ];
  return observations.reduce<ToolDomObservation | null>((latest, observation) =>
    !latest || observation.observedSequence > latest.observedSequence ? observation : latest, null);
}

function firstToolRecordObservation(record: ToolLifecycleRecord): ToolDomObservation | null {
  const observations: ToolDomObservation[] = [
    ...(record.registeredAt ? [record.registeredAt] : []),
    ...record.transitions,
    ...record.visualTransitions,
    ...record.callCountTransitions,
  ];
  return observations.reduce<ToolDomObservation | null>((first, observation) =>
    !first || observation.observedSequence < first.observedSequence ? observation : first, null);
}

function recordToolSurfaceTransitions(
  capture: ToolLifecycleCapture,
  observations: Map<string, ToolDomObservation>,
  fallback?: ToolDomObservation,
): void {
  const turnIds = new Set<string>(capture.surfaceTransitions.keys());
  for (const record of capture.records.values()) {
    if (record.turnId) turnIds.add(record.turnId);
  }
  for (const turnId of turnIds) {
    const turnRecords = [...capture.records.values()].filter((record) =>
      record.turnId === turnId);
    const connected = turnRecords.filter((record) =>
      record.element.isConnected && capture.container.contains(record.element));
    const toolCallCount = connected.reduce((sum, record) => sum + record.callCount, 0);
    const terminalToolCallCount = connected
      .filter((record) => toolIsVisuallySettled(record.element, capture.container))
      .reduce((sum, record) => sum + record.callCount, 0);
    const transitions = capture.surfaceTransitions.get(turnId) ?? [];
    const previous = transitions[transitions.length - 1];
    if (
      previous?.toolCallCount === toolCallCount
      && previous.terminalToolCallCount === terminalToolCallCount
      && previous.toolRowCount === connected.length
    ) {
      continue;
    }
    const candidates = turnRecords
      .map((record) => observations.get(record.partKey))
      .filter((value): value is ToolDomObservation => value !== undefined);
    if (candidates.length === 0) {
      for (const record of connected) {
        const latest = latestToolRecordObservation(record);
        if (latest) candidates.push(latest);
      }
    }
    if (candidates.length === 0 && fallback) candidates.push(fallback);
    let observation = candidates.reduce<ToolDomObservation | null>((latest, candidate) =>
      !latest || candidate.observedSequence > latest.observedSequence ? candidate : latest, null);
    if (!observation || observation.observedSequence <= (previous?.observedSequence ?? 0)) {
      observation = nextToolObservation(capture);
    }
    transitions.push({
      ...observation,
      terminalToolCallCount,
      toolCallCount,
      toolRowCount: connected.length,
    });
    capture.surfaceTransitions.set(turnId, transitions);
  }
}

function scanToolLifecycleCapture(
  capture: ToolLifecycleCapture,
  observations = new Map<string, ToolDomObservation>(),
  fallback?: ToolDomObservation,
): void {
  registerCapturedTools(capture);
  registerCurrentResponseErrors(capture, fallback);
  let sharedFallback = fallback;
  for (const record of capture.records.values()) {
    const state = toolLifecycleState(record.element);
    const callCount = toolCallCount(record.element);
    const settled = toolIsVisuallySettled(record.element, capture.container);
    const rowSettled = toolRowIsVisuallyTerminal(record.element);
    const stateChanged = state !== null
      && record.transitions[record.transitions.length - 1]?.state !== state;
    const lastVisual = record.visualTransitions[record.visualTransitions.length - 1];
    const visualChanged = lastVisual?.settled !== settled
      || lastVisual?.rowSettled !== rowSettled;
    const countChanged = record.callCountTransitions[record.callCountTransitions.length - 1]
      ?.callCount !== callCount;
    if (!stateChanged && !visualChanged && !countChanged && record.registeredAt) continue;
    let observation = observations.get(record.partKey) ?? sharedFallback;
    if (!observation) {
      observation = nextToolObservation(capture);
      sharedFallback = observation;
    }
    if (!record.registeredAt) record.registeredAt = registrationObservation(capture, observation);
    refreshCapturedToolIdentity(capture, record);
    if (!stateChanged && !visualChanged && !countChanged) continue;
    if (stateChanged && state) {
      record.transitions.push({ state, ...observation });
    }
    if (countChanged) {
      record.callCount = callCount;
      record.callCountTransitions.push({ callCount, ...observation });
    }
    if (visualChanged) {
      record.visualTransitions.push({ settled, rowSettled, ...observation });
    }
  }
  recordToolSurfaceTransitions(capture, observations, sharedFallback);
}

function observeToolLifecycleMutations(
  capture: ToolLifecycleCapture,
  mutations: MutationRecord[],
): void {
  if (mutations.length === 0) return;
  const mutationBatch = capture.mutationBatch + 1;
  capture.mutationBatch = mutationBatch;
  registerCapturedTools(capture);
  const observations = new Map<string, ToolDomObservation>();
  const observedMutations: ObservedMutation[] = [];
  const registrations = new Map<string, SpecificMutationObservation>();
  let fallback: ToolDomObservation | undefined;
  for (const mutation of mutations) {
    const observation = nextToolObservation(capture, mutationBatch);
    fallback = observation;
    observedMutations.push({ mutation, observation });
    const tailStatusChanged = mutationTouchesTailStatus(mutation);
    for (const record of capture.records.values()) {
      const touchesTool = mutationTouchesTool(mutation, record.element);
      if (!record.registeredAt) {
        const specificity = toolIntroductionSpecificity(mutation, record.element);
        if (specificity > 0) {
          registrations.set(record.partKey, preferSpecificMutation(
            registrations.get(record.partKey),
            { observation, specificity },
          ));
        }
      }
      if (tailStatusChanged || touchesTool) {
        observations.set(record.partKey, observation);
      }
    }
  }
  const supportEvidence = registrations.size > 0
    ? currentRunSupportEvidence(capture)
    : null;
  for (const [partKey, registration] of registrations) {
    const record = capture.records.get(partKey);
    if (record && !record.registeredAt) {
      record.registeredAt = registrationObservation(
        capture,
        registration.observation,
        supportEvidence ?? undefined,
      );
      refreshCapturedToolIdentity(capture, record);
    }
  }
  recordContinuationMutations(capture, observedMutations);
  recordResponseErrorMutations(capture, observedMutations);
  scanToolLifecycleCapture(capture, observations, fallback);
}

function flushToolLifecycleCapture(capture: ToolLifecycleCapture): void {
  observeToolLifecycleMutations(capture, capture.observer.takeRecords());
  scanToolLifecycleCapture(capture);
}

function readLiveAndSettledToolIdentities(
  ctx: ActionContext,
): ReadonlyMap<string, Readonly<{ canonicalInput: string; toolName: string }>> | null {
  const view = activeChatView(ctx);
  if (!view) return null;
  const identities = new Map(view.agent?.active?.toolIdentities ?? []);
  // A fast run can settle between capture flushes: a tool introduced in the
  // final frames loses its live identity map before the next poll reads it.
  // The settled transcript carries the same server-echoed name and input, so
  // it backfills identities for calls the live map no longer covers. Live
  // entries keep precedence so a genuine mid-run identity change still
  // surfaces as a conflict.
  for (const message of view.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      if (!call.id || identities.has(call.id)) continue;
      const fn = call.request?.function;
      if (!fn?.name) continue;
      let input: unknown;
      try {
        input = JSON.parse(fn.arguments || "{}");
      } catch {
        continue;
      }
      identities.set(call.id, {
        canonicalInput: canonicalAgentToolInput(input),
        toolName: fn.name,
      });
    }
  }
  return identities;
}

export function startToolLifecycleCapture(ctx: ActionContext): Record<string, unknown> {
  if (toolLifecycleCaptures.has(ctx.app)) {
    throw new DriverActionError("A live tool-lifecycle capture is already active.");
  }
  exactSequentialToolPlanProofs.delete(ctx.app);
  const container = chatContainer(ctx.app);
  if (!container) throw new DriverActionError("Chat must be open before capturing tool lifecycle.");
  const existingToolElements = [
    ...container.querySelectorAll<HTMLElement>(".systemsculpt-agent-part.is-tool"),
  ];
  const existingResponseErrorElements = [
    ...container.querySelectorAll<HTMLElement>(".systemsculpt-agent-part.is-error"),
  ];
  const ignoredPartKeys = new Set(
    existingToolElements
      .map((element) => element.dataset.partKey)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const Observer = container.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
  const supportDiagnosticReader = ctx.readSupportDiagnostics ?? null;
  const supportDiagnosticBaselineRead = readSupportDiagnostics(supportDiagnosticReader);
  const supportDiagnosticBaseline = new Set(
    supportDiagnosticBaselineRead.events.map(supportDiagnosticKey),
  );
  let capture: ToolLifecycleCapture;
  const observer = new Observer((mutations) => observeToolLifecycleMutations(capture, mutations));
  capture = {
    container,
    continuationKeysByElement: new Map<HTMLElement, string>(),
    continuationObservations: new Map<HTMLElement, ToolContinuationObservation>(),
    ignoredPartKeys,
    ignoredResponseErrorElements: new Set(existingResponseErrorElements),
    ignoredToolElements: new Set(existingToolElements),
    mutationBatch: 0,
    mutationSequence: 0,
    nextRenderedContinuationKey: 0,
    nextRenderedPartKey: 0,
    nextRenderedTurnId: 0,
    observer,
    partKeysByElement: new Map<HTMLElement, string>(),
    records: new Map<string, ToolLifecycleRecord>(),
    renderedTurnIds: new Map<HTMLElement, string>(),
    readSupportDiagnostics: supportDiagnosticReader,
    readToolIdentities: () => readLiveAndSettledToolIdentities(ctx),
    responseErrorObservations: new Map<HTMLElement, ToolResponseErrorObservation>(),
    startedAtMs: ownerWindowNow(container),
    supportDiagnosticBaselineAvailable: supportDiagnosticBaselineRead.available,
    supportDiagnosticBaseline,
    surfaceTransitions: new Map<string, ToolSurfaceTransition[]>(),
  };
  capture.observer.observe(container, {
    attributes: true,
    attributeFilter: ["class", "data-part-key", "data-status", "data-tool-count"],
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    subtree: true,
  });
  toolLifecycleCaptures.set(ctx.app, capture);
  return {
    active: true,
    clock: "owner_window_performance",
    source: "live_dom_mutation",
    ignoredExistingTools: existingToolElements.length,
  };
}

export function toolLifecycleReport(ctx: ActionContext): Record<string, unknown> {
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) throw new DriverActionError("No live tool-lifecycle capture is active.");
  flushToolLifecycleCapture(capture);
  const tools = [...capture.records.values()].map((record) => {
    const transitions = record.transitions.map((transition) => ({
      state: transition.state,
      observedAtMs: Math.round(transition.observedAtMs * 1000) / 1000,
      observedSequence: transition.observedSequence,
    }));
    const visualTransitions = record.visualTransitions.map((transition) => ({
      settled: transition.settled,
      rowSettled: transition.rowSettled,
      observedAtMs: Math.round(transition.observedAtMs * 1000) / 1000,
      observedSequence: transition.observedSequence,
    }));
    const callCountTransitions = record.callCountTransitions.map((transition) => ({
      callCount: transition.callCount,
      observedAtMs: Math.round(transition.observedAtMs * 1000) / 1000,
      observedSequence: transition.observedSequence,
    }));
    const first = record.transitions[0]?.observedAtMs;
    const last = record.transitions[record.transitions.length - 1]?.observedAtMs;
    return {
      partKey: record.partKey,
      label: record.label,
      turnId: record.turnId,
      connected: record.element.isConnected && capture.container.contains(record.element),
      callCount: record.callCount,
      callCountTransitions,
      transitions,
      visualTransitions,
      observedDurationMs: typeof first === "number" && typeof last === "number"
        ? Math.round(Math.max(0, last - first) * 1000) / 1000
        : null,
    };
  });
  return {
    active: true,
    clock: "owner_window_performance",
    source: "live_dom_mutation",
    elapsedMs: Math.round(
      Math.max(0, ownerWindowNow(capture.container) - capture.startedAtMs) * 1000,
    ) / 1000,
    surfaces: [...capture.surfaceTransitions].flatMap(([turnId, transitions]) =>
      transitions.map((transition) => ({
        turnId,
        observedAtMs: Math.round(transition.observedAtMs * 1000) / 1000,
        observedSequence: transition.observedSequence,
        toolCallCount: transition.toolCallCount,
        terminalToolCallCount: transition.terminalToolCallCount,
        toolRowCount: transition.toolRowCount,
      }))),
    tools,
  };
}

function assertToolLifecycle(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const minToolCount = params.minToolCount;
  if (!Number.isSafeInteger(minToolCount) || (minToolCount as number) < 1) {
    throw new DriverActionError("minToolCount must be a positive safe integer.");
  }
  if (params.requireTerminal !== undefined && typeof params.requireTerminal !== "boolean") {
    throw new DriverActionError("requireTerminal must be a boolean.");
  }
  const expectedTurnId = typeof params.turnId === "string" ? params.turnId.trim() : null;
  if (params.turnId !== undefined && !expectedTurnId) {
    throw new DriverActionError("turnId must be a non-empty string when provided.");
  }
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) throw new DriverActionError("No live tool-lifecycle capture is active.");
  flushToolLifecycleCapture(capture);
  const records = [...capture.records.values()];
  const turnId = expectedTurnId
    ?? [...records].reverse().find((record) => record.turnId)?.turnId
    ?? null;
  if (!turnId) {
    throw new DriverActionError("No current-run tool identity was observed during capture.");
  }
  const currentRunRecords = records.filter((record) => record.turnId === turnId);
  const connectedRecords = currentRunRecords.filter((record) =>
    record.element.isConnected && capture.container.contains(record.element));
  const connectedToolCallCount = connectedRecords.reduce(
    (sum, record) => sum + record.callCount,
    0,
  );
  const observedToolIdentityCount = currentRunRecords.length;
  const observedToolCallCount = currentRunRecords.reduce(
    (sum, record) => sum + firstCapturedToolCallCount(record),
    0,
  );
  const surfaces = capture.surfaceTransitions.get(turnId) ?? [];
  const toolCallCount = Math.max(
    connectedToolCallCount,
    observedToolIdentityCount,
    observedToolCallCount,
    ...surfaces.map((surface) => surface.toolCallCount),
  );
  if (toolCallCount < (minToolCount as number)) {
    throw new DriverActionError(
      `Current run ${JSON.stringify(turnId)} observed ${toolCallCount} tool calls; `
        + `at least ${String(minToolCount)} were required.`,
    );
  }
  const retainedTerminalToolCallCount = currentRunRecords
    .filter((record) => record.visualTransitions[record.visualTransitions.length - 1]
      ?.rowSettled === true)
    .reduce((sum, record) => sum + firstCapturedToolCallCount(record), 0);
  const terminalToolCallCount = Math.max(
    0,
    retainedTerminalToolCallCount,
    ...surfaces.map((surface) => surface.terminalToolCallCount),
  );
  const allTerminal = terminalToolCallCount >= toolCallCount;
  if (params.requireTerminal === true && !allTerminal) {
    throw new DriverActionError(
      `Current run has not reached a fully terminal captured tool surface: ${JSON.stringify({
        connectedToolCallCount,
        observedToolIdentityCount,
        observedToolCallCount,
        retainedTerminalToolCallCount,
        terminalToolCallCount,
        toolCallCount,
      })}.`,
    );
  }
  const terminalSurface = [...surfaces]
    .reverse()
    .find((surface) => surface.terminalToolCallCount === terminalToolCallCount) ?? null;
  const toolRowCount = terminalSurface?.toolRowCount
    ?? surfaces[surfaces.length - 1]?.toolRowCount
    ?? connectedRecords.length;
  return {
    asserted: true,
    turnId,
    minToolCount,
    toolCallCount,
    toolRowCount,
    connectedToolRowCount: connectedRecords.length,
    observedToolIdentityCount,
    supersededToolRowCount: Math.max(0, currentRunRecords.length - toolRowCount),
    connectedToolCallCount,
    observedToolCallCount,
    retainedTerminalToolCallCount,
    terminalToolCallCount,
    allTerminal,
  };
}

export function endToolLifecycleCapture(ctx: ActionContext): Record<string, unknown> {
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) return {
    active: false,
    clock: "owner_window_performance",
    source: "live_dom_mutation",
      tools: [],
    };
  const exactProof = exactSequentialToolPlanProofs.get(ctx.app);
  try {
    if (exactProof?.capture === capture) {
      flushToolLifecycleCapture(capture);
      if (!exactProof.cleanCloseProven) {
        throw new DriverActionError(
          "Exact tool-plan capture requires a post-run clean-close assertion before ending.",
        );
      }
      if (sameTurnResponseErrorCount(capture, exactProof.turnId) !== 0) {
        throw new DriverActionError(
          "Exact tool-plan clean close observed a response-wide error part.",
        );
      }
    }
    return { ...toolLifecycleReport(ctx), active: false };
  } finally {
    capture.observer.disconnect();
    toolLifecycleCaptures.delete(ctx.app);
    if (exactProof?.capture === capture) exactSequentialToolPlanProofs.delete(ctx.app);
  }
}

interface ContinuationOrderingProof {
  allToolResultProof: readonly Record<string, unknown>[];
  canonicalAcknowledgementProof: readonly Record<string, unknown>[];
  priorRecords: readonly ToolLifecycleRecord[];
  terminalToolCallCount: number;
  toolCallCount: number;
}

function latestVisualTransitionAt(
  record: ToolLifecycleRecord,
  observedSequence: number,
): ToolVisualTransition | null {
  const transitions = record.visualTransitions
    .filter((transition) => transition.observedSequence <= observedSequence);
  return transitions[transitions.length - 1] ?? null;
}

function proveCanonicalToolAcknowledgements(
  capture: ToolLifecycleCapture,
  continuation: ToolContinuationObservation,
  records: readonly ToolLifecycleRecord[],
): readonly Record<string, unknown>[] {
  if (
    !capture.supportDiagnosticBaselineAvailable
    || !continuation.supportDiagnosticsAvailable
  ) {
    throw new DriverActionError(
      "Command acknowledgement ordering requires content-free support diagnostics.",
    );
  }
  const orderedRecords = orderedToolLifecycleRecords(records);
  const expectedToolCallCount = orderedRecords.reduce(
    (count, record) => count + record.callCount,
    0,
  );
  const scope = bindToolResultDeliveryScope(
    continuation,
    orderedRecords,
    expectedToolCallCount,
  );
  let evidenceIndex = 0;
  const proof = orderedRecords.map((record, recordIndex) => {
    const evidence = scope.startedEvidence[evidenceIndex];
    evidenceIndex += record.callCount;
    const acknowledgementSucceededCount = evidence?.acknowledgementSucceededCount ?? 0;
    const acknowledgementFailedCount = evidence?.acknowledgementFailedCount ?? 0;
    const commandProof = evidence ? resultDeliveryCommandProof(evidence) : null;
    return {
      acknowledgementCount: acknowledgementSucceededCount + acknowledgementFailedCount,
      acknowledgementFailedCount,
      acknowledgementSucceededCount,
      commandOrderingProven: commandProof?.valid === true,
      recordIndex: recordIndex + 1,
      toolExecutionOrdinal: evidence?.toolExecutionOrdinal ?? null,
    };
  });
  if (proof.some((entry) =>
    entry.acknowledgementCount !== 1 || entry.commandOrderingProven !== true)) {
    throw new DriverActionError(
      "Continuation text appeared before the matching tool-result command was acknowledged "
        + "exactly once for every prior current-run tool.",
    );
  }
  return proof;
}

function proveContinuationOrdering(
  capture: ToolLifecycleCapture,
  entry: ToolContinuationEntry,
  expectedRecord: ToolLifecycleRecord | null,
  requireCommandAck: boolean,
  requireAllToolResultAcks: boolean,
  requiredAllToolResultState: "failed" | "succeeded" | null,
): ContinuationOrderingProof {
  const [, continuationAt] = entry;
  const turnId = continuationAt.turnId;
  if (!turnId) {
    throw new DriverActionError(
      "The continuation observation is not bound to an assistant turn identity.",
    );
  }
  const priorRecords = [...capture.records.values()].filter((candidate) => {
    if (candidate.turnId !== turnId) return false;
    const first = firstToolRecordObservation(candidate);
    return first !== null && first.observedSequence <= continuationAt.observedSequence;
  });
  const surfacesBeforeContinuation = (capture.surfaceTransitions.get(turnId) ?? [])
    .filter((surface) => surface.observedSequence <= continuationAt.observedSequence);
  const observedToolCallCount = priorRecords.reduce(
    (sum, record) => sum + firstCapturedToolCallCount(record),
    0,
  );
  const toolCallCount = Math.max(
    priorRecords.length,
    observedToolCallCount,
    0,
    ...surfacesBeforeContinuation.map((surface) => surface.toolCallCount),
  );
  const retainedTerminalToolCallCount = priorRecords
    .filter((record) => latestVisualTransitionAt(
      record,
      continuationAt.observedSequence,
    )?.rowSettled === true)
    .reduce((sum, record) => sum + firstCapturedToolCallCount(record), 0);
  const terminalToolCallCount = Math.max(
    0,
    retainedTerminalToolCallCount,
    ...surfacesBeforeContinuation.map((surface) => surface.terminalToolCallCount),
  );
  const expectedFirst = expectedRecord ? firstToolRecordObservation(expectedRecord) : null;
  if (
    expectedRecord
    && expectedFirst
    && expectedFirst.observedSequence <= continuationAt.observedSequence
  ) {
    const visualAtContinuation = latestVisualTransitionAt(
      expectedRecord,
      continuationAt.observedSequence,
    );
    if (visualAtContinuation?.settled !== true) {
      const laterSettlement = expectedRecord.visualTransitions.find((transition) =>
        transition.settled
        && transition.observedSequence > continuationAt.observedSequence);
      throw new DriverActionError(
        `Continuation text appeared after tool ${JSON.stringify(expectedRecord.label)} before its `
          + `row was visibly settled: continuationSequence=${String(
            continuationAt.observedSequence,
          )}, settledSequence=${String(laterSettlement?.observedSequence ?? null)}, `
          + `continuationClassification=present-but-polluted, `
          + `continuationEvidence=${JSON.stringify(continuationObservationMetadata(entry))}.`,
      );
    }
  }
  const unsettledToolIdentityCount = priorRecords.filter((record) =>
    latestVisualTransitionAt(record, continuationAt.observedSequence)?.settled !== true).length;
  if (
    terminalToolCallCount < toolCallCount
    || unsettledToolIdentityCount > 0
  ) {
    throw new DriverActionError(
      "Continuation text appeared before every prior current-run tool was visibly terminal: "
        + `${JSON.stringify({
          continuation: continuationObservationMetadata(entry),
          terminalToolCallCountAtContinuation: terminalToolCallCount,
          toolCallCountAtContinuation: toolCallCount,
          unsettledToolIdentityCount,
        })}; continuationClassification=present-but-polluted.`,
    );
  }
  if (toolCallCount === 0) {
    return {
      allToolResultProof: [],
      canonicalAcknowledgementProof: [],
      priorRecords,
      terminalToolCallCount,
      toolCallCount,
    };
  }
  const canonicalAcknowledgementProof = requireCommandAck
    ? proveCanonicalToolAcknowledgements(capture, continuationAt, priorRecords)
    : [];
  const allToolResultProof = requireAllToolResultAcks
    ? proveEveryToolResultAcknowledgement(
      capture,
      continuationAt,
      priorRecords,
      toolCallCount,
    )
    : [];
  if (
    requiredAllToolResultState
    && allToolResultProof.some((result) =>
      result.acknowledgedResultState !== requiredAllToolResultState)
  ) {
    throw new DriverActionError(
      `Expected every current-turn tool result to be ${requiredAllToolResultState}.`,
    );
  }
  return {
    allToolResultProof,
    canonicalAcknowledgementProof,
    priorRecords,
    terminalToolCallCount,
    toolCallCount,
  };
}

async function assertLatestToolSettledAfterContinuation(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const expectedLabel = typeof params.toolLabel === "string" ? params.toolLabel.trim() : "";
  const expectedText = typeof params.text === "string" ? params.text.trim() : "";
  if (!expectedLabel || !expectedText) {
    throw new DriverActionError(
      "A current-run tool label and continuation text are required for lifecycle assertions.",
    );
  }
  if (
    params.textMode !== undefined
    && params.textMode !== "equals"
    && params.textMode !== "contains"
  ) {
    throw new DriverActionError('textMode must be "equals" or "contains".');
  }
  const textMode = params.textMode === "equals" ? "equals" : "contains";
  const expectedState = typeof params.expectedState === "string"
    ? params.expectedState.trim() as ToolLifecycleState
    : null;
  if (expectedState && TOOL_TERMINAL_ICONS[expectedState] === undefined) {
    throw new DriverActionError(
      `expectedState must be visibly terminal: ${Object.keys(TOOL_TERMINAL_ICONS).join(", ")}.`,
    );
  }
  if (params.requireCommandAck !== undefined && typeof params.requireCommandAck !== "boolean") {
    throw new DriverActionError("requireCommandAck must be a boolean.");
  }
  const requireCommandAck = params.requireCommandAck === true;
  if (
    params.requireAllToolResultAcks !== undefined
    && typeof params.requireAllToolResultAcks !== "boolean"
  ) {
    throw new DriverActionError("requireAllToolResultAcks must be a boolean.");
  }
  const requireAllToolResultAcks = params.requireAllToolResultAcks === true;
  const expectedAllToolResultState = params.expectedAllToolResultState;
  if (
    expectedAllToolResultState !== undefined
    && expectedAllToolResultState !== "succeeded"
    && expectedAllToolResultState !== "failed"
  ) {
    throw new DriverActionError(
      'expectedAllToolResultState must be "succeeded" or "failed".',
    );
  }
  if (expectedAllToolResultState !== undefined && !requireAllToolResultAcks) {
    throw new DriverActionError(
      "expectedAllToolResultState requires requireAllToolResultAcks=true.",
    );
  }
  const requiredAllToolResultState = requireAllToolResultAcks
    ? expectedAllToolResultState ?? "succeeded"
    : null;
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) {
    throw new DriverActionError(
      "A live tool-lifecycle capture must begin before the current run.",
    );
  }
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const container = chatContainer(ctx.app);
    if (!container) throw new DriverActionError("Chat is not open.");
    flushToolLifecycleCapture(capture);
    const allLabelRecords = [...capture.records.values()]
      .filter((record) => record.label === expectedLabel && record.turnId !== null);
    const matchingContinuations = matchingContinuationEntries(
      capture,
      expectedText,
      textMode,
    );
    const continuationEntry = matchingContinuations[matchingContinuations.length - 1] ?? null;
    const continuationTurnId = continuationEntry?.[1].turnId ?? null;
    const matchingRecords = continuationTurnId
      ? allLabelRecords
        .filter((record) => record.turnId === continuationTurnId)
        .sort((left, right) => left.callCount - right.callCount)
      : [];
    const record = matchingRecords[matchingRecords.length - 1] ?? null;
    if (record && continuationEntry) {
      const tool = record.element;
      const assistantTurn = tool.closest<HTMLElement>(".systemsculpt-agent-turn.is-assistant");
      if (
        !record.turnId
        || (
          tool.isConnected
          && capturedTurnId(capture, assistantTurn) !== record.turnId
        )
      ) {
        throw new DriverActionError(
          "The captured tool is not bound to the current assistant run identity.",
        );
      }
      if (continuationEntry[1].turnId === record.turnId) {
        const [continuation, continuationAt] = continuationEntry;
        const snapshot = capturedToolRowSnapshot(record);
        const agentStatus = container.querySelector(".systemsculpt-agent-tail-status")
          ?.getAttribute("data-status") ?? null;
        if (expectedState && snapshot.state !== expectedState) {
          throw new DriverActionError(
            `Expected tool state ${JSON.stringify(expectedState)}, got ${JSON.stringify(snapshot.state)}.`,
          );
        }
        const sameTurnContinuations = capturedContinuationEntries(capture)
          .filter(([, observation]) =>
            observation.turnId === record.turnId
            && observation.observedSequence <= continuationAt.observedSequence);
        let orderingProof: ContinuationOrderingProof | null = null;
        for (const sameTurnEntry of sameTurnContinuations) {
          orderingProof = proveContinuationOrdering(
            capture,
            sameTurnEntry,
            record,
            requireCommandAck,
            requireAllToolResultAcks,
            requiredAllToolResultState,
          );
        }
        if (!orderingProof) {
          throw new DriverActionError(
            "The matching continuation was not retained in its assistant-turn observations.",
          );
        }
        const latestVisual = record.visualTransitions[record.visualTransitions.length - 1];
        const currentlySettled = tool.isConnected
          ? toolIsVisuallySettled(tool, container)
          : latestVisual?.settled === true;
        if (!currentlySettled) {
          throw new DriverActionError(
            `Continuation text appeared after tool ${JSON.stringify(snapshot.label)} before its `
              + `row was visibly settled: continuationSequence=${continuationAt.observedSequence}, `
              + `state=${String(snapshot.state)}, `
              + `stateIcon=${String(snapshot.stateIcon)}, `
              + `agentStatus=${String(agentStatus)}, `
              + `continuationEvidence=${JSON.stringify(
                continuationObservationMetadata(continuationEntry),
              )}.`,
          );
        }
        const {
          allToolResultProof,
          canonicalAcknowledgementProof,
          priorRecords,
          terminalToolCallCount: terminalToolCallCountAtContinuation,
          toolCallCount: toolCallCountAtContinuation,
        } = orderingProof;
        const recordIndex = orderedToolLifecycleRecords(priorRecords).indexOf(record);
        const recordAcknowledgement = recordIndex >= 0
          ? canonicalAcknowledgementProof[recordIndex]
          : null;
        const commandAcknowledgementCountAtContinuation = typeof recordAcknowledgement
          ?.acknowledgementCount === "number"
          ? recordAcknowledgement.acknowledgementCount
          : 0;
        if (requireCommandAck && commandAcknowledgementCountAtContinuation !== 1) {
          throw new DriverActionError(
            "Continuation text appeared before the matching tool-result command was acknowledged.",
          );
        }
        const lifecycle = toolLifecycleReport(ctx).tools as Array<Record<string, unknown>>;
        return {
          settled: true,
          waitedMs: Date.now() - startedAt,
          tool: snapshot,
          turnId: record.turnId,
          agentStatus,
          continuationAt: {
            observedAtMs: Math.round(continuationAt.observedAtMs * 1000) / 1000,
            observedSequence: continuationAt.observedSequence,
          },
          continuationObservationsChecked: sameTurnContinuations.length,
          priorToolsChecked: priorRecords.length,
          priorTools: priorRecords.map((candidate) => ({
            partKey: candidate.partKey,
            label: candidate.label,
            callCount: candidate.callCount,
          })),
          terminalToolCallCountAtContinuation,
          toolCallCountAtContinuation,
          commandAcknowledgedBeforeContinuation:
            commandAcknowledgementCountAtContinuation === 1,
          commandAcknowledgementCountAtContinuation,
          allToolResultsAcknowledgedBeforeContinuation: requireAllToolResultAcks,
          expectedAllToolResultState: requiredAllToolResultState,
          toolResultAcknowledgementCount: allToolResultProof.length,
          toolResultAcknowledgements: allToolResultProof,
          continuationCharacters: (continuation.textContent ?? "").trim().length,
          lifecycle: lifecycle.find((entry) => entry.partKey === record.partKey) ?? null,
        };
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw continuationTimeoutError(
        capture,
        expectedText,
        timeoutMs,
        "Tool-settlement assertion",
      );
    }
    await sleep(50);
  }
}

async function assertAllToolResultSendsCompleted(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const expectedLabel = typeof params.toolLabel === "string" ? params.toolLabel.trim() : "";
  const expectedText = typeof params.text === "string" ? params.text.trim() : "";
  if (!expectedLabel || !expectedText) {
    throw new DriverActionError(
      "A current-run tool label and continuation text are required for send-completion proof.",
    );
  }
  if (
    params.textMode !== undefined
    && params.textMode !== "equals"
    && params.textMode !== "contains"
  ) {
    throw new DriverActionError('textMode must be "equals" or "contains".');
  }
  const textMode = params.textMode === "equals" ? "equals" : "contains";
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) {
    throw new DriverActionError(
      "A live tool-lifecycle capture must begin before the current run.",
    );
  }

  const startedAt = Date.now();
  let matchedToolSurface = false;
  for (;;) {
    throwIfActionCancelled(ctx);
    if (!chatContainer(ctx.app)) throw new DriverActionError("Chat is not open.");
    flushToolLifecycleCapture(capture);
    const matchingContinuations = matchingContinuationEntries(
      capture,
      expectedText,
      textMode,
    );
    const continuationEntry = matchingContinuations[matchingContinuations.length - 1] ?? null;
    if (continuationEntry) {
      const continuationAt = continuationEntry[1];
      const matchingRecords = [...capture.records.values()]
        .filter((record) =>
          record.label === expectedLabel
          && record.turnId === continuationAt.turnId)
        .sort((left, right) => left.callCount - right.callCount);
      const record = matchingRecords[matchingRecords.length - 1] ?? null;
      if (record) {
        matchedToolSurface = true;
        const priorRecords = [...capture.records.values()].filter((candidate) => {
          if (candidate.turnId !== record.turnId) return false;
          const first = firstToolRecordObservation(candidate);
          return first !== null && first.observedSequence <= continuationAt.observedSequence;
        });
        const surfacesBeforeContinuation = (capture.surfaceTransitions.get(record.turnId ?? "")
          ?? []).filter((surface) =>
          surface.observedSequence <= continuationAt.observedSequence);
        const toolCallCountAtContinuation = Math.max(
          priorRecords.length,
          0,
          ...surfacesBeforeContinuation.map((surface) => surface.toolCallCount),
        );
        const proof = inspectEveryToolResultSendCompletion(
          capture,
          continuationAt,
          priorRecords,
          toolCallCountAtContinuation,
        );
        if (proof) {
          return {
            completed: true,
            waitedMs: Date.now() - startedAt,
            turnId: record.turnId,
            toolCallCount: toolCallCountAtContinuation,
            toolResultSendCompletionCount: proof.length,
            toolResultSendCompletions: proof,
          };
        }
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      if (!matchedToolSurface) {
        throw continuationTimeoutError(
          capture,
          expectedText,
          timeoutMs,
          "Tool-result send-completion assertion",
        );
      }
      throw new DriverActionError(
        "Every current-turn tool result did not record one clean send completion in time.",
      );
    }
    await sleep(20);
  }
}

interface ExactSequentialToolExpectation {
  canonicalInput: string;
  toolName: string;
}

interface ExactSequentialToolPlanParams {
  expectedTools: readonly ExactSequentialToolExpectation[];
  expectedText: string;
  requireNoOtherText: boolean;
  textMode: "contains" | "equals";
  timeoutMs: number;
}

interface ExactSequentialToolPlanProof {
  capture: ToolLifecycleCapture;
  chatId: string;
  cleanCloseProven: boolean;
  commandSegmentOrdinals: readonly number[];
  deliveryRequestId: string;
  expectedTools: readonly ExactSequentialToolExpectation[];
  partKeys: readonly string[];
  provenAtObservedSequence: number;
  requireNoOtherText: boolean;
  textParts: readonly ExactSequentialTextPartProof[];
  textMode: "contains" | "equals";
  textMetadata: Readonly<{ characters: number; sha256: string }>;
  toolExecutionOrdinals: readonly number[];
  turnId: string;
}

interface ExactSequentialTextPartProof {
  partKey: string;
  textMetadata: Readonly<{ characters: number; sha256: string }>;
}

const exactSequentialToolPlanProofs = new WeakMap<App, ExactSequentialToolPlanProof>();

function exactSequentialToolPlanParams(
  params: Record<string, unknown>,
): ExactSequentialToolPlanParams {
  const rawTools = params.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new DriverActionError("tools must be a nonempty exact ordered tool plan.");
  }
  const expectedTools = rawTools.map((rawTool, index) => {
    if (typeof rawTool !== "object" || rawTool === null || Array.isArray(rawTool)) {
      throw new DriverActionError(`Tool plan entry ${String(index + 1)} must be an exact object.`);
    }
    const tool = rawTool as Record<string, unknown>;
    const keys = Object.keys(tool).sort();
    if (keys.length !== 2 || keys[0] !== "input" || keys[1] !== "name") {
      throw new DriverActionError(
        `Tool plan entry ${String(index + 1)} must contain only name and input.`,
      );
    }
    if (
      typeof tool.name !== "string"
      || tool.name.length === 0
      || tool.name.trim() !== tool.name
    ) {
      throw new DriverActionError(
        `Tool plan entry ${String(index + 1)} requires one canonical tool name.`,
      );
    }
    return Object.freeze({
      canonicalInput: canonicalAgentToolInput(tool.input),
      toolName: tool.name,
    });
  });
  const expectedText = typeof params.text === "string" ? params.text.trim() : "";
  if (!expectedText) {
    throw new DriverActionError("Exact sequential tool-plan proof requires continuation text.");
  }
  if (
    params.textMode !== undefined
    && params.textMode !== "equals"
    && params.textMode !== "contains"
  ) {
    throw new DriverActionError('textMode must be "equals" or "contains".');
  }
  const textMode = params.textMode === "contains" ? "contains" : "equals";
  if (
    params.requireNoOtherText !== undefined
    && typeof params.requireNoOtherText !== "boolean"
  ) {
    throw new DriverActionError("requireNoOtherText must be a boolean.");
  }
  const requireNoOtherText = params.requireNoOtherText !== false;
  if (requireNoOtherText && textMode !== "equals") {
    throw new DriverActionError(
      "requireNoOtherText requires textMode=equals so the final marker is exact.",
    );
  }
  const timeoutMs = params.timeoutMs === undefined
    ? 10000
    : typeof params.timeoutMs === "number"
      && Number.isFinite(params.timeoutMs)
      && params.timeoutMs >= 0
      ? params.timeoutMs
      : null;
  if (timeoutMs === null) {
    throw new DriverActionError("timeoutMs must be a finite nonnegative number.");
  }
  return {
    expectedTools: Object.freeze(expectedTools),
    expectedText,
    requireNoOtherText,
    textMode,
    timeoutMs,
  };
}

/**
 * Canonicalizes a plan tool input with the vault executor's optional-field
 * defaults resolved, so a model that trimmed a field whose default it relied
 * on still proves the same semantic call. Only fields the executor defines a
 * default for participate; an unknown tool or an unknown field keeps the
 * input byte-exact.
 */
function developmentSemanticCanonicalInput(
  toolName: string,
  canonicalInput: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalInput);
  } catch {
    return canonicalInput;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return canonicalInput;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (toolName === "write") {
    if (!keys.every((key) =>
      ["appendNewline", "content", "createDirs", "ifExists", "path"].includes(key))) {
      return canonicalInput;
    }
    return canonicalAgentToolInput({
      appendNewline: record.appendNewline ?? false,
      content: record.content,
      createDirs: record.createDirs ?? true,
      ifExists: record.ifExists ?? "overwrite",
      path: record.path,
    });
  }
  if (toolName === "read") {
    if (!keys.every((key) => ["length", "offset", "paths"].includes(key))) {
      return canonicalInput;
    }
    // The executor windows an omitted length to MAX_FILE_READ_LENGTH, so an
    // explicit request for that same window is the identical semantic call.
    return canonicalAgentToolInput({
      length: record.length ?? FILESYSTEM_LIMITS.MAX_FILE_READ_LENGTH,
      offset: record.offset ?? 0,
      paths: record.paths,
    });
  }
  return canonicalInput;
}

/**
 * Value-free identity-mismatch evidence: canonical inputs may contain private
 * vault paths and note content, so a mismatch report may name top-level input
 * KEYS (tool-schema identifiers) but never their values. Comparison happens on
 * the executor-default-resolved semantic form, the same form the identity
 * check itself uses.
 */
function describeSemanticInputMismatch(
  toolName: string,
  capturedInput: string | null,
  expectedInput: string,
): Record<string, unknown> {
  const parse = (input: string | null): Record<string, unknown> | string => {
    if (input === null) return "absent";
    let parsed: unknown;
    try {
      parsed = JSON.parse(developmentSemanticCanonicalInput(toolName, input));
    } catch {
      return "unparseable";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Array.isArray(parsed) ? "array" : typeof parsed;
    }
    return parsed as Record<string, unknown>;
  };
  const captured = parse(capturedInput);
  const expected = parse(expectedInput);
  if (typeof captured === "string" || typeof expected === "string") {
    return {
      capturedShape: typeof captured === "string" ? captured : "object",
      expectedShape: typeof expected === "string" ? expected : "object",
    };
  }
  const keys = [...new Set([...Object.keys(captured), ...Object.keys(expected)])].sort();
  const mismatchedKeys: string[] = [];
  const capturedOnlyKeys: string[] = [];
  const expectedOnlyKeys: string[] = [];
  for (const key of keys) {
    if (!(key in captured)) expectedOnlyKeys.push(key);
    else if (!(key in expected)) capturedOnlyKeys.push(key);
    else if (canonicalAgentToolInput(captured[key]) !== canonicalAgentToolInput(expected[key])) {
      mismatchedKeys.push(key);
    }
  }
  return { mismatchedKeys, capturedOnlyKeys, expectedOnlyKeys };
}

function sameDevelopmentSemanticToolIdentity(
  expected: ExactSequentialToolExpectation,
  toolName: string | null,
  canonicalInput: string | null,
): boolean {
  return toolName === expected.toolName
    && canonicalInput !== null
    && developmentSemanticCanonicalInput(expected.toolName, canonicalInput)
      === developmentSemanticCanonicalInput(expected.toolName, expected.canonicalInput);
}

function sameContinuationMetadata(
  left: Readonly<{ characters: number; sha256: string }>,
  right: Readonly<{ characters: number; sha256: string }>,
): boolean {
  return left.characters === right.characters && left.sha256 === right.sha256;
}

function capturedExactTextParts(
  capture: ToolLifecycleCapture,
  turnId: string,
): readonly ExactSequentialTextPartProof[] {
  return capturedContinuationEntries(capture)
    .filter(([, observation]) => observation.turnId === turnId)
    .map(([part, observation]) => Object.freeze({
      partKey: observation.partKey,
      textMetadata: continuationContentMetadata(part.textContent ?? ""),
    }));
}

function exactTextPartProofMatches(
  expected: readonly ExactSequentialTextPartProof[],
  actual: readonly ExactSequentialTextPartProof[],
): boolean {
  return expected.length === actual.length && expected.every((part, index) => {
    const candidate = actual[index];
    return candidate !== undefined
      && part.partKey === candidate.partKey
      && sameContinuationMetadata(part.textMetadata, candidate.textMetadata);
  });
}

function sameOrdinalPlan(
  expected: readonly number[],
  actual: readonly number[],
): boolean {
  return expected.length === actual.length
    && expected.every((ordinal, index) => ordinal === actual[index]);
}

function exactTerminalGroupedToolSurface(
  turn: HTMLElement,
  container: HTMLElement,
  orderedPartKeys: readonly string[],
): boolean {
  const collapsedOverflows = [...turn.querySelectorAll<HTMLButtonElement>(
    'button[data-agent-activity-overflow][aria-expanded="false"]',
  )];
  for (const overflow of collapsedOverflows) overflow.click();
  try {
    if (collapsedOverflows.some((overflow) =>
      overflow.getAttribute("aria-expanded") !== "true")) return false;
    const rows = [...turn.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-part.is-tool",
    )];
    if (rows.length === 0) return false;
    let logicalIndex = 0;
    for (const row of rows) {
      const callCount = exactTerminalRowCallCount(row);
      if (
        callCount === null
        || row.dataset.partKey !== orderedPartKeys[logicalIndex]
        || toolLifecycleState(row) !== "succeeded"
        || !toolIsVisuallySettled(row, container)
      ) return false;
      logicalIndex += callCount;
    }
    return logicalIndex === orderedPartKeys.length;
  } finally {
    for (const overflow of collapsedOverflows.reverse()) {
      if (overflow.getAttribute("aria-expanded") === "true") overflow.click();
    }
  }
}

/**
 * With exactGrouping, every tool row must precede every text part. Without it
 * (a plan that allows benign assistant prose), interleaved text is fine, but
 * the turn must still end with a text part painted after the last tool so the
 * continuation remains the terminal surface.
 */
function toolsPrecedeTextOnExactSurface(
  turn: HTMLElement,
  exactGrouping: boolean,
): boolean {
  const relevant = [...turn.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-tool, .systemsculpt-agent-part.is-text",
  )];
  const toolRowCount = relevant.filter((part) => part.classList.contains("is-tool")).length;
  if (toolRowCount === 0) return false;
  if (exactGrouping) {
    return relevant.slice(0, toolRowCount).every((part) => part.classList.contains("is-tool"))
      && relevant.slice(toolRowCount).every((part) => part.classList.contains("is-text"));
  }
  const lastToolIndex = relevant.reduce(
    (latest, part, index) => (part.classList.contains("is-tool") ? index : latest),
    -1,
  );
  const finalPart = relevant[relevant.length - 1];
  return finalPart !== undefined
    && finalPart.classList.contains("is-text")
    && lastToolIndex < relevant.length - 1;
}

function sameTurnResponseErrorCount(
  capture: ToolLifecycleCapture,
  turnId: string,
): number {
  return [...capture.responseErrorObservations.values()]
    .filter((observation) => observation.turnId === turnId)
    .length;
}

function exactSequentialRegistrationProof(
  records: readonly ToolLifecycleRecord[],
  finalDeliveryScope: BoundToolResultDeliveryScope,
): void {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    const currentRegistration = current?.registeredAt;
    if (!previous?.registeredAt || !currentRegistration) {
      throw new DriverActionError(
        "Exact sequential tool-plan proof is missing first-introduction provenance.",
      );
    }
    if (
      currentRegistration.observedSequence <= previous.registeredAt.observedSequence
      || currentRegistration.mutationBatch <= previous.registeredAt.mutationBatch
    ) {
      throw new DriverActionError(
        "A later expected tool was introduced in the same or an earlier mutation batch.",
      );
    }
    if (
      latestVisualTransitionAt(previous, currentRegistration.observedSequence)?.rowSettled !== true
    ) {
      throw new DriverActionError(
        "A later expected tool appeared before the prior tool was visibly terminal.",
      );
    }
    const previousFinalEvidence = finalDeliveryScope.startedEvidence[index - 1];
    const currentFinalEvidence = finalDeliveryScope.startedEvidence[index];
    if (!previousFinalEvidence || !currentFinalEvidence) {
      throw new DriverActionError(
        "Exact sequential tool-plan diagnostics do not cover every ordered call.",
      );
    }
    const priorAtIntroduction = currentRegistration.toolResultDeliveryEvidence.find((evidence) =>
      evidence.requestId === finalDeliveryScope.requestId
      && evidence.toolExecutionOrdinal === previousFinalEvidence.toolExecutionOrdinal);
    const priorCommandProof = priorAtIntroduction
      ? resultDeliveryCommandProof(priorAtIntroduction)
      : null;
    const finalPriorCommandProof = resultDeliveryCommandProof(previousFinalEvidence);
    const finalCurrentCommandProof = resultDeliveryCommandProof(currentFinalEvidence);
    if (
      !priorAtIntroduction
      || priorAtIntroduction.acknowledgementSucceededCount !== 1
      || priorAtIntroduction.acknowledgementFailedCount !== 0
      || priorCommandProof?.valid !== true
      || finalPriorCommandProof.valid !== true
      || finalCurrentCommandProof.valid !== true
      || finalPriorCommandProof.acknowledgementSequence === null
      || finalCurrentCommandProof.localStartSequence === null
      || finalPriorCommandProof.acknowledgementSequence
        >= finalCurrentCommandProof.localStartSequence
    ) {
      throw new DriverActionError(
        "A later expected tool appeared or started before one successful prior result ACK.",
      );
    }
  }
}

async function assertExactSequentialToolPlan(
  ctx: ActionContext,
  rawParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = exactSequentialToolPlanParams(rawParams);
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) {
    throw new DriverActionError(
      "A live tool-lifecycle capture must begin before the exact sequential plan.",
    );
  }
  const startedAt = Date.now();
  let quiescedTurnId: string | null = null;
  for (;;) {
    throwIfActionCancelled(ctx);
    const container = chatContainer(ctx.app);
    if (!container) throw new DriverActionError("Chat is not open.");
    flushToolLifecycleCapture(capture);
    const matching = matchingContinuationEntries(
      capture,
      params.expectedText,
      params.textMode,
    );
    const continuationEntry = matching[matching.length - 1] ?? null;
    if (continuationEntry) {
      const [continuationPart, continuationAt] = continuationEntry;
      const turnId = continuationAt.turnId;
      if (!turnId) {
        throw new DriverActionError(
          "The exact final continuation is not bound to an assistant turn.",
        );
      }
      const sameTurnTextEntries = capturedContinuationEntries(capture)
        .filter(([, observation]) => observation.turnId === turnId);
      const sameTurnMatchingCount = sameTurnTextEntries.filter(([textPart]) => {
        const text = (textPart.textContent ?? "").trim();
        return params.textMode === "equals"
          ? text === params.expectedText
          : text.includes(params.expectedText);
      }).length;
      if (sameTurnMatchingCount !== 1) {
        throw new DriverActionError(
          "The allowed final continuation was observed more than once in its assistant turn.",
        );
      }
      if (params.requireNoOtherText && sameTurnTextEntries.length !== 1) {
        throw new DriverActionError(
          "The exact tool-plan turn contains pre-tool, duplicate, or additional assistant text.",
        );
      }
      const records = orderedToolLifecycleRecords(
        [...capture.records.values()].filter((record) => record.turnId === turnId),
      );
      if (records.length > params.expectedTools.length) {
        throw new DriverActionError(
          "The exact tool-plan turn contains an extra client-tool call: "
            + `expected=${String(params.expectedTools.length)}; `
            + `records=${JSON.stringify(records.map((record) => ({
              partKey: record.partKey,
              label: record.label,
              firstCallCount: firstCapturedToolCallCount(record),
              callCount: record.callCount,
              connected: record.element.isConnected
                && capture.container.contains(record.element),
            })))}.`,
        );
      }
      if (records.length === params.expectedTools.length) {
        if (records.some((record) => firstCapturedToolCallCount(record) !== 1)) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires distinct singleton introductions.",
          );
        }
        if (records.some((record) => toolLifecycleState(record.element) !== "succeeded")) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires every visible result to succeed.",
          );
        }
        records.forEach((record, index) => {
          const expected = params.expectedTools[index];
          if (
            !expected
            || record.identityConflict
            || !sameDevelopmentSemanticToolIdentity(
              expected,
              record.toolName,
              record.canonicalInput,
            )
          ) {
            throw new DriverActionError(
              `Exact canonical tool identity mismatch at plan index ${String(index + 1)}: `
                + `partKey=${record.partKey}; `
                + `conflict=${String(record.identityConflict)}; `
                + `capturedName=${JSON.stringify(record.toolName)}; `
                + `expectedName=${JSON.stringify(expected?.toolName ?? null)}; `
                + `inputKeyDiff=${JSON.stringify(expected
                  ? describeSemanticInputMismatch(
                      expected.toolName,
                      record.canonicalInput,
                      expected.canonicalInput,
                    )
                  : null)}.`,
            );
          }
        });
        const orderingProofs = sameTurnTextEntries.map((entry) =>
          proveContinuationOrdering(
            capture,
            entry,
            records[records.length - 1] ?? null,
            false,
            false,
            null,
          ));
        const finalOrderingProof = orderingProofs[orderingProofs.length - 1];
        if (
          !finalOrderingProof
          || finalOrderingProof.toolCallCount !== params.expectedTools.length
          || finalOrderingProof.priorRecords.length !== records.length
        ) {
          throw new DriverActionError(
            "The final continuation does not bind the exact expected tool cardinality.",
          );
        }
        const finalDeliveryScope = bindToolResultDeliveryScope(
          continuationAt,
          records,
          params.expectedTools.length,
          turnId,
          true,
        );
        if (finalDeliveryScope.startedEvidence.some((evidence) =>
          evidence.acknowledgementSucceededCount !== 1
          || evidence.acknowledgementFailedCount !== 0
          || !resultDeliveryCommandProof(evidence).valid)) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires one successful result ACK per call.",
          );
        }
        const commandSegments = finalDeliveryScope.startedEvidence.map((evidence) =>
          resultDeliveryCommandProof(evidence).commandSegmentOrdinal);
        if (
          commandSegments.some((ordinal) => ordinal === null)
          || new Set(commandSegments).size !== params.expectedTools.length
        ) {
          throw new DriverActionError(
            "Exact sequential tool-plan proof requires one unique result-command segment per call.",
          );
        }
        exactSequentialRegistrationProof(records, finalDeliveryScope);
        const assistantTurn = continuationPart.closest<HTMLElement>(
          ".systemsculpt-agent-turn.is-assistant",
        );
        const partKeys = records.map((record) => record.partKey);
        if (
          !assistantTurn
          || !exactTerminalGroupedToolSurface(assistantTurn, container, partKeys)
          || !toolsPrecedeTextOnExactSurface(assistantTurn, params.requireNoOtherText)
        ) {
          throw new DriverActionError(
            "The exact tool-plan turn does not preserve its terminal grouped tool surface.",
          );
        }
        const responseErrorCount = sameTurnResponseErrorCount(capture, turnId)
          + (assistantTurn?.querySelectorAll(".systemsculpt-agent-part.is-error").length ?? 0);
        if (responseErrorCount > 0) {
          throw new DriverActionError(
            "The exact tool-plan turn observed a response-wide error part.",
          );
        }
        const stop = resolveTarget(ctx, "chat.composer.stop");
        const runStillActive = assistantTurn?.classList.contains("is-active") === true
          || (stop !== null && isVisible(stop));
        if (!runStillActive) {
          if (quiescedTurnId !== turnId) {
            quiescedTurnId = turnId;
            await sleep(0);
            flushToolLifecycleCapture(capture);
            await sleep(0);
            continue;
          }
          const view = activeChatView(ctx);
          const textParts = capturedExactTextParts(capture, turnId);
          const toolExecutionOrdinals = finalDeliveryScope.startedEvidence.map(
            (evidence) => evidence.toolExecutionOrdinal,
          );
          exactSequentialToolPlanProofs.set(ctx.app, {
            capture,
            chatId: view?.chatId ?? "",
            cleanCloseProven: false,
            commandSegmentOrdinals: Object.freeze(commandSegments as number[]),
            deliveryRequestId: finalDeliveryScope.requestId,
            expectedTools: params.expectedTools,
            partKeys: Object.freeze(partKeys),
            provenAtObservedSequence: capture.mutationSequence,
            requireNoOtherText: params.requireNoOtherText,
            textParts: Object.freeze(textParts),
            textMetadata: continuationContentMetadata(params.expectedText),
            textMode: params.textMode,
            toolExecutionOrdinals: Object.freeze(toolExecutionOrdinals),
            turnId,
          });
          return {
            asserted: true,
            continuationCount: sameTurnTextEntries.length,
            exactToolCallCount: records.length,
            exactToolCallsProven: true,
            responseErrorFreeAtAssertion: true,
            noTextBeforeToolsCompleteProven: params.requireNoOtherText,
            sequentialToolResultAcksProven: true,
          };
        }
      }
    }
    if (Date.now() - startedAt >= params.timeoutMs) {
      throw continuationTimeoutError(
        capture,
        params.expectedText,
        params.timeoutMs,
        "Exact sequential tool-plan assertion",
      );
    }
    await sleep(20);
  }
}

async function waitForOwnerPaintOpportunity(container: HTMLElement): Promise<void> {
  const ownerWindow = container.ownerDocument.defaultView;
  const requestFrame = ownerWindow?.requestAnimationFrame?.bind(ownerWindow);
  if (requestFrame) {
    await new Promise<void>((resolve) => {
      requestFrame(() => requestFrame(() => resolve()));
    });
  } else {
    await sleep(0);
    await sleep(0);
  }
  await sleep(0);
}

async function assertExactToolPlanCleanClose(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const proof = exactSequentialToolPlanProofs.get(ctx.app);
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!proof || !capture || proof.capture !== capture) {
    throw new DriverActionError(
      "Exact tool-plan clean close requires the original successful live proof.",
    );
  }
  const container = chatContainer(ctx.app);
  if (!container) throw new DriverActionError("Chat is not open.");
  await waitForOwnerPaintOpportunity(container);
  flushToolLifecycleCapture(capture);
  const view = activeChatView(ctx);
  const matchingTurns = [...container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant",
  )].filter((turn) => turn.dataset.turnId === proof.turnId);
  const turn = matchingTurns[0] ?? null;
  const responseErrorCount = sameTurnResponseErrorCount(capture, proof.turnId)
    + matchingTurns.reduce(
      (count, turn) => count
        + turn.querySelectorAll(".systemsculpt-agent-part.is-error").length,
      0,
    );
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    responseErrorCount !== 0
    || turn?.classList.contains("is-active") === true
    || (stop !== null && isVisible(stop))
  ) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not reach an error-free terminal render boundary.",
    );
  }
  if (view?.chatId !== proof.chatId || matchingTurns.length !== 1 || !turn) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven chat and assistant turn.",
    );
  }

  const capturedTextParts = capturedExactTextParts(capture, proof.turnId);
  const visibleTextMetadata = [...turn.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-part.is-text",
  )]
    .filter((part) => (part.textContent ?? "").trim().length > 0)
    .map((part) => continuationContentMetadata(part.textContent ?? ""));
  const expectedVisibleTextMetadata = proof.textParts.map((part) => part.textMetadata);
  const visibleTextMatches = expectedVisibleTextMetadata.length === visibleTextMetadata.length
    && expectedVisibleTextMetadata.every((metadata, index) => {
      const candidate = visibleTextMetadata[index];
      return candidate !== undefined && sameContinuationMetadata(metadata, candidate);
    });

  const records = orderedToolLifecycleRecords(
    [...capture.records.values()].filter((record) => record.turnId === proof.turnId),
  );
  const lateNonterminalObservation = records.some((record) =>
    record.transitions.some((transition) =>
      transition.observedSequence > proof.provenAtObservedSequence
      && transition.state !== "succeeded")
    || record.visualTransitions.some((transition) =>
      transition.observedSequence > proof.provenAtObservedSequence
      && !transition.settled));
  const exactRecordSurface = records.length === proof.expectedTools.length
    && records.every((record, index) => {
      const expected = proof.expectedTools[index];
      return expected !== undefined
        && firstCapturedToolCallCount(record) === 1
        && !record.identityConflict
        && record.partKey === proof.partKeys[index]
        && sameDevelopmentSemanticToolIdentity(
          expected,
          record.toolName,
          record.canonicalInput,
        )
        && toolLifecycleState(record.element) === "succeeded"
        && toolIsVisuallySettled(record.element, container);
    });
  const exactVisibleToolSurface = exactTerminalGroupedToolSurface(
    turn,
    container,
    proof.partKeys,
  );
  const cleanCloseChecks = {
    textProof: exactTextPartProofMatches(proof.textParts, capturedTextParts),
    visibleText: visibleTextMatches,
    recordSurface: exactRecordSurface,
    visibleToolSurface: exactVisibleToolSurface,
    toolOrder: toolsPrecedeTextOnExactSurface(turn, proof.requireNoOtherText),
    noLateNonterminal: !lateNonterminalObservation,
  };
  if (Object.values(cleanCloseChecks).some((passed) => !passed)) {
    const failedChecks = Object.entries(cleanCloseChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven terminal tool "
        + `and text surface (failed: ${failedChecks}; capturedTextParts=`
        + `${capturedTextParts.length}; visibleTextParts=`
        + `${visibleTextMetadata.length}).`,
    );
  }

  const currentDeliveryScope = bindToolResultDeliveryScope(
    currentRunSupportEvidence(capture),
    records,
    proof.expectedTools.length,
    proof.deliveryRequestId,
    true,
  );
  const currentCommandSegments = currentDeliveryScope.startedEvidence.map((evidence) =>
    resultDeliveryCommandProof(evidence).commandSegmentOrdinal);
  const currentToolExecutionOrdinals = currentDeliveryScope.startedEvidence.map(
    (evidence) => evidence.toolExecutionOrdinal,
  );
  const exactDeliverySurface = currentDeliveryScope.requestId === proof.deliveryRequestId
    && currentDeliveryScope.startedEvidence.every((evidence) =>
      evidence.acknowledgementSucceededCount === 1
      && evidence.acknowledgementFailedCount === 0
      && resultDeliveryCommandProof(evidence).valid)
    && currentCommandSegments.every((ordinal): ordinal is number => ordinal !== null)
    && new Set(currentCommandSegments).size === proof.expectedTools.length
    && sameOrdinalPlan(proof.commandSegmentOrdinals, currentCommandSegments)
    && sameOrdinalPlan(proof.toolExecutionOrdinals, currentToolExecutionOrdinals);
  if (!exactDeliverySurface) {
    throw new DriverActionError(
      "Exact tool-plan clean close did not preserve the proven request delivery boundary.",
    );
  }
  exactSequentialRegistrationProof(records, currentDeliveryScope);
  proof.cleanCloseProven = true;
  return {
    asserted: true,
    exactToolPlanCleanCloseProven: true,
    responseErrorCount: 0,
  };
}

async function assertNoClientToolsBeforeContinuation(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const expectedText = typeof params.text === "string" ? params.text.trim() : "";
  if (!expectedText) {
    throw new DriverActionError(
      "Exact continuation text is required for a zero-client-tool assertion.",
    );
  }
  const capture = toolLifecycleCaptures.get(ctx.app);
  if (!capture) {
    throw new DriverActionError(
      "A live tool-lifecycle capture must begin before the current run.",
    );
  }
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    if (!chatContainer(ctx.app)) throw new DriverActionError("Chat is not open.");
    flushToolLifecycleCapture(capture);
    const matchingContinuations = [...capture.continuationObservations]
      .filter(([textPart, observation]) =>
        observation.turnId !== null
        && (textPart.textContent ?? "").trim() === expectedText)
      .sort((left, right) => left[1].observedSequence - right[1].observedSequence);
    const continuationEntry = matchingContinuations[matchingContinuations.length - 1] ?? null;
    if (continuationEntry) {
      const continuationAt = continuationEntry[1];
      const sameTurnRecords = [...capture.records.values()].filter((record) =>
        record.turnId === continuationAt.turnId);
      const observedToolIdentityCount = sameTurnRecords.length;
      const observedToolCallCount = sameTurnRecords.reduce(
        (count, record) => count + record.callCount,
        0,
      );
      const currentSupportEvidence = currentRunSupportEvidence(capture);
      if (
        !capture.supportDiagnosticBaselineAvailable
        || !continuationAt.supportDiagnosticsAvailable
        || !currentSupportEvidence.supportDiagnosticsAvailable
      ) {
        throw new DriverActionError(
          "Support diagnostics were unavailable; zero client-tool activity cannot be proven.",
        );
      }
      const localToolExecutionCount = Math.max(
        continuationAt.localToolExecutionCount,
        currentSupportEvidence.localToolExecutionCount,
      );
      const toolResultAcknowledgedCount = Math.max(
        continuationAt.toolResultAcknowledgedCount,
        currentSupportEvidence.toolResultAcknowledgedCount,
      );
      const toolResultSentCount = Math.max(
        continuationAt.toolResultSentCount,
        currentSupportEvidence.toolResultSentCount,
      );
      const pendingCounts = developmentAgentPendingCounts(ctx);
      const evidence = {
        observedToolIdentityCount,
        observedToolCallCount,
        localToolExecutionCount,
        toolResultSentCount,
        toolResultAcknowledgedCount,
        ...pendingCounts,
      };
      if (Object.values(evidence).some((count) => count !== 0)) {
        throw new DriverActionError(
          `Expected zero client-tool activity before continuation: ${JSON.stringify(evidence)}.`,
        );
      }
      return {
        asserted: true,
        continuationObserved: true,
        ...evidence,
      };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        "Exact continuation text was not observed during the current tool-lifecycle capture.",
      );
    }
    await sleep(20);
  }
}

export const CHAT_TOOL_LIFECYCLE_ACTIONS: DriverActionHandlers = {
  "chat.beginToolLifecycleCapture": startToolLifecycleCapture,
  "chat.toolLifecycle": toolLifecycleReport,
  "chat.assertToolLifecycle": assertToolLifecycle,
  "chat.endToolLifecycleCapture": endToolLifecycleCapture,
  "chat.assertLatestToolSettledAfterContinuation": assertLatestToolSettledAfterContinuation,
  "chat.assertAllToolResultSendsCompleted": assertAllToolResultSendsCompleted,
  "chat.assertExactSequentialToolPlan": assertExactSequentialToolPlan,
  "chat.assertExactToolPlanCleanClose": assertExactToolPlanCleanClose,
  "chat.assertNoClientToolsBeforeContinuation": assertNoClientToolsBeforeContinuation,
};
