import { App, Component, Menu, setIcon } from "obsidian";
import { getHostOperatingSystem } from "../../platform/hostCapabilities";
import {
  applyPluginSurface,
  createUiAction,
  updateUiAction,
} from "../../core/ui/surface";
import {
  cancelSurfaceAnimationFrame,
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";
import { bindSurfaceActivity } from "../../core/ui/surface/SurfaceActivity";
import { observeLeafVisibility } from "../../core/ui/surface/LeafVisibility";
import type { ChatMessage } from "../../types";
import { contentKeys, sameContentKeys } from "../../utils/immutableJson";
import {
  AnchoredScroller,
  type AnchoredScrollerIncidentSnapshot,
} from "./AnchoredScroller";
import {
  AgentComposer,
  type AgentComposerAttachment,
  type AgentComposerOptions,
  type AgentComposerSubmit,
} from "./AgentComposer";
import type { ChatMessageAttachment } from "./attachments/ChatMessageAttachments";
import type { ChatDocumentAttachmentProcessor } from "./attachments/ChatMessageAttachments";
import type { ThinAgentInputLimits } from "../../services/managed/ThinAgentInputLimits";
import type { AgentArtifact, AgentConversationSnapshot, ManagedAgentError } from "../../chat/ChatConversation";
import { presentAgentConversation } from "./AgentConversationPresentation";
import type { ApprovalAnswer } from "./AgentApprovalCards";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { presentEmptyState, type AgentChromeState } from "./AgentChatChrome";
import { AgentEmptyState, type AgentEmptyStateOptions } from "./AgentEmptyState";
import { AgentRunLine, containMenuEscape, returnFocusAfterMenu, type AgentRunLineOptions } from "./AgentRunLine";
import { ChatHistoryPanel, type ChatHistoryPanelOptions } from "../history/ChatHistoryPanel";
import {
  AgentConversationRenderer,
  type AgentConversationRendererIncidentSnapshot,
  type AgentInlineMessageEdit,
} from "./AgentConversationRenderer";

export type AgentQueuedFollowUp = Readonly<{
  id: string;
  text: string;
  includeContextFiles: boolean;
  attachments?: readonly ChatMessageAttachment[];
}>;

export type AgentWorkspaceOptions = Readonly<{
  app: App;
  visibilityRoot?: HTMLElement;
  sourcePath: () => string;
  reducedMotion?: () => boolean;
  onSubmit: AgentComposerOptions["onSubmit"];
  onStop: () => void | Promise<void>;
  onAttach: () => void | Promise<void>;
  onVaultContextDrop?: (path: string) => void | Promise<void>;
  documentAttachmentProcessor?: ChatDocumentAttachmentProcessor;
  attachmentLimits?: ThinAgentInputLimits;
  onMic?: () => void | Promise<void>;
  onRemoveAttachment: (attachment: AgentComposerAttachment) => void | Promise<void>;
  onApprove: ApprovalAnswer;
  isApprovalVisible?: () => boolean;
  onHiddenApproval?: (part: AgentToolPart) => void;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => boolean | Promise<boolean>;
  onRetryFailedTurn?: (messageId: string) => void | Promise<void>;
  onPrepareIncidentReport?: (reportId: string, retry?: boolean) => Promise<boolean>;
  onCopyIncidentReport?: (
    reportId: string,
  ) => boolean | Promise<boolean>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onResubmitMessage?: (messageId: string, text: string) => boolean | Promise<boolean>;
  onCancelMessageEdit?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => boolean | Promise<boolean>;
  onNewChat: () => void | Promise<void>;
  onOpenHistory: () => void | Promise<void>;
  /** Detect again resolves true when this chat's agent is ready, enabling Retry. */
  onDetectAgain?: () => boolean | void | Promise<boolean | void>;
  onUseHosted?: () => void | Promise<void>;
  /** "Add credits" in an out-of-credits error: the credits modal. */
  onOpenCredits?: () => void | Promise<void>;
  /** Who answers in this chat ("Claude Code", "Codex", "SystemSculpt"). */
  backendName?: () => string;
  /** Saves a title typed into the header. */
  onRename?: (title: string) => void | Promise<void>;
  /** Fills the header's More menu; the view adds the same items to its pane menu. */
  buildMoreMenu?: (menu: Menu) => void;
  onViewPlans?: (error?: ManagedAgentError) => void | Promise<void>;
  showPlanOffer?: boolean;
  onCancelQueued?: (id: string) => void | Promise<void>;
  onRunQueuedNow?: (id: string) => void | Promise<void>;
  runLine?: AgentRunLineOptions;
  emptyState?: AgentEmptyStateOptions;
  history?: ChatHistoryPanelOptions;
}>;

const NO_RUN_LINE: AgentRunLineOptions = {
  onSelectBackend: () => undefined,
  onSelectMode: () => undefined,
  onModelChange: () => undefined,
  onDetectAgain: () => undefined,
  onOpenSettings: () => undefined,
  onAction: () => undefined,
};

const NO_EMPTY_STATE: AgentEmptyStateOptions = {
  onStarter: () => undefined,
  onAction: () => undefined,
};

const NO_HISTORY: ChatHistoryPanelOptions = {
  loadRows: async () => [],
  loadSearchText: async () => "",
  isCurrent: () => false,
  isRunning: () => false,
  onOpen: () => undefined,
  onNewChat: () => undefined,
  onClose: () => undefined,
  onToggleFavorite: async () => undefined,
  onRename: async () => undefined,
  onDelete: async () => false,
};

function iconButton(parent: HTMLElement, testId: string, label: string, icon: string): HTMLButtonElement {
  const element = createUiAction(parent, {
    label,
    testId,
    icon,
    size: "icon",
    tooltip: false,
  });
  element.addClass("systemsculpt-agent-icon-button");
  return element;
}

let workspaceLabelSequence = 0;

const PENDING_AGENT_SNAPSHOT: AgentConversationSnapshot = Object.freeze({
  runId: null,
  turnId: null,
  status: "running",
  phase: "submitted",
  elapsedMs: 0,
  messages: Object.freeze([]),
  parts: Object.freeze([]),
});

type SnapshotRenderWaiter = Readonly<{
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

type AgentWorkspaceIncidentRenderState =
  | "idle"
  | "frame_pending"
  | "queued"
  | "rendering"
  | "rendering_with_pending";

export type AgentWorkspaceIncidentRenderingSnapshot = Readonly<{
  renderState: AgentWorkspaceIncidentRenderState;
  renderPassCount: number;
  pendingRenderCount: number;
  lastRenderDurationMs: number;
  maxRenderDurationMs: number;
  firstDomCommitObserved: boolean;
  firstPaintOpportunityObserved: boolean;
  failureSurfaceDomCommitted: boolean;
  failureSurfacePaintOpportunityObserved: boolean;
  registeredRowCount: number;
  renderer: AgentConversationRendererIncidentSnapshot;
  scroller: AnchoredScrollerIncidentSnapshot;
}>;

const INCIDENT_RENDER_COUNT_LIMIT = 1_000_000;
const INCIDENT_RENDER_DURATION_LIMIT_MS = 86_400_000;

function boundedIncidentRenderCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_COUNT_LIMIT, Math.max(0, Math.floor(value)));
}

function boundedIncidentRenderDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(INCIDENT_RENDER_DURATION_LIMIT_MS, Math.max(0, Math.round(value)));
}

/** Complete native shell for the managed agent experience inside Obsidian. */
export class AgentWorkspace extends Component {
  public readonly element: HTMLElement;
  public readonly viewport: HTMLElement;
  public readonly renderer: AgentConversationRenderer;
  public readonly composer: AgentComposer;
  public readonly runLine: AgentRunLine;
  public readonly historyPanel: ChatHistoryPanel;
  private readonly header: HTMLElement;
  private readonly titleElement: HTMLElement;
  private readonly titleButton: HTMLButtonElement;
  private titleText = "New chat";
  private readonly emptyState: AgentEmptyState;
  private readonly liveRegion: HTMLElement;
  private announceTimer: number | null = null;
  private announceTimerWindow: Window | null = null;
  private loading = false;
  private pendingAnnouncements: string[] = [];
  private chromeKey = "";
  private historyReturnFocus: HTMLElement | null = null;
  private moreMenu: Menu | null = null;
  private showPlanOffer = false;
  private readonly banner: HTMLElement;
  private readonly queueElement: HTMLElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly scroller: AnchoredScroller;
  private readonly registeredRows = new Map<string, HTMLElement>();
  private readonly queuedRows = new Map<string, HTMLElement>();
  private history: readonly ChatMessage[] = [];
  /** Frozen transcript messages compare by identity instead of by JSON. */
  private historyKeys: readonly unknown[] = [];
  private historyNeedsRender = false;
  private snapshot: AgentConversationSnapshot | null = null;
  private runPending = false;
  private pendingTurnId: string | null = null;
  private rendering: Promise<void> = Promise.resolve();
  private pendingSnapshotRender: AgentConversationSnapshot | null | undefined;
  private snapshotRenderWaiters: SnapshotRenderWaiter[] = [];
  private readonly activeSnapshotRenderWaiters = new Set<SnapshotRenderWaiter>();
  private snapshotRenderFrame: number | null = null;
  private snapshotRenderTaskCount = 0;
  private registeredActiveResponse: Readonly<{
    turnId: string;
    row: HTMLElement;
  }> | null = null;
  private followedTurnId: string | null = null;
  private submittedPromptTurnId: string | null = null;
  private pendingDisclosureLayoutMutation: Readonly<{
    cancel: () => void;
  }> | null = null;
  private unloaded = false;
  private visible = true;
  private deferredChrome: AgentChromeState | null = null;
  private deferredQueue: readonly AgentQueuedFollowUp[] | null = null;
  private snapshotRenderWindow: Window | null = null;
  private lifecycleGeneration = 0;
  private incidentMetricsGeneration = 0;
  private incidentRenderPassCount = 0;
  private incidentQueuedRenderCount = 0;
  private incidentActiveRenderCount = 0;
  private incidentLastRenderDurationMs = 0;
  private incidentMaxRenderDurationMs = 0;
  private incidentFirstDomCommitObserved = false;
  private incidentFirstPaintOpportunityObserved = false;
  private incidentFailureSurfaceTurnId: string | null = null;
  private incidentFailureSurfaceDomCommitted = false;
  private incidentFailureSurfacePaintOpportunityObserved = false;

