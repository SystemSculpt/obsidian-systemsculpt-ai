import { App, Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import SystemSculptPlugin from "../../main";
import {
  WorkflowEngineSettings,
  WorkflowAutomationState,
  WorkflowSkipEntry,
  WorkflowManagedTextOperation,
  createDefaultWorkflowEngineSettings,
} from "../../types";
import { TranscriptionService } from "../TranscriptionService";
import { WORKFLOW_AUTOMATIONS, type WorkflowAutomationDefinition } from "../../constants/workflowAutomations";
import { ManagedTextGenerationError } from "../managed/ManagedTextGenerationAdapter";
import {
  BulkAutomationConfirmModal,
  BulkProgressWidget,
  type PendingAutomationFile,
} from "../../modals/BulkAutomationConfirmModal";

const SUPPORTED_AUDIO_EXTENSIONS = new Set(["wav", "m4a", "mp3", "webm", "ogg"]);
const DEBOUNCE_MS = 800;
const BULK_THRESHOLD = 3;
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 1000;

function createWorkflowOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `workflow:${random}`.slice(0, 128);
}

export interface AutomationBacklogEntry {
  automationId: string;
  automationTitle: string;
  file: TFile;
}

interface PendingFileEvent {
  file: TFile;
  type: "transcription" | "automation";
  automationId?: string;
  automationTitle?: string;
}

