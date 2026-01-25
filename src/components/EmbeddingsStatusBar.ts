import { Component } from "obsidian";
import { EMBEDDING_SCHEMA_VERSION } from "../constants/embeddings";
import type SystemSculptPlugin from "../main";
import { EmbeddingsStatusModal } from "../modals/EmbeddingsStatusModal";

interface CachedStatus {
  /** Files that have embeddings in the current namespace (may still be sealing). */
  presentFiles: number;
  /** Files that are fully sealed (`metadata.complete === true` on `#0`). */
  processedFiles: number;
  totalFiles: number;
  isProcessing: boolean;
  presentPercentage: number | null;
  sealedPercentage: number | null;
  lastUpdate: number;
  failedFiles: number;
}

export class EmbeddingsStatusBar extends Component {
  private plugin: SystemSculptPlugin;
  private statusBarEl: HTMLElement;
  private valueEl: HTMLElement;
  private detailEl: HTMLElement;
  private updateInterval: number | null = null;
  private currentIntervalMs = 0;
  private unsubscribes: Array<() => void> = [];
  private isVisible = true;

  private cachedStatus: CachedStatus | null = null;
  private readonly CACHE_DURATION = 5000;
  private readonly ACTIVE_INTERVAL_MS = 2000;
  private readonly IDLE_INTERVAL_MS = 6000;
  private isFirstUpdate = true;

  private isInErrorState = false;
  private currentErrorMessage: string | null = null;
  private currentErrorRetryMs: number | null = null;
  private currentErrorCode: string | null = null;
  private currentErrorDetails: Record<string, unknown> | null = null;

  constructor(plugin: SystemSculptPlugin) {
    super();
    this.plugin = plugin;
    this.initializeStatusBar();
  }

