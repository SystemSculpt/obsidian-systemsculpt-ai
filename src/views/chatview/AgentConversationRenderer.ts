import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import {
  createSurfaceElement,
  createUiAction,
  getSurfaceOwnerWindow,
  updateUiAction,
} from "../../core/ui/surface";
import type { ChatMessage, MessagePart } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import {
  isServerExecutedManagedToolCall,
  readManagedToolCallFunction,
} from "../../services/chat/ManagedToolExecution";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";
import {
  renderOperationsInlinePreview,
  renderWriteEditInlineDiff,
} from "../../utils/toolCallPreview";
import type {
  AgentArtifact,
  AgentConversationSnapshot,
  AgentPart,
  AgentToolPart,
} from "./AgentConversation";
import {
  formatAgentActivityDuration,
  formatAgentWorkingDuration,
  finalAgentAnswerPartIds,
  groupAdjacentAgentActivity,
  isAgentActivityPart,
  splitPreviousAgentActivity,
} from "./AgentActivityPresentation";
import {
  isActiveAgentToolState,
  presentAgentError,
  type AgentConversationPresentation,
} from "./AgentConversationPresentation";
import {
  isLocalReportId,
  normalizeFailedTerminalReceipt,
} from "./FailedTerminalReceipt";
import {
  presentAgentTool,
  presentAgentToolDetails,
  presentAgentToolFailure,
} from "./AgentToolPresentation";
import {
  presentChatMessage,
  presentMessageContent,
  type PresentedMessageAttachment,
  type PresentedMessageContent,
} from "./ChatMessagePresentation";
import { LiveMarkdownRenderer } from "./LiveMarkdownRenderer";
import { MessagePartNormalizer } from "./utils/MessagePartNormalizer";

export type AgentConversationRendererOptions = Readonly<{
  app: App;
  sourcePath: () => string;
  labelledBy?: string;
  beginLayoutMutation?: (
    disclosureControl?: HTMLElement,
    mutationTarget?: HTMLElement,
  ) => (() => void) | undefined;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => boolean | Promise<boolean>;
  onRetryFailedTurn?: (messageId: string) => void | Promise<void>;
  onCopyIncidentReport?: (
    reportId: string,
  ) => boolean | Promise<boolean>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onResubmitMessage?: (messageId: string, text: string) => boolean | Promise<boolean>;
  onCancelMessageEdit?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => boolean | Promise<boolean>;
}>;

export type AgentConversationRendererIncidentSnapshot = Readonly<{
  renderPassCount: number;
  pendingRenderPassCount: number;
  lastRenderDurationMs: number;
  maxRenderDurationMs: number;
  historicalRowCount: number;
  historicalPartCount: number;
  activePartCount: number;
  disclosureCount: number;
  openDisclosureCount: number;
  activityDisclosureCount: number;
  reasoningDisclosureCount: number;
  toolDisclosureCount: number;
  overflowDisclosureCount: number;
  pendingHydrationCount: number;
  renderingEnabled: boolean;
}>;

export type AgentInlineMessageEdit = Readonly<{
  messageId: string;
  text: string;
  laterMessageCount: number;
  hasAttachments: boolean;
  unavailableAttachmentCount: number;
  requiresReplayConfirmation: boolean;
}>;

function button(parent: HTMLElement, testId: string, label: string, icon?: string): HTMLButtonElement {
  const element = createUiAction(parent, {
    label,
    testId,
    icon,
    size: icon ? "icon" : "small",
    tooltip: false,
  });
  element.addClass("systemsculpt-agent-inline-button");
  return element;
}

const ACTIONABLE_ARTIFACT_TOOLS = new Set(["write", "edit", "multi_edit", "move"]);
const INCIDENT_RENDER_COUNT_LIMIT = 1_000_000;
const INCIDENT_RENDER_DURATION_LIMIT_MS = 86_400_000;
let activityDrawerSequence = 0;

type IncidentDisclosureKind = "activity" | "reasoning" | "tool" | "overflow";

type IncidentDisclosureState = {
  kind: IncidentDisclosureKind;
  available: boolean;
  open: boolean;
};

function boundedIncidentRenderCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_COUNT_LIMIT, Math.max(0, Math.floor(value)));
}

function boundedIncidentRenderDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_DURATION_LIMIT_MS, Math.max(0, Math.round(value)));
}

function toolPartKey(callId: string): string {
  return `tool:${callId}`;
}

function isNativeSourcesPart(part: MessagePart): boolean {
  if (part.type !== "content") return false;
  if (part.id.startsWith("sources:")) return true;
  const markdown = presentMessageContent(part.data).markdown.trim();
  const lines = markdown.split(/\r?\n/);
  return lines.length >= 3
    && lines[0] === "### Sources"
    && lines[1] === ""
    && lines.slice(2).every((line) =>
      /^- \[(?:\\.|[^\]])+\]\(<https?:\/\/[^<>\s]+>\)$/.test(line));
}

function historicalPartKey(part: MessagePart): string {
  return part.type === "tool_call" ? toolPartKey(part.data.id) : part.id;
}

type HistoricalTurnSemantics = Readonly<{
  hasVisibleContent: boolean;
  hasTools: boolean;
  isToolOnly: boolean;
  copyText: string;
}>;

type DurableFailedReceipt = Readonly<{
  messageId: string;
  reportId: string;
  incidentId?: string;
  failureCode: string;
  retryable: boolean;
  serverRunId?: string;
}>;

function durableFailedReceipt(message: ChatMessage): DurableFailedReceipt | null {
  if (message.role !== "assistant") return null;
  const receipt = normalizeFailedTerminalReceipt(message);
  if (!receipt) return null;
  return Object.freeze({
    messageId: message.message_id,
    reportId: receipt.terminalReportId ?? receipt.terminalIncidentId!,
    ...(receipt.terminalIncidentId ? { incidentId: receipt.terminalIncidentId } : {}),
    failureCode: receipt.terminalFailureCode,
    retryable: receipt.terminalRetryable,
    ...(receipt.terminalServerRunId ? { serverRunId: receipt.terminalServerRunId } : {}),
  });
}

type HistoricalPartPartition = Readonly<{
  workParts: readonly MessagePart[];
  finalAnswers: readonly MessagePart[];
  hasActivity: boolean;
}>;

type HistoricalActivityHydrationState = {
  element: HTMLDetailsElement;
  summary: HTMLElement;
  body: HTMLElement;
  parts: readonly MessagePart[];
  status: HistoricalHydrationStatus;
  staging: HTMLElement | null;
  hydration: Promise<void> | null;
};

type HistoricalOverflowHydrationState = {
  parts: readonly MessagePart[];
  status: HistoricalHydrationStatus;
  staging: HTMLElement | null;
  hydration: Promise<void> | null;
};

type HistoricalHydrationStatus = "cold" | "hydrating" | "hydrated" | "disposed";

type ToolApprovalPreviewHydrationState = {
  approval: HTMLElement;
  preview: HTMLElement;
  fingerprint: string;
  toolCall: ToolCall;
  lifecycleGeneration: number;
  toolRenderEpoch: number;
  hydration: Promise<void> | null;
};

type HistoricalRowState = Readonly<{
  fingerprint: string;
  node: HTMLElement;
  partFingerprints: ReadonlyMap<string, string>;
}>;

type HistoricalDisclosureSnapshot = Readonly<{
  workedOpen: boolean;
  hydrateWorked: boolean;
  overflowOpen: ReadonlyMap<string, boolean>;
  reasoningOpen: ReadonlyMap<string, boolean>;
  toolOpen: ReadonlyMap<string, boolean>;
}>;

type HistoricalRowReplacement = Readonly<{
  previous: HistoricalRowState;
  next: HistoricalRowState;
  disclosure: HistoricalDisclosureSnapshot;
}>;

type HistoricalFocusLocator =
  | Readonly<{ kind: "part"; key: string; focusKey: string | null }>
  | Readonly<{ kind: "overflow"; key: string; focusKey: string | null }>
  | Readonly<{ kind: "worked"; focusKey: string | null }>;

type PreservedDomSelection = Readonly<{
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}>;

type HistoricalReplacementInteraction = Readonly<{
  focusElement: HTMLElement | null;
  focusLocator: HistoricalFocusLocator | null;
  focusRow: HTMLElement;
  selection: PreservedDomSelection | null;
}>;

function isVisibleHistoricalPart(part: MessagePart): boolean {
  if (part.type === "reasoning") return part.data.trim().length > 0;
  if (part.type === "tool_call") return true;
  const content = presentMessageContent(part.data);
  return content.markdown.trim().length > 0 || content.attachments.length > 0;
}

function partitionHistoricalParts(
  parts: readonly MessagePart[],
  finalAnswerPartIds: ReadonlySet<string>,
): HistoricalPartPartition {
  const visibleParts = parts.filter(isVisibleHistoricalPart);
  const workParts = visibleParts.filter((part) => !finalAnswerPartIds.has(part.id));
  const finalAnswers = visibleParts.filter((part) =>
    part.type === "content" && finalAnswerPartIds.has(part.id));
  return {
    workParts,
    finalAnswers,
    hasActivity: workParts.some((part) =>
      part.type === "reasoning" || part.type === "tool_call"),
  };
}

function classifyHistoricalTurn(
  message: ChatMessage,
  aggregateContent: PresentedMessageContent,
  orderedParts: readonly MessagePart[],
): HistoricalTurnSemantics {
  const usesOrderedParts = orderedParts.length > 0;
  const presentedContent = usesOrderedParts
    ? orderedParts
      .filter((part) => part.type === "content")
      .map((part) => presentMessageContent(part.data))
    : [aggregateContent];
  const copyText = presentedContent
    .map((content) => content.markdown)
    .filter((markdown) => markdown.trim().length > 0)
    .join("\n\n");
  const hasVisibleContent = copyText.length > 0
    || presentedContent.some((content) => content.attachments.length > 0)
    || orderedParts.some((part) => part.type === "reasoning" && part.data.trim().length > 0);
  const hasTools = message.role === "assistant"
    && orderedParts.some((part) => part.type === "tool_call");
  const isToolOnly = hasTools && !hasVisibleContent;
  return { hasVisibleContent, hasTools, isToolOnly, copyText };
}

function toolCallForPart(part: AgentToolPart): ToolCall {
  return {
    id: part.callId,
    messageId: part.messageId,
    request: {
      id: part.callId,
      type: "function",
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      },
    },
    state: "executing",
    timestamp: Date.now(),
  };
}

function historicalToolState(tool: ToolCall, success: boolean): AgentToolPart["state"] {
  if (success) return "succeeded";

  switch (tool.result?.error?.code) {
    case "USER_DENIED":
      return "denied";
    case "TOOL_CANCELLED_BEFORE_START":
      return "cancelled";
    case "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN":
    case "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART":
      return "outcome-unknown";
    default:
      return tool.state === "failed" || tool.result?.success === false ? "failed" : "running";
  }
}

function visibleToolError(part: AgentToolPart): string | null {
  return part.error ? presentAgentToolFailure(part) : null;
}

function toolDisplayFingerprint(part: AgentToolPart): string {
  const presentation = presentAgentTool(part);
  const approvalInput = part.location === "vault"
    && part.state === "approval-required"
    && part.approvalId
    ? part.input
    : undefined;
  const artifacts = ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)
    ? part.output?.artifacts
    : undefined;
  return JSON.stringify({
    location: part.location,
    state: part.state,
    presentation,
    details: presentAgentToolDetails(part),
    error: visibleToolError(part),
    approvalId: approvalInput === undefined ? undefined : part.approvalId,
    approvalInput,
    artifacts,
  });
}

function agentPartsEqual(
  left: AgentPart | undefined,
  right: AgentPart,
  committedToolFingerprint?: string,
  incomingToolFingerprint?: string,
): boolean {
  if (left === right && right.kind !== "tool") return true;
  if (!left || left.kind !== right.kind || left.id !== right.id || left.order !== right.order) {
    return false;
  }
  switch (right.kind) {
    case "text":
      return left.kind === "text"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.markdown === right.markdown;
    case "reasoning":
      return left.kind === "reasoning"
        && left.messageId === right.messageId
        && left.state === right.state
        && left.summary === right.summary;
    case "error":
      return left.kind === "error"
        && left.retryable === right.retryable
        && left.retryMessageId === right.retryMessageId
        && JSON.stringify(presentAgentError(left.error, left.retryable))
          === JSON.stringify(presentAgentError(right.error, right.retryable));
    case "tool":
      return left.kind === "tool"
        && left.messageId === right.messageId
        && left.callId === right.callId
        && committedToolFingerprint === incomingToolFingerprint;
  }
}

function terminalToolPresentation(
  part: AgentPart,
  presentation: AgentConversationPresentation,
): AgentPart {
  if (
    part.kind !== "tool"
    || presentation.busy
    || (part.state !== "approval-required" && !isActiveAgentToolState(part.state))
  ) {
    return part;
  }
  const state: AgentToolPart["state"] = presentation.phase === "cancelled"
    ? "cancelled"
    : presentation.phase === "failed"
      ? "failed"
      : "outcome-unknown";
  return { ...part, state };
}

/** Projects durable messages plus the active normalized agent run into native DOM. */
export class AgentConversationRenderer extends Component {
  public readonly element: HTMLElement;
  private readonly historyRoot: HTMLElement;
  private readonly activeRoot: HTMLElement;
  private readonly activeNodes = new Map<string, HTMLElement>();
  private readonly activeOverflowNodes = new Map<string, HTMLButtonElement>();
  private readonly activityOverflowStates = new WeakMap<HTMLButtonElement, {
    body: HTMLElement;
    icon: HTMLElement;
    label: HTMLElement;
    latestNode: HTMLElement | null;
    previousNodes: HTMLElement[];
  }>();
  private readonly historicalOverflowHydrationStates = new Map<
    HTMLButtonElement,
    HistoricalOverflowHydrationState
  >();
  private readonly reasoningDisclosureStates = new WeakMap<HTMLDetailsElement, {
    body: HTMLElement;
    summary: string;
    streaming: boolean;
    dirty: boolean;
    revision: number;
  }>();
  private readonly historicalActivityHydrationStates = new Map<
    HTMLDetailsElement,
    HistoricalActivityHydrationState
  >();
  private readonly activePartRefs = new Map<string, AgentPart>();
  private readonly activeToolDisplayFingerprints = new Map<string, string>();
  private readonly activeToolErrorSuppression = new Map<string, boolean>();
  private readonly toolApprovalPreviewHydrationStates = new WeakMap<
    HTMLElement,
    ToolApprovalPreviewHydrationState
  >();
  private toolRenderEpoch = 0;
  private activeTailStatus: HTMLElement | null = null;
  private activeCompletedFold: HTMLDetailsElement | null = null;
  private activeCompletedFoldBody: HTMLElement | null = null;
  private activeWorkingTimer: number | null = null;
  private activeElapsedBaseline: Readonly<{ elapsedMs: number; observedAt: number }> | null = null;
  private historyRows = new Map<string, HistoricalRowState>();
  private historyMessageIds: ReadonlySet<string> = new Set<string>();
  private committedCancelledMessageIds: ReadonlySet<string> = new Set<string>();
  private committedFailedMessageIds: ReadonlySet<string> = new Set<string>();
  private committedFailedTurnIds: ReadonlySet<string> = new Set<string>();
  private inlineMessageEdit: AgentInlineMessageEdit | null = null;
  private activeTurn: HTMLElement | null = null;
  private activeBody: HTMLElement | null = null;
  private activeTurnId: string | null = null;
  private suppressedEditorKeyup: "Escape" | "Enter" | null = null;
  private suppressedEditorKeyupAction: (() => void) | null = null;
  private suppressedEditorKeyupTimer: number | null = null;
  private inlineEditorShortcutCleanup: (() => void) | null = null;
  private readonly copyFeedbackTimers = new Map<HTMLButtonElement, number>();
  private readonly incidentDisclosureStates = new Map<HTMLElement, IncidentDisclosureState>();
  private readonly liveMarkdown: LiveMarkdownRenderer;
  private renderGeneration = 0;
  private lifecycleGeneration = 0;
  private renderingEnabled = true;
  private adoptingTurnId: string | null = null;
  private incidentMetricsGeneration = 0;
  private incidentRenderPassCount = 0;
  private incidentPendingRenderPassCount = 0;
  private incidentLastRenderDurationMs = 0;
  private incidentMaxRenderDurationMs = 0;
  private incidentHistoricalPartCount = 0;
  private incidentPendingHydrationCount = 0;