export class WorkflowEngineService {
  private readonly plugin: SystemSculptPlugin;
  private readonly app: App;
  private disposed = false;
  private pendingFiles: PendingFileEvent[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isProcessingBulk = false;
  private progressWidget: BulkProgressWidget | null = null;
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

    this.plugin.registerEvent(
      this.app.workspace.on("systemsculpt:settings-updated", () => {
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
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private resetStopState(): void {
    this.stopRequested = false;
    this.stopReason = null;
  }

  private buildSkipKey(
    filePath: string,
    type: "transcription" | "automation",
    automationId?: string
  ): string {
    const id = automationId ?? "default";
    return `${type}::${id}::${filePath}`;
  }

  private getSkipMap(settings: WorkflowEngineSettings): Record<string, WorkflowSkipEntry> {
    return settings.skippedFiles ?? {};
  }

  private isFileSkipped(
    file: TFile,
    type: "transcription" | "automation",
    automationId: string | undefined,
    settings: WorkflowEngineSettings
  ): boolean {
    const skipMap = this.getSkipMap(settings);
    const key = this.buildSkipKey(file.path, type, automationId);
    if (skipMap[key]) {
      return true;
    }
    if (type === "automation" && file.extension.toLowerCase() === "md") {
      const cache = this.app.metadataCache.getFileCache(file);
      const status = cache?.frontmatter?.workflow_status;
      if (status === "skipped") {
        return true;
      }
    }
    return false;
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
      const key = this.buildSkipKey(pending.file.path, pending.type, pending.automationId);
      if (updated[key]) continue;
      updated[key] = {
        path: pending.file.path,
        type: pending.type,
        automationId: pending.automationId,
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

  private buildAutomationFailureNotice(error: unknown): string {
    if (error instanceof ManagedTextGenerationError) {
      if (error.ambiguous) return "Automation paused: the managed generation outcome needs reconciliation.";
      if (error.code === "license_required" || error.code === "license_rejected") {
        return "Automation queued: a valid SystemSculpt license is required.";
      }
      if (error.code === "rate_limited" || error.code === "temporarily_unavailable") {
        return "Automation queued: managed text generation is temporarily unavailable.";
      }
      return `Automation failed: ${error.message}`;
    }

    const message = error instanceof Error ? error.message : String(error ?? "");
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      return `Automation failed: ${trimmed}`;
    }
    return "Automation failed. Check the SystemSculpt console for details.";
  }

  private buildAutomationErrorDetails(error: unknown, skippedCount: number): {
    status: string;
    detailLines: string[];
    copyText?: string;
  } {
    const detailLines: string[] = [];
    let message = "Automation failed.";

    if (error instanceof ManagedTextGenerationError) {
      message = error.message || message;
      detailLines.push(`Operation: ${error.operationId}`);
      detailLines.push(`Code: ${error.code}`);
      if (error.requestId) detailLines.push(`Request ID: ${error.requestId}`);
      if (error.ambiguous) detailLines.push("The request will not be replayed automatically.");
    } else if (error instanceof Error) {
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
    if (error instanceof ManagedTextGenerationError) {
      copyLines.push(`Operation: ${error.operationId}`);
      copyLines.push(`Code: ${error.code}`);
      if (error.requestId) copyLines.push(`Request ID: ${error.requestId}`);
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
      (p) => p.file.path === file.path && p.type === pending.type
    );
    if (isDuplicate) {
      return;
    }

    this.pendingFiles.push(pending);
    this.clearDebounceTimer();

    this.debounceTimer = setTimeout(() => {
      void this.flushPendingFiles();
    }, DEBOUNCE_MS);
  }

  private classifyFile(file: TFile, settings: WorkflowEngineSettings): PendingFileEvent | null {
    const extension = (file.extension || "").toLowerCase();
    if (
      settings.autoTranscribeInboxNotes &&
      this.isFileInInbox(file, settings.inboxFolder) &&
      SUPPORTED_AUDIO_EXTENSIONS.has(extension)
    ) {
      if (this.isFileSkipped(file, "transcription", undefined, settings)) {
        return null;
      }
      return { file, type: "transcription" };
    }

    if (extension !== "md") {
      return null;
    }

    const automations = settings.automations || {};
    for (const [automationId, automation] of Object.entries(automations)) {
      if (!automation?.enabled || !automation.sourceFolder) {
        continue;
      }
      if (!this.isFileInFolder(file.path, automation.sourceFolder)) {
        continue;
      }
      const cache = this.app.metadataCache.getFileCache(file);
      const status = cache?.frontmatter?.workflow_status;
      if (status === "processed" || status === "skipped") {
        continue;
      }
      if (this.isFileSkipped(file, "automation", automationId, settings)) {
        continue;
      }

      const definition = WORKFLOW_AUTOMATIONS.find((d) => d.id === automationId);
      return {
        file,
        type: "automation",
        automationId,
        automationTitle: definition?.title || automationId,
      };
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

    const pendingFiles: PendingAutomationFile[] = files.map((f) => ({
      file: f.file,
      automationType: f.type,
      automationId: f.automationId,
      automationTitle: f.automationTitle,
    }));

    return new Promise<void>((resolve) => {
      const modal = new BulkAutomationConfirmModal({
        app: this.app,
        plugin: this.plugin,
        pendingFiles,
        onConfirm: (confirmed) => {
          const events: PendingFileEvent[] = confirmed.map((c) => ({
            file: c.file,
            type: c.automationType,
            automationId: c.automationId,
            automationTitle: c.automationTitle,
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
            this.plugin.getLogger().info("Bulk workflow processing cancelled by user", {
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
    this.progressWidget = new BulkProgressWidget({
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
    widget: BulkProgressWidget | null,
    abortController?: AbortController
  ): Promise<void> {
    const settings = this.getWorkflowSettings();
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
        automationType: b.type,
        automationId: b.automationId,
        automationTitle: b.automationTitle,
      })));

      for (let j = 0; j < batch.length; j++) {
        const pending = batch[j];
        if (shouldStop()) {
          skippedCount++;
          widget?.markBatchItemSkipped(pending.file, "Skipped");
          continue;
        }

        try {
          await this.processSingleFile(pending, settings, {
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
              metadata: { file: pending.file.path, type: pending.type },
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
        widget.markFailed(this.buildAutomationErrorDetails(this.stopReason.error, skippedCount));
      } else if (this.stopReason?.type === "user") {
        widget.markStopped(this.buildStopDetails(skippedCount));
      } else if (failedCount > 0) {
        widget.markFailed(
          this.buildAutomationErrorDetails(new Error("One or more workflows failed."), skippedCount)
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
    settings: WorkflowEngineSettings,
    options?: { signal?: AbortSignal; showNotices?: boolean }
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (pending.type === "transcription") {
      await this.processTranscription(pending.file, settings, options?.signal, options?.showNotices);
    } else if (pending.automationId) {
      const automation = settings.automations?.[pending.automationId];
      if (automation) {
        await this.processAutomation(pending.file, { ...automation, id: pending.automationId }, {
          signal: options?.signal,
          showNotices: options?.showNotices,
        });
      }
    }
  }

  private async processTranscription(
    file: TFile,
    settings: WorkflowEngineSettings,
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

    const transcript = await transcriptionService.transcribeFile(file, {
      type: "note",
      onProgress: (progress, status) => {
        logger.debug("Workflow inbox transcription progress", {
          source: "WorkflowEngineService",
          metadata: { progress, status, file: file.path },
        });
      },
    });

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    await this.persistTranscription(file, transcript, showNotices);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getWorkflowSettings(): WorkflowEngineSettings {
    return this.plugin.settings.workflowEngine ?? createDefaultWorkflowEngineSettings();
  }

  private managedTextOperationKey(filePath: string, automationId: string): string {
    return `automation::${automationId}::${filePath}`;
  }

  private async persistManagedTextOperation(
    key: string,
    operation: WorkflowManagedTextOperation
  ): Promise<WorkflowManagedTextOperation> {
    const current = this.getWorkflowSettings();
    const updatedEngine: WorkflowEngineSettings = {
      ...current,
      managedTextOperations: {
        ...(current.managedTextOperations ?? {}),
        [key]: operation,
      },
    };
    this.plugin.settings.workflowEngine = updatedEngine;
    const settingsManager = this.plugin.getSettingsManager?.();
    if (settingsManager?.updateSettings) {
      await settingsManager.updateSettings({ workflowEngine: updatedEngine });
    } else {
      await this.plugin.saveSettings();
    }
    return operation;
  }

  private async updateManagedTextOperation(
    key: string,
    operation: WorkflowManagedTextOperation,
    patch: Partial<Pick<WorkflowManagedTextOperation,
      "phase" | "admissionReason" | "errorCode" | "requestId" | "retryable"
    >>
  ): Promise<WorkflowManagedTextOperation> {
    const updated: WorkflowManagedTextOperation = {
      ...operation,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return this.persistManagedTextOperation(key, updated);
  }

  private async getOrCreateManagedTextOperation(
    file: TFile,
    automation: WorkflowAutomationState,
    destinationFolder: string
  ): Promise<{ key: string; operation: WorkflowManagedTextOperation }> {
    const key = this.managedTextOperationKey(file.path, automation.id);
    const existing = this.getWorkflowSettings().managedTextOperations?.[key];
    if (existing) return { key, operation: existing };
    const timestamp = new Date().toISOString();
    const operation: WorkflowManagedTextOperation = {
      operationId: createWorkflowOperationId(),
      automationId: automation.id,
      sourcePath: file.path,
      targetPath: await this.getUniqueRoutePath(file, destinationFolder),
      phase: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return { key, operation: await this.persistManagedTextOperation(key, operation) };
  }

  private throwIfWorkflowAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }

  private isEngineActive(settings: WorkflowEngineSettings): boolean {
    if (settings.enabled) {
      return true;
    }
    if (settings.autoTranscribeInboxNotes) {
      return true;
    }
    const automations = settings.automations || {};
    return Object.values(automations).some((automation) => automation?.enabled);
  }

  public async runAutomationOnFile(
    automationId: string,
    file: TFile,
    options?: { onStatus?: (status: string, progress?: number) => void }
  ): Promise<TFile | null> {
    const settings = this.getWorkflowSettings();
    const automation = settings.automations?.[automationId];
    if (!automation) {
      throw new Error("Automation is missing.");
    }
    if (file.extension.toLowerCase() !== "md") {
      throw new Error("Automations are currently supported only for markdown notes.");
    }
    return await this.processAutomation(file, { ...automation, id: automationId }, options);
  }

  public async getAutomationBacklog(): Promise<AutomationBacklogEntry[]> {
    const settings = this.getWorkflowSettings();
    const definitions = new Map<string, WorkflowAutomationDefinition>(
      WORKFLOW_AUTOMATIONS.map((definition) => [definition.id, definition])
    );
    const backlog: AutomationBacklogEntry[] = [];
    const automations = settings.automations || {};
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const [automationId, automationState] of Object.entries(automations)) {
      const definition = definitions.get(automationId);
      if (!definition) {
        continue;
      }
      const sourceFolder = automationState?.sourceFolder || definition.capturePlaceholder;
      if (!sourceFolder) {
        continue;
      }
      const normalizedFolder = normalizePath(sourceFolder);
      for (const file of markdownFiles) {
        if (!this.isFileInFolder(file.path, normalizedFolder)) {
          continue;
        }
        const cache = this.app.metadataCache.getFileCache(file);
        const status = cache?.frontmatter?.workflow_status;
        if (status === "processed" || status === "skipped") {
          continue;
        }
        if (this.isFileSkipped(file, "automation", automationId, settings)) {
          continue;
        }
        backlog.push({
          automationId,
          automationTitle: definition.title,
          file,
        });
      }
    }

    return backlog;
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

  private async processAutomation(
    file: TFile,
    automation: WorkflowAutomationState,
    options?: {
      onStatus?: (status: string, progress?: number) => void;
      signal?: AbortSignal;
      showNotices?: boolean;
    }
  ): Promise<TFile | null> {
    const destinationFolder = automation.destinationFolder?.trim();
    if (!destinationFolder) {
      return null;
    }

    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const normalizedDestination = normalizePath(destinationFolder);
    const originalPath = file.path;
    const onStatus = options?.onStatus;
    const showNotices = options?.showNotices !== false;

    try {
      const tracked = await this.getOrCreateManagedTextOperation(file, automation, normalizedDestination);
      let operation = tracked.operation;
      const targetPath = operation.targetPath;
      const existingOutput = this.app.vault.getAbstractFileByPath(targetPath);

      if (existingOutput instanceof TFile && ["dispatching", "local_commit_pending", "completed"].includes(operation.phase)) {
        this.throwIfWorkflowAborted(options?.signal);
        await this.applyProcessedMetadata(existingOutput, automation.id, originalPath, targetPath);
        this.throwIfWorkflowAborted(options?.signal);
        await this.upsertFrontmatter(file, {
          workflow_status: "processed",
          workflow_processed_note: this.createWikiLink(targetPath) ?? targetPath,
        });
        this.throwIfWorkflowAborted(options?.signal);
        if (operation.phase !== "completed") {
          operation = await this.updateManagedTextOperation(tracked.key, operation, { phase: "completed" });
        }
        return existingOutput;
      }

      if (operation.phase === "completed") {
        throw new Error("Managed workflow output is recorded as complete but the output note is missing.");
      }
      if (operation.phase === "dispatching") {
        operation = await this.updateManagedTextOperation(tracked.key, operation, {
          phase: "ambiguous",
          errorCode: "ambiguous_outcome",
          retryable: false,
        });
      }
      if (operation.phase === "ambiguous") {
        throw new ManagedTextGenerationError({
          code: "ambiguous_outcome",
          message: "This workflow generation has an unknown server outcome and will not be replayed automatically.",
          operationId: operation.operationId,
          requestId: operation.requestId,
          retryable: false,
          ambiguous: true,
        });
      }
      if (operation.phase === "failed") {
        throw new Error("This workflow generation failed definitively. An explicit retry must create a new operation.");
      }

      onStatus?.("Generating automation output…", 40);
      let result;
      try {
        result = await this.plugin.getManagedCapabilityClient().generateText({
          operationId: operation.operationId,
          purpose: "workflow_automation",
          signal: options?.signal,
          buildMessages: async () => {
            this.throwIfWorkflowAborted(options?.signal);
            onStatus?.(`Reading ${file.basename}…`, 55);
            const sourceContent = await this.app.vault.read(file);
            this.throwIfWorkflowAborted(options?.signal);
            const automationPrompt = automation.systemPrompt?.trim()
              || "You are a note-processing assistant. Given a source note, create a cleaned, well-structured Markdown note that captures the key ideas and action items.";
            const systemPrompt = `${automationPrompt}

You are operating inside an Obsidian vault. Output a single, self-contained Markdown note suitable for saving as the processed result of this workflow. Do not include YAML frontmatter; the plugin will attach metadata itself.`;
            return [
              { role: "system" as const, content: systemPrompt },
              {
                role: "user" as const,
                content: `Workflow ID: ${automation.id}
Source note path: ${file.path}

--- SOURCE NOTE CONTENT ---
${sourceContent}
--- END SOURCE NOTE CONTENT ---`,
              },
            ];
          },
          onDispatch: async () => {
            operation = await this.updateManagedTextOperation(tracked.key, operation, {
              phase: "dispatching",
              admissionReason: undefined,
              errorCode: undefined,
              retryable: undefined,
            });
            onStatus?.("Generating draft…", 70);
          },
        });
      } catch (error) {
        if (error instanceof ManagedTextGenerationError) {
          if (error.ambiguous) {
            operation = await this.updateManagedTextOperation(tracked.key, operation, {
              phase: "ambiguous",
              errorCode: error.code,
              requestId: error.requestId ?? undefined,
              retryable: false,
            });
          } else if (error.code === "local_aborted") {
            operation = await this.updateManagedTextOperation(tracked.key, operation, { phase: "queued" });
          } else if (["license_required", "license_rejected", "temporarily_unavailable", "rate_limited", "capability_unavailable"].includes(error.code)) {
            operation = await this.updateManagedTextOperation(tracked.key, operation, {
              phase: "queued",
              admissionReason: error.code,
              requestId: error.requestId ?? undefined,
              retryable: error.retryable,
            });
          } else {
            operation = await this.updateManagedTextOperation(tracked.key, operation, {
              phase: "failed",
              errorCode: error.code,
              requestId: error.requestId ?? undefined,
              retryable: error.retryable,
            });
          }
        } else if (this.isAbortError(error)) {
          operation = await this.updateManagedTextOperation(tracked.key, operation, { phase: "queued" });
        } else {
          operation = await this.updateManagedTextOperation(tracked.key, operation, {
            phase: "failed",
            errorCode: "local_failure",
            retryable: false,
          });
        }
        throw error;
      }

      this.throwIfWorkflowAborted(options?.signal);
      const generatedContent = result.text.trim();
      if (!generatedContent) {
        operation = await this.updateManagedTextOperation(tracked.key, operation, {
          phase: "failed",
          errorCode: "invalid_response",
          requestId: result.requestId,
          retryable: false,
        });
        throw new ManagedTextGenerationError({
          code: "invalid_response",
          message: "Managed text generation returned empty workflow content.",
          operationId: operation.operationId,
          requestId: result.requestId,
          retryable: false,
        });
      }

      onStatus?.("Saving generated note…", 85);
      await this.plugin.createDirectoryOnce(normalizedDestination);
      this.throwIfWorkflowAborted(options?.signal);
      const finalContent = generatedContent.endsWith("\n") ? generatedContent : `${generatedContent}\n`;
      const created = await this.app.vault.create(targetPath, finalContent);
      if (!(created instanceof TFile)) throw new Error("Managed workflow output was not created as a file.");
      this.throwIfWorkflowAborted(options?.signal);
      operation = await this.updateManagedTextOperation(tracked.key, operation, {
        phase: "local_commit_pending",
        requestId: result.requestId,
      });
      this.throwIfWorkflowAborted(options?.signal);
      await this.applyProcessedMetadata(created, automation.id, originalPath, targetPath);
      this.throwIfWorkflowAborted(options?.signal);
      await this.upsertFrontmatter(file, {
        workflow_status: "processed",
        workflow_processed_note: this.createWikiLink(targetPath) ?? targetPath,
      });
      this.throwIfWorkflowAborted(options?.signal);
      operation = await this.updateManagedTextOperation(tracked.key, operation, { phase: "completed" });

      onStatus?.("Automation complete", 100);
      this.plugin.getLogger().info("Workflow automation created note from source", {
        source: "WorkflowEngineService",
        metadata: {
          workflow: automation.id,
          destination: normalizedDestination,
          targetPath,
          sourcePath: originalPath,
        },
      });
      if (showNotices) {
        new Notice(`Automation created note → ${normalizedDestination}`);
      }
      return created;
    } catch (error) {
      if (this.isAbortError(error)) {
        onStatus?.("Automation stopped", 100);
        this.plugin.getLogger().info("Workflow automation cancelled", {
          source: "WorkflowEngineService",
          metadata: {
            workflow: automation.id,
            destination: normalizedDestination,
            file: file.path,
          },
        });
        throw error;
      }

      onStatus?.("Automation failed", 100);
      this.plugin.getLogger().error("Workflow automation failed", error, {
        source: "WorkflowEngineService",
        metadata: {
          workflow: automation.id,
          destination: normalizedDestination,
          file: file.path,
        },
      });
      if (showNotices) {
        new Notice(this.buildAutomationFailureNotice(error), 6000);
      }
      throw error;
    }
  }

  private async persistTranscription(
    file: TFile,
    transcript: string,
    showNotices: boolean = true
  ): Promise<void> {
    const folderPath = file.parent?.path ?? "";
    const baseName = file.basename || "transcript";
    const targetPath = await this.getAvailableNotePath(folderPath, baseName);
    const noteContent = this.buildTranscriptionNote(file.path, transcript, targetPath);

    await this.app.vault.create(targetPath, noteContent);
    if (showNotices) {
      new Notice(`Transcribed ${file.name} → ${targetPath}`);
    }
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

  private buildTranscriptionNote(sourcePath: string, transcript: string, notePath: string): string {
    const timestamp = new Date().toISOString();
    const processedLink = this.createWikiLink(notePath) ?? notePath;
    const sourceLink = this.createWikiLink(sourcePath) ?? sourcePath;
    const headerLines = [
      "---",
      "workflow: inbox-transcription",
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

  private async getUniqueRoutePath(file: TFile, destinationFolder: string): Promise<string> {
    const baseName = file.name.replace(/\.md$/i, "");
    let attempt = 0;
    let candidate: string;
    do {
      const suffix = attempt === 0 ? "" : ` (${attempt})`;
      const fileName = `${baseName}${suffix}.${file.extension}`;
      candidate = normalizePath(`${destinationFolder}/${fileName}`);
      attempt += 1;
    } while (this.app.vault.getAbstractFileByPath(candidate));
    return candidate;
  }

  private async applyProcessedMetadata(
    file: TFile,
    automationId: string,
    originalPath: string,
    destinationPath: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const entries: Record<string, string> = {
      workflow_status: "processed",
      workflow_processed_at: timestamp,
      workflow_processed_by: automationId,
      workflow_processed_from: this.createWikiLink(originalPath) ?? originalPath,
      workflow_processed_note: this.createWikiLink(destinationPath) ?? destinationPath,
    };
    await this.upsertFrontmatter(file, entries);
  }

  private async upsertFrontmatter(file: TFile, entries: Record<string, string>): Promise<void> {
    type FrontmatterFileManager = {
      processFrontMatter?: (
        target: TFile,
        update: (frontmatter: Record<string, unknown>) => void
      ) => Promise<void>;
    };
    const fileManager = this.app.fileManager as unknown as FrontmatterFileManager;
    const processFrontMatter = fileManager?.processFrontMatter?.bind(fileManager);

    if (processFrontMatter) {
      await processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(entries)) {
          if (value !== undefined && value !== null) {
            (frontmatter as Record<string, unknown>)[key] = value;
          }
        }
      });
      return;
    }

    const content = await this.app.vault.read(file);
    const newContent = this.mergeFrontmatter(content, entries);
    await this.app.vault.modify(file, newContent);
  }

  private mergeFrontmatter(content: string, entries: Record<string, string>): string {
    const values = Object.entries(entries).filter(([, value]) => value);
    const fmLines = values.map(([key, value]) => `${key}: ${value}`).join("\n");

    if (content.startsWith("---\n")) {
      const endIndex = content.indexOf("\n---", 4);
      if (endIndex !== -1) {
        const lines = content.slice(4, endIndex).split("\n");
        for (const [key, value] of values) {
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const index = lines.findIndex((line) => new RegExp(`^${escaped}\\s*:`).test(line));
          const next = `${key}: ${value}`;
          if (index >= 0) lines[index] = next;
          else lines.push(next);
        }
        const fmBody = lines.join("\n");
        const body = content.slice(endIndex + 4);
        const separator = body.startsWith("\n") ? "" : "\n";
        return `---\n${fmBody.trimEnd()}\n---${separator}${body}`;
      }
    }

    return `---\n${fmLines}\n---\n${content}`;
  }

  private createWikiLink(path: string | undefined): string | undefined {
    if (!path) {
      return;
    }
    const trimmed = path.endsWith(".md") ? path.slice(0, -3) : path;
    return `[[${trimmed}]]`;
  }
}
