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
  private history: readonly ChatMessage[] = [];
  private historyFingerprint = "[]";
  private snapshot: AgentConversationSnapshot | null = null;
  private runPending = false;
  private pendingTurnId: string | null = null;
  private rendering: Promise<void> = Promise.resolve();
  private pendingSnapshotRender: AgentConversationSnapshot | null | undefined;
  private snapshotRenderPromise: Promise<void> | null = null;
  private snapshotRenderWaiters: Array<Readonly<{ resolve: () => void; reject: (error: unknown) => void }>> = [];
  private renderedTurnId: string | null = null;

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
          tooltip: false,
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
    });
    this.addChild(this.composer);
  }

  public setTitle(title: string): void {
    const normalized = title.trim() || "New chat";
    this.titleElement.setText(normalized);
  }

  public setCredits(label: string | null, low = false): void {
    if (!this.creditsButton) return;
    this.creditsButton.toggleAttribute("hidden", label === null);
    this.creditsButton.classList.toggle("is-low", low);
    if (label !== null) {
      updateUiAction(this.creditsButton, {
        label,
        title: `Credits: ${label}`,
      });
      this.creditsButton.setAttribute("aria-label", `Credits: ${label}`);
    }
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
    this.queueElement.empty();
    this.queueElement.toggleAttribute("hidden", queue.length === 0);
    for (const [index, item] of queue.entries()) {
      const row = this.queueElement.createDiv({
        cls: "systemsculpt-agent-queue-item",
        attr: { role: "listitem" },
      });
      const icon = row.createSpan();
      setIcon(icon, "list-end");
      const attachmentLabel = item.attachments?.map((attachment) => attachment.name).join(", ") || "";
      row.createSpan({ text: item.text || attachmentLabel || "Queued attachment" });
      const target = `queued follow-up ${index + 1} of ${queue.length}`;
      if (this.options.onRunQueuedNow) {
        const runNow = iconButton(row, `Stop and send ${target} now`, "arrow-up");
        runNow.onclick = () => void this.options.onRunQueuedNow?.(item.id);
      }
      if (this.options.onCancelQueued) {
        const remove = iconButton(row, `Remove ${target}`, "x");
        remove.onclick = () => void this.options.onCancelQueued?.(item.id);
      }
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
    return this.scheduleRender(async () => {
      const anchor = this.scroller.capturePrependAnchor();
      await this.renderer.renderHistory(this.history);
      this.syncRows();
      this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
      this.anchorActiveTurn();
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
    return this.scheduleRender(async () => {
      const anchor = this.scroller.capturePrependAnchor();
      let renderedHistory = false;
      try {
        await this.renderer.renderHistory(messages);
        renderedHistory = true;
        this.historyFingerprint = JSON.stringify(messages);
      } catch (error) {
        this.renderer.showCompletedRenderFallback();
        throw error;
      } finally {
        if (renderedHistory) this.renderer.clearActive();
        this.syncRows();
        this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
        this.scroller.notifyContentChanged({ streaming: false });
        this.syncEmpty();
        this.renderedTurnId = null;
        for (const waiter of this.snapshotRenderWaiters.splice(0)) waiter.resolve();
      }
    });
  }

  public setAgentSnapshot(snapshot: AgentConversationSnapshot | null): Promise<void> {
    this.snapshot = snapshot;
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
        this.scroller.registerRow(id, row, { turnAnchor: row.classList.contains("is-user") });
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
    const hasActiveParts = this.runPending || (this.snapshot?.parts.length ?? 0) > 0;
    this.emptyState.toggleAttribute("hidden", this.history.length > 0 || hasActiveParts);
  }

  private scheduleRender(task: () => Promise<void>): Promise<void> {
    this.rendering = this.rendering.then(task, task);
    return this.rendering;
  }

  private ensureSnapshotRender(): void {
    if (this.snapshotRenderPromise) return;
    let renderWaiters: Array<Readonly<{ resolve: () => void; reject: (error: unknown) => void }>> = [];
    this.snapshotRenderPromise = this.scheduleRender(async () => {
      await new Promise<void>((resolve) => getSurfaceOwnerWindow(this.element).setTimeout(resolve, 32));
      renderWaiters = this.snapshotRenderWaiters.splice(0);
      const snapshot = this.pendingSnapshotRender;
      this.pendingSnapshotRender = undefined;
      const presentation = presentAgentConversation(snapshot ?? null, this.runPending);
      if (snapshot) await this.renderer.renderActive(snapshot, presentation);
      else if (presentation.busy) {
        await this.renderer.renderActive({
          ...PENDING_AGENT_SNAPSHOT,
          turnId: this.pendingTurnId,
        }, presentation);
      }
      else this.renderer.clearActive();
      this.composer.setRunning(presentation.composerRunning);
      this.anchorActiveTurn();
      this.scroller.notifyContentChanged({ streaming: presentation.busy });
      this.syncEmpty();
    });
    void this.snapshotRenderPromise.then(
      () => {
        for (const waiter of renderWaiters) waiter.resolve();
      },
      (error) => {
        for (const waiter of renderWaiters) waiter.reject(error);
      },
    ).finally(() => {
      this.snapshotRenderPromise = null;
      if (typeof this.pendingSnapshotRender !== "undefined") this.ensureSnapshotRender();
    });
  }

  private anchorActiveTurn(): void {
    const turnId = this.snapshot?.turnId;
    if (!turnId) {
      this.renderedTurnId = null;
      return;
    }
    if (this.renderedTurnId === turnId) return;
    const rowId = `message:${turnId}`;
    if (!this.registeredRows.has(rowId)) return;
    this.scroller.notifyTurnStarted(rowId);
    this.renderedTurnId = turnId;
  }
}
