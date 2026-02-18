import { App, MarkdownView, Notice, Platform, TFile } from "obsidian";
import SystemSculptPlugin from "../main";
import { FloatingWidget } from "./FloatingWidget";
import type { ToolCallRequest } from "../types/toolCalls";
import { errorLogger } from "../utils/errorLogger";
import {
  QuickEditController,
  type QuickEditState,
  type QuickEditMoveOperation,
  type QuickEditActivity,
} from "../quick-edit/controller";
import { type QuickEditReadinessResult } from "../quick-edit/capabilities";
import { type QuickEditSelection } from "../quick-edit/prompt-builder";
import { createQuickEditRuntime, type QuickEditRuntime } from "../quick-edit/runtime";
import { getQuickEditKeyAction } from "../quick-edit/keyboard";
import { buildQuickEditDiffPreview } from "../quick-edit/preview";
import {
  applyAllQuickEditDiffInEditors,
  applyQuickEditDiffToEditors,
  clearQuickEditDiffFromEditors,
  discardAllQuickEditDiffInEditors,
  QUICK_EDIT_REVIEW_COMPLETE_EVENT,
} from "../quick-edit/editor-diff";

let cachedWidget: QuickEditWidget | null = null;

type StatusTone = "info" | "success" | "error";

export class QuickEditWidget extends FloatingWidget {
  private inputEl: HTMLTextAreaElement | null = null;
  private primaryButtonEl: HTMLButtonElement | null = null;
  private cancelButtonEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private activityLogEl: HTMLElement | null = null;
  private proposalSummaryEl: HTMLElement | null = null;
  private responseEl: HTMLElement | null = null;

  private inputText = "";
  private controller: QuickEditController;
  private runtime: QuickEditRuntime;
  private isStreaming = false;
  private activeFile: TFile | null = null;
  private capturedSelection: QuickEditSelection | undefined = undefined;
  private capturedSelectionFilePath: string | null = null;
  private currentState: QuickEditState = "idle";
  private boundContainerKeydown: (event: KeyboardEvent) => void;
  private boundReviewComplete: (event: Event) => void;
  private keydownTarget: HTMLElement | null = null;
  private activityLog: string[] = [];

  private confirmRowEl: HTMLElement | null = null;
  private applyButtonEl: HTMLButtonElement | null = null;
  private discardButtonEl: HTMLButtonElement | null = null;

