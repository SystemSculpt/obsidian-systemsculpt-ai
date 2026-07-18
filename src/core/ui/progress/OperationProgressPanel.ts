import { setIcon } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  resolveSurfaceDomContext,
  updateUiAction,
} from "../surface";

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

export type OperationProgressItemState = "running" | "complete" | "error" | "skipped";

export interface OperationProgressItem {
  id: string;
  label: string;
  icon?: string;
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
  host?: HTMLElement;
  collapsible?: boolean;
}

interface OperationProgressStepElements {
  item: HTMLElement;
  icon: HTMLElement;
}

interface OperationProgressItemElements {
  item: HTMLElement;
  statusIcon: HTMLElement;
}

interface OperationProgressStack {
  element: HTMLElement;
  panels: Set<HTMLElement>;
}

const progressStacks = new WeakMap<HTMLElement, OperationProgressStack>();

function acquireProgressStack(host: HTMLElement): OperationProgressStack {
  const current = progressStacks.get(host);
  if (current?.element.isConnected || current?.element.parentElement === host) {
    return current;
  }
  const stack: OperationProgressStack = {
    element: host.createDiv({ cls: "systemsculpt-progress-stack" }),
    panels: new Set(),
  };
  progressStacks.set(host, stack);
  return stack;
}

export class OperationProgressPanel {
  private readonly root: HTMLElement;
  private readonly statusIcon: HTMLElement;
  private readonly statusLabel: HTMLElement;
  private readonly percentLabel: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly itemsListEl: HTMLElement;
  private readonly listeners: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];
  private readonly stepOrder: string[];
  private readonly stepElements = new Map<string, OperationProgressStepElements>();
  private readonly stepsListEl: HTMLElement | null;
  private readonly itemElements = new Map<string, OperationProgressItemElements>();
  private readonly hostWindow: Window;
  private readonly stackHost: HTMLElement;
  private readonly stack: OperationProgressStack;
  private autoCloseTimer: number | null = null;
  private closed = false;

  constructor(options: OperationProgressPanelOptions) {
    const context = resolveSurfaceDomContext(options.host);
    const { host } = context;
    this.hostWindow = context.window;
    this.stackHost = host;
    this.stack = acquireProgressStack(host);
    this.root = this.stack.element.createDiv({
      cls: "systemsculpt-progress-panel",
      attr: {
        role: "region",
        "aria-label": options.title,
      },
    });
    this.stack.panels.add(this.root);
    applyPluginSurface(this.root, "transient");
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

    const dismissButton = createUiAction(header, {
      label: options.dismissLabel ?? (options.collapsible ? "Minimize" : "Hide"),
      icon: options.collapsible ? "minus" : "x",
      size: "icon",
    });
    dismissButton.addClass("systemsculpt-progress-dismiss");
    if (options.collapsible) {
      dismissButton.setAttribute("aria-expanded", "true");
    }
    this.registerDomEvent(dismissButton, "click", () => {
      if (options.collapsible) {
        const collapsed = !this.root.hasClass("is-collapsed");
        this.root.toggleClass("is-collapsed", collapsed);
        dismissButton.setAttribute("aria-expanded", String(!collapsed));
        updateUiAction(dismissButton, {
          label: collapsed ? "Expand" : "Minimize",
          icon: collapsed ? "plus" : "minus",
          title: collapsed ? "Expand" : "Minimize",
        });
        return;
      }
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
      attr: { role: "status", "aria-live": "polite" },
    });
    this.statusIcon = statusRow.createSpan({ cls: "systemsculpt-progress-status-icon" });
    this.statusLabel = statusRow.createSpan({ cls: "systemsculpt-progress-status-text" });
    this.percentLabel = statusRow.createSpan({ cls: "systemsculpt-progress-percent" });

    this.progressTrack = this.root.createDiv({
      cls: "systemsculpt-progress-bar-track",
      attr: {
        role: "progressbar",
        "aria-label": `${options.title} progress`,
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0",
      },
    });
    this.progressFill = this.progressTrack.createDiv({ cls: "systemsculpt-progress-bar" });

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

    this.itemsListEl = this.root.createEl("ul", {
      cls: "systemsculpt-progress-items is-hidden",
      attr: { "aria-label": "Current items" },
    });

    this.detailEl = this.root.createDiv({
      cls: "systemsculpt-progress-detail is-hidden",
    });
    this.actionsEl = this.root.createDiv({
      cls: "systemsculpt-progress-buttons",
    });
    this.applyState("running");
  }

  /** Mounted host for owner-realm utilities such as clipboard access. */
  get element(): HTMLElement {
    return this.root;
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
    this.progressTrack.setAttribute("aria-valuenow", String(Math.round(progress ?? 0)));
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
      const button = createUiAction(this.actionsEl, {
        label: action.label,
        tone: action.variant === "primary"
          ? "primary"
          : action.variant === "danger"
            ? "danger"
            : "default",
        size: "small",
        disabled: action.disabled,
      });
      button.addClass("systemsculpt-progress-button");
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

      elements.item.removeClass("is-active", "is-complete", "is-error");
      elements.icon.empty();

      if (activeIndex === -1) {
        setIcon(elements.icon, "circle");
        return;
      }

      if (state === "error" && index === activeIndex) {
        elements.item.addClass("is-error");
        setIcon(elements.icon, "x-circle");
        return;
      }

      if (state === "complete" && index <= activeIndex) {
        elements.item.addClass("is-complete");
        setIcon(elements.icon, index === activeIndex ? "check-circle" : "check");
        return;
      }

      if (index < activeIndex) {
        elements.item.addClass("is-complete");
        setIcon(elements.icon, "check");
        return;
      }

      if (index === activeIndex) {
        elements.item.addClass("is-active");
        setIcon(elements.icon, "loader");
        return;
      }

      setIcon(elements.icon, "circle");
    });
  }

  setItems(items: OperationProgressItem[]): void {
    if (this.closed) return;
    this.itemsListEl.empty();
    this.itemElements.clear();
    this.itemsListEl.toggleClass("is-hidden", items.length === 0);

    for (const item of items) {
      const row = this.itemsListEl.createEl("li", {
        cls: "systemsculpt-progress-item is-running",
      });
      if (item.icon) {
        const leadingIcon = row.createSpan({ cls: "systemsculpt-progress-item-icon" });
        setIcon(leadingIcon, item.icon);
      }
      row.createSpan({ cls: "systemsculpt-progress-item-label", text: item.label });
      const statusIcon = row.createSpan({ cls: "systemsculpt-progress-item-status" });
      setIcon(statusIcon, "loader");
      this.itemElements.set(item.id, { item: row, statusIcon });
    }
  }

  setItemState(id: string, state: OperationProgressItemState, title?: string): void {
    if (this.closed) return;
    const elements = this.itemElements.get(id);
    if (!elements) return;
    elements.item.removeClass("is-running", "is-complete", "is-error", "is-skipped");
    elements.item.addClass(`is-${state}`);
    elements.item.toggleAttribute("title", Boolean(title));
    if (title) elements.item.title = title;
    elements.statusIcon.empty();
    setIcon(
      elements.statusIcon,
      state === "complete"
        ? "check"
        : state === "error"
          ? "x"
          : state === "skipped"
            ? "minus"
            : "loader",
    );
  }

  closeAfter(delayMs: number): void {
    if (this.closed) return;
    if (this.autoCloseTimer !== null) {
      this.hostWindow.clearTimeout(this.autoCloseTimer);
    }
    this.autoCloseTimer = this.hostWindow.setTimeout(() => this.close(), delayMs);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.autoCloseTimer !== null) {
      this.hostWindow.clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    this.listeners.forEach(({ element, type, listener }) => element.removeEventListener(type, listener));
    this.listeners.length = 0;
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    } else if (this.root.isConnected) {
      this.root.remove();
    }
    this.stack.panels.delete(this.root);
    if (this.stack.panels.size === 0) {
      this.stack.element.remove();
      if (progressStacks.get(this.stackHost) === this.stack) {
        progressStacks.delete(this.stackHost);
      }
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
