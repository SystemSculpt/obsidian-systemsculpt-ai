import { App, Notice, TFile, MarkdownView } from "obsidian";
import { TranscriptionService } from "../services/TranscriptionService";
import type SystemSculptPlugin from "../main";
import { PostProcessingService } from "../services/PostProcessingService";
import { TranscriptionProgressManager } from "../services/TranscriptionProgressManager";
import { TranscriptionTitleService } from "../services/transcription/TranscriptionTitleService";

export interface AudioTranscriptionOptions {
  file: TFile;
  timestamped?: boolean;
  isChat?: boolean;
  onTranscriptionComplete?: (text: string) => void;
  plugin: SystemSculptPlugin;
}

export class AudioTranscriptionModal {
  private transcriptionService: TranscriptionService;
  private postProcessingService: PostProcessingService;
  private options: AudioTranscriptionOptions;
  private plugin: SystemSculptPlugin;
  private app: App;

  constructor(app: App, options: AudioTranscriptionOptions) {
    this.app = app;
    this.options = options;
    this.plugin = options.plugin;
    this.transcriptionService = TranscriptionService.getInstance(
      options.plugin
    );
    this.postProcessingService = PostProcessingService.getInstance(
      options.plugin
    );
  }

  open(): void {
    new Notice("Processing audio...");
    void this.startTranscription();
  }

  /**
   * Insert transcribed text into the active view
   */
  private insertTranscribedText(text: string): void {
    try {
      // For markdown view, insert directly
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        view.editor.replaceSelection(text);
        new Notice("✓ Transcription inserted into document");
      } else {
        // Fallback to clipboard if no active editor
        new Notice("✓ Transcription copied to clipboard (no active editor)");
        navigator.clipboard.writeText(text);
      }
    } catch (error) {
      new Notice("❌ Failed to insert transcription");

      // Try clipboard as fallback
      try {
        navigator.clipboard.writeText(text);
        new Notice("✓ Transcription copied to clipboard instead");
      } catch (e) {
      }
    }
  }

  private async startTranscription(): Promise<void> {
    const progressManager = TranscriptionProgressManager.getInstance();

    try {
      const progressHandler = progressManager.createProgressHandler(this.options.file);

      const text = await this.transcriptionService.transcribeFile(this.options.file, {
        ...progressHandler,
        type: this.options.isChat ? "chat" : "note",
        timestamped: this.options.timestamped
      });

      if (!text) {
        throw new Error("Failed to get transcription text");
      }

      let finalText = text;
      let processedText = text;

      if (this.plugin.settings.postProcessingEnabled) {
        processedText = await this.postProcessingService.processTranscription(text);
      }

      if (this.plugin.settings.cleanTranscriptionOutput || this.options.isChat) {
        finalText = processedText;
      } else if (this.plugin.settings.postProcessingEnabled) {
        let audioPlayerSection = "";
        if (this.plugin.settings.keepRecordingsAfterTranscription) {
          const audioLink = `![[${this.options.file.path}]]`;
          audioPlayerSection = `
## Audio Recording
${audioLink}

`;
        }

        finalText = `# Audio Transcription
Source: ${this.options.file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${text}

## Processed Transcription
${processedText}`;
      } else {
        let audioPlayerSection = "";
        if (this.plugin.settings.keepRecordingsAfterTranscription) {
          const audioLink = `![[${this.options.file.path}]]`;
          audioPlayerSection = `
## Audio Recording
${audioLink}

`;
        }

        finalText = `# Audio Transcription
Source: ${this.options.file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${text}`;
      }

      if (!this.options.isChat && this.plugin.settings.autoPasteTranscription) {
        this.insertTranscribedText(finalText);
      }

      if (this.options.onTranscriptionComplete) {
        this.options.onTranscriptionComplete(finalText);
      } else {
        const postProcessingEnabled = this.plugin.settings.postProcessingEnabled;
        const completionMessage = postProcessingEnabled
          ? "Transcription ready. Post-processing complete."
          : "Transcription ready.";
        new Notice(completionMessage);
      }

      await navigator.clipboard.writeText(finalText).catch(() => {});

      const titleService = TranscriptionTitleService.getInstance(this.plugin);
      const folderPath = this.options.file.path.split("/").slice(0, -1).join("/");
      const fallbackBasename = titleService.buildFallbackBasename(this.options.file.basename);
      const fallbackPath = folderPath ? `${folderPath}/${fallbackBasename}.md` : `${fallbackBasename}.md`;

      const existingFile = this.app.vault.getAbstractFileByPath(fallbackPath);
      let transcriptionFile: TFile;

      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, finalText);
        transcriptionFile = existingFile;
      } else {
        transcriptionFile = await this.app.vault.create(fallbackPath, finalText);
      }

      const finalPath = await titleService.tryRenameTranscriptionFile(this.app, transcriptionFile, {
        prefix: this.options.file.basename,
        transcriptText: processedText,
        extension: "md",
      });

      progressManager.handleCompletion(this.options.file.path, finalPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Transcription failed: ${errorMessage}`, 6000);
      progressManager.clearProgress(this.options.file.path);
    }
  }
}

export async function showAudioTranscriptionModal(
  app: App,
  options: AudioTranscriptionOptions
): Promise<void> {
  const modal = new AudioTranscriptionModal(app, options);
  modal.open();
}
