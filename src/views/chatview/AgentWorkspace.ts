import { App, Component, setIcon } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  getSurfaceOwnerWindow,
  updateUiAction,
} from "../../core/ui/surface";
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

function iconButton(parent: HTMLElement, label: string, icon: string): HTMLButtonElement {
  const element = createUiAction(parent, {
    label,
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
  messages: Object.freeze([]),
  parts: Object.freeze([]),
});

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
  private snapshotRenderPromise: Promise<void> | null = null;
  private snapshotRenderWaiters: Array<Readonly<{ resolve: () => void; reject: (error: unknown) => void }>> = [];
  private activeSnapshotRenderWaiters: Array<Readonly<{ resolve: () => void; reject: (error: unknown) => void }>> = [];
  private snapshotRenderTimer: number | null = null;
  private resolveSnapshotRenderDelay: (() => void) | null = null;
  private followedTurnId: string | null = null;
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
          size: "small",
        })
      : null;
    if (this.creditsButton) {
      this.creditsButton.addClass("systemsculpt-agent-credits");
      this.creditsButton.setAttribute("aria-label", "Credits");
      this.registerDomEvent(this.creditsButton, "click", () => void this.options.onOpenCredits?.());
    }
    const history = iconButton(headerActions, "Chat history", "history");
    const create = iconButton(headerActions, "New chat", "square-pen");
    const settings = iconButton(headerActions, "Chat settings", "settings-2");
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
      this.creditsButton.classList.remove("is-low");
      return;
    }
    if (balance.usageClass === "master_auth") {
      this.creditsButton.classList.remove("is-low");
      updateUiAction(this.creditsButton, {
        label: "Internal QA",
        title: "Internal testing mode",
      });
      this.creditsButton.setAttribute("aria-label", "Internal testing mode");
      return;
    }
    const label = formatCredits(balance.totalRemaining);
    this.creditsButton.classList.toggle("is-low", balance.totalRemaining <= 1000);
    updateUiAction(this.creditsButton, {
      label,
      title: `Credits: ${label}`,
    });
    this.creditsButton.setAttribute("aria-label", `Credits: ${label}`);
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
          const runNow = iconButton(row, "Stop and send queued follow-up now", "arrow-up");
          runNow.dataset.queueAction = "run-now";
          runNow.onclick = () => {
            const currentId = row?.dataset.queueItemId;
            if (currentId) void this.options.onRunQueuedNow?.(currentId);
          };
        }
        if (this.options.onCancelQueued) {
          const remove = iconButton(row, "Remove queued follow-up", "x");
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
      const anchor = this.scroller.capturePrependAnchor();
      await this.renderer.renderHistory(this.history);
      if (!this.isLifecycleCurrent(generation)) return;
      this.syncRows();
      this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
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
    this.history = messages;
    this.snapshot = null;
    this.pendingSnapshotRender = undefined;
    const generation = this.lifecycleGeneration;
    return this.scheduleRender(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      const anchor = this.scroller.capturePrependAnchor();
      let renderedHistory = false;
      try {
        await this.renderer.renderHistory(messages);
        if (!this.isLifecycleCurrent(generation)) return;
        renderedHistory = true;
        this.historyFingerprint = JSON.stringify(messages);
      } catch (error) {
        if (!this.isLifecycleCurrent(generation)) return;
        this.renderer.showCompletedRenderFallback();
        throw error;
      } finally {
        if (this.isLifecycleCurrent(generation)) {
          if (renderedHistory) this.renderer.clearActive();
          this.syncRows();
          this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
          this.scroller.notifyContentChanged({ streaming: false });
          this.syncEmpty();
          this.followedTurnId = null;
          for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
        }
      }
    });
  }

  public setAgentSnapshot(snapshot: AgentConversationSnapshot | null): Promise<void> {
    this.snapshot = snapshot;
    if (this.unloaded) return Promise.resolve();
    this.pendingSnapshotRender = snapshot;
    const completion = new Promise<void>((resolve, reject) => {
      this.snapshotRenderWaiters.push({ resolve, reject });
    });
    this.ensureSnapshotRender();
    return completion;
  }

  public setRunPending(pending: boolean, turnId?: string): void {
    this.runPending = pending;
    this.pendingTurnId = pending ? turnId ?? this.pendingTurnId : null;
    this.composer.setRunning(presentAgentConversation(this.snapshot, pending).composerRunning);
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
    const discovered = new Set<string>();
    const rows = this.renderer.element.querySelectorAll<HTMLElement>(".systemsculpt-agent-turn[data-message-id]");
    for (const row of Array.from(rows)) {
      const messageId = row.dataset.messageId?.trim();
      if (!messageId) continue;
      const id = `message:${messageId}`;
      discovered.add(id);
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
    if (this.unloaded || this.snapshotRenderPromise) return;
    const generation = this.lifecycleGeneration;
    let renderWaiters: Array<Readonly<{ resolve: () => void; reject: (error: unknown) => void }>> = [];
    this.snapshotRenderPromise = this.scheduleRender(async () => {
      if (!this.isLifecycleCurrent(generation)) return;
      await new Promise<void>((resolve) => {
        const finishDelay = (): void => {
          this.snapshotRenderTimer = null;
          this.resolveSnapshotRenderDelay = null;
          resolve();
        };
        this.resolveSnapshotRenderDelay = finishDelay;
        this.snapshotRenderTimer = getSurfaceOwnerWindow(this.element)
          .setTimeout(finishDelay, 32);
      });
      if (!this.isLifecycleCurrent(generation)) return;
      renderWaiters = this.snapshotRenderWaiters.splice(0);
      this.activeSnapshotRenderWaiters = renderWaiters;
      const snapshot = this.pendingSnapshotRender;
      this.pendingSnapshotRender = undefined;
      const presentation = presentAgentConversation(snapshot ?? null, this.runPending);
      // Terminal protocol truth must update controls even if rendering the
      // final Markdown frame or a postprocessor later fails.
      this.composer.setRunning(presentation.composerRunning);
      this.syncEmpty();
      if (snapshot) {
        await this.renderer.renderActive(snapshot, presentation);
        if (!this.isLifecycleCurrent(generation)) return;
      } else if (presentation.busy) {
        await this.renderer.renderActive({
          ...PENDING_AGENT_SNAPSHOT,
          turnId: this.pendingTurnId,
        }, presentation);
        if (!this.isLifecycleCurrent(generation)) return;
      } else {
        this.renderer.clearActive();
      }
      if (!this.isLifecycleCurrent(generation)) return;
      this.followActiveTurn(snapshot ?? null);
      this.scroller.notifyContentChanged({ streaming: presentation.busy });
    });
    void this.snapshotRenderPromise.then(
      () => {
        for (const waiter of renderWaiters) waiter.resolve();
      },
      (error) => {
        for (const waiter of renderWaiters) waiter.reject(error);
      },
    ).finally(() => {
      if (this.activeSnapshotRenderWaiters === renderWaiters) {
        this.activeSnapshotRenderWaiters = [];
      }
      this.snapshotRenderPromise = null;
      if (!this.unloaded && typeof this.pendingSnapshotRender !== "undefined") {
        this.ensureSnapshotRender();
      }
    });
  }

  private followActiveTurn(snapshot: AgentConversationSnapshot | null = this.snapshot): void {
    const turnId = snapshot?.turnId ?? (this.runPending ? this.pendingTurnId : null);
    if (!turnId) {
      this.followedTurnId = null;
      return;
    }
    if (this.followedTurnId === turnId) return;
    const rowId = `message:${turnId}`;
    if (!this.registeredRows.has(rowId)) return;
    this.scroller.notifyTurnStarted();
    this.followedTurnId = turnId;
  }

  public override onload(): void {
    this.unloaded = false;
    this.lifecycleGeneration += 1;
  }

  public override onunload(): void {
    this.unloaded = true;
    this.lifecycleGeneration += 1;
    if (this.snapshotRenderTimer !== null) {
      getSurfaceOwnerWindow(this.element).clearTimeout(this.snapshotRenderTimer);
      this.snapshotRenderTimer = null;
    }
    const resolveDelay = this.resolveSnapshotRenderDelay;
    this.resolveSnapshotRenderDelay = null;
    resolveDelay?.();
    this.pendingSnapshotRender = undefined;
    for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
    for (const waiter of this.activeSnapshotRenderWaiters.splice(0)) waiter.resolve();
  }

  private isLifecycleCurrent(generation: number): boolean {
    return !this.unloaded && generation === this.lifecycleGeneration;
  }
}