  constructor(parent: HTMLElement, private readonly options: AgentWorkspaceOptions) {
    super();
    this.element = parent.createDiv({ cls: "systemsculpt-agent-workspace" });
    applyPluginSurface(this.element, "view");
    this.element.classList.toggle("is-reduced-motion", options.reducedMotion?.() === true);

    this.header = this.element.createDiv({ cls: "systemsculpt-agent-header" });
    const titleId = `systemsculpt-agent-title-${++workspaceLabelSequence}`;
    this.titleElement = this.header.createDiv({
      cls: "systemsculpt-agent-header-title",
      attr: { id: titleId, role: "heading", "aria-level": "2" },
    });
    this.titleButton = this.titleElement.createEl("button", {
      cls: "systemsculpt-agent-title-button",
      text: this.titleText,
      attr: { type: "button", "data-testid": "chat.header.title", "aria-description": "Rename chat" },
    });
    this.titleButton.addEventListener("click", () => this.beginRename());
    const headerActions = this.header.createDiv({ cls: "systemsculpt-agent-header-actions" });
    const history = iconButton(headerActions, "chat.header.history", "Chat history", "history");
    const create = iconButton(headerActions, "chat.header.new", "New chat", "square-pen");
    const more = iconButton(headerActions, "chat.header.more", "More", "more-horizontal");
    const modifier = getHostOperatingSystem() === "macOS" ? "Meta" : "Control";
    history.setAttribute("aria-keyshortcuts", `${modifier}+K`);
    create.setAttribute("aria-keyshortcuts", `${modifier}+Shift+O`);
    more.setAttribute("aria-haspopup", "menu");
    for (const button of [history, create, more]) button.addClass("systemsculpt-agent-header-button");
    this.registerDomEvent(history, "click", () => void this.options.onOpenHistory());
    this.registerDomEvent(create, "click", () => void this.options.onNewChat());
    this.registerDomEvent(more, "click", () => this.showMoreMenu(more));

    this.banner = this.element.createDiv({
      cls: "systemsculpt-agent-banner",
      attr: { "aria-atomic": "true" },
    });
    this.banner.toggleAttribute("hidden", true);

    const transcript = this.element.createDiv({ cls: "systemsculpt-agent-transcript" });
    this.viewport = transcript.createDiv({
      cls: "systemsculpt-agent-viewport",
      attr: { tabindex: "0" },
    });
    this.emptyState = new AgentEmptyState(this.viewport, options.emptyState ?? NO_EMPTY_STATE);

    this.renderer = new AgentConversationRenderer(this.viewport, {
      app: options.app,
      sourcePath: options.sourcePath,
      beginLayoutMutation: (disclosureControl, mutationTarget) => this.unloaded
        ? undefined
        : disclosureControl
          ? this.scroller.beginDisclosureLayoutMutation(disclosureControl)
          : this.scroller.beginLayoutMutation(mutationTarget),
      onApprove: (approvalId, approved, rememberForSession, answers) => {
        const answered = answers
          ? options.onApprove(approvalId, approved, rememberForSession, answers)
          : rememberForSession
            ? options.onApprove(approvalId, approved, rememberForSession)
            : options.onApprove(approvalId, approved);
        return Promise.resolve(answered).then((result) => {
          // After a denial with nothing else waiting, invite the person to steer.
          if (!approved && !answers && result !== false && !this.hasPendingApprovalOtherThan(approvalId)) {
            this.composer.showSteeringPlaceholder();
          }
          return result;
        });
      },
      onReviewApproval: () => this.hideHistory(false),
      approvalComposer: () => this.composer?.element,
      isApprovalVisible: options.isApprovalVisible,
      onHiddenApproval: options.onHiddenApproval,
      onOpenArtifact: options.onOpenArtifact,
      onCopyArtifactPath: options.onCopyArtifactPath,
      showPlanOffer: () => this.showPlanOffer,
      onViewPlans: options.onViewPlans,
      onRetryFailedTurn: options.onRetryFailedTurn,
      onPrepareIncidentReport: options.onPrepareIncidentReport,
      onCopyIncidentReport: options.onCopyIncidentReport,
      onRetryMessage: options.onRetryMessage,
      onResubmitMessage: options.onResubmitMessage,
      onCancelMessageEdit: options.onCancelMessageEdit,
      onCopyText: options.onCopyText,
      backendName: options.backendName,
      onAnnounce: (text) => this.announce(text),
      onDetectAgain: options.onDetectAgain,
      onUseHosted: options.onUseHosted,
      onOpenCredits: options.onOpenCredits,
    });
    this.addChild(this.renderer);

    this.jumpButton = createUiAction(transcript, {
      label: "Latest",
      testId: "chat.jump-to-latest",
      icon: "arrow-down",
      tooltip: false,
    });
    this.jumpButton.addClass("systemsculpt-agent-jump");
    this.jumpButton.setAttribute("aria-label", "Jump to latest");

    this.scroller = new AnchoredScroller({
      viewport: this.viewport,
      content: this.renderer.element,
      scrollButton: this.jumpButton,
      reducedMotion: options.reducedMotion,
      labelledBy: titleId,
    });
    this.register(() => this.scroller.destroy());
    this.registerDomEvent(this.renderer.element, "click", this.handleDisclosureActivation, true);
    this.registerDomEvent(this.renderer.element, "keydown", this.handleDisclosureActivation, true);
    this.registerDomEvent(this.renderer.element, "keyup", this.handleDisclosureActivation, true);

    this.queueElement = this.element.createDiv({
      cls: "systemsculpt-agent-queue",
      attr: {
        role: "list",
        "aria-label": "Queued follow-ups",
      },
    });
    this.queueElement.toggleAttribute("hidden", true);

    this.composer = new AgentComposer(this.element, {
      app: options.app,
      sourcePath: options.sourcePath,
      onSubmit: options.onSubmit,
      onStop: options.onStop,
      onAttach: options.onAttach,
      onVaultContextDrop: options.onVaultContextDrop,
      documentAttachmentProcessor: options.documentAttachmentProcessor,
      attachmentLimits: options.attachmentLimits,
      onMic: options.onMic,
      onRemoveAttachment: options.onRemoveAttachment,
      announce: (message) => this.announce(message),
      onHeightChange: () => {
        if (!this.unloaded) this.scroller.notifyViewportGeometryChanged();
      },
    });
    this.addChild(this.composer);

    this.runLine = new AgentRunLine(this.composer.footerSlot, options.runLine ?? NO_RUN_LINE);
    this.addChild(this.runLine);

    this.historyPanel = new ChatHistoryPanel(this.element, {
      ...(options.history ?? NO_HISTORY),
      announce: (message) => this.announce(message),
    });
    this.addChild(this.historyPanel);

    // One polite live region per view (spec 6.3); streaming text is never announced.
    this.liveRegion = this.element.createDiv({
      cls: "systemsculpt-agent-sr-only",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true", "data-testid": "chat.announcer" },
    });
    this.register(() => {
      if (this.announceTimer !== null) this.announceTimerWindow?.clearTimeout(this.announceTimer);
      this.announceTimer = null;
      this.announceTimerWindow = null;
      this.pendingAnnouncements = [];
    });
  }

  /** A one-time info line from the agent, shown in the conversation. */
  public showNotice(text: string): void {
    this.renderer.showNotice(text);
  }

  /** A saved chat is loading; the conversation shows its skeleton after 300 ms. */
  public setLoading(loading: boolean): void {
    this.loading = loading;
    if (!this.visible) return;
    this.element.classList.toggle("is-loading-chat", loading);
    this.renderer.setLoading(loading);
    this.syncEmpty();
  }

  /** Polite announcement for screen readers. */
  public announce(text: string): void {
    if (!this.isRenderingVisible()) return;
    this.pendingAnnouncements.push(text);
    if (this.announceTimer !== null) return;
    // Clearing first makes a repeated message announce again. Preserve a burst
    // in order rather than letting a fast reply overwrite its start or approval.
    this.liveRegion.setText("");
    const ownerWindow = getSurfaceOwnerWindow(this.liveRegion);
    this.announceTimerWindow = ownerWindow;
    this.announceTimer = ownerWindow.setTimeout(() => {
      this.announceTimer = null;
      this.announceTimerWindow = null;
      this.liveRegion.setText(this.pendingAnnouncements.join(" "));
      this.pendingAnnouncements = [];
    }, 50);
  }

  /** Renders the run line and the empty state for the current chat. */
  public setChrome(state: AgentChromeState): void {
    if (!this.visible) { this.deferredChrome = state; return; }
    // Snapshots arrive many times a second while a turn streams.
    const key = JSON.stringify(state, (_key, value: unknown) => value instanceof Set ? [...value] : value);
    if (key === this.chromeKey) return;
    this.chromeKey = key;
    this.runLine.render(state);
    this.emptyState.render(presentEmptyState(state));
  }

  /** The header hides its title on mobile, where Obsidian's own header shows it. */
  public isTitleVisible(): boolean {
    return this.titleElement.getClientRects().length > 0;
  }

  public get isHistoryOpen(): boolean {
    return this.historyPanel.isOpen;
  }

  /** History replaces the conversation and composer until it closes. */
  public showHistory(): void {
    if (this.historyPanel.isOpen) {
      this.historyPanel.focusSearch();
      return;
    }
    const active = this.element.ownerDocument.activeElement;
    this.historyReturnFocus = active instanceof HTMLElement && this.element.contains(active) ? active : null;
    this.element.classList.add("is-history-open");
    this.historyPanel.open();
  }

  public hideHistory(restoreFocus = true): void {
    if (!this.historyPanel.isOpen) return;
    this.historyPanel.close();
    this.element.classList.remove("is-history-open");
    this.scroller.notifyViewportGeometryChanged();
    const target = this.historyReturnFocus;
    this.historyReturnFocus = null;
    if (!restoreFocus) return;
    if (target?.isConnected && !target.hasAttribute("disabled")) target.focus();
    else this.composer.focus();
  }

