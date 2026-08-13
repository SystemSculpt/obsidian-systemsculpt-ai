import { App, Component, setIcon } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  updateUiAction,
} from "../../core/ui/surface";
import {
  cancelSurfaceAnimationFrame,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";
import type { ChatMessage } from "../../types";
import { AnchoredScroller } from "./AnchoredScroller";
import {
  AgentComposer,
  type AgentComposerAttachment,
  type AgentComposerSubmit,
} from "./AgentComposer";
import type { ChatMessageAttachment } from "./attachments/ChatMessageAttachments";
import type { ChatDocumentAttachmentProcessor } from "./attachments/ChatMessageAttachments";
import type { ThinAgentInputLimits } from "../../services/managed/ThinAgentInputLimits";
import type { CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import type { AgentArtifact, AgentConversationSnapshot } from "./AgentConversation";
import { presentAgentConversation } from "./AgentConversationPresentation";
import {
  AgentConversationRenderer,
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
  sourcePath: () => string;
  reducedMotion?: () => boolean;
  onSubmit: (submission: AgentComposerSubmit) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onAttach: () => void | Promise<void>;
  onVaultContextDrop?: (path: string) => void | Promise<void>;
  documentAttachmentProcessor?: ChatDocumentAttachmentProcessor;
  attachmentLimits?: ThinAgentInputLimits;
  onMic?: () => void | Promise<void>;
  onRemoveAttachment: (attachment: AgentComposerAttachment) => void | Promise<void>;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => boolean | Promise<boolean>;
  onRetryFailedTurn?: (messageId: string) => void | Promise<void>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onResubmitMessage?: (messageId: string, text: string) => boolean | Promise<boolean>;
  onCancelMessageEdit?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => boolean | Promise<boolean>;
  onNewChat: () => void | Promise<void>;
  onOpenHistory: () => void | Promise<void>;
  onOpenSettings: () => void | Promise<void>;
  onOpenCredits?: () => void | Promise<void>;
  onCancelQueued?: (id: string) => void | Promise<void>;
  onRunQueuedNow?: (id: string) => void | Promise<void>;
  onApprovalModeChange?: (mode: "ask" | "full-access") => void;
}>;

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

function formatCredits(value: number): string {
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

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

/** Complete native shell for the managed agent experience inside Obsidian. */
export class AgentWorkspace extends Component {
  public readonly element: HTMLElement;
  public readonly viewport: HTMLElement;
  public readonly renderer: AgentConversationRenderer;
  public readonly composer: AgentComposer;
  private readonly titleElement: HTMLElement;
  private readonly creditsButton: HTMLButtonElement | null;
  private readonly emptyState: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly queueElement: HTMLElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly scroller: AnchoredScroller;
  private readonly registeredRows = new Map<string, HTMLElement>();
  private readonly queuedRows = new Map<string, HTMLElement>();
  private history: readonly ChatMessage[] = [];
  private historyFingerprint = "[]";
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
  private lifecycleGeneration = 0;

  constructor(parent: HTMLElement, private readonly options: AgentWorkspaceOptions) {
    super();
    this.element = parent.createDiv({ cls: "systemsculpt-agent-workspace" });
    applyPluginSurface(this.element, "view");
    this.element.classList.toggle("is-reduced-motion", options.reducedMotion?.() === true);

    const header = this.element.createDiv({ cls: "systemsculpt-agent-header" });
    const titleId = `systemsculpt-agent-title-${++workspaceLabelSequence}`;
    this.titleElement = header.createDiv({
      cls: "systemsculpt-agent-header-title",
      text: "New chat",
      attr: { id: titleId, role: "heading", "aria-level": "2" },
    });
    const headerActions = header.createDiv({ cls: "systemsculpt-agent-header-actions" });
    this.creditsButton = options.onOpenCredits
      ? createUiAction(headerActions, {
          label: "Credits",
          testId: "chat.header.credits",
          size: "small",
        })
      : null;
    if (this.creditsButton) {
      this.creditsButton.addClass("systemsculpt-agent-credits");
      this.creditsButton.setAttribute("aria-label", "Credits");
      this.registerDomEvent(this.creditsButton, "click", () => void this.options.onOpenCredits?.());
    }
    const history = iconButton(headerActions, "chat.header.history", "Chat history", "history");
    const create = iconButton(headerActions, "chat.header.new", "New chat", "square-pen");
    const settings = iconButton(headerActions, "chat.header.settings", "Chat settings", "settings-2");
    this.registerDomEvent(history, "click", () => void this.options.onOpenHistory());
    this.registerDomEvent(create, "click", () => void this.options.onNewChat());
    this.registerDomEvent(settings, "click", () => void this.options.onOpenSettings());

    this.banner = this.element.createDiv({
      cls: "systemsculpt-agent-banner",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    this.banner.toggleAttribute("hidden", true);

    this.viewport = this.element.createDiv({
      cls: "systemsculpt-agent-viewport",
      attr: { tabindex: "0" },
    });
    this.emptyState = this.viewport.createDiv({ cls: "systemsculpt-agent-empty" });
    this.emptyState.createEl("strong", { text: "What should we work on?" });
    this.emptyState.createDiv({ text: "Ask about your notes or give SystemSculpt a task." });

    this.renderer = new AgentConversationRenderer(this.viewport, {
      app: options.app,
      sourcePath: options.sourcePath,
      labelledBy: titleId,
      beginLayoutMutation: (disclosureControl, mutationTarget) => this.unloaded
        ? undefined
        : disclosureControl
          ? this.scroller.beginDisclosureLayoutMutation(disclosureControl)
          : this.scroller.beginLayoutMutation(mutationTarget),
      onApprove: options.onApprove,
      onOpenArtifact: options.onOpenArtifact,
      onCopyArtifactPath: options.onCopyArtifactPath,
      onRetryFailedTurn: options.onRetryFailedTurn,
      onRetryMessage: options.onRetryMessage,
      onResubmitMessage: options.onResubmitMessage,
      onCancelMessageEdit: options.onCancelMessageEdit,
      onCopyText: options.onCopyText,
    });
    this.addChild(this.renderer);

    this.jumpButton = createUiAction(this.element, {
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
        "aria-live": "polite",
      },
    });
    this.queueElement.toggleAttribute("hidden", true);

    this.composer = new AgentComposer(this.element, {
      onSubmit: options.onSubmit,
      onStop: options.onStop,
      onAttach: options.onAttach,
      onVaultContextDrop: options.onVaultContextDrop,
      documentAttachmentProcessor: options.documentAttachmentProcessor,
      attachmentLimits: options.attachmentLimits,
      onMic: options.onMic,
      onRemoveAttachment: options.onRemoveAttachment,
      onApprovalModeChange: options.onApprovalModeChange,
      onHeightChange: () => {
        if (!this.unloaded) this.scroller.notifyViewportGeometryChanged();
      },
    });
    this.addChild(this.composer);
  }

  public setTitle(title: string): void {
    const normalized = title.trim() || "New chat";
    this.titleElement.setText(normalized);
  }

  public setCreditsBalance(balance: CreditsBalanceSnapshot | null): void {
    if (!this.creditsButton) return;
    this.creditsButton.toggleAttribute("hidden", balance === null);
    this.creditsButton.classList.toggle(
      "is-internal-qa",
      balance?.usageClass === "master_auth",
    );
    if (balance === null) {
      this.creditsButton.classList.remove("is-low", "is-empty");
      updateUiAction(this.creditsButton, {
        label: "Credits",
        title: "Credits",
      });
      this.creditsButton.setAttribute("aria-label", "Credits");
      return;
    }
    if (balance.usageClass === "master_auth") {
      this.creditsButton.classList.remove("is-low", "is-empty");
      updateUiAction(this.creditsButton, {
        label: "Internal QA",
        title: "Internal testing mode",
      });
      this.creditsButton.setAttribute("aria-label", "Internal testing mode");
      return;
    }
    const available = balance.availableUnreserved ?? balance.totalRemaining;
    const held = balance.heldInFlight ?? 0;
    const label = formatCredits(available);
    const outOfCredits = balance.totalRemaining <= 0;
    const unavailable = !outOfCredits && available <= 0;
    this.creditsButton.classList.toggle("is-low", available <= 1000);
    this.creditsButton.classList.toggle("is-empty", outOfCredits);
    const availableTitle = held > 0
      ? `${label} credits available; ${formatCredits(held)} held in flight; ${formatCredits(balance.totalRemaining)} total.`
      : `Credits available: ${label}`;
    updateUiAction(this.creditsButton, {
      label: outOfCredits ? "Out of credits" : unavailable ? "0 available" : label,
      title: outOfCredits
        ? "You are out of credits. Add credits to continue."
        : unavailable
          ? `${availableTitle} Add credits or wait for in-flight work to settle.`
          : availableTitle,
    });
    this.creditsButton.setAttribute(
      "aria-label",
      outOfCredits
        ? "Out of credits. Add credits to continue."
        : unavailable
          ? "No credits are available. Add credits or wait for in-flight work to settle."
          : availableTitle,
    );
  }

  public setBanner(message: string | null, kind: "info" | "error" = "info"): void {
    this.banner.toggleAttribute("hidden", !message);
    this.banner.classList.toggle("is-error", kind === "error");
    this.banner.setAttribute("role", kind === "error" ? "alert" : "status");
    this.banner.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    this.banner.setText(message ?? "");
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
        });
        setIcon(icon, "list-end");
        row.createSpan({ cls: "systemsculpt-agent-queue-copy" });
        if (this.options.onRunQueuedNow) {
          const runNow = iconButton(row, "chat.queue.run-now", "Stop and send queued follow-up now", "arrow-up");
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
        updateUiAction(runNow, { label: `Stop and send ${target} now` });
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
    if (
      this.submittedPromptTurnId
      && !messages.some((message) =>
        message.role === "user" && message.message_id === this.submittedPromptTurnId)
    ) {
      this.submittedPromptTurnId = null;
      this.scroller.clearSubmittedPromptAnchor();
    }
    const fingerprint = JSON.stringify(messages);
    this.history = messages;
    if (fingerprint === this.historyFingerprint) return Promise.resolve();
    return this.renderHistoryPreservingAnchor().then(() => {
      this.historyFingerprint = fingerprint;
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
    this.flushPendingSnapshotRender();
    this.history = messages;
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
        this.historyFingerprint = JSON.stringify(messages);
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
    this.snapshot = snapshot;
    if (this.unloaded) return Promise.resolve();
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
    if (pending && turnId) {
      this.submittedPromptTurnId = options.anchorSubmittedPrompt === true
        ? turnId
        : this.submittedPromptTurnId === turnId
          ? this.submittedPromptTurnId
          : null;
    }
    this.runPending = pending;
    this.pendingTurnId = pending ? turnId ?? this.pendingTurnId : null;
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

  public setApprovalMode(mode: "ask" | "full-access"): void {
    this.composer.setApprovalMode(mode);
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
    const activeResponse = this.renderer.element.querySelector<HTMLElement>(
      ".systemsculpt-agent-active-run .systemsculpt-agent-turn.is-assistant[data-turn-id]",
    );
    const activeTurnId = activeResponse?.dataset.turnId?.trim();
    this.registeredActiveResponse = activeResponse && activeTurnId
      ? { turnId: activeTurnId, row: activeResponse }
      : null;
  }

  private syncActiveResponseRow(): void {
    const activeResponse = this.renderer.element.querySelector<HTMLElement>(
      ".systemsculpt-agent-active-run .systemsculpt-agent-turn.is-assistant[data-turn-id]",
    );
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
    const summary = target.closest("summary") as HTMLElement | null;
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
    this.emptyState.toggleAttribute(
      "hidden",
      this.history.length > 0 || hasActivePresentation,
    );
  }

  private scheduleRender(task: () => Promise<void>): Promise<void> {
    this.rendering = this.rendering.then(task, task);
    return this.rendering;
  }

  private ensureSnapshotRender(): void {
    if (
      this.unloaded
      || this.snapshotRenderFrame !== null
      || this.snapshotRenderTaskCount > 0
      || typeof this.pendingSnapshotRender === "undefined"
    ) {
      return;
    }
    const generation = this.lifecycleGeneration;
    this.snapshotRenderFrame = requestSurfaceAnimationFrame(this.element, () => {
      this.snapshotRenderFrame = null;
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
      const activeRun = this.renderer.element.querySelector<HTMLElement>(
        ":scope > .systemsculpt-agent-active-run",
      );
      const finishLayoutMutation = this.scroller.beginLayoutMutation(activeRun ?? undefined);
      try {
        if (snapshot) {
          await this.renderer.renderActive(snapshot, presentation);
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

  private flushPendingSnapshotRender(): void {
    if (this.snapshotRenderFrame !== null) {
      cancelSurfaceAnimationFrame(this.element, this.snapshotRenderFrame);
      this.snapshotRenderFrame = null;
    }
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
    const durableUserRow = Array.from(
      this.renderer.element.querySelectorAll<HTMLElement>(
        ".systemsculpt-agent-history .systemsculpt-agent-turn.is-user[data-message-id]",
      ),
    ).find((row) => row.dataset.messageId === turnId);
    if (!durableUserRow) return;
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

  public override onload(): void {
    this.unloaded = false;
    this.lifecycleGeneration += 1;
  }

  public override onunload(): void {
    this.pendingDisclosureLayoutMutation?.cancel();
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    if (this.snapshotRenderFrame !== null) {
      cancelSurfaceAnimationFrame(this.element, this.snapshotRenderFrame);
      this.snapshotRenderFrame = null;
    }
    this.pendingSnapshotRender = undefined;
    for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
    for (const waiter of this.activeSnapshotRenderWaiters) waiter.resolve();
    this.activeSnapshotRenderWaiters.clear();
  }

  private isLifecycleCurrent(generation: number): boolean {
    return !this.unloaded && generation === this.lifecycleGeneration;
  }
}
