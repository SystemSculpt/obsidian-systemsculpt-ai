import { App, Notice, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type { CreditsBalanceSnapshot } from "../services/SystemSculptService";
import { LICENSE_URL } from "../types";

export interface CreditsBalanceModalOptions {
  initialBalance: CreditsBalanceSnapshot | null;
  fallbackPurchaseUrl?: string | null;
  loadBalance: () => Promise<CreditsBalanceSnapshot | null>;
  onOpenSetup: () => void;
}

export class CreditsBalanceModal extends StandardModal {
  private readonly options: CreditsBalanceModalOptions;
  private balance: CreditsBalanceSnapshot | null;
  private summaryEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private timelineEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private isRefreshing: boolean = false;

  constructor(app: App, options: CreditsBalanceModalOptions) {
    super(app);
    this.options = options;
    this.balance = options.initialBalance;
    this.setSize("medium");
    this.modalEl.addClass("ss-credits-balance-modal");
  }

  onOpen(): void {
    super.onOpen();

    this.addTitle(
      "Credits & Usage",
      "Understand your remaining balance and when your monthly credits reset."
    );

    const root = this.contentEl.createDiv({ cls: "ss-credits-balance" });
    this.summaryEl = root.createDiv({ cls: "ss-credits-balance__summary" });
    this.statsEl = root.createDiv({ cls: "ss-credits-balance__stats" });
    this.timelineEl = root.createDiv({ cls: "ss-credits-balance__timeline" });
    this.hintEl = root.createDiv({ cls: "ss-credits-balance__hint" });
    this.statusEl = root.createDiv({ cls: "ss-credits-balance__status" });

    this.refreshButton = this.addActionButton(
      "Refresh",
      () => {
        void this.refreshBalance();
      },
      false,
      "refresh-cw"
    ) as HTMLButtonElement;

    this.addActionButton(
      "Buy Credits",
      () => this.openPurchasePage(),
      true,
      "external-link"
    );

    this.addActionButton(
      "Open Setup",
      () => this.options.onOpenSetup(),
      false,
      "settings"
    );

    this.addActionButton("Close", () => this.close(), false);

    this.render();

    // Always request a fresh snapshot when opening so users see up-to-date balance.
    void this.refreshBalance(true);
  }

  private render(): void {
    if (!this.summaryEl || !this.statsEl || !this.timelineEl || !this.hintEl) {
      return;
    }

    this.summaryEl.empty();
    this.statsEl.empty();
    this.timelineEl.empty();
    this.hintEl.empty();

    if (!this.balance) {
      this.renderNoDataState();
      return;
    }

    const metrics = this.calculateCreditsMetrics(this.balance);
    const lowCreditsThreshold = 1000;
    const isLowBalance = metrics.conservativeTotalRemaining <= lowCreditsThreshold;
    const hero = this.summaryEl.createDiv({ cls: "ss-credits-balance__hero" });
    hero.classList.toggle("is-low", isLowBalance);

    const heroIcon = hero.createDiv({ cls: "ss-credits-balance__hero-icon" });
    setIcon(heroIcon, isLowBalance ? "alert-triangle" : "coins");

    const heroContent = hero.createDiv({ cls: "ss-credits-balance__hero-content" });
    heroContent.createDiv({
      cls: "ss-credits-balance__hero-label",
      text: "Total remaining",
    });
    heroContent.createDiv({
      cls: "ss-credits-balance__hero-value",
      text: `${this.formatCredits(metrics.conservativeTotalRemaining)} credits`,
    });

    const includedMeter = this.summaryEl.createDiv({ cls: "ss-credits-balance__meter" });
    const meterLabel = includedMeter.createDiv({ cls: "ss-credits-balance__meter-label" });
    if (metrics.hasMonthlyAllowance) {
      meterLabel.setText(
        `Included remaining this cycle: ${this.formatCredits(metrics.includedRemainingForMeter)} of ${this.formatCredits(metrics.includedPerMonth)}`
      );
    } else {
      meterLabel.setText("Included monthly allowance unavailable.");
    }
    const meterTrack = includedMeter.createDiv({ cls: "ss-credits-balance__meter-track" });
    const meterFill = meterTrack.createDiv({ cls: "ss-credits-balance__meter-fill" });
    meterFill.style.width = `${metrics.remainingPercentForMeter}%`;

    this.createStatCard(
      "Included left",
      `${this.formatCredits(this.balance.includedRemaining)} credits`
    );
    this.createStatCard(
      "Add-on left",
      `${this.formatCredits(this.balance.addOnRemaining)} credits`
    );
    this.createStatCard(
      "Monthly included",
      `${this.formatCredits(this.balance.includedPerMonth)} credits`
    );

    this.createTimelineRow("Cycle started", this.formatDate(this.balance.cycleStartedAt));
    this.createTimelineRow("Cycle resets", this.formatDate(this.balance.cycleEndsAt));

    if (this.balance.cycleAnchorAt) {
      this.createTimelineRow("Billing anchor", this.formatDate(this.balance.cycleAnchorAt));
    }

    if (this.balance.turnInFlightUntil) {
      this.createTimelineRow("Request lock until", this.formatDate(this.balance.turnInFlightUntil, true));
    }

    if (metrics.totalsMismatch) {
      this.hintEl.setText(
        `Balance sources disagree (reported ${this.formatCredits(metrics.reportedTotalRemaining)} vs breakdown ${this.formatCredits(metrics.derivedTotalRemaining)}). Showing the conservative total to avoid overestimating available credits.`
      );
      this.hintEl.addClass("is-warning");
    } else if (isLowBalance) {
      this.hintEl.setText("You are running low on credits. Buying credits now helps avoid interrupted requests.");
      this.hintEl.addClass("is-warning");
    } else {
      this.hintEl.setText("Need more headroom? You can buy additional credits anytime.");
      this.hintEl.removeClass("is-warning");
    }
  }

  private renderNoDataState(): void {
    if (!this.summaryEl || !this.hintEl) {
      return;
    }

    const hero = this.summaryEl.createDiv({ cls: "ss-credits-balance__hero is-empty" });
    const heroIcon = hero.createDiv({ cls: "ss-credits-balance__hero-icon" });
    setIcon(heroIcon, "circle-help");
    const heroContent = hero.createDiv({ cls: "ss-credits-balance__hero-content" });
    heroContent.createDiv({
      cls: "ss-credits-balance__hero-label",
      text: "Credits snapshot unavailable",
    });
    heroContent.createDiv({
      cls: "ss-credits-balance__hero-value",
      text: "Refresh to try again",
    });

    this.hintEl.setText("We could not load your latest credits. You can refresh or open Setup to verify your license.");
    this.hintEl.removeClass("is-warning");
  }

  private createStatCard(label: string, value: string): void {
    if (!this.statsEl) {
      return;
    }

    const card = this.statsEl.createDiv({ cls: "ss-credits-balance__stat" });
    card.createDiv({ cls: "ss-credits-balance__stat-label", text: label });
    card.createDiv({ cls: "ss-credits-balance__stat-value", text: value });
  }

  private createTimelineRow(label: string, value: string): void {
    if (!this.timelineEl) {
      return;
    }

    const row = this.timelineEl.createDiv({ cls: "ss-credits-balance__timeline-row" });
    row.createDiv({ cls: "ss-credits-balance__timeline-label", text: label });
    row.createDiv({ cls: "ss-credits-balance__timeline-value", text: value });
  }

  private async refreshBalance(silent: boolean = false): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    this.setRefreshBusyState(true);
    if (!silent) {
      this.setStatusMessage("Refreshing credits balance…");
    }

    try {
      this.balance = await this.options.loadBalance();
      this.render();
      const updatedAt = this.formatDate(new Date().toISOString(), true);
      if (this.balance) {
        this.setStatusMessage(`Last updated ${updatedAt}.`);
      } else {
        this.setStatusMessage("Could not fetch current balance. Try again in a moment.", "warning");
      }
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Unknown error";
      this.setStatusMessage(`Unable to refresh credits balance (${message}).`, "error");
      new Notice("Unable to refresh credits balance.", 5000);
    } finally {
      this.isRefreshing = false;
      this.setRefreshBusyState(false);
    }
  }

  private setRefreshBusyState(isBusy: boolean): void {
    if (!this.refreshButton) {
      return;
    }

    this.refreshButton.disabled = isBusy;
    this.refreshButton.classList.toggle("is-loading", isBusy);
    this.refreshButton.setAttr("aria-busy", isBusy ? "true" : "false");
  }

  private setStatusMessage(message: string, tone: "neutral" | "warning" | "error" = "neutral"): void {
    if (!this.statusEl) {
      return;
    }

    this.statusEl.setText(message);
    this.statusEl.removeClass("is-warning", "is-error");
    if (tone === "warning") {
      this.statusEl.addClass("is-warning");
    }
    if (tone === "error") {
      this.statusEl.addClass("is-error");
    }
  }

  private openPurchasePage(): void {
    const purchaseUrl = this.balance?.purchaseUrl || this.options.fallbackPurchaseUrl || LICENSE_URL;
    if (purchaseUrl) {
      window.open(purchaseUrl, "_blank");
      return;
    }

    this.options.onOpenSetup();
  }

  private formatCredits(value: number): string {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(safeValue);
    } catch {
      return String(safeValue);
    }
  }

  private asSafeCredit(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.max(0, parsed);
  }

  private roundDownPercent(value: number): number {
    const bounded = Math.max(0, Math.min(100, value));
    return Math.floor(bounded * 10) / 10;
  }

  private calculateCreditsMetrics(balance: CreditsBalanceSnapshot): {
    reportedTotalRemaining: number;
    derivedTotalRemaining: number;
    conservativeTotalRemaining: number;
    totalsMismatch: boolean;
    includedPerMonth: number;
    includedRemainingForMeter: number;
    remainingPercentForMeter: number;
    hasMonthlyAllowance: boolean;
  } {
    const reportedTotalRemaining = this.asSafeCredit(balance.totalRemaining);
    const includedRemainingRaw = this.asSafeCredit(balance.includedRemaining);
    const addOnRemaining = this.asSafeCredit(balance.addOnRemaining);
    const derivedTotalRemaining = includedRemainingRaw + addOnRemaining;

    // Conservative policy: when two totals disagree, trust the lower value to avoid
    // overstating available credits.
    const conservativeTotalRemaining = Math.min(reportedTotalRemaining, derivedTotalRemaining);
    const totalsMismatch = reportedTotalRemaining !== derivedTotalRemaining;

    const includedPerMonth = this.asSafeCredit(balance.includedPerMonth);
    const hasMonthlyAllowance = includedPerMonth > 0;
    const includedRemainingForMeter = hasMonthlyAllowance
      ? Math.min(includedRemainingRaw, includedPerMonth)
      : 0;

    // Bar represents remaining credits. We round down so UI never overstates what is left.
    const remainingPercentForMeter = hasMonthlyAllowance
      ? this.roundDownPercent((includedRemainingForMeter / includedPerMonth) * 100)
      : 0;

    return {
      reportedTotalRemaining,
      derivedTotalRemaining,
      conservativeTotalRemaining,
      totalsMismatch,
      includedPerMonth,
      includedRemainingForMeter,
      remainingPercentForMeter,
      hasMonthlyAllowance,
    };
  }

  private formatDate(iso: string, includeTime: boolean = false): string {
    if (!iso) {
      return "Unknown";
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
      }).format(date);
    } catch {
      return includeTime ? date.toISOString().replace("T", " ").slice(0, 16) : date.toISOString().slice(0, 10);
    }
  }
}
