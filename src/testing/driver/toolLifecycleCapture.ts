import { canonicalAgentToolInput } from "../../chat/managed/MutationJournal";
import {
type ActionContext,
activeChatView,
DriverActionError
} from "./actionCore";
import { chatContainer } from "./locators";
import {
canonicalToolCallId,
exactSequentialToolPlanProofs,
ownerWindowNow,
toolCallCount,
type ToolContinuationObservation,
type ToolDomObservation,
toolIsVisuallySettled,
type ToolLifecycleCapture,
toolLifecycleCaptures,
type ToolLifecycleRecord,
toolLifecycleState,
type ToolRegistrationObservation,
type ToolResponseErrorObservation,
toolRowIsVisuallyTerminal,
toolRowSnapshot,
type ToolSurfaceTransition,
} from "./toolLifecycleState";
import {
currentRunSupportEvidence,
readSupportDiagnostics,
supportDiagnosticKey,
} from "./toolResultDelivery";

/** Live DOM observation, tool identity tracking, and capture reports. */

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

export function capturedTurnId(
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

export function capturedToolRowSnapshot(record: ToolLifecycleRecord): Record<string, unknown> {
  return {
    ...toolRowSnapshot(record.element),
    partKey: record.partKey,
  };
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

export function firstToolRecordObservation(record: ToolLifecycleRecord): ToolDomObservation | null {
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

export function flushToolLifecycleCapture(capture: ToolLifecycleCapture): void {
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
