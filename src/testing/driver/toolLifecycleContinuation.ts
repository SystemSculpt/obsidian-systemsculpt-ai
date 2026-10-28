import {
  type ActionContext,
  activeChatView,
  DriverActionError,
  sleep,
  throwIfActionCancelled,
} from "./actionCore";
import { chatContainer } from "./locators";
import {
  capturedToolRowSnapshot,
  capturedTurnId,
  firstToolRecordObservation,
  flushToolLifecycleCapture,
  toolLifecycleReport,
} from "./toolLifecycleCapture";
import {
  continuationContentMetadata,
  firstCapturedToolCallCount,
  orderedToolLifecycleRecords,
  TOOL_TERMINAL_ICONS,
  type ToolContinuationEntry,
  type ToolContinuationObservation,
  toolIsVisuallySettled,
  type ToolLifecycleCapture,
  toolLifecycleCaptures,
  type ToolLifecycleRecord,
  type ToolLifecycleState,
  type ToolVisualTransition,
} from "./toolLifecycleState";
import {
  bindToolResultDeliveryScope,
  currentRunSupportEvidence,
  inspectEveryToolResultSendCompletion,
  proveEveryToolResultAcknowledgement,
  resultDeliveryCommandProof,
} from "./toolResultDelivery";

/** Assertions that bind captured tool completion to assistant continuation. */

export function capturedContinuationEntries(
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

export function matchingContinuationEntries(
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

export function continuationTimeoutError(
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

interface ContinuationOrderingProof {
  allToolResultProof: readonly Record<string, unknown>[];
  canonicalAcknowledgementProof: readonly Record<string, unknown>[];
  priorRecords: readonly ToolLifecycleRecord[];
  terminalToolCallCount: number;
  toolCallCount: number;
}

export function latestVisualTransitionAt(
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

export function proveContinuationOrdering(
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

export async function assertLatestToolSettledAfterContinuation(
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

export async function assertAllToolResultSendsCompleted(
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

export async function assertNoClientToolsBeforeContinuation(
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
