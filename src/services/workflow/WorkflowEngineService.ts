import { App, Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import SystemSculptPlugin from "../../main";
import {
  WorkflowEngineSettings,
  WorkflowAutomationState,
  WorkflowSkipEntry,
  createDefaultWorkflowEngineSettings,
  ChatMessage,
} from "../../types";
import { TranscriptionService } from "../TranscriptionService";
import { WORKFLOW_AUTOMATIONS, type WorkflowAutomationDefinition } from "../../constants/workflowTemplates";
import { ensureCanonicalId } from "../../utils/modelUtils";
import { SystemSculptError, ERROR_CODES } from "../../utils/errors";
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
    if (error instanceof SystemSculptError) {
      if (error.code === ERROR_CODES.MODEL_UNAVAILABLE) {
        return "Automation failed: the selected model is unavailable. Choose another model in settings.";
      }
      if (error.code === ERROR_CODES.INVALID_LICENSE) {
        return "Automation failed: invalid API key or authentication error.";
      }
      if (error.code === ERROR_CODES.QUOTA_EXCEEDED) {
        return "Automation failed: rate limit or quota exceeded. Try again later.";
      }
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

    if (error instanceof SystemSculptError) {
      const upstreamMessage = typeof error.metadata?.upstreamMessage === "string"
        ? error.metadata?.upstreamMessage
        : "";
      message = upstreamMessage || error.message || message;
      const provider = error.metadata?.provider;
      const model = error.metadata?.model;
      const endpoint = error.metadata?.endpoint;
      const statusCode = error.metadata?.statusCode;
      const requestId = error.metadata?.requestId;

      const identityParts = [provider, model].filter(Boolean);
      if (identityParts.length > 0) {
        detailLines.push(identityParts.join(" - "));
      }
      if (endpoint) {
        detailLines.push(`Endpoint: ${endpoint}`);
      }
      const metaParts: string[] = [];
      if (statusCode) metaParts.push(`HTTP ${statusCode}`);
      if (requestId) metaParts.push(`Request ID: ${requestId}`);
      if (metaParts.length > 0) {
        detailLines.push(metaParts.join(" - "));
      }

      if (error.metadata?.invalidChatSettings) {
        detailLines.push("Provider rejected the chat settings. Verify the model and request options.");
      } else if (error.metadata?.shouldResubmitWithoutTools) {
        detailLines.push("This model doesn't support tools. Disable tools or pick a tool-capable model.");
      }

      if (error.metadata?.shouldResubmitWithoutImages) {
        detailLines.push("This model doesn't support images. Remove image attachments or pick a vision model.");
      }

      if (error.metadata?.statusCode === 400 && error.metadata?.provider) {
        detailLines.push("Tip: Review your provider settings in Settings → Overview & Setup.");
      }
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
    if (error instanceof SystemSculptError) {
      if (error.metadata?.provider) copyLines.push(`Provider: ${error.metadata.provider}`);
      if (error.metadata?.model) copyLines.push(`Model: ${error.metadata.model}`);
      if (error.metadata?.endpoint) copyLines.push(`Endpoint: ${error.metadata.endpoint}`);
      if (error.metadata?.statusCode) copyLines.push(`Status: ${error.metadata.statusCode}`);
      if (error.metadata?.requestId) copyLines.push(`Request ID: ${error.metadata.requestId}`);
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

    const automations = settings.templates || {};
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
              new Notice(`Skipped ${skippedCount} file${skippedCount > 1 ? "s" : ""}. You can clear skips in Settings -> Automations.`, 7000);
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
      const automation = settings.templates?.[pending.automationId];
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

  private isEngineActive(settings: WorkflowEngineSettings): boolean {
    if (settings.enabled) {
      return true;
    }
    if (settings.autoTranscribeInboxNotes) {
      return true;
    }
    const templates = settings.templates || {};
    return Object.values(templates).some((automation) => automation?.enabled);
  }

  public async runAutomationOnFile(
    automationId: string,
    file: TFile,
    options?: { onStatus?: (status: string, progress?: number) => void }
  ): Promise<TFile | null> {
    const settings = this.getWorkflowSettings();
    const automation = settings.templates?.[automationId];
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
    const templates = settings.templates || {};
    const markdownFiles = this.app.vault.getMarkdownFiles();

    for (const [automationId, automationState] of Object.entries(templates)) {
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
    await this.plugin.createDirectoryOnce(normalizedDestination);
    const originalPath = file.path;
    const targetPath = await this.getUniqueRoutePath(file, normalizedDestination);

    const onStatus = options?.onStatus;
    const showNotices = options?.showNotices !== false;

    try {
      onStatus?.(`Reading ${file.basename}…`, 15);
      const sourceContent = await this.app.vault.read(file);

      onStatus?.("Generating automation output…", 40);
      const generatedContent = await this.generateAutomationContent(
        file,
        automation,
        sourceContent,
        onStatus,
        options?.signal
      );

      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      onStatus?.("Saving generated note…", 85);
      const finalContent = generatedContent.endsWith("\n") ? generatedContent : `${generatedContent}\n`;
      const created = await this.app.vault.create(targetPath, finalContent);

      if (created instanceof TFile) {
        await this.applyProcessedMetadata(
          created,
          automation.id,
          originalPath,
          targetPath
        );
        await this.upsertFrontmatter(file, {
          workflow_status: "processed",
          workflow_processed_note: this.createWikiLink(targetPath) ?? targetPath,
        });
      }

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
      return created instanceof TFile ? created : null;
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

  private async generateAutomationContent(
    file: TFile,
    automation: WorkflowAutomationState,
    sourceContent: string,
    onStatus?: (status: string, progress?: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const logger = this.plugin.getLogger();
    const automationPrompt =
      automation.systemPrompt?.trim() ||
      "You are a note-processing assistant. Given a source note, create a cleaned, well-structured Markdown note that captures the key ideas and action items.";

    const selectedModelId = this.plugin.settings.selectedModelId;
    const modelId = ensureCanonicalId(selectedModelId);
    if (!modelId) {
      throw new Error("No default model is configured for automations. Choose a model in SystemSculpt settings.");
    }

    const systemPrompt = `${automationPrompt}

You are operating inside an Obsidian vault. Output a single, self-contained Markdown note suitable for saving as the processed result of this workflow. Do not include YAML frontmatter; the plugin will attach metadata itself.`;

    const userMessage: ChatMessage = {
      role: "user",
      content: `Workflow ID: ${automation.id}
Source note path: ${file.path}

--- SOURCE NOTE CONTENT ---
${sourceContent}
--- END SOURCE NOTE CONTENT ---`,
      message_id: crypto.randomUUID(),
    };

    let generated = "";

    try {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      onStatus?.("Contacting AI model…", 55);
      const stream = this.plugin.aiService.streamMessage({
        messages: [userMessage],
        model: modelId,
        systemPromptOverride: systemPrompt,
        signal,
      });

      onStatus?.("Generating draft…", 70);
      for await (const event of stream) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (event.type === "content") {
          generated += event.text;
        }
      }
    } catch (error) {
      logger.error("Workflow automation generation failed", error, {
        source: "WorkflowEngineService",
        metadata: {
          workflow: automation.id,
          file: file.path,
          model: modelId,
        },
      });
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const final = generated.trim();
    if (!final) {
      throw new Error("The automation model returned empty content for this note.");
    }

    return final;
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
    const fileManager: any = this.app.fileManager as any;
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
    const fmLines = Object.entries(entries)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    if (content.startsWith("---\n")) {
      const endIndex = content.indexOf("\n---", 4);
      if (endIndex !== -1) {
        const fmBody = content.slice(4, endIndex);
        const body = content.slice(endIndex + 4);
        const merged = [fmBody.trimEnd(), fmLines].filter((block) => block.length > 0).join("\n");
        const separator = body.startsWith("\n") ? "" : "\n";
        return `---\n${merged}\n---${separator}${body}`;
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
