import { setIcon } from "obsidian";

export type OperationProgressState = "running" | "complete" | "error" | "warning";

export interface OperationProgressButton {
  label: string;
  onClick: () => void;
  variant?: "primary" | "danger" | "default";
  disabled?: boolean;
}

export interface OperationProgressStatusOptions {
  label: string;
  icon: string;
  progress?: number;
  details?: string;
  state?: OperationProgressState;
}

export interface OperationProgressStepDefinition {
  id: string;
  label: string;
}

export interface OperationProgressPanelOptions {
  title: string;
  icon: string;
  metaText?: string;
  metaIcon?: string;
  dismissLabel?: string;
  onDismiss?: () => void;
  className?: string;
  steps?: OperationProgressStepDefinition[];
}

interface OperationProgressStepElements {
  item: HTMLElement;
  icon: HTMLElement;
}

export class OperationProgressPanel {
  private readonly root: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly percentLabel: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly listeners: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];
  private readonly stepOrder: string[];
  private readonly stepElements = new Map<string, OperationProgressStepElements>();
  private readonly stepsListEl: HTMLElement | null;
  private closed = false;

  constructor(options: OperationProgressPanelOptions) {
    this.root = document.body.createDiv({
      cls: "systemsculpt-progress-panel",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
    });
    if (options.className) {
      options.className
        .split(/\s+/)
        .filter(Boolean)
        .forEach((className) => this.root.addClass(className));
    }

    const header = this.root.createDiv({ cls: "systemsculpt-progress-header" });
    const headerIcon = header.createDiv({ cls: "systemsculpt-progress-icon" });
    setIcon(headerIcon, options.icon);

    header.createDiv({
      cls: "systemsculpt-progress-title",
      text: options.title,
    });

    const dismissButton = header.createEl("button", {
      cls: "systemsculpt-progress-dismiss",
      attr: {
        type: "button",
        "aria-label": options.dismissLabel ?? "Hide",
      },
    });
    setIcon(dismissButton, "x");
    this.registerDomEvent(dismissButton, "click", () => {
      options.onDismiss?.();
      this.close();
    });

    if (options.metaText?.trim()) {
      const metaRow = this.root.createDiv({ cls: "systemsculpt-progress-status" });
      const metaIcon = metaRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
      setIcon(metaIcon, options.metaIcon ?? options.icon);
      metaRow.createSpan({
        cls: "systemsculpt-progress-status-text",
        text: options.metaText.trim(),
      });
    }

    const statusRow = this.root.createDiv({
      cls: "systemsculpt-progress-status",
      attr: { "aria-live": "polite" },
    });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan({ cls: "systemsculpt-progress-status-text" });
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    const progressTrack = this.root.createDiv({ cls: "systemsculpt-progress-bar-track" });
    this.progressFill = progressTrack.createDiv({ cls: "systemsculpt-progress-bar" });

    this.stepOrder = options.steps?.map((step) => step.id) ?? [];
    this.stepsListEl = this.stepOrder.length > 0
      ? this.root.createEl("ul", { cls: "systemsculpt-progress-steps" })
      : null;

    if (this.stepsListEl && options.steps) {
      options.steps.forEach((step) => {
        const item = this.stepsListEl!.createEl("li", { cls: "systemsculpt-progress-step" });
        const icon = item.createDiv({ cls: "systemsculpt-progress-step-icon" });
        setIcon(icon, "circle");
        item.createDiv({
          cls: "systemsculpt-progress-step-text",
          text: step.label,
        });
        this.stepElements.set(step.id, { item, icon });
      });
    }

    this.detailEl = this.root.createDiv({
      cls: "systemsculpt-progress-detail is-hidden",
    });
    this.actionsEl = this.root.createDiv({
      cls: "systemsculpt-progress-buttons",
    });
    this.applyState("running");
  }

  setStatus(options: OperationProgressStatusOptions): void {
    if (this.closed) {
      return;
    }

    const progress = clampPercentage(options.progress);
    this.statusIcon.empty();
    setIcon(this.statusIcon, options.icon);
    this.statusLabel.setText(options.label);
    this.percentLabel.setText(typeof progress === "number" ? `${Math.round(progress)}%` : "");
    this.progressFill.style.width = `${progress ?? 0}%`;
    this.applyState(options.state ?? "running");
    this.setDetails(options.details);
  }

  setDetails(details?: string): void {
    if (this.closed) {
      return;
    }
    if (details && details.trim()) {
      this.detailEl.removeClass("is-hidden");
      this.detailEl.setText(details.trim());
      return;
    }
    this.detailEl.addClass("is-hidden");
    this.detailEl.empty();
  }

  setActions(actions: OperationProgressButton[]): void {
    if (this.closed) {
      return;
    }
    this.actionsEl.empty();
    this.actionsEl.toggleClass("is-hidden", actions.length === 0);
    actions.forEach((action) => {
      const classes = ["systemsculpt-progress-button"];
      if (action.variant === "primary") {
        classes.push("primary");
      } else if (action.variant === "danger") {
        classes.push("danger");
      }
      const button = this.actionsEl.createEl("button", {
        cls: classes.join(" "),
        text: action.label,
        attr: { type: "button" },
      });
      button.disabled = Boolean(action.disabled);
      this.registerDomEvent(button, "click", action.onClick);
    });
  }

  setTimelineState(activeStepId: string, state: Exclude<OperationProgressState, "warning"> | "complete"): void {
    if (this.closed || this.stepOrder.length === 0) {
      return;
    }

    const activeIndex = this.stepOrder.indexOf(activeStepId);
    this.stepOrder.forEach((stepId, index) => {
      const elements = this.stepElements.get(stepId);
      if (!elements) {
        return;
      }

      elements.item.removeClass("active", "completed", "error");
      elements.icon.empty();

      if (activeIndex === -1) {
        setIcon(elements.icon, "circle");
        return;
      }

      if (state === "error" && index === activeIndex) {
        elements.item.addClass("error");
        setIcon(elements.icon, "x-circle");
        return;
      }

      if (state === "complete" && index <= activeIndex) {
        elements.item.addClass("completed");
        setIcon(elements.icon, index === activeIndex ? "check-circle" : "check");
        return;
      }

      if (index < activeIndex) {
        elements.item.addClass("completed");
        setIcon(elements.icon, "check");
        return;
      }

      if (index === activeIndex) {
        elements.item.addClass("active");
        setIcon(elements.icon, "loader");
        return;
      }

      setIcon(elements.icon, "circle");
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listeners.forEach(({ element, type, listener }) => element.removeEventListener(type, listener));
    this.listeners.length = 0;
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    } else if (this.root.isConnected) {
      this.root.remove();
    }
  }

  private applyState(state: OperationProgressState): void {
    this.root.removeClass("is-running", "is-complete", "is-error", "is-warning");
    this.root.addClass(`is-${state}`);
  }

  private registerDomEvent(element: HTMLElement, type: string, listener: EventListener): void {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }
}

function clampPercentage(value: number | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 100 : 0;
  }
  return Math.min(100, Math.max(0, value));
}
