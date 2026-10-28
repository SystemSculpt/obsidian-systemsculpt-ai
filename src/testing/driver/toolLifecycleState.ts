import type { App } from "obsidian";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import { sha256HexFromBytesPortable } from "../../utils/sha256";

/** Shared capture records and DOM identity primitives for live tool-lifecycle evidence. */

/**
 * Tool lifecycle capture for the chat. A capture watches the live chat DOM
 * from the moment it begins; the assertions then prove each tool's states,
 * its result delivery and the continuation that follows it.
 */

export function continuationContentMetadata(text: string): Readonly<{
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

export type ToolLifecycleState = typeof TOOL_LIFECYCLE_STATES[number];

export const TOOL_TERMINAL_ICONS: Partial<Record<ToolLifecycleState, string>> = {
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

export interface ToolVisualTransition {
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

export interface ToolDomObservation {
  mutationBatch: number;
  observedAtMs: number;
  observedSequence: number;
}

export interface ToolSupportEvidence {
  localToolExecutionCount: number;
  supportDiagnosticsAvailable: boolean;
  toolResultAcknowledgedCount: number;
  toolResultDeliveryEvidence: readonly ToolResultDeliveryEvidence[];
  toolResultSentCount: number;
}

export interface ToolContinuationObservation extends ToolDomObservation, ToolSupportEvidence {
  partKey: string;
  turnId: string | null;
}

export interface ToolRegistrationObservation extends ToolDomObservation, ToolSupportEvidence {}

export interface ToolResponseErrorObservation extends ToolDomObservation {
  turnId: string | null;
}

export type ToolContinuationEntry = [HTMLElement, ToolContinuationObservation];

export interface ToolResultDeliveryEvidence {
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

export interface ToolSurfaceTransition extends ToolDomObservation {
  terminalToolCallCount: number;
  toolCallCount: number;
  toolRowCount: number;
}

export interface ToolLifecycleRecord {
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

export interface ToolLifecycleCapture {
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

export function toolLifecycleState(element: HTMLElement): ToolLifecycleState | null {
  return TOOL_LIFECYCLE_STATES.find((state) => element.classList.contains(`is-${state}`)) ?? null;
}

export function toolCallCount(element: HTMLElement): number {
  const parsed = Number(element.dataset.toolCount ?? "1");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function exactTerminalRowCallCount(element: HTMLElement): number | null {
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

export function ownerWindowNow(container: HTMLElement): number {
  return container.ownerDocument.defaultView?.performance.now() ?? performance.now();
}

export function orderedToolLifecycleRecords(
  records: readonly ToolLifecycleRecord[],
): ToolLifecycleRecord[] {
  return [...records].sort((left, right) => {
    const leftSequence = left.registeredAt?.observedSequence ?? Number.MAX_SAFE_INTEGER;
    const rightSequence = right.registeredAt?.observedSequence ?? Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence;
  });
}

export function firstCapturedToolCallCount(record: ToolLifecycleRecord): number {
  return record.callCountTransitions[0]?.callCount ?? record.callCount;
}

export function canonicalToolCallId(partKey: string): string | null {
  if (!partKey.startsWith("tool:")) return null;
  const callId = partKey.slice("tool:".length);
  return callId.length > 0 ? callId : null;
}

export function toolRowIsVisuallyTerminal(element: HTMLElement): boolean {
  const snapshot = toolRowSnapshot(element);
  const state = snapshot.state as ToolLifecycleState | null;
  return state !== null
    && TOOL_TERMINAL_ICONS[state] === snapshot.stateIcon;
}

export function toolIsVisuallySettled(element: HTMLElement, container: HTMLElement): boolean {
  const agentStatus = container.querySelector(".systemsculpt-agent-tail-status")
    ?.getAttribute("data-status") ?? null;
  return toolRowIsVisuallyTerminal(element) && agentStatus !== "Working in vault";
}

export interface ExactSequentialToolExpectation {
  canonicalInput: string;
  toolName: string;
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

export interface ExactSequentialTextPartProof {
  partKey: string;
  textMetadata: Readonly<{ characters: number; sha256: string }>;
}

export const exactSequentialToolPlanProofs = new WeakMap<App, ExactSequentialToolPlanProof>();
