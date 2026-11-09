import { boundedIncidentRenderCount, boundedIncidentRenderDuration, incidentMonotonicNow } from "./RenderIncidentMetrics";
import { App, Component, Keymap, MarkdownRenderer, setIcon } from "obsidian";
import {
  createSurfaceElement,
  createUiAction,
  getSurfaceOwnerWindow,
  updateUiAction,
} from "../../core/ui/surface";
import type { ChatMessage, MessagePart } from "../../types";
import { contentKeys, sameContentKeys } from "../../utils/immutableJson";
import type {
  AgentArtifact,
  AgentConversationSnapshot,
  AgentPart,
  AgentToolPart,
  ManagedAgentError,
} from "../../chat/ChatConversation";
import {
  formatAgentActivityDuration,
  formatAgentWorkingDuration,
  finalAgentAnswerPartIds,
  summarizeAgentActivity,
  setActivityLabelText,
  unbreakableActivityLabel,
} from "./AgentActivityPresentation";
import { presentTurnChanges } from "./TurnChangeSummary";
import { renderTurnMedia } from "./TurnMedia";
import { codexImageVaultPath } from "../../services/codex/CodexImages";
import { openExternalUrl } from "../../utils/externalUrl";
import { enhanceMarkdownCodeBlocks } from "./MarkdownCodeBlocks";
import { embedTarget, enhanceMarkdownEmbeds, markUnresolvedLinks } from "./MarkdownEmbeds";
import { fitRequestBubbles } from "./RequestBubbleFit";
import {
  isActiveAgentToolState,
  presentAgentError,
  type AgentConversationPresentation,
} from "./AgentConversationPresentation";
import {
  isLocalReportId,
} from "./FailedTerminalReceipt";
import {
  presentChatMessage,
  presentMessageContent,
  type PresentedMessageAttachment,
} from "./ChatMessagePresentation";
import { InlineMessageEditor, type AgentInlineMessageEdit } from "./InlineMessageEditor";
import { LiveMarkdownRenderer } from "./LiveMarkdownRenderer";
import { ConversationHistoryHydration } from "./ConversationHistoryHydration";
import { ActiveConversationRenderer } from "./ActiveConversationRenderer";
import {
  captureDomSelection,
  findFocusKey,
  focusedElementWithin,
  reconcileConversationChildren,
  restoreDomSelection,
  type PreservedDomSelection,
} from "./ConversationDomState";
import { AgentApprovalCards, type ApprovalAnswer } from "./AgentApprovalCards";
import { MessagePartNormalizer } from "./utils/MessagePartNormalizer";

import { AgentToolRenderer } from "./AgentToolRenderer";
import { gatedSystemSculptTurn, presentAgentTool, presentToolLineMeta, refusedSystemSculptCall } from "./AgentToolPresentation";
import {
  classifyHistoricalTurn,
  durableFailedReceipt,
  historicalPartKey,
  historicalAgentPart,
  historicalToolPart,
  isNativeSourcesPart,
  isOrphanNativeFailure,
  isVisibleHistoricalPart,
  partitionHistoricalParts,
  toolDisplayFingerprint,
  toolPartKey,
  type DurableFailedReceipt,
  type HistoricalTurnSemantics,
} from "./ConversationPartPresentation";