  private previewNonce = 0;
  private previewFilePath: string | null = null;
  private pendingMoveOp: QuickEditMoveOperation | null = null;
  private pendingDiffStats: { additions: number; deletions: number } | null = null;
  private boundGlobalKeydown: (event: KeyboardEvent) => void;
  private responseContent = "";

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app, plugin, {
      title: "Quick Edit",
      icon: "pencil",
      className: "systemsculpt-quick-edit-widget",
      position: { bottom: "20px", right: "20px" },
      width: "360px",
      draggable: true,
    });

    this.runtime = createQuickEditRuntime(this.app, this.plugin);
    this.controller = this.runtime.controller;

    this.bindControllerEvents();
    this.boundContainerKeydown = (event: KeyboardEvent) => {
      const action = getQuickEditKeyAction(event, this.currentState);
      if (action === "none") return;

      if (action === "confirm") {
        event.preventDefault();
        void this.applyAllPendingEdits();
        return;
      }

      if (this.isStreaming) return;
      if (this.inputEl && event.target !== this.inputEl) return;

      event.preventDefault();
      void this.submit();
    };

    this.boundReviewComplete = (event: Event) => {
      if (this.currentState !== "awaiting-confirmation") return;
      const filePath = (event as any)?.detail?.filePath;
      if (!filePath || !this.previewFilePath) return;
      if (filePath !== this.previewFilePath) return;
      this.controller.complete();
    };

    this.boundGlobalKeydown = (event: KeyboardEvent) => {
      if (this.currentState !== "awaiting-confirmation") return;
      if (event.isComposing) return;

      const action = getQuickEditKeyAction(event, this.currentState);
      if (action !== "confirm") return;

      const targetFilePath = this.previewFilePath || this.activeFile?.path;
      if (!targetFilePath) return;

      event.preventDefault();
      event.stopPropagation();
      void this.applyAllPendingEdits();
    };
  }

  protected showMobileVersion(): void {
    (async () => {
      try {
        const { showQuickFileEditModal } = await import("../modals/QuickFileEditModal");
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = activeView?.file ?? this.app.workspace.getActiveFile();
        await showQuickFileEditModal(this.app, this.plugin, {
          file,
          selection: this.captureSelection(activeView),
        });
      } catch (error) {
        errorLogger.error("Failed to open Quick Edit modal on mobile", error, {
          source: "QuickEditWidget",
          method: "showMobileVersion",
        });
        new Notice("Unable to open Quick Edit on mobile.");
      }
    })();
  }

  protected createContent(container: HTMLElement): void {
    container.addClass("ss-quick-edit-container");

    const inputSection = container.createDiv("ss-quick-edit-input-section");

    this.inputEl = inputSection.createEl("textarea", {
      cls: "ss-quick-edit-input",
      attr: {
        rows: "3",
        placeholder: "Describe the change… (e.g., “Rewrite intro for clarity, add summary at end”).",
      },
    });

    this.inputEl.addEventListener("input", (e) => {
      this.inputText = (e.target as HTMLTextAreaElement).value;
    });
    container.addEventListener("keydown", this.boundContainerKeydown, true);
    this.keydownTarget = container;
    window.addEventListener(QUICK_EDIT_REVIEW_COMPLETE_EVENT, this.boundReviewComplete);
    try {
      document.addEventListener("keydown", this.boundGlobalKeydown, true);
    } catch {}

    const actionRow = inputSection.createDiv("ss-quick-edit-action-row");
    this.primaryButtonEl = actionRow.createEl("button", {
      text: "Preview changes",
      cls: "ss-quick-edit-submit-btn",
    }) as HTMLButtonElement;
    this.primaryButtonEl.addEventListener("click", () => void this.submit());

    this.cancelButtonEl = actionRow.createEl("button", {
      text: "Stop",
      cls: "ss-quick-edit-cancel-btn",
    }) as HTMLButtonElement;
    this.cancelButtonEl.style.display = "none";
    this.cancelButtonEl.addEventListener("click", () => this.cancelRun());

    this.statusEl = container.createDiv("ss-quick-edit-status");
    this.syncTargetFromWorkspace();

    this.activityLogEl = container.createDiv("ss-quick-edit-activity-log");
    this.activityLogEl.style.display = "none";

    this.proposalSummaryEl = container.createDiv("ss-quick-edit-proposal-summary");
    this.proposalSummaryEl.style.display = "none";

    this.responseEl = container.createDiv("ss-quick-edit-response");
    this.responseEl.style.display = "none";

    this.confirmRowEl = container.createDiv("ss-quick-edit-confirm-row");
    this.confirmRowEl.style.display = "none";

    this.applyButtonEl = this.confirmRowEl.createEl("button", {
      text: "Apply all",
      cls: "ss-quick-edit-confirm-btn",
    }) as HTMLButtonElement;
    this.applyButtonEl.createSpan({
      cls: "systemsculpt-shortcut-hint",
      text: Platform.isMacOS ? " (⌘+Enter)" : " (Ctrl+Enter)",
    });
    this.applyButtonEl.addEventListener("click", () => void this.applyAllPendingEdits());

    this.discardButtonEl = this.confirmRowEl.createEl("button", {
      text: "Discard all",
      cls: "ss-quick-edit-discard-btn",
    }) as HTMLButtonElement;
    this.discardButtonEl.addEventListener("click", () => this.discardAllPendingEdits());

    setTimeout(() => this.focusInput(), 80);
  }

  private syncTargetFromWorkspace(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file: TFile | null = view?.file ?? this.app.workspace.getActiveFile();

    this.activeFile = file;
    this.capturedSelection = undefined;
    this.capturedSelectionFilePath = null;

    const shouldUpdateStatus = !this.isStreaming && this.currentState !== "awaiting-confirmation";

    if (!file) {
      if (shouldUpdateStatus) {
        this.updateStatus("Open a note to use Quick Edit.", "error");
      }
      return;
    }

    if (view?.file?.path === file.path) {
      this.capturedSelection = this.captureSelection(view);
      this.capturedSelectionFilePath = file.path;
    }

    if (shouldUpdateStatus) {
      this.updateStatus(`Quick editing: ${file.basename}`, "info");
    }
  }

  private findMarkdownViewForFilePath(filePath: string): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path === filePath) return activeView;

    try {
      const leaves = (this.app.workspace as any)?.getLeavesOfType?.("markdown") ?? [];
      for (const leaf of leaves) {
        const view = leaf?.view;
        if (view?.file?.path === filePath) return view as MarkdownView;
      }
    } catch {}

    return null;
  }

  hide(): void {
    try {
      this.controller.cancel();
    } catch {}
    if (this.keydownTarget) {
      this.keydownTarget.removeEventListener("keydown", this.boundContainerKeydown, true);
      this.keydownTarget = null;
    }
    try {
      window.removeEventListener(QUICK_EDIT_REVIEW_COMPLETE_EVENT, this.boundReviewComplete);
    } catch {}
    try {
      document.removeEventListener("keydown", this.boundGlobalKeydown, true);
    } catch {}
    this.clearDiffPreview();
    this.pendingMoveOp = null;
    this.activeFile = null;
    this.capturedSelection = undefined;
    this.capturedSelectionFilePath = null;
    super.hide();
  }

  private bindControllerEvents(): void {
    this.controller.events.on("state", ({ state, issues, error }) => {
      this.updateStateUI(state, issues, error);
    });

    this.controller.events.on("activity", (activity) => {
      this.updateActivityStatus(activity);
    });

    this.controller.events.on("preview", ({ toolCalls, pendingMove }) => {
      this.pendingMoveOp = pendingMove ?? null;
      void this.renderPreviewOverlay(toolCalls);
    });

    this.controller.events.on("response", ({ content }) => {
      this.responseContent = content;
      this.renderResponse();
    });
  }

  private updateActivityStatus(activity: QuickEditActivity): void {
    if (this.currentState === "completed" || this.currentState === "failed" || this.currentState === "cancelled") {
      return;
    }

    let message = "";
    let statusText = "";

    switch (activity.type) {
      case "thinking":
        message = "Analyzing request…";
        statusText = "Thinking…";
        break;
      case "exploring": {
        const folder = activity.folder;
        if (folder && folder !== "/" && folder !== "") {
          message = `Exploring: ${folder}`;
          statusText = `Exploring: ${folder.length > 25 ? "…" + folder.slice(-23) : folder}`;
        } else {
          message = "Exploring vault structure…";
          statusText = "Exploring vault…";
        }
        break;
      }
      case "reading": {
        const file = activity.file;
        if (file) {
          message = `Reading: ${file}`;
          statusText = `Reading: ${file.length > 25 ? "…" + file.slice(-23) : file}`;
        } else {
          message = "Reading files…";
          statusText = "Reading files…";
        }
        break;
      }
      case "deciding":
        message = "Processing exploration…";
        statusText = "Processing…";
        break;
      case "proposing":
        message = "Preparing changes…";
        statusText = "Proposing changes…";
        break;
    }

    if (message && !this.activityLog.includes(message)) {
      this.addActivityLogEntry(message);
    }
    if (statusText && this.isStreaming) {
      this.updateStatus(statusText, "info");
    }
  }

  private addActivityLogEntry(message: string): void {
    this.activityLog.push(message);
    this.renderActivityLog();
  }

  private renderActivityLog(): void {
    if (!this.activityLogEl) return;

    if (this.activityLog.length === 0) {
      this.activityLogEl.style.display = "none";
      return;
    }

    this.activityLogEl.style.display = "block";
    this.activityLogEl.empty();

    const maxVisible = 4;
    const startIndex = Math.max(0, this.activityLog.length - maxVisible);
    const visibleEntries = this.activityLog.slice(startIndex);

    for (let i = 0; i < visibleEntries.length; i++) {
      const entry = visibleEntries[i];
      const isLatest = i === visibleEntries.length - 1;
      const entryEl = this.activityLogEl.createDiv({
        cls: `ss-quick-edit-activity-entry${isLatest ? " ss-quick-edit-activity-entry--active" : ""}`,
      });

      if (isLatest) {
        entryEl.createSpan({ cls: "ss-quick-edit-activity-spinner", text: "◐" });
      } else {
        entryEl.createSpan({ cls: "ss-quick-edit-activity-check", text: "✓" });
      }

      entryEl.createSpan({ cls: "ss-quick-edit-activity-text", text: entry });
    }

    this.activityLogEl.scrollTop = this.activityLogEl.scrollHeight;
  }

  private clearActivityLog(): void {
    this.activityLog = [];
    if (this.activityLogEl) {
      this.activityLogEl.empty();
      this.activityLogEl.style.display = "none";
    }
  }

  private updateStateUI(state: QuickEditState, issues?: QuickEditReadinessResult["issues"], error?: Error): void {
    this.currentState = state;
    switch (state) {
      case "checking":
        this.isStreaming = true;
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        if (this.responseEl) this.responseEl.style.display = "none";
        this.updateStatus("Starting…", "info");
        this.toggleInputDisabled(true);
        this.showCancelButton(false);
        break;
      case "streaming":
        this.isStreaming = true;
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        if (this.responseEl) this.responseEl.style.display = "none";
        if (this.activityLog.length === 0) {
          this.updateStatus("Working…", "info");
        }
        this.showCancelButton(true);
        break;
      case "awaiting-confirmation":
        this.isStreaming = false;
        this.toggleInputDisabled(true);
        this.finalizeActivityLog();
        this.renderProposalSummary();
        this.updateConfirmationStatus();
        this.showCancelButton(false);
        if (this.confirmRowEl) this.confirmRowEl.style.display = "flex";
        if (this.applyButtonEl) this.applyButtonEl.disabled = false;
        if (this.discardButtonEl) this.discardButtonEl.disabled = false;
        if (this.responseEl) this.responseEl.style.display = "none";
        break;
      case "responded":
        this.isStreaming = false;
        this.toggleInputDisabled(false);
        this.showCancelButton(false);
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        this.clearDiffPreview();
        this.clearActivityLog();
        this.updateStatus("Response ready.", "success");
        this.renderResponse();
        break;
      case "completed":
        this.isStreaming = false;
        this.updateStatus("Done!", "success");
        this.toggleInputDisabled(false);
        this.showCancelButton(false);
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        if (this.responseEl) this.responseEl.style.display = "none";
        this.clearActivityLog();
        this.clearDiffPreview();
        this.activeFile = null;
        setTimeout(() => {
          try { this.hide(); } catch {}
        }, 1200);
        break;
      case "failed":
        this.isStreaming = false;
        this.toggleInputDisabled(false);
        this.showCancelButton(false);
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        if (this.responseEl) this.responseEl.style.display = "none";
        this.clearActivityLog();
        this.clearDiffPreview();
        if (issues && issues.length > 0) {
          const lines = issues.map((issue) => `• ${issue.message}${issue.action ? ` (${issue.action})` : ""}`);
          this.updateStatus(lines.join("\n"), "error");
        } else if (error) {
          this.updateStatus(`Failed: ${error.message}`, "error");
        } else {
          this.updateStatus("Quick Edit could not run.", "error");
        }
        break;
      case "cancelled":
        this.isStreaming = false;
        this.toggleInputDisabled(false);
        this.showCancelButton(false);
        this.updateStatus("Cancelled.", "info");
        if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
        if (this.proposalSummaryEl) this.proposalSummaryEl.style.display = "none";
        if (this.responseEl) this.responseEl.style.display = "none";
        this.clearActivityLog();
        this.clearDiffPreview();
        break;
      default:
        break;
    }
  }

  private updateStatus(message: string, tone: StatusTone = "info"): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `ss-quick-edit-status ss-quick-edit-status--${tone}`;
  }

  private updateConfirmationStatus(): void {
    const hasMove = this.pendingMoveOp !== null;
    const hasContentChanges = this.pendingDiffStats &&
      (this.pendingDiffStats.additions > 0 || this.pendingDiffStats.deletions > 0);

    if (hasMove && hasContentChanges) {
      this.updateStatus("Review move and content changes", "info");
    } else if (hasMove) {
      this.updateStatus("Review file move/rename", "info");
    } else if (hasContentChanges) {
      this.updateStatus("Review diff in editor", "info");
    } else {
      this.updateStatus("No changes to apply", "info");
    }
  }

  private finalizeActivityLog(): void {
    if (this.activityLog.length > 0) {
      this.activityLog.push("Ready for review");
    }
    this.renderActivityLog();

    if (this.activityLogEl) {
      const entries = this.activityLogEl.querySelectorAll(".ss-quick-edit-activity-entry");
      entries.forEach((entry) => {
        entry.removeClass("ss-quick-edit-activity-entry--active");
        const spinner = entry.querySelector(".ss-quick-edit-activity-spinner");
        if (spinner) {
          spinner.textContent = "✓";
          spinner.removeClass("ss-quick-edit-activity-spinner");
          spinner.addClass("ss-quick-edit-activity-check");
        }
      });
    }
  }

  private renderProposalSummary(): void {
    if (!this.proposalSummaryEl) return;

    this.proposalSummaryEl.empty();
    const items: string[] = [];

    const move = this.pendingMoveOp;
    if (move) {
      const srcName = move.source.split("/").pop() ?? move.source;
      const dstName = move.destination.split("/").pop() ?? move.destination;
      const srcDir = move.source.split("/").slice(0, -1).join("/") || "(root)";
      const dstDir = move.destination.split("/").slice(0, -1).join("/") || "(root)";
      const isRename = srcDir === dstDir && srcName !== dstName;
      const isRelocate = srcDir !== dstDir;

      if (isRename && !isRelocate) {
        items.push(`📝 Rename: ${srcName} → ${dstName}`);
      } else if (isRelocate && srcName === dstName) {
        items.push(`📁 Move to: ${dstDir}/`);
      } else if (isRelocate) {
        items.push(`📁 Move to: ${dstDir}/`);
        if (srcName !== dstName) {
          items.push(`📝 Rename: ${srcName} → ${dstName}`);
        }
      }
    }

    const stats = this.pendingDiffStats;
    const hasContentChanges = stats && (stats.additions > 0 || stats.deletions > 0);

    if (hasContentChanges) {
      const parts: string[] = [];
      if (stats.additions > 0) parts.push(`+${stats.additions}`);
      if (stats.deletions > 0) parts.push(`-${stats.deletions}`);
      items.push(`✏️ Content: ${parts.join(", ")} lines`);
    }

    if (items.length === 0) {
      items.push("No changes proposed");
    }

    this.proposalSummaryEl.style.display = "block";

    const header = this.proposalSummaryEl.createDiv({ cls: "ss-quick-edit-proposal-header" });
    header.textContent = "Proposed Changes:";

    for (const item of items) {
      const itemEl = this.proposalSummaryEl.createDiv({ cls: "ss-quick-edit-proposal-item" });
      itemEl.textContent = item;
    }
  }

  private renderResponse(): void {
    if (!this.responseEl) return;
    const content = (this.responseContent || "").trim();
    if (!content) {
      this.responseEl.empty();
      this.responseEl.style.display = "none";
      return;
    }
    this.responseEl.empty();
    this.responseEl.style.display = "block";
    this.responseEl.createDiv({ cls: "ss-quick-edit-response-header", text: "Assistant response:" });
    const body = this.responseEl.createDiv({ cls: "ss-quick-edit-response-body" });
    body.textContent = content;
  }

  private resetForNewRun(): void {
    this.clearDiffPreview();
    this.clearActivityLog();
    this.pendingMoveOp = null;
    this.pendingDiffStats = null;
    this.responseContent = "";
    this.renderResponse();
    if (this.confirmRowEl) this.confirmRowEl.style.display = "none";
    if (this.proposalSummaryEl) {
      this.proposalSummaryEl.empty();
      this.proposalSummaryEl.style.display = "none";
    }
    if (this.applyButtonEl) this.applyButtonEl.disabled = false;
    if (this.discardButtonEl) this.discardButtonEl.disabled = false;
  }

  private toggleInputDisabled(disabled: boolean): void {
    if (this.inputEl) this.inputEl.disabled = disabled;
    if (this.primaryButtonEl) this.primaryButtonEl.disabled = disabled;
  }

  private showCancelButton(show: boolean): void {
    if (!this.cancelButtonEl) return;
    this.cancelButtonEl.style.display = show ? "inline-flex" : "none";
    this.cancelButtonEl.disabled = !show;
  }

  private focusInput(): void {
    if (this.inputEl && !this.inputEl.disabled) {
      this.inputEl.focus();
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    }
  }

  private captureSelection(view: MarkdownView | null): QuickEditSelection | undefined {
    const editor: any = view?.editor;
    if (!editor || typeof editor.getSelection !== "function") return undefined;

    const text = editor.getSelection();
    if (!text || text.trim().length === 0) return undefined;

    let range: QuickEditSelection["range"] | undefined;
    if (typeof editor.listSelections === "function") {
      const selections = editor.listSelections();
      if (Array.isArray(selections) && selections.length > 0) {
        const first = selections[0];
        const anchor = first.anchor;
        const head = first.head;
        if (anchor && head) {
          const anchorBefore =
            anchor.line < head.line || (anchor.line === head.line && anchor.ch <= head.ch);
          const start = anchorBefore ? anchor : head;
          const end = anchorBefore ? head : anchor;
          range = {
            startLine: (start.line ?? 0) + 1,
            startColumn: (start.ch ?? 0) + 1,
            endLine: (end.line ?? 0) + 1,
            endColumn: (end.ch ?? 0) + 1,
          };
        }
      }
    }

    return { text, range };
  }

  private async submit(): Promise<void> {
    const prompt = (this.inputText || "").trim();
    if (!prompt) {
      this.updateStatus("Describe the change before running Quick Edit.", "error");
      this.focusInput();
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const resolvedFile: TFile | null =
      activeView?.file ?? this.activeFile ?? this.app.workspace.getActiveFile();
    if (!resolvedFile) {
      this.updateStatus("Open a note to use Quick Edit.", "error");
      return;
    }

    const targetView = this.findMarkdownViewForFilePath(resolvedFile.path);
    if (targetView && targetView.getMode() !== "source") {
      try {
        await targetView.setState({ mode: "source" }, { history: false });
        await new Promise((r) => setTimeout(r, 50));
      } catch {}
    }

    this.activeFile = resolvedFile;
    const selectionView = this.findMarkdownViewForFilePath(resolvedFile.path);
    let selection: QuickEditSelection | undefined;
    if (selectionView) {
      selection = this.captureSelection(selectionView);
      this.capturedSelection = selection;
      this.capturedSelectionFilePath = resolvedFile.path;
    } else if (this.capturedSelectionFilePath === resolvedFile.path) {
      selection = this.capturedSelection;
    }
    this.resetForNewRun();
    this.toggleInputDisabled(true);
    this.updateStatus("Starting Quick Edit…", "info");

    try {
      await this.controller.start({
        plugin: this.plugin,
        file: resolvedFile,
        prompt,
        selection,
        toolCallManager: this.runtime.toolCallManager,
      });
    } catch (error: any) {
      errorLogger.error("Quick Edit start failed", error, {
        source: "QuickEditWidget",
        method: "submit",
        metadata: { filePath: resolvedFile.path },
      });
      this.updateStatus(`Quick Edit failed: ${error?.message || String(error)}`, "error");
      this.toggleInputDisabled(false);
      this.isStreaming = false;
    }
  }

  private normalizeFolderPath(path: string): string {
    return String(path || "")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("/");
  }

  private async ensureFolderPathExists(folderPath: string): Promise<void> {
    const normalized = this.normalizeFolderPath(folderPath);
    if (!normalized) return;

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      await this.app.vault.createFolder(current);
    }
  }

  private async applyAllPendingEdits(): Promise<void> {
    const filePath = this.previewFilePath || this.activeFile?.path;
    if (!filePath) return;

    this.updateStatus("Applying…", "info");
    try {
      const hasContentChanges = this.pendingDiffStats &&
        (this.pendingDiffStats.additions > 0 || this.pendingDiffStats.deletions > 0);
      const hasMove = this.pendingMoveOp !== null;

      if (hasContentChanges) {
        const applied = applyAllQuickEditDiffInEditors(this.app, filePath);
        if (!applied) {
          this.updateStatus("Unable to apply content changes.", "error");
          return;
        }
      }

      if (hasMove && this.pendingMoveOp) {
        const file = this.app.vault.getAbstractFileByPath(this.pendingMoveOp.source);
        if (!file) {
          this.updateStatus(`File not found: ${this.pendingMoveOp.source}`, "error");
          return;
        }
        const destDir = this.pendingMoveOp.destination.split("/").slice(0, -1).join("/");
        if (destDir) {
          await this.ensureFolderPathExists(destDir);
        }
        await this.app.fileManager.renameFile(file, this.pendingMoveOp.destination);
      }

      if (!hasContentChanges && !hasMove) {
        this.updateStatus("No changes to apply.", "info");
        return;
      }

      this.controller.complete();
    } catch (error: any) {
      errorLogger.error("Quick Edit apply-all failed", error, {
        source: "QuickEditWidget",
        method: "applyAllPendingEdits",
      });
      this.updateStatus(`Unable to apply changes: ${error?.message || String(error)}`, "error");
    }
  }

  private discardAllPendingEdits(): void {
    const filePath = this.previewFilePath || this.activeFile?.path;
    if (!filePath) {
      this.hide();
      return;
    }

    try {
      discardAllQuickEditDiffInEditors(this.app, filePath);
      this.controller.complete();
    } catch (error: any) {
      errorLogger.error("Quick Edit discard-all failed", error, {
        source: "QuickEditWidget",
        method: "discardAllPendingEdits",
      });
      this.updateStatus(`Unable to discard changes: ${error?.message || String(error)}`, "error");
    }
  }

  private cancelRun(): void {
    if (this.currentState === "idle") {
      this.hide();
      return;
    }
    this.controller.cancel();
  }

  private clearDiffPreview(): void {
    this.previewNonce += 1;
    if (this.previewFilePath) {
      try {
        clearQuickEditDiffFromEditors(this.app, this.previewFilePath);
      } catch {}
    }
    this.previewFilePath = null;
  }

  private async renderPreviewOverlay(toolCalls: ToolCallRequest[]): Promise<void> {
    if (!this.activeFile) return;

    const file = this.activeFile;
    this.clearDiffPreview();
    const nonce = this.previewNonce;

    try {
      const preview = await buildQuickEditDiffPreview(this.app, file, toolCalls);

      if (this.previewNonce !== nonce) return;
      if (!this.activeFile || this.activeFile.path !== file.path) return;

      this.previewFilePath = preview.path;

      if (preview.diff?.stats) {
        this.pendingDiffStats = {
          additions: preview.diff.stats.additions ?? 0,
          deletions: preview.diff.stats.deletions ?? 0,
        };
      }

      const applied = applyQuickEditDiffToEditors(this.app, preview.path, preview.diff, preview.newContent);

      if (applied === 0) {
        this.updateStatus("Switch this note to edit mode to review/apply changes.", "error");
        if (this.applyButtonEl) this.applyButtonEl.disabled = true;
        if (this.discardButtonEl) this.discardButtonEl.disabled = true;
      }
    } catch (error) {
      errorLogger.warn("[QuickEditWidget] Failed to build diff preview", error);
      if (this.previewNonce !== nonce) return;
      this.updateStatus("Unable to preview changes.", "error");
      this.clearDiffPreview();
    }
  }

}

export function showQuickEditWidget(app: App, plugin: SystemSculptPlugin): QuickEditWidget {
  if (!cachedWidget) {
    cachedWidget = new QuickEditWidget(app, plugin);
  }
  cachedWidget.show();
  return cachedWidget;
}
