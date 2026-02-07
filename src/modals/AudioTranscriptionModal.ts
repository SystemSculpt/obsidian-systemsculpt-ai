import { App, Notice, TFile, MarkdownView, setIcon } from "obsidian";
import { TranscriptionService, TranscriptionContext } from "../services/TranscriptionService";
import type SystemSculptPlugin from "../main";
import { PostProcessingService } from "../services/PostProcessingService";
import { TranscriptionTitleService } from "../services/transcription/TranscriptionTitleService";
import { formatFileSize } from "../utils/FileValidator";

export interface AudioTranscriptionOptions {
  file: TFile;
  timestamped?: boolean;
  isChat?: boolean;
  onTranscriptionComplete?: (text: string) => void;
  plugin: SystemSculptPlugin;
}

type TimelineStep = "queued" | "uploading" | "processing" | "saving" | "ready";

const TIMELINE_ORDER: TimelineStep[] = [
  "queued",
  "uploading",
  "processing",
  "saving",
  "ready",
];

const STEP_LABEL: Record<TimelineStep, string> = {
  queued: "Preparing",
  uploading: "Uploading",
  processing: "Transcribing",
  saving: "Saving",
  ready: "Ready",
};

interface StepElements {
  wrapper: HTMLElement;
  icon: HTMLElement;
  label: HTMLElement;
}

export class AudioTranscriptionModal {
  private readonly transcriptionService: TranscriptionService;
  private readonly postProcessingService: PostProcessingService;
  private readonly options: AudioTranscriptionOptions;
  private readonly plugin: SystemSculptPlugin;
  private readonly app: App;

  private readonly startTime = Date.now();
  private destroyed = false;
  private autoCloseTimer: number | null = null;
  private lastStatus = "";

  private readonly container: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly percentLabel: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly steps = new Map<TimelineStep, StepElements>();
  private readonly buttonsContainer: HTMLElement;
  private readonly detailEl: HTMLElement;

  constructor(app: App, options: AudioTranscriptionOptions) {
    this.app = app;
    this.options = options;
    this.plugin = options.plugin;

    this.transcriptionService = TranscriptionService.getInstance(options.plugin);
    this.postProcessingService = PostProcessingService.getInstance(options.plugin);

    this.container = document.body.createDiv({ cls: "systemsculpt-progress-modal" });

    const header = this.container.createDiv({ cls: "systemsculpt-progress-header" });
    const headerIcon = header.createDiv({ cls: "systemsculpt-progress-icon" });
    setIcon(headerIcon, "file-audio");

    const headerContent = header.createDiv({ cls: "systemsculpt-progress-title" });
    headerContent.setText("Audio Transcription");

    const fileMeta = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    const fileIcon = fileMeta.createSpan({ cls: "systemsculpt-progress-status-icon" });
    setIcon(fileIcon, "file");

    const metaText = fileMeta.createSpan();
    const parts: string[] = [options.file.name];
    if (typeof options.file.stat?.size === "number") {
      parts.push(formatFileSize(options.file.stat.size));
    }
    metaText.setText(parts.join(" · "));

    const statusRow = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan({ cls: "systemsculpt-progress-status-text" });
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    const progressTrack = this.container.createDiv({ cls: "systemsculpt-progress-bar-track" });
    this.progressFill = progressTrack.createDiv({ cls: "systemsculpt-progress-bar" });

    const stepsWrapper = this.container.createDiv({ cls: "systemsculpt-progress-steps" });
    TIMELINE_ORDER.forEach((step) => {
      const wrapper = stepsWrapper.createDiv({ cls: "systemsculpt-progress-step" });
      const icon = wrapper.createDiv({ cls: "systemsculpt-progress-step-icon" });
      setIcon(icon, "circle");
      const label = wrapper.createDiv({
        cls: "systemsculpt-progress-step-text",
        text: STEP_LABEL[step],
      });
      this.steps.set(step, { wrapper, icon, label });
    });

    this.detailEl = this.container.createDiv({ cls: "systemsculpt-progress-detail is-hidden" });

    this.buttonsContainer = this.container.createDiv({ cls: "systemsculpt-progress-buttons" });
    this.setButtons([
      {
        label: "Hide",
        onClick: () => this.close(),
      },
    ]);

    if (typeof options.file.stat?.size === "number" && options.file.stat.size > 25 * 1024 * 1024) {
      this.detailEl.removeClass("is-hidden");
      this.detailEl.setText("Large file detected. Uploading in parts, then processing on SystemSculpt servers.");
    }

    this.updateProgress({ progress: 2, status: "Preparing audio transcription...", icon: "loader" });

    // Ensure we clean up if the plugin unloads.
    this.plugin.register(() => this.close());
  }

