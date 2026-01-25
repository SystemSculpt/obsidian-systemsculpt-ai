import { App, Notice, TFile, setIcon } from "obsidian";
import type SystemSculptPlugin from "../main";

export interface AutomationProcessingModalOptions {
  app: App;
  plugin: SystemSculptPlugin;
  file: TFile;
  automationTitle: string;
}

export interface AutomationProcessingSuccessPayload {
  resultFile: TFile;
  openOutput: () => Promise<void> | void;
}

export interface AutomationProcessingFailurePayload {
  error: unknown;
}

export interface AutomationProcessingModalHandle {
  setStatus(label: string, progress?: number): void;
  markSuccess(payload: AutomationProcessingSuccessPayload): void;
  markFailure(payload: AutomationProcessingFailurePayload): void;
  close(): void;
}

class AutomationProcessingModal implements AutomationProcessingModalHandle {
  private readonly app: App;
  private readonly file: TFile;
  private readonly automationTitle: string;
  private readonly container: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly percentLabel: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly buttonsContainer: HTMLElement;
  private autoCloseTimer: number | null = null;
  private destroyed = false;

  constructor(options: AutomationProcessingModalOptions) {
    this.app = options.app;
    this.file = options.file;
    this.automationTitle = options.automationTitle;

    this.container = document.body.createDiv({ cls: "systemsculpt-progress-modal" });

    const header = this.container.createDiv({ cls: "systemsculpt-progress-header" });
    const headerIcon = header.createDiv({ cls: "systemsculpt-progress-icon" });
    setIcon(headerIcon, "sparkles");

    const headerContent = header.createDiv({ cls: "systemsculpt-progress-title" });
    headerContent.setText("Workflow Automation");

    const fileMeta = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    const fileIcon = fileMeta.createSpan({ cls: "systemsculpt-progress-status-icon" });
    setIcon(fileIcon, "file-text");
    const metaText = fileMeta.createSpan();
    metaText.setText(this.file.name);

    const statusRow = this.container.createDiv({ cls: "systemsculpt-progress-status" });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan();
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    const progressTrack = this.container.createDiv({
      cls: "systemsculpt-progress-bar-track",
    });
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
    ]);

    this.updateStatus({
      label: `Running “${this.automationTitle}” on ${this.file.basename}…`,
      icon: "loader",
      progress: 10,
    });
  }

  markSuccess(payload: AutomationProcessingSuccessPayload): void {
    if (this.destroyed) {
      return;
    }

    this.updateStatus({
      label: "Automation complete – opening note…",
      icon: "check-circle",
      progress: 100,
    });

    this.detailEl.removeClass("is-hidden");
    this.detailEl.setText(`Created ${payload.resultFile.path}`);

    this.setButtons([
      {
        label: "Open note",
        variant: "primary",
        onClick: async () => {
          try {
            await payload.openOutput();
          } catch (error) {
            new Notice("Unable to open automation result note. See console for details.", 4000);
          }
          this.close();
        },
      },
      {
        label: "Close",
        onClick: () => this.close(),
      },
    ]);

    // Also trigger opening immediately for smoother UX.
    void (async () => {
      try {
        await payload.openOutput();
      } catch (error) {
        console.error(error);
      }
      this.scheduleAutoClose();
    })();
  }

  markFailure(payload: AutomationProcessingFailurePayload): void {
    if (this.destroyed) {
      return;
    }

    const message =
      payload.error instanceof Error ? payload.error.message : String(payload.error ?? "Unknown error");

    this.updateStatus({
      label: "Automation failed",
      icon: "x-circle",
      progress: 100,
    });

    this.detailEl.removeClass("is-hidden");
    this.detailEl.setText(message);

    const supportsClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

    const buttons = supportsClipboard
      ? [
          {
            label: "Copy error",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(message);
                new Notice("Error copied to clipboard", 2500);
              } catch (error) {
                console.error(error);
              }
              this.close();
            },
          },
          {
            label: "Close",
            variant: "primary" as const,
            onClick: () => this.close(),
          },
        ]
      : [
          {
            label: "Close",
            variant: "primary" as const,
            onClick: () => this.close(),
          },
        ];

    this.setButtons(buttons);
  }

  setStatus(label: string, progress?: number): void {
    if (this.destroyed) {
      return;
    }
    const pct = typeof progress === "number" ? progress : 50;
    this.updateStatus({
      label,
      icon: "loader",
      progress: pct,
    });
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

  private updateStatus(options: { label: string; icon: string; progress: number }): void {
    const { label, icon, progress } = options;

    this.statusIcon.empty();
    setIcon(this.statusIcon, icon);
    this.statusLabel.setText(label);

    const clamped = clampPercentage(progress);
    this.progressFill.style.width = `${clamped}%`;
    this.percentLabel.setText(`${Math.round(clamped)}%`);
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>
  ): void {
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
    this.autoCloseTimer = window.setTimeout(() => this.close(), 4000);
  }
}

export const launchAutomationProcessingModal = (
  options: AutomationProcessingModalOptions
): AutomationProcessingModalHandle => {
  const modal = new AutomationProcessingModal(options);
  options.plugin.register(() => modal.close());
  return modal;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, value));
}
