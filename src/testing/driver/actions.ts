import type { App } from "obsidian";

import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { sha256HexFromBytesPortable } from "../../studio/hash";
import type { ChatMessage } from "../../types";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import { canonicalAgentToolInput } from "../../views/chatview/agent/MutationJournal";
import { FILESYSTEM_LIMITS } from "../../tools/vault/constants";
import type { DriverDiagnostics } from "./diagnostics";
import {
  chatContainer,
  describeElement,
  isVisible,
  knownSemanticTargets,
  liveTestIdCatalog,
  queryChatElements,
  queryElements,
  resolveTarget,
} from "./locators";

/**
 * DOM-level action engine for the E2E test driver.
 *
 * Every action operates on the real rendered UI through synthesized user
 * events (pointer, keyboard, input, change, drop), never through service
 * shortcuts, so a scripted run exercises the same code paths as a human.
 */

export interface ActionContext {
  app: App;
  pluginId: string;
  pluginVersion: string;
  buildStamp: string;
  diagnostics: DriverDiagnostics;
  readSupportDiagnostics?: () => readonly SupportDiagnosticEvent[];
  signal?: AbortSignal;
  settingsRoot?: () => HTMLElement | null;
}

interface AppWithCommands extends App {
  commands: { executeCommandById(id: string): boolean };
}

interface AppWithSettings extends App {
  setting: {
    open(): void;
    close(): void;
    openTabById(id: string): unknown;
  };
}

class DriverActionError extends Error {}

function throwIfActionCancelled(ctx: ActionContext): void {
  if (ctx.signal?.aborted) throw new DriverActionError("Driver action cancelled.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export const DEVELOPMENT_TEST_ROOT = "SystemSculpt/Development Tests";
const DEVELOPMENT_TEST_PREFIX = `${DEVELOPMENT_TEST_ROOT}/`;
const DEVELOPMENT_MARKER_PATTERN = /^SS-DEV-TEST-[A-Z0-9]{2,64}$/;
const DEVELOPMENT_MARKER_HANDOFF_TIMEOUT_MS = 1000;

interface DevelopmentChatOwnership {
  approvalClearedAfterGrant: boolean;
  approvalGranted: boolean;
  approvedDevelopmentDirectories: Set<string>;
  approvedDevelopmentPaths: Map<string, string>;
  approvedDevelopmentRootEstablished: boolean;
  approvedMutationCount: number;
  approvedTrashArtifacts: Map<string, ApprovedDevelopmentTrashArtifact>;
  cleanupProgress: DevelopmentCleanupProgress | null;
  initialApprovalMode: string;
  marker: string;
  ownedChatId: string | null;
  previousChatId: string;
  runObserved: boolean;
  submissionBaseline: RunSubmissionBaseline | null;
  submissionAttempted: boolean;
  toolCaptureOwned: boolean;
  view: DevelopmentChatView;
}

interface DevelopmentChatOwnershipReceipt {
  readonly chatSha256: string;
  readonly chatPath: string;
  readonly initialApprovalMode: string;
  readonly marker: string;
  readonly ownedChatId: string;
  readonly previousChatId: string;
  readonly version: 1;
}

interface ApprovedDevelopmentTrashArtifact {
  readonly candidates: readonly string[];
  readonly expectedText: string;
  mirroredDirectoriesCleaned: boolean;
  restored: boolean;
  restoredCandidate: string | null;
  readonly sourcePath: string;
}

interface DevelopmentCleanupProgress {
  chatCleanupComplete: boolean;
  developmentPathCleanupComplete: boolean;
  draftCleared: boolean;
  ownedChatPath: string | null;
  removedAttachments: number;
  requestedDevelopmentPath: string | null;
  requestedTrashSavedChat: boolean;
  restorationComplete: boolean;
  stoppedRun: boolean;
  toolCaptureEnded: boolean;
  toolLifecycle: Record<string, unknown> | null;
  trashedChat: boolean;
  trashedDevelopmentPath: boolean;
  uiCleanupComplete: boolean;
}

const developmentChatOwners = new WeakMap<App, DevelopmentChatOwnership>();

const INCIDENT_REPORT_ID_PATTERN = /^report_(?!0{32}$)[a-f0-9]{32}$/u;
const INCIDENT_REPORT_DIRECTORY = ".systemsculpt/diagnostics/incidents";
const INCIDENT_REPORT_MAX_BYTES = 256 * 1024;

/**
 * Diagnostics-export attribution state. The harness may only trash a
 * snapshot it baselined, attributed as the single new export, and validated
 * against the allowlisted content-free schema. Evidence stays metadata-only.
 */
interface DiagnosticsExportAttribution {
  baseline: Set<string> | null;
  attributed: {
    readonly basename: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  } | null;
}

const diagnosticsExportAttributions = new WeakMap<App, DiagnosticsExportAttribution>();

const DIAGNOSTICS_EXPORT_DIRECTORY = ".systemsculpt/diagnostics";
const DIAGNOSTICS_EXPORT_BASENAME_PATTERN =
  /^diagnostics-\d{8}-\d{6}-[0-9a-f]{32}\.txt$/u;
const DIAGNOSTICS_SNAPSHOT_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "generated_at",
  "plugin_version",
  "obsidian_version",
  "status",
  "event_count",
  "events",
  "resource_sample_count",
  "resources",
]);

interface RunSubmissionBaseline {
  bannerFingerprint: string;
  fingerprint: string;
  submittedAtMs: number;
  turnCount: number;
}

const pendingRunSubmissions = new WeakMap<App, RunSubmissionBaseline>();

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

const toolLifecycleCaptures = new WeakMap<App, ToolLifecycleCapture>();

interface DevelopmentChatView {
  agent?: Readonly<{
    active?: Readonly<{
      approvalDecisions?: ReadonlyMap<string, unknown>;
      executingToolIds?: ReadonlySet<string>;
      toolIdentities?: ReadonlyMap<string, Readonly<{
        canonicalInput: string;
        toolName: string;
      }>>;
      toolTasks?: ReadonlyMap<string, unknown>;
    }> | null;
    pendingApprovalDeliveries?: ReadonlyMap<string, unknown>;
    pendingDeliveries?: ReadonlyMap<string, unknown>;
  }>;
  chatId: string;
  containerEl: HTMLElement;
  messages: readonly Readonly<ChatMessage>[];
  getChatHistoryFilePath(): string | null;
  getExpectedChatHistoryFilePath(): string | null;
  loadChatById(chatId: string): Promise<void>;
}

function activeChatView(ctx: ActionContext): DevelopmentChatView | null {
  const leaves = ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
  const active = ctx.app.workspace.activeLeaf;
  const leaf = active && leaves.includes(active) ? active : leaves.length === 1 ? leaves[0] : null;
  if (!leaf) return null;
  const view = leaf.view as Partial<DevelopmentChatView>;
  return typeof view.getChatHistoryFilePath === "function"
    && typeof view.getExpectedChatHistoryFilePath === "function"
    && typeof view.loadChatById === "function"
    && view.containerEl?.instanceOf(HTMLElement)
    ? view as DevelopmentChatView
    : null;
}

function requireTarget(ctx: ActionContext, target: unknown, fallback?: string): HTMLElement {
  const name = typeof target === "string" && target.trim().length > 0
    ? target
    : fallback;
  if (!name) throw new DriverActionError("A target is required for this action.");
  const element = resolveTarget(ctx, name);
  if (!element) {
    throw new DriverActionError(
      `Target "${name}" did not resolve. Targets are data-testid values (run the catalog ` +
        `action or npm run e2e -- targets), plus ${knownSemanticTargets().join(", ")} and ` +
        "css:, chat:, label:, testid: prefixes.",
    );
  }
  return element;
}

function pointerSequence(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.x + rect.width / 2);
  const clientY = Math.round(rect.y + rect.height / 2);
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY };
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent("mousedown", base));
  if (typeof PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerup", { ...base, isPrimary: true }));
  }
  element.dispatchEvent(new MouseEvent("mouseup", base));
  element.dispatchEvent(new MouseEvent("click", base));
}

function keyboardEventInit(params: Record<string, unknown>): KeyboardEventInit {
  const key = typeof params.key === "string" ? params.key : "";
  if (!key) throw new DriverActionError("press requires a key, e.g. Enter or Escape.");
  return {
    key,
    code: typeof params.code === "string" ? params.code : key === "Enter" ? "Enter" : undefined,
    shiftKey: params.shift === true,
    ctrlKey: params.ctrl === true,
    altKey: params.alt === true,
    metaKey: params.meta === true,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

function setNativeValue(element: HTMLElement, text: string, mode: "replace" | "append"): void {
  if (element.instanceOf(HTMLTextAreaElement) || element.instanceOf(HTMLInputElement)) {
    element.focus();
    element.value = mode === "append" ? element.value + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text }));
    return;
  }
  if (element.isContentEditable) {
    element.focus();
    element.textContent = mode === "append" ? (element.textContent ?? "") + text : text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: text }));
    return;
  }
  throw new DriverActionError("type targets must be a text input, textarea, or contenteditable element.");
}

function decodeBase64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function buildFile(params: Record<string, unknown>): File {
  const name = typeof params.name === "string" ? params.name : "";
  const mimeType = typeof params.mimeType === "string" ? params.mimeType : "application/octet-stream";
  const dataBase64 = typeof params.dataBase64 === "string" ? params.dataBase64 : "";
  if (!name) throw new DriverActionError("attach requires a file name.");
  if (!dataBase64) throw new DriverActionError("attach requires base64 file data.");
  const bytes = decodeBase64ToBytes(dataBase64);
  return new File([bytes.buffer as ArrayBuffer], name, { type: mimeType });
}

function validatedVaultPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new DriverActionError("A vault-relative file path is required.");
  }
  if (
    value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new DriverActionError("The vault file path is unsafe.");
  }
  return value;
}

function developmentMarkerFromPath(value: unknown, allowMarkerRoot = false): {
  marker: string;
  path: string;
} {
  const path = validatedVaultPath(value);
  if (!path.startsWith(DEVELOPMENT_TEST_PREFIX)) {
    throw new DriverActionError(
      `Development-test paths must use a unique marker under "${DEVELOPMENT_TEST_ROOT}".`,
    );
  }
  const segments = path.slice(DEVELOPMENT_TEST_PREFIX.length).split("/");
  const marker = segments[0] ?? "";
  if (
    !DEVELOPMENT_MARKER_PATTERN.test(marker)
    || (!allowMarkerRoot && segments.length === 1)
  ) {
    throw new DriverActionError(
      `Development-test paths must use "${DEVELOPMENT_TEST_ROOT}/SS-DEV-TEST-<ID>/...".`,
    );
  }
  return { marker, path };
}

function validatedDevelopmentMarker(value: unknown): string {
  if (typeof value !== "string" || !DEVELOPMENT_MARKER_PATTERN.test(value)) {
    throw new DriverActionError(
      "A marker matching SS-DEV-TEST-[A-Z0-9]{2,64} is required.",
    );
  }
  return value;
}

