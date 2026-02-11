import { App, Notice, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import type {
  CreditsBalanceSnapshot,
  CreditsUsageHistoryPage,
  CreditsUsageSnapshot,
} from "../services/SystemSculptService";
import { LICENSE_URL } from "../types";

type CreditsTabId = "balance" | "usage";

export interface CreditsBalanceModalOptions {
  initialBalance: CreditsBalanceSnapshot | null;
  initialUsage?: CreditsUsageHistoryPage | null;
  fallbackPurchaseUrl?: string | null;
  loadBalance: () => Promise<CreditsBalanceSnapshot | null>;
  loadUsage?: (params?: { limit?: number; before?: string }) => Promise<CreditsUsageHistoryPage>;
  onOpenSetup: () => void;
}

export class CreditsBalanceModal extends StandardModal {
  private readonly options: CreditsBalanceModalOptions;
  private balance: CreditsBalanceSnapshot | null;
  private usage: CreditsUsageHistoryPage;
  private activeTab: CreditsTabId = "balance";
  private usageLoaded: boolean = false;

  private tabBarEl: HTMLElement | null = null;
  private balanceTabButton: HTMLButtonElement | null = null;
  private usageTabButton: HTMLButtonElement | null = null;
  private balancePanelEl: HTMLElement | null = null;
  private usagePanelEl: HTMLElement | null = null;

  private summaryEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private timelineEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  private usageListEl: HTMLElement | null = null;
  private usageHintEl: HTMLElement | null = null;
  private usageLoadMoreButton: HTMLButtonElement | null = null;

  private statusEl: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;
  private isRefreshingBalance: boolean = false;
  private isRefreshingUsage: boolean = false;
  private isLoadingMoreUsage: boolean = false;

  constructor(app: App, options: CreditsBalanceModalOptions) {
    super(app);
    this.options = options;
    this.balance = options.initialBalance;
    this.usage = options.initialUsage ?? { items: [], nextBefore: null };
    this.usageLoaded = !!options.initialUsage;
    this.setSize("medium");
    this.modalEl.addClass("ss-credits-balance-modal");
  }

  onOpen(): void {
    super.onOpen();

    this.addTitle(
      "Credits & Usage",
      "Track your remaining credits and inspect exactly where credits were spent."
    );

    const root = this.contentEl.createDiv({ cls: "ss-credits-balance" });
    this.tabBarEl = root.createDiv({ cls: "ss-credits-balance__tabs" });
    this.balanceTabButton = this.createTabButton("Balance", "balance");
    this.usageTabButton = this.createTabButton("Usage", "usage");

    this.balancePanelEl = root.createDiv({ cls: "ss-credits-balance__panel ss-credits-balance__panel--balance" });
    this.summaryEl = this.balancePanelEl.createDiv({ cls: "ss-credits-balance__summary" });
    this.statsEl = this.balancePanelEl.createDiv({ cls: "ss-credits-balance__stats" });
    this.timelineEl = this.balancePanelEl.createDiv({ cls: "ss-credits-balance__timeline" });
    this.hintEl = this.balancePanelEl.createDiv({ cls: "ss-credits-balance__hint" });

    this.usagePanelEl = root.createDiv({ cls: "ss-credits-balance__panel ss-credits-balance__panel--usage" });
    this.usageListEl = this.usagePanelEl.createDiv({ cls: "ss-credits-usage__list" });
    this.usageHintEl = this.usagePanelEl.createDiv({ cls: "ss-credits-usage__hint" });
    this.usageLoadMoreButton = this.usagePanelEl.createEl("button", {
      cls: "ss-credits-usage__load-more",
      text: "Load More",
      attr: { type: "button" },
    });
    this.registerDomEvent(this.usageLoadMoreButton, "click", () => {
      void this.loadMoreUsage();
    });

    this.statusEl = root.createDiv({ cls: "ss-credits-balance__status" });

    this.refreshButton = this.addActionButton(
      "Refresh",
      () => {
        if (this.activeTab === "usage") {
          void this.refreshUsage();
          return;
        }
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

    this.renderBalance();
    this.renderUsage();
    this.updateTabUI();

    // Always request a fresh balance snapshot when opening.
    void this.refreshBalance(true);
  }

  private createTabButton(label: string, tab: CreditsTabId): HTMLButtonElement {
    if (!this.tabBarEl) {
      throw new Error("Tab bar is not initialized.");
    }
    const button = this.tabBarEl.createEl("button", {
      cls: "ss-credits-balance__tab",
      text: label,
      attr: { type: "button" },
    }) as HTMLButtonElement;

    this.registerDomEvent(button, "click", () => {
      void this.setActiveTab(tab);
    });
    return button;
  }

  private async setActiveTab(tab: CreditsTabId): Promise<void> {
    if (this.activeTab === tab) {
      return;
    }
    this.activeTab = tab;
    this.updateTabUI();

    if (tab === "usage" && !this.usageLoaded) {
      await this.refreshUsage(true);
    }
  }

  private updateTabUI(): void {
    this.balanceTabButton?.classList.toggle("is-active", this.activeTab === "balance");
    this.usageTabButton?.classList.toggle("is-active", this.activeTab === "usage");

    this.balancePanelEl?.classList.toggle("is-active", this.activeTab === "balance");
    this.usagePanelEl?.classList.toggle("is-active", this.activeTab === "usage");

    this.updateUsageLoadMoreButton();
  }

  private renderBalance(): void {
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

  private renderUsage(): void {
    if (!this.usageListEl || !this.usageHintEl) {
      return;
    }

    this.usageListEl.empty();
    this.usageHintEl.empty();

    if (!this.options.loadUsage) {
      this.usageHintEl.setText("Usage history is unavailable in this build.");
      this.usageHintEl.addClass("is-warning");
      this.updateUsageLoadMoreButton();
      return;
    }

    if (!this.usageLoaded && this.usage.items.length === 0) {
      this.usageHintEl.setText("Open the Usage tab and press Refresh to load recent usage.");
      this.usageHintEl.removeClass("is-warning");
      this.updateUsageLoadMoreButton();
      return;
    }

    if (this.usage.items.length === 0) {
      this.usageHintEl.setText("No usage records found for this account yet.");
      this.usageHintEl.removeClass("is-warning");
      this.updateUsageLoadMoreButton();
      return;
    }

    for (const item of this.usage.items) {
      const row = this.usageListEl.createDiv({ cls: "ss-credits-usage__item" });

      const header = row.createDiv({ cls: "ss-credits-usage__item-header" });
      header.createDiv({
        cls: "ss-credits-usage__item-title",
        text: item.endpoint || this.formatUsageKind(item.usageKind),
      });
      header.createDiv({
        cls: "ss-credits-usage__item-credits",
        text: `${this.formatCredits(item.creditsCharged)} credits`,
      });

      const meta = row.createDiv({ cls: "ss-credits-usage__item-meta" });
      const modelText = [item.provider, item.model].filter(Boolean).join(" · ");
      meta.setText(
        [this.formatDate(item.createdAt, true), modelText || this.formatUsageKind(item.usageKind)]
          .filter(Boolean)
          .join("  •  ")
      );

      const details = row.createDiv({ cls: "ss-credits-usage__item-details" });
      const detailParts: string[] = [];
      if (item.durationSeconds > 0) {
        detailParts.push(`${this.formatCompactNumber(item.durationSeconds)}s audio`);
      }
      if (item.totalTokens > 0) {
        detailParts.push(`${this.formatCompactNumber(item.totalTokens)} tokens`);
      }
      if (item.pageCount > 0) {
        detailParts.push(`${this.formatCompactNumber(item.pageCount)} pages`);
      }
      details.setText(detailParts.length > 0 ? detailParts.join("  •  ") : this.formatUsageKind(item.usageKind));

      const balanceTrail = row.createDiv({ cls: "ss-credits-usage__item-balance-trail" });
      balanceTrail.setText(
        `Balance: ${this.formatCredits(item.totalBefore)} → ${this.formatCredits(item.totalAfter)}`
      );
    }

    this.usageHintEl.setText("Each row shows an auditable charge with usage basis, credits spent, and balance impact.");
    this.usageHintEl.removeClass("is-warning");
    this.updateUsageLoadMoreButton();
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
    if (this.isRefreshingBalance) {
      return;
    }

    this.isRefreshingBalance = true;
    this.setRefreshBusyState();
    if (!silent) {
      this.setStatusMessage("Refreshing credits balance…");
    }

    try {
      this.balance = await this.options.loadBalance();
      this.renderBalance();
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
      this.isRefreshingBalance = false;
      this.setRefreshBusyState();
    }
  }

  private async refreshUsage(silent: boolean = false): Promise<void> {
    if (!this.options.loadUsage || this.isRefreshingUsage) {
      return;
    }

    this.isRefreshingUsage = true;
    this.setRefreshBusyState();
    if (!silent) {
      this.setStatusMessage("Refreshing usage history…");
    }

    try {
      const page = await this.options.loadUsage({ limit: 50 });
      this.usage = {
        items: Array.isArray(page?.items) ? page.items : [],
        nextBefore: typeof page?.nextBefore === "string" ? page.nextBefore : null,
      };
      this.usageLoaded = true;
      this.renderUsage();
      const updatedAt = this.formatDate(new Date().toISOString(), true);
      this.setStatusMessage(`Usage updated ${updatedAt}.`);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Unknown error";
      this.setStatusMessage(`Unable to refresh usage (${message}).`, "error");
      new Notice("Unable to refresh usage history.", 5000);
    } finally {
      this.isRefreshingUsage = false;
      this.setRefreshBusyState();
    }
  }

  private async loadMoreUsage(): Promise<void> {
    if (
      !this.options.loadUsage ||
      this.isLoadingMoreUsage ||
      !this.usage.nextBefore
    ) {
      return;
    }

    this.isLoadingMoreUsage = true;
    this.updateUsageLoadMoreButton();
    this.setRefreshBusyState();
    this.setStatusMessage("Loading older usage records…");

    try {
      const page = await this.options.loadUsage({
        limit: 50,
        before: this.usage.nextBefore,
      });

      const appended = Array.isArray(page?.items) ? page.items : [];
      const seen = new Set(this.usage.items.map((entry) => entry.id));
      const merged = [...this.usage.items];
      for (const entry of appended) {
        if (!entry?.id || seen.has(entry.id)) {
          continue;
        }
        seen.add(entry.id);
        merged.push(entry);
      }

      this.usage = {
        items: merged,
        nextBefore: typeof page?.nextBefore === "string" ? page.nextBefore : null,
      };
      this.usageLoaded = true;
      this.renderUsage();
      this.setStatusMessage("Loaded older usage records.");
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Unknown error";
      this.setStatusMessage(`Unable to load older usage (${message}).`, "error");
      new Notice("Unable to load older usage records.", 5000);
    } finally {
      this.isLoadingMoreUsage = false;
      this.updateUsageLoadMoreButton();
      this.setRefreshBusyState();
    }
  }

  private updateUsageLoadMoreButton(): void {
    if (!this.usageLoadMoreButton) {
      return;
    }

    const shouldShow =
      this.activeTab === "usage" &&
      !!this.options.loadUsage &&
      typeof this.usage.nextBefore === "string" &&
      this.usage.nextBefore.length > 0;

    this.usageLoadMoreButton.style.display = shouldShow ? "" : "none";
    this.usageLoadMoreButton.disabled = this.isLoadingMoreUsage;
    this.usageLoadMoreButton.classList.toggle("is-loading", this.isLoadingMoreUsage);
  }

  private setRefreshBusyState(): void {
    if (!this.refreshButton) {
      return;
    }

    const isBusy = this.isRefreshingBalance || this.isRefreshingUsage || this.isLoadingMoreUsage;
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

  private formatUsageKind(kind: CreditsUsageSnapshot["usageKind"]): string {
    switch (kind) {
      case "audio_transcription":
        return "Audio transcription";
      case "document_processing":
        return "Document processing";
      case "youtube_transcript":
        return "YouTube transcript";
      case "agent_turn":
        return "Agent turn";
      case "embeddings":
        return "Embeddings";
      default:
        return "Request";
    }
  }

  private formatCompactNumber(value: number): string {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(safeValue);
    } catch {
      return String(safeValue);
    }
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
