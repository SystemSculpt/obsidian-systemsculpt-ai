import { App, MarkdownView, Platform, TFile } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type { ToolCallRequest } from "../types/toolCalls";
import {
  QuickEditController,
  type QuickEditState,
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
import { errorLogger } from "../utils/errorLogger";

type StatusTone = "info" | "success" | "error";

interface QuickFileEditModalStartContext {
  file?: TFile | null;
  selection?: QuickEditSelection;
}

export class QuickFileEditModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private controller: QuickEditController;
  private runtime: QuickEditRuntime;

  private inputEl: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;
  private responseEl: HTMLElement | null = null;
  private inputText = "";
  private isStreaming = false;
  private activeFile: TFile | null = null;
  private capturedSelection: QuickEditSelection | undefined = undefined;
  private capturedSelectionFilePath: string | null = null;
  private currentState: QuickEditState = "idle";
  private boundModalKeydown: (event: KeyboardEvent) => void;
  private boundReviewComplete: (event: Event) => void;
  private boundGlobalKeydown: (event: KeyboardEvent) => void;

  private previewButton: HTMLButtonElement | null = null;
  private stopButton: HTMLButtonElement | null = null;
  private applyButton: HTMLButtonElement | null = null;
  private discardButton: HTMLButtonElement | null = null;

  private previewNonce = 0;
  private previewFilePath: string | null = null;
  private responseContent = "";

  constructor(app: App, plugin: SystemSculptPlugin, context?: QuickFileEditModalStartContext) {
    super(app);
    this.plugin = plugin;
    this.setSize("medium");
    this.activeFile = context?.file ?? null;
    this.capturedSelection = context?.selection;
    this.capturedSelectionFilePath = context?.file?.path ?? null;

    this.runtime = createQuickEditRuntime(this.app, this.plugin);
    this.controller = this.runtime.controller;

    this.bindControllerEvents();
    this.boundModalKeydown = (event: KeyboardEvent) => {
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

  onOpen(): void {
    super.onOpen();
    this.addTitle("Quick Edit", "Describe the change, then apply.");

    const container = this.contentEl.createDiv({ cls: "ss-quick-edit-modal" });

    this.inputEl = container.createEl("textarea", {
      cls: "ss-quick-edit-modal__input",
      attr: {
        rows: "4",
        placeholder: "Describe the change… (e.g., “Rewrite intro for clarity, add summary at end”).",
      },
    });
    this.inputEl.addEventListener("input", (e) => {
      this.inputText = (e.target as HTMLTextAreaElement).value;
    });

    this.statusEl = container.createDiv({ cls: "ss-quick-edit-modal__status" });
    this.responseEl = container.createDiv({ cls: "ss-quick-edit-modal__response" });
    if (this.responseEl) {
      this.responseEl.style.display = "none";
    }
    this.syncTargetFromWorkspace();

    this.previewButton = this.addActionButton("Preview changes", () => void this.submit(), true, "settings");
    this.stopButton = this.addActionButton("Stop", () => this.cancelRun(), false, "x-circle");
    this.applyButton = this.addActionButton("Apply all", () => void this.applyAllPendingEdits(), true, "check");
    if (this.applyButton && !Platform.isMobile) {
      this.applyButton.createSpan({
        cls: "systemsculpt-shortcut-hint",
        text: Platform.isMacOS ? " (⌘+Enter)" : " (Ctrl+Enter)",
      });
    }
    this.discardButton = this.addActionButton("Discard all", () => this.discardAllPendingEdits(), false, "x");

    this.toggleButtonVisibility(this.stopButton, false);
    this.toggleButtonVisibility(this.applyButton, false);
    this.toggleButtonVisibility(this.discardButton, false);

    if (this.modalEl) {
      this.registerDomEvent(this.modalEl, "keydown", this.boundModalKeydown);
    }
    window.addEventListener(QUICK_EDIT_REVIEW_COMPLETE_EVENT, this.boundReviewComplete);
    try {
      document.addEventListener("keydown", this.boundGlobalKeydown, true);
    } catch {}

    setTimeout(() => this.focusInput(), 80);
  }

  private syncTargetFromWorkspace(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file: TFile | null = view?.file ?? this.activeFile ?? this.app.workspace.getActiveFile();

    this.activeFile = file;

    const shouldUpdateStatus = !this.isStreaming && this.currentState !== "awaiting-confirmation";
    if (!shouldUpdateStatus) return;

    if (!file) {
      this.updateStatus("Open a note to use Quick Edit.", "error");
      return;
    }

    this.updateStatus(`Quick editing: ${file.basename}`, "info");
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

  onClose(): void {
    super.onClose();
    this.controller.cancel();
    try {
      window.removeEventListener(QUICK_EDIT_REVIEW_COMPLETE_EVENT, this.boundReviewComplete);
    } catch {}
    try {
      document.removeEventListener("keydown", this.boundGlobalKeydown, true);
    } catch {}
  }

  private bindControllerEvents(): void {
    this.controller.events.on("state", ({ state, issues, error }) => {
      this.updateStateUI(state, issues, error);
    });

    this.controller.events.on("preview", ({ toolCalls }) => {
      void this.renderPreviewOverlay(toolCalls);
    });

    this.controller.events.on("response", ({ content }) => {
      this.responseContent = content;
      this.renderResponse();
    });
  }

  private updateStateUI(state: QuickEditState, issues?: QuickEditReadinessResult["issues"], error?: Error): void {
    this.currentState = state;
    switch (state) {
      case "checking":
        this.isStreaming = true;
        this.updateStatus("Working…", "info");
        this.toggleInputDisabled(true);
        this.toggleButtonVisibility(this.stopButton, false);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.hideResponse();
        break;
      case "streaming":
        this.isStreaming = true;
        this.updateStatus("Working…", "info");
        this.toggleButtonVisibility(this.stopButton, true);
        this.toggleButtonEnabled(this.stopButton, true);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.hideResponse();
        break;
      case "awaiting-confirmation":
        this.isStreaming = false;
        this.updateStatus("Ready to apply.", "info");
        this.toggleInputDisabled(true);
        this.toggleButtonVisibility(this.stopButton, false);
        this.toggleButtonVisibility(this.applyButton, true);
        this.toggleButtonVisibility(this.discardButton, true);
        this.toggleButtonEnabled(this.applyButton, true);
        this.toggleButtonEnabled(this.discardButton, true);
        this.hideResponse();
        break;
      case "responded":
        this.isStreaming = false;
        this.updateStatus("Response ready.", "success");
        this.toggleInputDisabled(false);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.toggleButtonVisibility(this.stopButton, false);
        this.clearDiffPreview();
        this.renderResponse();
        break;
      case "completed":
        this.isStreaming = false;
        this.updateStatus("Done.", "success");
        this.toggleInputDisabled(false);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.toggleButtonVisibility(this.stopButton, false);
        this.clearDiffPreview();
        this.hideResponse();
        this.activeFile = null;
        setTimeout(() => {
          try { this.close(); } catch {}
        }, 900);
        break;
      case "failed":
        this.isStreaming = false;
        this.toggleInputDisabled(false);
        this.toggleButtonVisibility(this.stopButton, false);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.clearDiffPreview();
        this.hideResponse();
        if (issues && issues.length > 0) {
          const lines = issues.map((issue) => `• ${issue.message}${issue.action ? ` (${issue.action})` : ""}`);
          this.updateStatus(lines.join("\n"), "error");
        } else if (error) {
          this.updateStatus(`Quick Edit failed: ${error.message}`, "error");
        } else {
          this.updateStatus("Quick Edit could not run.", "error");
        }
        break;
      case "cancelled":
        this.isStreaming = false;
        this.toggleInputDisabled(false);
        this.toggleButtonVisibility(this.stopButton, false);
        this.toggleButtonVisibility(this.applyButton, false);
        this.toggleButtonVisibility(this.discardButton, false);
        this.updateStatus("Cancelled.", "info");
        this.clearDiffPreview();
        this.hideResponse();
        break;
      default:
        break;
    }
  }

  private updateStatus(message: string, tone: StatusTone = "info"): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `ss-quick-edit-modal__status ss-quick-edit-modal__status--${tone}`;
  }

  private renderResponse(): void {
    if (!this.responseEl) return;
    const content = (this.responseContent || "").trim();
    if (!content) {
      this.hideResponse();
      return;
    }
    this.responseEl.empty();
    this.responseEl.style.display = "block";
    this.responseEl.createDiv({ cls: "ss-quick-edit-modal__response-header", text: "Assistant response:" });
    const body = this.responseEl.createDiv({ cls: "ss-quick-edit-modal__response-body" });
    body.textContent = content;
  }

  private hideResponse(): void {
    if (!this.responseEl) return;
    this.responseEl.empty();
    this.responseEl.style.display = "none";
  }

  private resetForNewRun(): void {
    this.clearDiffPreview();
    this.responseContent = "";
    this.hideResponse();
  }

  private toggleInputDisabled(disabled: boolean): void {
    if (this.inputEl) this.inputEl.disabled = disabled;
    if (this.previewButton) this.previewButton.disabled = disabled;
  }

  private toggleButtonVisibility(button: HTMLButtonElement | null, show: boolean): void {
    if (!button) return;
    button.style.display = show ? "inline-flex" : "none";
  }

  private toggleButtonEnabled(button: HTMLButtonElement | null, enabled: boolean): void {
    if (!button) return;
    button.disabled = !enabled;
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
      console.warn("[QuickFileEditModal] Submit blocked: empty prompt");
      this.updateStatus("Describe the change before running Quick Edit.", "error");
      this.focusInput();
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const resolvedFile: TFile | null =
      activeView?.file ?? this.activeFile ?? this.app.workspace.getActiveFile();
    if (!resolvedFile) {
      console.warn("[QuickFileEditModal] Submit blocked: no file available");
      this.updateStatus("Open a note to use Quick Edit.", "error");
      return;
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
      errorLogger.error("Quick Edit modal start failed", error, {
        source: "QuickFileEditModal",
        method: "submit",
        metadata: { filePath: resolvedFile.path },
      });
      this.updateStatus(`Quick Edit failed: ${error?.message || String(error)}`, "error");
      this.toggleInputDisabled(false);
      this.isStreaming = false;
    }
  }

  private async applyAllPendingEdits(): Promise<void> {
    const filePath = this.previewFilePath || this.activeFile?.path;
    if (!filePath) return;

    this.updateStatus("Applying…", "info");
    try {
      const applied = applyAllQuickEditDiffInEditors(this.app, filePath);
      if (!applied) {
        this.updateStatus("Unable to apply changes.", "error");
        return;
      }
      this.controller.complete();
    } catch (error: any) {
      errorLogger.error("Quick Edit modal apply-all failed", error, {
        source: "QuickFileEditModal",
        method: "applyAllPendingEdits",
      });
      this.updateStatus(`Unable to apply changes: ${error?.message || String(error)}`, "error");
      this.toggleButtonEnabled(this.applyButton, false);
      this.toggleButtonEnabled(this.discardButton, true);
    }
  }

  private discardAllPendingEdits(): void {
    const filePath = this.previewFilePath || this.activeFile?.path;
    if (!filePath) {
      this.close();
      return;
    }

    try {
      discardAllQuickEditDiffInEditors(this.app, filePath);
      this.controller.complete();
    } catch (error: any) {
      errorLogger.error("Quick Edit modal discard-all failed", error, {
        source: "QuickFileEditModal",
        method: "discardAllPendingEdits",
      });
      this.updateStatus(`Unable to discard changes: ${error?.message || String(error)}`, "error");
    }
  }

  private cancelRun(): void {
    if (this.currentState === "idle") {
      this.close();
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
      const applied = applyQuickEditDiffToEditors(this.app, preview.path, preview.diff, preview.newContent);
      if (applied === 0) {
        console.warn("[QuickFileEditModal] No active editor found to render diff overlay", {
          filePath: preview.path,
        });
        this.updateStatus("Switch this note to edit mode to review/apply changes.", "error");
        this.toggleButtonEnabled(this.applyButton, false);
        this.toggleButtonEnabled(this.discardButton, false);
      }
    } catch (error) {
      errorLogger.warn("[QuickFileEditModal] Failed to build diff preview", error);
      if (this.previewNonce !== nonce) return;
      this.updateStatus("Unable to preview changes.", "error");
      this.clearDiffPreview();
    }
  }

}

export async function showQuickFileEditModal(
  app: App,
  plugin: SystemSculptPlugin,
  context?: QuickFileEditModalStartContext
): Promise<void> {
  const modal = new QuickFileEditModal(app, plugin, context);
  modal.open();
}