function containsExactDevelopmentMarker(text: string, marker: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${marker}([^A-Za-z0-9]|$)`).test(text);
}

function chatContainsDevelopmentMarker(
  container: HTMLElement,
  input: HTMLElement | null,
  marker: string,
): boolean {
  if (containsExactDevelopmentMarker(composerDraft(input), marker)) return true;
  return [...container.querySelectorAll(".systemsculpt-agent-turn")]
    .some((turn) => containsExactDevelopmentMarker(turn.textContent ?? "", marker));
}

function requireDevelopmentChatOwnership(ctx: ActionContext): DevelopmentChatOwnership {
  const ownership = developmentChatOwners.get(ctx.app);
  if (!ownership) {
    throw new DriverActionError("No development-test chat is owned.");
  }
  return ownership;
}

function claimDevelopmentChatId(ownership: DevelopmentChatOwnership): void {
  const chatId = ownership.view.chatId.trim();
  if (!chatId) return;
  if (!ownership.submissionAttempted && !ownership.runObserved) {
    throw new DriverActionError(
      "The development chat changed identity before the owned submission.",
    );
  }
  if (ownership.ownedChatId && ownership.ownedChatId !== chatId) {
    throw new DriverActionError("The owned development chat identity changed.");
  }
  ownership.ownedChatId = chatId;
}

function requireCurrentDevelopmentChatMarker(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): { container: HTMLElement; input: HTMLElement | null } {
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (
    activeChatView(ctx) !== ownership.view
    || !container
    || !input
    || !chatContainsDevelopmentMarker(container, input, ownership.marker)
  ) {
    throw new DriverActionError(
      "The active chat does not contain the owned development-test marker.",
    );
  }
  claimDevelopmentChatId(ownership);
  return { container, input };
}

/**
 * Send clears the composer synchronously, while the optimistic user turn may
 * enter the DOM on the next task. Bridge only that short, owned handoff. Once
 * the marker is visible again, the ordinary strict ownership check resumes.
 */
async function waitForSubmittedDevelopmentChatMarker(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  timeoutMs: number,
): Promise<void> {
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (activeChatView(ctx) !== ownership.view || !container || !input) {
    throw new DriverActionError(
      "The active chat does not contain the owned development-test marker.",
    );
  }
  const requestedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const handoffTimeoutMs = Math.min(
    requestedTimeoutMs,
    DEVELOPMENT_MARKER_HANDOFF_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const currentContainer = chatContainer(ctx.app);
    const currentInput = resolveTarget(ctx, "chat.composer.input");
    if (
      activeChatView(ctx) !== ownership.view
      || currentContainer !== container
      || currentInput !== input
    ) {
      throw new DriverActionError(
        "The active chat does not contain the owned development-test marker.",
      );
    }
    const currentChatId = ownership.view.chatId.trim();
    if (
      ownership.ownedChatId
      && currentChatId
      && ownership.ownedChatId !== currentChatId
    ) {
      throw new DriverActionError("The owned development chat identity changed.");
    }
    if (chatContainsDevelopmentMarker(container, input, ownership.marker)) {
      claimDevelopmentChatId(ownership);
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (
      !ownership.submissionAttempted
      || !ownership.submissionBaseline
      || elapsedMs >= handoffTimeoutMs
    ) {
      throw new DriverActionError(
        "The active chat does not contain the owned development-test marker.",
      );
    }
    await sleep(Math.min(20, Math.max(1, handoffTimeoutMs - elapsedMs)));
  }
}

function requireAskApprovalMode(ctx: ActionContext): void {
  const approval = resolveTarget(ctx, "chat.composer.approval-mode");
  if (!approval?.instanceOf(HTMLSelectElement) || approval.value !== "ask") {
    throw new DriverActionError("Live development tests require Ask approval mode.");
  }
}

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

function toolRowSnapshot(element: HTMLElement): Record<string, unknown> {
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

function canonicalToolCallId(partKey: string): string | null {
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

function startToolLifecycleCapture(ctx: ActionContext): Record<string, unknown> {
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

function toolLifecycleReport(ctx: ActionContext): Record<string, unknown> {
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

function endToolLifecycleCapture(ctx: ActionContext): Record<string, unknown> {
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
    && sameOrdinalPlan(proof.commandSegmentOrdinals, currentCommandSegments as number[])
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

function chatSnapshot(
  ctx: ActionContext,
  includeToolLifecycle = true,
): Record<string, unknown> {
  const container = chatContainer(ctx.app);
  if (!container) return { open: false };
  const text = (selector: string): string => {
    const element = container.querySelector(selector);
    return (element?.textContent ?? "").trim();
  };
  const turns: Array<Record<string, unknown>> = [];
  for (const turn of container.querySelectorAll(".systemsculpt-agent-turn")) {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of turn.querySelectorAll(".systemsculpt-agent-part")) {
      const element = part as HTMLElement;
      const kind = [...element.classList].find((cls) => cls.startsWith("is-")) ?? "part";
      parts.push({
        kind,
        text: (part.textContent ?? "").trim().slice(0, 2000),
        ...(element.classList.contains("is-tool") ? { tool: toolRowSnapshot(element) } : {}),
      });
    }
    const turnText = turn.textContent ?? "";
    turns.push({
      role: turn.classList.contains("is-assistant") ? "assistant"
        : turn.classList.contains("is-user") ? "user"
        : "unknown",
      active: turn.classList.contains("is-active"),
      text: turnText.trim().slice(0, 4000),
      textCharacters: turnText.length,
      parts,
    });
  }
  const input = container.querySelector("textarea.systemsculpt-agent-prompt-input");
  const send = container.querySelector("button.systemsculpt-agent-send");
  const stop = container.querySelector("button.systemsculpt-agent-stop");
  const approval = container.querySelector("select.systemsculpt-agent-approval-mode");
  const tailStatus = container.querySelector(".systemsculpt-agent-tail-status");
  const attachments: string[] = [];
  for (const item of container.querySelectorAll(".systemsculpt-agent-composer-attachments [role='listitem'], .systemsculpt-agent-composer-attachments > *")) {
    const label = (item.textContent ?? "").trim();
    if (label) attachments.push(label.slice(0, 200));
  }
  const banners: string[] = [];
  for (const banner of container.querySelectorAll(".systemsculpt-agent-banner")) {
    const label = (banner.textContent ?? "").trim();
    if (label) banners.push(label.slice(0, 500));
  }
  return {
    open: true,
    title: text(".systemsculpt-agent-header-title"),
    turnCount: turns.length,
    turns,
    banners,
    agentStatus: tailStatus?.getAttribute("data-status")
      ?? tailStatus?.querySelector(".systemsculpt-agent-tail-status-label")?.textContent?.trim()
      ?? null,
    toolLifecycle: includeToolLifecycle && toolLifecycleCaptures.has(ctx.app)
      ? toolLifecycleReport(ctx)
      : null,
    composer: {
      value: input?.instanceOf(HTMLTextAreaElement) ? input.value : "",
      sendDisabled: send?.instanceOf(HTMLButtonElement) ? send.disabled : null,
      stopVisible: stop?.instanceOf(HTMLElement) ? isVisible(stop) : false,
      approvalMode: approval?.instanceOf(HTMLSelectElement) ? approval.value : null,
      attachments,
    },
  };
}

function settingsSnapshot(ctx: ActionContext): Record<string, unknown> {
  const surface = resolveTarget(ctx, "settings.surface");
  if (!surface?.instanceOf(HTMLElement) || !isVisible(surface)) return { open: false };
  const tabs: Array<Record<string, unknown>> = [];
  const bar = surface.querySelector(".ss-settings-tab-bar");
  for (const button of bar?.querySelectorAll("button, [role='tab']") ?? []) {
    tabs.push({
      label: (button.textContent ?? "").trim(),
      active: button.classList.contains("is-active") ||
        button.getAttribute("aria-selected") === "true",
    });
  }
  const activePanel = surface.querySelector(".systemsculpt-tab-content.is-active");
  return {
    open: true,
    tabs,
    activePanelText: (activePanel?.textContent ?? "").trim().slice(0, 4000),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForVisibilitySafely(
  ctx: ActionContext,
  target: string,
  state: "visible" | "hidden",
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const element = resolveTarget(ctx, target);
    const visible = element !== null && isVisible(element);
    if ((state === "visible" && visible) || (state === "hidden" && !visible)) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(`Timed out waiting for ${target} to become ${state}.`);
    }
    await sleep(100);
  }
}

function composerDraft(input: HTMLElement | null): string {
  if (input?.instanceOf(HTMLTextAreaElement) || input?.instanceOf(HTMLInputElement)) {
    return input.value;
  }
  return input?.isContentEditable ? input.textContent ?? "" : "";
}

async function waitForFailedTurnRetryAdmission(
  ctx: ActionContext,
  priorUserTurn: HTMLElement | null,
  priorMessageId: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const stop = resolveTarget(ctx, "chat.composer.stop");
    if (stop && isVisible(stop)) return;
    const container = chatContainer(ctx.app);
    const currentUserTurns = container?.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-turn.is-user",
    );
    const currentUserTurn = currentUserTurns?.[currentUserTurns.length - 1] ?? null;
    const currentMessageId = currentUserTurn?.dataset.messageId ?? "";
    if (
      currentUserTurn
      && (
        currentUserTurn !== priorUserTurn
        || (priorMessageId.length > 0 && currentMessageId !== priorMessageId)
      )
    ) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("Retry did not admit a replacement failed turn.");
    }
    await sleep(20);
  }
}

async function waitForBlankDevelopmentChat(
  ctx: ActionContext,
  newChatLoaded: () => boolean,
  timeoutMs = 10000,
): Promise<HTMLSelectElement> {
  const startedAt = Date.now();
  for (;;) {
    const container = chatContainer(ctx.app);
    const input = resolveTarget(ctx, "chat.composer.input");
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const approval = resolveTarget(ctx, "chat.composer.approval-mode");
    const blank = container !== null
      && newChatLoaded()
      && input !== null
      && isVisible(input)
      && composerDraft(input).length === 0
      && (!stop || !isVisible(stop))
      && container.querySelectorAll(".systemsculpt-agent-turn").length === 0
      && container.querySelector(
        '[data-testid="chat.composer.attachment.remove"], '
          + '[data-testid="chat.composer.attachment.unpin"]',
      ) === null
      && approval?.instanceOf(HTMLSelectElement);
    if (blank && approval?.instanceOf(HTMLSelectElement)) return approval;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("New Chat did not establish a blank development-test chat.");
    }
    await sleep(100);
  }
}

async function openBlankDevelopmentChat(
  ctx: ActionContext,
  view: DevelopmentChatView,
  newChat: HTMLElement,
): Promise<HTMLSelectElement> {
  let loaded = false;
  // The old composer can already look blank while New Chat is still awaiting
  // session replacement. Its lifecycle event follows the final draft reset.
  const loadedRef = ctx.app.workspace.on("systemsculpt:chat-loaded", (chatId) => {
    if (chatId === "" && activeChatView(ctx) === view) loaded = true;
  });
  try {
    newChat.scrollIntoView({ block: "nearest" });
    pointerSequence(newChat);
    return await waitForBlankDevelopmentChat(ctx, () => loaded);
  } finally {
    ctx.app.workspace.offref(loadedRef);
  }
}

function selectValue(element: HTMLSelectElement, value: string): void {
  const options = [...element.options].map((option) => option.value);
  if (!options.includes(value)) {
    throw new DriverActionError("The required approval mode is unavailable.");
  }
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function restoreDevelopmentChat(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): Promise<void> {
  if (ownership.previousChatId) {
    await ownership.view.loadChatById(ownership.previousChatId);
    return;
  }
  const newChat = requireTarget(ctx, "chat.header.new");
  const approval = await openBlankDevelopmentChat(ctx, ownership.view, newChat);
  if (approval.value !== ownership.initialApprovalMode) {
    selectValue(approval, ownership.initialApprovalMode);
  }
}

async function beginDevelopmentChat(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const marker = validatedDevelopmentMarker(params.marker);
  if (developmentChatOwners.has(ctx.app)) {
    throw new DriverActionError("A development-test chat is already owned.");
  }
  const developmentRoot = `${DEVELOPMENT_TEST_PREFIX}${marker}`;
  if (ctx.app.vault.getAbstractFileByPath(developmentRoot)) {
    throw new DriverActionError(
      `Refusing to reuse the existing development-test root "${developmentRoot}".`,
    );
  }
  const view = activeChatView(ctx);
  if (!view) throw new DriverActionError("Chat must be open before starting a development test.");
  const previousChatId = view.chatId;
  const container = chatContainer(ctx.app);
  if (!container) throw new DriverActionError("Chat must be open before starting a development test.");
  const input = resolveTarget(ctx, "chat.composer.input");
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (stop && isVisible(stop)) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has an active run.",
    );
  }
  if (composerDraft(input).length > 0) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has a draft.",
    );
  }
  if (container.querySelector(
    '[data-testid="chat.composer.attachment.remove"], '
      + '[data-testid="chat.composer.attachment.unpin"]',
  )) {
    throw new DriverActionError(
      "Refusing to start a development test while the current chat has attachments.",
    );
  }
  if (!previousChatId && container.querySelectorAll(".systemsculpt-agent-turn").length > 0) {
    throw new DriverActionError(
      "Refusing to replace an unsaved chat that already contains messages.",
    );
  }
  const currentApproval = resolveTarget(ctx, "chat.composer.approval-mode");
  if (!currentApproval?.instanceOf(HTMLSelectElement)) {
    throw new DriverActionError("The current chat approval mode is unavailable.");
  }

  const newChat = requireTarget(ctx, "chat.header.new");
  const ownership: DevelopmentChatOwnership = {
    approvalClearedAfterGrant: false,
    approvalGranted: false,
    approvedDevelopmentDirectories: new Set(),
    approvedDevelopmentPaths: new Map(),
    approvedDevelopmentRootEstablished: false,
    approvedMutationCount: 0,
    approvedTrashArtifacts: new Map(),
    cleanupProgress: null,
    initialApprovalMode: currentApproval.value,
    marker,
    ownedChatId: null,
    previousChatId,
    runObserved: false,
    submissionBaseline: null,
    submissionAttempted: false,
    toolCaptureOwned: false,
    view,
  };
  developmentChatOwners.set(ctx.app, ownership);
  try {
    const approval = await openBlankDevelopmentChat(ctx, view, newChat);
    if (approval.value !== "ask") selectValue(approval, "ask");
    const ownedInput = requireTarget(ctx, "chat.composer.input");
    setNativeValue(ownedInput, marker, "replace");
    if (!toolLifecycleCaptures.has(ctx.app)) {
      startToolLifecycleCapture(ctx);
      ownership.toolCaptureOwned = true;
    }
    return { owned: true, composerReady: true, markerInstalled: true };
  } catch (error) {
    let restoreError: unknown = null;
    try {
      await restoreDevelopmentChat(ctx, ownership);
    } catch (failure) {
      restoreError = failure;
    } finally {
      if (ownership.toolCaptureOwned) endToolLifecycleCapture(ctx);
      pendingRunSubmissions.delete(ctx.app);
      developmentChatOwners.delete(ctx.app);
    }
    if (restoreError) {
      throw new DriverActionError(
        `Development-chat setup failed: ${errorMessage(error)} `
          + `Previous-chat restoration failed: ${errorMessage(restoreError)}`,
      );
    }
    throw error;
  }
}

function typeDevelopmentDraft(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const input = requireTarget(ctx, "chat.composer.input");
  requireCurrentDevelopmentChatMarker(ctx, ownership);
  if (typeof params.text !== "string" || params.text.trim().length === 0) {
    throw new DriverActionError("chat.typeDevelopmentDraft requires text.");
  }
  const text = `${ownership.marker} ${params.text.trim()}`;
  setNativeValue(input, text, "replace");
  if (params.submit === true) {
    requireAskApprovalMode(ctx);
    const send = requireTarget(ctx, "chat.composer.send");
    if (!send.instanceOf(HTMLButtonElement) || send.disabled) {
      throw new DriverActionError("The development-test message is not ready to send.");
    }
    ownership.approvalClearedAfterGrant = false;
    ownership.approvalGranted = false;
    ownership.runObserved = false;
    ownership.submissionAttempted = true;
    const submissionBaseline = captureRunSubmissionBaseline(ctx);
    pointerSequence(send);
    ownership.submissionBaseline = submissionBaseline;
    pendingRunSubmissions.set(ctx.app, submissionBaseline);
    claimDevelopmentChatId(ownership);
  }
  return { characters: text.length, submitted: params.submit === true };
}

async function waitForDisconnect(element: HTMLElement, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (element.isConnected) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError("Timed out removing a development-test attachment.");
    }
    await sleep(50);
  }
}

interface DevelopmentVaultNode {
  children?: unknown;
  path: string;
}

function asDevelopmentVaultNode(value: unknown): DevelopmentVaultNode {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { path?: unknown }).path !== "string"
  ) {
    throw new DriverActionError("Development cleanup could not inspect the marker folder tree.");
  }
  return value as DevelopmentVaultNode;
}

function addApprovedDevelopmentDirectories(
  directories: Set<string>,
  rootPath: string,
  path: string,
  includePath: boolean,
): void {
  if (!path.startsWith(`${rootPath}/`)) {
    throw new DriverActionError("Approved development state escaped its marker root.");
  }
  const segments = path.slice(rootPath.length + 1).split("/");
  let directory = rootPath;
  const directorySegments = includePath ? segments : segments.slice(0, -1);
  for (const segment of directorySegments) {
    directory = `${directory}/${segment}`;
    directories.add(directory);
  }
}

function recordApprovedDevelopmentFile(
  ownership: DevelopmentChatOwnership,
  path: string,
  text: string,
): void {
  const rootPath = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  addApprovedDevelopmentDirectories(
    ownership.approvedDevelopmentDirectories,
    rootPath,
    path,
    false,
  );
  ownership.approvedDevelopmentPaths.set(path, text);
  ownership.approvedDevelopmentRootEstablished = true;
}

function exactDevelopmentTreePaths(rootValue: unknown, rootPath: string): {
  directoryPaths: string[];
  leafPaths: string[];
} {
  const root = asDevelopmentVaultNode(rootValue);
  if (root.path !== rootPath || !Array.isArray(root.children)) {
    throw new DriverActionError(
      "Refusing to trash a development root whose descendants cannot be proven.",
    );
  }
  const directoryPaths: string[] = [];
  const leaves: string[] = [];
  const visit = (value: unknown, parentPath: string): void => {
    const node = asDevelopmentVaultNode(value);
    const directChild = node.path.startsWith(`${parentPath}/`)
      && !node.path.slice(parentPath.length + 1).includes("/");
    if (!directChild) {
      throw new DriverActionError(
        "Refusing to trash a development root containing an out-of-scope descendant.",
      );
    }
    if (Array.isArray(node.children)) {
      directoryPaths.push(node.path);
      for (const child of node.children) visit(child, node.path);
      return;
    }
    leaves.push(node.path);
  };
  for (const child of root.children) visit(child, rootPath);
  return { directoryPaths, leafPaths: leaves };
}

async function proveExactApprovedDevelopmentTree(
  ctx: ActionContext,
  rootValue: unknown,
  rootPath: string,
  approved: Map<string, string>,
  approvedDirectories: ReadonlySet<string>,
  rootEstablished: boolean,
): Promise<void> {
  if (!rootEstablished) {
    throw new DriverActionError(
      "Refusing to trash a development root without an owned approved write.",
    );
  }
  const { directoryPaths, leafPaths } = exactDevelopmentTreePaths(rootValue, rootPath);
  const uniqueLeaves = new Set(leafPaths);
  const uniqueDirectories = new Set(directoryPaths);
  if (
    uniqueLeaves.size !== leafPaths.length
    || uniqueDirectories.size !== directoryPaths.length
    || [...uniqueLeaves].some((path) => uniqueDirectories.has(path))
    || uniqueLeaves.size !== approved.size
    || [...uniqueLeaves].some((path) => !approved.has(path))
    || uniqueDirectories.size !== approvedDirectories.size
    || [...uniqueDirectories].some((path) => !approvedDirectories.has(path))
  ) {
    throw new DriverActionError(
      "Refusing to trash a development root with unapproved or missing descendants.",
    );
  }
  for (const [path, expectedText] of approved) {
    const actual = await ctx.app.vault.adapter.read(path);
    if (actual !== expectedText) {
      throw new DriverActionError(
        `Refusing to trash development content that no longer matches its approved write: "${path}".`,
      );
    }
  }
}

async function waitForOwnedHistoryEntry(
  ctx: ActionContext,
  ownedChatId: string,
  timeoutMs: number,
): Promise<HTMLElement> {
  const expectedEntryId = `chat:${ownedChatId}`;
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const rows = queryElements(
      ctx,
      '.systemsculpt-history-item[data-kind="chat"]',
    ).filter(isVisible);
    if (rows.length === 1 && rows[0]?.dataset.entryId === expectedEntryId) {
      return rows[0];
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        "Visible history did not resolve the exact owned development-test chat.",
      );
    }
    await sleep(50);
  }
}

/**
 * Reopens the exact marker-owned chat by clicking its visible history row.
 * The history provider owns leaf selection and disk-backed resume behavior,
 * matching the path a person exercises from the modal.
 */
async function reopenOwnedDevelopmentHistory(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  const ownedChatId = ownership.ownedChatId;
  if (!ownedChatId || ownership.view.chatId !== ownedChatId) {
    throw new DriverActionError(
      "The development run has not claimed an exact saved-chat identity.",
    );
  }
  const expectedPath = ownership.view.getExpectedChatHistoryFilePath();
  if (!expectedPath || ownership.view.getChatHistoryFilePath() !== expectedPath) {
    throw new DriverActionError(
      "The owned development-test chat is not durably saved yet.",
    );
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (stop && isVisible(stop)) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with an active run.",
    );
  }
  const input = resolveTarget(ctx, "chat.composer.input");
  if (composerDraft(input).length > 0) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with a draft.",
    );
  }
  if (container.querySelector(
    '[data-testid="chat.composer.attachment.remove"], '
      + '[data-testid="chat.composer.attachment.unpin"]',
  )) {
    throw new DriverActionError(
      "Refusing to reload an owned development-test chat with attachments.",
    );
  }

  const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.max(0, params.timeoutMs)
    : 10000;
  let restored = false;
  try {
    const newChat = requireTarget(ctx, "chat.header.new");
    await openBlankDevelopmentChat(ctx, ownership.view, newChat);

    const history = requireTarget(ctx, "chat.header.history");
    history.scrollIntoView({ block: "nearest" });
    pointerSequence(history);
    await waitForCondition(ctx, {
      target: "history.search",
      state: "visible",
      timeoutMs,
    });
    const search = requireTarget(ctx, "history.search");
    setNativeValue(search, ownership.marker, "replace");
    const ownedHistoryEntry = await waitForOwnedHistoryEntry(ctx, ownedChatId, timeoutMs);

    let loaded = false;
    const loadedRef = ctx.app.workspace.on("systemsculpt:chat-loaded", (chatId) => {
      if (chatId === ownedChatId && activeChatView(ctx) === ownership.view) loaded = true;
    });
    try {
      ownedHistoryEntry.scrollIntoView({ block: "nearest" });
      pointerSequence(ownedHistoryEntry);
      const startedAt = Date.now();
      while (!loaded) {
        throwIfActionCancelled(ctx);
        if (Date.now() - startedAt >= timeoutMs) {
          throw new DriverActionError(
            "The exact owned development-test history row did not emit its loaded event.",
          );
        }
        await sleep(50);
      }
      await waitForVisibilitySafely(ctx, "history.close", "hidden", timeoutMs);
    } finally {
      ctx.app.workspace.offref(loadedRef);
    }
    requireCurrentDevelopmentChatMarker(ctx, ownership);
    if (
      ownership.view.chatId !== ownedChatId
      || ownership.view.getExpectedChatHistoryFilePath() !== expectedPath
      || ownership.view.getChatHistoryFilePath() !== expectedPath
    ) {
      throw new DriverActionError(
        "The reopened development-test chat did not preserve its exact saved identity.",
      );
    }
    restored = true;
    return {
      reopened: true,
      visibleHistoryMatched: true,
      exactIdentityPreserved: true,
      markerRestored: true,
    };
  } catch (error) {
    const close = resolveTarget(ctx, "history.close");
    if (close && isVisible(close)) pointerSequence(close);
    if (!restored) {
      try {
        await ownership.view.loadChatById(ownedChatId);
        requireCurrentDevelopmentChatMarker(ctx, ownership);
      } catch (recoveryError) {
        throw new DriverActionError(
          `Owned-history reopen failed: ${errorMessage(error)} `
            + `Owned-chat recovery failed: ${errorMessage(recoveryError)}`,
        );
      }
    }
    throw error;
  }
}

function exactReceiptRecord(value: unknown): DevelopmentChatOwnershipReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "chatPath",
    "chatSha256",
    "initialApprovalMode",
    "marker",
    "ownedChatId",
    "previousChatId",
    "version",
  ];
  if (
    Object.keys(receipt).length !== expectedKeys.length
    || expectedKeys.some((key) => !(key in receipt))
    || receipt.version !== 1
    || typeof receipt.ownedChatId !== "string"
    || receipt.ownedChatId.length === 0
    || receipt.ownedChatId.length > 256
    || receipt.ownedChatId.includes("/")
    || receipt.ownedChatId.includes("\\")
    || typeof receipt.previousChatId !== "string"
    || receipt.previousChatId.length > 256
    || receipt.previousChatId.includes("/")
    || receipt.previousChatId.includes("\\")
    || receipt.previousChatId === receipt.ownedChatId
    || typeof receipt.initialApprovalMode !== "string"
    || receipt.initialApprovalMode.length === 0
    || receipt.initialApprovalMode.length > 64
    || typeof receipt.chatSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(receipt.chatSha256)
  ) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  const marker = validatedDevelopmentMarker(receipt.marker);
  const chatPath = validatedVaultPath(receipt.chatPath);
  if (!chatPath.endsWith(".md")) {
    throw new DriverActionError("The development ownership receipt is invalid.");
  }
  return {
    version: 1,
    marker,
    ownedChatId: receipt.ownedChatId,
    previousChatId: receipt.previousChatId,
    initialApprovalMode: receipt.initialApprovalMode,
    chatPath,
    chatSha256: receipt.chatSha256,
  };
}

async function exportDevelopmentOwnershipReceipt(
  ctx: ActionContext,
): Promise<DevelopmentChatOwnershipReceipt> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container, input } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  if (
    ownership.cleanupProgress
    || ownership.approvedMutationCount !== 0
    || ownership.approvedDevelopmentPaths.size !== 0
    || ownership.approvedDevelopmentDirectories.size !== 0
    || ownership.approvedTrashArtifacts.size !== 0
  ) {
    throw new DriverActionError(
      "Development ownership can cross a reload only before cleanup and without vault mutations.",
    );
  }
  const ownedChatId = ownership.ownedChatId;
  const chatPath = ownership.view.getChatHistoryFilePath();
  if (
    !ownedChatId
    || ownership.view.chatId !== ownedChatId
    || !chatPath
    || ownership.view.getExpectedChatHistoryFilePath() !== chatPath
  ) {
    throw new DriverActionError("The owned development chat is not durably saved.");
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    (stop && isVisible(stop))
    || composerDraft(input).length > 0
    || container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    )
  ) {
    throw new DriverActionError("The owned development chat is not idle for reload.");
  }
  const text = await ctx.app.vault.adapter.read(chatPath);
  if (
    !containsExactDevelopmentMarker(text, ownership.marker)
    || !text.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
  ) {
    throw new DriverActionError("The saved development chat does not match its ownership proof.");
  }
  if (ownership.toolCaptureOwned) {
    endToolLifecycleCapture(ctx);
    ownership.toolCaptureOwned = false;
  }
  return {
    version: 1,
    marker: ownership.marker,
    ownedChatId,
    previousChatId: ownership.previousChatId,
    initialApprovalMode: ownership.initialApprovalMode,
    chatPath,
    chatSha256: sha256OfText(text),
  };
}

async function importDevelopmentOwnershipReceipt(
  ctx: ActionContext,
  value: unknown,
): Promise<Record<string, unknown>> {
  const receipt = exactReceiptRecord(value);
  const existing = developmentChatOwners.get(ctx.app);
  const view = existing?.view ?? activeChatView(ctx);
  if (!view) throw new DriverActionError("Chat must be open before restoring development ownership.");
  if (existing) {
    if (
      existing.marker !== receipt.marker
      || existing.ownedChatId !== receipt.ownedChatId
      || existing.previousChatId !== receipt.previousChatId
      || existing.initialApprovalMode !== receipt.initialApprovalMode
      || existing.view.getExpectedChatHistoryFilePath() !== receipt.chatPath
    ) {
      throw new DriverActionError("A different development-test chat is already owned.");
    }
  }
  if (view.chatId !== receipt.ownedChatId) await view.loadChatById(receipt.ownedChatId);
  if (
    activeChatView(ctx) !== view
    || view.chatId !== receipt.ownedChatId
    || view.getExpectedChatHistoryFilePath() !== receipt.chatPath
    || view.getChatHistoryFilePath() !== receipt.chatPath
  ) {
    throw new DriverActionError("The reloaded chat does not match its ownership proof.");
  }
  const text = await ctx.app.vault.adapter.read(receipt.chatPath);
  if (
    sha256OfText(text) !== receipt.chatSha256
    || !containsExactDevelopmentMarker(text, receipt.marker)
    || !text.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
  ) {
    throw new DriverActionError("The reloaded chat changed since its ownership proof.");
  }
  const container = chatContainer(ctx.app);
  const input = resolveTarget(ctx, "chat.composer.input");
  if (
    activeChatView(ctx) !== view
    || !container
    || !input
    || !chatContainsDevelopmentMarker(container, input, receipt.marker)
  ) {
    throw new DriverActionError("The reloaded chat does not contain its ownership marker.");
  }
  const stop = resolveTarget(ctx, "chat.composer.stop");
  if (
    (stop && isVisible(stop))
    || composerDraft(input).length > 0
    || container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    )
  ) {
    throw new DriverActionError("The reloaded development chat is not idle.");
  }
  const approval = resolveTarget(ctx, "chat.composer.approval-mode");
  if (
    !approval?.instanceOf(HTMLSelectElement)
    || ![...approval.options].some((option) => option.value === receipt.initialApprovalMode)
  ) {
    throw new DriverActionError("The prior approval mode cannot be restored safely.");
  }
  if (existing) {
    return {
      restored: true,
      alreadyOwned: true,
      exactChatBytesPreserved: true,
      markerRestored: true,
    };
  }
  developmentChatOwners.set(ctx.app, {
    approvalClearedAfterGrant: false,
    approvalGranted: false,
    approvedDevelopmentDirectories: new Set(),
    approvedDevelopmentPaths: new Map(),
    approvedDevelopmentRootEstablished: false,
    approvedMutationCount: 0,
    approvedTrashArtifacts: new Map(),
    cleanupProgress: null,
    initialApprovalMode: receipt.initialApprovalMode,
    marker: receipt.marker,
    ownedChatId: receipt.ownedChatId,
    previousChatId: receipt.previousChatId,
    runObserved: true,
    submissionBaseline: null,
    submissionAttempted: true,
    toolCaptureOwned: false,
    view,
  });
  return {
    restored: true,
    exactChatBytesPreserved: true,
    markerRestored: true,
  };
}

async function readCopiedIncidentReport(
  ctx: ActionContext,
): Promise<Readonly<{ reportId: string; serialized: string }>> {
  const ownerWindow = chatContainer(ctx.app)?.ownerDocument.defaultView ?? window;
  const clipboard = ownerWindow.navigator.clipboard;
  const readText = clipboard?.readText;
  if (typeof readText !== "function") {
    throw new DriverActionError("Clipboard reading is unavailable in this development build.");
  }
  let serialized: string;
  try {
    serialized = await readText.call(clipboard);
  } catch {
    throw new DriverActionError("The copied incident report could not be read.");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes === 0 || bytes > INCIDENT_REPORT_MAX_BYTES) {
    throw new DriverActionError("The copied incident report has an invalid size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new DriverActionError("The copied incident report is not valid JSON.");
  }
  const reportId = typeof parsed === "object"
    && parsed !== null
    && !Array.isArray(parsed)
    && typeof (parsed as { report_id?: unknown }).report_id === "string"
    ? (parsed as { report_id: string }).report_id
    : "";
  if (!INCIDENT_REPORT_ID_PATTERN.test(reportId)) {
    throw new DriverActionError("The copied incident report has an invalid identity.");
  }
  let persisted: string;
  try {
    persisted = await ctx.app.vault.adapter.read(
      `${INCIDENT_REPORT_DIRECTORY}/${reportId}.json`,
    );
  } catch {
    throw new DriverActionError("The copied incident report is not durably stored.");
  }
  if (persisted !== serialized) {
    throw new DriverActionError("The copied incident report differs from its stored bytes.");
  }
  return { reportId, serialized };
}

function developmentCleanupProgress(
  ownership: DevelopmentChatOwnership,
  requestedTrashSavedChat: boolean,
  requestedDevelopmentPath: string | null,
): DevelopmentCleanupProgress {
  const existing = ownership.cleanupProgress;
  if (existing) {
    if (
      existing.requestedTrashSavedChat !== requestedTrashSavedChat
      || existing.requestedDevelopmentPath !== requestedDevelopmentPath
    ) {
      throw new DriverActionError(
        "A retry must use the exact cleanup request already bound to this development-test chat.",
      );
    }
    return existing;
  }
  const progress: DevelopmentCleanupProgress = {
    chatCleanupComplete: !requestedTrashSavedChat,
    developmentPathCleanupComplete: requestedDevelopmentPath === null,
    draftCleared: false,
    ownedChatPath: null,
    removedAttachments: 0,
    requestedDevelopmentPath,
    requestedTrashSavedChat,
    restorationComplete: false,
    stoppedRun: false,
    toolCaptureEnded: false,
    toolLifecycle: null,
    trashedChat: false,
    trashedDevelopmentPath: false,
    uiCleanupComplete: false,
  };
  ownership.cleanupProgress = progress;
  return progress;
}

function finishDevelopmentToolCapture(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  progress: DevelopmentCleanupProgress,
): void {
  if (progress.toolCaptureEnded) return;
  if (!toolLifecycleCaptures.has(ctx.app)) {
    ownership.toolCaptureOwned = false;
    progress.toolCaptureEnded = true;
    return;
  }
  if (!ownership.toolCaptureOwned) {
    progress.toolLifecycle = toolLifecycleReport(ctx);
    progress.toolCaptureEnded = true;
    return;
  }
  try {
    progress.toolLifecycle = endToolLifecycleCapture(ctx);
  } finally {
    ownership.toolCaptureOwned = false;
    progress.toolCaptureEnded = true;
  }
}

async function resetDevelopmentChatState(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const marker = validatedDevelopmentMarker(params.marker);
  if (params.requireOwned !== undefined && typeof params.requireOwned !== "boolean") {
    throw new DriverActionError("requireOwned must be a boolean.");
  }
  const ownership = developmentChatOwners.get(ctx.app);
  if (!ownership) {
    if (params.requireOwned === true) {
      throw new DriverActionError(
        "The exact development-test ownership proof is unavailable; cleanup did not run.",
      );
    }
    return { owned: false, skipped: true };
  }
  if (ownership.marker !== marker) {
    throw new DriverActionError(
      "The cleanup marker does not match the owned development-test chat.",
    );
  }
  const trashDevelopmentPath = params.trashDevelopmentPath === undefined
    ? null
    : developmentMarkerFromPath(params.trashDevelopmentPath, true);
  const expectedDevelopmentRoot = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (
    trashDevelopmentPath
    && (
      trashDevelopmentPath.marker !== ownership.marker
      || trashDevelopmentPath.path !== expectedDevelopmentRoot
    )
  ) {
    throw new DriverActionError(
      "Development cleanup may trash only the exact owned marker folder.",
    );
  }
  if (ownership.approvedMutationCount > 0 && !trashDevelopmentPath) {
    throw new DriverActionError(
      "Approved development mutations require cleanup of the exact owned marker folder.",
    );
  }
  const progress = developmentCleanupProgress(
    ownership,
    params.trashSavedChat === true,
    trashDevelopmentPath?.path ?? null,
  );
  let captureError: unknown = null;
  try {
    finishDevelopmentToolCapture(ctx, ownership, progress);
  } catch (error) {
    captureError = error;
  }
  pendingRunSubmissions.delete(ctx.app);

  if (!progress.uiCleanupComplete) {
    const container = chatContainer(ctx.app);
    if (!container || activeChatView(ctx) !== ownership.view) {
      throw new DriverActionError(
        "The owned development-test chat is no longer open for cleanup; ownership was retained for retry.",
      );
    }
    const input = resolveTarget(ctx, "chat.composer.input");
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const hasAttachments = container.querySelector(
      '[data-testid="chat.composer.attachment.remove"], '
        + '[data-testid="chat.composer.attachment.unpin"]',
    ) !== null;
    const untouched = composerDraft(input).length === 0
      && container.querySelectorAll(".systemsculpt-agent-turn").length === 0
      && (!stop || !isVisible(stop))
      && !hasAttachments;
    const marked = input !== null
      && chatContainsDevelopmentMarker(container, input, ownership.marker);
    if (!marked && !untouched) {
      throw new DriverActionError(
        "Refusing cleanup because the active chat is not the owned development-test chat; "
          + "ownership was retained for retry.",
      );
    }

    if (stop && isVisible(stop)) {
      requireCurrentDevelopmentChatMarker(ctx, ownership);
      if (!progress.stoppedRun) {
        pointerSequence(stop);
        progress.stoppedRun = true;
      }
      await waitForVisibilitySafely(ctx, "chat.composer.stop", "hidden", 15000);
    }

    for (;;) {
      const remove = container.querySelector(
        '[data-testid="chat.composer.attachment.remove"]',
      );
      if (!remove?.instanceOf(HTMLElement)) break;
      requireCurrentDevelopmentChatMarker(ctx, ownership);
      pointerSequence(remove);
      await waitForDisconnect(remove, 5000);
      progress.removedAttachments += 1;
    }

    if (marked && !progress.draftCleared) {
      const current = requireCurrentDevelopmentChatMarker(ctx, ownership).input;
      if (
        (current?.instanceOf(HTMLTextAreaElement) || current?.instanceOf(HTMLInputElement))
        && (current.disabled || current.readOnly)
      ) {
        throw new DriverActionError("The development-test composer input cannot be cleared.");
      }
      if (!current) {
        throw new DriverActionError("The development-test composer input is unavailable.");
      }
      setNativeValue(current, "", "replace");
      progress.draftCleared = true;
    }
    progress.uiCleanupComplete = true;
  }

  let cleanupError: unknown = captureError;
  let restoreError: unknown = null;
  if (!progress.chatCleanupComplete) {
    try {
      if (!progress.ownedChatPath) {
        if (!ownership.ownedChatId || ownership.view.chatId !== ownership.ownedChatId) {
          throw new DriverActionError(
            "Refusing to trash a chat whose identity was not owned by this development run.",
          );
        }
        const startedAt = Date.now();
        let path = ownership.view.getChatHistoryFilePath();
        const expectedPath = ownership.view.getExpectedChatHistoryFilePath();
        const shouldWaitForSave = ownership.submissionAttempted
          || ownership.runObserved
          || expectedPath !== null;
        while (!path && shouldWaitForSave && Date.now() - startedAt < 5000) {
          await sleep(100);
          path = ownership.view.getChatHistoryFilePath();
        }
        if (!path && shouldWaitForSave) {
          throw new DriverActionError(
            "The observed development run did not produce a saved chat for cleanup.",
          );
        }
        if (path && path !== ownership.view.getExpectedChatHistoryFilePath()) {
          throw new DriverActionError("The owned development chat path changed during cleanup.");
        }
        progress.ownedChatPath = path;
      }
      const path = progress.ownedChatPath;
      if (path) {
        const file = ctx.app.vault.getAbstractFileByPath(path);
        if (!file) {
          if (!progress.trashedChat) {
            throw new DriverActionError("The owned development chat disappeared during cleanup.");
          }
        } else {
          const content = await ctx.app.vault.adapter.read(path);
          if (
            !containsExactDevelopmentMarker(content, ownership.marker)
            || !content.includes("<!-- SYSTEMSCULPT-MESSAGE-START")
          ) {
            throw new DriverActionError(
              "Refusing to trash a chat that is not the owned development test.",
            );
          }
          await ctx.app.fileManager.trashFile(file);
          progress.trashedChat = true;
        }
      }
      progress.chatCleanupComplete = true;
    } catch (error) {
      cleanupError = cleanupError
        ? new DriverActionError(
          `Tool-capture cleanup failed: ${errorMessage(cleanupError)} `
            + `Chat cleanup failed: ${errorMessage(error)}`,
        )
        : error;
    }
  }

  if (!progress.developmentPathCleanupComplete && progress.requestedDevelopmentPath) {
    try {
      await restoreApprovedTrashArtifacts(ctx, ownership);
      const file = ctx.app.vault.getAbstractFileByPath(progress.requestedDevelopmentPath);
      if (!file) {
        if (
          ownership.approvedDevelopmentRootEstablished
          || ownership.approvedMutationCount > 0
        ) {
          throw new DriverActionError(
            "The exact owned development marker root is unavailable for cleanup.",
          );
        }
        progress.developmentPathCleanupComplete = true;
      } else {
        await proveExactApprovedDevelopmentTree(
          ctx,
          file,
          progress.requestedDevelopmentPath,
          ownership.approvedDevelopmentPaths,
          ownership.approvedDevelopmentDirectories,
          ownership.approvedDevelopmentRootEstablished,
        );
        await ctx.app.fileManager.trashFile(file);
        progress.trashedDevelopmentPath = true;
        progress.developmentPathCleanupComplete = true;
      }
    } catch (error) {
      cleanupError = cleanupError
        ? new DriverActionError(
          `Development cleanup failed: ${errorMessage(cleanupError)} `
            + `Development-folder cleanup failed: ${errorMessage(error)}`,
        )
        : error;
    }
  }

  const restorationCanProceed = progress.uiCleanupComplete
    && (progress.chatCleanupComplete || progress.ownedChatPath !== null);
  if (!progress.restorationComplete && restorationCanProceed) {
    try {
      await restoreDevelopmentChat(ctx, ownership);
      progress.restorationComplete = true;
    } catch (error) {
      restoreError = error;
    }
  }

  const complete = progress.uiCleanupComplete
    && progress.chatCleanupComplete
    && progress.developmentPathCleanupComplete
    && progress.restorationComplete;
  if (complete) {
    pendingRunSubmissions.delete(ctx.app);
    developmentChatOwners.delete(ctx.app);
  }
  if (cleanupError && restoreError) {
    throw new DriverActionError(
      `Development cleanup failed: ${errorMessage(cleanupError)} `
        + `Previous-chat restoration failed: ${errorMessage(restoreError)}`,
    );
  }
  if (cleanupError) throw cleanupError;
  if (restoreError) throw restoreError;
  if (!complete) {
    throw new DriverActionError(
      "Development cleanup remains incomplete; exact ownership was retained for retry.",
    );
  }
  return {
    owned: true,
    stoppedRun: progress.stoppedRun,
    removedAttachments: progress.removedAttachments,
    draftCleared: progress.draftCleared,
    approvalRestored: true,
    restoredPreviousChat: ownership.previousChatId.length > 0,
    trashedChat: progress.trashedChat,
    trashedDevelopmentPath: progress.trashedDevelopmentPath,
    toolLifecycle: progress.toolLifecycle,
  };
}

const DEVELOPMENT_MUTATION_TOOL_NAMES = [
  "create_folders",
  "edit",
  "multi_edit",
  "move",
  "trash",
] as const;

type DevelopmentMutationToolName = typeof DEVELOPMENT_MUTATION_TOOL_NAMES[number];

interface DevelopmentExactEdit {
  mode: "exact";
  newText: string;
  occurrence: "first";
  oldText: string;
}

interface DevelopmentMutationPlan {
  affectedPaths: ReadonlySet<string>;
  directories: Set<string>;
  files: Map<string, string>;
  trashArtifacts: ApprovedDevelopmentTrashArtifact[];
}

function exactMutationRecord(
  value: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DriverActionError("The exact development mutation input is malformed.");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (
    actualKeys.some((key) => !keys.includes(key) && !optionalKeys.includes(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new DriverActionError("The exact development mutation input shape is unsupported.");
  }
  return record;
}

function exactMutationArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new DriverActionError("The exact development mutation batch is malformed.");
  }
  return value;
}

function ownedMutationPath(value: unknown, ownership: DevelopmentChatOwnership): string {
  const path = developmentMarkerFromPath(value);
  if (path.marker !== ownership.marker) {
    throw new DriverActionError(
      "Every development mutation path must remain inside the active marker root.",
    );
  }
  return path.path;
}

function exactDevelopmentEdits(value: unknown): readonly DevelopmentExactEdit[] {
  return exactMutationArray(value).map((entry) => {
    // Every optional FileEdit field may be echoed at its executor-resolved
    // default (models do this): occurrence "first", mode "exact", isRegex
    // false, preserveIndent true, and null flags/range are all byte-identical
    // to the trimmed input. Any resolved value that could change the effect —
    // another occurrence/mode, a truthy isRegex, real flags, a real range —
    // is still refused.
    const edit = exactMutationRecord(
      entry,
      ["oldText", "newText"],
      ["occurrence", "mode", "isRegex", "preserveIndent", "flags", "range"],
    );
    if (
      typeof edit.oldText !== "string"
      || edit.oldText.length === 0
      || typeof edit.newText !== "string"
      || (edit.occurrence ?? "first") !== "first"
      || (edit.mode ?? "exact") !== "exact"
      || (edit.isRegex ?? false) !== false
      || (edit.preserveIndent ?? true) !== true
      || (edit.flags ?? null) !== null
      || (edit.range ?? null) !== null
    ) {
      throw new DriverActionError(
        "Development edits require exact first-occurrence text replacements.",
      );
    }
    return {
      oldText: edit.oldText,
      newText: edit.newText,
      occurrence: "first",
      mode: "exact",
    };
  });
}

function applyDevelopmentEdits(
  content: string,
  edits: readonly DevelopmentExactEdit[],
): string {
  let next = content;
  for (const edit of edits) {
    const index = next.indexOf(edit.oldText);
    if (index < 0) {
      throw new DriverActionError(
        "The approved edit does not match the currently owned development content.",
      );
    }
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
}

function developmentTrashCandidates(sourcePath: string): readonly string[] {
  const basename = sourcePath.split("/").pop();
  if (!basename) {
    throw new DriverActionError("The approved trash path has no file name.");
  }
  return [...new Set([`.trash/${sourcePath}`, `.trash/${basename}`])];
}

function planDevelopmentMutation(
  ownership: DevelopmentChatOwnership,
  toolName: DevelopmentMutationToolName,
  input: unknown,
): DevelopmentMutationPlan {
  if (!ownership.approvedDevelopmentRootEstablished) {
    throw new DriverActionError(
      "Development mutations require an exact owned seed write before approval.",
    );
  }
  const rootPath = `${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  const files = new Map(ownership.approvedDevelopmentPaths);
  const directories = new Set(ownership.approvedDevelopmentDirectories);
  const affectedPaths = new Set<string>();
  const trashArtifacts: ApprovedDevelopmentTrashArtifact[] = [];
  const recordPath = (value: unknown): string => {
    const path = ownedMutationPath(value, ownership);
    affectedPaths.add(path);
    return path;
  };

  if (toolName === "create_folders") {
    const record = exactMutationRecord(input, ["paths"]);
    const paths = exactMutationArray(record.paths).map(recordPath);
    for (const path of paths) {
      if (files.has(path)) {
        throw new DriverActionError("A development folder cannot replace an owned file.");
      }
      addApprovedDevelopmentDirectories(directories, rootPath, path, true);
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "edit") {
    // strict may be omitted or null: the vault executor resolves it to true.
    const record = exactMutationRecord(input, ["path", "edits"], ["strict"]);
    if ((record.strict ?? true) !== true) {
      throw new DriverActionError("Development edit approval requires strict mode.");
    }
    const path = recordPath(record.path);
    const content = files.get(path);
    if (content === undefined) {
      throw new DriverActionError("Development edit approval requires a tracked owned file.");
    }
    files.set(path, applyDevelopmentEdits(content, exactDevelopmentEdits(record.edits)));
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "multi_edit") {
    const record = exactMutationRecord(input, ["files"]);
    const entries = exactMutationArray(record.files);
    const seen = new Set<string>();
    for (const entry of entries) {
      const file = exactMutationRecord(entry, ["path", "edits"], ["strict"]);
      if ((file.strict ?? true) !== true) {
        throw new DriverActionError("Development multi-edit approval requires strict mode.");
      }
      const path = recordPath(file.path);
      if (seen.has(path)) {
        throw new DriverActionError("Development multi-edit paths must be unique.");
      }
      seen.add(path);
      const content = files.get(path);
      if (content === undefined) {
        throw new DriverActionError(
          "Development multi-edit approval requires tracked owned files.",
        );
      }
      files.set(path, applyDevelopmentEdits(content, exactDevelopmentEdits(file.edits)));
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  if (toolName === "move") {
    const record = exactMutationRecord(input, ["items"]);
    const entries = exactMutationArray(record.items);
    const sources = new Set<string>();
    const destinations = new Set<string>();
    for (const entry of entries) {
      const item = exactMutationRecord(entry, ["source", "destination"]);
      const source = recordPath(item.source);
      const destination = recordPath(item.destination);
      if (
        source === destination
        || sources.has(source)
        || destinations.has(destination)
        || files.has(destination)
        || directories.has(destination)
      ) {
        throw new DriverActionError("Development move approval has an ambiguous path plan.");
      }
      const content = files.get(source);
      if (content === undefined) {
        throw new DriverActionError("Development move approval requires a tracked owned file.");
      }
      sources.add(source);
      destinations.add(destination);
      files.delete(source);
      files.set(destination, content);
      addApprovedDevelopmentDirectories(directories, rootPath, destination, false);
    }
    return { affectedPaths, directories, files, trashArtifacts };
  }

  const record = exactMutationRecord(input, ["paths"]);
  const paths = exactMutationArray(record.paths).map(recordPath);
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path) || ownership.approvedTrashArtifacts.has(path)) {
      throw new DriverActionError("Development trash paths must be unique and newly owned.");
    }
    seen.add(path);
    const expectedText = files.get(path);
    if (expectedText === undefined) {
      throw new DriverActionError("Development trash approval requires a tracked owned file.");
    }
    files.delete(path);
    trashArtifacts.push({
      candidates: developmentTrashCandidates(path),
      expectedText,
      mirroredDirectoriesCleaned: false,
      restored: false,
      restoredCandidate: null,
      sourcePath: path,
    });
  }
  return { affectedPaths, directories, files, trashArtifacts };
}

/**
 * Plans the mutation the model actually requested from its captured canonical
 * input, or returns null when that input cannot be planned (malformed shape,
 * non-default semantics, an out-of-marker path, or an untracked file). A null
 * result must always refuse approval.
 */
function developmentMutationPlanFromCanonicalInput(
  ownership: DevelopmentChatOwnership,
  toolName: DevelopmentMutationToolName,
  canonicalInput: string,
): Readonly<{ plan: DevelopmentMutationPlan | null; failure: string | null }> {
  let input: unknown;
  try {
    input = JSON.parse(canonicalInput);
  } catch {
    return { plan: null, failure: "The canonical input is not valid JSON." };
  }
  try {
    return { plan: planDevelopmentMutation(ownership, toolName, input), failure: null };
  } catch (error) {
    if (error instanceof DriverActionError) return { plan: null, failure: error.message };
    throw error;
  }
}

/** Serializable summary of a plan for refusal evidence in error messages. */
function describeDevelopmentPlan(plan: DevelopmentMutationPlan | null): unknown {
  if (!plan) return null;
  return {
    affectedPaths: [...plan.affectedPaths].sort(),
    directories: [...plan.directories].sort(),
    files: Object.fromEntries(
      [...plan.files.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
    ),
    trashArtifacts: plan.trashArtifacts.map((artifact) => ({
      sourcePath: artifact.sourcePath,
      expectedText: artifact.expectedText,
      candidates: artifact.candidates,
    })),
  };
}

function developmentMutationPlansEqual(
  expected: DevelopmentMutationPlan,
  actual: DevelopmentMutationPlan | null,
): boolean {
  if (!actual) return false;
  const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
    left.size === right.size && [...left].every((value) => right.has(value));
  if (
    !sameSet(expected.affectedPaths, actual.affectedPaths)
    || !sameSet(expected.directories, actual.directories)
    || expected.files.size !== actual.files.size
  ) return false;
  for (const [path, text] of expected.files) {
    if (actual.files.get(path) !== text) return false;
  }
  return expected.trashArtifacts.length === actual.trashArtifacts.length
    && expected.trashArtifacts.every((artifact, index) => {
      const other = actual.trashArtifacts[index];
      return other !== undefined
        && artifact.sourcePath === other.sourcePath
        && artifact.expectedText === other.expectedText
        && artifact.candidates.length === other.candidates.length
        && artifact.candidates.every((candidate, at) => other.candidates[at] === candidate);
    });
}

function assertAllowedApproval(
  approvalButton: HTMLElement,
  allowedPath: unknown,
  allowedText?: unknown,
): string {
  const expectedPath = developmentMarkerFromPath(allowedPath).path;
  const tool = approvalButton.closest(".systemsculpt-agent-part.is-tool");
  const label = tool?.querySelector(".systemsculpt-agent-tool-label")?.textContent?.trim();
  const summary = tool?.querySelector(".systemsculpt-agent-tool-summary")?.textContent?.trim();
  const previewPath = tool
    ?.querySelector(".systemsculpt-agent-approval-preview .systemsculpt-diff-filename")
    ?.textContent
    ?.trim();
  if (label !== "Write file" || summary !== expectedPath || previewPath !== expectedPath) {
    throw new DriverActionError(
      "Refusing an approval that is not the exact owned development-test write.",
    );
  }
  if (typeof allowedText !== "string") {
    throw new DriverActionError("An exact development-test write preview is required.");
  }
  const added = tool?.querySelectorAll(
    ".systemsculpt-agent-approval-preview "
      + ".systemsculpt-diff-line-added .systemsculpt-diff-line-content",
  ) ?? [];
  if (added.length !== 1 || added[0]?.textContent !== allowedText) {
    throw new DriverActionError(
      "Refusing an approval whose write preview does not exactly match.",
    );
  }
  return expectedPath;
}

function approveDevelopmentWriteOnce(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  requireCurrentDevelopmentChatMarker(ctx, ownership);
  requireAskApprovalMode(ctx);
  const allowed = developmentMarkerFromPath(params.path);
  if (allowed.marker !== ownership.marker) {
    throw new DriverActionError(
      "The approval path does not belong to the owned development-test marker.",
    );
  }
  const approval = resolveTarget(ctx, "chat.approval.allow-once");
  if (!approval || !isVisible(approval)) {
    throw new DriverActionError("The safe Allow once approval is unavailable.");
  }
  assertAllowedApproval(approval, params.path, params.text);
  pointerSequence(approval);
  recordApprovedDevelopmentFile(ownership, allowed.path, params.text as string);
  ownership.approvalGranted = true;
  ownership.approvalClearedAfterGrant = false;
  return { approved: true, path: allowed.path };
}

async function proveTrashApprovalPreconditions(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
  artifacts: readonly ApprovedDevelopmentTrashArtifact[],
): Promise<void> {
  if (artifacts.length === 0) return;
  const adapter = ctx.app.vault.adapter;
  const mirrorRoot = `.trash/${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (await adapter.exists(mirrorRoot)) {
    throw new DriverActionError(
      "The exact marker-scoped local-trash destination already exists.",
    );
  }
  const candidates = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !await adapter.exists(artifact.sourcePath)
      || await adapter.read(artifact.sourcePath) !== artifact.expectedText
    ) {
      throw new DriverActionError(
        "The approved trash source does not match the tracked owned file.",
      );
    }
    for (const candidate of artifact.candidates) {
      if (candidates.has(candidate) || await adapter.exists(candidate)) {
        throw new DriverActionError(
          "The exact local-trash destination is ambiguous or already occupied.",
        );
      }
      candidates.add(candidate);
    }
  }
}

function mirroredTrashDirectories(
  ownership: DevelopmentChatOwnership,
  candidate: string,
): readonly string[] {
  const mirrorRoot = `.trash/${DEVELOPMENT_TEST_PREFIX}${ownership.marker}`;
  if (!candidate.startsWith(`${mirrorRoot}/`)) return [];
  const directories: string[] = [];
  let directory = candidate.slice(0, candidate.lastIndexOf("/"));
  while (directory === mirrorRoot || directory.startsWith(`${mirrorRoot}/`)) {
    directories.push(directory);
    if (directory === mirrorRoot) break;
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
  return directories;
}

async function waitForRestoredDevelopmentFile(
  ctx: ActionContext,
  sourcePath: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    throwIfActionCancelled(ctx);
    const file = ctx.app.vault.getAbstractFileByPath(sourcePath);
    if (file) {
      const node = asDevelopmentVaultNode(file);
      if (node.path === sourcePath && !Array.isArray(node.children)) return;
    }
    if (Date.now() - startedAt >= 5000) {
      throw new DriverActionError(
        "The restored development file did not reappear in the exact vault index.",
      );
    }
    await sleep(50);
  }
}

async function restoreApprovedTrashArtifacts(
  ctx: ActionContext,
  ownership: DevelopmentChatOwnership,
): Promise<void> {
  const adapter = ctx.app.vault.adapter;
  for (const artifact of ownership.approvedTrashArtifacts.values()) {
    if (!artifact.restored) {
      const sourceExists = await adapter.exists(artifact.sourcePath);
      const existingCandidates: string[] = [];
      for (const candidate of artifact.candidates) {
        if (await adapter.exists(candidate)) existingCandidates.push(candidate);
      }
      if (sourceExists) {
        if (existingCandidates.length !== 0) {
          throw new DriverActionError(
            "The approved trash artifact exists at both its source and local-trash destination.",
          );
        }
        if (await adapter.read(artifact.sourcePath) !== artifact.expectedText) {
          throw new DriverActionError(
            "The approved trash source no longer matches its tracked content.",
          );
        }
      } else {
        if (existingCandidates.length !== 1) {
          throw new DriverActionError(
            "The approved trash artifact has no unique exact local-trash destination.",
          );
        }
        const candidate = existingCandidates[0];
        if (await adapter.read(candidate) !== artifact.expectedText) {
          throw new DriverActionError(
            "The approved local-trash artifact no longer matches its tracked content.",
          );
        }
        await adapter.rename(candidate, artifact.sourcePath);
        if (
          !await adapter.exists(artifact.sourcePath)
          || await adapter.read(artifact.sourcePath) !== artifact.expectedText
        ) {
          throw new DriverActionError(
            "The approved local-trash artifact could not be restored exactly.",
          );
        }
        artifact.restoredCandidate = candidate;
      }
      await waitForRestoredDevelopmentFile(ctx, artifact.sourcePath);
      artifact.restored = true;
      artifact.mirroredDirectoriesCleaned = artifact.restoredCandidate === null;
      recordApprovedDevelopmentFile(
        ownership,
        artifact.sourcePath,
        artifact.expectedText,
      );
    }

    if (!artifact.mirroredDirectoriesCleaned) {
      if (!artifact.restoredCandidate) {
        throw new DriverActionError(
          "The approved local-trash cleanup state is incomplete.",
        );
      }
      for (const directory of mirroredTrashDirectories(
        ownership,
        artifact.restoredCandidate,
      )) {
        if (await adapter.exists(directory)) await adapter.rmdir(directory, false);
      }
      artifact.mirroredDirectoriesCleaned = true;
    }
  }
}

async function approveDevelopmentMutationOnce(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ownership = requireDevelopmentChatOwnership(ctx);
  const { container } = requireCurrentDevelopmentChatMarker(ctx, ownership);
  requireAskApprovalMode(ctx);
  const expected = exactMutationRecord(params, ["toolName", "input"]);
  if (
    typeof expected.toolName !== "string"
    || !(DEVELOPMENT_MUTATION_TOOL_NAMES as readonly string[]).includes(expected.toolName)
  ) {
    throw new DriverActionError(
      "A supported exact development mutation tool name is required.",
    );
  }
  const toolName = expected.toolName as DevelopmentMutationToolName;
  const pendingTools = [...container.querySelectorAll<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant.is-active "
      + ".systemsculpt-agent-part.is-tool.is-approval-required",
  )].filter(isVisible);
  const approvals = [...container.querySelectorAll<HTMLElement>(
    '[data-testid="chat.approval.allow-once"]',
  )].filter(isVisible);
  if (pendingTools.length !== 1 || approvals.length !== 1) {
    throw new DriverActionError(
      "Exactly one visible development mutation must be awaiting Allow once.",
    );
  }
  const approval = approvals[0];
  const tool = approval?.closest<HTMLElement>(
    ".systemsculpt-agent-part.is-tool.is-approval-required",
  ) ?? null;
  const activeTurn = tool?.closest<HTMLElement>(
    ".systemsculpt-agent-turn.is-assistant.is-active",
  ) ?? null;
  const toolCallId = tool ? canonicalToolCallId(tool.dataset.partKey ?? "") : null;
  if (
    !approval?.instanceOf(HTMLButtonElement)
    || approval.disabled
    || !tool
    || tool !== pendingTools[0]
    || !activeTurn
    || !toolCallId
  ) {
    throw new DriverActionError(
      "The visible Allow once control is not bound to one active canonical tool call.",
    );
  }
  const active = ownership.view.agent?.active;
  const identities = active?.toolIdentities;
  const decisions = active?.approvalDecisions;
  const identity = identities?.get(toolCallId);
  if (!identities || !decisions || !identity || decisions.has(toolCallId)) {
    throw new DriverActionError(
      "The active pending mutation identity is unavailable or already decided.",
    );
  }
  // Approval binds to the mutation's exact planned effect, not its raw input
  // bytes: the model may legally omit fields whose executor defaults it relied
  // on. Both inputs plan through the same marker-containment rules, and any
  // path, resulting byte, or trash-artifact difference still refuses.
  const plan = planDevelopmentMutation(ownership, toolName, expected.input);
  const visible = developmentMutationPlanFromCanonicalInput(
    ownership,
    toolName,
    identity.canonicalInput,
  );
  if (
    identity.toolName !== toolName
    || !developmentMutationPlansEqual(plan, visible.plan)
  ) {
    throw new DriverActionError(
      "The visible pending mutation does not exactly match the expected tool and input. "
        + `expectedTool=${JSON.stringify(toolName)}; `
        + `visibleTool=${JSON.stringify(identity.toolName)}; `
        + `visibleCanonicalInput=${JSON.stringify(identity.canonicalInput)}; `
        + `expectedPlan=${JSON.stringify(describeDevelopmentPlan(plan))}; `
        + `visiblePlan=${JSON.stringify(describeDevelopmentPlan(visible.plan))}; `
        + `visiblePlanFailure=${JSON.stringify(visible.failure)}`,
    );
  }
  await proveTrashApprovalPreconditions(ctx, ownership, plan.trashArtifacts);

  pointerSequence(approval);
  ownership.approvedDevelopmentPaths.clear();
  for (const [path, text] of plan.files) {
    ownership.approvedDevelopmentPaths.set(path, text);
  }
  ownership.approvedDevelopmentDirectories.clear();
  for (const path of plan.directories) ownership.approvedDevelopmentDirectories.add(path);
  for (const artifact of plan.trashArtifacts) {
    ownership.approvedTrashArtifacts.set(artifact.sourcePath, artifact);
  }
  ownership.approvedMutationCount += 1;
  ownership.approvalGranted = true;
  ownership.approvalClearedAfterGrant = false;
  return {
    approved: true,
    toolName,
    affectedPathCount: plan.affectedPaths.size,
    mutationIndex: ownership.approvedMutationCount,
  };
}

async function waitForDevelopmentRun(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 180000;
  const until = params.until;
  if (until !== "approval" && until !== "complete") {
    throw new DriverActionError(
      'chat.waitForDevelopmentRun requires until="approval" or "complete".',
    );
  }
  const ownership = requireDevelopmentChatOwnership(ctx);
  const startedAt = Date.now();
  await waitForSubmittedDevelopmentChatMarker(ctx, ownership, timeoutMs);
  requireAskApprovalMode(ctx);
  const approvalTransitionStartedAt = ownership.approvalGranted ? startedAt : null;
  for (;;) {
    throwIfActionCancelled(ctx);
    requireCurrentDevelopmentChatMarker(ctx, ownership);
    const snapshot = chatSnapshot(ctx, false);
    const stop = resolveTarget(ctx, "chat.composer.stop");
    const running = stop !== null && isVisible(stop);
    if (running) ownership.runObserved = true;
    const approval = resolveTarget(ctx, "chat.approval.allow-once");
    if (approval !== null && isVisible(approval)) {
      ownership.runObserved = true;
      if (until === "approval") {
        return {
          reached: "approval",
          waitedMs: Date.now() - startedAt,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      if (ownership.approvalGranted && !ownership.approvalClearedAfterGrant) {
        const now = Date.now();
        if (
          now - startedAt >= timeoutMs
          || (approvalTransitionStartedAt !== null && now - approvalTransitionStartedAt >= 5000)
        ) {
          throw new DriverActionError("The granted Allow once approval did not clear.");
        }
        await sleep(100);
        continue;
      }
      throw new DriverActionError("The run requires explicit Allow once approval.");
    }
    if (
      !running
      && ownership.submissionBaseline
      && completedSubmittedRun(snapshot, ownership.submissionBaseline)
    ) {
      ownership.runObserved = true;
      if (until === "complete") {
        pendingRunSubmissions.delete(ctx.app);
        ownership.submissionBaseline = null;
        return {
          reached: "complete",
          waitedMs: Date.now() - startedAt,
          completedBeforeRunningWasObserved: true,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      pendingRunSubmissions.delete(ctx.app);
      ownership.submissionBaseline = null;
      throw new DriverActionError("The run completed without requesting the expected approval.");
    }
    if (ownership.approvalGranted) ownership.approvalClearedAfterGrant = true;
    if (!running && ownership.runObserved) {
      if (until === "complete") {
        pendingRunSubmissions.delete(ctx.app);
        ownership.submissionBaseline = null;
        return {
          reached: "complete",
          waitedMs: Date.now() - startedAt,
          toolLifecycle: toolLifecycleCaptures.has(ctx.app) ? toolLifecycleReport(ctx) : null,
        };
      }
      pendingRunSubmissions.delete(ctx.app);
      ownership.submissionBaseline = null;
      throw new DriverActionError("The run completed without requesting the expected approval.");
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `The development run did not reach ${until} within ${timeoutMs}ms.`,
      );
    }
    await sleep(100);
  }
}

/**
 * Everything the chat surface can show that indicates the run moved.
 *
 * Deliberately content-derived rather than "is the stop button visible": a
 * wedged run keeps the stop button up forever, which is exactly why a plain
 * waitFor cannot tell a dead run from a slow one.
 */
function runProgressFingerprint(snapshot: Record<string, unknown>): string {
  const composer = asRecord(snapshot.composer);
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const last = asRecord(turns[turns.length - 1]);
  const parts = Array.isArray(last.parts) ? last.parts : [];
  const toolProgress = parts.map((value) => {
    const part = asRecord(value);
    const tool = asRecord(part.tool);
    return [
      part.kind ?? null,
      tool.partKey ?? null,
      tool.callCount ?? null,
      tool.state ?? null,
    ];
  });
  return [
    turns.length,
    parts.length,
    JSON.stringify(toolProgress),
    typeof last.textCharacters === "number"
      ? last.textCharacters
      : typeof last.text === "string" ? last.text.length : 0,
    String(composer.stopVisible),
    Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "",
  ].join(":");
}

function captureRunSubmissionBaseline(ctx: ActionContext): RunSubmissionBaseline {
  const snapshot = chatSnapshot(ctx, false);
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  return {
    bannerFingerprint: Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "",
    fingerprint: runProgressFingerprint(snapshot),
    submittedAtMs: Date.now(),
    turnCount: turns.length,
  };
}

function visibleRunSignals(snapshot: Record<string, unknown>): {
  feedbackVisible: boolean;
  contentVisible: boolean;
  latestUserIndex: number;
} {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const normalized = turns.map((turn) => asRecord(turn));
  let latestUserIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const assistantTurns = latestUserIndex < 0
    ? []
    : normalized.slice(latestUserIndex + 1).filter((turn) => turn.role === "assistant");
  return {
    feedbackVisible: assistantTurns.some((turn) =>
      (typeof turn.text === "string" && turn.text.length > 0)
      || (Array.isArray(turn.parts) && turn.parts.length > 0)),
    contentVisible: assistantTurns.some((turn) =>
      Array.isArray(turn.parts) && turn.parts.length > 0),
    latestUserIndex,
  };
}

function completedSubmittedRun(
  snapshot: Record<string, unknown>,
  baseline: RunSubmissionBaseline,
): boolean {
  const composer = asRecord(snapshot.composer);
  if (composer.stopVisible !== false) return false;
  const signals = visibleRunSignals(snapshot);
  if (signals.latestUserIndex < baseline.turnCount) return false;
  if (runProgressFingerprint(snapshot) === baseline.fingerprint) return false;
  const bannerFingerprint = Array.isArray(snapshot.banners) ? snapshot.banners.join("|") : "";
  return signals.feedbackVisible || bannerFingerprint !== baseline.bannerFingerprint;
}

/**
 * Waits for a chat run to finish, but fails fast and *specifically* when the
 * run stops producing anything.
 *
 * A flat timeout reports "waitFor timed out" for both a wedged run and a slow
 * model, which is how a hung run stayed invisible for nineteen minutes. This
 * reports which one happened, and returns the transcript either way.
 */
async function waitForRun(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 180000;
  const stallMs = typeof params.stallMs === "number" ? params.stallMs : 45000;
  const startMs = typeof params.startMs === "number" ? params.startMs : 20000;
  const approve = params.approve !== false;
  const returnOnApproval = params.returnOnApproval === true;
  const startedAt = Date.now();
  const submissionBaseline = pendingRunSubmissions.get(ctx.app) ?? null;
  pendingRunSubmissions.delete(ctx.app);

  // Submitting is asynchronous, so the run has not necessarily begun when this
  // action starts. Without waiting for it to appear, the very first poll sees
  // an idle composer and reports success for a turn that never ran. A fast
  // response can also finish before this separate driver action begins, so a
  // baseline captured by the submit action proves that terminal DOM belongs to
  // this submission without accepting arbitrary historical replies.
  let running = false;
  let completedBeforeRunningWasObserved: Record<string, unknown> | null = null;
  for (;;) {
    throwIfActionCancelled(ctx);
    const snapshot = chatSnapshot(ctx, false);
    if (asRecord(snapshot.composer).stopVisible === true) {
      running = true;
      break;
    }
    if (submissionBaseline && completedSubmittedRun(snapshot, submissionBaseline)) {
      completedBeforeRunningWasObserved = snapshot;
      break;
    }
    if (Date.now() - startedAt >= startMs) break;
    await sleep(50);
  }
  if (completedBeforeRunningWasObserved && submissionBaseline) {
    const completedSnapshot = chatSnapshot(ctx);
    const elapsedMs = Date.now() - startedAt;
    const visibleSignals = visibleRunSignals(completedSnapshot);
    const submitToFirstObservationUpperBoundMs = Math.max(
      0,
      Date.now() - submissionBaseline.submittedAtMs,
    );
    return {
      finished: true,
      waitedMs: elapsedMs,
      approvals: 0,
      timing: {
        runStartObserved: false,
        runStartedMs: null,
        firstVisibleFeedbackMs: null,
        firstVisibleContentMs: null,
        completedMs: null,
        feedbackPresentAtFirstObservation: visibleSignals.feedbackVisible,
        contentPresentAtFirstObservation: visibleSignals.contentVisible,
        submitToFirstObservationUpperBoundMs,
        submitToCompletionUpperBoundMs: submitToFirstObservationUpperBoundMs,
      },
      snapshot: completedSnapshot,
    };
  }
  if (!running) {
    throw new DriverActionError(
      `No run started within ${startMs}ms of submitting.`,
    );
  }

  const runStartedMs = Date.now() - startedAt;
  let firstVisibleFeedbackMs: number | null = null;
  let firstVisibleContentMs: number | null = null;
  let fingerprint = "";
  let lastProgressAt = Date.now();
  let approvals = 0;
  for (;;) {
    throwIfActionCancelled(ctx);
    const snapshot = chatSnapshot(ctx, false);
    const composer = asRecord(snapshot.composer);
    const elapsedMs = Date.now() - startedAt;
    const visibleSignals = visibleRunSignals(snapshot);
    if (firstVisibleFeedbackMs === null && visibleSignals.feedbackVisible) {
      firstVisibleFeedbackMs = elapsedMs;
    }
    if (firstVisibleContentMs === null && visibleSignals.contentVisible) {
      firstVisibleContentMs = elapsedMs;
    }
    const current = runProgressFingerprint(snapshot);
    if (current !== fingerprint) {
      fingerprint = current;
      lastProgressAt = Date.now();
    }
    if (composer.stopVisible === false) {
      const completedSnapshot = chatSnapshot(ctx);
      return {
        finished: true,
        waitedMs: elapsedMs,
        approvals,
        timing: {
          runStartedMs,
          firstVisibleFeedbackMs,
          firstVisibleContentMs,
          completedMs: elapsedMs,
        },
        snapshot: completedSnapshot,
      };
    }

    // Approve exactly as a user would, rather than relying on the composer's
    // approval mode. A run that parks on approval is otherwise indisputably
    // "not progressing", so a driven run would stall by design.
    const approvalButton = resolveTarget(ctx, "chat.approval.allow-for-chat")
      ?? resolveTarget(ctx, "chat.approval.allow-once");
    if (approvalButton && isVisible(approvalButton)) {
      if (returnOnApproval) {
        const approvalSnapshot = chatSnapshot(ctx);
        return {
          finished: false,
          approvalRequired: true,
          waitedMs: elapsedMs,
          approvals,
          timing: {
            runStartedMs,
            firstVisibleFeedbackMs,
            firstVisibleContentMs,
            completedMs: null,
          },
          snapshot: approvalSnapshot,
        };
      }
      if (approve) {
        throwIfActionCancelled(ctx);
        approvalButton.click();
        approvals += 1;
        lastProgressAt = Date.now();
        await sleep(120);
        continue;
      }
    }
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs >= stallMs) {
      throw new DriverActionError(
        `The run stalled: no chat activity for ${idleMs}ms `
          + `(waited ${Date.now() - startedAt}ms total). The run is still `
          + "presented as active. Check server logs for the matching run id.",
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `The run did not finish within ${timeoutMs}ms, but it was still `
          + `producing output ${idleMs}ms ago. Raise timeoutMs if this is `
          + "simply a long job.",
      );
    }
    await sleep(100);
  }
}

async function waitForCondition(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const target = typeof params.target === "string" ? params.target : "";
  const state = typeof params.state === "string" ? params.state : "exists";
  const text = typeof params.text === "string" ? params.text : "";
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  if (!target) throw new DriverActionError("waitFor requires a target.");
  const startedAt = Date.now();
  const evaluate = (): boolean => {
    const element = resolveTarget(ctx, target);
    switch (state) {
      case "exists": return element !== null;
      case "gone": return element === null;
      case "visible": return element !== null && isVisible(element);
      case "hidden": return element === null || !isVisible(element);
      case "enabled":
        if (!element) return false;
        return element.instanceOf(HTMLButtonElement) ? !element.disabled
          : element.instanceOf(HTMLInputElement) || element.instanceOf(HTMLTextAreaElement)
            ? !element.disabled
            : false;
      case "disabled":
        if (!element) return false;
        return element.instanceOf(HTMLButtonElement) ? element.disabled
          : element.instanceOf(HTMLInputElement) || element.instanceOf(HTMLTextAreaElement)
            ? element.disabled
            : false;
      case "textContains":
        return element !== null && (element.textContent ?? "").includes(text);
      case "textEquals": {
        const trimmedTarget = target.trim();
        if (trimmedTarget.startsWith("css:") || trimmedTarget.startsWith("chat:")) {
          const matches = trimmedTarget.startsWith("chat:")
            ? queryChatElements(ctx.app, trimmedTarget.slice(5))
            : queryElements(ctx, trimmedTarget.slice(4));
          return matches.length === 1
            && (matches[0]?.textContent ?? "").trim() === text.trim();
        }
        return element !== null
          && (element.textContent ?? "").trim() === text.trim();
      }
      default:
        throw new DriverActionError(
          `waitFor state must be exists, gone, visible, hidden, enabled, disabled, textContains, or textEquals; got "${state}".`,
        );
    }
  };
  for (;;) {
    throwIfActionCancelled(ctx);
    if (evaluate()) {
      return { satisfied: true, waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const element = resolveTarget(ctx, target);
      throw new DriverActionError(
        `waitFor timed out after ${timeoutMs}ms: ${target} did not reach "${state}". ` +
          `Current: ${JSON.stringify(describeElement(element))}`,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
}

interface DiagnosticsAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ type: string; size: number } | null>;
  trashLocal?(path: string): Promise<void>;
}

function diagnosticsAdapter(ctx: ActionContext): DiagnosticsAdapter {
  return ctx.app.vault.adapter as unknown as DiagnosticsAdapter;
}

function diagnosticsAttributionState(ctx: ActionContext): DiagnosticsExportAttribution {
  let state = diagnosticsExportAttributions.get(ctx.app);
  if (!state) {
    state = { baseline: null, attributed: null };
    diagnosticsExportAttributions.set(ctx.app, state);
  }
  return state;
}

async function listDiagnosticsExportBasenames(
  ctx: ActionContext,
): Promise<Set<string>> {
  const adapter = diagnosticsAdapter(ctx);
  const names = new Set<string>();
  if (!(await adapter.exists(DIAGNOSTICS_EXPORT_DIRECTORY))) return names;
  const listing = await adapter.list(DIAGNOSTICS_EXPORT_DIRECTORY);
  for (const filePath of listing.files) {
    const basename = filePath.split("/").pop() ?? "";
    if (DIAGNOSTICS_EXPORT_BASENAME_PATTERN.test(basename)) names.add(basename);
  }
  return names;
}

function sha256OfText(text: string): string {
  return sha256HexFromBytesPortable(new TextEncoder().encode(text));
}

/**
 * Validate an export against the allowlisted content-free snapshot schema.
 * Throws with metadata-only messages; never includes snapshot content.
 */
function validateDiagnosticsSnapshotText(ctx: ActionContext, text: string): {
  eventCount: number;
  resourceSampleCount: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DriverActionError("Diagnostics export is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DriverActionError("Diagnostics export is not a JSON object.");
  }
  const snapshot = parsed as Record<string, unknown>;
  for (const key of Object.keys(snapshot)) {
    if (!DIAGNOSTICS_SNAPSHOT_TOP_LEVEL_KEYS.has(key)) {
      throw new DriverActionError(
        `Diagnostics export contains a non-allowlisted top-level key: "${key}".`,
      );
    }
  }
  if (snapshot.schema_version !== 1) {
    throw new DriverActionError("Diagnostics export schema_version must be 1.");
  }
  if (
    typeof snapshot.generated_at !== "string"
    || !Number.isFinite(Date.parse(snapshot.generated_at))
  ) {
    throw new DriverActionError("Diagnostics export generated_at is invalid.");
  }
  if (snapshot.plugin_version !== ctx.pluginVersion) {
    throw new DriverActionError(
      "Diagnostics export plugin_version does not match the loaded plugin.",
    );
  }
  if (!Array.isArray(snapshot.events) || snapshot.event_count !== snapshot.events.length) {
    throw new DriverActionError(
      "Diagnostics export event_count does not match its events array.",
    );
  }
  if (
    !Array.isArray(snapshot.resources)
    || snapshot.resource_sample_count !== snapshot.resources.length
  ) {
    throw new DriverActionError(
      "Diagnostics export resource_sample_count does not match its resources array.",
    );
  }
  if (text.includes("tool_call_id")) {
    throw new DriverActionError(
      "Diagnostics export privacy canary failed: tool_call_id must not be exported.",
    );
  }
  const adapter = ctx.app.vault.adapter as unknown as {
    getBasePath?: () => string;
  };
  if (typeof adapter.getBasePath === "function") {
    let basePath = "";
    try {
      basePath = adapter.getBasePath();
    } catch {
      basePath = "";
    }
    if (basePath && text.includes(basePath)) {
      throw new DriverActionError(
        "Diagnostics export privacy canary failed: absolute vault path leaked.",
      );
    }
  }
  return {
    eventCount: snapshot.events.length,
    resourceSampleCount: snapshot.resources.length,
  };
}

async function baselineDiagnosticsExports(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  state.baseline = await listDiagnosticsExportBasenames(ctx);
  state.attributed = null;
  return { baselinedCount: state.baseline.size };
}

async function attributeNewDiagnosticsExport(
  ctx: ActionContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  if (!state.baseline) {
    throw new DriverActionError(
      "diagnostics.attributeNewExport requires diagnostics.baselineExports first.",
    );
  }
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const startedAt = Date.now();
  let fresh: string[] = [];
  for (;;) {
    throwIfActionCancelled(ctx);
    const current = await listDiagnosticsExportBasenames(ctx);
    fresh = [...current].filter((name) => !state.baseline!.has(name));
    if (fresh.length > 1) {
      throw new DriverActionError(
        `Expected exactly one new diagnostics export; found ${fresh.length}.`,
      );
    }
    if (fresh.length === 1) break;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new DriverActionError(
        `No new diagnostics export appeared within ${timeoutMs}ms.`,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  const basename = fresh[0]!;
  const path = `${DIAGNOSTICS_EXPORT_DIRECTORY}/${basename}`;
  const adapter = diagnosticsAdapter(ctx);
  const stat = await adapter.stat(path);
  if (!stat || stat.type !== "file") {
    throw new DriverActionError(
      "The new diagnostics export is not a regular file.",
    );
  }
  const text = await adapter.read(path);
  const { eventCount, resourceSampleCount } = validateDiagnosticsSnapshotText(ctx, text);
  const bytes = new TextEncoder().encode(text).byteLength;
  const sha256 = sha256OfText(text);
  state.attributed = { basename, path, bytes, sha256 };
  return { basename, bytes, sha256: `sha256:${sha256}`, eventCount, resourceSampleCount };
}

async function trashAttributedDiagnosticsExport(
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const state = diagnosticsAttributionState(ctx);
  const attributed = state.attributed;
  if (!attributed) {
    throw new DriverActionError(
      "diagnostics.trashAttributedExport requires a successful diagnostics.attributeNewExport.",
    );
  }
  const adapter = diagnosticsAdapter(ctx);
  if (!(await adapter.exists(attributed.path))) {
    throw new DriverActionError(
      "The attributed diagnostics export no longer exists; refusing to trash.",
    );
  }
  const stat = await adapter.stat(attributed.path);
  if (!stat || stat.type !== "file") {
    throw new DriverActionError(
      "The attributed diagnostics export is no longer a regular file; refusing to trash.",
    );
  }
  const text = await adapter.read(attributed.path);
  if (
    new TextEncoder().encode(text).byteLength !== attributed.bytes
    || sha256OfText(text) !== attributed.sha256
  ) {
    throw new DriverActionError(
      "The attributed diagnostics export changed since attribution; refusing to trash.",
    );
  }
  if (typeof adapter.trashLocal !== "function") {
    throw new DriverActionError(
      "Recoverable local trash is unavailable; refusing to delete permanently.",
    );
  }
  await adapter.trashLocal(attributed.path);
  if (await adapter.exists(attributed.path)) {
    throw new DriverActionError(
      "The attributed diagnostics export still exists after trashing.",
    );
  }
  state.attributed = null;
  state.baseline = null;
  return { basename: attributed.basename, trashed: true };
}

export async function runDriverAction(
  ctx: ActionContext,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  throwIfActionCancelled(ctx);
  switch (action) {
    case "status": {
      return {
        marker: "test-driver",
        pluginVersion: ctx.pluginVersion,
        buildStamp: ctx.buildStamp,
        vault: ctx.app.vault.getName(),
        chatOpen: chatContainer(ctx.app) !== null,
        settingsOpen: settingsSnapshot(ctx).open === true,
        consoleErrorCount: ctx.diagnostics.recentErrorCount(),
      };
    }
    case "chat.open": {
      const leaves = ctx.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
      const activeLeaf = ctx.app.workspace.activeLeaf;
      const existing = activeLeaf && leaves.includes(activeLeaf)
        ? activeLeaf
        : leaves[0];
      if (existing) {
        await ctx.app.workspace.revealLeaf(existing);
      } else {
        const leaf = ctx.app.workspace.getLeaf(true);
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
        await ctx.app.workspace.revealLeaf(leaf);
      }
      await waitForCondition(ctx, { target: "chat.composer.input", state: "visible", timeoutMs: 10000 });
      return chatSnapshot(ctx);
    }
    case "chat.beginToolLifecycleCapture": {
      return startToolLifecycleCapture(ctx);
    }
    case "chat.toolLifecycle": {
      return toolLifecycleReport(ctx);
    }
    case "chat.assertToolLifecycle": {
      return assertToolLifecycle(ctx, params);
    }
    case "chat.endToolLifecycleCapture": {
      return endToolLifecycleCapture(ctx);
    }
    case "chat.assertLatestToolSettledAfterContinuation": {
      return assertLatestToolSettledAfterContinuation(ctx, params);
    }
    case "chat.assertAllToolResultSendsCompleted": {
      return assertAllToolResultSendsCompleted(ctx, params);
    }
    case "chat.assertExactSequentialToolPlan": {
      return assertExactSequentialToolPlan(ctx, params);
    }
    case "chat.assertExactToolPlanCleanClose": {
      return assertExactToolPlanCleanClose(ctx);
    }
    case "chat.assertNoClientToolsBeforeContinuation": {
      return assertNoClientToolsBeforeContinuation(ctx, params);
    }
    case "chat.beginDevelopmentState": {
      return beginDevelopmentChat(ctx, params);
    }
    case "chat.exportDevelopmentOwnershipReceipt": {
      return exportDevelopmentOwnershipReceipt(ctx);
    }
    case "chat.importDevelopmentOwnershipReceipt": {
      return importDevelopmentOwnershipReceipt(ctx, params.receipt);
    }
    case "chat.readCopiedIncidentReport": {
      return readCopiedIncidentReport(ctx);
    }
    case "chat.resetDevelopmentState": {
      return resetDevelopmentChatState(ctx, params);
    }
    case "chat.approveDevelopmentWriteOnce": {
      return approveDevelopmentWriteOnce(ctx, params);
    }
    case "chat.approveDevelopmentMutationOnce": {
      return approveDevelopmentMutationOnce(ctx, params);
    }
    case "chat.typeDevelopmentDraft": {
      return typeDevelopmentDraft(ctx, params);
    }
    case "chat.reopenOwnedDevelopmentHistory": {
      return reopenOwnedDevelopmentHistory(ctx, params);
    }
    case "chat.waitForDevelopmentRun": {
      return waitForDevelopmentRun(ctx, params);
    }
    case "diagnostics.baselineExports": {
      return baselineDiagnosticsExports(ctx);
    }
    case "diagnostics.attributeNewExport": {
      return attributeNewDiagnosticsExport(ctx, params);
    }
    case "diagnostics.trashAttributedExport": {
      return trashAttributedDiagnosticsExport(ctx);
    }
    case "click": {
      const element = requireTarget(ctx, params.target);
      const isFailedTurnRetry = element === resolveTarget(ctx, "chat.turn.retry-failed");
      const retryContainer = isFailedTurnRetry ? chatContainer(ctx.app) : null;
      const retryUserTurns = retryContainer?.querySelectorAll<HTMLElement>(
        ".systemsculpt-agent-turn.is-user",
      );
      const priorRetryUserTurn = retryUserTurns?.[retryUserTurns.length - 1] ?? null;
      const priorRetryMessageId = priorRetryUserTurn?.dataset.messageId ?? "";
      const submissionBaseline = (
        element === resolveTarget(ctx, "chat.composer.send")
        || isFailedTurnRetry
      )
        ? captureRunSubmissionBaseline(ctx)
        : null;
      element.scrollIntoView({ block: "nearest" });
      pointerSequence(element);
      if (
        typeof params.immediateTextEquals === "string"
        && (element.textContent ?? "").trim() !== params.immediateTextEquals
      ) {
        throw new DriverActionError("The clicked control did not enter its expected immediate state.");
      }
      if (submissionBaseline) {
        pendingRunSubmissions.set(ctx.app, submissionBaseline);
        if (isFailedTurnRetry) {
          const ownership = developmentChatOwners.get(ctx.app);
          if (ownership) {
            ownership.approvalClearedAfterGrant = false;
            ownership.approvalGranted = false;
            ownership.runObserved = false;
            ownership.submissionAttempted = true;
            ownership.submissionBaseline = submissionBaseline;
          }
        }
      }
      if (isFailedTurnRetry) {
        const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
          ? Math.max(0, Math.min(params.timeoutMs, 60000))
          : 20000;
        await waitForFailedTurnRetryAdmission(
          ctx,
          priorRetryUserTurn,
          priorRetryMessageId,
          timeoutMs,
        );
        const ownership = developmentChatOwners.get(ctx.app);
        if (ownership) ownership.runObserved = true;
      }
      return describeElement(element);
    }
    case "type": {
      const element = requireTarget(ctx, params.target, "chat.composer.input");
      const text = typeof params.text === "string" ? params.text : "";
      const mode = params.mode === "append" ? "append" : "replace";
      setNativeValue(element, text, mode);
      if (params.submit === true) {
        const submissionBaseline = captureRunSubmissionBaseline(ctx);
        element.dispatchEvent(new KeyboardEvent("keydown", keyboardEventInit({ key: "Enter" })));
        element.dispatchEvent(new KeyboardEvent("keyup", keyboardEventInit({ key: "Enter" })));
        pendingRunSubmissions.set(ctx.app, submissionBaseline);
      }
      return describeElement(element);
    }
    case "press": {
      const element = requireTarget(ctx, params.target, "chat.composer.input");
      const init = keyboardEventInit(params);
      const submissionBaseline = init.key === "Enter"
        && !init.shiftKey
        && element === resolveTarget(ctx, "chat.composer.input")
        ? captureRunSubmissionBaseline(ctx)
        : null;
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", init));
      element.dispatchEvent(new KeyboardEvent("keyup", init));
      if (submissionBaseline) pendingRunSubmissions.set(ctx.app, submissionBaseline);
      return describeElement(element);
    }
    case "attach": {
      const file = buildFile(params);
      const via = params.via === "drop" ? "drop" : "picker";
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (via === "picker") {
        const picker = requireTarget(ctx, "chat.composer.file-picker");
        if (!(picker.instanceOf(HTMLInputElement))) {
          throw new DriverActionError("The chat file picker input was not found.");
        }
        picker.files = transfer.files;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const composer = requireTarget(ctx, "chat.composer");
        composer.dispatchEvent(new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
        }));
      }
      return { attached: file.name, bytes: file.size, via };
    }
    case "scroll": {
      const element = requireTarget(ctx, params.target, "chat.scroller");
      if (params.to === "top") element.scrollTop = 0;
      else if (params.to === "bottom") element.scrollTop = element.scrollHeight;
      else if (typeof params.deltaY === "number") element.scrollTop += params.deltaY;
      else throw new DriverActionError("scroll requires to=top|bottom or a numeric deltaY.");
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
    }
    case "read": {
      const element = requireTarget(ctx, params.target);
      return describeElement(element);
    }
    case "vault.assertText": {
      const path = validatedVaultPath(params.path);
      if (typeof params.text !== "string") {
        throw new DriverActionError("vault.assertText requires exact text.");
      }
      const actual = await ctx.app.vault.adapter.read(path);
      if (actual !== params.text) {
        throw new DriverActionError(
          `Vault file "${path}" did not contain the expected exact text.`,
        );
      }
      return { path, exact: true, characters: actual.length };
    }
    case "vault.assertFolder": {
      const path = validatedVaultPath(params.path);
      const value = ctx.app.vault.getAbstractFileByPath(path) as unknown;
      if (
        typeof value !== "object"
        || value === null
        || (value as { path?: unknown }).path !== path
        || !Array.isArray((value as { children?: unknown }).children)
      ) {
        throw new DriverActionError(`Vault path "${path}" is not an exact folder.`);
      }
      return {
        path,
        folder: true,
        childCount: (value as { children: unknown[] }).children.length,
      };
    }
    case "select": {
      const element = requireTarget(ctx, params.target);
      if (!element.instanceOf(HTMLSelectElement)) {
        throw new DriverActionError("select targets must be a <select> element.");
      }
      const value = typeof params.value === "string" ? params.value : "";
      const options = [...element.options].map((option) => option.value);
      if (!options.includes(value)) {
        throw new DriverActionError(
          `select value "${value}" is not an option. Available: ${options.join(", ")}.`,
        );
      }
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return describeElement(element);
    }
    case "logs": {
      return ctx.diagnostics.readLogs({
        level: typeof params.level === "string" ? params.level : undefined,
        pattern: typeof params.pattern === "string" ? params.pattern : undefined,
        sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    }
    case "notices": {
      return ctx.diagnostics.readNotices({
        sinceSeq: typeof params.sinceSeq === "number" ? params.sinceSeq : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      });
    }
    case "catalog": {
      return { testIds: liveTestIdCatalog(ctx) };
    }
    case "query": {
      const css = typeof params.css === "string" ? params.css : "";
      if (!css) throw new DriverActionError("query requires a css selector.");
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 50) : 10;
      const matches: Array<Record<string, unknown>> = [];
      for (const element of queryElements(ctx, css)) {
        if (matches.length >= limit) break;
        matches.push(describeElement(element));
      }
      return { count: matches.length, matches };
    }
    case "snapshot": {
      const scope = typeof params.scope === "string" ? params.scope : "chat";
      if (scope === "chat") return chatSnapshot(ctx);
      if (scope === "settings") return settingsSnapshot(ctx);
      throw new DriverActionError(`snapshot scope must be chat or settings; got "${scope}".`);
    }
    case "waitFor": {
      return waitForCondition(ctx, params);
    }
    case "waitForRun": {
      return waitForRun(ctx, params);
    }
    case "command": {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) throw new DriverActionError("command requires an Obsidian command id.");
      const executed = (ctx.app as AppWithCommands).commands.executeCommandById(id);
      if (!executed) throw new DriverActionError(`Obsidian command "${id}" did not execute.`);
      return { executed: true, id };
    }
    case "settings.open": {
      const host = ctx.app as AppWithSettings;
      host.setting.open();
      host.setting.openTabById(ctx.pluginId);
      await waitForCondition(ctx, { target: "settings.surface", state: "visible", timeoutMs: 10000 });
      const tab = typeof params.tab === "string" ? params.tab : "";
      if (tab) {
        const button = requireTarget(ctx, `settings.tab:${tab}`);
        pointerSequence(button);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return settingsSnapshot(ctx);
    }
    case "settings.close": {
      (ctx.app as AppWithSettings).setting.close();
      return { closed: true };
    }
    default:
      throw new DriverActionError(
        `Unknown driver action "${action}". Available: status, chat.open, ` +
          "chat.beginToolLifecycleCapture, chat.toolLifecycle, " +
          "chat.assertToolLifecycle, chat.endToolLifecycleCapture, " +
          "chat.assertLatestToolSettledAfterContinuation, " +
          "chat.assertAllToolResultSendsCompleted, " +
          "chat.assertExactSequentialToolPlan, " +
          "chat.assertExactToolPlanCleanClose, " +
          "chat.assertNoClientToolsBeforeContinuation, " +
          "chat.beginDevelopmentState, chat.typeDevelopmentDraft, " +
          "chat.exportDevelopmentOwnershipReceipt, chat.importDevelopmentOwnershipReceipt, " +
          "chat.readCopiedIncidentReport, " +
          "chat.approveDevelopmentWriteOnce, " +
          "chat.approveDevelopmentMutationOnce, " +
          "chat.waitForDevelopmentRun, chat.resetDevelopmentState, click, type, press, " +
          "attach, scroll, select, read, vault.assertText, vault.assertFolder, query, " +
          "catalog, logs, notices, " +
          "snapshot, waitFor, waitForRun, command, settings.open, settings.close.",
      );
  }
}

export { DriverActionError };
