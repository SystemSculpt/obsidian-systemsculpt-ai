import { Component, Menu, TFile, setIcon, type App } from "obsidian";
import {
  createUiAction,
  updateUiAction,
  type UiActionTone,
} from "../../core/ui/surface";
import {
  getSurfaceOwnerWindow,
  requestSurfaceAnimationFrame,
} from "../../core/ui/surface/SurfaceDomContext";
import { ContextSelectionModal } from "../../modals/ContextSelectionModal";
import { statusBarBottomOverlap } from "../../platform/desktopStatusBar";
import { isMobileLayout } from "../../platform/mobileLayout";
import type { ThinAgentInputLimits } from "../../services/managed/ThinAgentInputLimits";
import type { ChatMessage } from "../../types";
import {
  CHAT_ATTACHMENT_PICKER_ACCEPT,
  ChatMessageAttachmentCollection,
  restoreChatMessageDraft,
  type ChatAttachmentDisplay,
  type ChatDocumentAttachmentProcessor,
  type ChatMessageAttachment,
  type ChatAttachmentIngestionResult,
} from "./attachments/ChatMessageAttachments";
import { AgentComposerMentionPopover, type ComposerMentionTrigger } from "./AgentComposerMentions";
import { AgentComposerVault } from "./AgentComposerVault";
import { containsControlCharacters } from "../../utils/characterValidation";
import { parseChatApprovalMode, type ChatApprovalMode } from "./storage/ChatPersistenceTypes";

export type AgentComposerAttachment = Readonly<{
  id: string;
  label: string;
  path?: string;
  kind: "vault" | "file" | "image";
  previewUrl?: string;
}>;

export type AgentComposerSubmit = Readonly<{
  text: string;
  mode: "send" | "queue";
  attachments?: readonly ChatMessageAttachment[];
}>;

export type AgentComposerOptions = Readonly<{
  onSubmit: (submission: AgentComposerSubmit) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  /** Opens the picker that pins vault files for every message. */
  onAttach: () => void | Promise<void>;
  /** Pins one vault file for every message. */
  onVaultContextDrop?: (path: string) => void | Promise<void>;
  documentAttachmentProcessor?: ChatDocumentAttachmentProcessor;
  attachmentLimits?: ThinAgentInputLimits;
  onMic?: () => void | Promise<void>;
  onRemoveAttachment: (attachment: AgentComposerAttachment) => void | Promise<void>;
  onApprovalModeChange?: (mode: ChatApprovalMode) => void;
  onHeightChange?: () => void;
  /** The vault, for the active-note chip, `@` mentions, the vault picker, and opening chips. */
  app?: App;
  /** The chat note's path, so inserted links resolve the way Obsidian writes them. */
  sourcePath?: () => string;
  /** Announces a short status through the view's polite live region. */
  announce?: (message: string) => void;
}>;

const DEFAULT_AGENT_NAME = "SystemSculpt";
const READ_ONLY_PLACEHOLDER = "Start a new chat to continue.";
const RUNNING_PLACEHOLDER = "Queue a follow-up…";
const PINNED_FILES_DESCRIPTION =
  "Pinned files are reread for every message. Files SystemSculpt reads while working remain part of this chat, but are not pinned automatically.";
/** Spec: the message box grows to 40% of the view, and never caps below six lines. */
const INPUT_MAX_VIEW_FRACTION = 0.4;
const INPUT_MIN_MAX_LINES = 6;

