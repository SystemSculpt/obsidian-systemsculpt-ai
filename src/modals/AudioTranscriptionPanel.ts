import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { OperationProgressPanel } from "../core/ui/progress/OperationProgressPanel";
import { TranscriptionCoordinator } from "../services/transcription/TranscriptionCoordinator";
import { formatFileSize } from "../utils/FileValidator";
import { tryCopyToClipboard } from "../utils/clipboard";

export interface AudioTranscriptionPanelOptions {
  file: TFile;
  timestamped?: boolean;
  isChat?: boolean;
  onTranscriptionComplete?: (text: string) => void;
  plugin: SystemSculptPlugin;
}

export class AudioTranscriptionPanel {
  private readonly coordinator: TranscriptionCoordinator;
  private readonly options: AudioTranscriptionPanelOptions;
  private readonly plugin: SystemSculptPlugin;
  private readonly app: App;

  private panel: OperationProgressPanel | null = null;
  private destroyed = false;

  constructor(app: App, options: AudioTranscriptionPanelOptions) {
    this.app = app;
    this.options = options;
    this.plugin = options.plugin;
    this.coordinator = new TranscriptionCoordinator(app, options.plugin);
  }

  open(): void {
    this.render();
    this.updateStatus({
      label: "Preparing audio transcription…",
      icon: "loader-2",
      progress: 2,
    });
    void this.startTranscription();
  }

  close(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.panel?.close();
    this.panel = null;
  }

  private render(): void {
    if (this.panel) {
      return;
    }

    const metaParts: string[] = [this.options.file.name];
    if (typeof this.options.file.stat?.size === "number") {
      metaParts.push(formatFileSize(this.options.file.stat.size));
    }

    this.panel = new OperationProgressPanel({
      title: "Audio transcription",
      icon: "file-audio",
      metaText: metaParts.join(" · "),
      metaIcon: "file-audio",
      dismissLabel: "Hide transcription progress",
    });

    this.setButtons([
      {
        label: "Hide",
        onClick: () => this.close(),
      },
      {
        label: "Cancel",
        onClick: () => {
          this.coordinator.abort();
          this.close();
        },
      },
    ]);

    try {
      if (typeof (this.plugin as any)?.register === "function") {
        (this.plugin as any).register(() => {
          this.coordinator.abort();
          this.close();
        });
      }
    } catch (_) {}
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>
  ): void {
    if (!this.panel || this.destroyed) {
      return;
    }
    this.panel.setActions(descriptors);
  }

  private updateStatus(options: { label: string; icon: string; progress: number; details?: string }): void {
    if (this.destroyed || !this.panel) {
      return;
    }

    this.panel.setStatus({
      label: options.label,
      icon: options.icon,
      progress: clampPercentage(options.progress),
      details: options.details,
      state: resolveProgressState(options.icon),
    });
  }

  private async openOutput(path: string): Promise<void> {
    const output = this.app.vault.getAbstractFileByPath(path);
    if (!(output instanceof TFile)) {
      return;
    }

    try {
      const leaf = (this.app.workspace as any).getLeaf?.("tab");
      if (leaf?.openFile) {
        await leaf.openFile(output);
        (this.app.workspace as any).setActiveLeaf?.(leaf, { focus: true });
      }
    } catch (_) {}
  }

  private async startTranscription(): Promise<void> {
    try {
      let finalPath = "";
      await this.coordinator.start({
        filePath: this.options.file.path,
        isChatContext: this.options.isChat,
        timestamped: this.options.timestamped,
        suppressNotices: true,
        onProgress: (progress, status) => this.updateStatus({
          label: status,
          icon: status.includes("Uploading")
            ? "upload"
            : status.includes("Saving")
              ? "hard-drive"
              : "loader-2",
          progress,
        }),
        onStatus: (status) =>
          this.updateStatus({
            label: status,
            icon: "loader-2",
            progress: status.includes("Saving") ? 92 : 75,
          }),
        onOutput: (path) => {
          finalPath = path;
        },
        onTranscriptionComplete: this.options.onTranscriptionComplete,
      });

      this.updateStatus({
        label: "Transcription complete!",
        icon: "check-circle",
        progress: 100,
        details: `Saved to ${finalPath}`,
      });

      this.setButtons([
        {
          label: "Open note",
          variant: "primary",
          onClick: () => void this.openOutput(finalPath),
        },
        {
          label: "Close",
          onClick: () => this.close(),
        },
      ]);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Transcription failed: ${errorMessage}`, 6000);
      this.updateStatus({
        label: "Transcription failed",
        icon: "x-circle",
        progress: 100,
        details: errorMessage,
      });
      this.setButtons([
        {
          label: "Copy error",
          onClick: async () => {
            try {
              const copied = await tryCopyToClipboard(errorMessage);
              if (copied) {
                new Notice("Error copied to clipboard", 2500);
              } else {
                new Notice("Unable to copy error (clipboard unavailable).", 4000);
              }
            } catch (_) {}
            this.close();
          },
        },
        {
          label: "Close",
          variant: "primary",
          onClick: () => this.close(),
        },
      ]);
    }
  }
}

export function launchAudioTranscriptionPanel(
  app: App,
  options: AudioTranscriptionPanelOptions
): AudioTranscriptionPanel {
  const panel = new AudioTranscriptionPanel(app, options);
  panel.open();
  return panel;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function resolveProgressState(icon: string): "running" | "complete" | "error" {
  if (icon === "check-circle") {
    return "complete";
  }
  if (icon === "x-circle") {
    return "error";
  }
  return "running";
}