  constructor(parent: HTMLElement, private readonly options: AgentConversationRendererOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-conversation",
      attr: {
        "data-testid": "chat.scroller",
        role: "log",
        ...(options.labelledBy ? { "aria-labelledby": options.labelledBy } : {}),
        "aria-live": "polite",
        "aria-relevant": "additions",
        "aria-atomic": "false",
      },
    });
    this.historyRoot = this.element.createDiv({ cls: "systemsculpt-agent-history" });
    this.activeRoot = this.element.createDiv({ cls: "systemsculpt-agent-active-run" });
    const containEditorKeyup = (event: KeyboardEvent): void => {
      this.containSuppressedEditorKeyup(event);
    };
    this.element.addEventListener("keyup", containEditorKeyup, true);
    this.register(() => this.element.removeEventListener("keyup", containEditorKeyup, true));
    this.liveMarkdown = new LiveMarkdownRenderer({
      beginDomCommit: (target) => this.options.beginLayoutMutation?.(undefined, target),
      render: async (markdown, staging, component) => {
        await MarkdownRenderer.render(
          this.options.app,
          markdown,
          staging,
          this.options.sourcePath(),
          component,
        );
        this.enhanceCodeBlocks(staging);
      },
    });
    this.addChild(this.liveMarkdown);
  }

  /** Resets per-run timing while keeping current content-free DOM state counts. */
  public resetIncidentRenderMetrics(): void {
    this.incidentMetricsGeneration += 1;
    this.incidentRenderPassCount = 0;
    this.incidentPendingRenderPassCount = 0;
    this.incidentLastRenderDurationMs = 0;
    this.incidentMaxRenderDurationMs = 0;
  }

  /** Returns a frozen scalar-only projection without inspecting rendered text. */
  public captureIncidentSnapshot(): AgentConversationRendererIncidentSnapshot {
    let disclosureCount = 0;
    let openDisclosureCount = 0;
    let activityDisclosureCount = 0;
    let reasoningDisclosureCount = 0;
    let toolDisclosureCount = 0;
    let overflowDisclosureCount = 0;
    for (const state of this.incidentDisclosureStates.values()) {
      if (!state.available) continue;
      disclosureCount += 1;
      if (state.open) openDisclosureCount += 1;
      if (state.kind === "activity") {
        activityDisclosureCount += 1;
      } else if (state.kind === "reasoning") {
        reasoningDisclosureCount += 1;
      } else if (state.kind === "tool") {
        toolDisclosureCount += 1;
      } else {
        overflowDisclosureCount += 1;
      }
    }
    return Object.freeze({
      renderPassCount: boundedIncidentRenderCount(this.incidentRenderPassCount),
      pendingRenderPassCount: boundedIncidentRenderCount(
        this.incidentPendingRenderPassCount,
      ),
      lastRenderDurationMs: boundedIncidentRenderDuration(
        this.incidentLastRenderDurationMs,
      ),
      maxRenderDurationMs: boundedIncidentRenderDuration(
        this.incidentMaxRenderDurationMs,
      ),
      historicalRowCount: boundedIncidentRenderCount(this.historyRows.size),
      historicalPartCount: boundedIncidentRenderCount(this.incidentHistoricalPartCount),
      activePartCount: boundedIncidentRenderCount(this.activeNodes.size),
      disclosureCount: boundedIncidentRenderCount(disclosureCount),
      openDisclosureCount: boundedIncidentRenderCount(openDisclosureCount),
      activityDisclosureCount: boundedIncidentRenderCount(activityDisclosureCount),
      reasoningDisclosureCount: boundedIncidentRenderCount(reasoningDisclosureCount),
      toolDisclosureCount: boundedIncidentRenderCount(toolDisclosureCount),
      overflowDisclosureCount: boundedIncidentRenderCount(overflowDisclosureCount),
      pendingHydrationCount: boundedIncidentRenderCount(this.incidentPendingHydrationCount),
      renderingEnabled: this.renderingEnabled,
    });
  }

  /** Uses maintained reconciliation state to prove that a failed surface committed. */
  public hasCommittedFailureSurface(turnId: string): boolean {
    if (!this.renderingEnabled || !turnId) return false;
    if (this.committedFailedTurnIds.has(turnId)) return true;
    if (this.activeTurnId !== turnId) return false;
    for (const part of this.activePartRefs.values()) {
      if (part.kind === "error") return true;
    }
    return false;
  }

  private async measureIncidentRenderPass(task: () => Promise<void>): Promise<void> {
    const generation = this.incidentMetricsGeneration;
    this.incidentRenderPassCount = boundedIncidentRenderCount(
      this.incidentRenderPassCount + 1,
    );
    this.incidentPendingRenderPassCount = boundedIncidentRenderCount(
      this.incidentPendingRenderPassCount + 1,
    );
    const startedAt = this.incidentMonotonicNow();
    try {
      await task();
    } finally {
      if (generation === this.incidentMetricsGeneration) {
        this.incidentPendingRenderPassCount = Math.max(
          0,
          this.incidentPendingRenderPassCount - 1,
        );
        const durationMs = boundedIncidentRenderDuration(
          this.incidentMonotonicNow() - startedAt,
        );
        this.incidentLastRenderDurationMs = durationMs;
        this.incidentMaxRenderDurationMs = Math.max(
          this.incidentMaxRenderDurationMs,
          durationMs,
        );
      }
    }
  }

  private incidentMonotonicNow(): number {
    try {
      const value = getSurfaceOwnerWindow(this.element).performance?.now?.();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      // Incident measurement must never affect rendering.
    }
    try {
      const value = Date.now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  public renderHistory(messages: readonly ChatMessage[]): Promise<void> {
    return this.measureIncidentRenderPass(() => this.renderHistoryPass(messages));
  }

  private async renderHistoryPass(messages: readonly ChatMessage[]): Promise<void> {
    if (!this.renderingEnabled) return;
    const adoptionState = this.captureActiveAdoptionState();
    const lifecycleGeneration = this.lifecycleGeneration;
    const generation = ++this.renderGeneration;
    const isCurrent = (): boolean =>
      this.renderingEnabled
      && lifecycleGeneration === this.lifecycleGeneration
      && generation === this.renderGeneration;
    if (
      this.inlineMessageEdit
      && !messages.some((message) =>
        message.role === "user" && message.message_id === this.inlineMessageEdit?.messageId)
    ) {
      this.inlineMessageEdit = null;
    }
    const nextHistory = createSurfaceElement(this.historyRoot.ownerDocument, "div");
    const nextRows = new Map<string, HistoricalRowState>();
    const nextMessageIds = new Set<string>();
    const nextDurableCancelledMessageIds = new Set<string>();
    const nextDurableFailedMessageIds = new Set<string>();
    const nextDurableFailedTurnIds = new Set<string>();
    const desiredRows: HTMLElement[] = [];
    const rowReplacements: HistoricalRowReplacement[] = [];
    let nextHistoricalPartCount = 0;
    let hasInlineEdit = false;
    let currentTurnId: string | null = null;
    for (let index = 0; index < messages.length;) {
      if (!isCurrent()) {
        this.forgetMarkdown(nextHistory);
        return;
      }
      const message = messages[index];
      index += 1;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const turnMessages: ChatMessage[] = [message];
      if (message.role === "assistant") {
        while (index < messages.length && messages[index].role === "assistant") {
          turnMessages.push(messages[index]);
          index += 1;
        }
      }
      const anchorMessage = turnMessages[0];
      if (message.role === "user") currentTurnId = anchorMessage.message_id;
      const turnId = message.role === "assistant" ? currentTurnId : null;

      const presented = turnMessages.map((entry) => {
        const content = presentChatMessage(entry);
        const orderedParts = entry.role === "assistant" ? this.orderedDurableParts(entry) : [];
        return {
          message: entry,
          content,
          orderedParts,
          semantics: classifyHistoricalTurn(entry, content, orderedParts),
        };
      });
      const hasVisibleContent = presented.some((entry) => entry.semantics.hasVisibleContent);
      const hasTools = presented.some((entry) => entry.semantics.hasTools);
      const failedReceipt = [...turnMessages]
        .reverse()
        .map(durableFailedReceipt)
        .find((receipt): receipt is DurableFailedReceipt => receipt !== null) ?? null;
      const copyText = presented
        .map((entry) => entry.semantics.copyText)
        .filter(Boolean)
        .join("\n\n");
      const semantics: HistoricalTurnSemantics = {
        hasVisibleContent: hasVisibleContent || failedReceipt !== null,
        hasTools,
        isToolOnly: hasTools && !hasVisibleContent && failedReceipt === null,
        copyText,
      };
      if (failedReceipt && turnId) nextDurableFailedTurnIds.add(turnId);
      if (!semantics.hasVisibleContent && !semantics.hasTools) continue;
      for (const entry of turnMessages) {
        nextMessageIds.add(entry.message_id);
        if (entry.role === "assistant" && entry.terminalOutcome === "cancelled") {
          nextDurableCancelledMessageIds.add(entry.message_id);
        }
        if (entry.role === "assistant" && durableFailedReceipt(entry)) {
          nextDurableFailedMessageIds.add(entry.message_id);
        }
      }
      const inlineEdit = message.role === "user"
        && this.inlineMessageEdit?.messageId === anchorMessage.message_id
        ? this.inlineMessageEdit
        : null;
      hasInlineEdit ||= inlineEdit !== null;
      const rowKey = JSON.stringify({
        role: message.role,
        messageIds: turnMessages.map((entry) => entry.message_id),
        ...(turnId ? { turnId } : {}),
      });
      const cancelledTurn = message.role === "assistant"
        && turnMessages.some((entry) => entry.terminalOutcome === "cancelled");
      const fingerprint = JSON.stringify({
        messages: turnMessages,
        inlineEdit,
        cancelledTurn,
        failedReceipt,
      });
      const existing = this.historyRows.get(rowKey);
      if (existing?.fingerprint === fingerprint) {
        nextRows.set(rowKey, existing);
        nextHistoricalPartCount = boundedIncidentRenderCount(
          nextHistoricalPartCount + existing.partFingerprints.size,
        );
        desiredRows.push(existing.node);
        continue;
      }
      const adoptActive = message.role === "assistant"
        && turnId === this.adoptingTurnId
        && this.activeTurn !== null
        && this.activeBody !== null;
      const row = adoptActive ? this.activeTurn! : nextHistory.createDiv();
      row.className = [
        "systemsculpt-agent-turn",
        `is-${message.role}`,
        semantics.isToolOnly ? "is-tool-only" : "",
        inlineEdit ? "is-editing" : "",
      ].filter(Boolean).join(" ");
      row.dataset.messageId = anchorMessage.message_id;
      if (turnMessages.length > 1) {
        row.dataset.messageIds = turnMessages.map((entry) => entry.message_id).join(" ");
      } else {
        delete row.dataset.messageIds;
      }
      if (turnId) row.dataset.turnId = turnId;
      else delete row.dataset.turnId;
      const body = adoptActive
        ? this.activeBody!
        : row.createDiv({ cls: "systemsculpt-agent-turn-body" });
      let partFingerprints: ReadonlyMap<string, string> = new Map<string, string>();
      if (message.role === "assistant") {
        const ownedTurnParts = presented.flatMap((entry, entryIndex) => {
          const parts: MessagePart[] = entry.orderedParts.length > 0
            ? entry.orderedParts
            : [{
            id: `${entry.message.message_id}:content`,
            type: "content",
            timestamp: entryIndex,
            data: entry.message.content ?? "",
          }];
          return parts.map((part) => ({ part, messageId: entry.message.message_id }));
        });
        const turnParts = ownedTurnParts.map(({ part }) => part);
        partFingerprints = new Map(turnParts.map((part) => [
          historicalPartKey(part),
          this.historicalPartDisplayFingerprint(part),
        ]));
        const finalAnswerPartIds = this.finalHistoricalAnswerPartIds(ownedTurnParts);
        const foldedCancelledActivity = adoptActive
          ? await this.adoptHistoricalParts(
            body,
            turnParts,
            turnMessages[turnMessages.length - 1]?.responseDurationMs,
            finalAnswerPartIds,
            cancelledTurn,
          )
          : await (async (): Promise<boolean> => {
          try {
            return await this.renderHistoricalParts(
              body,
              turnParts,
              turnMessages[turnMessages.length - 1]?.responseDurationMs,
              finalAnswerPartIds,
              cancelledTurn,
            );
          } catch (error) {
            this.forgetMarkdown(nextHistory);
            throw error;
          }
          })();
        if (!isCurrent()) {
          this.forgetMarkdown(nextHistory);
          return;
        }
        if (cancelledTurn && !foldedCancelledActivity) {
          this.renderDurableCancelledTail(body);
        }
        if (failedReceipt) {
          await this.renderDurableFailedTail(body, failedReceipt, turnId, adoptActive);
        }
      } else {
        const { content } = presented[0];
        if (inlineEdit) {
          this.renderInlineMessageEditor(body, inlineEdit);
        } else if (content.markdown.trim()) {
          try {
            await this.renderMarkdown(content.markdown, body);
          } catch (error) {
            this.forgetMarkdown(nextHistory);
            throw error;
          }
          if (!isCurrent()) {
            this.forgetMarkdown(nextHistory);
            return;
          }
        }
        if (content.attachments.length > 0) this.renderMessageAttachments(body, content.attachments);
      }
      if (!semantics.isToolOnly && !inlineEdit) {
        this.renderMessageActions(
          row,
          turnMessages[turnMessages.length - 1],
          semantics.copyText,
        );
      }
      const rendered: HistoricalRowState = { fingerprint, node: row, partFingerprints };
      nextRows.set(rowKey, rendered);
      nextHistoricalPartCount = boundedIncidentRenderCount(
        nextHistoricalPartCount + partFingerprints.size,
      );
      desiredRows.push(row);
      if (existing && !adoptActive) {
        rowReplacements.push({
          previous: existing,
          next: rendered,
          disclosure: this.captureHistoricalDisclosureState(existing.node),
        });
      }
      if (adoptActive) this.releaseAdoptedActiveTurn();
    }
    for (const replacement of rowReplacements) {
      await this.prepareHistoricalRowReplacement(replacement);
      if (!isCurrent()) {
        this.forgetMarkdown(nextHistory);
        return;
      }
    }
    if (!isCurrent()) {
      this.forgetMarkdown(nextHistory);
      return;
    }
    let historicalInteraction: HistoricalReplacementInteraction | null = null;
    for (const replacement of rowReplacements) {
      historicalInteraction ??= this.captureHistoricalReplacementInteraction(
        replacement.previous.node,
        replacement.next.node,
      );
      this.commitHistoricalRowReplacement(replacement);
    }
    const focusReplacement = this.transferActivePresentationState(desiredRows);
    const desiredRowSet = new Set(desiredRows);
    for (const { node } of this.historyRows.values()) {
      if (!desiredRowSet.has(node)) this.forgetMarkdown(node);
    }
    this.reconcileChildren(this.historyRoot, desiredRows);
    const historicalFocus = historicalInteraction?.focusElement;
    const restoredHistoricalFocus = historicalFocus?.isConnected
      ? historicalFocus
      : historicalInteraction
        ? this.resolveHistoricalFocus(
          historicalInteraction.focusRow,
          historicalInteraction.focusLocator,
        )
        : null;
    const preservedFocus = adoptionState?.focusElement;
    if (restoredHistoricalFocus) restoredHistoricalFocus.focus({ preventScroll: true });
    else if (preservedFocus?.isConnected) preservedFocus.focus({ preventScroll: true });
    else focusReplacement?.focus({ preventScroll: true });
    this.restoreDomSelection(
      historicalInteraction?.selection ?? adoptionState?.selection ?? null,
    );
    this.historyRows = nextRows;
    this.incidentHistoricalPartCount = nextHistoricalPartCount;
    this.historyMessageIds = nextMessageIds;
    this.committedCancelledMessageIds = nextDurableCancelledMessageIds;
    this.committedFailedMessageIds = nextDurableFailedMessageIds;
    this.committedFailedTurnIds = nextDurableFailedTurnIds;
    if (!hasInlineEdit) this.clearInlineEditorShortcutGuard();
  }

  /**
   * Commits a completed turn while reusing its live row and keyed part nodes.
   * This keeps Markdown, selection, focus, and disclosure identity intact.
   */
  public async settleHistory(messages: readonly ChatMessage[], turnId: string): Promise<void> {
    if (!this.activeTurn || this.activeTurnId !== turnId) {
      await this.renderHistory(messages);
      this.clearActive();
      return;
    }
    this.adoptingTurnId = turnId;
    try {
      await this.renderHistory(messages);
    } finally {
      this.adoptingTurnId = null;
    }
  }

  private captureActiveAdoptionState(): Readonly<{
    focusElement: HTMLElement | null;
    selection: Readonly<{
      anchorNode: Node;
      anchorOffset: number;
      focusNode: Node;
      focusOffset: number;
    }> | null;
  }> | null {
    if (!this.adoptingTurnId || !this.activeTurn) return null;
    const activeElement = this.activeTurn.ownerDocument.activeElement;
    const focusElement = activeElement?.nodeType === 1
      && this.activeTurn.contains(activeElement)
      ? activeElement as HTMLElement
      : null;
    const selection = this.activeTurn.ownerDocument.getSelection();
    const preservedSelection = selection?.anchorNode
      && selection.focusNode
      && this.activeTurn.contains(selection.anchorNode)
      && this.activeTurn.contains(selection.focusNode)
      ? {
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : null;
    return { focusElement, selection: preservedSelection };
  }

  private restoreDomSelection(selection: PreservedDomSelection | null): void {
    if (!selection || !selection.anchorNode.isConnected || !selection.focusNode.isConnected) return;
    const current = this.element.ownerDocument.getSelection();
    if (!current) return;
    const maximumOffset = (node: Node): number => node.nodeType === Node.TEXT_NODE
      ? node.nodeValue?.length ?? 0
      : node.childNodes.length;
    const anchorOffset = Math.min(selection.anchorOffset, maximumOffset(selection.anchorNode));
    const focusOffset = Math.min(selection.focusOffset, maximumOffset(selection.focusNode));
    try {
      current.removeAllRanges();
      if (typeof current.setBaseAndExtent === "function") {
        current.setBaseAndExtent(
          selection.anchorNode,
          anchorOffset,
          selection.focusNode,
          focusOffset,
        );
        return;
      }
      const range = this.element.ownerDocument.createRange();
      range.setStart(selection.anchorNode, anchorOffset);
      range.setEnd(selection.focusNode, focusOffset);
      current.addRange(range);
    } catch {
      current.removeAllRanges();
    }
  }

  public setInlineMessageEdit(edit: AgentInlineMessageEdit | null): void {
    this.inlineMessageEdit = edit;
  }

  public focusInlineMessageEdit(): void {
    const input = this.historyRoot.querySelector<HTMLTextAreaElement>(
      ".systemsculpt-agent-message-editor-input",
    );
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  public focusMessageEditAction(messageId: string): void {
    const row = Array.from(
      this.historyRoot.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn[data-message-id]"),
    ).find((candidate) => candidate.dataset.messageId === messageId);
    row?.querySelector<HTMLButtonElement>('[data-focus-key="edit-message"]')?.focus();
  }

  /** Durable message parts are the chronology source for managed chats. */
  private orderedDurableParts(message: ChatMessage): MessagePart[] {
    if (!message.messageParts?.length) return [];
    return MessagePartNormalizer.toParts(message)
      .filter((part) => ["reasoning", "content", "tool_call"].includes(part.type));
  }

  /** Fingerprint only the projection that can change a rendered part node. */
  private historicalPartDisplayFingerprint(part: MessagePart): string {
    if (part.type === "reasoning") {
      return JSON.stringify({ type: part.type, summary: part.data });
    }
    if (part.type === "tool_call") {
      return toolDisplayFingerprint(this.historicalToolPart(part.data));
    }
    return JSON.stringify({ type: part.type, content: presentMessageContent(part.data) });
  }

  private finalHistoricalAnswerPartIds(
    parts: readonly Readonly<{ part: MessagePart; messageId: string }>[],
  ): ReadonlySet<string> {
    return finalAgentAnswerPartIds(parts.map(({ part, messageId }) => ({
      id: part.id,
      messageId,
      visible: isVisibleHistoricalPart(part),
      kind: part.type !== "content"
        ? "activity" as const
        : isNativeSourcesPart(part)
          ? "sources" as const
          : "content" as const,
    })));
  }

  private async renderHistoricalPart(parent: HTMLElement, part: MessagePart): Promise<void> {
    if (part.type === "reasoning") {
      if (!part.data.trim()) return;
      const node = parent.createDiv({
        cls: "systemsculpt-agent-part is-reasoning",
        attr: {
          "data-part-key": part.id,
          "data-agent-activity-row": "",
          "data-activity-kind": "reasoning",
        },
      });
      await this.renderReasoning(node, part.data, false);
      return;
    }
    if (part.type === "tool_call") {
      const tool = this.historicalToolPart(part.data);
      const node = parent.createDiv({
        cls: "systemsculpt-agent-part is-tool",
        attr: {
          "data-part-key": toolPartKey(tool.callId),
          "data-agent-activity-row": "",
          "data-activity-kind": "tool",
        },
      });
      await this.renderTool(node, tool);
      return;
    }
    if (part.type !== "content") return;
    const content = presentMessageContent(part.data);
    if (content.markdown.trim()) {
      const node = parent.createDiv({
        cls: "systemsculpt-agent-part is-text",
        attr: { "data-part-key": part.id },
      });
      await this.renderMarkdown(content.markdown, node);
    }
    if (content.attachments.length > 0) this.renderMessageAttachments(parent, content.attachments);
  }

  private async renderHistoricalParts(
    parent: HTMLElement,
    parts: readonly MessagePart[],
    elapsedMs?: number,
    finalAnswerPartIds: ReadonlySet<string> = new Set<string>(),
    cancelled = false,
  ): Promise<boolean> {
    const { workParts, finalAnswers, hasActivity } = partitionHistoricalParts(
      parts,
      finalAnswerPartIds,
    );
    if (hasActivity) {
      const activity = this.createCompletedActivity(parent, elapsedMs, cancelled);
      if (workParts.some((part) => this.hasActiveHistoricalPart(part))) {
        await this.renderHistoricalTimeline(activity.body, workParts);
      } else {
        this.deferHistoricalActivityHydration(activity, workParts);
      }
    } else {
      for (const part of workParts) await this.renderHistoricalPart(parent, part);
    }
    for (const finalAnswer of finalAnswers) await this.renderHistoricalPart(parent, finalAnswer);
    return hasActivity;
  }

  private hasActiveHistoricalPart(part: MessagePart): boolean {
    const key = part.type === "tool_call" ? toolPartKey(part.data.id) : part.id;
    return this.activeNodes.has(key);
  }

  private async renderHistoricalTimeline(
    parent: HTMLElement,
    parts: readonly MessagePart[],
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const timeline = groupAdjacentAgentActivity(
      parts,
      (part) => part.type === "reasoning" || part.type === "tool_call",
    );
    for (const entry of timeline) {
      if (!isCurrent()) return false;
      if (entry.kind === "item") {
        await this.renderHistoricalPart(parent, entry.item);
        if (!isCurrent()) return false;
        continue;
      }
      const split = splitPreviousAgentActivity(entry.items);
      if (split.previous.length > 0) {
        if (split.latest) {
          await this.renderHistoricalPart(parent, split.latest);
          if (!isCurrent()) return false;
        }
        const latestNode = parent.lastElementChild as HTMLElement | null;
        const overflow = this.createActivityOverflow(
          parent,
          split.previous.length,
          `overflow:${historicalPartKey(split.previous[0]!)}`,
        );
        this.setActivityOverflowItems(
          overflow.element,
          latestNode,
          [],
        );
        this.deferHistoricalOverflowHydration(overflow.element, split.previous);
        continue;
      }
      if (split.latest) {
        await this.renderHistoricalPart(parent, split.latest);
        if (!isCurrent()) return false;
      }
    }
    return true;
  }

  private deferHistoricalOverflowHydration(
    element: HTMLButtonElement,
    parts: readonly MessagePart[],
  ): void {
    this.historicalOverflowHydrationStates.set(element, {
      parts,
      status: "cold",
      staging: null,
      hydration: null,
    });
  }

  private startHistoricalOverflowHydration(
    element: HTMLButtonElement,
  ): Promise<void> | null {
    const state = this.historicalOverflowHydrationStates.get(element);
    if (!state || state.status === "hydrated" || state.status === "disposed") return null;
    if (state.hydration) return state.hydration;

    this.setHistoricalHydrationStatus(state, "hydrating");
    const lifecycleGeneration = this.lifecycleGeneration;
    const staging = createSurfaceElement(element.ownerDocument, "div");
    state.staging = staging;
    const isCurrent = (): boolean =>
      this.renderingEnabled
      && lifecycleGeneration === this.lifecycleGeneration
      && state.status !== "disposed"
      && this.historicalOverflowHydrationStates.get(element) === state;
    const discardStaging = (): void => {
      this.forgetMarkdown(staging);
      if (
        state.status !== "disposed"
        && this.historicalOverflowHydrationStates.get(element) === state
      ) {
        this.setHistoricalHydrationStatus(state, "cold");
      }
    };
    let hydration!: Promise<void>;
    hydration = (async (): Promise<void> => {
      try {
        for (const part of state.parts) {
          if (!isCurrent()) {
            discardStaging();
            return;
          }
          await this.renderHistoricalPart(staging, part);
        }
        if (!isCurrent()) {
          discardStaging();
          return;
        }
        const overflow = this.activityOverflowStates.get(element);
        if (!overflow) {
          this.disposeHistoricalOverflowHydration(element);
          return;
        }
        overflow.previousNodes = Array.from(staging.children) as HTMLElement[];
        state.staging = null;
        this.setHistoricalHydrationStatus(state, "hydrated");
        this.applyActivityOverflowLayout(element);
      } catch (error) {
        discardStaging();
        throw error;
      } finally {
        if (state.staging === staging) state.staging = null;
        if (state.hydration === hydration) state.hydration = null;
      }
    })();
    state.hydration = hydration;
    return hydration;
  }

  private deferHistoricalActivityHydration(
    activity: Readonly<{
      element: HTMLDetailsElement;
      summary: HTMLElement;
      body: HTMLElement;
    }>,
    parts: readonly MessagePart[],
  ): void {
    const state: HistoricalActivityHydrationState = {
      ...activity,
      parts,
      status: "cold",
      staging: null,
      hydration: null,
    };
    this.historicalActivityHydrationStates.set(activity.element, state);
    activity.element.addEventListener("toggle", () => {
      if (!activity.element.open) return;
      void this.hydrateHistoricalActivity(state).catch(() => undefined);
    });
  }

  private hydrateHistoricalActivity(
    state: HistoricalActivityHydrationState,
  ): Promise<void> {
    if (state.status === "hydrated" || state.status === "disposed") {
      return Promise.resolve();
    }
    if (state.hydration) return state.hydration;
    this.setHistoricalHydrationStatus(state, "hydrating");
    const lifecycleGeneration = this.lifecycleGeneration;
    const staging = createSurfaceElement(state.body.ownerDocument, "div");
    state.staging = staging;
    const isCurrent = (): boolean =>
      this.renderingEnabled
      && lifecycleGeneration === this.lifecycleGeneration
      && state.status !== "disposed"
      && this.historicalActivityHydrationStates.get(state.element) === state;
    let hydration!: Promise<void>;
    hydration = (async (): Promise<void> => {
      try {
        const rendered = await this.renderHistoricalTimeline(staging, state.parts, isCurrent);
        if (!rendered || !isCurrent()) {
          this.forgetMarkdown(staging);
          return;
        }
        const finishLayoutMutation = this.options.beginLayoutMutation?.(
          state.summary.isConnected ? state.summary : undefined,
          state.body,
        );
        try {
          if (!isCurrent()) {
            this.forgetMarkdown(staging);
            return;
          }
          state.body.replaceChildren(...Array.from(staging.childNodes));
          state.staging = null;
          this.setHistoricalHydrationStatus(state, "hydrated");
        } finally {
          finishLayoutMutation?.();
        }
      } catch (error) {
        this.forgetMarkdown(staging);
        if (isCurrent()) this.setHistoricalHydrationStatus(state, "cold");
        throw error;
      } finally {
        if (state.status === "hydrating") {
          this.setHistoricalHydrationStatus(state, "cold");
        }
        if (state.staging === staging) state.staging = null;
        if (state.hydration === hydration) state.hydration = null;
      }
    })();
    state.hydration = hydration;
    return hydration;
  }

  private async adoptHistoricalParts(
    parent: HTMLElement,
    parts: readonly MessagePart[],
    elapsedMs: number | undefined,
    finalAnswerPartIds: ReadonlySet<string>,
    cancelled = false,
  ): Promise<boolean> {
    const { workParts, finalAnswers, hasActivity } = partitionHistoricalParts(
      parts,
      finalAnswerPartIds,
    );
    const work = await this.adoptHistoricalLanes(workParts, parent);
    const desired: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    if (hasActivity) {
      if (!this.activeCompletedFold || !this.activeCompletedFoldBody) {
        const created = this.createCompletedActivity(parent, elapsedMs, cancelled);
        this.activeCompletedFold = created.element;
        this.activeCompletedFoldBody = created.body;
      } else {
        this.activeCompletedFold.querySelector<HTMLElement>(
          ":scope > .systemsculpt-agent-activity-header > .systemsculpt-agent-activity-label",
        )?.setText(this.workedLabel(elapsedMs, cancelled));
      }
      const grouped = this.groupActiveTimeline(
        this.activeCompletedFoldBody,
        work.map(({ key, node }) => ({ key, node })),
        work.map(({ part }) => part),
      );
      this.reconcileChildren(this.activeCompletedFoldBody, grouped.map(({ node }) => node));
      desired.push({ key: "turn-fold", node: this.activeCompletedFold });
    } else {
      desired.push(...work.map(({ key, node }) => ({ key, node })));
    }
    const final = await this.adoptHistoricalLanes(finalAnswers, parent);
    desired.push(...final.map(({ key, node }) => ({ key, node })));
    this.reconcileChildren(parent, desired.map(({ node }) => node));
    return hasActivity;
  }

  private async adoptHistoricalLanes(
    parts: readonly MessagePart[],
    insertionParent: HTMLElement,
  ): Promise<Array<Readonly<{ key: string; node: HTMLElement; part: AgentPart }>>> {
    const lanes: Array<Readonly<{ key: string; node: HTMLElement; part: AgentPart }>> = [];
    for (const messagePart of parts) {
      const part = this.historicalAgentPart(messagePart);
      if (!part) continue;
      const key = part.kind === "tool" ? toolPartKey(part.callId) : part.id;
      const node = await this.renderActivePart(part, key, false, insertionParent);
      if (messagePart.type === "content") {
        const content = presentMessageContent(messagePart.data);
        node.querySelectorAll(":scope > .systemsculpt-agent-message-attachments")
          .forEach((attachment) => attachment.remove());
        if (content.attachments.length > 0) this.renderMessageAttachments(node, content.attachments);
      }
      lanes.push({ key, node, part });
    }
    return lanes;
  }

  private historicalAgentPart(part: MessagePart): AgentPart | null {
    if (part.type === "reasoning") {
      return {
        id: part.id,
        order: part.timestamp,
        kind: "reasoning",
        messageId: "",
        state: "complete",
        summary: part.data,
      };
    }
    if (part.type === "tool_call") return this.historicalToolPart(part.data);
    const content = presentMessageContent(part.data);
    return {
      id: part.id,
      order: part.timestamp,
      kind: "text",
      messageId: "",
      state: "complete",
      markdown: content.markdown,
    };
  }

  private releaseAdoptedActiveTurn(): void {
    this.activeTailStatus?.remove();
    this.stopWorkingTimer();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeTailStatus = null;
    this.activeCompletedFold = null;
    this.activeCompletedFoldBody = null;
    this.activeOverflowNodes.clear();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolDisplayFingerprints.clear();
    this.activeToolErrorSuppression.clear();
    this.element.setAttribute("aria-busy", "false");
  }

  public renderActive(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    return this.measureIncidentRenderPass(() =>
      this.renderActivePass(snapshot, presentation));
  }

  private async renderActivePass(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    if (!this.renderingEnabled) return;
    const lifecycleGeneration = this.lifecycleGeneration;
    const isCurrent = (): boolean =>
      this.renderingEnabled && lifecycleGeneration === this.lifecycleGeneration;
    this.element.setAttribute("aria-busy", String(presentation.busy));
    const body = this.ensureActiveTurn(snapshot.turnId);
    this.activeTurn?.toggleClass("is-active", presentation.busy);
    const hasCommittedFailedProjection = presentation.phase === "failed"
      && snapshot.messages.some((message) =>
        this.committedFailedMessageIds.has(message.id));
    const wantedParts = new Set<string>();
    const orderedParts = presentation.visibleParts
      .map((part) => terminalToolPresentation(part, presentation))
      .map((part, index) => ({ part, index }))
      .sort((left, right) =>
        left.part.order - right.part.order || left.index - right.index)
      .map(({ part }) => part)
      // History and the live run are sibling containers. Once a part's
      // message is rendered in the committed transcript above, its live copy
      // would show the same content twice; only parts history cannot carry
      // (the terminal error and its Retry affordance) may stay.
      .filter((part) =>
        part.kind === "error" || !this.historyMessageIds.has(part.messageId))
      .filter((part) => part.kind !== "error" || !hasCommittedFailedProjection)
      .filter((part) =>
        presentation.phase !== "completed"
        || part.kind !== "reasoning"
        || part.summary.trim().length > 0);
    const terminalErrors = orderedParts.filter(
      (part): part is Extract<AgentPart, { kind: "error" }> => part.kind === "error",
    );
    const hasCommittedCancelledProjection = presentation.phase === "cancelled"
      && snapshot.messages.some((message) =>
        this.committedCancelledMessageIds.has(message.id));
    const showTerminalStatus = presentation.phase === "cancelled"
      ? !hasCommittedCancelledProjection
      : presentation.phase === "failed"
        && terminalErrors.length === 0
        && !hasCommittedFailedProjection;
    const tailStatus = presentation.busy || showTerminalStatus
      ? this.ensureTailStatus(presentation, snapshot.elapsedMs)
      : null;
    if (!tailStatus && this.activeTailStatus) {
      this.activeTailStatus.remove();
      this.activeTailStatus = null;
      this.stopWorkingTimer();
    }
    if (orderedParts.length === 0 && !tailStatus) {
      this.clearActive();
      return;
    }
    const duplicatesTerminalError = (part: AgentToolPart): boolean =>
      Boolean(part.error && terminalErrors.some((terminal) =>
        terminal.error.code === part.error?.code
        && terminal.error.message === part.error.message));
    const lanes: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    const renderErrors: unknown[] = [];
    for (const part of orderedParts) {
      const key = part.kind === "tool" ? toolPartKey(part.callId) : part.id;
      wantedParts.add(key);
      try {
        const node = await this.renderActivePart(
          part,
          key,
          part.kind === "tool" && duplicatesTerminalError(part),
        );
        if (!isCurrent()) return;
        lanes.push({ key, node });
      } catch (error) {
        if (!isCurrent()) return;
        renderErrors.push(error);
        const node = this.activeNodes.get(key);
        if (node) lanes.push({ key, node });
      }
    }
    if (!isCurrent()) return;
    const finalAnswerPartIds = presentation.phase === "completed"
      ? finalAgentAnswerPartIds(orderedParts.flatMap((part) => part.kind === "error" ? [] : [{
        id: part.id,
        messageId: part.messageId,
        visible: part.kind === "text"
          ? part.markdown.trim().length > 0
          : part.kind !== "reasoning" || part.summary.trim().length > 0,
        kind: isAgentActivityPart(part)
          ? "activity" as const
          : part.id.startsWith("sources:")
            ? "sources" as const
            : "content" as const,
      }]))
      : new Set<string>();
    const visibleLanes = presentation.phase === "completed"
      ? this.completedActiveLanes(
        body,
        lanes,
        orderedParts,
        finalAnswerPartIds,
        snapshot.elapsedMs,
      )
      : this.groupActiveTimeline(body, lanes, orderedParts);
    if (tailStatus) {
      visibleLanes.push({
        key: "tail-status",
        node: tailStatus,
      });
    }

    this.reconcileChildren(body, visibleLanes.map((lane) => lane.node));
    for (const [key, node] of this.activeNodes) {
      if (!wantedParts.has(key)) {
        this.forgetMarkdown(node);
        node.remove();
        this.activeNodes.delete(key);
        this.activePartRefs.delete(key);
        this.activeToolDisplayFingerprints.delete(key);
        this.activeToolErrorSuppression.delete(key);
      }
    }
    if (renderErrors.length > 0) throw renderErrors[0];
  }

  private completedActiveLanes(
    body: HTMLElement,
    lanes: Array<Readonly<{ key: string; node: HTMLElement }>>,
    parts: readonly AgentPart[],
    finalAnswerPartIds: ReadonlySet<string>,
    elapsedMs?: number,
  ): Array<Readonly<{ key: string; node: HTMLElement }>> {
    const finalAnswers = lanes.filter((_, index) => finalAnswerPartIds.has(parts[index]!.id));
    const workLanes = lanes.filter((_, index) => !finalAnswerPartIds.has(parts[index]!.id));
    const workParts = parts.filter((part) => !finalAnswerPartIds.has(part.id));
    const hasActivity = workParts.some(isAgentActivityPart);
    if (!hasActivity) return lanes;
    const focused = body.ownerDocument.activeElement;
    const focusedElement = focused?.nodeType === 1 ? focused as HTMLElement : null;
    const moveFocusToFold = focusedElement !== null
      && workLanes.some(({ node }) => node.contains(focusedElement));
    if (!this.activeCompletedFold || !this.activeCompletedFoldBody) {
      const created = this.createCompletedActivity(body, elapsedMs);
      this.activeCompletedFold = created.element;
      this.activeCompletedFoldBody = created.body;
    } else {
      this.activeCompletedFold.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-activity-header > .systemsculpt-agent-activity-label",
      )?.setText(this.workedLabel(elapsedMs));
    }
    const rendered = this.groupActiveTimeline(this.activeCompletedFoldBody, workLanes, workParts);
    this.reconcileChildren(this.activeCompletedFoldBody, rendered.map(({ node }) => node));
    if (moveFocusToFold) {
      this.activeCompletedFold.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-activity-header",
      )?.focus({ preventScroll: true });
    }
    return [
      { key: "turn-fold", node: this.activeCompletedFold },
      ...finalAnswers,
    ];
  }

  private groupActiveTimeline(
    parent: HTMLElement,
    lanes: readonly Readonly<{ key: string; node: HTMLElement }>[],
    parts: readonly AgentPart[],
  ): Array<Readonly<{ key: string; node: HTMLElement }>> {
    const result: Array<Readonly<{ key: string; node: HTMLElement }>> = [];
    const timeline = groupAdjacentAgentActivity(
      lanes.map((lane, index) => ({ lane, part: parts[index]! })),
      ({ part }) => isAgentActivityPart(part),
    );
    const wantedOverflowKeys = new Set<string>();
    for (const entry of timeline) {
      if (entry.kind === "item") {
        result.push(entry.item.lane);
        continue;
      }
      const split = splitPreviousAgentActivity(entry.items);
      if (split.previous.length > 0) {
        const first = split.previous[0]!;
        const key = `overflow:${first.lane.key}`;
        wantedOverflowKeys.add(key);
        let overflow = this.activeOverflowNodes.get(key);
        if (!overflow) {
          overflow = this.createActivityOverflow(parent, split.previous.length, key).element;
          this.activeOverflowNodes.set(key, overflow);
        } else {
          this.updateActivityOverflow(overflow, split.previous.length);
        }
        const previousLanes = split.previous.map(({ lane }) => lane);
        this.setActivityOverflowItems(
          overflow,
          split.latest?.lane.node ?? null,
          previousLanes.map(({ node }) => node),
        );
        result.push({ key, node: overflow });
        const overflowBody = this.activityOverflowStates.get(overflow)?.body;
        if (overflowBody) result.push({ key: `${key}:body`, node: overflowBody });
        continue;
      }
      if (split.latest) result.push(split.latest.lane);
    }
    for (const [key, overflow] of this.activeOverflowNodes) {
      if (wantedOverflowKeys.has(key)) continue;
      this.activityOverflowStates.get(overflow)?.body.remove();
      this.forgetMarkdown(overflow);
      overflow.remove();
      this.activeOverflowNodes.delete(key);
      this.activityOverflowStates.delete(overflow);
    }
    return result;
  }

  private async renderActivePart(
    part: AgentPart,
    key: string,
    suppressToolError = false,
    insertionParent?: HTMLElement,
  ): Promise<HTMLElement> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const renderEpoch = this.toolRenderEpoch;
    let node = this.activeNodes.get(key);
    const createdNode = !node;
    if (!node) {
      node = createSurfaceElement(this.activeRoot.ownerDocument, "div");
      node.addClass("systemsculpt-agent-part", `is-${part.kind}`);
      node.dataset.partKey = key;
      if (isAgentActivityPart(part)) {
        node.dataset.agentActivityRow = "";
        node.dataset.activityKind = part.kind;
      }
      this.activeNodes.set(key, node);
    }
    const needsInsertion = node.parentElement === null;
    const candidate = node.ownerDocument.activeElement;
    const activeElement = candidate?.nodeType === 1 ? candidate as HTMLElement : null;
    const preservedFocusKey = activeElement && node.contains(activeElement)
      ? activeElement.dataset.focusKey
      : undefined;
    const incomingToolFingerprint = part.kind === "tool"
      ? toolDisplayFingerprint(part)
      : undefined;
    const suppressionChanged = part.kind === "tool"
      && this.activeToolErrorSuppression.get(key) !== suppressToolError;
    if (
      !agentPartsEqual(
        this.activePartRefs.get(key),
        part,
        this.activeToolDisplayFingerprints.get(key),
        incomingToolFingerprint,
      )
      || suppressionChanged
    ) {
      const committed = await this.renderPart(
        node,
        part,
        this.activePartRefs.get(key),
        suppressToolError,
      );
      if (
        !this.renderingEnabled
        || lifecycleGeneration !== this.lifecycleGeneration
        || renderEpoch !== this.toolRenderEpoch
      ) {
        if (createdNode && this.activeNodes.get(key) === node) {
          this.forgetMarkdown(node);
          node.remove();
          this.activeNodes.delete(key);
          this.activePartRefs.delete(key);
          this.activeToolDisplayFingerprints.delete(key);
          this.activeToolErrorSuppression.delete(key);
        }
        return node;
      }
      if (committed) {
        this.activePartRefs.set(key, part);
        if (part.kind === "tool") {
          this.activeToolDisplayFingerprints.set(key, incomingToolFingerprint!);
          this.activeToolErrorSuppression.set(key, suppressToolError);
        } else {
          this.activeToolDisplayFingerprints.delete(key);
          this.activeToolErrorSuppression.delete(key);
        }
        if (needsInsertion) {
          if (insertionParent) insertionParent.appendChild(node);
          else this.insertActiveNode(node);
        }
        if (part.kind === "tool") this.startToolApprovalPreviewHydration(node);
      }
    }
    if (preservedFocusKey) {
      node.querySelector<HTMLElement>(`[data-focus-key="${preservedFocusKey}"]`)?.focus();
    }
    return node;
  }

  private insertActiveNode(node: HTMLElement): void {
    if (!this.activeBody) return;
    this.activeBody.insertBefore(
      node,
      this.activeTailStatus?.parentElement === this.activeBody
        ? this.activeTailStatus
        : null,
    );
  }

  private createCompletedActivity(
    parent: HTMLElement,
    elapsedMs?: number,
    cancelled = false,
  ): Readonly<{
    element: HTMLDetailsElement;
    summary: HTMLElement;
    body: HTMLElement;
  }> {
    const element = parent.createEl("details", {
      cls: "systemsculpt-agent-activity is-settled",
      attr: {
        "data-agent-turn-fold": "",
        "data-activity-state": "settled",
      },
    }) as HTMLDetailsElement;
    const header = element.createEl("summary", {
      cls: "systemsculpt-agent-activity-header",
      attr: {
        "data-focus-key": "activity-summary",
        tabindex: "0",
      },
    });
    header.createEl("strong", {
      cls: "systemsculpt-agent-activity-label",
      text: this.workedLabel(elapsedMs, cancelled),
    });
    const disclosure = header.createSpan({
      cls: "systemsculpt-agent-activity-disclosure",
    });
    setIcon(disclosure, "chevron-right");
    const body = element.createDiv({
      cls: "systemsculpt-agent-activity-body",
      attr: { "data-agent-turn-fold-body": "" },
    });
    element.open = false;
    this.trackIncidentDisclosure(element, "activity", true, false);
    element.addEventListener("toggle", () => {
      this.updateIncidentDisclosure(element, true, element.open);
    });
    return { element, summary: header, body };
  }

  private createActivityOverflow(
    parent: HTMLElement,
    hiddenCount: number,
    key: string,
  ): Readonly<{ element: HTMLButtonElement }> {
    const element = parent.createEl("button", {
      cls: "systemsculpt-agent-activity-overflow systemsculpt-agent-activity-overflow-header",
      attr: {
        type: "button",
        "aria-expanded": "false",
        "data-testid": "chat.activity.previous-tools",
        "data-agent-activity-overflow": "",
        "data-agent-activity-overflow-key": key,
        "data-focus-key": "activity-overflow-summary",
      },
    });
    const icon = element.createSpan({
      cls: "systemsculpt-agent-activity-overflow-icon",
    });
    setIcon(icon, "sparkles");
    icon.dataset.iconName = "sparkles";
    const label = element.createEl("strong", {
      cls: "systemsculpt-agent-activity-overflow-label",
      text: this.activityOverflowLabel(hiddenCount, null),
    });
    const disclosure = element.createSpan({
      cls: "systemsculpt-agent-activity-overflow-disclosure",
    });
    setIcon(disclosure, "chevron-right");
    disclosure.dataset.iconName = "chevron-right";
    const body = parent.createDiv({
      cls: "systemsculpt-agent-activity-overflow-body",
      attr: {
        hidden: "",
        role: "group",
        "aria-label": "Tool calls",
      },
    });
    const bodyId = `systemsculpt-agent-activity-drawer-${String(++activityDrawerSequence)}`;
    body.id = bodyId;
    element.setAttribute("aria-controls", bodyId);
    this.activityOverflowStates.set(element, {
      body,
      icon,
      label,
      latestNode: null,
      previousNodes: [],
    });
    this.trackIncidentDisclosure(element, "overflow", true, false);
    element.onclick = () => {
      const finishLayoutMutation = this.options.beginLayoutMutation?.(element, body);
      const expanded = !this.activityOverflowExpanded(element);
      element.setAttribute("aria-expanded", String(expanded));
      this.updateIncidentDisclosure(element, true, expanded);
      this.applyActivityOverflowLayout(element);
      const hydration = expanded
        ? this.startHistoricalOverflowHydration(element)
        : null;
      if (!hydration) {
        finishLayoutMutation?.();
        return;
      }
      void hydration.catch(() => undefined).finally(() => finishLayoutMutation?.());
    };
    this.updateActivityOverflow(element, hiddenCount);
    return { element };
  }

  private setActivityOverflowItems(
    element: HTMLButtonElement,
    latestNode: HTMLElement | null,
    previousNodes: readonly HTMLElement[],
  ): void {
    const state = this.activityOverflowStates.get(element);
    if (!state) return;
    const unchanged = state.latestNode === latestNode
      && state.previousNodes.length === previousNodes.length
      && state.previousNodes.every((node, index) => node === previousNodes[index]);
    if (unchanged) {
      this.applyActivityOverflowLayout(element);
      return;
    }
    const wanted = new Set(previousNodes);
    for (const node of state.previousNodes) {
      if (!wanted.has(node)) node.remove();
    }
    state.latestNode = latestNode;
    state.previousNodes = [...previousNodes];
    this.applyActivityOverflowLayout(element);
  }

  private activityOverflowExpanded(element: HTMLButtonElement): boolean {
    return element.getAttribute("aria-expanded") === "true";
  }

  private applyActivityOverflowLayout(element: HTMLButtonElement): void {
    const state = this.activityOverflowStates.get(element);
    if (!state) return;
    const count = Number(element.dataset.hiddenCount);
    const expanded = this.activityOverflowExpanded(element);
    const label = this.activityOverflowLabel(
      Number.isFinite(count) ? count : 0,
      state.latestNode,
    );
    if (state.label.textContent !== label) state.label.setText(label);
    this.updateActivityOverflowIcon(state.icon, state.latestNode);
    const desired = state.latestNode
      ? [...(expanded ? state.previousNodes : []), state.latestNode]
      : [];
    this.reconcileChildren(state.body, desired);
    state.body.toggleAttribute("hidden", !expanded);
  }

  private updateActivityOverflowIcon(icon: HTMLElement, latestNode: HTMLElement | null): void {
    const reasoningIcon = latestNode?.querySelector<HTMLElement>(
      ".systemsculpt-agent-reasoning-icon",
    ) ?? null;
    const toolIcon = latestNode?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-icon",
    ) ?? null;
    const iconName = reasoningIcon
      ? reasoningIcon.dataset.iconState === "streaming" ? "loader-circle" : "sparkles"
      : toolIcon?.dataset.iconName ?? "sparkles";
    if (icon.dataset.iconName !== iconName) {
      setIcon(icon, iconName);
      icon.dataset.iconName = iconName;
    }
    icon.classList.toggle("is-animated", reasoningIcon?.dataset.iconState === "streaming");
  }

  private updateActivityOverflow(element: HTMLButtonElement, hiddenCount: number): void {
    const count = String(hiddenCount);
    if (element.dataset.hiddenCount !== count) element.dataset.hiddenCount = count;
  }

  private activityOverflowLabel(count: number, latestNode: HTMLElement | null): string {
    const latestLabel = latestNode?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-label, .systemsculpt-agent-reasoning-header strong",
    )?.textContent?.trim() || "Activity";
    return `${latestLabel} + ${count} other tool call${count === 1 ? "" : "s"}`;
  }

  private workedLabel(elapsedMs?: number, cancelled = false): string {
    const duration = formatAgentActivityDuration(elapsedMs);
    if (cancelled) {
      return duration ? `You stopped after ${duration}` : "You stopped this response";
    }
    return duration ? `Worked for ${duration}` : "Worked";
  }

  /**
   * A durable cancelled turn without activity keeps a static "Stopped"
   * marker so an interrupted response never reads as silently complete.
   */
  private renderDurableCancelledTail(body: HTMLElement): void {
    const status = body.createDiv({
      cls: "systemsculpt-agent-tail-status is-cancelled",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
        "data-status": "Stopped",
      },
    });
    const icon = status.createSpan({ cls: "systemsculpt-agent-tail-status-icon" });
    setIcon(icon, "circle-stop");
    icon.dataset.iconState = "circle-stop";
    status.createSpan({ cls: "systemsculpt-agent-tail-status-label", text: "Stopped" });
  }

  private async renderDurableFailedTail(
    body: HTMLElement,
    receipt: DurableFailedReceipt,
    retryMessageId: string | null,
    adoptActive: boolean,
  ): Promise<void> {
    const key = `error:${retryMessageId ?? receipt.messageId}`;
    const part: AgentPart = {
      id: key,
      order: Number.MAX_SAFE_INTEGER,
      kind: "error",
      error: {
        code: receipt.failureCode,
        message: "SystemSculpt could not complete the response.",
        retryable: receipt.retryable,
        ...(isLocalReportId(receipt.reportId)
          ? { reportId: receipt.reportId }
          : { incidentId: receipt.reportId }),
        ...(receipt.incidentId ? { incidentId: receipt.incidentId } : {}),
      },
      retryable: receipt.retryable,
      ...(retryMessageId ? { retryMessageId } : {}),
    };
    if (adoptActive) {
      await this.renderActivePart(part, key, false, body);
      return;
    }
    const node = body.createDiv({
      cls: "systemsculpt-agent-part is-error",
      attr: { "data-part-key": key },
    });
    await this.renderPart(node, part);
  }

  private ensureActiveTurn(turnId: string | null): HTMLElement {
    if (this.activeTurn && this.activeBody && this.activeTurnId === turnId) return this.activeBody;
    this.clearActive();
    this.activeTurnId = turnId;
    this.activeTurn = this.activeRoot.createDiv({
      cls: "systemsculpt-agent-turn is-assistant is-active",
      attr: {
        ...(turnId ? { "data-turn-id": turnId } : {}),
      },
    });
    this.activeBody = this.activeTurn.createDiv({ cls: "systemsculpt-agent-turn-body" });
    return this.activeBody;
  }

  private ensureTailStatus(
    presentation: AgentConversationPresentation,
    elapsedMs?: number,
  ): HTMLElement {
    let status = this.activeTailStatus;
    if (!status) {
      status = this.activeRoot.createDiv({
        cls: "systemsculpt-agent-tail-status",
      });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-icon" });
      status.createSpan({ cls: "systemsculpt-agent-tail-status-label" });
      this.activeTailStatus = status;
    }
    status.className =
      `systemsculpt-agent-tail-status is-${presentation.phase}`;
    const workingElapsedMs = presentation.busy
      ? this.startWorkingTimer(status, elapsedMs)
      : undefined;
    const workingDuration = formatAgentWorkingDuration(workingElapsedMs);
    const displayStatus = presentation.busy
      ? (workingDuration ? `Working for ${workingDuration}` : "Working")
      : presentation.activityStatus;
    const statusChanged = status.dataset.status !== displayStatus;
    if (statusChanged) {
      status.dataset.status = displayStatus;
      this.setTextNode(
        status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label"),
        displayStatus,
      );
    }
    status.toggleAttribute("data-agent-working-timer", presentation.busy);
    const label = status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label");
    label?.toggleAttribute("data-agent-working-duration", presentation.busy);
    if (!presentation.busy) this.stopWorkingTimer();
    const icon = status.querySelector<HTMLElement>(
      ".systemsculpt-agent-tail-status-icon",
    );
    const iconName = presentation.phase === "cancelled"
      ? "circle-stop"
      : presentation.phase === "failed"
        ? "circle-alert"
        : presentation.phase === "awaiting-approval"
          ? "shield-question"
          : "loader-circle";
    if (icon && icon.dataset.iconState !== iconName) {
      setIcon(icon, iconName);
      icon.dataset.iconState = iconName;
    }
    icon?.classList.toggle(
      "is-animated",
      presentation.busy && presentation.phase !== "awaiting-approval",
    );
    if (presentation.busy) {
      status.removeAttribute("role");
      status.removeAttribute("aria-live");
      status.removeAttribute("aria-atomic");
    } else {
      status.setAttribute(
        "role",
        presentation.phase === "failed" ? "alert" : "status",
      );
      status.setAttribute(
        "aria-live",
        presentation.phase === "failed" ? "assertive" : "polite",
      );
      status.setAttribute("aria-atomic", "true");
    }
    return status;
  }

  private startWorkingTimer(
    status: HTMLElement,
    elapsedMs: number | undefined,
  ): number | undefined {
    if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      this.stopWorkingTimer();
      return undefined;
    }
    const observedAt = this.monotonicNow(status);
    const projectedElapsedMs = this.activeElapsedBaseline
      ? this.activeElapsedBaseline.elapsedMs
        + Math.max(0, observedAt - this.activeElapsedBaseline.observedAt)
      : elapsedMs;
    const rebasedElapsedMs = Math.max(elapsedMs, projectedElapsedMs);
    this.activeElapsedBaseline = {
      elapsedMs: rebasedElapsedMs,
      observedAt,
    };
    if (this.activeWorkingTimer !== null) return rebasedElapsedMs;
    const ownerWindow = getSurfaceOwnerWindow(status);
    this.activeWorkingTimer = ownerWindow.setInterval(() => {
      if (!status.isConnected || !this.activeElapsedBaseline) {
        this.stopWorkingTimer();
        return;
      }
      const current = this.activeElapsedBaseline.elapsedMs
        + Math.max(0, this.monotonicNow(status) - this.activeElapsedBaseline.observedAt);
      const text = `Working for ${formatAgentWorkingDuration(current) ?? "0s"}`;
      if (status.dataset.status === text) return;
      status.dataset.status = text;
      this.setTextNode(
        status.querySelector<HTMLElement>(".systemsculpt-agent-tail-status-label"),
        text,
      );
    }, 1_000);
    return rebasedElapsedMs;
  }

  private monotonicNow(element: HTMLElement): number {
    return getSurfaceOwnerWindow(element).performance?.now?.() ?? Date.now();
  }

  private setTextNode(element: HTMLElement | null, text: string): void {
    if (!element) return;
    if (element.childNodes.length === 1 && element.firstChild!.nodeType === Node.TEXT_NODE) {
      element.firstChild!.nodeValue = text;
      return;
    }
    element.replaceChildren(element.ownerDocument.createTextNode(text));
  }

  private stopWorkingTimer(): void {
    if (this.activeWorkingTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearInterval(this.activeWorkingTimer);
      this.activeWorkingTimer = null;
    }
    this.activeElapsedBaseline = null;
  }

  private reconcileChildren(parent: HTMLElement, desired: readonly HTMLElement[]): void {
    let cursor = parent.firstElementChild;
    for (const node of desired) {
      if (cursor !== node) parent.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  private disposeHistoricalActivityHydrationWithin(target: HTMLElement): void {
    for (const [element, state] of this.historicalActivityHydrationStates) {
      if (element !== target && !target.contains(element)) continue;
      this.setHistoricalHydrationStatus(state, "disposed");
      if (state.staging) this.forgetMarkdown(state.staging);
      state.staging = null;
      this.historicalActivityHydrationStates.delete(element);
    }
  }

  private disposeHistoricalOverflowHydration(element: HTMLButtonElement): void {
    const state = this.historicalOverflowHydrationStates.get(element);
    if (!state) return;
    this.setHistoricalHydrationStatus(state, "disposed");
    if (state.staging) this.forgetMarkdown(state.staging);
    state.staging = null;
    this.historicalOverflowHydrationStates.delete(element);
  }

  private disposeHistoricalOverflowHydrationWithin(target: HTMLElement): void {
    for (const element of this.historicalOverflowHydrationStates.keys()) {
      if (element !== target && !target.contains(element)) continue;
      this.disposeHistoricalOverflowHydration(element);
    }
  }

  private captureHistoricalDisclosureState(row: HTMLElement): HistoricalDisclosureSnapshot {
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]");
    const workedBody = worked?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    ) ?? null;
    const hydration = worked
      ? this.historicalActivityHydrationStates.get(worked)
      : undefined;
    const overflowOpen = new Map<string, boolean>();
    for (const overflow of row.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )) {
      const key = overflow.dataset.agentActivityOverflowKey;
      if (key) overflowOpen.set(key, this.activityOverflowExpanded(overflow));
    }
    const reasoningOpen = new Map<string, boolean>();
    const toolOpen = new Map<string, boolean>();
    for (const [key, part] of this.collectHistoricalPartNodes(row)) {
      const reasoning = part.querySelector<HTMLDetailsElement>(
        ":scope > .systemsculpt-agent-reasoning-details",
      );
      if (reasoning) reasoningOpen.set(key, reasoning.open);
      const tool = part.querySelector<HTMLDetailsElement>(
        ":scope > details.systemsculpt-agent-tool",
      );
      if (tool) toolOpen.set(key, tool.open);
    }
    return {
      workedOpen: worked?.open ?? false,
      hydrateWorked: Boolean(
        worked
        && (
          worked.open
          || hydration?.status === "hydrated"
          || (workedBody?.childElementCount ?? 0) > 0
        )
      ),
      overflowOpen,
      reasoningOpen,
      toolOpen,
    };
  }

  private async prepareHistoricalRowReplacement(
    replacement: HistoricalRowReplacement,
  ): Promise<void> {
    const nextWorked = replacement.next.node.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    );
    if (replacement.disclosure.hydrateWorked && nextWorked) {
      const hydration = this.historicalActivityHydrationStates.get(nextWorked);
      if (hydration) await this.hydrateHistoricalActivity(hydration);
    }
    if (nextWorked) {
      nextWorked.open = replacement.disclosure.workedOpen;
      this.updateIncidentDisclosureOpen(nextWorked, nextWorked.open);
    }

    const previousOverflows = new Map<string, HTMLButtonElement>();
    for (const overflow of replacement.previous.node.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )) {
      const key = overflow.dataset.agentActivityOverflowKey;
      if (key) previousOverflows.set(key, overflow);
    }
    for (const overflow of replacement.next.node.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )) {
      const key = overflow.dataset.agentActivityOverflowKey;
      if (!key) continue;
      const expanded = replacement.disclosure.overflowOpen.get(key) === true;
      const previous = previousOverflows.get(key);
      const previousWasHydrated = previous
        ? (this.activityOverflowStates.get(previous)?.previousNodes.length ?? 0) > 0
        : false;
      if (!expanded && !previousWasHydrated) continue;
      overflow.setAttribute("aria-expanded", String(expanded));
      this.updateIncidentDisclosureOpen(overflow, expanded);
      const hydration = this.startHistoricalOverflowHydration(overflow);
      if (hydration) await hydration;
    }

    const previousParts = this.collectHistoricalPartNodes(replacement.previous.node);
    const nextParts = this.collectHistoricalPartNodes(replacement.next.node);
    for (const [key, open] of replacement.disclosure.reasoningOpen) {
      if (!open) continue;
      const previousPart = previousParts.get(key);
      const nextPart = nextParts.get(key);
      const exactNodeWillMove = Boolean(
        previousPart
        && nextPart
        && replacement.previous.partFingerprints.get(key)
          === replacement.next.partFingerprints.get(key),
      );
      const part = exactNodeWillMove ? previousPart : nextPart;
      const details = part?.querySelector<HTMLDetailsElement>(
        ":scope > .systemsculpt-agent-reasoning-details",
      );
      if (!details) continue;
      details.open = true;
      this.updateIncidentDisclosureOpen(details, true);
      await this.renderReasoningDisclosure(details);
    }
  }

  private captureHistoricalReplacementInteraction(
    previousRow: HTMLElement,
    nextRow: HTMLElement,
  ): HistoricalReplacementInteraction | null {
    const candidate = previousRow.ownerDocument.activeElement;
    const focusElement = candidate?.nodeType === 1
      && previousRow.contains(candidate)
      ? candidate as HTMLElement
      : null;
    const selection = previousRow.ownerDocument.getSelection();
    const preservedSelection = selection?.anchorNode
      && selection.focusNode
      && previousRow.contains(selection.anchorNode)
      && previousRow.contains(selection.focusNode)
      ? {
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : null;
    if (!focusElement && !preservedSelection) return null;

    const keyedFocus = focusElement?.closest<HTMLElement>("[data-focus-key]") ?? null;
    const focusKey = keyedFocus?.dataset.focusKey ?? null;
    const part = focusElement?.closest<HTMLElement>("[data-part-key]") ?? null;
    let focusLocator: HistoricalFocusLocator | null = null;
    if (part && previousRow.contains(part) && part.dataset.partKey) {
      focusLocator = { kind: "part", key: part.dataset.partKey, focusKey };
    } else {
      const overflow = focusElement?.closest<HTMLButtonElement>(
        "button[data-agent-activity-overflow-key]",
      ) ?? null;
      if (overflow?.dataset.agentActivityOverflowKey) {
        focusLocator = {
          kind: "overflow",
          key: overflow.dataset.agentActivityOverflowKey,
          focusKey,
        };
      } else if (focusElement?.closest("details[data-agent-turn-fold]")) {
        focusLocator = { kind: "worked", focusKey };
      }
    }
    return {
      focusElement,
      focusLocator,
      focusRow: nextRow,
      selection: preservedSelection,
    };
  }

  private commitHistoricalRowReplacement(replacement: HistoricalRowReplacement): void {
    const previousParts = this.collectHistoricalPartNodes(replacement.previous.node);
    const nextParts = this.collectHistoricalPartNodes(replacement.next.node);
    for (const [key, fingerprint] of replacement.next.partFingerprints) {
      if (replacement.previous.partFingerprints.get(key) !== fingerprint) continue;
      const previousPart = previousParts.get(key);
      const nextPart = nextParts.get(key);
      if (!previousPart || !nextPart || previousPart === nextPart) continue;
      this.moveExactHistoricalPart(
        replacement.previous.node,
        replacement.next.node,
        previousPart,
        nextPart,
      );
    }

    const nextWorked = replacement.next.node.querySelector<HTMLDetailsElement>(
      "details[data-agent-turn-fold]",
    );
    if (nextWorked) {
      nextWorked.open = replacement.disclosure.workedOpen;
      this.updateIncidentDisclosureOpen(nextWorked, nextWorked.open);
    }

    const transferredParts = this.collectHistoricalPartNodes(replacement.next.node);
    for (const [key, open] of replacement.disclosure.reasoningOpen) {
      const details = transferredParts.get(key)?.querySelector<HTMLDetailsElement>(
        ":scope > .systemsculpt-agent-reasoning-details",
      );
      if (details) {
        details.open = open;
        this.updateIncidentDisclosureOpen(details, open);
      }
    }
    for (const [key, open] of replacement.disclosure.toolOpen) {
      const details = transferredParts.get(key)?.querySelector<HTMLDetailsElement>(
        ":scope > details.systemsculpt-agent-tool",
      );
      if (details) {
        details.open = open;
        this.updateIncidentDisclosureOpen(details, open);
      }
    }
    for (const overflow of replacement.next.node.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow-key]",
    )) {
      const key = overflow.dataset.agentActivityOverflowKey;
      const open = key ? replacement.disclosure.overflowOpen.get(key) : undefined;
      if (open === undefined) continue;
      overflow.setAttribute("aria-expanded", String(open));
      this.updateIncidentDisclosureOpen(overflow, open);
      this.applyActivityOverflowLayout(overflow);
    }
  }

  private collectHistoricalPartNodes(row: HTMLElement): Map<string, HTMLElement> {
    const parts = new Map<string, HTMLElement>();
    const remember = (node: HTMLElement | null): void => {
      if (!node) return;
      if (node.dataset.partKey) parts.set(node.dataset.partKey, node);
      for (const child of node.querySelectorAll<HTMLElement>("[data-part-key]")) {
        if (child.dataset.partKey) parts.set(child.dataset.partKey, child);
      }
    };
    remember(row);
    for (const overflow of row.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )) {
      const state = this.activityOverflowStates.get(overflow);
      if (!state) continue;
      remember(state.latestNode);
      for (const node of state.previousNodes) remember(node);
    }
    return parts;
  }

  private moveExactHistoricalPart(
    previousRow: HTMLElement,
    nextRow: HTMLElement,
    previousPart: HTMLElement,
    nextPart: HTMLElement,
  ): void {
    for (const overflow of previousRow.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )) {
      const state = this.activityOverflowStates.get(overflow);
      if (!state) continue;
      if (state.latestNode === previousPart) state.latestNode = null;
      state.previousNodes = state.previousNodes.filter((node) => node !== previousPart);
    }
    for (const overflow of nextRow.querySelectorAll<HTMLButtonElement>(
      "button[data-agent-activity-overflow]",
    )) {
      const state = this.activityOverflowStates.get(overflow);
      if (!state) continue;
      if (state.latestNode === nextPart) state.latestNode = previousPart;
      state.previousNodes = state.previousNodes.map((node) =>
        node === nextPart ? previousPart : node);
    }
    this.forgetMarkdown(nextPart);
    if (nextPart.parentElement) nextPart.replaceWith(previousPart);
    else previousPart.remove();
  }

  private resolveHistoricalFocus(
    row: HTMLElement,
    locator: HistoricalFocusLocator | null,
  ): HTMLElement | null {
    if (!locator) return null;
    let root: HTMLElement | null = null;
    if (locator.kind === "part") {
      root = this.collectHistoricalPartNodes(row).get(locator.key) ?? null;
    } else if (locator.kind === "overflow") {
      root = Array.from(row.querySelectorAll<HTMLButtonElement>(
        "button[data-agent-activity-overflow-key]",
      )).find((candidate) =>
        candidate.dataset.agentActivityOverflowKey === locator.key) ?? null;
    } else {
      root = row.querySelector<HTMLElement>("details[data-agent-turn-fold]");
    }
    if (!root || !locator.focusKey) return root;
    if (root.dataset.focusKey === locator.focusKey) return root;
    return Array.from(root.querySelectorAll<HTMLElement>("[data-focus-key]"))
      .find((candidate) => candidate.dataset.focusKey === locator.focusKey) ?? root;
  }

  /**
   * The committed transcript replaces the live projection with authoritative
   * DOM. Carry activity and tool disclosure state across that replacement while
   * canonical keys let diagnostics follow the same lifecycle records.
   */
  private transferActivePresentationState(
    desiredRows: readonly HTMLElement[],
  ): HTMLElement | null {
    const focused = this.element.ownerDocument.activeElement;
    const focusedElement = focused?.nodeType === 1 ? focused as HTMLElement : null;
    let focusReplacement: HTMLElement | null = null;
    for (const row of desiredRows) {
      for (const historical of row.querySelectorAll<HTMLElement>(
        ".systemsculpt-agent-part[data-part-key]",
      )) {
        // The selector above guarantees the attribute exists. An empty value
        // cannot match a canonical active-node key, so the map lookup already
        // provides the same safe miss without a second lifecycle branch.
        const active = this.activeNodes.get(historical.dataset.partKey!);
        if (!active || active === historical) continue;

        const activeDetails = Array.from(active.querySelectorAll<HTMLDetailsElement>("details"));
        const historicalDetails = Array.from(
          historical.querySelectorAll<HTMLDetailsElement>("details"),
        );
        activeDetails.forEach((details, index) => {
          const replacement = historicalDetails[index];
          if (replacement) {
            replacement.open = details.open;
            this.updateIncidentDisclosureOpen(replacement, replacement.open);
          }
        });

        if (!focusedElement || !active.contains(focusedElement)) continue;
        const focusKey = focusedElement.dataset.focusKey;
        focusReplacement = focusKey
          ? Array.from(historical.querySelectorAll<HTMLElement>("[data-focus-key]"))
            .find((candidate) => candidate.dataset.focusKey === focusKey) ?? null
          : historical;
      }
    }
    return focusReplacement;
  }

  public clearActive(): void {
    this.toolRenderEpoch += 1;
    this.forgetMarkdown(this.activeRoot);
    this.activeRoot.empty();
    this.activeTurn = null;
    this.activeBody = null;
    this.activeTurnId = null;
    this.activeTailStatus = null;
    this.activeCompletedFold = null;
    this.activeCompletedFoldBody = null;
    this.stopWorkingTimer();
    this.activeOverflowNodes.clear();
    this.activeNodes.clear();
    this.activePartRefs.clear();
    this.activeToolDisplayFingerprints.clear();
    this.activeToolErrorSuppression.clear();
    this.element.setAttribute("aria-busy", "false");
  }

  public showCompletedRenderFallback(): void {
    this.element.setAttribute("aria-busy", "false");
    if (this.activeRoot.querySelector(".systemsculpt-agent-render-fallback")) return;
    this.activeRoot.createDiv({
      cls: "systemsculpt-agent-render-fallback systemsculpt-agent-banner is-error",
      text: "The response completed, but part of this chat could not be displayed. Reopen the chat to try again.",
      attr: {
        role: "alert",
        "aria-live": "assertive",
      },
    });
  }

  /*
   * Stable part nodes are reconciled above. Only the changed part subtree is
   * refreshed, so adding a tool does not remount earlier text or disclosures.
   */
  private async renderPart(
    node: HTMLElement,
    part: AgentPart,
    previousPart?: AgentPart,
    suppressToolError = false,
  ): Promise<boolean> {
    if (part.kind === "text") {
      node.className = "systemsculpt-agent-part is-text";
      node.classList.toggle("is-streaming", part.state === "streaming");
      if (part.state === "streaming") {
        this.liveMarkdown.stream(node, part.markdown);
        return true;
      }
      await this.liveMarkdown.settle(node, part.markdown);
      return true;
    }
    if (
      part.kind === "reasoning"
      && previousPart?.kind === "reasoning"
      && await this.updateReasoning(node, part)
    ) {
      return true;
    }
    if (part.kind === "tool") {
      return this.renderTool(node, part, suppressToolError);
    }
    this.forgetMarkdown(node);
    node.empty();
    node.className = `systemsculpt-agent-part is-${part.kind}`;
    switch (part.kind) {
      case "reasoning": {
        await this.renderReasoning(
          node,
          part.summary,
          part.state === "streaming",
        );
        return true;
      }
      case "error": {
        node.setAttrs({ role: "alert", "aria-live": "assertive" });
        const errorIcon = node.createSpan({ cls: "systemsculpt-agent-error-icon" });
        setIcon(errorIcon, "circle-alert");
        const copy = node.createDiv({ cls: "systemsculpt-agent-error-copy" });
        const presented = presentAgentError(part.error, part.retryable);
        copy.createEl("strong", {
          cls: "systemsculpt-agent-error-heading",
          text: presented.heading,
        });
        copy.createDiv({
          cls: "systemsculpt-agent-error-message",
          text: presented.message,
        });
        if (presented.reportId) {
          copy.createDiv({
            cls: "systemsculpt-agent-error-report",
            text: `Report ID: ${presented.reportId}`,
          });
        }
        const actions = part.retryable && part.retryMessageId && this.options.onRetryFailedTurn
          || presented.reportId && this.options.onCopyIncidentReport
          ? copy.createDiv({ cls: "systemsculpt-agent-error-actions" })
          : null;
        if (actions && part.retryable && part.retryMessageId && this.options.onRetryFailedTurn) {
          const retry = createUiAction(actions, {
            label: "Retry",
            testId: "chat.turn.retry-failed",
            tone: "primary",
            size: "small",
          });
          retry.addClass("systemsculpt-agent-error-retry");
          retry.onclick = () => void this.options.onRetryFailedTurn?.(part.retryMessageId!);
        }
        if (actions && presented.reportId && this.options.onCopyIncidentReport) {
          const copyReport = createUiAction(actions, {
            label: "Copy report ID",
            testId: "chat.turn.copy-incident-report",
            size: "small",
            tooltip: false,
          });
          copyReport.addClass("systemsculpt-agent-error-copy-report");
          copyReport.onclick = () => void this.copyIncidentReport(
            copyReport,
            presented.reportId!,
          );
        }
        return true;
      }
      default:
        return true;
    }
  }

  public override onunload(): void {
    this.renderingEnabled = false;
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.toolRenderEpoch += 1;
    this.disposeHistoricalActivityHydrationWithin(this.element);
    for (const element of Array.from(this.historicalOverflowHydrationStates.keys())) {
      this.disposeHistoricalOverflowHydration(element);
    }
    this.liveMarkdown.clear();
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    this.stopWorkingTimer();
    for (const timer of this.copyFeedbackTimers.values()) ownerWindow.clearTimeout(timer);
    this.copyFeedbackTimers.clear();
    this.historyRows.clear();
    this.incidentHistoricalPartCount = 0;
    this.historyMessageIds = new Set<string>();
    this.committedCancelledMessageIds = new Set<string>();
    this.committedFailedMessageIds = new Set<string>();
    this.committedFailedTurnIds = new Set<string>();
    this.incidentDisclosureStates.clear();
    this.incidentPendingHydrationCount = 0;
    this.clearInlineEditorShortcutGuard();
    this.clearSuppressedEditorKeyup();
  }

  public override onload(): void {
    this.renderingEnabled = true;
    this.lifecycleGeneration += 1;
  }

  private async renderReasoning(
    node: HTMLElement,
    summary: string,
    streaming: boolean,
    preservedOpen?: boolean,
  ): Promise<void> {
    node.classList.toggle("is-streaming", streaming);
    const details = node.createEl("details", {
      cls: "systemsculpt-agent-reasoning-details",
      attr: {
        "data-agent-part-disclosure": "",
        "data-activity-kind": "reasoning",
      },
    });
    details.open = preservedOpen ?? false;
    const header = details.createEl("summary", {
      cls: "systemsculpt-agent-reasoning-header",
      attr: {
        "data-focus-key": "reasoning-summary",
        tabindex: "0",
      },
    });
    header.tabIndex = 0;
    const icon = header.createSpan({ cls: "systemsculpt-agent-reasoning-icon" });
    setIcon(icon, streaming ? "loader-circle" : "sparkles");
    icon.dataset.iconState = streaming ? "streaming" : "complete";
    icon.classList.toggle("is-animated", streaming);
    const labelText = streaming ? "Reasoning..." : "Reasoned";
    header.createEl("strong", { text: labelText });
    const disclosure = header.createSpan({ cls: "systemsculpt-agent-reasoning-disclosure" });
    setIcon(disclosure, "chevron-right");
    const body = details.createDiv({ cls: "systemsculpt-agent-reasoning-body" });
    this.reasoningDisclosureStates.set(details, {
      body,
      summary,
      streaming,
      dirty: true,
      revision: 0,
    });
    this.trackIncidentDisclosure(details, "reasoning", true, details.open);
    details.addEventListener("toggle", () => {
      this.updateIncidentDisclosure(details, true, details.open);
      if (!details.open) {
        this.pauseReasoningDisclosure(details);
        return;
      }
      void this.renderReasoningDisclosure(details).catch(() => undefined);
    });
    if (details.open) await this.renderReasoningDisclosure(details);
  }

  private async updateReasoning(
    node: HTMLElement,
    current: Extract<AgentPart, { kind: "reasoning" }>,
  ): Promise<boolean> {
    const details = node.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details");
    const header = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-header");
    const icon = header?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-icon");
    const label = header?.querySelector<HTMLElement>("strong");
    const body = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-body");
    if (!details || !header || !icon || !label || !body) return false;

    const streaming = current.state === "streaming";
    const labelText = streaming ? "Reasoning..." : "Reasoned";
    node.className = "systemsculpt-agent-part is-reasoning";
    node.classList.toggle("is-streaming", streaming);
    label.setText(labelText);
    const iconState = streaming ? "streaming" : "complete";
    if (icon.dataset.iconState !== iconState) {
      setIcon(icon, streaming ? "loader-circle" : "sparkles");
      icon.dataset.iconState = iconState;
    }
    icon.classList.toggle("is-animated", streaming);
    const state = this.reasoningDisclosureStates.get(details);
    if (!state || state.body !== body) return false;
    if (state.summary !== current.summary || state.streaming !== streaming) {
      state.summary = current.summary;
      state.streaming = streaming;
      state.dirty = true;
      state.revision += 1;
    }
    if (!details.open) return true;
    await this.renderReasoningDisclosure(details);
    return true;
  }

  private pauseReasoningDisclosure(details: HTMLDetailsElement): void {
    const state = this.reasoningDisclosureStates.get(details);
    if (!state) return;
    state.dirty = true;
    state.revision += 1;
    this.forgetMarkdown(state.body);
  }

  private async renderReasoningDisclosure(details: HTMLDetailsElement): Promise<void> {
    const state = this.reasoningDisclosureStates.get(details);
    if (!state || !details.open || !state.dirty) return;
    const revision = state.revision;
    const summary = state.summary;
    const streaming = state.streaming;
    state.dirty = false;
    if (!summary.trim()) {
      this.liveMarkdown.forget(state.body);
      state.body.empty();
      return;
    }
    if (streaming) {
      this.liveMarkdown.stream(state.body, summary);
      return;
    }
    try {
      await this.liveMarkdown.settle(state.body, summary);
    } catch (error) {
      if (details.open && state.revision === revision) state.dirty = true;
      throw error;
    }
    if (!details.open || state.revision !== revision) state.dirty = true;
  }

  private renderTool(
    node: HTMLElement,
    part: AgentToolPart,
    suppressToolError = false,
  ): boolean {
    const presentation = presentAgentTool(part);
    const detailRows = presentAgentToolDetails(part);
    const actionableArtifacts = ACTIONABLE_ARTIFACT_TOOLS.has(presentation.canonicalName)
      ? part.output?.artifacts ?? []
      : [];
    const toolError = part.error && !suppressToolError
      ? visibleToolError(part) ?? "This action could not be completed."
      : null;
    const hasDetail = detailRows.length > 0 || Boolean(toolError) || actionableArtifacts.length > 0;
    const supportFingerprint = JSON.stringify({
      detailRows,
      toolError,
      actionableArtifacts,
      suppressToolError,
    });
    const supportNeedsRender = node.dataset.toolSupportFingerprint !== supportFingerprint
      || !node.querySelector(":scope > .systemsculpt-agent-tool > .systemsculpt-agent-tool-support")
      || !node.querySelector(
        ":scope > .systemsculpt-agent-tool > .systemsculpt-agent-tool-header .systemsculpt-agent-tool-state-icon",
      );

    const stagedSupport = createSurfaceElement(node.ownerDocument, "div");
    stagedSupport.className = "systemsculpt-agent-tool-support";
    if (supportNeedsRender && detailRows.length > 0) {
      const detailsList = stagedSupport.createEl("pre", {
        cls: "systemsculpt-agent-tool-details",
      });
      for (const detail of detailRows) {
        const row = detailsList.createSpan({ cls: "systemsculpt-agent-tool-detail" });
        row.createSpan({ cls: "systemsculpt-agent-tool-detail-label", text: detail.label });
        row.appendText(": ");
        row.createSpan({ cls: "systemsculpt-agent-tool-detail-value", text: detail.value });
      }
    }
    if (supportNeedsRender && toolError) {
      stagedSupport.createDiv({
        cls: "systemsculpt-agent-tool-error",
        text: toolError,
        attr: { role: "alert" },
      });
    }
    if (supportNeedsRender) {
      for (const artifact of actionableArtifacts) {
        this.renderArtifact(stagedSupport, artifact);
      }
    }

    const approvalRequired = part.location === "vault"
      && part.state === "approval-required"
      && Boolean(part.approvalId);
    const approvalFingerprint = approvalRequired
      ? JSON.stringify({
        approvalId: part.approvalId,
        canonicalName: presentation.canonicalName,
        input: part.input,
      })
      : null;
    const existingApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    );
    const reusableApproval = approvalFingerprint
      && existingApproval?.dataset.approvalFingerprint === approvalFingerprint
      ? existingApproval
      : null;
    const stagedApproval = approvalRequired && !reusableApproval
      ? this.createDetachedToolApproval(
        node.ownerDocument,
        part,
        presentation.canonicalName,
      )
      : null;
    if (stagedApproval && approvalFingerprint) {
      stagedApproval.dataset.approvalFingerprint = approvalFingerprint;
    }
    node.className = `systemsculpt-agent-part is-tool is-${presentation.displayState}`;
    node.dataset.agentActivityRow = "";
    node.dataset.activityKind = "tool";
    delete node.dataset.toolCount;
    let shell = node.querySelector<HTMLElement>(":scope > .systemsculpt-agent-tool");
    let header = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-header",
    ) ?? null;
    let copy = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-copy",
    ) ?? null;
    let controls = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-controls",
    ) ?? null;
    let disclosureIcon = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-disclosure",
    ) ?? null;
    let icon = header?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-icon",
    ) ?? null;
    let label = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-label",
    ) ?? null;
    let summary = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-summary",
    ) ?? null;
    let stateIcon = header?.querySelector<HTMLElement>(
      ".systemsculpt-agent-tool-state-icon",
    ) ?? null;
    let support = shell?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-tool-support",
    ) ?? null;
    const preservedOpen = shell?.instanceOf(HTMLDetailsElement) === true
      ? shell.open
      : false;
    let rebuiltShell = false;
    if (
      !shell
      || !shell.instanceOf(HTMLDetailsElement)
      || !header
      || !copy
      || !controls
      || !disclosureIcon
      || !icon
      || !label
      || !summary
      || !stateIcon
      || !support
    ) {
      this.untrackIncidentDisclosuresWithin(node);
      node.empty();
      rebuiltShell = true;
      shell = node.createEl("details", {
        cls: "systemsculpt-agent-tool",
        attr: {
          "data-agent-part-disclosure": "",
          "data-activity-kind": "tool",
        },
      });
      header = shell.createEl("summary", { cls: "systemsculpt-agent-tool-header" });
      icon = header.createSpan({ cls: "systemsculpt-agent-tool-icon" });
      copy = header.createSpan({ cls: "systemsculpt-agent-tool-copy" });
      label = copy.createEl("strong", {
        cls: "systemsculpt-agent-tool-label",
      });
      summary = copy.createSpan({
        cls: "systemsculpt-agent-tool-summary",
      });
      controls = header.createSpan({ cls: "systemsculpt-agent-tool-controls" });
      disclosureIcon = controls.createSpan({
        cls: "systemsculpt-agent-tool-disclosure",
      });
      disclosureIcon.setAttribute("aria-hidden", "true");
      stateIcon = controls.createSpan({ cls: "systemsculpt-agent-tool-state-icon" });
      stateIcon.setAttribute("aria-hidden", "true");
      header.dataset.focusKey = "tool-summary";
      const createdShell = shell as HTMLDetailsElement;
      header.addEventListener("click", (event) => {
        if (!createdShell.classList.contains("is-disclosure")) event.preventDefault();
      });
      createdShell.addEventListener("toggle", () => {
        this.updateIncidentDisclosure(
          createdShell,
          createdShell.classList.contains("is-disclosure"),
          createdShell.open,
        );
      });
      support = shell.createDiv({ cls: "systemsculpt-agent-tool-support" });
      createdShell.open = preservedOpen && hasDetail;
    }

    shell.classList.toggle("is-disclosure", hasDetail);
    if (!hasDetail && (shell as HTMLDetailsElement).open) {
      (shell as HTMLDetailsElement).open = false;
    }
    this.trackIncidentDisclosure(
      shell,
      "tool",
      hasDetail,
      hasDetail && (shell as HTMLDetailsElement).open,
    );
    if (hasDetail) {
      if (disclosureIcon.dataset.iconName !== "chevron-down") {
        setIcon(disclosureIcon, "chevron-down");
        disclosureIcon.dataset.iconName = "chevron-down";
      }
    } else if (disclosureIcon.hasChildNodes()) {
      disclosureIcon.empty();
      delete disclosureIcon.dataset.iconName;
    }
    const accessibleState = presentation.displayState === "succeeded" ? "Done" : "";
    header.removeAttribute("aria-label");
    if (accessibleState) header.setAttribute("aria-description", accessibleState);
    else header.removeAttribute("aria-description");
    const actionIcon = presentation.actionIcon;
    if (icon.dataset.iconName !== actionIcon) {
      setIcon(icon, actionIcon);
      icon.dataset.iconName = actionIcon;
    }
    if (stateIcon.dataset.iconState !== presentation.icon) {
      setIcon(stateIcon, presentation.icon);
      stateIcon.dataset.iconState = presentation.icon;
    }
    if (label.textContent !== presentation.label) label.setText(presentation.label);
    if (presentation.summary) {
      if (summary.textContent !== presentation.summary) summary.setText(presentation.summary);
      summary.toggleAttribute("hidden", false);
    } else {
      if (summary.textContent) summary.setText("");
      summary.toggleAttribute("hidden", true);
    }
    if (supportNeedsRender || rebuiltShell) {
      support.replaceChildren(...Array.from(stagedSupport.childNodes));
      node.dataset.toolSupportFingerprint = supportFingerprint;
    }
    support.toggleAttribute("hidden", !support.hasChildNodes());
    const currentApproval = node.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval",
    );
    const desiredApproval = reusableApproval ?? stagedApproval;
    if (desiredApproval) {
      if (currentApproval && currentApproval !== desiredApproval) {
        currentApproval.replaceWith(desiredApproval);
      } else if (desiredApproval.parentElement !== node) {
        node.appendChild(desiredApproval);
      }
    } else {
      currentApproval?.remove();
    }
    if (desiredApproval && approvalFingerprint) {
      this.prepareToolApprovalPreviewHydration(
        node,
        desiredApproval,
        approvalFingerprint,
        toolCallForPart(part),
      );
    } else {
      this.toolApprovalPreviewHydrationStates.delete(node);
    }
    return true;
  }

  private createDetachedToolApproval(
    ownerDocument: Document,
    part: AgentToolPart,
    canonicalName: string,
  ): HTMLElement {
    const approval = createSurfaceElement(ownerDocument, "div");
    approval.className = "systemsculpt-agent-approval";
    approval.setAttrs({
      role: "group",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    approval.createDiv({
      cls: "systemsculpt-agent-approval-copy",
      text: "Allow this change in your vault?",
    });
    const actions = approval.createDiv({ cls: "systemsculpt-agent-approval-actions" });
    const deny = createUiAction(actions, {
      label: "Deny",
      testId: "chat.approval.deny",
      size: "small",
    });
    deny.setAttr("data-focus-key", "tool-deny");
    const approve = createUiAction(actions, {
      label: "Allow once",
      testId: "chat.approval.allow-once",
      tone: "primary",
      size: "small",
    });
    approve.setAttr("data-focus-key", "tool-allow-once");
    deny.onclick = () => void this.options.onApprove(part.approvalId!, false);
    approve.onclick = () => void this.options.onApprove(part.approvalId!, true);
    if (canonicalName !== "trash") {
      const allowForChat = createUiAction(actions, {
        label: "Allow for chat",
        testId: "chat.approval.allow-for-chat",
        size: "small",
      });
      allowForChat.setAttr("data-focus-key", "tool-allow-chat");
      allowForChat.onclick = () => void this.options.onApprove(part.approvalId!, true, true);
    }
    approval.createDiv({
      cls: "systemsculpt-agent-approval-preview",
      attr: { hidden: "" },
    });
    return approval;
  }

  private prepareToolApprovalPreviewHydration(
    node: HTMLElement,
    approval: HTMLElement,
    fingerprint: string,
    toolCall: ToolCall,
  ): void {
    const existing = this.toolApprovalPreviewHydrationStates.get(node);
    if (
      existing
      && existing.approval === approval
      && existing.fingerprint === fingerprint
    ) {
      return;
    }
    const preview = approval.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-approval-preview",
    );
    if (!preview) return;
    this.toolApprovalPreviewHydrationStates.set(node, {
      approval,
      preview,
      fingerprint,
      toolCall,
      lifecycleGeneration: this.lifecycleGeneration,
      toolRenderEpoch: this.toolRenderEpoch,
      hydration: null,
    });
  }

  private startToolApprovalPreviewHydration(
    node: HTMLElement,
  ): Promise<void> | null {
    const state = this.toolApprovalPreviewHydrationStates.get(node);
    if (!state) return null;
    if (state.hydration) return state.hydration;
    state.hydration = this.hydrateToolApprovalPreview(node, state).catch(() => undefined);
    return state.hydration;
  }

  private async hydrateToolApprovalPreview(
    node: HTMLElement,
    state: ToolApprovalPreviewHydrationState,
  ): Promise<void> {
    const staging = createSurfaceElement(state.preview.ownerDocument, "div");
    try {
      const diff = await renderWriteEditInlineDiff(
        this.options.app,
        staging,
        state.toolCall,
      );
      if (!diff) await renderOperationsInlinePreview(staging, state.toolCall);
    } catch {
      return;
    }
    if (!this.isCurrentToolApprovalPreview(node, state)) return;
    const finishLayoutMutation = this.options.beginLayoutMutation?.(
      undefined,
      state.preview,
    );
    try {
      if (!this.isCurrentToolApprovalPreview(node, state)) return;
      state.preview.replaceChildren(...Array.from(staging.childNodes));
      state.preview.toggleAttribute("hidden", !state.preview.hasChildNodes());
    } finally {
      finishLayoutMutation?.();
    }
  }

  private isCurrentToolApprovalPreview(
    node: HTMLElement,
    state: ToolApprovalPreviewHydrationState,
  ): boolean {
    return this.renderingEnabled
      && state.lifecycleGeneration === this.lifecycleGeneration
      && state.toolRenderEpoch === this.toolRenderEpoch
      && this.toolApprovalPreviewHydrationStates.get(node) === state
      && node.isConnected
      && state.approval.isConnected
      && state.approval.dataset.approvalFingerprint === state.fingerprint
      && state.approval.contains(state.preview)
      && node.querySelector(":scope > .systemsculpt-agent-approval") === state.approval;
  }

  private renderArtifact(parent: HTMLElement, artifact: AgentArtifact): void {
    const card = parent.createDiv({ cls: "systemsculpt-agent-artifact" });
    const icon = card.createSpan({ cls: "systemsculpt-agent-artifact-icon" });
    setIcon(icon, artifact.kind === "diff" ? "diff" : "file-check-2");
    const copy = card.createDiv({ cls: "systemsculpt-agent-artifact-copy" });
    copy.createEl("strong", { text: artifact.title });
    if (artifact.description) copy.createDiv({ text: artifact.description });
    if (!artifact.path?.trim()) return;
    const actions = card.createDiv({ cls: "systemsculpt-agent-artifact-actions" });
    const open = button(actions, "chat.tool.file.open", "Open", "arrow-up-right");
    open.onclick = () => void this.options.onOpenArtifact(artifact);
    const copyPath = button(actions, "chat.tool.file.copy-path", "Copy path", "copy");
    copyPath.setAttrs({ "aria-label": "Copy path", "aria-live": "polite" });
    copyPath.onclick = () => void this.copyArtifactPath(copyPath, artifact);
  }

  private historicalToolPart(tool: ToolCall): AgentToolPart {
    const fn = readManagedToolCallFunction(tool);
    const success = tool.state === "completed" && tool.result?.success === true;
    let input: unknown = {};
    let paths: string[] = [];
    try {
      input = JSON.parse(fn?.arguments || "{}");
      if (fn) {
        paths = success
          ? collectToolArtifactPaths(fn.name, input as Record<string, unknown>, tool.result?.data)
          : collectSuccessfulToolArtifactPaths(fn.name, tool.result?.data);
      }
    } catch {
      // Malformed input is already represented by the durable failed tool state.
      input = fn?.arguments ?? {};
    }
    const state = historicalToolState(tool, success);
    const summary = tool.result?.data && typeof tool.result.data === "object"
      && typeof (tool.result.data as { summary?: unknown }).summary === "string"
      ? (tool.result.data as { summary: string }).summary
      : paths.join(", ");
    return {
      id: tool.id,
      order: tool.timestamp,
      kind: "tool",
      messageId: tool.messageId,
      callId: tool.id,
      name: fn?.name ?? "unknown_tool",
      location: isServerExecutedManagedToolCall(tool) ? "server" : "vault",
      input,
      state,
      ...(typeof tool.result?.data !== "undefined" || paths.length ? {
        output: {
          ...(summary ? { summary } : {}),
          data: tool.result?.data,
          ...(paths.length ? {
            artifacts: paths.map((path) => ({
              id: `${tool.id}:artifact:${path}`,
              kind: "vault_file" as const,
              title: path.split("/").pop() || path,
              path,
            })),
          } : {}),
        },
      } : {}),
      ...(!success && tool.result?.error ? {
        error: {
          code: String(tool.result.error.code || "TOOL_EXECUTION_FAILED"),
          message: tool.result.error.message || "The tool failed.",
        },
      } : {}),
    };
  }

  private renderMessageActions(row: HTMLElement, message: ChatMessage, text: string): void {
    const canCopy = text.length > 0 && Boolean(this.options.onCopyText);
    const canRetry = message.role === "user" && Boolean(this.options.onRetryMessage);
    if (!canCopy && !canRetry) return;

    const actions = row.createDiv({ cls: "systemsculpt-agent-message-actions" });
    if (canCopy) {
      const subject = message.role === "assistant" ? "response" : "message";
      const copy = createUiAction(actions, {
        label: `Copy ${subject}`,
        testId: "chat.turn.copy",
        icon: "copy",
        size: "icon",
      });
      copy.addClass("systemsculpt-agent-message-copy");
      copy.setAttrs({ "aria-label": `Copy ${subject}`, "aria-live": "polite" });
      copy.onclick = () => void this.copyMessage(copy, text, subject);
    }
    if (canRetry) {
      const retry = createUiAction(actions, {
        label: "Edit and resubmit",
        testId: "chat.turn.edit-resubmit",
        icon: "pencil",
        size: "icon",
      });
      retry.addClass("systemsculpt-agent-inline-button");
      retry.setAttr("data-focus-key", "edit-message");
      retry.onclick = () => void this.options.onRetryMessage?.(message.message_id);
    }
  }

  private renderInlineMessageEditor(parent: HTMLElement, edit: AgentInlineMessageEdit): void {
    const editor = parent.createDiv({
      cls: "systemsculpt-agent-message-editor",
      attr: {
        role: "group",
      },
    });
    const input = editor.createEl("textarea", {
      cls: "systemsculpt-agent-message-editor-input",
      attr: {
        rows: "3",
        "aria-label": "Edit message",
      },
    });
    input.value = edit.text;

    const consequenceParts: string[] = [];
    if (edit.laterMessageCount > 0) {
      consequenceParts.push(
        `Saving will replace ${edit.laterMessageCount} later ${
          edit.laterMessageCount === 1 ? "message" : "messages"
        } in this chat.`,
      );
    } else {
      consequenceParts.push("Saving will resubmit this message from here.");
    }
    if (edit.unavailableAttachmentCount > 0) {
      consequenceParts.push(
        `${edit.unavailableAttachmentCount} unavailable ${
          edit.unavailableAttachmentCount === 1 ? "attachment" : "attachments"
        } will be left out.`,
      );
    }
    if (edit.requiresReplayConfirmation) {
      consequenceParts.push("Existing vault changes will not be undone. You will confirm before resubmitting.");
    }
    consequenceParts.push("Ctrl or Command Enter to save. Escape to cancel.");
    const hint = editor.createDiv({
      cls: "systemsculpt-agent-message-editor-hint",
      text: consequenceParts.join(" "),
    });
    const hintId = `systemsculpt-agent-message-editor-hint-${edit.messageId}`;
    hint.id = hintId;
    input.setAttribute("aria-describedby", hintId);

    const actions = editor.createDiv({ cls: "systemsculpt-agent-message-editor-actions" });
    const cancel = createUiAction(actions, {
      label: "Cancel",
      testId: "chat.editor.cancel",
      size: "small",
    });
    const save = createUiAction(actions, {
      label: "Save and resubmit",
      testId: "chat.editor.save-resubmit",
      tone: "primary",
      size: "small",
    });
    let submitting = false;
    const sync = (): void => {
      const empty = input.value.trim().length === 0 && !edit.hasAttachments;
      input.disabled = submitting;
      cancel.disabled = submitting;
      save.disabled = submitting || empty;
      editor.setAttribute("aria-busy", String(submitting));
    };
    const cancelEdit = (): void => {
      if (submitting) return;
      void this.options.onCancelMessageEdit?.(edit.messageId);
    };
    const submitEdit = async (): Promise<void> => {
      if (submitting || (input.value.trim().length === 0 && !edit.hasAttachments)) return;
      submitting = true;
      sync();
      let accepted = false;
      try {
        accepted = await this.options.onResubmitMessage?.(edit.messageId, input.value.trim()) === true;
      } finally {
        if (!accepted && input.isConnected) {
          submitting = false;
          sync();
          input.focus();
        }
      }
    };
    input.oninput = () => {
      input.setCssStyles({ height: "auto" });
      const next = Math.min(Math.max(input.scrollHeight, 96), 280);
      input.setCssStyles({ height: `${next}px` });
      sync();
    };
    const handleEditorKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Escape", cancelEdit);
        return;
      }
      if (
        event.key === "Enter"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !event.isComposing
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressEditorKeyup("Enter");
        void submitEdit();
      }
    };
    input.onkeydown = handleEditorKeydown;
    cancel.onclick = cancelEdit;
    save.onclick = () => void submitEdit();
    this.installInlineEditorShortcutGuard(input, handleEditorKeydown);
    sync();
  }

  private installInlineEditorShortcutGuard(
    input: HTMLTextAreaElement,
    handleKeydown: (event: KeyboardEvent) => void,
  ): void {
    this.clearInlineEditorShortcutGuard();
    const ownerWindow = getSurfaceOwnerWindow(input);
    const keydown = (event: KeyboardEvent): void => {
      if (event.target === input) handleKeydown(event);
    };
    const keyup = (event: KeyboardEvent): void => {
      this.containSuppressedEditorKeyup(event);
    };
    ownerWindow.addEventListener("keydown", keydown, true);
    ownerWindow.addEventListener("keyup", keyup, true);
    this.inlineEditorShortcutCleanup = () => {
      ownerWindow.removeEventListener("keydown", keydown, true);
      ownerWindow.removeEventListener("keyup", keyup, true);
    };
  }

  private clearInlineEditorShortcutGuard(): void {
    this.inlineEditorShortcutCleanup?.();
    this.inlineEditorShortcutCleanup = null;
  }

  private containSuppressedEditorKeyup(event: KeyboardEvent): boolean {
    if (event.key !== this.suppressedEditorKeyup) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const action = this.suppressedEditorKeyupAction;
    this.clearSuppressedEditorKeyup();
    action?.();
    return true;
  }

  private suppressEditorKeyup(
    key: "Escape" | "Enter",
    afterKeyup: (() => void) | null = null,
  ): void {
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    if (this.suppressedEditorKeyupTimer !== null) {
      ownerWindow.clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = key;
    this.suppressedEditorKeyupAction = afterKeyup;
    this.suppressedEditorKeyupTimer = ownerWindow.setTimeout(() => {
      const action = this.suppressedEditorKeyupAction;
      this.suppressedEditorKeyup = null;
      this.suppressedEditorKeyupAction = null;
      this.suppressedEditorKeyupTimer = null;
      action?.();
    }, 500);
  }

  private clearSuppressedEditorKeyup(): void {
    if (this.suppressedEditorKeyupTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.suppressedEditorKeyupTimer);
    }
    this.suppressedEditorKeyup = null;
    this.suppressedEditorKeyupAction = null;
    this.suppressedEditorKeyupTimer = null;
  }

  private renderMessageAttachments(parent: HTMLElement, attachments: readonly PresentedMessageAttachment[]): void {
    const list = parent.createDiv({
      cls: "systemsculpt-agent-message-attachments",
      attr: { role: "list" },
    });
    for (const attachment of attachments) {
      const item = list.createDiv({
        cls: `systemsculpt-agent-message-attachment is-${attachment.kind}`,
        attr: { role: "listitem" },
      });
      if (attachment.kind === "image" && attachment.url) {
        item.createEl("img", {
          attr: { src: attachment.url, alt: attachment.label, loading: "lazy" },
        });
      } else {
        const icon = item.createSpan({ cls: "systemsculpt-agent-message-attachment-icon" });
        setIcon(icon, attachment.kind === "image" ? "image" : "file-text");
      }
      const copy = item.createDiv({ cls: "systemsculpt-agent-message-attachment-copy" });
      copy.createEl("strong", { text: attachment.label });
      if (attachment.mimeType) copy.createSpan({ text: attachment.mimeType });
      if (attachment.unavailable) copy.createSpan({ text: "Unavailable" });
    }
  }

  private async renderMarkdown(markdown: string, parent: HTMLElement): Promise<void> {
    await this.liveMarkdown.settle(parent, markdown);
  }

  private forgetMarkdown(target: HTMLElement): void {
    this.untrackIncidentDisclosuresWithin(target);
    this.disposeHistoricalActivityHydrationWithin(target);
    this.disposeHistoricalOverflowHydrationWithin(target);
    const overflows = target.matches("button[data-agent-activity-overflow]")
      ? [target as HTMLButtonElement]
      : Array.from(target.querySelectorAll<HTMLButtonElement>(
        "button[data-agent-activity-overflow]",
      ));
    for (const overflow of overflows) {
      const state = this.activityOverflowStates.get(overflow);
      if (!state) continue;
      for (const node of state.previousNodes) {
        if (!target.contains(node)) {
          this.untrackIncidentDisclosuresWithin(node);
          this.liveMarkdown.forget(node);
        }
      }
      this.activityOverflowStates.delete(overflow);
    }
    this.liveMarkdown.forget(target);
  }

  private trackIncidentDisclosure(
    element: HTMLElement,
    kind: IncidentDisclosureKind,
    available: boolean,
    open: boolean,
  ): void {
    const state = this.incidentDisclosureStates.get(element);
    if (state) {
      state.kind = kind;
      state.available = available;
      state.open = available && open;
      return;
    }
    const created: IncidentDisclosureState = {
      kind,
      available,
      open: available && open,
    };
    this.incidentDisclosureStates.set(element, created);
  }

  private updateIncidentDisclosure(
    element: HTMLElement,
    available: boolean,
    open: boolean,
  ): void {
    const state = this.incidentDisclosureStates.get(element);
    if (!state) return;
    state.available = available;
    state.open = available && open;
  }

  private updateIncidentDisclosureOpen(element: HTMLElement, open: boolean): void {
    const state = this.incidentDisclosureStates.get(element);
    if (!state) return;
    state.open = state.available && open;
  }

  private untrackIncidentDisclosuresWithin(target: HTMLElement): void {
    for (const element of this.incidentDisclosureStates.keys()) {
      if (element === target || target.contains(element)) {
        this.incidentDisclosureStates.delete(element);
      }
    }
  }

  private setHistoricalHydrationStatus(
    state: HistoricalActivityHydrationState | HistoricalOverflowHydrationState,
    status: HistoricalHydrationStatus,
  ): void {
    if (state.status === status) return;
    if (state.status === "hydrating") {
      this.incidentPendingHydrationCount = boundedIncidentRenderCount(
        this.incidentPendingHydrationCount - 1,
      );
    }
    state.status = status;
    if (status === "hydrating") {
      this.incidentPendingHydrationCount = boundedIncidentRenderCount(
        this.incidentPendingHydrationCount + 1,
      );
    }
  }

  private enhanceCodeBlocks(parent: HTMLElement): void {
    for (const pre of Array.from(parent.querySelectorAll<HTMLPreElement>("pre"))) {
      const code = pre.querySelector<HTMLElement>("code");
      if (!code) continue;

      pre.addClass("systemsculpt-agent-code-block");
      pre.querySelectorAll(".copy-code-button").forEach((button) => button.remove());
      if (pre.querySelector(".systemsculpt-agent-code-copy")) continue;

      const copyButton = createUiAction(pre, {
        label: "Copy",
        testId: "chat.code.copy",
        icon: "copy",
        size: "small",
      });
      copyButton.addClass("systemsculpt-agent-code-copy");
      copyButton.setAttrs({ "aria-label": "Copy code", "aria-live": "polite" });
      copyButton.onclick = async () => {
        const copied = await tryCopyToClipboard(code.textContent ?? "", pre);
        this.showCopyFeedback(copyButton, copied);
      };
    }
  }

  private showCopyFeedback(button: HTMLButtonElement, copied: boolean): void {
    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    updateUiAction(button, {
      label: copied ? "Copied" : "Try again",
      icon: copied ? "check" : "circle-alert",
    });
    button.setAttribute("aria-label", copied ? "Code copied" : "Could not copy code");

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: "Copy", icon: "copy" });
      button.setAttribute("aria-label", "Copy code");
    }, 1_600);
    this.copyFeedbackTimers.set(button, timer);
  }

  private async copyIncidentReport(
    button: HTMLButtonElement,
    reportId: string,
  ): Promise<void> {
    if (button.dataset.copyPending === "true") return;
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    button.dataset.copyPending = "true";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    updateUiAction(button, { label: "Copying…" });
    let result = false;
    try {
      result = await this.options.onCopyIncidentReport?.(reportId) ?? false;
    } catch {
      result = false;
    }
    if (button.dataset.copyAttempt !== attempt) return;
    delete button.dataset.copyPending;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (!button.isConnected) return;
    if (!result) {
      updateUiAction(button, { label: "Try again" });
      return;
    }

    updateUiAction(button, {
      label: "Report ID copied",
    });
    const ownerWindow = getSurfaceOwnerWindow(button);
    const prior = this.copyFeedbackTimers.get(button);
    if (prior !== undefined) ownerWindow.clearTimeout(prior);
    this.copyFeedbackTimers.set(button, ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected || button.dataset.copyAttempt !== attempt) return;
      updateUiAction(button, { label: "Copy report ID" });
    }, 2_000));
  }

  private async copyMessage(
    button: HTMLButtonElement,
    text: string,
    subject: "message" | "response",
  ): Promise<void> {
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    let copied = false;
    try {
      copied = await this.options.onCopyText?.(text) === true;
    } catch {
      copied = false;
    }
    if (!button.isConnected || button.dataset.copyAttempt !== attempt) return;

    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    updateUiAction(button, {
      label: copied ? `${subject === "response" ? "Response" : "Message"} copied` : `Could not copy ${subject}. Try again`,
      icon: copied ? "check" : "circle-alert",
    });
    const subjectLabel = subject === "response" ? "Response" : "Message";
    button.setAttribute(
      "aria-label",
      copied ? `${subjectLabel} copied` : `Could not copy ${subject}. Try again`,
    );

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: `Copy ${subject}`, icon: "copy" });
    }, copied ? 1_800 : 3_000);
    this.copyFeedbackTimers.set(button, timer);
  }

  private async copyArtifactPath(
    button: HTMLButtonElement,
    artifact: AgentArtifact,
  ): Promise<void> {
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    let copied = false;
    try {
      copied = await this.options.onCopyArtifactPath(artifact) === true;
    } catch {
      copied = false;
    }
    if (!button.isConnected || button.dataset.copyAttempt !== attempt) return;

    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    updateUiAction(button, {
      label: copied ? "Path copied" : "Could not copy path. Try again",
      icon: copied ? "check" : "circle-alert",
    });
    button.setAttribute(
      "aria-label",
      copied ? "Path copied" : "Could not copy path. Try again",
    );

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: "Copy path", icon: "copy" });
      button.setAttribute("aria-label", "Copy path");
    }, copied ? 1_800 : 3_000);
    this.copyFeedbackTimers.set(button, timer);
  }
}
