import { Component, Notice, setIcon } from "obsidian";
import type { ManagedChatInputLimits } from "../../services/managed/ManagedChatInputLimits";
import {
  CHAT_ATTACHMENT_PICKER_ACCEPT,
  ChatMessageAttachmentCollection,
  type ChatDocumentAttachmentProcessor,
  type ChatMessageAttachment,
} from "./attachments/ChatMessageAttachments";

export type AgentComposerAttachment = Readonly<{
  id: string;
  label: string;
  path?: string;
  kind: "vault" | "file" | "image";
}>;

export type AgentComposerSubmit = Readonly<{
  text: string;
  webSearch: boolean;
  mode: "send" | "queue";
  attachments?: readonly ChatMessageAttachment[];
}>;

export type AgentComposerOptions = Readonly<{
  onSubmit: (submission: AgentComposerSubmit) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onAttach: () => void | Promise<void>;
  onVaultContextDrop?: (path: string) => void | Promise<void>;
  documentAttachmentProcessor?: ChatDocumentAttachmentProcessor;
  attachmentLimits?: ManagedChatInputLimits;
  onMic?: () => void | Promise<void>;
  onRemoveAttachment: (attachment: AgentComposerAttachment) => void | Promise<void>;
  onWebSearchChange?: (enabled: boolean) => void;
  onApprovalModeChange?: (mode: "ask" | "full-access") => void;
}>;

