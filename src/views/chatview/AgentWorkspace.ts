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
import type { ManagedChatInputLimits } from "../../services/managed/ManagedChatInputLimits";
import type { AgentArtifact, AgentConversationSnapshot } from "./AgentConversation";
import { AgentConversationRenderer } from "./AgentConversationRenderer";

export type AgentQueuedFollowUp = Readonly<{
  id: string;
  text: string;
  webSearch: boolean;
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
  attachmentLimits?: ManagedChatInputLimits;
  onMic?: () => void | Promise<void>;
  onRemoveAttachment: (attachment: AgentComposerAttachment) => void | Promise<void>;
  onApprove: (approvalId: string, approved: boolean, rememberForChat?: boolean) => void | Promise<void>;
  onOpenArtifact: (artifact: AgentArtifact) => void | Promise<void>;
  onCopyArtifactPath: (artifact: AgentArtifact) => void | Promise<void>;
  onRetryMessage?: (messageId: string) => void | Promise<void>;
  onCopyText?: (text: string) => void | Promise<void>;
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
  });
  element.addClass("systemsculpt-agent-icon-button");
  return element;
}

let workspaceLabelSequence = 0;

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
  private readonly registeredRows = new Set<string>();
  private history: readonly ChatMessage[] = [];
  private snapshot: AgentConversationSnapshot | null = null;
  private runPending = false;
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
          label: "—",
          size: "small",
          title: "Credits",
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
      onCopyText: options.onCopyText,
    });
    this.addChild(this.renderer);

    this.jumpButton = createUiAction(this.element, {
      label: "Latest",
      icon: "arrow-down",
      title: "Jump to latest",
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

  public setMessageAttachmentLimits(limits: ManagedChatInputLimits): void {
    this.composer.setMessageAttachmentLimits(limits);
  }

  public restoreMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.composer.restoreMessageAttachments(attachments);
  }

  public restoreRejectedSubmission(submission: Pick<AgentComposerSubmit, "text" | "attachments">): void {
    this.composer.restoreRejectedSubmission(submission);
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
    for (const item of queue) {
      const row = this.queueElement.createDiv({
        cls: "systemsculpt-agent-queue-item",
        attr: { role: "listitem" },
      });
      const icon = row.createSpan();
      setIcon(icon, "list-end");
      const attachmentLabel = item.attachments?.map((attachment) => attachment.name).join(", ") || "";
      row.createSpan({ text: item.text || attachmentLabel || "Queued attachment" });
      if (this.options.onRunQueuedNow) {
        const runNow = iconButton(row, "Stop and send now", "arrow-up");
        runNow.onclick = () => void this.options.onRunQueuedNow?.(item.id);
      }
      if (this.options.onCancelQueued) {
        const remove = iconButton(row, "Remove queued follow-up", "x");
        remove.onclick = () => void this.options.onCancelQueued?.(item.id);
      }
    }
  }

  public setHistory(messages: readonly ChatMessage[]): Promise<void> {
    this.history = messages;
    return this.scheduleRender(async () => {
      const anchor = this.scroller.capturePrependAnchor();
      for (const id of this.registeredRows) this.scroller.unregisterRow(id);
      this.registeredRows.clear();
      await this.renderer.renderHistory(messages);
      this.syncRows();
      this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
      this.syncEmpty();
    });
  }

  /** Atomically replaces the live run with its newly committed transcript. */
  public settleCompletedRun(messages: readonly ChatMessage[]): Promise<void> {
    this.history = messages;
    this.snapshot = null;
    return this.scheduleRender(async () => {
      const anchor = this.scroller.capturePrependAnchor();
      for (const id of this.registeredRows) this.scroller.unregisterRow(id);
      this.registeredRows.clear();
      await this.renderer.renderHistory(messages);
      this.renderer.clearActive();
      this.syncRows();
      this.scroller.restorePrependAnchor(anchor && this.registeredRows.has(anchor.rowId) ? anchor : null);
      this.scroller.notifyContentChanged({ streaming: false });
      this.syncEmpty();
      this.renderedTurnId = null;
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

  public setRunPending(pending: boolean): void {
    this.runPending = pending;
    const running = pending || this.snapshot?.status === "running" || this.snapshot?.status === "waiting";
    this.composer.setRunning(running);
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

  public setWebSearchEnabled(enabled: boolean): void {
    this.composer.setWebSearchEnabled(enabled);
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
      if (!this.registeredRows.has(id)) {
        this.scroller.registerRow(id, row, { turnAnchor: row.classList.contains("is-user") });
        this.registeredRows.add(id);
      }
    }
    for (const id of this.registeredRows) {
      if (!discovered.has(id)) {
        this.scroller.unregisterRow(id);
        this.registeredRows.delete(id);
      }
    }
  }

  private syncEmpty(): void {
    const hasActiveParts = (this.snapshot?.parts.length ?? 0) > 0;
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
      if (snapshot) await this.renderer.renderActive(snapshot);
      else this.renderer.clearActive();
      const running = this.runPending || snapshot?.status === "running" || snapshot?.status === "waiting";
      this.composer.setRunning(running);
      this.scroller.notifyContentChanged({ streaming: running });
      this.syncEmpty();
      if (snapshot?.turnId && this.renderedTurnId !== snapshot.turnId) {
        const rowId = `message:${snapshot.turnId}`;
        if (this.registeredRows.has(rowId)) this.scroller.notifyTurnStarted(rowId);
      }
      this.renderedTurnId = snapshot?.turnId ?? null;
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
}
