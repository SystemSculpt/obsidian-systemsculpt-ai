import { App, Notice, TFile, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";
import { TranscriptionCoordinator } from "../services/transcription/TranscriptionCoordinator";
import { formatFileSize } from "../utils/FileValidator";
import { tryCopyToClipboard } from "../utils/clipboard";

export interface AudioTranscriptionOptions {
  file: TFile;
  timestamped?: boolean;
  isChat?: boolean;
  onTranscriptionComplete?: (text: string) => void;
  plugin: SystemSculptPlugin;
}

export class AudioTranscriptionModal {
  private readonly coordinator: TranscriptionCoordinator;
  private readonly options: AudioTranscriptionOptions;
  private readonly plugin: SystemSculptPlugin;
  private readonly app: App;

  private container: HTMLElement | null = null;
  private statusIcon: HTMLElement | null = null;
  private statusLabel: HTMLElement | null = null;
  private percentLabel: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private buttonsContainer: HTMLElement | null = null;

  private destroyed = false;

  constructor(app: App, options: AudioTranscriptionOptions) {
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
    try {
      if (this.container && this.container.parentElement) {
        this.container.parentElement.removeChild(this.container);
      } else if (this.container?.isConnected) {
        this.container.remove();
      }
    } catch (_) {}

    this.container = null;
    this.statusIcon = null;
    this.statusLabel = null;
    this.percentLabel = null;
    this.progressFill = null;
    this.detailEl = null;
    this.buttonsContainer = null;
  }

  private render(): void {
    if (this.container) {
      return;
    }

    this.container = document.body.createDiv({ cls: "systemsculpt-progress-modal" });

    const header = this.container.createDiv({ cls: "systemsculpt-progress-header" });
    const headerIcon = header.createDiv({ cls: "systemsculpt-progress-icon" });
    setIcon(headerIcon, "file-audio");

    const headerContent = header.createDiv({ cls: "systemsculpt-progress-title" });
    headerContent.setText("Audio transcription");

    const fileMeta = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    const fileIcon = fileMeta.createSpan({ cls: "systemsculpt-progress-status-icon" });
    setIcon(fileIcon, "file-audio");

    const metaText = fileMeta.createSpan();
    const metaParts: string[] = [this.options.file.name];
    if (typeof this.options.file.stat?.size === "number") {
      metaParts.push(formatFileSize(this.options.file.stat.size));
    }
    metaText.setText(metaParts.join(" · "));

    const statusRow = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan({ cls: "systemsculpt-progress-status-text" });
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    const progressTrack = this.container.createDiv({ cls: "systemsculpt-progress-bar-track" });
    this.progressFill = progressTrack.createDiv({ cls: "systemsculpt-progress-bar" });

    this.detailEl = this.container.createDiv({
      cls: "systemsculpt-progress-detail is-hidden",
    });

    this.buttonsContainer = this.container.createDiv({
      cls: "systemsculpt-progress-buttons",
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

    // Ensure we never leave dangling DOM on plugin unload.
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
    if (!this.buttonsContainer || this.destroyed) {
      return;
    }

    this.buttonsContainer.empty();
    descriptors.forEach((descriptor) => {
      const button = this.buttonsContainer!.createEl("button", {
        cls:
          "systemsculpt-progress-button" + (descriptor.variant === "primary" ? " primary" : ""),
        text: descriptor.label,
      });
      button.addEventListener("click", descriptor.onClick);
    });
  }

  private updateStatus(options: { label: string; icon: string; progress: number; details?: string }): void {
    if (this.destroyed) {
      return;
    }

    const { label, icon, progress, details } = options;
    const pct = clampPercentage(progress);

    if (this.progressFill) {
      this.progressFill.style.width = `${pct}%`;
    }
    if (this.percentLabel) {
      this.percentLabel.setText(`${Math.round(pct)}%`);
    }
    if (this.statusIcon) {
      this.statusIcon.empty();
      setIcon(this.statusIcon, icon);
    }
    if (this.statusLabel) {
      this.statusLabel.setText(label);
    }

    if (this.detailEl) {
      if (details && details.trim()) {
        this.detailEl.removeClass("is-hidden");
        this.detailEl.setText(details.trim());
      } else {
        this.detailEl.addClass("is-hidden");
        this.detailEl.setText("");
      }
    }
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
        useModal: false,
        suppressNotices: true,
        onProgress: (progress, status) => this.updateStatus({
          label: status,
          icon: status.includes("Uploading") ? "upload" : status.includes("Saving") ? "hard-drive" : "loader-2",
          progress,
        }),
        onStatus: (status) => this.updateStatus({ label: status, icon: "loader-2", progress: status.includes("Saving") ? 92 : 75 }),
        onOutput: (path) => { finalPath = path; },
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
      if (error instanceof Error && error.name === "AbortError") return;
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

export async function showAudioTranscriptionModal(
  app: App,
  options: AudioTranscriptionOptions
): Promise<void> {
  const modal = new AudioTranscriptionModal(app, options);
  modal.open();
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
