import { Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../main";
import { OperationProgressPanel } from "../core/ui/progress/OperationProgressPanel";
import { tryCopyToClipboard } from "../utils/clipboard";

export interface AutomationProcessingPanelOptions {
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

export interface AutomationProcessingPanelHandle {
  setStatus(label: string, progress?: number): void;
  markSuccess(payload: AutomationProcessingSuccessPayload): void;
  markFailure(payload: AutomationProcessingFailurePayload): void;
  close(): void;
}

class AutomationProcessingPanel implements AutomationProcessingPanelHandle {
  private readonly panel: OperationProgressPanel;
  private destroyed = false;

  constructor(options: AutomationProcessingPanelOptions) {
    this.panel = new OperationProgressPanel({
      title: "Workflow automation",
      icon: "sparkles",
      metaText: options.file.name,
      metaIcon: "file-text",
      dismissLabel: "Hide workflow progress",
    });

    this.setButtons([
      {
        label: "Hide",
        onClick: () => this.close(),
      },
    ]);

    this.updateStatus({
      label: `Running “${options.automationTitle}” on ${options.file.basename}…`,
      icon: "loader",
      progress: 10,
      state: "running",
    });
  }

  markSuccess(payload: AutomationProcessingSuccessPayload): void {
    if (this.destroyed) {
      return;
    }

    this.updateStatus({
      label: "Automation complete",
      icon: "check-circle",
      progress: 100,
      details: `Created ${payload.resultFile.path}`,
      state: "complete",
    });

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

    void (async () => {
      try {
        await payload.openOutput();
      } catch (error) {
        console.error(error);
      }
      this.panel.closeAfter(4000);
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
      details: message,
      state: "error",
    });

    this.setButtons([
      {
        label: "Copy error",
        onClick: async () => {
          try {
            const copied = await tryCopyToClipboard(message, this.panel.element);
            new Notice(
              copied ? "Error copied to clipboard" : "Unable to copy error (clipboard unavailable).",
              copied ? 2500 : 4000,
            );
          } catch (error) {
            console.error(error);
          }
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

  setStatus(label: string, progress?: number): void {
    if (this.destroyed) {
      return;
    }
    const pct = typeof progress === "number" ? progress : 50;
    this.updateStatus({
      label,
      icon: "loader",
      progress: pct,
      state: "running",
    });
  }

  close(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.panel.close();
  }

  private updateStatus(options: {
    label: string;
    icon: string;
    progress: number;
    details?: string;
    state: "running" | "complete" | "error";
  }): void {
    this.panel.setStatus({
      label: options.label,
      icon: options.icon,
      progress: clampPercentage(options.progress),
      details: options.details,
      state: options.state,
    });
  }

  private setButtons(
    descriptors: Array<{ label: string; onClick: () => void; variant?: "primary" | "default" }>
  ): void {
    this.panel.setActions(descriptors);
  }

}

export const launchAutomationProcessingPanel = (
  options: AutomationProcessingPanelOptions
): AutomationProcessingPanelHandle => {
  const panel = new AutomationProcessingPanel(options);
  options.plugin.register(() => panel.close());
  return panel;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
