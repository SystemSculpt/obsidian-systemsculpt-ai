import { App, Notice } from "obsidian";
import moment from "moment";
import { DailyNoteService } from "../../services/daily/DailyNoteService";
import { DailySettingsService } from "../../services/daily/DailySettingsService";
import { DailyNoteNavigatorModal } from "../../modals/DailyNoteNavigatorModal";

export class DailyStatusBar {
  private app: App;
  private containerEl: HTMLElement | null = null;
  private dailyNoteService: DailyNoteService;
  private dailySettingsService: DailySettingsService;
  private unsubscribeHandlers: Array<() => void> = [];
  private lastRefreshAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private readonly REFRESH_TTL = 60 * 1000;
  private readonly REFRESH_FORCE_COOLDOWN = 2000;
  private refreshCooldownHandle: ReturnType<typeof setTimeout> | null = null;
  private interactionsBound = false;

  constructor(
    app: App,
    dailyNoteService: DailyNoteService,
    dailySettingsService: DailySettingsService
  ) {
    this.app = app;
    this.dailyNoteService = dailyNoteService;
    this.dailySettingsService = dailySettingsService;
  }

  async initialize(containerEl: HTMLElement): Promise<void> {
    this.containerEl = containerEl;
    this.containerEl.empty();
    this.ensureInteractionHandlers();
    this.requestRefresh(true);
    this.registerListeners();
  }

  private ensureInteractionHandlers(): void {
    if (!this.containerEl || this.interactionsBound) {
      return;
    }

    const target = this.containerEl;
    target.addClass("mod-clickable");
    target.setAttr("role", "button");
    target.setAttr("tabindex", "0");

    target.addEventListener("click", (event) => {
      event.preventDefault();
      void this.openTodayNote();
    });

    target.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.openTodayNote();
      }
    });

    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openNavigator();
    });

    this.interactionsBound = true;
  }

  public requestRefresh(force: boolean = false): void {
    if (this.refreshQueued && !force) {
      return;
    }
    this.refreshQueued = true;
    this.runWhenIdle(() => {
      this.refreshQueued = false;
      void this.refresh(force);
    });
  }

  async refresh(force: boolean = false): Promise<void> {
    if (!this.containerEl) return;
    const now = Date.now();
    if (!force && now - this.lastRefreshAt < this.REFRESH_TTL) {
      return;
    }
    if (this.refreshPromise) {
      if (force) {
        await this.refreshPromise;
      }
      return;
    }

    const refreshTask = this.renderStatusContent(force)
      .then(() => {
        this.lastRefreshAt = Date.now();
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    this.refreshPromise = refreshTask;
    await refreshTask;
  }

  private async renderStatusContent(_force: boolean): Promise<void> {
    const settings = await this.dailySettingsService.getSettings();
    const root = this.containerEl;
    if (!root) {
      return;
    }

    if (!settings.showDailyStatusBar) {
      root.empty();
      root.style.display = "none";
      return;
    }

    root.style.removeProperty("display");
    root.empty();

    const dateFormat = settings.dailyNoteFormat || "YYYY-MM-DD";
    const today = moment();
    const todayLabel = today.format(dateFormat);
    root.createSpan({ text: todayLabel });

    const todayNote = await this.dailyNoteService.getDailyNote();
    const weekdayLabel = today.format("dddd");
    const actionPrefix = todayNote ? "Open" : "Create";
    const detail = todayNote ? `${weekdayLabel}` : `${weekdayLabel}, note missing`;
    root.setAttr("aria-label", `${actionPrefix} daily note ${todayLabel} (${detail})`);
    root.title = `${actionPrefix} daily note • ${detail}`;
  }

  private async openTodayNote(): Promise<void> {
    try {
      await this.dailyNoteService.openDailyNote();
    } catch (error) {
      console.warn("Failed to open today's daily note", error);
      new Notice(
        `Unable to open today's daily note: ${error instanceof Error ? error.message : String(error)}`,
        6000
      );
    }
  }

  cleanup(): void {
    this.unsubscribeHandlers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribeHandlers = [];
    if (this.refreshCooldownHandle) {
      clearTimeout(this.refreshCooldownHandle);
      this.refreshCooldownHandle = null;
    }

    if (this.containerEl) {
      this.containerEl.remove();
      this.containerEl = null;
    }
  }

  private registerListeners(): void {
    this.unsubscribeHandlers.push(
      this.dailyNoteService.on("daily-note-created", () => {
        this.dailyNoteService.invalidateDailyNotesCache();
        this.queueForcedRefresh();
      })
    );
    this.unsubscribeHandlers.push(
      this.dailySettingsService.onSettingsChange(() => {
        this.dailyNoteService.invalidateDailyNotesCache();
        this.queueForcedRefresh();
      })
    );
  }

  private queueForcedRefresh(): void {
    if (this.refreshCooldownHandle) {
      return;
    }
    const trigger = () => {
      this.refreshCooldownHandle = null;
      this.requestRefresh(true);
    };
    this.refreshCooldownHandle = setTimeout(trigger, this.REFRESH_FORCE_COOLDOWN);
  }

  private runWhenIdle(callback: () => void): void {
    if (typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function") {
      (window as any).requestIdleCallback(() => callback());
    } else {
      setTimeout(() => callback(), 0);
    }
  }

  private openNavigator(initialDate?: Date): void {
    const modal = new DailyNoteNavigatorModal(this.app, this.dailyNoteService, initialDate ?? null);
    modal.open();
  }
}
