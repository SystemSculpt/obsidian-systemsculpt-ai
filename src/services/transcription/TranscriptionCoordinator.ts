import { App, MarkdownView, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { PostProcessingService } from "../PostProcessingService";
import { TranscriptionProgressManager } from "../TranscriptionProgressManager";
import { ManagedJobClient } from "../managed/ManagedJobClient";
import { ManagedJobRecoveryStore } from "../managed/ManagedJobRecoveryStore";
import { ObsidianManagedRecoveryAdapter } from "../managed/adapters/ObsidianManagedRecoveryAdapter";
import {
  ManagedTranscriptionAdapter,
  type ManagedTranscriptionContext,
  type ManagedTranscriptionResult,
} from "./ManagedTranscriptionAdapter";
import { TranscriptionTitleService } from "./TranscriptionTitleService";
import { sha256HexFromBytesPortable } from "../../studio/hash";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
});

export interface TranscriptionContext {
  type: "note" | "chat";
  timestamped?: boolean;
  onProgress?: (progress: number, status: string) => void;
  suppressNotices?: boolean;
  signal?: AbortSignal;
}

export interface TranscriptionRequest {
  filePath: string;
  isChatContext?: boolean;
  onTranscriptionComplete?: (text: string) => void | Promise<void>;
  onOutput?: (path: string) => void;
  onStatus?: (status: string) => void;
  onProgress?: (progress: number, status: string) => void;
  onError?: (error: Error) => void;
  /** Presentation is owned by the caller; the coordinator never opens UI. */
  timestamped?: boolean;
  suppressNotices?: boolean;
}