  private initializeStatusBar(): void {
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.title = "Click to view embeddings status";
    this.statusBarEl.setAttr("role", "button");
    this.statusBarEl.setAttr("tabindex", "0");

    this.statusBarEl.createSpan({ text: "Embeddings:" });
    this.statusBarEl.createSpan({ text: " " });

    this.valueEl = this.statusBarEl.createSpan({
      attr: {
        role: "meter",
        "aria-label": "Embeddings",
      },
    });
    this.valueEl.style.marginLeft = "2px";
    this.valueEl.textContent = this.plugin.settings.embeddingsEnabled ? "initializing" : "idle";

    this.detailEl = this.statusBarEl.createSpan();

    this.statusBarEl.addEventListener("click", () => {
      this.openEmbeddingsStatus();
    });
    this.statusBarEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.openEmbeddingsStatus();
      }
    });

    this.setupEventListeners();
    if (this.plugin.settings.embeddingsEnabled) {
      this.scheduleUpdates(this.IDLE_INTERVAL_MS);
      void this.updateStatus();
    } else {
      this.setVisibility(false);
    }
  }

  public startMonitoring(): void {
    this.cachedStatus = null;
    this.isFirstUpdate = true;
    this.setVisibility(true);
    this.scheduleUpdates(this.ACTIVE_INTERVAL_MS);
    void this.updateStatus();
  }

  public stopMonitoring(): void {
    this.clearUpdateInterval();
    this.setVisibility(false);
    this.setIdleState();
  }

  private scheduleUpdates(intervalMs: number): void {
    if (intervalMs <= 0) {
      this.clearUpdateInterval();
      return;
    }

    if (this.updateInterval && this.currentIntervalMs === intervalMs) {
      return;
    }

    this.clearUpdateInterval();
    this.currentIntervalMs = intervalMs;
    this.updateInterval = window.setInterval(() => {
      void this.updateStatus();
    }, intervalMs);
  }

  private clearUpdateInterval(): void {
    if (this.updateInterval) {
      window.clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.currentIntervalMs = 0;
  }

  private async updateStatus(): Promise<void> {
    try {
      if (!this.plugin.settings.embeddingsEnabled) {
        this.setVisibility(false);
        this.clearUpdateInterval();
        return;
      }

      this.setVisibility(true);
      const manager = this.plugin.embeddingsManager;

      if (!manager) {
        this.scheduleUpdates(this.ACTIVE_INTERVAL_MS);
        this.setMainText("initializing", "Embeddings initializing");
        this.statusBarEl.title = "Embeddings initializing. Click to view status.";
        this.updateDetail(null);
        return;
      }

      await this.refreshCachedStatus(manager);

      const stats = this.cachedStatus;
      const namespaceDescriptor = (manager as any).getCurrentNamespaceDescriptor?.() || {
        provider: "unknown",
        model: "unknown",
        schema: EMBEDDING_SCHEMA_VERSION,
      };

      if (!stats) {
        this.scheduleUpdates(this.IDLE_INTERVAL_MS);
        this.setMainText("idle", "Embeddings idle");
        this.statusBarEl.title = this.plugin.settings.embeddingsEnabled
          ? "Embeddings idle. Click to view status."
          : "Embeddings disabled. Click to view status.";
        this.updateDetail(null);
        return;
      }

      const { processedFiles, presentFiles, totalFiles, isProcessing, presentPercentage, sealedPercentage, failedFiles } = stats;
      const safePresent = Math.min(presentFiles, totalFiles);
      const safeProcessed = Math.min(processedFiles, totalFiles);
      const countsLabel = this.formatCounts(safePresent, totalFiles, presentPercentage);
      const inlineCounts = totalFiles > 0 ? `${safePresent}/${totalFiles}` : null;
      const compactInlineCounts = totalFiles > 0
        ? `${this.formatCompact(safePresent)}/${this.formatCompact(totalFiles)}`
        : null;

      if (this.isInErrorState) {
        const countsText = totalFiles > 0 ? `${this.formatCompact(safePresent)}/${this.formatCompact(totalFiles)}` : "error";
        this.setMainText(countsText, "Embeddings error");
        this.applyErrorState();
        return;
      }

      if (!this.plugin.settings.embeddingsEnabled) {
        this.scheduleUpdates(this.IDLE_INTERVAL_MS);
        this.setMainText("off", "Embeddings disabled");
        this.updateDetail(null);
        this.statusBarEl.title = countsLabel
          ? `Embeddings disabled • ${countsLabel}`
          : "Embeddings disabled. Click to view status.";
        return;
      }

      if (isProcessing) {
        this.scheduleUpdates(this.ACTIVE_INTERVAL_MS);
        const mainText = compactInlineCounts ?? inlineCounts ?? "processing";
        this.setMainText(mainText, `Embeddings ${mainText}`);
        this.updateDetail(null);
        const sealSuffix =
          totalFiles > 0 && safeProcessed < totalFiles
            ? ` • sealed ${this.formatCompact(safeProcessed)}/${this.formatCompact(totalFiles)}`
            : "";
        const failedSuffix = failedFiles > 0 ? ` • ${failedFiles} failed` : "";
        this.statusBarEl.title = namespaceDescriptor
          ? `Embeddings processing • ${this.formatNamespaceInfo(namespaceDescriptor)} • ${countsLabel}${sealSuffix}${failedSuffix}`
          : `Embeddings processing • ${countsLabel}${sealSuffix}${failedSuffix}`;
        return;
      }

      this.scheduleUpdates(this.IDLE_INTERVAL_MS);

      if (totalFiles > 0 && safeProcessed >= totalFiles && (sealedPercentage ?? 0) >= 100 && failedFiles === 0) {
        const mainText = compactInlineCounts || (totalFiles ? `${this.formatCompact(totalFiles)} files` : "ready");
        this.setMainText(mainText, `Embeddings ready ${mainText}`);
        this.updateDetail(null);
        this.statusBarEl.title = namespaceDescriptor
          ? `Embeddings ready • ${this.formatNamespaceInfo(namespaceDescriptor)} • ${countsLabel || (totalFiles ? `${this.formatCompact(totalFiles)} files` : "")}`
          : `Embeddings ready • ${countsLabel || (totalFiles ? `${this.formatCompact(totalFiles)} files` : "")}`;
        return;
      }

      const mainText = compactInlineCounts ?? inlineCounts ?? (presentPercentage !== null ? `${presentPercentage}%` : "idle");
      this.setMainText(mainText, `Embeddings ${mainText}`);
      this.updateDetail(failedFiles > 0 ? `${failedFiles} failed` : null);
      const sealSuffix =
        totalFiles > 0 && safeProcessed < totalFiles && safePresent > 0
          ? ` • sealed ${this.formatCompact(safeProcessed)}/${this.formatCompact(totalFiles)}`
          : "";
      const failedSuffix = failedFiles > 0 ? ` • ${failedFiles} failed (click to retry)` : "";
      this.statusBarEl.title = namespaceDescriptor
        ? `Embeddings coverage • ${this.formatNamespaceInfo(namespaceDescriptor)} • ${countsLabel}${sealSuffix}${failedSuffix}`
        : `Embeddings coverage • ${countsLabel}${sealSuffix}${failedSuffix}`;
    } catch {
      this.scheduleUpdates(this.IDLE_INTERVAL_MS);
      this.setMainText("idle", "Embeddings idle");
      this.updateDetail(null);
    }
  }

  private async refreshCachedStatus(manager: any): Promise<void> {
    const now = Date.now();
    if (!this.isFirstUpdate && this.cachedStatus && now - this.cachedStatus.lastUpdate < this.CACHE_DURATION) {
      return;
    }

    this.isFirstUpdate = false;

    try {
      await manager.awaitReady?.();
    } catch {
    }

    let isProcessing = false;
    let totalFiles = 0;
    let processedFiles = 0;
    let presentFiles = 0;
    let failedFiles = 0;
    let presentPercentage: number | null = null;
    let sealedPercentage: number | null = null;

    try {
      isProcessing = !!manager.isCurrentlyProcessing?.();
      const stats = manager.getStats?.();
      if (stats && typeof stats.total === "number") {
        totalFiles = Math.max(0, stats.total);
        processedFiles = Math.min(Math.max(0, stats.processed || 0), totalFiles);
        presentFiles = Math.min(Math.max(0, stats.present || 0), totalFiles);
        failedFiles = Math.max(0, stats.failed || 0);
      }

      if (totalFiles > 0) {
        presentPercentage = Math.max(0, Math.min(100, Math.round((presentFiles / totalFiles) * 100)));
        sealedPercentage = Math.max(0, Math.min(100, Math.round((processedFiles / totalFiles) * 100)));
      } else {
        presentPercentage = manager.hasAnyEmbeddings?.() ? 100 : null;
        sealedPercentage = presentPercentage;
      }
    } catch {
    }

    this.cachedStatus = {
      processedFiles,
      presentFiles,
      totalFiles,
      isProcessing,
      presentPercentage,
      sealedPercentage,
      lastUpdate: now,
      failedFiles,
    };
  }

  private formatCounts(processed: number, total: number, _percentage: number | null): string {
    if (total === 0) return "";
    const processedLabel = this.formatCompact(processed);
    const totalLabel = this.formatCompact(total);
    return `${processedLabel}/${totalLabel}`;
  }

  private formatCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(value);
  }

  private setupEventListeners(): void {
    try {
      const emitter = (this.plugin as any).emitter;
      if (!emitter || typeof emitter.on !== "function") return;

      this.unsubscribes.push(
        emitter.on("embeddings:processing-start", (payload: any) => {
          if (this.isInErrorState) {
            this.clearErrorState();
          }
          this.cachedStatus = null;
          this.isFirstUpdate = true;
          this.scheduleUpdates(this.ACTIVE_INTERVAL_MS);
          void this.updateStatus();
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:processing-progress", (_payload: any) => {
          this.cachedStatus = null;
          this.isFirstUpdate = true;
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:processing-complete", (_payload: any) => {
          this.cachedStatus = null;
          this.isFirstUpdate = true;
          this.scheduleUpdates(this.IDLE_INTERVAL_MS);
          void this.updateStatus();
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:error", (payload: any) => {
          const message = payload?.error?.message || "Embeddings error";
          const retryInMs =
            typeof payload?.error?.retryInMs === "number"
              ? payload.error.retryInMs
              : typeof payload?.retryInMs === "number"
              ? payload.retryInMs
              : undefined;
          const code = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
          const details =
            payload?.error && typeof payload.error.details === "object" ? payload.error.details : undefined;
          this.displayErrorState(message, retryInMs, code, details as Record<string, unknown> | undefined);
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:retry-scheduled", (payload: any) => {
          if (!this.isInErrorState) return;
          const retryInMs = typeof payload?.retryInMs === "number" ? payload.retryInMs : undefined;
          if (retryInMs !== undefined) {
            this.updateRetryCountdown(retryInMs);
          }
        })
      );

      this.unsubscribes.push(
        emitter.on("embeddings:recovered", (_payload: any) => {
          this.clearErrorState();
          this.cachedStatus = null;
          this.isFirstUpdate = true;
          this.scheduleUpdates(this.IDLE_INTERVAL_MS);
          void this.updateStatus();
        })
      );
    } catch {
      // Ignore event wiring issues; status bar can continue polling.
    }
  }

  private setVisibility(visible: boolean): void {
    if (!this.statusBarEl) {
      return;
    }
    if (this.isVisible === visible) {
      return;
    }

    this.isVisible = visible;

    if (visible) {
      this.statusBarEl.style.removeProperty("display");
      this.statusBarEl.removeAttribute("aria-hidden");
    } else {
      this.statusBarEl.style.display = "none";
      this.statusBarEl.setAttr("aria-hidden", "true");
    }
  }

  private setIdleState(): void {
    this.setMainText("idle", "Embeddings idle");
    this.statusBarEl.title = "Embeddings idle. Click to view status.";
    this.updateDetail(null);
  }

  private displayErrorState(
    message: string,
    retryInMs?: number,
    code?: string,
    details?: Record<string, unknown>
  ): void {
    this.isInErrorState = true;
    this.currentErrorMessage = message;
    this.currentErrorRetryMs = typeof retryInMs === "number" && retryInMs >= 0 ? retryInMs : null;
    this.currentErrorCode = code ?? null;
    this.currentErrorDetails = details ?? null;
    this.applyErrorState();
  }

  private updateRetryCountdown(retryInMs: number): void {
    if (!this.isInErrorState) return;
    this.currentErrorRetryMs = retryInMs >= 0 ? retryInMs : null;
    this.applyErrorState();
  }

  private clearErrorState(): void {
    this.isInErrorState = false;
    this.currentErrorMessage = null;
    this.currentErrorRetryMs = null;
    this.currentErrorCode = null;
    this.currentErrorDetails = null;
    const presentPercentage = this.cachedStatus?.presentPercentage ?? null;
    const totalFiles = this.cachedStatus?.totalFiles ?? null;
    const presentFiles = this.cachedStatus?.presentFiles ?? null;
    const processedFiles = this.cachedStatus?.processedFiles ?? null;

    const hasCounts = typeof totalFiles === "number" && typeof presentFiles === "number" && totalFiles > 0;
    const countsText = hasCounts
      ? `${this.formatCompact(presentFiles)}/${this.formatCompact(totalFiles)}`
      : "idle";
    this.setMainText(countsText, hasCounts ? `Embeddings ${countsText}` : "Embeddings coverage");

    const sealSuffix =
      typeof processedFiles === "number" && typeof totalFiles === "number" && totalFiles > 0 && processedFiles < totalFiles && presentFiles! > 0
        ? ` • sealed ${this.formatCompact(processedFiles)}/${this.formatCompact(totalFiles)}`
        : "";
    const countsLabel = hasCounts ? this.formatCounts(presentFiles!, totalFiles!, presentPercentage) : "";

    this.updateDetail(null);
    this.statusBarEl.title = countsLabel
      ? `Embeddings coverage • ${countsLabel}${sealSuffix}`
      : "Embeddings status";
  }

  private applyErrorState(): void {
    const message = this.currentErrorMessage || "Embeddings error";
    const summary = this.summarizeErrorMessage(message, this.currentErrorCode, this.currentErrorDetails || undefined);
    const presentPercentage = this.cachedStatus?.presentPercentage ?? null;
    const totalFiles = this.cachedStatus?.totalFiles ?? null;
    const presentFiles = this.cachedStatus?.presentFiles ?? null;
    const processedFiles = this.cachedStatus?.processedFiles ?? null;

    const hasCounts = typeof totalFiles === "number" && typeof presentFiles === "number" && totalFiles > 0;
    const countsText = hasCounts
      ? `${this.formatCompact(presentFiles)}/${this.formatCompact(totalFiles)}`
      : "error";
    this.setMainText(countsText, `Embeddings error${hasCounts ? ` ${countsText}` : ""}`);

    const tooltipParts: string[] = [];
    tooltipParts.push(summary.tooltip ?? message);

    let detailText: string | null = summary.text ?? null;

    if (this.currentErrorRetryMs !== null) {
      const seconds = Math.max(1, Math.round(this.currentErrorRetryMs / 1000));
      tooltipParts.push(`Retry in ~${seconds}s`);
      detailText = `${summary.text ?? ""} (retry in ~${seconds}s)`;
    } else if (summary.hint) {
      tooltipParts.push(summary.hint);
      if (summary.text && summary.hint) {
        detailText = `${summary.text} • ${summary.hint}`;
      } else if (summary.hint) {
        detailText = summary.hint;
      }
    }

    if (hasCounts) {
      const sealSuffix =
        typeof processedFiles === "number" && processedFiles < totalFiles!
          ? ` • sealed ${this.formatCompact(processedFiles)}/${this.formatCompact(totalFiles!)}`
          : "";
      const countsLabel = this.formatCounts(presentFiles!, totalFiles!, presentPercentage);
      tooltipParts.push(`Coverage: ${countsLabel}${sealSuffix}`);
    }

    this.updateDetail(detailText || summary.text || null);
    this.statusBarEl.title = tooltipParts.join(" • ");
  }

  private setMainText(text: string, ariaLabel?: string): void {
    if (this.valueEl.textContent !== text) {
      this.valueEl.textContent = text;
    }
    if (ariaLabel) {
      this.valueEl.setAttr("aria-label", ariaLabel);
    }
  }

  private updateDetail(text: string | null): void {
    this.detailEl.textContent = text ? ` • ${text}` : "";
  }

  private formatNamespaceInfo(descriptor: { provider: string; model: string; schema: number }): string {
    if (descriptor.provider === "systemsculpt") {
      return `${descriptor.provider} • v${descriptor.schema}`;
    }
    return `${descriptor.provider} • ${descriptor.model} • v${descriptor.schema}`;
  }

  private summarizeErrorMessage(
    message: string,
    code: string | null,
    details?: Record<string, unknown>
  ): { text: string; hint?: string; tooltip?: string } {
    const tooltip = message;
    const kind = typeof details?.kind === "string" ? String(details.kind) : undefined;
    const lower = message.toLowerCase();

    if (code === "INVALID_RESPONSE" || kind === "html-response" || lower.includes("html")) {
      return {
        text: "Unexpected HTML response",
        hint: "Verify API URL",
        tooltip,
      };
    }
    if (code === "LICENSE_INVALID") {
      return {
        text: "License issue",
        hint: "Validate license key",
        tooltip,
      };
    }
    if (code === "RATE_LIMITED") {
      return {
        text: "Rate limited",
        hint: "Retry shortly",
        tooltip,
      };
    }
    if (code === "HOST_UNAVAILABLE") {
      return {
        text: "Provider unavailable",
        hint: "Server temporarily down",
        tooltip,
      };
    }
    if (code === "NETWORK_ERROR") {
      return {
        text: "Network error",
        hint: "Check connection",
        tooltip,
      };
    }

    const trimmed = message.length > 46 ? `${message.slice(0, 43)}…` : message;
    return {
      text: trimmed,
      tooltip,
    };
  }

  private openEmbeddingsStatus(): void {
    try {
      const modal = new EmbeddingsStatusModal(this.plugin.app, this.plugin);
      modal.open();
    } catch {
    }
  }

  onload(): void {
    // Component lifecycle hook (unused)
  }

  onunload(): void {
    this.clearUpdateInterval();
    try {
      for (const off of this.unsubscribes) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      this.unsubscribes = [];
    } catch {
      // ignore unsubscribe failures
    }
  }
}