function createButton(
  parent: HTMLElement,
  className: string,
  testId: string,
  label: string,
  icon: string,
  tone: UiActionTone = "default",
): HTMLButtonElement {
  const button = createUiAction(parent, {
    label,
    testId,
    icon,
    size: "icon",
    tone,
    // Obsidian shows the aria-label as the tooltip; a title would double it.
    tooltip: false,
  });
  className.split(/\s+/).filter(Boolean).forEach((name) => button.addClass(name));
  return button;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function pinnedVaultPath(attachment: AgentComposerAttachment): string {
  return (attachment.path || attachment.label).replace(/^\[\[(.*?)\]\]$/, "$1");
}

function isTextEntryTarget(target: Element): boolean {
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

/**
 * The agent workspace's message composer: one card with attachment chips, the
 * message box and its toolbar, plus a footer slot for the run line. It owns only
 * ephemeral input state; the conversation and run lifecycle stay outside.
 */
export class AgentComposer extends Component {
  public readonly element: HTMLElement;
  /** Mount point under the card for the chat's run line. */
  public readonly footerSlot: HTMLElement;
  private readonly card: HTMLElement;
  private readonly chipRow: HTMLElement;
  private readonly suggestionChip: HTMLButtonElement;
  private readonly attachmentList: HTMLElement;
  private readonly overflowChip: HTMLButtonElement;
  private readonly errorList: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly addButton: HTMLButtonElement;
  private readonly filePicker: HTMLInputElement;
  private readonly approvalMode: HTMLSelectElement;
  private readonly micButton: HTMLButtonElement | null;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly cancelAttachmentsButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly dropOverlay: HTMLElement;
  private readonly mentions: AgentComposerMentionPopover;
  private readonly vault: AgentComposerVault | null;
  private agentName = DEFAULT_AGENT_NAME;
  private steering = false;
  private running = false;
  private historyEditing = false;
  private readOnlyMessage: string | null = null;
  private submitting = false;
  private attachmentBusy = false;
  private attachmentBusyLabel = "";
  private attachmentGeneration = 0;
  private attachmentLimits: ThinAgentInputLimits | undefined;
  private pinnedAttachments: readonly AgentComposerAttachment[] = [];
  private messageAttachments: ChatMessageAttachmentCollection;
  /** Message attachments that came from the vault, by attachment id. */
  private readonly vaultAttachmentPaths = new Map<string, string>();
  private issues: readonly string[] = [];
  private chipsExpanded = false;
  private chipLayoutFrame: number | null = null;
  private promptHistory: readonly string[] = [];
  private recallIndex: number | null = null;
  private dragDepth = 0;
  private hostClearance = 0;
  private attachmentQueue: Promise<void> = Promise.resolve();

  constructor(private readonly parent: HTMLElement, private readonly options: AgentComposerOptions) {
    super();
    this.attachmentLimits = options.attachmentLimits;
    this.vault = options.app ? new AgentComposerVault(options.app, options.sourcePath) : null;
    this.messageAttachments = this.createMessageAttachmentCollection();
    this.element = parent.createDiv({
      cls: "systemsculpt-agent-composer",
      attr: { "data-testid": "chat.composer" },
    });

    this.card = this.element.createDiv({ cls: "systemsculpt-agent-prompt" });
    const chips = this.card.createDiv({ cls: "systemsculpt-agent-composer-chips" });
    this.chipRow = chips;
    this.suggestionChip = createUiAction(chips, {
      label: "",
      testId: "chat.composer.suggest-note",
      icon: "plus",
      size: "small",
      tooltip: false,
    });
    this.suggestionChip.addClass("systemsculpt-agent-attachment-suggestion");
    this.attachmentList = chips.createDiv({
      cls: "systemsculpt-agent-composer-attachments",
      attr: {
        role: "list",
        "aria-label": "Message attachments and pinned files",
        "aria-description": PINNED_FILES_DESCRIPTION,
      },
    });
    this.overflowChip = createUiAction(chips, {
      label: "",
      testId: "chat.composer.attachment.more",
      size: "small",
      tooltip: false,
    });
    this.overflowChip.addClass("systemsculpt-agent-attachment-overflow");
    this.errorList = this.card.createDiv({
      cls: "systemsculpt-agent-composer-errors",
      attr: { role: "alert" },
    });

    this.input = this.card.createEl("textarea", {
      cls: "systemsculpt-agent-prompt-input",
      attr: {
        "data-testid": "chat.composer.input",
        rows: "1",
        placeholder: this.placeholder(),
        "aria-label": `Message ${this.agentName}`,
      },
    });

    const toolbar = this.card.createDiv({ cls: "systemsculpt-agent-prompt-toolbar" });
    const tools = toolbar.createDiv({ cls: "systemsculpt-agent-prompt-tools" });
    this.addButton = createButton(tools, "systemsculpt-agent-icon-button", "chat.composer.add", "Add files and notes", "plus");
    this.addButton.setAttribute("aria-haspopup", "menu");
    this.filePicker = tools.createEl("input", {
      cls: "systemsculpt-agent-file-picker",
      attr: {
        "data-testid": "chat.composer.file-picker",
        type: "file",
        multiple: "true",
        accept: CHAT_ATTACHMENT_PICKER_ACCEPT,
        tabindex: "-1",
        "aria-hidden": "true",
      },
    });
    this.approvalMode = tools.createEl("select", {
      cls: "dropdown systemsculpt-agent-approval-mode",
      attr: { "data-testid": "chat.composer.approval-mode", "aria-label": "Vault changes" },
    });
    this.approvalMode.createEl("option", { value: "auto", text: "Auto" });
    this.approvalMode.createEl("option", { value: "ask", text: "Ask" });
    this.approvalMode.createEl("option", { value: "full-access", text: "Full access" });

    this.hint = toolbar.createSpan({ cls: "systemsculpt-agent-prompt-hint", attr: { "aria-live": "polite" } });

    const actions = toolbar.createDiv({ cls: "systemsculpt-agent-prompt-actions" });
    this.cancelAttachmentsButton = createButton(
      actions,
      "systemsculpt-agent-attachment-cancel",
      "chat.composer.attachment.cancel",
      "Stop processing attachments",
      "x",
    );
    this.micButton = options.onMic
      ? createButton(actions, "systemsculpt-agent-icon-button", "chat.composer.mic", "Record message", "mic")
      : null;
    this.stopButton = createButton(actions, "systemsculpt-agent-stop", "chat.composer.stop", "Stop response", "square");
    this.stopButton.setAttribute("aria-keyshortcuts", "Escape");
    this.sendButton = createButton(actions, "systemsculpt-agent-send", "chat.composer.send", "Send message", "arrow-up", "primary");
    this.sendButton.setAttribute("aria-keyshortcuts", "Enter");

    this.footerSlot = this.element.createDiv({ cls: "systemsculpt-agent-composer-footer" });
    this.mentions = new AgentComposerMentionPopover(this.element, this.input, {
      suggest: (query) => this.vault?.suggest(query) ?? [],
      onPick: (file, trigger) => void this.insertMention(file, trigger),
    });
    this.register(() => this.mentions.dispose());

    this.dropOverlay = parent.createDiv({
      cls: "systemsculpt-agent-drop-overlay",
      attr: { "data-testid": "chat.composer.drop-overlay", hidden: "", "aria-hidden": "true" },
    });
    const dropCopy = this.dropOverlay.createDiv({ cls: "systemsculpt-agent-drop-overlay-copy" });
    setIcon(dropCopy.createSpan({ cls: "systemsculpt-agent-drop-overlay-icon" }), "file-plus");
    dropCopy.createSpan({ text: "Drop to add to your message" });
    this.register(() => this.dropOverlay.remove());

    this.registerDomEvent(this.input, "input", () => {
      if (this.recallIndex !== null && this.input.value !== this.promptHistory[this.recallIndex]) {
        this.recallIndex = null;
      }
      this.resize();
      this.mentions.update();
      this.syncControls();
    });
    this.registerDomEvent(this.input, "keydown", (event) => this.handleInputKeydown(event));
    this.registerDomEvent(this.input, "click", () => this.mentions.update());
    this.registerDomEvent(this.input, "focus", () => this.resize());
    this.registerDomEvent(this.input, "blur", () => {
      // Pointer commits on options land before blur; anything else closes it.
      this.mentions.close();
    });
    this.registerDomEvent(this.addButton, "click", () => this.openAddMenu());
    this.registerDomEvent(this.suggestionChip, "click", () => {
      const note = this.vault?.activeNote();
      if (note) void this.addVaultFiles([note], { focus: true });
    });
    this.registerDomEvent(this.overflowChip, "click", () => {
      this.chipsExpanded = true;
      this.scheduleChipLayout();
    });
    this.registerDomEvent(this.filePicker, "change", () => {
      const files = Array.from(this.filePicker.files ?? []);
      this.filePicker.value = "";
      void this.ingestFiles(files);
    });
    this.registerDomEvent(this.input, "paste", (event) => {
      const files = this.filesFromTransfer(event.clipboardData);
      if (files.length === 0) return;
      // Text stays text; files become chips.
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) event.preventDefault();
      void this.ingestFiles(files);
    });
    this.registerDomEvent(parent, "dragenter", (event) => this.handleDragOver(event, true));
    this.registerDomEvent(parent, "dragover", (event) => this.handleDragOver(event, false));
    this.registerDomEvent(parent, "dragleave", () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.setDropOverlayVisible(false);
    });
    this.registerDomEvent(parent, "drop", (event) => this.handleDrop(event));
    this.registerDomEvent(parent, "keydown", (event) => this.handleWorkspaceKeydown(event));
    if (this.micButton) this.registerDomEvent(this.micButton, "click", () => void this.options.onMic?.());
    this.registerDomEvent(this.approvalMode, "change", () => {
      const mode = parseChatApprovalMode(this.approvalMode.value);
      this.approvalMode.classList.toggle("is-full-access", mode === "full-access");
      this.options.onApprovalModeChange?.(mode);
    });
    this.registerDomEvent(this.sendButton, "click", () => void this.submit());
    this.registerDomEvent(this.stopButton, "click", () => void this.options.onStop());
    this.registerDomEvent(this.cancelAttachmentsButton, "click", () => this.messageAttachments.cancelProcessing());
    if (options.app) {
      this.registerEvent(options.app.workspace.on("file-open", () => this.syncSuggestion()));
      this.registerEvent(options.app.workspace.on("active-leaf-change", () => this.syncSuggestion()));
    }
    this.register(() => {
      if (this.chipLayoutFrame !== null) getSurfaceOwnerWindow(this.element).cancelAnimationFrame(this.chipLayoutFrame);
    });
    this.observeHostClearance();
    this.renderAttachments();
    this.syncControls();
  }

  public focus(): void {
    this.input.focus();
  }

  public getValue(): string {
    return this.input.value;
  }

  onunload(): void {
    // Closing the chat stops document processing its draft started.
    this.attachmentGeneration += 1;
    this.messageAttachments.dispose();
  }

  public hasDraft(): boolean {
    return this.input.value.trim().length > 0 || this.messageAttachments.hasEntries();
  }

  public setValue(value: string, options: Readonly<{ focus?: boolean }> = {}): void {
    this.input.value = value;
    this.recallIndex = null;
    this.resize();
    this.syncControls();
    if (options.focus) this.focus();
  }

  /**
   * Starts a fresh ephemeral message draft without changing selected vault
   * context or run state. Replacing the owned collection also retires any
   * attachment ingestion or retry still resolving for the previous draft.
   */
  public resetDraft(): void {
    this.attachmentGeneration += 1;
    this.attachmentBusy = false;
    // Work still settling for the old draft must not hold up the new one.
    this.attachmentQueue = Promise.resolve();
    this.messageAttachments.dispose();
    this.input.value = "";
    this.filePicker.value = "";
    this.messageAttachments = this.createMessageAttachmentCollection();
    this.vaultAttachmentPaths.clear();
    this.issues = [];
    this.steering = false;
    this.recallIndex = null;
    this.chipsExpanded = false;
    this.mentions.close();
    this.renderAttachments();
    this.resize();
    this.syncControls();
  }

  /** Names the agent in the placeholder: "Ask Claude Code to work in your vault…". */
  public setAgentName(name: string): void {
    const next = name.trim() || DEFAULT_AGENT_NAME;
    if (next === this.agentName) return;
    this.agentName = next;
    this.syncControls();
  }

  /**
   * After the user denies an action and nothing else is pending, the box
   * invites them to steer the agent instead, until the next send.
   */
  public showSteeringPlaceholder(): void {
    this.steering = true;
    this.syncControls();
  }

  /** Earlier prompts in this chat, recalled with Up and Down in an empty box. */
  public setPromptHistory(messages: readonly ChatMessage[]): void {
    const prompts: string[] = [];
    for (const message of messages) {
      if (message.role !== "user") continue;
      const text = restoreChatMessageDraft(message).text.trim();
      if (text && prompts[prompts.length - 1] !== text) prompts.push(text);
    }
    const browsing = this.recallIndex === null ? null : this.promptHistory[this.recallIndex];
    this.promptHistory = Object.freeze(prompts);
    this.recallIndex = browsing === null || browsing === undefined
      ? null
      : (() => {
          const index = prompts.lastIndexOf(browsing);
          return index >= 0 ? index : null;
        })();
  }

  public setApprovalMode(mode: ChatApprovalMode): void {
    this.approvalMode.value = mode;
    this.approvalMode.classList.toggle("is-full-access", mode === "full-access");
    this.element.dispatchEvent(new Event("systemsculpt:approval-mode"));
  }

  public setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.element.classList.toggle("is-running", running);
    this.syncControls();
  }

  public setHistoryEditing(editing: boolean): void {
    this.historyEditing = editing;
    this.element.classList.toggle("is-history-editing", editing);
    this.syncControls();
  }

  public setReadOnly(message: string | null): void {
    this.readOnlyMessage = message?.trim() || null;
    this.element.classList.toggle("is-read-only", Boolean(this.readOnlyMessage));
    if (this.readOnlyMessage) this.mentions.close();
    this.renderAttachments();
    this.syncControls();
  }

  public setRecording(recording: boolean): void {
    if (!this.micButton) return;
    updateUiAction(this.micButton, {
      label: recording ? "Stop recording" : "Record message",
      icon: recording ? "square" : "mic",
      selected: recording,
    });
  }

  public setAttachments(attachments: readonly AgentComposerAttachment[]): void {
    this.pinnedAttachments = [...attachments];
    this.renderAttachments();
    this.syncControls();
  }

  public setMessageAttachmentLimits(limits: ThinAgentInputLimits): void {
    this.attachmentLimits = limits;
    this.messageAttachments.setLimits(limits);
  }

  public restoreMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.messageAttachments.mergeReady(attachments);
    this.renderAttachments();
    this.syncControls();
  }

  /**
   * Put a rejected submission back without destroying anything typed while the
   * request was in flight. The older rejected text stays first, followed by the
   * newer draft, matching their chronological intent.
   */
  public restoreRejectedSubmission(submission: Pick<AgentComposerSubmit, "text" | "attachments">): void {
    const rejected = submission.text.trim();
    const current = this.input.value;
    if (rejected && current.trim() !== rejected) {
      this.input.value = current.trim() ? `${rejected}\n\n${current}` : rejected;
    }
    if (submission.attachments?.length) {
      this.messageAttachments.mergeReady(submission.attachments, "prepend");
    }
    this.renderAttachments();
    this.resize();
    this.syncControls();
    this.focus();
  }

  public getMessageAttachments(): readonly ChatMessageAttachment[] {
    return this.messageAttachments.snapshot();
  }

  public setMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.messageAttachments.replace(attachments);
    this.renderAttachments();
    this.syncControls();
  }

  private placeholder(): string {
    if (this.readOnlyMessage) return READ_ONLY_PLACEHOLDER;
    if (this.steering) return `Tell ${this.agentName} what to do instead…`;
    if (this.running) return RUNNING_PLACEHOLDER;
    return `Ask ${this.agentName} to work in your vault…`;
  }

  private renderAttachments(): void {
    this.attachmentList.empty();
    const messageAttachments = this.messageAttachments.displaySnapshot();
    for (const id of [...this.vaultAttachmentPaths.keys()]) {
      if (!messageAttachments.some((attachment) => attachment.id === id)) this.vaultAttachmentPaths.delete(id);
    }
    const total = this.pinnedAttachments.length + messageAttachments.length;
    this.attachmentList.classList.toggle("is-empty", total === 0);
    for (const attachment of this.pinnedAttachments) this.renderPinnedChip(attachment);
    for (const attachment of messageAttachments) this.renderMessageChip(attachment);
    this.renderErrors(messageAttachments);
    this.syncSuggestion();
    if (total === 0) this.chipsExpanded = false;
    this.scheduleChipLayout();
  }

  private renderPinnedChip(attachment: AgentComposerAttachment): void {
    const path = pinnedVaultPath(attachment);
    const chip = this.attachmentList.createDiv({
      cls: "systemsculpt-agent-attachment is-pinned",
      attr: { role: "listitem", title: `${path}. Pinned and reread for every message.` },
    });
    const open = this.createChipButton(chip, `${attachment.label}, pinned for every message. Options`);
    if (attachment.kind === "image" && attachment.previewUrl) {
      this.renderAttachmentPreview(open, attachment.previewUrl);
    }
    this.renderAttachmentIcon(open, "pin", "is-pin");
    open.createSpan({ cls: "systemsculpt-agent-attachment-label", text: attachment.label });
    const readOnly = Boolean(this.readOnlyMessage);
    open.disabled = readOnly;
    // Attachment chips are replaced wholesale. Keeping their listeners on the
    // component cleanup stack would retain every removed chip until the view
    // closes.
    open.onclick = (event) => this.openChipMenu(event, open, [
      ...this.openItem(path),
      { title: "Unpin", icon: "pin-off", run: () => void this.options.onRemoveAttachment(attachment) },
    ]);
    const remove = createButton(chip, "systemsculpt-agent-attachment-remove", "chat.composer.attachment.unpin", `Unpin ${attachment.label}`, "x");
    remove.disabled = readOnly;
    remove.onclick = () => void this.options.onRemoveAttachment(attachment);
  }

  private renderMessageChip(attachment: ChatAttachmentDisplay): void {
    const vaultPath = this.vaultAttachmentPaths.get(attachment.id) ?? null;
    const label = basename(attachment.name);
    const chip = this.attachmentList.createDiv({
      cls: `systemsculpt-agent-attachment is-message is-${attachment.kind} is-${attachment.status}`,
      attr: {
        role: "listitem",
        title: attachment.status === "failed"
          ? attachment.error
          : `${attachment.name} · ${this.formatBytes(attachment.byteLength)}`,
      },
    });
    const processing = attachment.status === "processing";
    const open = this.createChipButton(
      chip,
      processing ? `Reading ${label}…` : `${label}, sent with this message. Options`,
    );
    if (attachment.status === "ready" && attachment.kind === "image" && attachment.contentPart.type === "image_url") {
      this.renderAttachmentPreview(open, attachment.contentPart.image_url.url);
    } else if (processing) {
      this.renderAttachmentIcon(open, "loader-circle", "is-spinning");
    } else {
      this.renderAttachmentIcon(open, attachment.status === "failed" ? "circle-alert" : "file-text");
    }
    open.createSpan({
      cls: "systemsculpt-agent-attachment-label",
      text: processing ? `Reading ${label}…` : label,
    });
    const readOnly = Boolean(this.readOnlyMessage);
    open.disabled = readOnly || processing;
    open.onclick = (event) => this.openChipMenu(event, open, [
      ...(vaultPath ? this.openItem(vaultPath) : []),
      ...(vaultPath && this.options.onVaultContextDrop && attachment.status === "ready"
        ? [{ title: "Pin for every message", icon: "pin", run: () => void this.pinMessageAttachment(attachment.id, vaultPath) }]
        : []),
      { title: "Remove", icon: "x", run: () => void this.removeMessageAttachment(attachment.id) },
    ]);
    if (attachment.status === "failed") {
      const retry = createButton(chip, "systemsculpt-agent-attachment-retry", "chat.composer.attachment.retry", `Retry ${label}`, "rotate-cw");
      retry.disabled = readOnly;
      retry.onclick = () => void this.retryMessageAttachment(attachment.id);
    }
    const remove = createButton(chip, "systemsculpt-agent-attachment-remove", "chat.composer.attachment.remove", `Remove ${label}`, "x");
    remove.disabled = readOnly;
    remove.onclick = () => void this.removeMessageAttachment(attachment.id);
  }

  private createChipButton(chip: HTMLElement, label: string): HTMLButtonElement {
    const button = chip.createEl("button", {
      cls: "systemsculpt-agent-attachment-open",
      attr: { type: "button", "data-testid": "chat.composer.attachment.open", "aria-label": label, "aria-haspopup": "menu" },
    });
    return button;
  }

  private openItem(path: string): ChipMenuItem[] {
    const file = this.vault?.resolve(path);
    return file ? [{ title: "Open", icon: "file-symlink", run: () => void this.vault?.open(file) }] : [];
  }

  private openChipMenu(event: MouseEvent, anchor: HTMLElement, items: readonly ChipMenuItem[]): void {
    if (this.readOnlyMessage) return;
    const menu = new Menu();
    let chosen = false;
    for (const entry of items) {
      menu.addItem((item) => item.setTitle(entry.title).setIcon(entry.icon).onClick(() => {
        chosen = true;
        entry.run();
        // The chip goes away (or the note opens); typing continues in the box.
        if (entry.title !== "Open") this.focus();
      }));
    }
    this.presentMenu(menu, anchor, () => chosen, event);
  }

  /**
   * Shows a menu and, when it is dismissed from the keyboard, returns focus to
   * the control that opened it. Obsidian otherwise sends focus to the editor.
   */
  private presentMenu(menu: Menu, anchor: HTMLElement, chosen: () => boolean, event?: MouseEvent): void {
    const ownerDocument = anchor.ownerDocument;
    let dismissedByPointer = false;
    const onPointerDown = (pointer: PointerEvent) => {
      const target = pointer.target as Element | null;
      if (!target?.closest?.(".menu")) dismissedByPointer = true;
    };
    ownerDocument.addEventListener("pointerdown", onPointerDown, true);
    menu.onHide(() => {
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
      if (chosen() || dismissedByPointer) return;
      anchor.focus();
      getSurfaceOwnerWindow(anchor).setTimeout(() => {
        if (anchor.isConnected && ownerDocument.activeElement !== anchor) anchor.focus();
      }, 0);
    });
    this.showMenu(menu, anchor, event);
  }

  private showMenu(menu: Menu, anchor: HTMLElement, event?: MouseEvent): void {
    // Keyboard activation reports no pointer position; anchor to the control.
    if (event && event.detail > 0 && (event.clientX !== 0 || event.clientY !== 0)) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top, width: rect.width, overlap: true, left: false }, anchor.ownerDocument);
  }

  private openAddMenu(): void {
    if (this.addButton.disabled) return;
    const menu = new Menu();
    let chosen = false;
    const choose = (run: () => void) => () => {
      chosen = true;
      run();
    };
    const note = this.vault?.activeNote() ?? null;
    if (note) {
      menu.addItem((item) => item
        .setTitle(`Add current note: ${note.extension === "md" ? note.basename : note.name}`)
        .setIcon("file-plus")
        .onClick(choose(() => void this.addVaultFiles([note], { focus: true }))));
    }
    if (this.options.app) {
      menu.addItem((item) => item
        .setTitle("Add notes from vault…")
        .setIcon("files")
        .onClick(choose(() => this.openVaultPicker())));
    }
    menu.addItem((item) => item
      .setTitle(isMobileLayout(this.element) ? "Upload from device…" : "Upload from computer…")
      .setIcon("upload")
      .onClick(choose(() => this.filePicker.click())));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("Pin files for every message…")
      .setIcon("pin")
      .onClick(choose(() => void this.options.onAttach())));
    this.presentMenu(menu, this.addButton, () => chosen);
  }

  private openVaultPicker(): void {
    const app = this.options.app;
    if (!app) return;
    const modal = new ContextSelectionModal(
      app,
      async (files) => {
        await this.addVaultFiles(files, { focus: true });
      },
      null,
      {
        purpose: "message",
        isFileAlreadyPinned: (file) => this.isVaultFileAttached(file.path),
      },
    );
    modal.open();
  }

  private isVaultFileAttached(path: string): boolean {
    return this.pinnedAttachments.some((attachment) => pinnedVaultPath(attachment) === path)
      || [...this.vaultAttachmentPaths.values()].includes(path);
  }

  private async insertMention(file: TFile, trigger: ComposerMentionTrigger): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const link = `[[${vault.linkText(file)}]]`;
    const value = this.input.value;
    const after = value.slice(trigger.end);
    const spacer = after.startsWith(" ") || after.startsWith("\n") ? "" : " ";
    const replacement = `${link}${spacer}`;
    this.input.value = `${value.slice(0, trigger.start)}${replacement}${after}`;
    const caret = trigger.start + replacement.length;
    this.input.setSelectionRange(caret, caret);
    this.resize();
    this.syncControls();
    this.focus();
    if (!this.isVaultFileAttached(file.path)) await this.addVaultFiles([file]);
  }

  private async addVaultFiles(files: readonly TFile[], options: Readonly<{ focus?: boolean }> = {}): Promise<void> {
    const vault = this.vault;
    if (!vault || files.length === 0) return;
    const fresh = files.filter((file) => !this.isVaultFileAttached(file.path));
    if (fresh.length === 0) {
      if (options.focus) this.focus();
      return;
    }
    await this.runAttachmentOperation("Adding notes…", async (collection) => {
      const sources: Array<{ path: string; file: File }> = [];
      for (const file of fresh) sources.push({ path: file.path, file: await vault.read(file) });
      const result = await collection.addVaultFiles(sources, this.input.value);
      for (const attachment of result.accepted) {
        const source = fresh.find((file) => file.path === attachment.name);
        if (source) this.vaultAttachmentPaths.set(attachment.id, source.path);
      }
      for (const entry of collection.displaySnapshot()) {
        if (this.vaultAttachmentPaths.has(entry.id)) continue;
        const source = fresh.find((file) => file.path === entry.name);
        if (source) this.vaultAttachmentPaths.set(entry.id, source.path);
      }
      return result;
    });
    if (options.focus) this.focus();
  }

  private async pinMessageAttachment(id: string, path: string): Promise<void> {
    await this.options.onVaultContextDrop?.(path);
    await this.removeMessageAttachment(id);
  }

  private syncSuggestion(): void {
    const note = this.vault?.activeNote() ?? null;
    const visible = Boolean(note)
      && !this.readOnlyMessage
      && !this.historyEditing
      && this.input.value.trim().length === 0
      && !this.messageAttachments.hasEntries()
      && !this.isVaultFileAttached(note!.path);
    this.suggestionChip.toggleAttribute("hidden", !visible);
    this.chipRow.classList.toggle("is-empty", !visible && this.attachmentList.childElementCount === 0);
    if (!note || !visible) return;
    const name = note.extension === "md" ? note.basename : note.name;
    updateUiAction(this.suggestionChip, { label: name });
    this.suggestionChip.setAttribute("aria-label", `Add current note: ${name}`);
    this.suggestionChip.title = `Add ${note.path} to this message`;
  }

  private renderErrors(messageAttachments: readonly ChatAttachmentDisplay[]): void {
    const failures = messageAttachments.flatMap((attachment) =>
      attachment.status === "failed" ? [attachment.error] : []);
    const messages = [...new Set([...failures, ...this.issues])];
    this.errorList.empty();
    this.errorList.toggleAttribute("hidden", messages.length === 0);
    for (const message of messages) {
      const row = this.errorList.createDiv({ cls: "systemsculpt-agent-composer-error" });
      setIcon(row.createSpan({ cls: "systemsculpt-agent-composer-error-icon", attr: { "aria-hidden": "true" } }), "circle-alert");
      row.createSpan({ cls: "systemsculpt-agent-composer-error-text", text: message });
    }
    if (this.issues.length > 0) {
      const dismiss = createButton(this.errorList, "systemsculpt-agent-composer-error-dismiss", "chat.composer.errors.dismiss", "Dismiss", "x");
      dismiss.onclick = () => {
        this.issues = [];
        this.renderAttachments();
        this.focus();
      };
    }
  }

  private scheduleChipLayout(): void {
    // Wrapping needs at least two chips; nothing to measure otherwise.
    if (this.attachmentList.childElementCount < 2) {
      this.overflowChip.setAttribute("hidden", "");
      return;
    }
    if (this.chipLayoutFrame !== null) return;
    this.chipLayoutFrame = requestSurfaceAnimationFrame(this.element, () => {
      this.chipLayoutFrame = null;
      this.layoutChips();
    });
  }

  /** Chips wrap to two rows; the rest fold behind "+N" until it is clicked. */
  private layoutChips(): void {
    const chips = Array.from(this.attachmentList.children) as HTMLElement[];
    for (const chip of chips) chip.removeAttribute("hidden");
    this.overflowChip.setAttribute("hidden", "");
    if (this.chipsExpanded || chips.length < 2) return;
    const rowTops = [...new Set(chips.map((chip) => chip.offsetTop))].sort((a, b) => a - b);
    if (rowTops.length <= 2) return;
    const lastVisibleTop = rowTops[1];
    let cut = chips.findIndex((chip) => chip.offsetTop > lastVisibleTop);
    this.overflowChip.removeAttribute("hidden");
    for (; cut > 0; cut -= 1) {
      for (const [index, chip] of chips.entries()) chip.toggleAttribute("hidden", index >= cut);
      const hidden = chips.length - cut;
      updateUiAction(this.overflowChip, { label: `+${hidden}` });
      this.overflowChip.setAttribute("aria-label", `Show ${hidden} more attachment${hidden === 1 ? "" : "s"}`);
      if (this.overflowChip.offsetTop <= lastVisibleTop) break;
    }
  }

  /**
   * Keeps the card and the run line clear of Obsidian's floating status bar
   * when the chat sits at the window's bottom right.
   */
  private observeHostClearance(): void {
    const view = getSurfaceOwnerWindow(this.element);
    const measure = () => {
      if (!this.input.style.height) this.resize();
      const clearance = statusBarBottomOverlap(this.element);
      if (clearance === this.hostClearance) return;
      this.hostClearance = clearance;
      this.element.setCssProps({ "--ss-agent-composer-host-clearance": `${clearance}px` });
      this.options.onHeightChange?.();
    };
    const Observer = (view as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => measure());
      observer.observe(this.element);
      this.register(() => observer.disconnect());
    }
    this.registerDomEvent(view, "resize", measure);
    if (this.options.app) this.registerEvent(this.options.app.workspace.on("layout-change", measure));
  }

  private renderAttachmentPreview(parent: HTMLElement, src: string): void {
    const image = parent.createEl("img", {
      cls: "systemsculpt-agent-attachment-preview",
      attr: { alt: "" },
    });
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    image.onerror = () => {
      image.onerror = null;
      const fallback = parent.createSpan({
        cls: "systemsculpt-agent-attachment-icon",
      });
      image.replaceWith(fallback);
      setIcon(fallback, "image");
    };
    image.src = src;
  }

  private renderAttachmentIcon(parent: HTMLElement, iconName: string, modifier = ""): void {
    const icon = parent.createSpan({
      cls: `systemsculpt-agent-attachment-icon ${modifier}`.trim(),
      attr: { "aria-hidden": "true" },
    });
    setIcon(icon, iconName);
  }

  private handleInputKeydown(event: KeyboardEvent): void {
    // "Process" is what an IME reports for keys it is still composing.
    if (event.isComposing || event.key === "Process") return;
    const modified = event.altKey || event.ctrlKey || event.metaKey;
    if (this.mentions.isOpen()) {
      if (event.key === "Tab" && !event.shiftKey && !modified) {
        if (this.mentions.commitActive()) event.preventDefault();
        return;
      }
      // The combobox owns arrows, Home/End, Escape, and Enter on a suggestion.
      if (["ArrowUp", "ArrowDown", "Home", "End", "Escape"].includes(event.key) && !modified) return;
      if (event.key === "Enter" && !event.shiftKey && !modified && this.mentions.commitActive()) {
        event.preventDefault();
        return;
      }
      this.mentions.close();
    }
    switch (event.key) {
      case "Enter": {
        if (event.shiftKey || event.altKey) return;
        // Touch keyboards insert a newline; the Send button sends.
        if (!event.ctrlKey && !event.metaKey && this.prefersTouchInput()) return;
        event.preventDefault();
        if (event.repeat) return;
        void this.submit();
        return;
      }
      case "Escape": {
        if (modified || event.shiftKey || !this.running) return;
        event.preventDefault();
        event.stopPropagation();
        void this.options.onStop();
        return;
      }
      case "ArrowUp": {
        if (modified || event.shiftKey) return;
        if (this.recallPrompt(-1)) event.preventDefault();
        return;
      }
      case "ArrowDown": {
        if (modified || event.shiftKey) return;
        if (this.recallPrompt(1)) event.preventDefault();
        return;
      }
    }
  }

  /**
   * Steps through earlier prompts in an empty box, like a shell: Up from the
   * start of the box goes back, Down from its end goes forward and finally
   * returns to an empty draft.
   */
  private recallPrompt(direction: -1 | 1): boolean {
    const value = this.input.value;
    const browsing = this.recallIndex !== null && value === this.promptHistory[this.recallIndex];
    if (!browsing) this.recallIndex = null;
    const start = this.input.selectionStart ?? 0;
    const end = this.input.selectionEnd ?? 0;
    if (direction < 0) {
      if (value.length > 0 && !browsing) return false;
      if (browsing && (start !== 0 || end !== 0)) return false;
      const next = (this.recallIndex ?? this.promptHistory.length) - 1;
      if (next < 0) return false;
      this.showRecalled(next, "start");
      return true;
    }
    if (!browsing || start !== value.length || end !== value.length) return false;
    const next = this.recallIndex! + 1;
    if (next >= this.promptHistory.length) {
      this.recallIndex = null;
      this.input.value = "";
      this.afterProgrammaticEdit();
      return true;
    }
    this.showRecalled(next, "end");
    return true;
  }

  private showRecalled(index: number, caret: "start" | "end"): void {
    this.recallIndex = index;
    this.input.value = this.promptHistory[index];
    const position = caret === "start" ? 0 : this.input.value.length;
    this.input.setSelectionRange(position, position);
    this.afterProgrammaticEdit();
  }

  private afterProgrammaticEdit(): void {
    this.resize();
    this.syncControls();
  }

  /**
   * Typing a printable character while focus is in the conversation sends it
   * to the message box; Escape returns there too. Cards, fields, and the rest
   * of the chrome keep their own keys.
   */
  private handleWorkspaceKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || this.element.contains(target)) return;
    if (target !== this.parent && !target.closest(".systemsculpt-agent-viewport, .systemsculpt-agent-queue")) return;
    if (isTextEntryTarget(target) || target.closest('.systemsculpt-agent-approval, [role="dialog"], [role="menu"]')) return;
    if (this.input.disabled || this.element.closest("[hidden]")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.focus();
      return;
    }
    if (event.key.length !== 1 || event.key === " ") return;
    event.preventDefault();
    const length = this.input.value.length;
    this.input.focus();
    this.input.setRangeText(event.key, length, length, "end");
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private prefersTouchInput(): boolean {
    return getSurfaceOwnerWindow(this.element).matchMedia?.("(pointer: coarse)").matches === true;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    const attachments = this.messageAttachments.snapshot();
    if (
      (!text && attachments.length === 0)
      || this.historyEditing
      || Boolean(this.readOnlyMessage)
      || this.submitting
      || this.attachmentBusy
    ) return;
    const validation = this.messageAttachments.validateSubmission(text, attachments);
    if (validation.length > 0) {
      this.issues = validation.map((problem) => problem.message);
      this.renderAttachments();
      return;
    }
    const mode = this.running ? "queue" as const : "send" as const;
    this.submitting = true;
    this.syncControls();
    try {
      await this.options.onSubmit({
        text,
        mode,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (text && this.promptHistory[this.promptHistory.length - 1] !== text) {
        this.promptHistory = Object.freeze([...this.promptHistory, text]);
      }
      this.recallIndex = null;
      this.steering = false;
      this.issues = [];
      this.input.value = "";
      this.messageAttachments.clear();
      this.vaultAttachmentPaths.clear();
      this.mentions.close();
      this.renderAttachments();
      this.resize();
      if (mode === "queue") this.options.announce?.("Message queued.");
    } finally {
      this.submitting = false;
      this.syncControls();
    }
  }

  /**
   * Grows from one line to 40% of the view (never less than six lines), then
   * scrolls inside; shrinks back after send.
   */
  private resize(): void {
    const previousHeight = this.input.style.height;
    const view = getSurfaceOwnerWindow(this.input);
    const style = view.getComputedStyle?.(this.input);
    const lineHeight = Number.parseFloat(style?.lineHeight ?? "") || 20;
    const padding = (Number.parseFloat(style?.paddingTop ?? "") || 0)
      + (Number.parseFloat(style?.paddingBottom ?? "") || 0);
    const viewHeight = this.parent.clientHeight || view.innerHeight || 0;
    const maxHeight = Math.max(
      Math.ceil(lineHeight * INPUT_MIN_MAX_LINES + padding),
      Math.floor(viewHeight * INPUT_MAX_VIEW_FRACTION),
    );
    this.input.setCssStyles({ height: "auto" });
    const content = this.input.scrollHeight;
    if (content === 0) {
      // Not laid out yet (a hidden or detached view): keep the natural one-line
      // height and measure again once it shows.
      this.input.setCssStyles({ height: "" });
      return;
    }
    const next = Math.min(content, maxHeight);
    const nextHeight = `${next}px`;
    this.input.setCssStyles({ height: nextHeight });
    this.input.classList.toggle("is-scrollable", content > maxHeight);
    if (previousHeight !== nextHeight) this.options.onHeightChange?.();
  }

  private syncControls(): void {
    const hasText = this.input.value.trim().length > 0;
    const hasMessage = hasText || this.messageAttachments.hasAny();
    const readOnly = Boolean(this.readOnlyMessage);
    const status = this.readOnlyMessage
      ?? (this.historyEditing ? "Finish editing the earlier message" : this.attachmentBusy ? this.attachmentBusyLabel : "");
    if (this.hint.textContent !== status) this.hint.setText(status);
    this.hint.toggleAttribute("hidden", !status);
    const placeholder = this.placeholder();
    if (this.input.placeholder !== placeholder) this.input.placeholder = placeholder;
    this.input.setAttribute("aria-label", `Message ${this.agentName}`);
    this.input.disabled = this.historyEditing || readOnly;
    // While running, Stop is always there; Send becomes Queue once there is something to queue.
    // One filled action at a time: Stop while running with an empty box,
    // otherwise Send (or Queue while running).
    const queueing = this.running;
    this.sendButton.toggleAttribute("hidden", queueing && !hasMessage);
    updateUiAction(this.sendButton, {
      label: queueing ? "Queue follow-up" : "Send message",
      icon: queueing ? "list-plus" : "arrow-up",
    });
    updateUiAction(this.stopButton, { tone: queueing && !hasMessage ? "primary" : "default" });
    this.sendButton.disabled = this.historyEditing || readOnly || this.submitting || this.attachmentBusy
      || this.messageAttachments.hasBlockingFailures() || !hasMessage;
    this.stopButton.toggleAttribute("hidden", !this.running);
    this.cancelAttachmentsButton.toggleAttribute("hidden", !this.attachmentBusy);
    this.addButton.disabled = this.historyEditing || readOnly || this.attachmentBusy;
    this.filePicker.disabled = this.historyEditing || readOnly || this.attachmentBusy;
    this.approvalMode.disabled = this.historyEditing || readOnly || this.running;
    if (this.micButton) this.micButton.disabled = this.historyEditing || readOnly || this.attachmentBusy;
    this.element.classList.toggle("is-submitting", this.submitting);
    this.element.classList.toggle("is-processing-attachments", this.attachmentBusy);
    this.syncSuggestion();
  }

  private ingestFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return Promise.resolve();
    return this.runAttachmentOperation("Processing attachments…", collection =>
      collection.addFiles(files, this.input.value));
  }

  private retryMessageAttachment(id: string): Promise<void> {
    return this.runAttachmentOperation("Retrying document…", collection =>
      collection.retry(id, this.input.value));
  }

  /**
   * Attachment work runs one operation at a time, in order: a second drop or
   * mention while a file is still being read waits instead of being lost.
   * Work queued for a draft that has since been reset is skipped.
   */
  private runAttachmentOperation(
    label: string,
    run: (collection: ChatMessageAttachmentCollection) => Promise<ChatAttachmentIngestionResult>,
  ): Promise<void> {
    const generation = this.attachmentGeneration;
    const next = this.attachmentQueue.then(() => {
      if (generation !== this.attachmentGeneration) return undefined;
      return this.performAttachmentOperation(label, run);
    });
    this.attachmentQueue = next.catch(() => undefined);
    return next;
  }

  private async performAttachmentOperation(
    label: string,
    run: (collection: ChatMessageAttachmentCollection) => Promise<ChatAttachmentIngestionResult>,
  ): Promise<void> {
    if (this.readOnlyMessage) return;
    const generation = this.attachmentGeneration;
    const collection = this.messageAttachments;
    this.attachmentBusy = true;
    this.attachmentBusyLabel = label;
    this.issues = [];
    this.renderAttachments();
    this.syncControls();
    try {
      const result = await run(collection);
      if (!this.isCurrentAttachmentOperation(generation, collection)) return;
      this.issues = result.issues
        .filter((problem) => problem.code !== "processing_failed")
        .map((problem) => problem.message);
      this.renderAttachments();
    } catch (error) {
      if (!this.isCurrentAttachmentOperation(generation, collection)) return;
      this.issues = [error instanceof Error && error.message ? error.message : "The file could not be read."];
      this.renderAttachments();
    } finally {
      if (this.isCurrentAttachmentOperation(generation, collection)) {
        this.attachmentBusy = false;
        this.attachmentBusyLabel = "";
        this.syncControls();
      }
    }
  }

  private createMessageAttachmentCollection(): ChatMessageAttachmentCollection {
    const collection: ChatMessageAttachmentCollection = new ChatMessageAttachmentCollection(
      undefined,
      this.options.documentAttachmentProcessor,
      this.attachmentLimits,
      () => {
        if (collection === this.messageAttachments) this.renderAttachments();
      },
    );
    return collection;
  }

  private isCurrentAttachmentOperation(
    generation: number,
    collection: ChatMessageAttachmentCollection,
  ): boolean {
    return generation === this.attachmentGeneration
      && collection === this.messageAttachments;
  }

  private async removeMessageAttachment(id: string): Promise<void> {
    if (this.readOnlyMessage) return;
    try {
      this.messageAttachments.remove(id);
    } catch {
      this.issues = ["The attachment recovery record could not be cleaned up."];
    }
    this.vaultAttachmentPaths.delete(id);
    this.renderAttachments();
    this.syncControls();
  }

  private handleDragOver(event: DragEvent, entering: boolean): void {
    if (this.readOnlyMessage || this.historyEditing) return;
    if (!this.transferHasAttachments(event.dataTransfer)) return;
    event.preventDefault();
    // Keep Obsidian from treating a vault file drop as "open it in this pane".
    event.stopPropagation();
    if (entering) this.dragDepth += 1;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.setDropOverlayVisible(true);
  }

  private handleDrop(event: DragEvent): void {
    this.dragDepth = 0;
    this.setDropOverlayVisible(false);
    if (this.readOnlyMessage || this.historyEditing) return;
    const files = this.filesFromTransfer(event.dataTransfer);
    const similarNotePath = this.similarNotePathFromTransfer(event.dataTransfer);
    const vaultFiles = files.length === 0 && !similarNotePath ? this.vault?.draggedFiles(event.dataTransfer) ?? [] : [];
    if (files.length === 0 && !similarNotePath && vaultFiles.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (files.length > 0) void this.ingestFiles(files);
    else if (similarNotePath) void this.options.onVaultContextDrop?.(similarNotePath);
    else void this.addVaultFiles(vaultFiles, { focus: true });
  }

  private setDropOverlayVisible(visible: boolean): void {
    if (!visible) this.dragDepth = 0;
    this.dropOverlay.toggleAttribute("hidden", !visible);
    this.element.classList.toggle("is-dragging-files", visible);
  }

  private transferHasAttachments(transfer: DataTransfer | null): boolean {
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    return types.includes("Files")
      || types.includes("application/x-systemsculpt-similar-note")
      || (transfer.files?.length ?? 0) > 0
      || this.vault?.isDraggingVaultFiles() === true;
  }

  private filesFromTransfer(transfer: DataTransfer | null): File[] {
    if (!transfer) return [];
    const files = Array.from(transfer.files ?? []);
    if (files.length > 0) return files;
    return Array.from(transfer.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((item): item is File => item !== null);
  }

  private similarNotePathFromTransfer(transfer: DataTransfer | null): string | null {
    if (!transfer || !Array.from(transfer.types ?? []).includes("application/x-systemsculpt-similar-note")) return null;
    try {
      const parsed: unknown = JSON.parse(transfer.getData("application/x-systemsculpt-similar-note"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const path = (parsed as Record<string, unknown>).path;
      if (typeof path !== "string" || !path.trim() || path.length > 1024 || containsControlCharacters(path, true)) return null;
      return path.trim();
    } catch {
      return null;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

type ChipMenuItem = Readonly<{
  title: string;
  icon: string;
  run: () => void;
}>;
