import { Notice } from "obsidian";

export type SettingsNavigationApi = {
  activeTab?: { id?: string; containerEl?: HTMLElement };
  open(): void;
  openTabById(id: string): void;
};

export type SettingsNavigatorOptions = Readonly<{
  pluginId: string;
  getSettingsApi: () => SettingsNavigationApi | undefined;
  getSettingsContainer: () => HTMLElement | undefined;
  isUnloading: () => boolean;
  registerCleanup: (cleanup: () => void) => void;
  triggerFocus: (tab: string) => void;
}>;

/** Owns pending settings focus and its retry/cancellation lifetime. */
export class SettingsNavigator {
  private pendingSettingsFocusTab: string | null = null;
  private cancelPendingSettingsFocus: (() => void) | null = null;
  private settingsFocusCleanupRegistered = false;

  constructor(private readonly options: SettingsNavigatorOptions) {}

  public openSettingsTab(targetTab: string = "account"): void {
    const normalizedTargetTab = String(targetTab || "account").trim() || "account";
    this.pendingSettingsFocusTab = normalizedTargetTab;

    this.cancelPendingSettingsFocus?.();
    if (!this.settingsFocusCleanupRegistered) {
      this.settingsFocusCleanupRegistered = true;
      this.options.registerCleanup(() => this.cancelPendingSettingsFocus?.());
    }

    let cancelled = false;
    let pendingTimer: { ownerWindow: Window; id: number } | null = null;
    const cancel = () => {
      cancelled = true;
      if (pendingTimer) pendingTimer.ownerWindow.clearTimeout(pendingTimer.id);
      pendingTimer = null;
      if (this.cancelPendingSettingsFocus === cancel) this.cancelPendingSettingsFocus = null;
    };
    this.cancelPendingSettingsFocus = cancel;

    try {
      const settingsApi = this.options.getSettingsApi();
      if (!settingsApi) throw new Error("Settings API unavailable");

      const isPluginTabReady = () => settingsApi.activeTab?.id === this.options.pluginId
        && (settingsApi.activeTab.containerEl?.isConnected ?? true);
      const schedule = (callback: () => void, delay: number) => {
        // Obsidian can host settings in a separate native window. Its active
        // tab, rather than the main document's old modal, owns focus timing.
        const ownerWindow = settingsApi.activeTab?.containerEl?.ownerDocument.defaultView
          ?? this.options.getSettingsContainer()?.ownerDocument.defaultView
          ?? window.activeWindow ?? window;
        pendingTimer = { ownerWindow, id: ownerWindow.setTimeout(() => {
          pendingTimer = null;
          if (!cancelled && !this.options.isUnloading()) callback();
        }, delay) };
      };
      const focusPluginTab = (attempt: number = 0) => {
        if (cancelled || this.options.isUnloading()) return;
        if (!isPluginTabReady()) {
          try {
            settingsApi.openTabById(this.options.pluginId);
          } catch {
            // Older hosts throw until their settings surface has mounted.
          }
        }
        if (isPluginTabReady()) {
          schedule(() => {
            if (isPluginTabReady()) {
              this.options.triggerFocus(normalizedTargetTab);
            }
            cancel();
          }, 0);
        } else if (attempt < 20) {
          schedule(() => focusPluginTab(attempt + 1), 50);
        } else {
          cancel();
        }
      };

      if (!settingsApi.activeTab?.containerEl?.isConnected) settingsApi.open();
      focusPluginTab();
    } catch {
      cancel();
      new Notice("Open SystemSculpt AI settings to manage your account and plugin preferences.", 6000);
    }
  }

  public peekPendingSettingsFocusTab(): string | null {
    return this.pendingSettingsFocusTab;
  }

  public consumePendingSettingsFocusTab(): string | null {
    const pendingTab = this.pendingSettingsFocusTab;
    this.pendingSettingsFocusTab = null;
    return pendingTab;
  }

  public clearPendingSettingsFocusTab(targetTab?: string | null): void {
    if (targetTab && this.pendingSettingsFocusTab !== String(targetTab || "").trim()) {
      return;
    }
    this.pendingSettingsFocusTab = null;
  }
}