export type AgentConversationRendererOptions = Readonly<{
  app: App;
  sourcePath: () => string;
  beginLayoutMutation?: (
    disclosureControl?: HTMLElement,
    mutationTarget?: HTMLElement,
  ) => (() => void) | undefined;
  onApprove: ApprovalAnswer;
  onReviewApproval?: () => void;
  approvalComposer?: () => HTMLElement | undefined;
  isApprovalVisible?: () => boolean;
  onHiddenApproval?: (part: AgentToolPart) => void;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => boolean | Promise<boolean>;
  showPlanOffer?: () => boolean;
  backendName?: () => string;
  onAnnounce?: (message: string) => void;
  onDetectAgain?: () => boolean | void | Promise<boolean | void>;
  onUseHosted?: () => void | Promise<void>;
  onOpenCredits?: () => void | Promise<void>;
  onViewPlans?: (error?: ManagedAgentError) => void | Promise<void>;
  /** Opens the $9 Monthly checkout. */
  onMonthlyOffer?: () => void | Promise<void>;
  /** Only a starter account gets Subscribe; any other account sees plans instead. */
  showMonthlyOffer?: () => boolean;
  /** A failed renewal: the credits error offers Update card instead (T-5348). */
  showPaymentFix?: () => boolean;
  /** Opens the billing portal to fix the card. */
  onUpdateCard?: () => void | Promise<void>;
  onRetryFailedTurn?: (messageId: string) => void | Promise<void>;
  onPrepareIncidentReport?: (reportId: string, retry?: boolean) => Promise<boolean>;
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

export type { AgentInlineMessageEdit } from "./InlineMessageEditor";

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

let activityDrawerSequence = 0;

type IncidentDisclosureKind = "activity" | "reasoning" | "tool" | "overflow";

type IncidentDisclosureState = {
  kind: IncidentDisclosureKind;
  available: boolean;
  open: boolean;
};

/*
 * What a rendered history row was built from. Frozen transcript messages
 * stand for themselves, so an unchanged row costs identity checks rather than
 * serializing every message on each history render.
 */
type HistoricalRowIdentity = Readonly<{
  messages: readonly unknown[];
  presentation: string;
}>;

type HistoricalRowState = Readonly<{
  identity: HistoricalRowIdentity;
  node: HTMLElement;
  partFingerprints: ReadonlyMap<string, string>;
}>;

function sameHistoricalRow(
  left: HistoricalRowIdentity,
  right: HistoricalRowIdentity,
): boolean {
  return left.presentation === right.presentation
    && sameContentKeys(left.messages, right.messages);
}

type HistoricalDisclosureSnapshot = Readonly<{
  workedOpen: boolean;
  hydrateWorked: boolean;
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

type HistoricalReplacementInteraction = Readonly<{
  focusElement: HTMLElement | null;
  focusLocator: HistoricalFocusLocator | null;
  focusRow: HTMLElement;
  selection: PreservedDomSelection | null;
}>;

/** Projects durable messages plus the active normalized agent run into native DOM. */
let turnHeadingSequence = 0;

// One formatter for every row; building one per message is measurable on 500-message chats.
let cachedMessageTimeFormat: Intl.DateTimeFormat | null = null;
function messageTimeFormat(): Intl.DateTimeFormat {
  cachedMessageTimeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return cachedMessageTimeFormat;
}

/**
 * The fold's hairline stops at the edge of a card its body ends on: CSS reads this class
 * (lint-css bans :has()), and the space under that card moves outside the body.
 */
function syncFoldEnd(body: HTMLElement): void {
  const cardLast = Boolean(body.querySelector(
    ":scope > .systemsculpt-agent-part:last-child > details.systemsculpt-agent-tool[open]",
  ));
  body.toggleClass("is-card-last", cardLast);
  // The fold says it too, so a framed block after it (a picture, a whole-turn card) can keep one 16 px gap from that card.
  body.parentElement?.toggleClass("is-card-last", cardLast);
}

export class AgentConversationRenderer extends Component {
  public readonly element: HTMLElement;
  private readonly historyRoot: HTMLElement;
  public readonly activeRoot: HTMLElement;
  private readonly activityOverflowStates = new WeakMap<HTMLButtonElement, {
    body: HTMLElement;
    icon: HTMLElement;
    label: HTMLElement;
    latestNode: HTMLElement | null;
    previousNodes: HTMLElement[];
  }>();
  private readonly reasoningDisclosureStates = new WeakMap<HTMLDetailsElement, {
    body: HTMLElement;
    summary: string;
    streaming: boolean;
    dirty: boolean;
    revision: number;
  }>();
  private visible = true;
  private historyRows = new Map<string, HistoricalRowState>();
  private historyMessageIds: ReadonlySet<string> = new Set<string>();
  private committedCancelledMessageIds: ReadonlySet<string> = new Set<string>();
  private committedFailedMessageIds: ReadonlySet<string> = new Set<string>();
  private committedFailedTurnIds: ReadonlySet<string> = new Set<string>();
  private inlineMessageEdit: AgentInlineMessageEdit | null = null;
  private readonly inlineEditor: InlineMessageEditor;
  private readonly copyFeedbackTimers = new Map<HTMLButtonElement, number>();
  private readonly incidentDisclosureStates = new Map<HTMLElement, IncidentDisclosureState>();
  private readonly liveMarkdown: LiveMarkdownRenderer;
  private readonly approvals: AgentApprovalCards;
  private readonly tools: AgentToolRenderer;
  private readonly historyHydration: ConversationHistoryHydration;
  private readonly active: ActiveConversationRenderer;
  private renderGeneration = 0;
  private lifecycleGeneration = 0;
  private renderingEnabled = true;
  private incidentMetricsGeneration = 0;
  private incidentRenderPassCount = 0;
  private incidentPendingRenderPassCount = 0;
  private incidentLastRenderDurationMs = 0;
  private incidentMaxRenderDurationMs = 0;
  private incidentHistoricalPartCount = 0;
  private loadingTimer: number | null = null;
  private loadingTimerWindow: Window | null = null;
  private loadingSkeleton: HTMLElement | null = null;
  private readonly shownNotices = new Set<string>();
  private reportGeneration = 0;
  private readonly deferredReportUpdates = new Map<HTMLElement, () => void>();

  constructor(parent: HTMLElement, private readonly options: AgentConversationRendererOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-conversation",
      attr: {
        role: "log",
        "aria-label": "Conversation",
        "aria-live": "off",
        "aria-relevant": "additions",
        "aria-atomic": "false",
      },
    });
    // Delegate from the stable root: streamed Markdown reconciliation clones links.
    const openSourceLink = (event: MouseEvent): void => {
      if (event.defaultPrevented || (event.type === "click" ? event.button !== 0 : event.button !== 1)) return;
      const target = event.target as Element | null;
      const link = target?.closest?.("a.internal-link");
      // An embedded image in an answer opens its vault file, like a link to it.
      const image = !link && target?.tagName === "IMG" ? target.closest?.(".internal-embed.image-embed") : null;
      const linked = link?.getAttribute("data-href") ?? link?.getAttribute("href") ?? (image ? embedTarget(image) : null);
      if (!linked) return;
      event.preventDefault();
      event.stopPropagation();
      // A reply linking an image Codex saved outside the vault opens the vault copy.
      const href = codexImageVaultPath(linked) ?? linked;
      void this.options.app.workspace.openLinkText(href, this.options.sourcePath(), Keymap.isModEvent(event));
    };
    this.registerDomEvent(this.element, "click", openSourceLink);
    this.registerDomEvent(this.element, "auxclick", openSourceLink);
    this.historyRoot = this.element.createDiv({ cls: "systemsculpt-agent-history" });
    // Request bubbles hug their longest line; a new chat width fits them again.
    const BubbleObserver = (getSurfaceOwnerWindow(this.element) as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof BubbleObserver === "function") {
      const bubbleObserver = new BubbleObserver(() => fitRequestBubbles(this.historyRoot));
      bubbleObserver.observe(this.historyRoot);
      this.register(() => bubbleObserver.disconnect());
    }
    this.activeRoot = this.element.createDiv({ cls: "systemsculpt-agent-active-run" });
    this.inlineEditor = new InlineMessageEditor(this.element, {
      onResubmitMessage: options.onResubmitMessage,
      onCancelMessageEdit: options.onCancelMessageEdit,
    });
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
        enhanceMarkdownEmbeds(staging);
        const cache = this.options.app.metadataCache;
        if (typeof cache?.getFirstLinkpathDest === "function") {
          markUnresolvedLinks(staging, (linkpath) =>
            Boolean(cache.getFirstLinkpathDest(codexImageVaultPath(linkpath) ?? linkpath, this.options.sourcePath())));
        }
      },
    });
    this.addChild(this.liveMarkdown);
    this.approvals = new AgentApprovalCards(this.element, {
      onApprove: options.onApprove,
      onReview: options.onReviewApproval,
      composer: options.approvalComposer,
      isVisible: options.isApprovalVisible,
      onHiddenApproval: options.onHiddenApproval,
      onAnnounce: options.onAnnounce,
      onOpenPath: (path) => this.options.onOpenArtifact({ id: path, title: path, path, kind: "vault_file" }),
      exists: (path) => Boolean(options.app.vault.getAbstractFileByPath(path)),
    });
    this.addChild(this.approvals);
    this.tools = new AgentToolRenderer({
      app: options.app,
      component: this,
      approvals: this.approvals,
      onOpenArtifact: (artifact) => this.options.onOpenArtifact(artifact),
      renderArtifact: (parent, artifact) => this.renderArtifact(parent, artifact),
      beginLayoutMutation: (control, target) => this.options.beginLayoutMutation?.(control, target),
      nextDisclosureId: () => `systemsculpt-tool-details-${++activityDrawerSequence}`,
      isRenderingEnabled: () => this.renderingEnabled,
      lifecycleGeneration: () => this.lifecycleGeneration,
      renderEpoch: () => this.active.renderEpoch,
      trackDisclosure: (element, available, open) => this.trackIncidentDisclosure(element, "tool", available, open),
      updateDisclosure: (element, available, open) => this.updateIncidentDisclosure(element, available, open),
      untrackDisclosures: (target) => this.untrackIncidentDisclosuresWithin(target),
    });
    this.historyHydration = new ConversationHistoryHydration({
      renderTimeline: (parent, parts, isCurrent) => this.renderHistoricalTimeline(parent, parts, isCurrent),
      forgetMarkdown: (target) => this.forgetMarkdown(target),
      activityHydrated: (element) => this.settleFold(element),
      beginLayoutMutation: (control, target) => this.options.beginLayoutMutation?.(control, target),
    });
    this.active = new ActiveConversationRenderer(this.activeRoot, {
      conversation: this.element,
      isRenderingEnabled: () => this.renderingEnabled,
      lifecycleGeneration: () => this.lifecycleGeneration,
      backendName: options.backendName,
      onAnnounce: options.onAnnounce,
      hasHistoryMessage: (id) => this.historyMessageIds.has(id),
      hasFailedMessage: (id) => this.committedFailedMessageIds.has(id),
      hasCancelledMessage: (id) => this.committedCancelledMessageIds.has(id),
      approvals: this.approvals,
      tools: this.tools,
      renderPart: (node, part, previous, suppressError, progress) => this.renderPart(node, part, previous, suppressError, progress),
      forgetMarkdown: (target) => this.forgetMarkdown(target),
      renderMessageAttachments: (parent, attachments) => this.renderMessageAttachments(parent, attachments),
      renderTurnMediaBlock: (parent, parts, answer, live) => this.renderTurnMediaBlock(parent, parts, answer, live),
      renderTurnChanges: (parent, parts) => this.renderTurnChanges(parent, parts),
      addTurnHeading: (row, user) => this.addTurnHeading(row, user),
      createCompletedActivity: (parent, elapsed, cancelled) => this.createCompletedActivity(parent, elapsed, cancelled),
      setCompletedActivitySummary: (element, parts, elapsed, cancelled) => this.setCompletedActivitySummary(element, parts, elapsed, cancelled),
      settleFold: (fold) => this.settleFold(fold),
      workedLabel: (elapsed, cancelled) => this.workedLabel(elapsed, cancelled),
      createActivityOverflow: (parent, count, key) => this.createActivityOverflow(parent, count, key),
      updateActivityOverflow: (element, count) => this.updateActivityOverflow(element, count),
      setActivityOverflowItems: (element, latest, previous) => this.setActivityOverflowItems(element, latest, previous),
      overflowBody: (element) => this.activityOverflowStates.get(element)?.body,
      forgetOverflow: (element) => { this.activityOverflowStates.delete(element); },
      updateDisclosureOpen: (element, open) => this.updateIncidentDisclosureOpen(element, open),
    });
  }

  /** The mounted live response; settlement transfers it to history and clears this reference. */
  public get activeResponseElement(): HTMLElement | null {
    return this.active.responseElement;
  }

  public setLoading(loading: boolean): void {
    const win = getSurfaceOwnerWindow(this.element);
    if (this.loadingTimer !== null) this.loadingTimerWindow?.clearTimeout(this.loadingTimer);
    this.loadingTimer = null;
    this.loadingTimerWindow = null;
    this.loadingSkeleton?.remove();
    this.loadingSkeleton = null;
    this.element.toggleClass("is-loading-chat", loading);
    if (!loading) return;
    this.shownNotices.clear();
    this.element.querySelectorAll(":scope > .systemsculpt-agent-notice").forEach(notice => notice.remove());
    this.active.resetAnnouncements();
    this.loadingTimerWindow = win;
    this.loadingTimer = win.setTimeout(() => {
      this.loadingTimer = null;
      this.loadingTimerWindow = null;
      if (!this.visible) return;
      this.options.onAnnounce?.("Loading chat");
      const skeleton = this.element.createDiv({
        cls: "systemsculpt-agent-loading",
        attr: { "data-testid": "chat.loading", "aria-label": "Loading chat" },
      });
      skeleton.createSpan({ cls: "systemsculpt-agent-sr-only", text: "Loading chat" });
      for (let index = 0; index < 3; index += 1) {
        skeleton.createDiv({ cls: "systemsculpt-agent-loading-bar", attr: { "aria-hidden": "true" } });
      }
      this.loadingSkeleton = skeleton;
    }, 300);
  }

  public showNotice(text: string): void {
    if (this.shownNotices.has(text)) return;
    this.shownNotices.add(text);
    const notice = this.element.createDiv({
      cls: "systemsculpt-agent-notice",
      attr: { role: "status", "aria-live": "off", "data-testid": "chat.notice" },
    });
    notice.createSpan({ text });
    this.options.onAnnounce?.(text);
    const dismiss = createUiAction(notice, {
      label: "Dismiss", icon: "x", size: "icon", testId: "chat.notice.dismiss",
    });
    dismiss.onclick = () => notice.remove();
    this.element.insertBefore(notice, this.activeRoot);
  }

  private addTurnHeading(row: HTMLElement, user: boolean): void {
    row.setAttribute("role", "article");
    if (row.querySelector(":scope > h3")) return;
    const heading = row.createEl("h3", {
      cls: "systemsculpt-agent-sr-only",
      text: user ? "You" : this.options.backendName?.() ?? "SystemSculpt",
    });
    heading.id = `systemsculpt-agent-turn-heading-${++turnHeadingSequence}`;
    row.setAttribute("aria-labelledby", heading.id);
    row.prepend(heading);
  }

  public focusPendingApproval(): void {
    this.approvals.focusFirst();
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
      activePartCount: boundedIncidentRenderCount(this.active.partCount),
      disclosureCount: boundedIncidentRenderCount(disclosureCount),
      openDisclosureCount: boundedIncidentRenderCount(openDisclosureCount),
      activityDisclosureCount: boundedIncidentRenderCount(activityDisclosureCount),
      reasoningDisclosureCount: boundedIncidentRenderCount(reasoningDisclosureCount),
      toolDisclosureCount: boundedIncidentRenderCount(toolDisclosureCount),
      overflowDisclosureCount: boundedIncidentRenderCount(overflowDisclosureCount),
      pendingHydrationCount: boundedIncidentRenderCount(this.historyHydration.pendingCount),
      renderingEnabled: this.renderingEnabled,
    });
  }

  /** Uses maintained reconciliation state to prove that a failed surface committed. */
  public hasCommittedFailureSurface(turnId: string): boolean {
    if (!this.renderingEnabled || !turnId) return false;
    if (this.committedFailedTurnIds.has(turnId)) return true;
    return this.active.hasFailure(turnId);
  }

  private async measureIncidentRenderPass(task: () => Promise<void>): Promise<void> {
    const generation = this.incidentMetricsGeneration;
    this.incidentRenderPassCount = boundedIncidentRenderCount(
      this.incidentRenderPassCount + 1,
    );
    this.incidentPendingRenderPassCount = boundedIncidentRenderCount(
      this.incidentPendingRenderPassCount + 1,
    );
    const startedAt = incidentMonotonicNow(() => getSurfaceOwnerWindow(this.element));
    try {
      await task();
    } finally {
      if (generation === this.incidentMetricsGeneration) {
        this.incidentPendingRenderPassCount = Math.max(
          0,
          this.incidentPendingRenderPassCount - 1,
        );
        const durationMs = boundedIncidentRenderDuration(
          incidentMonotonicNow(() => getSurfaceOwnerWindow(this.element)) - startedAt,
        );
        this.incidentLastRenderDurationMs = durationMs;
        this.incidentMaxRenderDurationMs = Math.max(
          this.incidentMaxRenderDurationMs,
          durationMs,
        );
      }
    }
  }

  public renderHistory(
    messages: readonly ChatMessage[],
    adoptingTurnId: string | null = null,
  ): Promise<void> {
    return this.measureIncidentRenderPass(() => this.renderHistoryPass(messages, adoptingTurnId));
  }

  private async renderHistoryPass(
    messages: readonly ChatMessage[],
    adoptingTurnId: string | null = null,
  ): Promise<void> {
    if (!this.renderingEnabled) return;
    const adoptionState = this.captureActiveAdoptionState(adoptingTurnId);
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
    const handoffs: Array<() => void> = [];
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
      if (isOrphanNativeFailure(message, currentTurnId)) continue;
      const turnMessages: ChatMessage[] = [message];
      if (message.role === "assistant") {
        while (index < messages.length && messages[index].role === "assistant") {
          if (!isOrphanNativeFailure(messages[index], currentTurnId)) turnMessages.push(messages[index]);
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
      const identity: HistoricalRowIdentity = {
        messages: contentKeys(turnMessages),
        presentation: JSON.stringify({ inlineEdit, cancelledTurn, failedReceipt }),
      };
      const existing = this.historyRows.get(rowKey);
      if (existing && sameHistoricalRow(existing.identity, identity)) {
        nextRows.set(rowKey, existing);
        nextHistoricalPartCount = boundedIncidentRenderCount(
          nextHistoricalPartCount + existing.partFingerprints.size,
        );
        desiredRows.push(existing.node);
        continue;
      }
      const adoptActive = adoptingTurnId !== null
        && message.role === "assistant"
        && turnId === adoptingTurnId
        && this.active.canAdopt(adoptingTurnId);
      const row = adoptActive ? this.active.responseElement! : nextHistory.createDiv();
      row.className = [
        "systemsculpt-agent-turn",
        `is-${message.role}`,
        semantics.isToolOnly ? "is-tool-only" : "",
        inlineEdit ? "is-editing" : "",
      ].filter(Boolean).join(" ");
      row.dataset.testid = "chat.turn";
      row.dataset.role = message.role;
      row.dataset.active = "false";
      this.addTurnHeading(row, message.role === "user");
      row.dataset.messageId = anchorMessage.message_id;
      if (turnMessages.length > 1) {
        row.dataset.messageIds = turnMessages.map((entry) => entry.message_id).join(" ");
      } else {
        delete row.dataset.messageIds;
      }
      if (turnId) row.dataset.turnId = turnId;
      else delete row.dataset.turnId;
      const body = adoptActive
        ? this.active.responseBody!
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
        const handoff = adoptActive
          ? await this.active.prepareHistoryHandoff(
            body,
            turnParts,
            turnMessages[turnMessages.length - 1]?.responseDurationMs,
            finalAnswerPartIds,
            cancelledTurn,
            failedReceipt ? this.failedTailPart(failedReceipt, turnId) : undefined,
            isCurrent,
          ) : null;
        if (adoptActive && !handoff) {
          this.forgetMarkdown(nextHistory);
          return;
        }
        if (handoff) handoffs.push(handoff.commit);
        const foldedCancelledActivity = handoff?.hasActivity
          ?? await (async (): Promise<boolean> => {
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
        if (failedReceipt && !adoptActive) {
          await this.renderDurableFailedTail(body, failedReceipt, turnId);
          if (!isCurrent()) {
            this.forgetMarkdown(nextHistory);
            return;
          }
        }
        const historicalTools = turnParts.flatMap((part) => part.type === "tool_call"
          ? [historicalToolPart(part.data)] : []);
        const media = this.renderTurnMediaBlock(body, historicalTools,
          turnParts.flatMap((part) => part.type === "content" && typeof part.data === "string" ? [part.data] : []).join("\n"));
        // Same place as the live turn settled it: under the folded work, above the reply.
        const fold = body.querySelector<HTMLElement>(":scope > details[data-agent-turn-fold]");
        if (media && fold && fold.nextElementSibling !== media) fold.after(media);
        this.renderTurnChanges(body, historicalTools);
      } else {
        const { content } = presented[0];
        if (inlineEdit) {
          this.inlineEditor.render(body, inlineEdit);
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
      const rendered: HistoricalRowState = { identity, node: row, partFingerprints };
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
    const focusReplacement = this.active.transferPresentationState(desiredRows);
    const desiredRowSet = new Set(desiredRows);
    for (const { node } of this.historyRows.values()) {
      if (!desiredRowSet.has(node)) this.forgetMarkdown(node);
    }
    reconcileConversationChildren(this.historyRoot, desiredRows);
    for (const commitHandoff of handoffs) commitHandoff();
    fitRequestBubbles(this.historyRoot);
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
    restoreDomSelection(
      historicalInteraction?.selection ?? adoptionState?.selection ?? null,
    );
    this.historyRows = nextRows;
    this.incidentHistoricalPartCount = nextHistoricalPartCount;
    this.historyMessageIds = nextMessageIds;
    this.committedCancelledMessageIds = nextDurableCancelledMessageIds;
    this.committedFailedMessageIds = nextDurableFailedMessageIds;
    this.committedFailedTurnIds = nextDurableFailedTurnIds;
    if (!hasInlineEdit) this.inlineEditor.deactivate();
  }

  /**
   * Commits a completed turn while reusing its live row and keyed part nodes.
   * This keeps Markdown, selection, focus, and disclosure identity intact.
   */
  public async settleHistory(messages: readonly ChatMessage[], turnId: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.active.canAdopt(turnId)) {
      await this.renderHistory(messages);
      if (this.renderingEnabled && generation === this.lifecycleGeneration) this.clearActive();
      return;
    }
    await this.renderHistory(messages, turnId);
  }

  private captureActiveAdoptionState(adoptingTurnId: string | null): Readonly<{
    focusElement: HTMLElement | null;
    selection: PreservedDomSelection | null;
  }> | null {
    const row = this.active.responseElement;
    if (!row || !this.active.canAdopt(adoptingTurnId)) return null;
    return { focusElement: focusedElementWithin(row), selection: captureDomSelection(row) };
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
      return toolDisplayFingerprint(historicalToolPart(part.data));
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
          "data-testid": "chat.part",
          "data-kind": "reasoning",
          "data-part-key": part.id,
          "data-agent-activity-row": "",
          "data-activity-kind": "reasoning",
        },
      });
      await this.renderReasoning(node, part.data, false);
      return;
    }
    if (part.type === "tool_call") {
      const tool = historicalToolPart(part.data);
      const node = parent.createDiv({
        cls: "systemsculpt-agent-part is-tool",
        attr: {
          "data-testid": "chat.part",
          "data-kind": "tool",
          "data-part-key": toolPartKey(tool.callId),
          "data-agent-activity-row": "",
          "data-activity-kind": "tool",
        },
      });
      this.tools.render(node, tool);
      return;
    }
    if (part.type !== "content") return;
    const content = presentMessageContent(part.data);
    if (content.markdown.trim()) {
      const node = parent.createDiv({
        cls: "systemsculpt-agent-part is-text",
        attr: { "data-testid": "chat.part", "data-kind": "text", "data-part-key": part.id },
      });
      // The Sources list a web answer appends reads as its footnote, not a second headline.
      node.classList.toggle("is-sources", isNativeSourcesPart(part));
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
      this.setCompletedActivitySummary(activity.element, workParts.flatMap(part => historicalAgentPart(part) ?? []), elapsedMs, cancelled);
      if (workParts.some((part) => this.hasActiveHistoricalPart(part))) {
        await this.renderHistoricalTimeline(activity.body, workParts);
        this.settleFold(activity.element);
      } else {
        this.historyHydration.deferActivity(activity, workParts);
      }
    } else {
      for (const part of workParts) await this.renderHistoricalPart(parent, part);
    }
    for (const finalAnswer of finalAnswers) await this.renderHistoricalPart(parent, finalAnswer);
    return hasActivity;
  }

  private hasActiveHistoricalPart(part: MessagePart): boolean {
    const key = part.type === "tool_call" ? toolPartKey(part.data.id) : part.id;
    return this.active.hasPart(key);
  }

  private async renderHistoricalTimeline(
    parent: HTMLElement,
    parts: readonly MessagePart[],
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    // Only a settled fold's body comes here: the fold is already its rows' summary, so
    // they sit flat inside it, with no second group header.
    for (const part of parts) {
      if (!isCurrent()) return false;
      await this.renderHistoricalPart(parent, part);
      if (!isCurrent()) return false;
    }
    return true;
  }

  public renderActive(
    snapshot: AgentConversationSnapshot,
    presentation: AgentConversationPresentation,
  ): Promise<void> {
    return this.measureIncidentRenderPass(() => this.active.render(snapshot, presentation));
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
    });
    const header = element.createEl("summary", {
      cls: "systemsculpt-agent-activity-header",
      attr: {
        "data-focus-key": "activity-summary",
        "data-testid": "chat.activity.toggle",
        role: "button",
        "aria-expanded": "false",
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
    const bodyId = `systemsculpt-completed-activity-${++activityDrawerSequence}`;
    header.setAttribute("aria-controls", bodyId);
    const body = element.createDiv({
      cls: "systemsculpt-agent-activity-body",
      attr: { "data-agent-turn-fold-body": "", id: bodyId },
    });
    element.open = false;
    this.trackIncidentDisclosure(element, "activity", true, false);
    element.addEventListener("toggle", () => {
      header.setAttribute("aria-expanded", String(element.open));
      this.updateIncidentDisclosure(element, true, element.open);
    });
    // Toggle does not bubble: the capture phase sees every card the body holds open or close.
    body.addEventListener("toggle", () => syncFoldEnd(body), true);
    return { element, summary: header, body };
  }

  private setCompletedActivitySummary(
    element: HTMLDetailsElement,
    parts: readonly AgentPart[],
    elapsedMs?: number,
    cancelled = false,
  ): void {
    const summary = summarizeAgentActivity(parts);
    const header = element.querySelector<HTMLElement>(":scope > summary")!;
    const duration = formatAgentActivityDuration(elapsedMs);
    const label = cancelled ? this.workedLabel(elapsedMs, true) : summary.label;
    // One call, with at most the words said before it (no thinking): the fold is that call's row.
    // It keeps the call's name and meta, and opening it shows those words and the call's card,
    // not a second row naming the call again.
    const tools = parts.filter((part): part is AgentToolPart => part.kind === "tool");
    const single = !cancelled && tools.length === 1 && parts.every((part) =>
      part.kind === "tool" || part.kind === "text");
    element.toggleAttribute("data-single-tool", single);
    // The line keeps its words when it opens: the person clicked that summary, and the
    // rows under it are its detail, not a reason to rename it.
    const target = header.querySelector<HTMLElement>(".systemsculpt-agent-activity-label");
    if (target) setActivityLabelText(target, unbreakableActivityLabel(label));
    let icon = header.querySelector<HTMLElement>(".systemsculpt-agent-activity-state");
    const loneTool = single ? tools[0] : undefined;
    if (target && loneTool) this.linkLoneTarget(target, loneTool);
    if (!icon) {
      icon = header.createSpan({ cls: "systemsculpt-agent-activity-state", attr: { "aria-hidden": "true" } });
      header.prepend(icon);
    }
    // A lone call's fold is its row: the row's own state icon and colour, so one failure
    // never shows one glyph closed and another open.
    const lone = single ? presentAgentTool(tools[0]) : null;
    // While a picture or video is made, the fold already names it: it spins until the step inside ends.
    const running = !cancelled && tools.some((part) => isActiveAgentToolState(part.state));
    const iconName = lone ? lone.icon : summary.failedCount ? "circle-alert" : summary.gated ? "lock" : summary.refused ? "circle-alert" : cancelled ? "circle-stop" : summary.denied ? "ban" : running ? "loader-circle" : "check";
    // The same glyph is kept, so a spinning one never restarts its turn on a refresh.
    if (icon.dataset.iconName !== iconName) {
      setIcon(icon, iconName);
      icon.dataset.iconName = iconName;
    }
    icon.classList.toggle("is-animated", running && iconName === "loader-circle");
    if (lone) {
      icon.dataset.toolState = gatedSystemSculptTurn(tools[0]) ? "gated"
        : refusedSystemSculptCall(tools[0]) ? "refused" : lone.displayState;
    } else delete icon.dataset.toolState;
    let meta = header.querySelector<HTMLElement>(".systemsculpt-agent-activity-duration");
    if (!meta) meta = header.createSpan({ cls: "systemsculpt-agent-activity-duration" });
    // A lone call shows its own meta, like its row would; a bare time beside a video reads as its length.
    meta.setText(lone ? presentToolLineMeta(lone) ?? "" : !cancelled && duration ? duration : "");
  }

  /** A lone call's fold is its row: the note it names, when it exists, is a link there too, as on the row. */
  private linkLoneTarget(label: HTMLElement, part: AgentToolPart): void {
    const presentation = presentAgentTool(part);
    const path = presentation.targetPath;
    const text = presentation.target?.text ?? path?.split("/").pop();
    if (!path || !text || label.querySelector("a") || !this.options.app.vault.getAbstractFileByPath(path)) return;
    const span = Array.from(label.children).find((child) => child.tagName === "SPAN" && child.textContent === text);
    if (!span) return;
    const link = createSurfaceElement(label.ownerDocument, "a");
    link.className = span.className;
    link.setText(text);
    link.setAttribute("href", path);
    link.setAttribute("data-href", path);
    link.setAttribute("data-testid", "chat.tool.open-path");
    link.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      void this.options.onOpenArtifact({ id: path, path, title: text, kind: "vault_file" });
    };
    span.replaceWith(link);
  }

  /**
   * A filled fold settles: one that holds one call opens straight to that call's card (its row
   * would only repeat the fold), and its body marks whether it ends on an open card.
   */
  private settleFold(fold: HTMLDetailsElement): void {
    const body = fold.querySelector<HTMLElement>(":scope > .systemsculpt-agent-activity-body");
    const cards = ":scope > .systemsculpt-agent-activity-body > .systemsculpt-agent-part.is-tool > details.systemsculpt-agent-tool";
    if (fold.hasAttribute("data-single-tool")) {
      const card = fold.querySelector<HTMLDetailsElement>(cards);
      if (card && !card.open) {
        card.open = true;
        card.dataset.foldOpened = "";
      }
    } else {
      // A live fold that held one call opened its card; once it holds more, that call is a row again.
      for (const card of Array.from(fold.querySelectorAll<HTMLDetailsElement>(`${cards}[data-fold-opened]`))) {
        card.open = false;
        delete card.dataset.foldOpened;
      }
    }
    if (body) syncFoldEnd(body);
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
        "data-testid": "chat.activity.body",
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
      finishLayoutMutation?.();
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
    // Same as the turn summary: "· 2 failed" never strands its dot at a line end.
    const label = unbreakableActivityLabel((element.dataset.activitySummary ?? this.activityOverflowLabel(
      Number.isFinite(count) ? count : 0,
      state.latestNode,
    )));
    setActivityLabelText(state.label, label);
    // The header speaks for the steps above the latest row, so it wears their state, not the latest's.
    const summaryIcon = element.dataset.summaryIcon;
    if (summaryIcon) {
      if (state.icon.dataset.iconName !== summaryIcon) {
        setIcon(state.icon, summaryIcon);
        state.icon.dataset.iconName = summaryIcon;
      }
      // It spins only while one of those steps' own rows does, so a frozen turn freezes it too.
      state.icon.classList.toggle("is-animated", summaryIcon === "loader-circle" && state.previousNodes.some((node) =>
        node.querySelector(".systemsculpt-agent-tool-icon.is-animated, .systemsculpt-agent-reasoning-icon.is-animated") !== null));
    } else if (Number(element.dataset.failedCount) > 0) {
      setIcon(state.icon, "circle-alert");
      state.icon.dataset.iconName = "circle-alert";
      state.icon.classList.remove("is-animated");
    } else this.updateActivityOverflowIcon(state.icon, state.latestNode);
    // A pending approval blocks the turn, so the drawer must reveal it instead
    // of parking it behind a disclosure the user has no reason to open.
    const awaitingApproval = [
      ...state.previousNodes,
      ...(state.latestNode ? [state.latestNode] : []),
    ].filter((node) => this.hasPendingApproval(node));
    const visiblePrevious = expanded
      ? state.previousNodes
      : state.previousNodes.filter((node) => awaitingApproval.includes(node));
    // The latest step stays a row of its own under the drawer, level with the header that names
    // the steps before it; the drawer holds only those earlier steps.
    reconcileConversationChildren(state.body, visiblePrevious);
    state.body.toggleAttribute("hidden", visiblePrevious.length === 0);
    // A drawer of one step with a card opens to that card, as a one-call fold does: no second row
    // naming the step again (activity.css hides it). With more steps, each is a row again.
    const lone = expanded && state.previousNodes.length === 1 && awaitingApproval.length === 0
      ? state.previousNodes[0].querySelector<HTMLDetailsElement>(":scope > details.systemsculpt-agent-tool.is-disclosure")
      : null;
    state.body.toggleAttribute("data-single-step", lone !== null);
    if (lone && !lone.open) lone.open = true;
  }

  private hasPendingApproval(node: HTMLElement): boolean {
    return Boolean(node.querySelector(".systemsculpt-agent-approval"));
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
        "data-testid": "chat.tail-status",
        "data-phase": "cancelled",
        "data-status": "Stopped",
      },
    });
    const icon = status.createSpan({ cls: "systemsculpt-agent-tail-status-icon" });
    // One glyph for a stop: the stopped row, its fold and this marker.
    setIcon(icon, "circle-stop");
    icon.dataset.iconState = "circle-stop";
    status.createSpan({ cls: "systemsculpt-agent-tail-status-label", text: "Stopped", attr: { "data-testid": "chat.tail-status.label" } });
  }

  private failedTailPart(
    receipt: DurableFailedReceipt,
    retryMessageId: string | null,
  ): AgentPart {
    const key = `error:${retryMessageId ?? receipt.messageId}`;
    return {
      id: key,
      order: Number.MAX_SAFE_INTEGER,
      kind: "error",
      error: {
        code: receipt.failureCode,
        message: receipt.failureMessage ?? "SystemSculpt could not complete the response.",
        retryable: receipt.retryable,
        ...(receipt.reportId ? isLocalReportId(receipt.reportId)
          ? { reportId: receipt.reportId }
          : { incidentId: receipt.reportId } : {}),
        ...(receipt.incidentId ? { incidentId: receipt.incidentId } : {}),
      },
      retryable: receipt.retryable,
      ...(retryMessageId ? { retryMessageId } : {}),
    };
  }

  private async renderDurableFailedTail(body: HTMLElement, receipt: DurableFailedReceipt, retryMessageId: string | null): Promise<void> {
    const part = this.failedTailPart(receipt, retryMessageId);
    const node = body.createDiv({ cls: "systemsculpt-agent-part is-error", attr: { "data-part-key": part.id } });
    await this.renderPart(node, part);
  }

  public setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.renderingEnabled = visible;
    this.lifecycleGeneration += 1;
    this.liveMarkdown.setVisible(visible);
    this.historyHydration.setVisible(visible);
    this.active.setVisible(visible);
    if (!visible) {
      if (this.loadingTimer !== null) this.loadingTimerWindow?.clearTimeout(this.loadingTimer);
      this.loadingTimer = null;
      this.loadingTimerWindow = null;
    } else {
      for (const [status, update] of this.deferredReportUpdates) {
        if (this.element.contains(status)) update();
      }
      this.deferredReportUpdates.clear();
    }
  }


  private captureHistoricalDisclosureState(row: HTMLElement): HistoricalDisclosureSnapshot {
    const worked = row.querySelector<HTMLDetailsElement>("details[data-agent-turn-fold]");
    const workedBody = worked?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-activity-body",
    ) ?? null;
    const wasHydrated = worked ? this.historyHydration.wasHydrated(worked) : false;
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
          || wasHydrated
          || (workedBody?.childElementCount ?? 0) > 0
        )
      ),
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
      await this.historyHydration.hydrate(nextWorked);
    }
    if (nextWorked) {
      nextWorked.open = replacement.disclosure.workedOpen;
      this.updateIncidentDisclosureOpen(nextWorked, nextWorked.open);
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
    const focusElement = focusedElementWithin(previousRow);
    const preservedSelection = captureDomSelection(previousRow);
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
    return findFocusKey(root, locator.focusKey) ?? root;
  }

  public clearActive(): void {
    this.active.clear();
  }

  public showCompletedRenderFallback(): void {
    this.element.setAttribute("aria-busy", "false");
    if (this.activeRoot.querySelector(".systemsculpt-agent-render-fallback")) return;
    this.activeRoot.createDiv({
      cls: "systemsculpt-agent-render-fallback systemsculpt-agent-banner is-error",
      text: "Part of this chat couldn't display. Reopen it.",
      attr: {
        "data-testid": "chat.banner",
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
    progressActive = true,
  ): Promise<boolean> {
    node.dataset.testid = "chat.part";
    node.dataset.kind = part.kind;
    if (part.kind === "text") {
      const streaming = progressActive && part.state === "streaming";
      node.className = "systemsculpt-agent-part is-text";
      node.classList.toggle("is-streaming", streaming);
      node.classList.toggle("is-sources", part.id.startsWith("sources:"));
      if (streaming) {
        this.liveMarkdown.stream(node, part.markdown);
        return true;
      }
      await this.liveMarkdown.settle(node, part.markdown);
      return true;
    }
    if (
      part.kind === "reasoning"
      && previousPart?.kind === "reasoning"
      && await this.updateReasoning(node, part, progressActive)
    ) {
      return true;
    }
    if (part.kind === "tool") {
      return this.tools.render(node, part, suppressToolError, progressActive);
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
          undefined,
          progressActive,
        );
        return true;
      }
      case "error": {
        node.setAttrs({ role: "alert", "aria-live": "assertive" });
        const errorIcon = node.createSpan({ cls: "systemsculpt-agent-error-icon" });
        setIcon(errorIcon, "circle-alert");
        const copy = node.createDiv({ cls: "systemsculpt-agent-error-copy" });
        const presented = presentAgentError(
          part.error, part.retryable, this.options.showPlanOffer?.(), this.options.showPaymentFix?.() ?? false,
        );
        // Credits, plans, a usage limit and a sign-in are a gate with a way through, not a failure: calm,
        // with a lock (as on a tool row). Red stays for things that broke.
        if (presented.action === "see-plans" || presented.action === "monthly" || presented.action === "add-credits"
          || presented.action === "use-hosted" || presented.action === "sign-in") {
          node.addClass("is-gate");
          setIcon(errorIcon, "lock");
        }
        // The line above the composer stays hidden while this card offers the same fix.
        if (presented.action === "see-plans" || presented.action === "monthly" || presented.action === "add-credits"
          || presented.action === "update-card") node.dataset.offer = presented.action;
        copy.createEl("strong", {
          cls: "systemsculpt-agent-error-heading",
          text: presented.heading,
        });
        const message = copy.createDiv({ cls: "systemsculpt-agent-error-message" });
        // A banner shows the message alone; under its heading, the card drops the words the heading says.
        const shown = presented.body ?? (presented.message.startsWith(`${presented.heading}.`)
          ? presented.message.slice(presented.heading.length + 1).trim() || presented.message
          : presented.message);
        for (const segment of shown.split(/(`[^`]+`)/u)) {
          if (segment.startsWith("`") && segment.endsWith("`")) message.createEl("code", { text: segment.slice(1, -1) });
          else message.appendText(segment);
        }
        const reportStatus = presented.reportId
          ? copy.createDiv({
            cls: "systemsculpt-agent-error-report",
            text: "Preparing report…",
          }) : null;
        const canRetry = part.retryable && part.retryMessageId && this.options.onRetryFailedTurn
          && !presented.action?.match(/^(see-plans|monthly|add-credits|detect|use-hosted)$/)
          && part.error.code !== "content_filter";
        const actions = canRetry || presented.action || presented.reportId && this.options.onCopyIncidentReport
          ? copy.createDiv({ cls: "systemsculpt-agent-error-actions" }) : null;
        if (actions && canRetry) {
          const retry = createUiAction(actions, {
            label: "Retry",
            testId: "chat.turn.retry-failed",
            tone: "primary",
            size: "small",
          });
          retry.addClass("systemsculpt-agent-error-retry");
          retry.onclick = () => void this.options.onRetryFailedTurn?.(part.retryMessageId!);
        }
        const monthlyOffer = presented.action === "monthly"
          && this.options.onMonthlyOffer
          && (this.options.showMonthlyOffer?.() ?? true);
        if (actions && monthlyOffer) {
          const monthly = createUiAction(actions, { label: "Subscribe", testId: "chat.turn.subscribe", tone: "primary", size: "small" });
          monthly.onclick = () => void this.options.onMonthlyOffer?.();
        }
        if (actions && presented.action === "update-card" && this.options.onUpdateCard) {
          const card = createUiAction(actions, { label: "Update card", testId: "chat.turn.update-card", tone: "primary", size: "small" });
          card.onclick = () => void this.options.onUpdateCard?.();
        }
        if (actions && presented.action === "add-credits" && this.options.onOpenCredits) {
          const credits = createUiAction(actions, { label: "Add credits", testId: "chat.turn.add-credits", tone: "primary", size: "small" });
          credits.onclick = () => void this.options.onOpenCredits?.();
        }
        // Signing in is finished with Retry, which the card's words name; Detect again is for a fresh install.
        if (actions && presented.action === "detect" && this.options.onDetectAgain) {
          const detect = createUiAction(actions, { label: "Detect again", testId: "chat.turn.detect-again", size: "small" });
          detect.onclick = async () => {
            const ready = await this.options.onDetectAgain?.();
            if (ready !== true || !detect.isConnected || presented.action !== "detect"
              || !part.retryable || !part.retryMessageId || !this.options.onRetryFailedTurn) return;
            updateUiAction(detect, { label: "Retry" });
            detect.dataset.testid = "chat.turn.retry-failed";
            detect.onclick = () => void this.options.onRetryFailedTurn?.(part.retryMessageId!);
          };
        }
        if (actions && (presented.action === "detect" || presented.action === "use-hosted") && this.options.onUseHosted) {
          const hosted = createUiAction(actions, { label: "Use SystemSculpt instead", testId: "chat.turn.use-hosted", size: "small" });
          hosted.onclick = () => void this.options.onUseHosted?.();
        }
        if (presented.details) {
          // The same quiet "› Details" disclosure as tool cards and approvals.
          const details = copy.createEl("details", { cls: "systemsculpt-agent-error-details systemsculpt-agent-tool-raw" });
          const summary = details.createEl("summary", { attr: { "data-testid": "chat.turn.error-details" } });
          setIcon(summary.createSpan({ cls: "systemsculpt-agent-tool-raw-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
          summary.appendText("Details");
          details.createEl("pre", { attr: { tabindex: "0" } }).createEl("code", { text: presented.details });
        }
        if (actions && (presented.action === "see-plans" || presented.action === "monthly" && !monthlyOffer) && this.options.onViewPlans) {
          const plans = createUiAction(actions, {
            label: "See plans",
            testId: "chat.turn.see-plans",
            tone: "primary",
            size: "small",
          });
          plans.onclick = () => void this.options.onViewPlans?.(part.error);
        }
        if (reportStatus && presented.reportId) {
          void this.prepareIncidentReport(reportStatus, actions, presented.reportId);
        }
        return true;
      }
      default:
        return true;
    }
  }

  public override onunload(): void {
    this.reportGeneration += 1;
    this.deferredReportUpdates.clear();
    this.setLoading(false);
    this.renderingEnabled = false;
    this.lifecycleGeneration += 1;
    this.renderGeneration += 1;
    this.active.dispose();
    this.historyHydration.clear();
    this.liveMarkdown.clear();
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    for (const timer of this.copyFeedbackTimers.values()) ownerWindow.clearTimeout(timer);
    this.copyFeedbackTimers.clear();
    this.historyRows.clear();
    this.incidentHistoricalPartCount = 0;
    this.historyMessageIds = new Set<string>();
    this.committedCancelledMessageIds = new Set<string>();
    this.committedFailedMessageIds = new Set<string>();
    this.committedFailedTurnIds = new Set<string>();
    this.incidentDisclosureStates.clear();
    this.inlineEditor.dispose();
  }

  public override onload(): void {
    this.renderingEnabled = this.visible;
    this.lifecycleGeneration += 1;
    const detachMigration = this.element.onWindowMigrated?.(() => this.active.windowMigrated());
    if (detachMigration) this.register(detachMigration);
    // Action rows stay invisible until a turn is hovered or focused, so their
    // icons are drawn then rather than for every row of a long chat.
    const reveal = (event: Event) => this.drawPendingActionIcons(event.target);
    this.registerDomEvent(this.element, "pointerover", reveal);
    this.registerDomEvent(this.element, "focusin", reveal);
  }

  /** Fine pointers reveal actions on hover/focus; touch shows them faintly at once. */
  private defersActionIcons(): boolean {
    try {
      const media = getSurfaceOwnerWindow(this.element).matchMedia?.("(pointer: coarse)");
      return media !== undefined && !media.matches;
    } catch {
      return false;
    }
  }

  private drawPendingActionIcons(target: EventTarget | null): void {
    const turn = (target as Element | null)?.closest?.(".systemsculpt-agent-turn");
    const actions = turn?.querySelector<HTMLElement>(
      ":scope > .systemsculpt-agent-message-actions[data-pending-icons]",
    );
    if (!actions) return;
    delete actions.dataset.pendingIcons;
    for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>("button[data-pending-icon]"))) {
      updateUiAction(button, { icon: button.dataset.pendingIcon! });
      delete button.dataset.pendingIcon;
    }
  }

  private async renderReasoning(
    node: HTMLElement,
    summary: string,
    incomplete: boolean,
    preservedOpen?: boolean,
    progressActive = true,
  ): Promise<void> {
    const streaming = incomplete && progressActive;
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
    icon.dataset.iconState = streaming ? "streaming" : incomplete ? "paused" : "complete";
    icon.classList.toggle("is-animated", streaming);
    const labelText = streaming ? "Reasoning..." : incomplete ? "Reasoning" : "Reasoned";
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
    progressActive = true,
  ): Promise<boolean> {
    const details = node.querySelector<HTMLDetailsElement>(".systemsculpt-agent-reasoning-details");
    const header = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-header");
    const icon = header?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-icon");
    const label = header?.querySelector<HTMLElement>("strong");
    const body = details?.querySelector<HTMLElement>(".systemsculpt-agent-reasoning-body");
    if (!details || !header || !icon || !label || !body) return false;

    const incomplete = current.state === "streaming";
    const streaming = incomplete && progressActive;
    const labelText = streaming ? "Reasoning..." : incomplete ? "Reasoning" : "Reasoned";
    node.className = "systemsculpt-agent-part is-reasoning";
    node.classList.toggle("is-streaming", streaming);
    label.setText(labelText);
    const iconState = streaming ? "streaming" : incomplete ? "paused" : "complete";
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

  private renderTurnMediaBlock(parent: HTMLElement, parts: readonly AgentToolPart[], answer: string, live = false): HTMLElement | null {
    return renderTurnMedia(this.options.app, parent, parts, {
      openFile: (path) => void this.options.onOpenArtifact({ id: path, kind: "generated_file", title: path.split("/").pop() ?? path, path }),
      openLink: (url) => void openExternalUrl(url, parent.ownerDocument.defaultView ?? undefined),
    }, answer, live);
  }

  private renderTurnChanges(parent: HTMLElement, parts: readonly AgentToolPart[]): void {
    const existing = parent.querySelector<HTMLElement>(":scope > .systemsculpt-agent-turn-changes");
    const changes = presentTurnChanges(parts);
    const fingerprint = JSON.stringify(changes);
    if (existing?.dataset.changes === fingerprint) return;
    existing?.remove();
    if (!changes.length) return;
    const summary = parent.createDiv({ cls: "systemsculpt-agent-turn-changes", attr: { "data-testid": "chat.turn.changes" } });
    summary.dataset.changes = fingerprint;
    summary.appendText(`Changed ${changes.length} ${changes.length === 1 ? "note" : "notes"}: `);
    changes.forEach((change, index) => {
      if (index) summary.appendText(", ");
      if (change.deleted) summary.appendText(change.label);
      else {
        const link = summary.createEl("a", {
          text: change.label, attr: { href: change.path, "data-testid": "chat.turn.change.open", "data-href": change.path },
        });
        link.onclick = (event) => {
          event.preventDefault();
          void this.options.onOpenArtifact({ id: change.path, kind: "vault_file", title: change.label, path: change.path });
        };
      }
      if (change.meta) summary.appendText(change.meta.startsWith("+") ? ` ${change.meta}` : ` (${change.meta})`);
    });
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
    copyPath.setAttrs({ "aria-label": "Copy path" });
    copyPath.onclick = () => void this.copyWithFeedback(copyPath, "path", () => this.options.onCopyArtifactPath(artifact));
  }

  private renderMessageActions(row: HTMLElement, message: ChatMessage, text: string): void {
    const canCopy = text.length > 0 && Boolean(this.options.onCopyText);
    const canRetry = message.role === "user" && Boolean(this.options.onRetryMessage);
    const canRetryResponse = message.role === "assistant" && row.dataset.turnId && this.options.onRetryFailedTurn;
    if (!canCopy && !canRetry && !canRetryResponse) return;

    row.querySelector(":scope > .systemsculpt-agent-message-actions")?.remove();
    const actions = row.createDiv({ cls: "systemsculpt-agent-message-actions" });
    const deferIcons = this.defersActionIcons();
    if (deferIcons) actions.dataset.pendingIcons = "";
    const icon = (name: string): Readonly<{ icon?: string }> => deferIcons ? {} : { icon: name };
    const pending = (button: HTMLButtonElement, name: string): void => {
      if (deferIcons) button.dataset.pendingIcon = name;
    };
    const timestamp = message.messageParts?.find((part) => part.timestamp > 1_000_000_000_000)?.timestamp;
    const time = timestamp ? messageTimeFormat().format(timestamp) : null;
    if (time) actions.setAttribute("title", time);
    const actionTitle = (label: string): string => time ? `${label} · ${time}` : label;
    if (canRetryResponse) {
      const retry = createUiAction(actions, {
        label: actionTitle("Retry response"), testId: "chat.turn.retry", ...icon("rotate-ccw"), size: "icon",
        title: actionTitle("Retry response"),
      });
      pending(retry, "rotate-ccw");
      retry.onclick = () => void this.options.onRetryFailedTurn?.(row.dataset.turnId!);
    }
    if (message.role === "assistant" && message.responseDurationMs !== undefined
      && (message.tool_calls?.length || message.messageParts?.some((part) => part.type === "tool_call"))) {
      actions.createSpan({
        cls: "systemsculpt-agent-message-duration",
        text: `Worked ${formatAgentWorkingDuration(message.responseDurationMs) ?? "0s"}`,
      });
    }
    if (canCopy) {
      const subject = message.role === "assistant" ? "response" : "message";
      const copy = createUiAction(actions, {
        label: actionTitle(`Copy ${subject}`),
        title: actionTitle(`Copy ${subject}`),
        testId: "chat.turn.copy",
        ...icon("copy"),
        size: "icon",
      });
      pending(copy, "copy");
      copy.addClass("systemsculpt-agent-message-copy");
      copy.onclick = () => void this.copyWithFeedback(copy, subject, () => this.options.onCopyText?.(text));
    }
    if (canRetry) {
      const retry = createUiAction(actions, {
        label: actionTitle("Edit and resubmit"),
        title: actionTitle("Edit and resubmit"),
        testId: "chat.turn.edit-resubmit",
        ...icon("pencil"),
        size: "icon",
      });
      pending(retry, "pencil");
      retry.addClass("systemsculpt-agent-inline-button");
      retry.setAttr("data-focus-key", "edit-message");
      retry.onclick = () => void this.options.onRetryMessage?.(message.message_id);
    }
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
      const file = attachment.kind === "file" && !attachment.unavailable
        ? this.options.app.metadataCache?.getFirstLinkpathDest(attachment.label, this.options.sourcePath()) : null;
      if (file) {
        const open = createUiAction(copy, { label: attachment.label, testId: "chat.attachment.open", size: "small" });
        open.onclick = () => void this.options.onOpenArtifact({
          id: file.path, kind: "vault_file", title: attachment.label, path: file.path,
        });
      } else copy.createEl("strong", { text: attachment.label });
      if (attachment.unavailable) copy.createSpan({ text: "Unavailable" });
    }
    parent.prepend(list);
  }

  private async renderMarkdown(markdown: string, parent: HTMLElement): Promise<void> {
    await this.liveMarkdown.settle(parent, markdown);
  }

  private forgetMarkdown(target: HTMLElement): void {
    this.untrackIncidentDisclosuresWithin(target);
    this.historyHydration.forgetWithin(target);
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

  private enhanceCodeBlocks(parent: HTMLElement): void {
    enhanceMarkdownCodeBlocks(parent, {
      onCopyFeedback: (control, copied) => this.showCopyFeedback(control, copied),
      beginLayoutMutation: this.options.beginLayoutMutation,
    });
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
    this.options.onAnnounce?.(copied ? "Copied" : "Could not copy code");

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: "Copy", icon: "copy" });
      button.setAttribute("aria-label", "Copy code");
    }, 1_500);
    this.copyFeedbackTimers.set(button, timer);
  }

  private async prepareIncidentReport(
    status: HTMLElement,
    actions: HTMLElement | null,
    reportId: string,
    retry = false,
  ): Promise<void> {
    const generation = this.reportGeneration;
    status.setText("Preparing report…");
    let available = !isLocalReportId(reportId);
    try {
      if (!available) available = await this.options.onPrepareIncidentReport?.(reportId, retry) ?? false;
    } catch {
      available = false;
    }
    if (generation !== this.reportGeneration) return;
    const update = () => this.renderIncidentReport(status, actions, reportId, available);
    if (!this.visible) this.deferredReportUpdates.set(status, update);
    else update();
  }

  private renderIncidentReport(
    status: HTMLElement,
    actions: HTMLElement | null,
    reportId: string,
    available: boolean,
  ): void {
    status.setText(available ? `Report ID: ${reportId}` : "Report unavailable");
    if (!actions) return;
    if (!available) {
      if (!this.options.onPrepareIncidentReport) return;
      const retrySave = createUiAction(actions, {
        label: "Retry report",
        testId: "chat.turn.retry-incident-report",
        size: "small",
        tooltip: false,
      });
      retrySave.onclick = () => {
        retrySave.disabled = true;
        retrySave.remove();
        void this.prepareIncidentReport(status, actions, reportId, true);
      };
      return;
    }
    if (!this.options.onCopyIncidentReport) return;
    const copyReport = createUiAction(actions, {
      label: "Copy report ID",
      testId: "chat.turn.copy-incident-report",
      size: "small",
      tooltip: false,
    });
    copyReport.addClass("systemsculpt-agent-error-copy-report");
    copyReport.onclick = () => void this.copyIncidentReport(copyReport, reportId);
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

  private async copyWithFeedback(
    button: HTMLButtonElement,
    subject: "message" | "response" | "path",
    copy: () => boolean | Promise<boolean> | undefined,
  ): Promise<void> {
    const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
    button.dataset.copyAttempt = attempt;
    let copied = false;
    try {
      copied = await copy() === true;
    } catch {
      copied = false;
    }
    if (!button.isConnected || button.dataset.copyAttempt !== attempt) return;

    const ownerWindow = getSurfaceOwnerWindow(button);
    const previousTimer = this.copyFeedbackTimers.get(button);
    if (typeof previousTimer === "number") ownerWindow.clearTimeout(previousTimer);

    button.classList.toggle("is-copied", copied);
    button.classList.toggle("is-copy-failed", !copied);
    const subjectLabel = subject[0].toUpperCase() + subject.slice(1);
    const label = copied ? `${subjectLabel} copied` : `Could not copy ${subject}. Try again`;
    delete button.dataset.pendingIcon;
    updateUiAction(button, {
      label,
      icon: copied ? "check" : "circle-alert",
    });
    button.setAttribute("aria-label", label);
    this.options.onAnnounce?.(copied ? "Copied" : label);

    const timer = ownerWindow.setTimeout(() => {
      this.copyFeedbackTimers.delete(button);
      if (!button.isConnected) return;
      button.removeClass("is-copied", "is-copy-failed");
      updateUiAction(button, { label: `Copy ${subject}`, icon: "copy" });
      button.setAttribute("aria-label", `Copy ${subject}`);
    }, copied ? 1_500 : 3_000);
    this.copyFeedbackTimers.set(button, timer);
  }

}