function abortError(): DOMException {
  return new DOMException("Transcription was cancelled locally.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function createOperationId(): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `transcription-${random}`.slice(0, 128);
}

export class TranscriptionCoordinator {
  private readonly postProcessing: PostProcessingService;
  private readonly progressManager: TranscriptionProgressManager;
  private managedAdapter: ManagedTranscriptionAdapter | null;
  private activeController: AbortController | null = null;
  private activeOperationId: string | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: SystemSculptPlugin,
    managedAdapter?: ManagedTranscriptionAdapter,
  ) {
    this.managedAdapter = managedAdapter ?? null;
    this.postProcessing = PostProcessingService.getInstance(plugin);
    this.progressManager = TranscriptionProgressManager.getInstance();
  }

  public abort(): void {
    this.activeController?.abort();
  }

  public getActiveOperationId(): string | null {
    return this.activeOperationId;
  }

  public async transcribeFile(file: TFile, context: TranscriptionContext): Promise<string> {
    const controller = this.replaceActiveController(context.signal);
    const operationId = createOperationId();
    this.activeOperationId = operationId;
    try {
      const result = await this.executeRemote(file.path, context, controller.signal, operationId, file);
      throwIfAborted(controller.signal);
      // Raw callers have not committed a durable output yet. Keep recovery at
      // result_ready so the acknowledged job can still be resumed if their own
      // write fails after this handoff.
      return result.text;
    } finally {
      this.releaseController(controller);
    }
  }

  public async start(request: TranscriptionRequest): Promise<string | void> {
    const isChat = request.isChatContext ?? this.isChatActive();
    const suppressNotices = request.suppressNotices ?? false;

    const controller = this.replaceActiveController();
    const operationId = createOperationId();
    this.activeOperationId = operationId;
    try {
      throwIfAborted(controller.signal);
      let file: TFile | null = null;
      let progressHandler: TranscriptionContext["onProgress"];
      const onProgress = (progress: number, status: string) => {
        if (file && !progressHandler) {
          progressHandler = this.progressManager.createProgressHandler(file, request.onProgress
            ? undefined
            : (_progress, nextStatus) => request.onStatus?.(nextStatus)).onProgress;
        }
        progressHandler?.(progress, status);
        if (request.onProgress) request.onProgress(progress, status);
        else if (!progressHandler) request.onStatus?.(status);
      };
      request.onStatus?.("Preparing transcription…");
      const remote = await this.executeRemote(request.filePath, {
        type: isChat ? "chat" : "note",
        timestamped: request.timestamped,
        suppressNotices,
        onProgress,
      }, controller.signal, operationId, undefined, (resolved) => { file = resolved; });
      throwIfAborted(controller.signal);
      const resolvedFile: TFile = file ?? this.resolveRecordingFile(request.filePath);

      const timestamped = request.timestamped === true;
      if (!timestamped && this.plugin.settings.postProcessingEnabled) request.onStatus?.("Post-processing…");
      const processedText = !timestamped && this.plugin.settings.postProcessingEnabled
        ? await this.postProcessing.processTranscription(remote.text, {
          operationId: `${remote.operationId}:postprocess`,
          signal: controller.signal,
        })
        : remote.text;
      throwIfAborted(controller.signal);
      const finalText = timestamped ? remote.text.trim() : this.composeFinalText(resolvedFile, remote.text, processedText, isChat);

      await this.adapter().beginLocalCommit(remote.operationId, controller.signal);
      throwIfAborted(controller.signal);
      request.onStatus?.("Saving transcription…");
      const outputPath = await this.persistTranscription(resolvedFile, finalText, processedText, timestamped, controller.signal);
      throwIfAborted(controller.signal);
      await this.adapter().completeLocalCommit(remote.operationId, controller.signal);
      throwIfAborted(controller.signal);

      if (!isChat && this.plugin.settings.autoPasteTranscription) {
        await this.insertTranscribedText(finalText, suppressNotices);
        throwIfAborted(controller.signal);
      }
      await navigator.clipboard?.writeText(finalText).catch(() => {});
      throwIfAborted(controller.signal);
      this.progressManager.handleCompletion(resolvedFile.path, outputPath);
      throwIfAborted(controller.signal);
      request.onOutput?.(outputPath);
      throwIfAborted(controller.signal);

      if (!this.plugin.settings.keepRecordingsAfterTranscription) {
        throwIfAborted(controller.signal);
        await this.app.fileManager.trashFile(resolvedFile);
        throwIfAborted(controller.signal);
      }
      throwIfAborted(controller.signal);
      await request.onTranscriptionComplete?.(finalText);
      throwIfAborted(controller.signal);
      if (!suppressNotices) new Notice("Transcription ready.");
      return finalText;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (normalized.name !== "AbortError") request.onError?.(normalized);
      this.progressManager.clearProgress(request.filePath);
      this.handleError(normalized, suppressNotices);
      throw normalized;
    } finally {
      this.releaseController(controller);
    }
  }

  private adapter(): ManagedTranscriptionAdapter {
    if (this.managedAdapter) return this.managedAdapter;
    const graph = this.plugin.getManagedCapabilityGraph();
    const recovery = new ManagedJobRecoveryStore(new ObsidianManagedRecoveryAdapter(this.app));
    this.managedAdapter = new ManagedTranscriptionAdapter({
      admission: graph.admission,
      jobs: new ManagedJobClient(graph.transport).transcription,
      recovery,
    });
    return this.managedAdapter;
  }

  private replaceActiveController(parentSignal?: AbortSignal): AbortController {
    this.activeController?.abort();
    const controller = new AbortController();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.activeController = controller;
    this.activeOperationId = null;
    return controller;
  }

  private releaseController(controller: AbortController): void {
    if (this.activeController === controller) {
      this.activeController = null;
      this.activeOperationId = null;
    }
  }

  private async executeRemote(
    filePath: string,
    context: TranscriptionContext,
    signal: AbortSignal,
    operationId: string,
    knownFile?: TFile,
    onResolved?: (file: TFile) => void,
  ): Promise<ManagedTranscriptionResult> {
    const identity = `vault:${filePath}`;
    const result = await this.adapter().transcribe({
      identity,
      fingerprint: async () => `sha256:${sha256HexFromBytesPortable(new TextEncoder().encode(identity))}`,
      load: async () => {
        throwIfAborted(signal);
        const file = knownFile ?? this.resolveRecordingFile(filePath);
        onResolved?.(file);
        const bytes = await this.app.vault.readBinary(file);
        throwIfAborted(signal);
        const extension = file.extension.toLowerCase();
        return {
          filename: file.name,
          contentType: MIME_TYPES[extension] ?? "application/octet-stream",
          bytes,
        };
      },
    }, {
      operationId,
      timestamped: context.timestamped,
      signal,
      onProgress: context.onProgress,
    } satisfies ManagedTranscriptionContext);
    return result;
  }

  private resolveRecordingFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error("Recording file not found");
    return file;
  }

  private composeFinalText(file: TFile, rawText: string, processedText: string, isChat: boolean): string {
    const audioPlayerSection = this.plugin.settings.keepRecordingsAfterTranscription
      ? `\n## Audio Recording\n![[${file.path}]]\n\n`
      : "";
    if (this.plugin.settings.cleanTranscriptionOutput || isChat) return processedText;
    if (this.plugin.settings.postProcessingEnabled) {
      return `# Audio Transcription\nSource: ${file.basename}\nTranscribed: ${new Date().toISOString()}\n\n${audioPlayerSection}## Raw Transcription\n${rawText}\n\n## Processed Transcription\n${processedText}`;
    }
    return `# Audio Transcription\nSource: ${file.basename}\nTranscribed: ${new Date().toISOString()}\n\n${audioPlayerSection}## Raw Transcription\n${rawText}`;
  }

  private async insertTranscribedText(text: string, suppressNotices: boolean): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor) {
      view.editor.replaceSelection(text);
      if (!suppressNotices) new Notice("✓ transcription inserted into document");
    } else if (!suppressNotices) {
      new Notice("✓ transcription copied to clipboard (no active editor)");
    }
  }

  private async persistTranscription(file: TFile, content: string, titleSourceText: string, timestamped: boolean, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const titleService = TranscriptionTitleService.getInstance(this.plugin);
    const folderPath = file.path.split("/").slice(0, -1).join("/");
    const extension = timestamped ? "srt" : "md";
    const fallbackBasename = timestamped ? file.basename : titleService.buildFallbackBasename(file.basename);
    const fallbackPath = folderPath ? `${folderPath}/${fallbackBasename}.${extension}` : `${fallbackBasename}.${extension}`;
    const existingFile = this.app.vault.getAbstractFileByPath(fallbackPath);
    const output = existingFile instanceof TFile
      ? (await this.app.vault.modify(existingFile, content), existingFile)
      : await this.app.vault.create(fallbackPath, content);
    throwIfAborted(signal);
    if (timestamped) return output.path;
    const finalPath = await titleService.tryRenameTranscriptionFile(this.app, output, {
      prefix: file.basename,
      transcriptText: titleSourceText,
      extension,
    });
    throwIfAborted(signal);
    return finalPath;
  }

  private isChatActive(): boolean {
    return this.app.workspace.activeLeaf?.view?.getViewType() === CHAT_VIEW_TYPE;
  }

  private handleError(error: Error, suppressNotices: boolean): void {
    if (suppressNotices || error.name === "AbortError") return;
    const message = `❌ Transcription failed: ${error.message}`;
    new Notice(message);
  }
}