function createButton(parent: HTMLElement, className: string, label: string, icon: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: className,
    attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

/**
 * Native Obsidian prompt composer. It owns only ephemeral input state; the
 * conversation and run lifecycle remain outside the view component.
 */
export class AgentComposer extends Component {
  public readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly attachmentList: HTMLElement;
  private readonly attachButton: HTMLButtonElement;
  private readonly vaultContextButton: HTMLButtonElement;
  private readonly filePicker: HTMLInputElement;
  private readonly webButton: HTMLButtonElement;
  private readonly approvalMode: HTMLSelectElement;
  private readonly micButton: HTMLButtonElement | null;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private running = false;
  private readOnly = false;
  private webSearch = false;
  private submitting = false;
  private attachmentBusy = false;
  private contextAttachments: readonly AgentComposerAttachment[] = [];
  private readonly messageAttachments: ChatMessageAttachmentCollection;

  constructor(parent: HTMLElement, private readonly options: AgentComposerOptions) {
    super();
    this.messageAttachments = new ChatMessageAttachmentCollection(
      undefined,
      options.documentAttachmentProcessor,
      options.attachmentLimits,
    );
    this.element = parent.createDiv({ cls: "systemsculpt-agent-composer" });
    this.attachmentList = this.element.createDiv({
      cls: "systemsculpt-agent-composer-attachments",
      attr: { "aria-label": "Attached files and vault context" },
    });

    const prompt = this.element.createDiv({ cls: "systemsculpt-agent-prompt" });
    this.input = prompt.createEl("textarea", {
      cls: "systemsculpt-agent-prompt-input",
      attr: {
        rows: "1",
        placeholder: "Ask SystemSculpt to work in your vault…",
        "aria-label": "Message SystemSculpt",
      },
    });

    const toolbar = prompt.createDiv({ cls: "systemsculpt-agent-prompt-toolbar" });
    const tools = toolbar.createDiv({ cls: "systemsculpt-agent-prompt-tools" });
    this.attachButton = createButton(tools, "clickable-icon systemsculpt-agent-icon-button", "Attach files", "paperclip");
    this.vaultContextButton = createButton(tools, "clickable-icon systemsculpt-agent-icon-button", "Add vault context", "files");
    this.filePicker = tools.createEl("input", {
      cls: "systemsculpt-agent-file-picker",
      attr: {
        type: "file",
        multiple: "true",
        accept: CHAT_ATTACHMENT_PICKER_ACCEPT,
        tabindex: "-1",
        "aria-hidden": "true",
      },
    });
    this.webButton = createButton(tools, "clickable-icon systemsculpt-agent-icon-button", "Search the web", "globe-2");
    this.webButton.setAttribute("aria-pressed", "false");
    this.approvalMode = tools.createEl("select", {
      cls: "dropdown systemsculpt-agent-approval-mode",
      attr: { "aria-label": "Vault changes", title: "Vault changes" },
    });
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- Familiar product mode name.
    this.approvalMode.createEl("option", { value: "ask", text: "Ask Approval" });
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- Familiar product mode name.
    this.approvalMode.createEl("option", { value: "full-access", text: "Full Access" });
    this.micButton = options.onMic
      ? createButton(tools, "clickable-icon systemsculpt-agent-icon-button", "Record message", "mic")
      : null;

    this.hint = toolbar.createSpan({ cls: "systemsculpt-agent-prompt-hint", text: "Enter to send" });

    const actions = toolbar.createDiv({ cls: "systemsculpt-agent-prompt-actions" });
    this.stopButton = createButton(actions, "clickable-icon systemsculpt-agent-stop", "Stop agent", "square");
    this.sendButton = createButton(actions, "clickable-icon systemsculpt-agent-send", "Send message", "arrow-up");

    this.registerDomEvent(this.input, "input", () => {
      this.resize();
      this.syncControls();
    });
    this.registerDomEvent(this.input, "keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.submit();
    });
    this.registerDomEvent(this.attachButton, "click", () => this.filePicker.click());
    this.registerDomEvent(this.vaultContextButton, "click", () => void this.options.onAttach());
    this.registerDomEvent(this.filePicker, "change", () => {
      const files = Array.from(this.filePicker.files ?? []);
      this.filePicker.value = "";
      void this.ingestFiles(files);
    });
    this.registerDomEvent(this.input, "paste", (event) => {
      const files = this.filesFromTransfer(event.clipboardData);
      if (files.length > 0) void this.ingestFiles(files);
    });
    this.registerDomEvent(this.element, "dragover", (event) => {
      if (!this.transferHasAttachments(event.dataTransfer)) return;
      event.preventDefault();
      this.element.classList.add("is-dragging-files");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.registerDomEvent(this.element, "dragleave", (event) => {
      if (event.relatedTarget instanceof Node && this.element.contains(event.relatedTarget)) return;
      this.element.classList.remove("is-dragging-files");
    });
    this.registerDomEvent(this.element, "drop", (event) => {
      const files = this.filesFromTransfer(event.dataTransfer);
      const vaultPath = this.similarNotePathFromTransfer(event.dataTransfer);
      this.element.classList.remove("is-dragging-files");
      if (files.length === 0 && !vaultPath) return;
      event.preventDefault();
      if (files.length > 0) void this.ingestFiles(files);
      else if (vaultPath) void this.options.onVaultContextDrop?.(vaultPath);
    });
    if (this.micButton) this.registerDomEvent(this.micButton, "click", () => void this.options.onMic?.());
    this.registerDomEvent(this.webButton, "click", () => {
      this.webSearch = !this.webSearch;
      this.webButton.setAttribute("aria-pressed", String(this.webSearch));
      this.webButton.classList.toggle("is-active", this.webSearch);
      this.options.onWebSearchChange?.(this.webSearch);
    });
    this.registerDomEvent(this.approvalMode, "change", () => {
      const mode = this.approvalMode.value === "full-access" ? "full-access" : "ask";
      this.approvalMode.classList.toggle("is-full-access", mode === "full-access");
      this.options.onApprovalModeChange?.(mode);
    });
    this.registerDomEvent(this.sendButton, "click", () => void this.submit());
    this.registerDomEvent(this.stopButton, "click", () => void this.options.onStop());
    this.syncControls();
  }

  public focus(): void {
    this.input.focus();
  }

  public getValue(): string {
    return this.input.value;
  }

  public hasDraft(): boolean {
    return this.input.value.trim().length > 0 || this.messageAttachments.hasEntries();
  }

  public setValue(value: string, options: Readonly<{ focus?: boolean }> = {}): void {
    this.input.value = value;
    this.resize();
    this.syncControls();
    if (options.focus) this.focus();
  }

  public isWebSearchEnabled(): boolean {
    return this.webSearch;
  }

  public setWebSearchEnabled(enabled: boolean): void {
    this.webSearch = enabled;
    this.webButton.setAttribute("aria-pressed", String(enabled));
    this.webButton.classList.toggle("is-active", enabled);
    this.options.onWebSearchChange?.(enabled);
  }

  public setApprovalMode(mode: "ask" | "full-access"): void {
    this.approvalMode.value = mode;
    this.approvalMode.classList.toggle("is-full-access", mode === "full-access");
    this.approvalMode.setAttribute("title", mode === "full-access"
      ? "Full Access: make vault changes without pausing"
      : "Ask Approval before vault changes");
  }

  public setRunning(running: boolean): void {
    this.running = running;
    this.element.classList.toggle("is-running", running);
    this.hint.setText(running ? "Enter to queue" : "Enter to send");
    this.sendButton.setAttribute("aria-label", running ? "Queue follow-up" : "Send message");
    this.sendButton.setAttribute("title", running ? "Queue follow-up" : "Send message");
    setIcon(this.sendButton, running ? "list-plus" : "arrow-up");
    this.syncControls();
  }

  public setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.input.disabled = readOnly;
    this.input.placeholder = readOnly
      ? "This legacy chat is read-only"
      : "Ask SystemSculpt to work in your vault…";
    this.syncControls();
  }

  public setRecording(recording: boolean): void {
    if (!this.micButton) return;
    this.micButton.classList.toggle("is-active", recording);
    this.micButton.setAttribute("aria-pressed", String(recording));
    this.micButton.setAttribute("aria-label", recording ? "Stop recording" : "Record message");
    this.micButton.setAttribute("title", recording ? "Stop recording" : "Record message");
    setIcon(this.micButton, recording ? "square" : "mic");
  }

  public setAttachments(attachments: readonly AgentComposerAttachment[]): void {
    this.contextAttachments = [...attachments];
    this.renderAttachments();
    this.syncControls();
  }

  public setMessageAttachmentLimits(limits: ManagedChatInputLimits): void {
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

  private renderAttachments(): void {
    this.attachmentList.empty();
    const messageAttachments = this.messageAttachments.displaySnapshot();
    this.attachmentList.classList.toggle("is-empty", this.contextAttachments.length + messageAttachments.length === 0);
    for (const attachment of this.contextAttachments) {
      const chip = this.attachmentList.createDiv({ cls: "systemsculpt-agent-attachment is-context" });
      const icon = chip.createSpan({ cls: "systemsculpt-agent-attachment-icon" });
      setIcon(icon, attachment.kind === "image" ? "image" : "file-text");
      chip.createSpan({ cls: "systemsculpt-agent-attachment-label", text: attachment.label });
      const remove = createButton(chip, "clickable-icon systemsculpt-agent-attachment-remove", `Remove ${attachment.label}`, "x");
      // Attachment chips are replaced wholesale. Keeping their listeners on
      // the component cleanup stack would retain every removed chip until the
      // view closes.
      remove.onclick = () => void this.options.onRemoveAttachment(attachment);
    }
    for (const attachment of messageAttachments) {
      const chip = this.attachmentList.createDiv({
        cls: `systemsculpt-agent-attachment is-message is-${attachment.kind} is-${attachment.status}`,
        attr: {
          title: attachment.status === "failed"
            ? attachment.error
            : `${attachment.name} · ${this.formatBytes(attachment.byteLength)}`,
        },
      });
      if (attachment.status === "ready" && attachment.kind === "image" && attachment.contentPart.type === "image_url") {
        chip.createEl("img", {
          cls: "systemsculpt-agent-attachment-preview",
          attr: { src: attachment.contentPart.image_url.url, alt: "" },
        });
      } else {
        const icon = chip.createSpan({ cls: "systemsculpt-agent-attachment-icon" });
        setIcon(icon, attachment.status === "failed" ? "circle-alert" : "file-text");
      }
      chip.createSpan({ cls: "systemsculpt-agent-attachment-label", text: attachment.name });
      if (attachment.status === "failed") {
        const retry = createButton(chip, "clickable-icon systemsculpt-agent-attachment-retry", `Retry ${attachment.name}`, "rotate-cw");
        retry.onclick = () => void this.retryMessageAttachment(attachment.id);
      }
      const remove = createButton(chip, "clickable-icon systemsculpt-agent-attachment-remove", `Remove ${attachment.name}`, "x");
      remove.onclick = () => void this.removeMessageAttachment(attachment.id);
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    const attachments = this.messageAttachments.snapshot();
    if ((!text && attachments.length === 0) || this.readOnly || this.submitting || this.attachmentBusy) return;
    const validation = this.messageAttachments.validateSubmission(text, attachments);
    if (validation.length > 0) {
      for (const problem of validation) new Notice(problem.message, 6000);
      return;
    }
    this.submitting = true;
    this.syncControls();
    try {
      await this.options.onSubmit({
        text,
        webSearch: this.webSearch,
        mode: this.running ? "queue" : "send",
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      this.input.value = "";
      this.messageAttachments.clear();
      this.renderAttachments();
      this.resize();
    } finally {
      this.submitting = false;
      this.syncControls();
    }
  }

  private resize(): void {
    this.input.setCssStyles({ height: "auto" });
    const next = Math.min(Math.max(this.input.scrollHeight, 40), 180);
    this.input.setCssStyles({ height: `${next}px` });
  }

  private syncControls(): void {
    const hasText = this.input.value.trim().length > 0;
    const hasMessage = hasText || this.messageAttachments.hasAny();
    this.sendButton.disabled = this.readOnly || this.submitting || this.attachmentBusy
      || this.messageAttachments.hasBlockingFailures() || !hasMessage;
    this.stopButton.toggleAttribute("hidden", !this.running);
    this.attachButton.disabled = this.readOnly || this.attachmentBusy;
    this.vaultContextButton.disabled = this.readOnly || this.attachmentBusy;
    this.filePicker.disabled = this.readOnly || this.attachmentBusy;
    this.webButton.disabled = this.readOnly;
    this.approvalMode.disabled = this.readOnly || this.running;
    if (this.micButton) this.micButton.disabled = this.readOnly;
    this.element.classList.toggle("is-submitting", this.submitting);
    this.element.classList.toggle("is-processing-attachments", this.attachmentBusy);
  }

  private async ingestFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0 || this.readOnly || this.attachmentBusy) return;
    this.attachmentBusy = true;
    this.syncControls();
    try {
      this.hint.setText("Processing attachments…");
      const result = await this.messageAttachments.addFiles(files, this.input.value);
      for (const problem of result.issues) new Notice(problem.message, 5000);
      this.renderAttachments();
    } finally {
      this.attachmentBusy = false;
      this.hint.setText(this.running ? "Enter to queue" : "Enter to send");
      this.syncControls();
    }
  }

  private async retryMessageAttachment(id: string): Promise<void> {
    if (this.attachmentBusy || this.readOnly) return;
    this.attachmentBusy = true;
    this.hint.setText("Retrying document…");
    this.syncControls();
    try {
      const result = await this.messageAttachments.retry(id, this.input.value);
      for (const problem of result.issues) new Notice(problem.message, 5000);
      this.renderAttachments();
    } finally {
      this.attachmentBusy = false;
      this.hint.setText(this.running ? "Enter to queue" : "Enter to send");
      this.syncControls();
    }
  }

  private async removeMessageAttachment(id: string): Promise<void> {
    try {
      await this.messageAttachments.remove(id);
    } catch {
      new Notice("The attachment recovery record could not be cleaned up.", 5000);
    }
    this.renderAttachments();
    this.syncControls();
  }

  private transferHasAttachments(transfer: DataTransfer | null): boolean {
    if (!transfer) return false;
    const types = Array.from(transfer.types ?? []);
    return types.includes("Files") || types.includes("application/x-systemsculpt-similar-note") || transfer.files.length > 0;
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
      if (typeof path !== "string" || !path.trim() || path.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(path)) return null;
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
