import { App, Notice, TFile, MarkdownView } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { AudioTranscriptionModal } from "../../modals/AudioTranscriptionModal";
import { PlatformContext } from "../PlatformContext";
import { CHAT_VIEW_TYPE } from "../../views/chatview/ChatView";
import { TranscriptionService, TranscriptionContext } from "../TranscriptionService";
import { PostProcessingService } from "../PostProcessingService";
import { TranscriptionProgressManager } from "../TranscriptionProgressManager";
import { TranscriptionTitleService } from "./TranscriptionTitleService";

export interface TranscriptionRequest {
  filePath: string;
  isChatContext?: boolean;
  onTranscriptionComplete?: (text: string) => void;
  onStatus?: (status: string) => void;
  onError?: (error: Error) => void;
  useModal?: boolean;
  timestamped?: boolean;
  suppressNotices?: boolean;
}

export class TranscriptionCoordinator {
  private readonly app: App;
  private readonly plugin: SystemSculptPlugin;
  private readonly platform: PlatformContext;
  private readonly transcriptionService: TranscriptionService;
  private readonly postProcessing: PostProcessingService;
  private readonly progressManager: TranscriptionProgressManager;

  constructor(app: App, plugin: SystemSculptPlugin, platform: PlatformContext = PlatformContext.get()) {
    this.app = app;
    this.plugin = plugin;
    this.platform = platform;
    this.transcriptionService = TranscriptionService.getInstance(plugin);
    this.postProcessing = PostProcessingService.getInstance(plugin);
    this.progressManager = TranscriptionProgressManager.getInstance();
  }

  public async start(request: TranscriptionRequest): Promise<string | void> {
    const file = this.resolveRecordingFile(request.filePath);
    const isChat = request.isChatContext ?? this.isChatActive();
    const useModal = request.useModal ?? (!request.onTranscriptionComplete && !request.onStatus);
    const suppressNotices = request.suppressNotices ?? !useModal;

    if (useModal) {
      try {
        const modal = new AudioTranscriptionModal(this.app, {
          file,
          isChat,
          onTranscriptionComplete: (text: string) => {
            this.handleCompletion(text, file, request.onTranscriptionComplete);
          },
          plugin: this.plugin
        });

        modal.open();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.handleError(normalized, request.filePath, suppressNotices);
        throw normalized;
      }
      return;
    }

    try {
      return await this.runInlineTranscription(file, {
        ...request,
        isChatContext: isChat,
        suppressNotices
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      request.onError?.(normalized);
      this.handleError(normalized, request.filePath, suppressNotices);
      throw normalized;
    }
  }

  private resolveRecordingFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      throw new Error("Recording file not found");
    }
    return file;
  }

  private async runInlineTranscription(
    file: TFile,
    request: TranscriptionRequest & { isChatContext: boolean; suppressNotices: boolean }
  ): Promise<string> {
    const progressHandler = this.progressManager.createProgressHandler(file, (_, status) => {
      request.onStatus?.(status);
    });

    const context: TranscriptionContext = {
      ...progressHandler,
      type: request.isChatContext ? "chat" : "note",
      timestamped: request.timestamped,
      suppressNotices: request.suppressNotices
    };

    try {
      request.onStatus?.("Transcribing…");
      const rawText = await this.transcriptionService.transcribeFile(file, context);

      if (this.plugin.settings.postProcessingEnabled) {
        request.onStatus?.("Post-processing…");
      }

      const processedText = this.plugin.settings.postProcessingEnabled
        ? await this.postProcessing.processTranscription(rawText)
        : rawText;

      const finalText = this.composeFinalText(file, rawText, processedText, request.isChatContext);

      request.onStatus?.("Saving transcription…");

      if (!request.isChatContext && this.plugin.settings.autoPasteTranscription) {
        await this.insertTranscribedText(finalText, request.suppressNotices);
      }

      await navigator.clipboard.writeText(finalText).catch(() => {});

      const markdownPath = await this.persistTranscription(file, finalText, processedText);
      this.progressManager.handleCompletion(file.path, markdownPath);

      if (!this.plugin.settings.keepRecordingsAfterTranscription) {
        this.app.vault.delete(file).catch(() => {});
      }

      request.onTranscriptionComplete?.(finalText);
      return finalText;
    } catch (error) {
      this.progressManager.clearProgress(file.path);
      throw error;
    }
  }

  private composeFinalText(file: TFile, rawText: string, processedText: string, isChat: boolean): string {
    const audioPlayerSection = this.plugin.settings.keepRecordingsAfterTranscription
      ? `\n## Audio Recording\n![[${file.path}]]\n\n`
      : "";

    if (this.plugin.settings.cleanTranscriptionOutput || isChat) {
      return processedText;
    }

    if (this.plugin.settings.postProcessingEnabled) {
      return `# Audio Transcription
Source: ${file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${rawText}

## Processed Transcription
${processedText}`;
    }

    return `# Audio Transcription
Source: ${file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${rawText}`;
  }

  private async insertTranscribedText(text: string, suppressNotices: boolean): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor) {
      view.editor.replaceSelection(text);
      if (!suppressNotices) {
        new Notice("✓ Transcription inserted into document");
      }
      return;
    }

    if (!suppressNotices) {
      new Notice("✓ Transcription copied to clipboard (no active editor)");
    }
  }

  private async persistTranscription(file: TFile, content: string, titleSourceText: string): Promise<string> {
    const titleService = TranscriptionTitleService.getInstance(this.plugin);
    const folderPath = file.path.split("/").slice(0, -1).join("/");
    const fallbackBasename = titleService.buildFallbackBasename(file.basename);
    const fallbackPath = folderPath ? `${folderPath}/${fallbackBasename}.md` : `${fallbackBasename}.md`;

    const existingFile = this.app.vault.getAbstractFileByPath(fallbackPath);
    let transcriptionFile: TFile;

    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
      transcriptionFile = existingFile;
    } else {
      transcriptionFile = await this.app.vault.create(fallbackPath, content);
    }

    return await titleService.tryRenameTranscriptionFile(this.app, transcriptionFile, {
      prefix: file.basename,
      transcriptText: titleSourceText,
      extension: "md",
    });
  }

  private handleCompletion(text: string, file: TFile, callback?: (text: string) => void): void {
    try {
      if (callback) {
        callback(text);
      } else {
        new Notice("✓ Transcription complete. Check the transcription modal for results.");
      }

      if (!this.plugin.settings.keepRecordingsAfterTranscription) {
        this.app.vault.delete(file).catch(() => {});
      }
    } catch (error) {
      new Notice(`❌ Failed to process transcription: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isChatActive(): boolean {
    const activeLeaf = this.app.workspace.activeLeaf;
    return activeLeaf?.view?.getViewType() === CHAT_VIEW_TYPE;
  }

  private handleError(error: Error, filePath: string, suppressNotices: boolean = false): void {
    if (suppressNotices) {
      return;
    }

    const isMobile = this.platform.isMobile();
    const fileName = filePath.split("/").pop();
    const message = isMobile
      ? `⚠️ Transcription failed, but your recording "${fileName}" is safely saved`
      : `❌ Transcription failed: ${error.message}`;

    new Notice(message);

    if (isMobile) {
      setTimeout(() => {
        new Notice("💡 You can manually transcribe the recording later from your recordings folder.", 8000);
      }, 1500);
    }
  }
}