  open(): void {
    void this.startTranscription();
  }

  close(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (this.autoCloseTimer !== null) {
      window.clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }

    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    } else if (this.container.isConnected) {
      this.container.remove();
    }
  }

  private updateProgress(options: { progress: number; status: string; icon: string }): void {
    if (this.destroyed) {
      return;
    }

    const progress = clampPercentage(options.progress);
    this.progressFill.style.width = `${progress}%`;
    this.percentLabel.setText(`${Math.round(progress)}%`);

    this.statusIcon.empty();
    setIcon(this.statusIcon, options.icon);
    this.lastStatus = options.status;
    this.statusLabel.setText(options.status);

    this.container.removeClass("is-error", "is-complete");

    const step = this.mapStatusToStep(options.status, progress);
    this.updateSteps(step);
  }

  private updateSteps(activeStep: TimelineStep): void {
    const activeIndex = TIMELINE_ORDER.indexOf(activeStep);
    this.steps.forEach((elements, step) => {
      const stepIndex = TIMELINE_ORDER.indexOf(step);
      elements.wrapper.removeClass("active", "completed");

      if (stepIndex < activeIndex) {
        elements.wrapper.addClass("completed");
        elements.icon.empty();
        setIcon(elements.icon, "check");
        return;
      }

      if (stepIndex === activeIndex) {
        elements.wrapper.addClass("active");
        elements.icon.empty();
        setIcon(elements.icon, this.resolveIconForStatus(this.lastStatus, "loader"));
        return;
      }

      elements.icon.empty();
      setIcon(elements.icon, "circle");
    });
  }

  private mapStatusToStep(status: string, progress: number): TimelineStep {
    const normalized = status.toLowerCase();
    if (normalized.includes("error") || normalized.includes("failed")) {
      return "processing";
    }
    if (normalized.includes("upload")) {
      return "uploading";
    }
    if (normalized.includes("post-processing") || normalized.includes("saving") || normalized.includes("writing")) {
      return "saving";
    }
    if (normalized.includes("complete") || progress >= 100) {
      return "ready";
    }
    if (
      normalized.includes("transcrib") ||
      normalized.includes("chunk") ||
      normalized.includes("processing") ||
      normalized.includes("finalizing") ||
      normalized.includes("downloading")
    ) {
      return "processing";
    }
    return "queued";
  }

  private resolveIconForStatus(status: string, fallback: string = "loader"): string {
    const normalized = status.toLowerCase();
    if (normalized.includes("error") || normalized.includes("failed")) return "x-circle";
    if (normalized.includes("complete")) return "check-circle";
    if (normalized.includes("saving") || normalized.includes("writing")) return "hard-drive";
    if (normalized.includes("post-processing")) return "sparkles";
    if (normalized.includes("upload")) return "upload";
    if (normalized.includes("chunk")) return "scissors";
    if (normalized.includes("transcrib")) return "file-audio";
    if (normalized.includes("processing")) return "cpu";
    return fallback;
  }

  private setButtons(descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>): void {
    this.buttonsContainer.empty();
    descriptors.forEach((descriptor) => {
      const button = this.buttonsContainer.createEl("button", {
        cls: "systemsculpt-progress-button" + (descriptor.variant === "primary" ? " primary" : ""),
        text: descriptor.label,
      });
      button.addEventListener("click", descriptor.onClick);
    });
  }

  private scheduleAutoClose(): void {
    if (this.autoCloseTimer !== null) {
      window.clearTimeout(this.autoCloseTimer);
    }
    this.autoCloseTimer = window.setTimeout(() => this.close(), 6000);
  }

  private async insertTranscribedText(text: string): Promise<void> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        view.editor.replaceSelection(text);
        new Notice("Transcription inserted into document");
      } else {
        new Notice("Transcription copied to clipboard (no active editor)");
        await navigator.clipboard.writeText(text);
      }
    } catch (_error) {
      new Notice("Failed to insert transcription");
      await navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  private async openOutput(path: string): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) {
      throw new Error("Transcription output file not found in vault.");
    }
    await this.app.workspace.getLeaf(true).openFile(abstract);
  }

  private async startTranscription(): Promise<void> {
    const transcriptionProgressMax = 85;

    const context: TranscriptionContext = {
      type: this.options.isChat ? "chat" : "note",
      timestamped: this.options.timestamped,
      suppressNotices: true,
      onProgress: (progress: number, status: string) => {
        const clamped = clampPercentage(progress);
        const overall = Math.floor((clamped / 100) * transcriptionProgressMax);
        this.updateProgress({
          progress: overall,
          status,
          icon: this.resolveIconForStatus(status),
        });
      },
    };

    try {
      const rawText = await this.transcriptionService.transcribeFile(this.options.file, context);
      if (!rawText?.trim()) {
        throw new Error("Failed to get transcription text.");
      }

      this.updateProgress({
        progress: 90,
        status: this.plugin.settings.postProcessingEnabled ? "Post-processing transcription..." : "Preparing output...",
        icon: this.plugin.settings.postProcessingEnabled ? "sparkles" : "loader",
      });

      let processedText = rawText;
      if (this.plugin.settings.postProcessingEnabled) {
        processedText = await this.postProcessingService.processTranscription(rawText);
      }

      const finalText = this.composeFinalText(rawText, processedText);

      this.updateProgress({
        progress: 96,
        status: "Saving transcription...",
        icon: "hard-drive",
      });

      if (!this.options.isChat && this.plugin.settings.autoPasteTranscription) {
        await this.insertTranscribedText(finalText);
      }

      await navigator.clipboard.writeText(finalText).catch(() => {});

      const finalPath = await this.persistTranscription(finalText, processedText);

      this.updateProgress({
        progress: 100,
        status: "Transcription complete",
        icon: "check-circle",
      });

      this.container.addClass("is-complete");
      this.detailEl.removeClass("is-hidden");
      const seconds = (Date.now() - this.startTime) / 1000;
      this.detailEl.setText(`Saved to ${finalPath} in ${seconds.toFixed(seconds < 10 ? 1 : 0)}s.`);

      this.setButtons([
        {
          label: "Open transcript",
          variant: "primary",
          onClick: async () => {
            try {
              await this.openOutput(finalPath);
            } catch (error) {
              new Notice("Unable to open transcription file. See console for details.", 4000);
              console.error(error);
            }
            this.close();
          },
        },
        {
          label: "Close",
          onClick: () => this.close(),
        },
      ]);

      // Give callers the content if they want to handle it themselves.
      this.options.onTranscriptionComplete?.(finalText);

      // If nothing is listening, still show a completion notice.
      if (!this.options.onTranscriptionComplete) {
        new Notice("Transcription ready.");
      }

      this.scheduleAutoClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.container.addClass("is-error");
      this.updateProgress({ progress: 100, status: "Transcription failed", icon: "x-circle" });
      this.detailEl.removeClass("is-hidden");
      this.detailEl.setText(message);
      new Notice(`Transcription failed: ${message}`, 6000);

      const supportsClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
      this.setButtons(
        supportsClipboard
          ? [
              {
                label: "Copy error",
                onClick: async () => {
                  await navigator.clipboard.writeText(message).catch(() => {});
                  new Notice("Error copied to clipboard", 2500);
                  this.close();
                },
              },
              {
                label: "Close",
                variant: "primary",
                onClick: () => this.close(),
              },
            ]
          : [
              {
                label: "Close",
                variant: "primary",
                onClick: () => this.close(),
              },
            ]
      );
    }
  }

  private composeFinalText(rawText: string, processedText: string): string {
    const postProcessingEnabled = this.plugin.settings.postProcessingEnabled;

    if (this.plugin.settings.cleanTranscriptionOutput || this.options.isChat) {
      return postProcessingEnabled ? processedText : rawText;
    }

    let audioPlayerSection = "";
    if (this.plugin.settings.keepRecordingsAfterTranscription) {
      audioPlayerSection = `\n## Audio Recording\n![[${this.options.file.path}]]\n\n`;
    }

    if (postProcessingEnabled) {
      return `# Audio Transcription
Source: ${this.options.file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${rawText}

## Processed Transcription
${processedText}`;
    }

    return `# Audio Transcription
Source: ${this.options.file.basename}
Transcribed: ${new Date().toISOString()}

${audioPlayerSection}## Raw Transcription
${rawText}`;
  }

  private async persistTranscription(finalText: string, titleSourceText: string): Promise<string> {
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

    return await titleService.tryRenameTranscriptionFile(this.app, transcriptionFile, {
      prefix: this.options.file.basename,
      transcriptText: titleSourceText,
      extension: "md",
    });
  }
}

export async function showAudioTranscriptionModal(app: App, options: AudioTranscriptionOptions): Promise<void> {
  const modal = new AudioTranscriptionModal(app, options);
  modal.open();
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, value));
}