  private showMoreMenu(anchor: HTMLElement): void {
    // The same in-view menu style as the run line, whatever the native-menu setting.
    this.moreMenu?.hide();
    const menu = new Menu().setUseNativeMenu(false);
    this.moreMenu = menu;
    const releaseEscape = containMenuEscape(menu, anchor.ownerDocument);
    this.options.buildMoreMenu?.(menu);
    anchor.setAttribute("aria-expanded", "true");
    menu.onHide(() => {
      releaseEscape();
      if (this.moreMenu !== menu) return;
      this.moreMenu = null;
      anchor.setAttribute("aria-expanded", "false");
      returnFocusAfterMenu(this.element, () => this.titleElement.querySelector("input") ? null : anchor);
    });
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.bottom, left: true }, anchor.ownerDocument);
  }

  /** Edits the title in place: Enter or blur saves, Escape cancels. */
  public beginRename(): void {
    if (this.titleElement.querySelector("input")) return;
    const input = this.titleElement.createEl("input", {
      cls: "systemsculpt-agent-title-input",
      attr: {
        type: "text",
        value: this.titleText,
        "aria-label": "Chat title",
        "data-testid": "chat.header.title-input",
      },
    });
    this.titleButton.toggleAttribute("hidden", true);
    let settled = false;
    const finish = (save: boolean): void => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      const focusTitle = this.titleElement.contains(input.ownerDocument.activeElement);
      input.remove();
      this.titleButton.toggleAttribute("hidden", false);
      if (focusTitle) this.titleButton.focus();
      if (save && next && next !== this.titleText) void this.options.onRename?.(next);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  /** Returns a deeply frozen, content-free projection for a local incident report. */
  public captureIncidentRenderingSnapshot(): AgentWorkspaceIncidentRenderingSnapshot {
    const deferredSnapshotCount = typeof this.pendingSnapshotRender !== "undefined"
      && this.incidentQueuedRenderCount === 0
      && this.incidentActiveRenderCount === 0
      ? 1
      : 0;
    const pendingRenderCount = boundedIncidentRenderCount(
      this.incidentQueuedRenderCount
      + this.incidentActiveRenderCount
      + deferredSnapshotCount,
    );
    const hasPendingAfterActive = this.incidentQueuedRenderCount > 0
      || typeof this.pendingSnapshotRender !== "undefined"
      || this.snapshotRenderFrame !== null;
    const renderState: AgentWorkspaceIncidentRenderState = this.incidentActiveRenderCount > 0
      ? hasPendingAfterActive ? "rendering_with_pending" : "rendering"
      : this.snapshotRenderFrame !== null
        ? "frame_pending"
        : pendingRenderCount > 0
          ? "queued"
          : "idle";
    const renderer = this.renderer.captureIncidentSnapshot();
    const scroller = this.scroller.captureIncidentSnapshot();
    return Object.freeze({
      renderState,
      renderPassCount: boundedIncidentRenderCount(this.incidentRenderPassCount),
      pendingRenderCount,
      lastRenderDurationMs: boundedIncidentRenderDuration(
        this.incidentLastRenderDurationMs,
      ),
      maxRenderDurationMs: boundedIncidentRenderDuration(
        this.incidentMaxRenderDurationMs,
      ),
      firstDomCommitObserved: this.incidentFirstDomCommitObserved,
      firstPaintOpportunityObserved: this.incidentFirstPaintOpportunityObserved,
      failureSurfaceDomCommitted: this.incidentFailureSurfaceDomCommitted,
      failureSurfacePaintOpportunityObserved:
        this.incidentFailureSurfacePaintOpportunityObserved,
      registeredRowCount: boundedIncidentRenderCount(this.registeredRows.size),
      renderer,
      scroller,
    });
  }

  /** Records a validated DOM commit from the ChatView render lifecycle. */
  public recordIncidentDomCommit(): void {
    this.incidentFirstDomCommitObserved = true;
  }

  /** Records the frame callback already owned by the ChatView render lifecycle. */
  public recordIncidentPaintOpportunity(): void {
    if (!this.incidentFirstDomCommitObserved) return;
    this.incidentFirstPaintOpportunityObserved = true;
  }

  /** Records a paint opportunity only for the maintained failed surface. */
  public recordIncidentFailureSurfacePaintOpportunity(turnId: string): boolean {
    if (
      !this.incidentFailureSurfaceDomCommitted
      || this.incidentFailureSurfaceTurnId !== turnId
    ) return false;
    this.incidentFailureSurfacePaintOpportunityObserved = true;
    this.incidentFirstPaintOpportunityObserved = true;
    return true;
  }

  private hasPendingApprovalOtherThan(approvalId: string): boolean {
    return (this.snapshot?.parts ?? []).some((part) =>
      part.kind === "tool" && part.state === "approval-required" && part.approvalId !== approvalId);
  }

  public setTitle(title: string): void {
    this.titleText = title.trim() || "New chat";
    this.titleButton.setText(this.titleText);
    // The tooltip shows a title the header had to truncate.
    this.titleButton.setAttribute("aria-label", this.titleText);
  }

  /**
   * View-level state only: a read-only or corrupted saved chat, or a session
   * that could not be restored. `action` true offers plans (T-36).
   */
  public setBanner(
    message: string | null,
    kind: "info" | "error" = "info",
    action: boolean | Readonly<{ label: string; testId: string; onSelect: () => void }> = false,
  ): void {
    const previousMessage = this.banner.dataset.message;
    this.banner.dataset.message = message ?? "";
    this.banner.toggleAttribute("hidden", !message);
    this.banner.classList.toggle("is-error", kind === "error");
    if (kind === "error") this.banner.setAttribute("role", "alert");
    else this.banner.removeAttribute("role");
    this.banner.setText(message ?? "");
    if (message && message !== previousMessage && kind !== "error") this.announce(message);
    if (!message) return;
    if (action === true && this.options.onViewPlans) {
      const plans = createUiAction(this.banner, {
        label: "See plans",
        testId: "chat.banner.see-plans",
        size: "small",
      });
      plans.onclick = () => void this.options.onViewPlans?.();
    } else if (action && action !== true) {
      const button = createUiAction(this.banner, {
        label: action.label,
        testId: action.testId,
        size: "small",
      });
      button.onclick = () => action.onSelect();
    }
  }

  /** Whether out-of-credits turns offer plans (T-36); the empty state reads the account itself. */
  public setPlanOfferVisible(visible: boolean): void {
    this.showPlanOffer = visible;
  }

  public setAttachments(attachments: readonly AgentComposerAttachment[]): void {
    this.composer.setAttachments(attachments);
  }

  public setMessageAttachmentLimits(limits: ThinAgentInputLimits): void {
    this.composer.setMessageAttachmentLimits(limits);
  }

  public restoreMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.composer.restoreMessageAttachments(attachments);
  }

  public getMessageAttachments(): readonly ChatMessageAttachment[] {
    return this.composer.getMessageAttachments();
  }

  public setMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.composer.setMessageAttachments(attachments);
  }

  public restoreRejectedSubmission(submission: Pick<AgentComposerSubmit, "text" | "attachments">): void {
    this.composer.restoreRejectedSubmission(submission);
  }

  public resetComposerDraft(): void {
    this.composer.resetDraft();
  }

  public setComposerReadOnly(message: string | null): void {
    this.composer.setReadOnly(message);
  }

  public hasDraft(): boolean {
    return this.composer.hasDraft();
  }

  public setRecording(recording: boolean): void {
    this.composer.setRecording(recording);
  }

  public setQueue(queue: readonly AgentQueuedFollowUp[]): void {
    if (!this.visible) { this.deferredQueue = queue; return; }
    const focusedElement = this.queueElement.contains(
      this.queueElement.ownerDocument.activeElement,
    )
      ? this.queueElement.ownerDocument.activeElement as HTMLElement
      : null;
    this.queueElement.toggleAttribute("hidden", queue.length === 0);
    const desiredRows: HTMLElement[] = [];
    const wantedKeys = new Set<string>();
    const occurrences = new Map<string, number>();
    for (const [index, item] of queue.entries()) {
      const occurrence = occurrences.get(item.id) ?? 0;
      occurrences.set(item.id, occurrence + 1);
      const key = occurrence === 0 ? item.id : `${item.id}:${occurrence}`;
      wantedKeys.add(key);
      let row = this.queuedRows.get(key);
      if (!row) {
        row = this.queueElement.createDiv({
          cls: "systemsculpt-agent-queue-item",
          attr: {
            role: "listitem",
            "data-queue-key": key,
          },
        });
        const icon = row.createSpan({
          cls: "systemsculpt-agent-queue-icon",
          attr: { "aria-hidden": "true" },
        });
        setIcon(icon, "list-end");
        row.createSpan({ cls: "systemsculpt-agent-queue-label", text: "Queued" });
        row.createSpan({ cls: "systemsculpt-agent-queue-copy" });
        if (this.options.onRunQueuedNow) {
          const runNow = createUiAction(row, {
            label: "Send now",
            testId: "chat.queue.run-now",
            size: "small",
            tooltip: false,
          });
          runNow.addClass("systemsculpt-agent-queue-send-now");
          runNow.dataset.queueAction = "run-now";
          runNow.onclick = () => {
            const currentId = row?.dataset.queueItemId;
            if (currentId) void this.options.onRunQueuedNow?.(currentId);
          };
        }
        if (this.options.onCancelQueued) {
          const remove = iconButton(row, "chat.queue.remove", "Remove queued follow-up", "x");
          remove.dataset.queueAction = "remove";
          remove.onclick = () => {
            const currentId = row?.dataset.queueItemId;
            if (currentId) void this.options.onCancelQueued?.(currentId);
          };
        }
        this.queuedRows.set(key, row);
      }
      row.dataset.queueItemId = item.id;
      const attachmentLabel = item.attachments?.map((attachment) => attachment.name).join(", ") || "";
      const copy = row.querySelector<HTMLElement>(":scope > .systemsculpt-agent-queue-copy");
      const text = item.text || attachmentLabel || "Queued attachment";
      if (copy?.textContent !== text) copy?.setText(text);
      const target = `queued follow-up ${index + 1} of ${queue.length}`;
      const runNow = row.querySelector<HTMLButtonElement>(
        ':scope > [data-queue-action="run-now"]',
      );
      if (runNow) {
        runNow.setAttribute("aria-label", `Stop and send ${target} now`);
      }
      const remove = row.querySelector<HTMLButtonElement>(
        ':scope > [data-queue-action="remove"]',
      );
      if (remove) {
        updateUiAction(remove, { label: `Remove ${target}` });
      }
      desiredRows.push(row);
    }
    for (const [key, row] of this.queuedRows) {
      if (wantedKeys.has(key)) continue;
      row.remove();
      this.queuedRows.delete(key);
    }
    this.reconcileQueueRows(desiredRows);
    if (
      focusedElement?.isConnected
      && this.queueElement.contains(focusedElement)
      && this.queueElement.ownerDocument.activeElement !== focusedElement
    ) {
      focusedElement.focus();
    }
  }

  private reconcileQueueRows(desired: readonly HTMLElement[]): void {
    let cursor = this.queueElement.firstElementChild;
    for (const row of desired) {
      if (cursor !== row) this.queueElement.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
    }
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  public setHistory(messages: readonly ChatMessage[]): Promise<void> {
    this.history = messages;
    if (!this.visible) return Promise.resolve();
    if (
      this.submittedPromptTurnId
      && !messages.some((message) =>
        message.role === "user" && message.message_id === this.submittedPromptTurnId)
    ) {
      this.submittedPromptTurnId = null;
      this.scroller.clearSubmittedPromptAnchor();
    }
    const keys = contentKeys(messages);
    this.composer.setPromptHistory(messages);
    if (sameContentKeys(keys, this.historyKeys)) return Promise.resolve();
    return this.renderHistoryPreservingAnchor().then(() => {
      this.historyKeys = keys;
    });
  }

  public showMessageEditor(edit: AgentInlineMessageEdit): Promise<void> {
    this.renderer.setInlineMessageEdit(edit);
    this.composer.setHistoryEditing(true);
    return this.renderHistoryPreservingAnchor(true);
  }

  public hideMessageEditor(messageId: string, restoreFocus = true): Promise<void> {
    this.renderer.setInlineMessageEdit(null);
    this.composer.setHistoryEditing(false);
    return this.renderHistoryPreservingAnchor(false, restoreFocus ? messageId : undefined);
  }

  public resetMessageEditor(): void {
    this.renderer.setInlineMessageEdit(null);
    this.composer.setHistoryEditing(false);
  }

  private renderHistoryPreservingAnchor(
    focusEditor = false,
    focusEditActionForMessageId?: string,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    return this.scheduleRender(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      const finishLayoutMutation = this.scroller.beginLayoutMutation();
      try {
        await this.renderer.renderHistory(this.history);
      } finally {
        try {
          if (this.isLifecycleCurrent(generation)) this.syncRows();
        } finally {
          finishLayoutMutation();
        }
      }
      if (!this.isLifecycleCurrent(generation)) return;
      this.followActiveTurn();
      this.syncEmpty();
      if (focusEditor) this.renderer.focusInlineMessageEdit();
      if (focusEditActionForMessageId) {
        this.renderer.focusMessageEditAction(focusEditActionForMessageId);
      }
    });
  }

  /** Atomically replaces the live run with its newly committed transcript. */
  public settleCompletedRun(messages: readonly ChatMessage[]): Promise<void> {
    const completedTurnId = this.snapshot?.turnId ?? null;
    this.snapshot = null;
    // A queued final frame stays queued: the render chain runs it before the
    // settle below, giving the streamed text its settled in-place render so
    // the turn already shows final content when history takes over.
    // Withdrawing it here would freeze the live text one flush short of its
    // last markdown delta — and the debounced task must then leave the DOM
    // alone rather than paint the empty pending placeholder over the still
    // mounted turn.
    return this.settleRun(messages, null, completedTurnId);
  }

  /**
   * Settles a failed or cancelled run against its reconciled transcript.
   * History becomes the durable copy of everything the run produced; the
   * live turn is then re-projected so it keeps only what history cannot
   * carry — the terminal error with its Retry affordance, or the Stopped
   * status — instead of repeating the committed content beneath it.
   */
  public settleUnfinishedRun(messages: readonly ChatMessage[]): Promise<void> {
    return this.settleRun(messages, this.snapshot);
  }

  private settleRun(
    messages: readonly ChatMessage[],
    retainedSnapshot: AgentConversationSnapshot | null,
    completedTurnId: string | null = null,
  ): Promise<void> {
    this.history = messages;
    if (!this.visible) return Promise.resolve();
    this.flushPendingSnapshotRender();
    const generation = this.lifecycleGeneration;
    return this.scheduleRender(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      const finishLayoutMutation = this.scroller.beginLayoutMutation();
      let renderedHistory = false;
      try {
        if (completedTurnId) {
          await this.renderer.settleHistory(messages, completedTurnId);
        } else {
          await this.renderer.renderHistory(messages);
        }
        if (!this.isLifecycleCurrent(generation)) return;
        renderedHistory = true;
        this.historyKeys = contentKeys(messages);
      } catch (error) {
        if (!this.isLifecycleCurrent(generation)) return;
        this.renderer.showCompletedRenderFallback();
        throw error;
      } finally {
        if (this.isLifecycleCurrent(generation)) {
          if (renderedHistory) {
            if (retainedSnapshot) {
              // Re-projecting after the history render lets the renderer
              // drop every live part the transcript now shows. A failed
              // re-projection keeps the previous live frame, which is never
              // worse than replacing settled content with a fallback.
              await this.renderer.renderActive(
                retainedSnapshot,
                presentAgentConversation(retainedSnapshot, false),
              ).catch(() => undefined);
            } else if (!completedTurnId) {
              this.renderer.clearActive();
            }
          }
        }
        if (this.isLifecycleCurrent(generation)) {
          try {
            this.syncRows();
          } finally {
            finishLayoutMutation();
          }
          this.scroller.setStreaming(false);
          this.syncEmpty();
          this.followedTurnId = null;
          if (!retainedSnapshot) {
            for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
          }
        } else {
          finishLayoutMutation();
        }
      }
    });
  }

  public setAgentSnapshot(snapshot: AgentConversationSnapshot | null): Promise<void> {
    // Explicit projection resets begin a new chat or admitted turn (including
    // automatic queue promotion). Ordinary settlement keeps denial steering.
    if (!snapshot) this.composer.clearSteeringPlaceholder();
    const currentTurnId = this.runPending
      ? this.pendingTurnId ?? this.snapshot?.turnId ?? null
      : this.snapshot?.turnId ?? null;
    if (snapshot?.turnId && snapshot.turnId !== currentTurnId) {
      this.resetIncidentRenderingMetrics();
    }
    this.snapshot = snapshot;
    if (this.unloaded) return Promise.resolve();
    if (!this.visible) {
      this.notifyHiddenApproval();
      return Promise.resolve();
    }
    if (!snapshot && !this.runPending) {
      // Clearing to "no run" is authoritative and idempotent, so retire the
      // active turn immediately. The scheduled render can coalesce, delay, or
      // bail on a superseded generation, which would otherwise strand the
      // previous conversation's pending turn in an empty chat.
      const finishLayoutMutation = this.scroller.beginLayoutMutation();
      try {
        this.renderer.clearActive();
        this.syncRows();
      } finally {
        finishLayoutMutation();
      }
    }
    this.pendingSnapshotRender = snapshot;
    const completion = new Promise<void>((resolve, reject) => {
      this.snapshotRenderWaiters.push({ resolve, reject });
    });
    this.ensureSnapshotRender();
    return completion;
  }

  public setRunPending(
    pending: boolean,
    turnId?: string,
    options: Readonly<{ anchorSubmittedPrompt?: boolean }> = {},
  ): void {
    const currentTurnId = this.runPending
      ? this.pendingTurnId ?? this.snapshot?.turnId ?? null
      : this.snapshot?.turnId ?? null;
    if (
      pending
      && (turnId ? turnId !== currentTurnId : !this.runPending)
    ) {
      this.resetIncidentRenderingMetrics();
    }
    if (pending && turnId) {
      this.submittedPromptTurnId = options.anchorSubmittedPrompt === true
        ? turnId
        : this.submittedPromptTurnId === turnId
          ? this.submittedPromptTurnId
          : null;
    }
    this.runPending = pending;
    this.pendingTurnId = pending ? turnId ?? this.pendingTurnId : null;
    if (!this.visible) return;
    this.composer.setRunning(presentAgentConversation(this.snapshot, pending).composerRunning);
    this.syncEmpty();
    if (!this.snapshot) {
      this.pendingSnapshotRender = null;
      this.ensureSnapshotRender();
    }
  }

  public focus(): void {
    this.composer.focus();
  }

  public getInputText(): string {
    return this.composer.getValue();
  }

  public setInputText(value: string, options?: Readonly<{ focus?: boolean }>): void {
    this.composer.setValue(value, options);
  }

  private syncRows(): void {
    const discovered = new Map<string, Readonly<{
      priority: number;
      row: HTMLElement;
    }>>();
    const rows = this.renderer.element.querySelectorAll<HTMLElement>(
      ".systemsculpt-agent-turn",
    );
    for (const row of Array.from(rows)) {
      const responseTurnId = row.classList.contains("is-assistant")
        ? row.dataset.turnId?.trim()
        : undefined;
      const activeResponse = Boolean(
        responseTurnId && row.closest(".systemsculpt-agent-active-run"),
      );
      if (activeResponse) row.dataset.messageId = responseTurnId;
      const messageId = row.dataset.messageId?.trim();
      const id = responseTurnId
        ? `response:${responseTurnId}`
        : messageId
          ? `message:${messageId}`
          : null;
      if (!id) continue;
      const priority = activeResponse ? 2 : responseTurnId ? 1 : 0;
      const existingCandidate = discovered.get(id);
      if (!existingCandidate || priority > existingCandidate.priority) {
        discovered.set(id, { priority, row });
      }
    }
    this.scroller.batchRowChanges(() => {
      for (const [id, { row }] of discovered) {
        const registered = this.registeredRows.get(id);
        if (registered !== row) {
          if (registered) this.scroller.unregisterRow(id);
          this.scroller.registerRow(id, row);
          this.registeredRows.set(id, row);
        }
      }
      for (const id of this.registeredRows.keys()) {
        if (!discovered.has(id)) {
          this.scroller.unregisterRow(id);
          this.registeredRows.delete(id);
        }
      }
    });
    const activeResponse = this.renderer.activeResponseElement;
    const activeTurnId = activeResponse?.dataset.turnId?.trim();
    this.registeredActiveResponse = activeResponse && activeTurnId
      ? { turnId: activeTurnId, row: activeResponse }
      : null;
  }

  private syncActiveResponseRow(): void {
    const activeResponse = this.renderer.activeResponseElement;
    const turnId = activeResponse?.dataset.turnId?.trim();
    if (!activeResponse || !turnId) {
      if (this.registeredActiveResponse) this.syncRows();
      return;
    }
    if (
      this.registeredActiveResponse?.turnId === turnId
      && this.registeredActiveResponse.row === activeResponse
      && this.registeredRows.get(`response:${turnId}`) === activeResponse
    ) {
      return;
    }
    this.syncRows();
  }

  private readonly handleDisclosureActivation = (event: Event): void => {
    if (event.defaultPrevented || this.unloaded) return;
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (key !== "Enter") return;
    } else if (event.type === "keyup") {
      if ((event as KeyboardEvent).key !== " ") return;
    } else if (event.type === "click" && (event as MouseEvent).button !== 0) {
      return;
    }
    const target = event.target as (Element & {
      closest?: (selectors: string) => Element | null;
    }) | null;
    if (typeof target?.closest !== "function") return;
    const summary = target.closest("summary");
    if (!summary || !this.renderer.element.contains(summary)) return;
    if (event.type === "keydown" && target !== summary) return;
    const nestedControl = target.closest(
      "a[href], button, input, select, textarea, [contenteditable='true'], [role='button']",
    );
    if (nestedControl && nestedControl !== summary) return;
    const details = summary.parentElement as HTMLDetailsElement | null;
    if (details?.tagName !== "DETAILS") return;
    this.beginDisclosureLayoutMutation(summary);
  };

  private beginDisclosureLayoutMutation(control: HTMLElement): void {
    if (this.pendingDisclosureLayoutMutation) return;
    const finishLayoutMutation = this.scroller.beginDisclosureLayoutMutation(control);
    let frame: number | null = null;
    let finished = false;
    const complete = (): void => {
      if (finished) return;
      finished = true;
      frame = null;
      this.pendingDisclosureLayoutMutation = null;
      finishLayoutMutation();
    };
    const cancel = (): void => {
      if (finished) return;
      finished = true;
      if (frame !== null) {
        cancelSurfaceAnimationFrame(this.renderer.element, frame);
        frame = null;
      }
      this.pendingDisclosureLayoutMutation = null;
    };
    this.pendingDisclosureLayoutMutation = { cancel };
    frame = requestSurfaceAnimationFrame(this.renderer.element, complete);
  }

  private syncEmpty(): void {
    const presentation = presentAgentConversation(this.snapshot, this.runPending);
    const hasActivePresentation = presentation.phase !== "idle";
    this.emptyState.element.toggleAttribute(
      "hidden",
      this.element.classList.contains("is-loading-chat") || this.history.length > 0 || hasActivePresentation,
    );
  }

  private scheduleRender(task: () => Promise<void>): Promise<void> {
    const metricsGeneration = this.incidentMetricsGeneration;
    this.incidentQueuedRenderCount = boundedIncidentRenderCount(
      this.incidentQueuedRenderCount + 1,
    );
    const measuredTask = async (): Promise<void> => {
      const measure = metricsGeneration === this.incidentMetricsGeneration;
      if (measure) {
        this.incidentQueuedRenderCount = Math.max(
          0,
          this.incidentQueuedRenderCount - 1,
        );
        this.incidentActiveRenderCount = boundedIncidentRenderCount(
          this.incidentActiveRenderCount + 1,
        );
        this.incidentRenderPassCount = boundedIncidentRenderCount(
          this.incidentRenderPassCount + 1,
        );
      }
      const startedAt = this.incidentMonotonicNow();
      try {
        await task();
      } finally {
        if (measure && metricsGeneration === this.incidentMetricsGeneration) {
          this.incidentActiveRenderCount = Math.max(
            0,
            this.incidentActiveRenderCount - 1,
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
    };
    this.rendering = this.rendering.then(measuredTask, measuredTask);
    return this.rendering;
  }

  private resetIncidentRenderingMetrics(): void {
    this.incidentMetricsGeneration += 1;
    this.incidentRenderPassCount = 0;
    this.incidentQueuedRenderCount = 0;
    this.incidentActiveRenderCount = 0;
    this.incidentLastRenderDurationMs = 0;
    this.incidentMaxRenderDurationMs = 0;
    this.incidentFirstDomCommitObserved = false;
    this.incidentFirstPaintOpportunityObserved = false;
    this.incidentFailureSurfaceTurnId = null;
    this.incidentFailureSurfaceDomCommitted = false;
    this.incidentFailureSurfacePaintOpportunityObserved = false;
    this.renderer.resetIncidentRenderMetrics();
  }

  private incidentMonotonicNow(): number {
    try {
      const value = this.element.ownerDocument.defaultView?.performance?.now?.();
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

  private ensureSnapshotRender(): void {
    if (
      this.unloaded
      || !this.visible
      || this.snapshotRenderFrame !== null
      || this.snapshotRenderTaskCount > 0
      || typeof this.pendingSnapshotRender === "undefined"
    ) {
      return;
    }
    const generation = this.lifecycleGeneration;
    this.snapshotRenderWindow = getSurfaceOwnerWindow(this.element);
    this.snapshotRenderFrame = requestSurfaceAnimationFrame(this.element, () => {
      this.snapshotRenderFrame = null;
      this.snapshotRenderWindow = null;
      if (!this.isLifecycleCurrent(generation)) return;
      this.queuePendingSnapshotRender(generation);
    });
  }

  private queuePendingSnapshotRender(generation: number): void {
    if (!this.isLifecycleCurrent(generation)) return;
    const snapshot = this.pendingSnapshotRender;
    if (typeof snapshot === "undefined") return;
    this.pendingSnapshotRender = undefined;
    this.snapshotRenderTaskCount += 1;
    const renderWaiters = this.snapshotRenderWaiters.splice(0);
    for (const waiter of renderWaiters) this.activeSnapshotRenderWaiters.add(waiter);
    const rendering = this.scheduleRender(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      const presentation = presentAgentConversation(snapshot, this.runPending);
      this.composer.setRunning(presentation.composerRunning);
      this.syncEmpty();
      const finishLayoutMutation = this.scroller.beginLayoutMutation(this.renderer.activeRoot);
      try {
        if (this.historyNeedsRender) {
          try {
            await this.renderer.renderHistory(this.history);
          } catch (error) {
            if (this.isLifecycleCurrent(generation)) this.renderer.showCompletedRenderFallback();
            throw error;
          }
          if (!this.isLifecycleCurrent(generation)) return;
          this.historyNeedsRender = false;
          this.historyKeys = contentKeys(this.history);
          this.syncRows();
        }
        if (snapshot) {
          await this.renderer.renderActive(snapshot, presentation);
          if (
            snapshot.status === "failed"
            && snapshot.turnId
            && this.renderer.hasCommittedFailureSurface(snapshot.turnId)
          ) {
            this.incidentFailureSurfaceTurnId = snapshot.turnId;
            this.incidentFailureSurfaceDomCommitted = true;
            this.incidentFirstDomCommitObserved = true;
          }
        } else if (presentation.busy) {
          await this.renderer.renderActive({
            ...PENDING_AGENT_SNAPSHOT,
            turnId: this.pendingTurnId,
          }, presentation);
        } else {
          this.renderer.clearActive();
        }
      } finally {
        try {
          if (this.isLifecycleCurrent(generation)) this.syncActiveResponseRow();
        } finally {
          finishLayoutMutation();
        }
      }
      if (!this.isLifecycleCurrent(generation)) return;
      this.followActiveTurn(snapshot);
      this.scroller.setStreaming(presentation.busy);
    });
    void rendering.then(
      () => {
        for (const waiter of renderWaiters) waiter.resolve();
      },
      (error) => {
        for (const waiter of renderWaiters) waiter.reject(error);
      },
    ).finally(() => {
      for (const waiter of renderWaiters) this.activeSnapshotRenderWaiters.delete(waiter);
      this.snapshotRenderTaskCount = Math.max(0, this.snapshotRenderTaskCount - 1);
      if (!this.unloaded && typeof this.pendingSnapshotRender !== "undefined") {
        this.ensureSnapshotRender();
      }
    });
  }

  private cancelSnapshotRenderFrame(): void {
    if (this.snapshotRenderFrame === null) return;
    cancelSurfaceAnimationFrame(this.snapshotRenderWindow?.document ?? this.element, this.snapshotRenderFrame);
    this.snapshotRenderFrame = null;
    this.snapshotRenderWindow = null;
  }

  private flushPendingSnapshotRender(): void {
    this.cancelSnapshotRenderFrame();
    if (typeof this.pendingSnapshotRender !== "undefined") {
      this.queuePendingSnapshotRender(this.lifecycleGeneration);
    }
  }

  private followActiveTurn(snapshot: AgentConversationSnapshot | null = this.snapshot): void {
    const turnId = snapshot?.turnId ?? (this.runPending ? this.pendingTurnId : null);
    if (!turnId) {
      this.followedTurnId = null;
      return;
    }
    if (this.followedTurnId === turnId) return;
    const durableUserRow = this.registeredRows.get(`message:${turnId}`);
    if (!durableUserRow?.classList.contains("is-user")) return;
    const rowId = `response:${turnId}`;
    if (!this.registeredRows.has(rowId)) return;
    if (this.submittedPromptTurnId === turnId) {
      this.scroller.notifyTurnStarted({
        submittedPromptRowId: `message:${turnId}`,
        submittedPromptOffset: 16,
      });
    } else {
      this.scroller.notifyTurnStarted();
    }
    this.followedTurnId = turnId;
  }

  public isRenderingVisible(): boolean {
    return this.visible && !this.unloaded;
  }

  private notifyHiddenApproval(): void {
    const approval = this.snapshot?.parts.find((part): part is AgentToolPart =>
      part.kind === "tool" && part.state === "approval-required" && Boolean(part.approvalId)
      && (part.location === "vault" || Boolean(part.native)));
    if (approval) this.options.onHiddenApproval?.(approval);
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible || this.unloaded) return;
    this.visible = visible;
    this.lifecycleGeneration += 1;
    this.renderer.setVisible(visible);
    if (!visible) {
      if (this.announceTimer !== null) this.announceTimerWindow?.clearTimeout(this.announceTimer);
      this.announceTimer = null;
      this.announceTimerWindow = null;
      this.pendingAnnouncements = [];
      this.scroller.setStreaming(false);
      this.cancelSnapshotRenderFrame();
      this.pendingSnapshotRender = undefined;
      // Rendering must never hold up transcript commits or queued turns.
      for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
      for (const waiter of this.activeSnapshotRenderWaiters) waiter.resolve();
      this.notifyHiddenApproval();
      return;
    }
    this.setLoading(this.loading);
    if (this.deferredChrome) this.setChrome(this.deferredChrome);
    if (this.deferredQueue) this.setQueue(this.deferredQueue);
    this.deferredChrome = null;
    this.deferredQueue = null;
    this.composer.setPromptHistory(this.history);
    // Reconcile history and the latest snapshot together; a failed history
    // render must keep the completion fallback instead of clearing the live row.
    this.historyNeedsRender = true;
    this.pendingSnapshotRender = this.snapshot;
    this.ensureSnapshotRender();
  }

  public override onload(): void {
    this.register(bindSurfaceActivity(this.element));
    this.unloaded = false;
    this.lifecycleGeneration += 1;
    const detachMigration = this.element.onWindowMigrated?.(() => {
      if (this.snapshotRenderFrame !== null) {
        this.cancelSnapshotRenderFrame();
        this.ensureSnapshotRender();
      }
    });
    if (detachMigration) this.register(detachMigration);
    this.register(observeLeafVisibility(
      this.options.visibilityRoot ?? this.element.parentElement!,
      this.options.app.workspace,
      visible => this.setVisible(visible),
    ));
  }

  public override onunload(): void {
    this.moreMenu?.hide();
    this.moreMenu = null;
    this.pendingDisclosureLayoutMutation?.cancel();
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    this.cancelSnapshotRenderFrame();
    this.pendingSnapshotRender = undefined;
    for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
    for (const waiter of this.activeSnapshotRenderWaiters) waiter.resolve();
    this.activeSnapshotRenderWaiters.clear();
  }

  private isLifecycleCurrent(generation: number): boolean {
    return this.isRenderingVisible() && generation === this.lifecycleGeneration;
  }
}
