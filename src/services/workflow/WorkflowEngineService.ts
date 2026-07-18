import { App, Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import SystemSculptPlugin from "../../main";
import {
  WorkflowEngineSettings,
  WorkflowSkipEntry,
  createDefaultWorkflowEngineSettings,
} from "../../types";
import { TranscriptionService } from "../TranscriptionService";
import {
  BulkTranscriptionConfirmModal,
  BulkTranscriptionProgressWidget,
  type PendingTranscriptionFile,
} from "../../modals/BulkTranscriptionConfirmModal";
import { isAudioFileExtension } from "../../constants/fileTypes";
import {
  createLocalCommitReceipt,
  verifyLocalCommitReceipt,
} from "../transcription/LocalCommitReceipt";

const DEBOUNCE_MS = 800;
const BULK_THRESHOLD = 3;
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 1000;

interface PendingFileEvent {
  file: TFile;
}

export class WorkflowEngineService {
  private readonly plugin: SystemSculptPlugin;
  private readonly app: App;
  private disposed = false;
  private pendingFiles: PendingFileEvent[] = [];
  private debounceTimer: number | null = null;
  private isProcessingBulk = false;
  private progressWidget: BulkTranscriptionProgressWidget | null = null;
  private abortController: AbortController | null = null;
  private stopRequested = false;
  private stopReason: { type: "user" | "error"; error?: unknown } | null = null;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  initialize(): void {
    this.disposed = false;

    this.plugin.registerEvent(
      this.app.vault.on("create", (file) => {
        void this.handleFileEvent(file);
      })
    );

    this.plugin.registerEvent(
      this.app.vault.on("rename", (file, _oldPath) => {
        void this.handleFileEvent(file);
      })
    );
  }

  destroy(): void {
    this.disposed = true;
    this.requestStop({ type: "user" });
    this.clearDebounceTimer();
    this.pendingFiles = [];
    this.progressWidget?.close();
    this.progressWidget = null;
    this.abortController = null;
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private resetStopState(): void {
    this.stopRequested = false;
    this.stopReason = null;
  }

  private buildSkipKey(filePath: string): string {
    return `transcription::default::${filePath}`;
  }

  private getSkipMap(settings: WorkflowEngineSettings): Record<string, WorkflowSkipEntry> {
    return settings.skippedFiles ?? {};
  }

  private isFileSkipped(
    file: TFile,
    settings: WorkflowEngineSettings
  ): boolean {
    const skipMap = this.getSkipMap(settings);
    return Boolean(skipMap[this.buildSkipKey(file.path)]);
  }

  private async persistSkippedFiles(
    files: PendingFileEvent[],
    reason: string
  ): Promise<number> {
    if (files.length === 0) return 0;
    const settings = this.getWorkflowSettings();
    const existing = this.getSkipMap(settings);
    const updated: Record<string, WorkflowSkipEntry> = { ...existing };
    const timestamp = new Date().toISOString();
    let added = 0;

    for (const pending of files) {
      const key = this.buildSkipKey(pending.file.path);
      if (updated[key]) continue;
      updated[key] = {
        path: pending.file.path,
        type: "transcription",
        skippedAt: timestamp,
        reason,
      };
      added += 1;
    }

    if (added > 0) {
      const updatedEngine = {
        ...settings,
        skippedFiles: updated,
      };
      const settingsManager = this.plugin.getSettingsManager?.();
      if (settingsManager?.updateSettings) {
        await settingsManager.updateSettings({ workflowEngine: updatedEngine });
      } else {
        this.plugin.settings.workflowEngine = updatedEngine;
        await this.plugin.saveSettings();
      }
    }

    return added;
  }

  private requestStop(reason: { type: "user" | "error"; error?: unknown }): void {
    if (this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.stopReason = reason;
    if (this.abortController && !this.abortController.signal.aborted) {
      try {
        this.abortController.abort();
      } catch {}
    }
    if (this.progressWidget) {
      const status = reason.type === "user" ? "Stopping..." : "Stopping after error...";
      this.progressWidget.updateStatus(status);
    }
  }

  private isAbortError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes("abort");
  }

  private buildBatchErrorDetails(error: unknown, skippedCount: number): {
    status: string;
    detailLines: string[];
    copyText?: string;
  } {
    const detailLines: string[] = [];
    let message = "Transcription failed.";

    if (error instanceof Error) {
      message = error.message || message;
    } else if (typeof error !== "undefined") {
      message = String(error);
    }

    const primary = message.split("\n")[0].trim();
    if (primary) {
      detailLines.unshift(primary);
    }

    if (skippedCount > 0) {
      detailLines.push(`Skipped ${skippedCount} remaining file${skippedCount > 1 ? "s" : ""}.`);
    }

    const copyLines: string[] = [];
    if (primary) {
      copyLines.push(primary);
    }
    if (skippedCount > 0) {
      copyLines.push(`Skipped: ${skippedCount}`);
    }

    return {
      status: "Stopped after an error",
      detailLines,
      copyText: copyLines.length > 0 ? copyLines.join("\n") : undefined,
    };
  }

  private buildStopDetails(skippedCount: number): { status: string; detailLines: string[] } {
    const detailLines: string[] = [];
    if (skippedCount > 0) {
      detailLines.push(`Skipped ${skippedCount} remaining file${skippedCount > 1 ? "s" : ""}.`);
    }
    return {
      status: "Stopped by you",
      detailLines,
    };
  }

  private async handleFileEvent(file: TAbstractFile): Promise<void> {
    if (this.disposed || !(file instanceof TFile)) {
      return;
    }

    const settings = this.getWorkflowSettings();
    if (!this.isEngineActive(settings)) {
      return;
    }

    const pending = this.classifyFile(file, settings);
    if (!pending) {
      return;
    }

    const isDuplicate = this.pendingFiles.some(
      (p) => p.file.path === file.path
    );
    if (isDuplicate) {
      return;
    }

    this.pendingFiles.push(pending);
    this.clearDebounceTimer();

    this.debounceTimer = window.setTimeout(() => {
      void this.flushPendingFiles();
    }, DEBOUNCE_MS);
  }

  private classifyFile(file: TFile, settings: WorkflowEngineSettings): PendingFileEvent | null {
    const extension = (file.extension || "").toLowerCase();
    if (
      settings.autoTranscribeInboxNotes &&
      this.isFileInInbox(file, settings.inboxFolder) &&
      isAudioFileExtension(extension)
    ) {
      if (this.isFileSkipped(file, settings)) {
        return null;
      }
      return { file };
    }

    return null;
  }

  private async flushPendingFiles(): Promise<void> {
    if (this.disposed || this.isProcessingBulk || this.pendingFiles.length === 0) {
      return;
    }

    const filesToProcess = [...this.pendingFiles];
    this.pendingFiles = [];
    this.resetStopState();

    if (filesToProcess.length >= BULK_THRESHOLD) {
      await this.showBulkConfirmation(filesToProcess);
    } else {
      await this.processFilesInBatches(filesToProcess, null);
    }
  }

  private async showBulkConfirmation(files: PendingFileEvent[]): Promise<void> {
    this.isProcessingBulk = true;

    const pendingFiles: PendingTranscriptionFile[] = files.map((f) => ({
      file: f.file,
    }));

    return new Promise<void>((resolve) => {
      const modal = new BulkTranscriptionConfirmModal({
        app: this.app,
        pendingFiles,
        onConfirm: (confirmed) => {
          const events: PendingFileEvent[] = confirmed.map((c) => ({
            file: c.file,
          }));
          void this.startBulkProcessing(events).then(() => {
            this.isProcessingBulk = false;
            resolve();
          });
        },
        onCancel: () => {
          void (async () => {
            const skippedCount = await this.persistSkippedFiles(files, "user_skip");
            if (skippedCount > 0) {
              new Notice(`Skipped ${skippedCount} file${skippedCount > 1 ? "s" : ""}. You can clear skips in Settings -> Workflow.`, 7000);
            }
            this.plugin.getLogger().info("Bulk inbox transcription cancelled by user", {
              source: "WorkflowEngineService",
              metadata: { fileCount: files.length, skippedCount },
            });
            this.isProcessingBulk = false;
            resolve();
          })();
        },
      });
      modal.open();
    });
  }

  private async startBulkProcessing(files: PendingFileEvent[]): Promise<void> {
    this.resetStopState();
    this.abortController = new AbortController();
    this.progressWidget = new BulkTranscriptionProgressWidget({
      plugin: this.plugin,
      totalFiles: files.length,
      onStop: () => this.requestStop({ type: "user" }),
    });

    await this.processFilesInBatches(files, this.progressWidget, this.abortController);

    this.abortController = null;
    this.progressWidget = null;
  }

  private async processFilesInBatches(
    files: PendingFileEvent[],
    widget: BulkTranscriptionProgressWidget | null,
    abortController?: AbortController
  ): Promise<void> {
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const controller = abortController ?? new AbortController();
    this.abortController = controller;
    const signal = controller.signal;

    const shouldStop = () => this.disposed || this.stopRequested || signal.aborted;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (shouldStop()) break;

      const batch = files.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(files.length / BATCH_SIZE);

      widget?.updateStatus(`Processing batch ${batchNumber} of ${totalBatches}...`);
      widget?.showCurrentBatch(batch.map((b) => ({
        file: b.file,
      })));

      for (let j = 0; j < batch.length; j++) {
        const pending = batch[j];
        if (shouldStop()) {
          skippedCount++;
          widget?.markBatchItemSkipped(pending.file, "Skipped");
          continue;
        }

        try {
          await this.processSingleFile(pending, {
            signal,
            showNotices: !widget,
          });
          completedCount++;
          widget?.markBatchItemComplete(pending.file);
        } catch (error) {
          if (this.isAbortError(error) || signal.aborted || this.stopReason?.type === "user") {
            skippedCount++;
            widget?.markBatchItemSkipped(pending.file, "Skipped");
          } else {
            failedCount++;
            const message =
              error instanceof Error ? error.message : String(error ?? "Unknown error");
            widget?.markBatchItemError(pending.file, message);
            this.plugin.getLogger().error("Batch item failed", error, {
              source: "WorkflowEngineService",
              metadata: { file: pending.file.path, type: "transcription" },
            });
            this.requestStop({ type: "error", error });
          }
        }

        if (this.stopRequested) {
          for (let k = j + 1; k < batch.length; k++) {
            skippedCount++;
            widget?.markBatchItemSkipped(batch[k].file, "Skipped");
          }
          break;
        }
      }

      widget?.updateProgress(completedCount, failedCount, skippedCount);

      const hasMoreBatches = i + BATCH_SIZE < files.length;
      if (hasMoreBatches && !shouldStop()) {
        await this.delay(INTER_BATCH_DELAY_MS);
      }
    }

    const processedCount = completedCount + failedCount + skippedCount;
    if (processedCount < files.length) {
      skippedCount += files.length - processedCount;
      widget?.updateProgress(completedCount, failedCount, skippedCount);
    }

    if (widget) {
      if (this.stopReason?.type === "error" && this.stopReason.error) {
        widget.markFailed(this.buildBatchErrorDetails(this.stopReason.error, skippedCount));
      } else if (this.stopReason?.type === "user") {
        widget.markStopped(this.buildStopDetails(skippedCount));
      } else if (failedCount > 0) {
        widget.markFailed(
          this.buildBatchErrorDetails(new Error("One or more transcriptions failed."), skippedCount)
        );
      } else {
        widget.markComplete();
      }
    }

    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private async processSingleFile(
    pending: PendingFileEvent,
    options?: { signal?: AbortSignal; showNotices?: boolean }
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    await this.processTranscription(pending.file, options?.signal, options?.showNotices);
  }

  private async processTranscription(
    file: TFile,
    signal?: AbortSignal,
    showNotices: boolean = true
  ): Promise<void> {
    const logger = this.plugin.getLogger();
    const transcriptionService = TranscriptionService.getInstance(this.plugin);

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    logger.debug("WorkflowEngineService auto-transcribing inbox audio", {
      source: "WorkflowEngineService",
      metadata: { file: file.path },
    });

    await transcriptionService.transcribeFile<void>(
      file,
      {
        type: "note",
        callerScope: "workflow-engine/auto-transcription",
        recoveryVariant: "workflow-inbox-transcription-v2",
        recoverLocalCommit: async (receipt) => {
          await verifyLocalCommitReceipt(this.app, receipt, signal);
        },
        signal,
        onProgress: (progress, status) => {
          logger.debug("Workflow inbox transcription progress", {
            source: "WorkflowEngineService",
            metadata: { progress, status, file: file.path },
          });
        },
      },
      async (transcript, operationId) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const persisted = await this.persistTranscription(
          file,
          transcript,
          operationId,
          showNotices,
        );
        const marker = `managed_operation: ${operationId}`;
        return {
          value: undefined,
          receipt: createLocalCommitReceipt(
            persisted.outputPath,
            persisted.storedContent,
            marker,
          ),
        };
      },
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private getWorkflowSettings(): WorkflowEngineSettings {
    return this.plugin.settings.workflowEngine ?? createDefaultWorkflowEngineSettings();
  }

  private isEngineActive(settings: WorkflowEngineSettings): boolean {
    return settings.enabled || settings.autoTranscribeInboxNotes;
  }

  private isFileInInbox(file: TFile, inboxFolder: string): boolean {
    return this.isFileInFolder(file.path, inboxFolder);
  }

  private isFileInFolder(filePath: string, folderPath: string | undefined): boolean {
    if (!folderPath) {
      return false;
    }
    const normalizedFolder = normalizePath(folderPath);
    const normalizedFile = normalizePath(filePath);
    if (normalizedFile === normalizedFolder) {
      return true;
    }
    return normalizedFile.startsWith(`${normalizedFolder}/`);
  }

  private async persistTranscription(
    file: TFile,
    transcript: string,
    operationId: string,
    showNotices: boolean = true
  ): Promise<Readonly<{ outputPath: string; storedContent: string }>> {
    const folderPath = file.parent?.path ?? "";
    const baseName = file.basename || "transcript";
    const existing = await this.findExistingTranscriptionNote(folderPath, operationId);
    if (existing) {
      if (showNotices) {
        new Notice(`Transcribed ${file.name} → ${existing.file.path}`);
      }
      return { outputPath: existing.file.path, storedContent: existing.storedContent };
    }
    const targetPath = await this.getAvailableNotePath(folderPath, baseName);
    const noteContent = this.buildTranscriptionNote(file.path, transcript, targetPath, operationId);

    await this.app.vault.create(targetPath, noteContent);
    if (showNotices) {
      new Notice(`Transcribed ${file.name} → ${targetPath}`);
    }
    return { outputPath: targetPath, storedContent: noteContent };
  }

  private async getAvailableNotePath(folderPath: string, baseName: string): Promise<string> {
    const base = baseName.trim() || "transcript";
    let attempt = 0;
    let candidate: string;
    do {
      const suffix = attempt === 0 ? "" : ` (${attempt})`;
      candidate = normalizePath(folderPath ? `${folderPath}/${base}${suffix}.md` : `${base}${suffix}.md`);
      attempt += 1;
    } while (this.app.vault.getAbstractFileByPath(candidate));
    return candidate;
  }

  private buildTranscriptionNote(
    sourcePath: string,
    transcript: string,
    notePath: string,
    operationId: string,
  ): string {
    const timestamp = new Date().toISOString();
    const processedLink = this.createWikiLink(notePath) ?? notePath;
    const sourceLink = this.createWikiLink(sourcePath) ?? sourcePath;
    const headerLines = [
      "---",
      "workflow: inbox-transcription",
      `managed_operation: ${operationId}`,
      `source: ${sourceLink}`,
      `captured: ${timestamp}`,
      "workflow_status: processed",
      `workflow_processed_at: ${timestamp}`,
      "workflow_processed_by: inbox-transcription",
      `workflow_processed_from: ${sourceLink}`,
      `workflow_processed_note: ${processedLink}`,
      "---",
      "",
      "## Transcript",
      "",
    ];
    return `${headerLines.join("\n")}${transcript.trim()}\n`;
  }

  private async findExistingTranscriptionNote(
    folderPath: string,
    operationId: string,
  ): Promise<Readonly<{ file: TFile; storedContent: string }> | null> {
    const marker = `managed_operation: ${operationId}`;
    const candidates = this.app.vault.getFiles().filter((candidate) => (
      candidate.extension === "md"
      && (candidate.parent?.path ?? "") === folderPath
    ));
    for (const candidate of candidates) {
      const storedContent = await this.app.vault.read(candidate);
      if (storedContent.includes(marker)) {
        return { file: candidate, storedContent };
      }
    }
    return null;
  }

  private createWikiLink(path: string | undefined): string | undefined {
    if (!path) {
      return;
    }
    const trimmed = path.endsWith(".md") ? path.slice(0, -3) : path;
    return `[[${trimmed}]]`;
  }
}
