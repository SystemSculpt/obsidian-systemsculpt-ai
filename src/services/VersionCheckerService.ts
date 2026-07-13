/**
 * VersionCheckerService
 * Handles checking for updates by comparing the current plugin version
 * with the latest release from the GitHub repository.
 */
import { Notice, App } from "obsidian";
import SystemSculptPlugin from "../main";
import { IS_DEVELOPMENT_BUILD } from "../constants/api";
import { VersionUpdateModal, type VersionUpdateModalVariant } from "../modals/VersionUpdateModal";
import { compareNumericVersions, parseNumericVersion } from "../utils/semver";

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  isLatest: boolean;
  releaseUrl: string;
  updateUrl: string;
}

export class VersionCheckerService {
  private static instance: VersionCheckerService | null = null;
  private currentVersion: string;
  private githubRepo: string = "systemsculpt/obsidian-systemsculpt-ai";
  private pluginId: string = "systemsculpt-ai";
  private cachedVersionInfo: VersionInfo | null = null;
  private lastChecked: number = 0;
  private cacheTimeMs: number = 1000 * 60 * 60; // 1 hour cache
  private app: App;
  private plugin: SystemSculptPlugin;
  private updateModal: VersionUpdateModal | null = null;
  private updateModalAutoCloseTimer: number | null = null;
  private periodicCheckIntervalMs: number = 1000 * 60 * 60; // 1 hour
  private periodicCheckTimeout: number | null = null;
  private startupCheckAbortController: AbortController | null = null;
  
  // Internal update-flow state used by local release testing
  private devModeUpdateState: "show-update" | "show-post-update" = "show-update";

  private constructor(currentVersion: string, app: App, plugin: SystemSculptPlugin) {
    this.currentVersion = currentVersion;
    this.app = app;
    this.plugin = plugin;
    
    // Load dev mode state from localStorage if in development mode
    if (IS_DEVELOPMENT_BUILD) {
      const savedState = localStorage.getItem("systemsculpt-dev-update-state");
      if (savedState === "show-post-update" || savedState === "show-update") {
        this.devModeUpdateState = savedState;
      }
    }
  }
  
  /**
   * Simulates an update in development mode
   */
  private simulateUpdate(): void {
    if (IS_DEVELOPMENT_BUILD) {
      this.devModeUpdateState = "show-post-update";
      localStorage.setItem("systemsculpt-dev-update-state", "show-post-update");
    }
  }
  
  /**
   * Resets the development mode update flow
   */
  public resetDevUpdateFlow(): void {
    if (IS_DEVELOPMENT_BUILD) {
      this.devModeUpdateState = "show-update";
      localStorage.setItem("systemsculpt-dev-update-state", "show-update");
    }
  }

  public static getInstance(currentVersion: string, app?: App, plugin?: SystemSculptPlugin): VersionCheckerService {
    if (!VersionCheckerService.instance) {
      if (!app || !plugin) {
        throw new Error("App and plugin must be provided when initializing VersionCheckerService");
      }
      VersionCheckerService.instance = new VersionCheckerService(currentVersion, app, plugin);
    }
    return VersionCheckerService.instance;
  }

  /**
   * Starts the periodic update checker
   */
  public startPeriodicUpdateCheck(): void {
    // Don't start periodic checks if notifications are disabled (unless in development mode)
    if (!IS_DEVELOPMENT_BUILD && !this.plugin.settings.showUpdateNotifications) {
      return;
    }
    
    // Clear any existing timeout
    this.stopPeriodicUpdateCheck();
    
    // Schedule periodic checks
    this.periodicCheckTimeout = window.setInterval(() => {
      this.checkForUpdatesQuietly();
    }, this.periodicCheckIntervalMs);
  }
  
  /**
   * Stops the periodic update checker
   */
  public stopPeriodicUpdateCheck(): void {
    if (this.periodicCheckTimeout) {
      window.clearInterval(this.periodicCheckTimeout);
      this.periodicCheckTimeout = null;
    }
  }
  
  /**
   * Checks for updates in background without showing notification
   * if already on the latest version
   */
  private async checkForUpdatesQuietly(): Promise<void> {
    // Don't check if notifications are disabled (unless in development mode)
    if (!IS_DEVELOPMENT_BUILD && !this.plugin.settings.showUpdateNotifications) {
      return;
    }
    
    try {
      let versionInfo = await this.checkVersion(true); // Force refresh
      
      // In development mode, always show update available if we're in show-update state
      if (IS_DEVELOPMENT_BUILD && this.devModeUpdateState === "show-update") {
        versionInfo = {
          currentVersion: this.currentVersion,
          latestVersion: "99.99.99",
          isLatest: false,
          releaseUrl: versionInfo.releaseUrl,
          updateUrl: versionInfo.updateUrl
        };
      }
      
      // Only show notification if an update is available
      if (!versionInfo.isLatest) {
        this.showUpdateModal(versionInfo);
      }
    } catch (error) {
      // Check if this is a rate limit error (403)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('403')) {
      } else {
      }
      // Don't show any error to the user, just log it
    }
  }

  /**
   * Checks if the current version is the latest available version
   * @param forceRefresh Force refresh the cache
   * @returns Version information
   */
  public async checkVersion(forceRefresh = false): Promise<VersionInfo> {
    const now = Date.now();
    
    // Return cached result if available and not expired
    if (
      !forceRefresh && 
      this.cachedVersionInfo && 
      now - this.lastChecked < this.cacheTimeMs
    ) {
      return this.cachedVersionInfo;
    }

    try {
      const latestVersion = await this.fetchLatestVersion();
      
      // Check if current version is latest
      let isLatest = this.compareVersions(this.currentVersion, latestVersion) >= 0;
      
      this.cachedVersionInfo = {
        currentVersion: this.currentVersion,
        latestVersion,
        isLatest,
        releaseUrl: `https://github.com/${this.githubRepo}/releases/latest`,
        updateUrl: `obsidian://show-plugin?id=${this.pluginId}`
      };
      
      this.lastChecked = now;
      return this.cachedVersionInfo;
    } catch (error) {
      // Check if this is a rate limit error (403)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('403')) {
      } else {
      }
      
      // Return current version info if we can't fetch latest
      return {
        currentVersion: this.currentVersion,
        latestVersion: "unknown",
        isLatest: true, // Assume we're on latest if we can't check
        releaseUrl: `https://github.com/${this.githubRepo}/releases/latest`,
        updateUrl: `obsidian://show-plugin?id=${this.pluginId}`
      };
    }
  }

  /**
   * Checks for plugin updates on startup and shows a notice if an update is available
   * @param delayMs Time to wait before checking (default: 3000ms)
   */
  public async checkForUpdatesOnStartup(delayMs: number = 3000): Promise<void> {
    // Wait a bit to avoid overwhelming the user with notifications on startup
    await new Promise(resolve => window.setTimeout(resolve, delayMs));

    // Handle development mode flow
    if (IS_DEVELOPMENT_BUILD) {
      if (this.devModeUpdateState === "show-post-update") {
        this.showPostUpdateModal();
        // Reset to show-update for next time
        this.devModeUpdateState = "show-update";
        localStorage.setItem("systemsculpt-dev-update-state", "show-update");
      } else {
        // Show update available notification
        const fakeVersionInfo: VersionInfo = {
          currentVersion: this.currentVersion,
          latestVersion: "99.99.99",
          isLatest: false,
          releaseUrl: `https://github.com/${this.githubRepo}/releases/latest`,
          updateUrl: `obsidian://show-plugin?id=${this.pluginId}`
        };
        this.showUpdateModal(fakeVersionInfo);
      }
      // Start periodic checks
      this.startPeriodicUpdateCheck();
      return;
    }
    
    // Production mode logic
    // Check if user has just updated to a new version
    const lastKnownVersion = this.plugin.settings.lastKnownVersion;
    const hasJustUpdated = lastKnownVersion && lastKnownVersion !== this.currentVersion && 
                          this.compareVersions(this.currentVersion, lastKnownVersion) > 0;
    
    // Update the last known version
    if (lastKnownVersion !== this.currentVersion) {
      await this.plugin.getSettingsManager().updateSettings({ lastKnownVersion: this.currentVersion });
    }
    
    // Show post-update notification if user just updated
    if (hasJustUpdated) {
      this.showPostUpdateModal();
    }
    
    // Don't check for new updates if notifications are disabled
    if (!this.plugin.settings.showUpdateNotifications) {
      this.startPeriodicUpdateCheck();
      return;
    }

    this.scheduleStartupUpdateCheck();
  }

  private scheduleStartupUpdateCheck(): void {
    this.cancelStartupUpdateCheck();
    const controller = new AbortController();
    this.startupCheckAbortController = controller;

    this.enqueueIdle(async () => {
      if (controller.signal.aborted || (!this.plugin.settings.showUpdateNotifications && !IS_DEVELOPMENT_BUILD)) {
        return;
      }
      try {
        const versionInfo = await this.checkVersion();
        if (controller.signal.aborted) {
          return;
        }
        if (!versionInfo.isLatest) {
          this.showUpdateModal(versionInfo);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('403')) {
        } else {
        }
      } finally {
        if (this.startupCheckAbortController === controller) {
          this.startupCheckAbortController = null;
        }
      }
    }, 200);

    this.startPeriodicUpdateCheck();
  }

  private cancelStartupUpdateCheck(): void {
    if (this.startupCheckAbortController) {
      this.startupCheckAbortController.abort();
      this.startupCheckAbortController = null;
    }
  }

  private enqueueIdle(task: () => void | Promise<void>, timeoutMs: number = 200): void {
    const runner = () => {
      try {
        const result = task();
        if (result instanceof Promise) {
          result.catch(() => void 0);
        }
      } catch {
        // swallow startup errors; diagnostics are handled elsewhere
      }
    };

    if (typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function") {
      (window as any).requestIdleCallback(() => runner(), { timeout: timeoutMs });
      return;
    }

    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      window.setTimeout(runner, timeoutMs);
      return;
    }

    window.setTimeout(runner, timeoutMs);
  }

  /**
   * Shows the post-update notice.
   */
  private showPostUpdateModal(): void {
    this.presentUpdateModal("updated");
  }

  /**
   * Opens the SystemSculpt settings to the changelog tab
   */
  private openChangelogTab(): void {
    import('../modals/ChangeLogModal')
      .then(({ ChangeLogModal }) => {
        const modal = new ChangeLogModal(this.app, this.plugin);
        modal.open();
      })
      .catch(() => {
        new Notice("Unable to open changelog modal.", 4000);
      });
  }

  /**
   * Shows the update-available notice.
   * @param versionInfo Version information to display
   */
  private showUpdateModal(versionInfo: VersionInfo): void {
    this.presentUpdateModal("available", versionInfo);
  }
  
  /**
   * Handles the update button click functionality
   * @param versionInfo Version information for the update
   */
  private handleUpdateButtonClick(versionInfo: VersionInfo): void {
    // In development mode, simulate the update
    if (IS_DEVELOPMENT_BUILD) {
      this.simulateUpdate();
      new Notice(
        "Development Mode: Simulating update...\n\n" +
        "The post-update notification will appear on next reload.",
        5000
      );
      return;
    }
    
    // Production mode: Try to open the update URL (obsidian:// URI scheme)
    window.open(versionInfo.updateUrl, "_blank");
    
    // Show a notice with fallback instructions in case URI scheme doesn't work
    new Notice(
      "Opening SystemSculpt AI in Community Plugins...\n\n" +
      "If nothing happens, please update manually via Settings → Community plugins",
      10000 // Show for 10 seconds
    );
  }

  /**
   * Opens a shared modal for update lifecycle notices.
   */
  private presentUpdateModal(variant: VersionUpdateModalVariant, versionInfo?: VersionInfo): void {
    this.closeUpdateModal();

    const modal = new VersionUpdateModal(this.app, {
      variant,
      currentVersion: this.currentVersion,
      latestVersion: versionInfo?.latestVersion,
      onPrimaryAction: () => {
        if (variant === "available" && versionInfo) {
          this.handleUpdateButtonClick(versionInfo);
          return;
        }
        this.openChangelogTab();
      },
      onClose: () => {
        if (this.updateModal === modal) {
          this.updateModal = null;
        }
        this.clearUpdateModalAutoCloseTimer();
      },
    });

    this.updateModal = modal;
    modal.open();
    this.scheduleUpdateModalAutoClose();
  }

  private scheduleUpdateModalAutoClose(timeoutMs: number = 20000): void {
    this.clearUpdateModalAutoCloseTimer();
    this.updateModalAutoCloseTimer = window.setTimeout(() => {
      this.closeUpdateModal();
    }, timeoutMs);
  }

  private clearUpdateModalAutoCloseTimer(): void {
    if (this.updateModalAutoCloseTimer !== null) {
      window.clearTimeout(this.updateModalAutoCloseTimer);
      this.updateModalAutoCloseTimer = null;
    }
  }

  private closeUpdateModal(): void {
    this.clearUpdateModalAutoCloseTimer();
    if (this.updateModal) {
      const modal = this.updateModal;
      this.updateModal = null;
      modal.close();
    }
  }

  /** Fetches the public latest-release record through the fixed SystemSculpt route. */
  private async fetchLatestVersion(): Promise<string> {
    try {
      const response = await this.plugin
        .getManagedProductIntegrationClient()
        .latestPluginRelease();
      const version = response.data.latestVersion;
      // Only trust a strictly-numeric version string. A malformed/sentinel value
      // ("latest", "v5.8.1-beta", an HTML error page, "99.99.99") must fail safe
      // to "you're up to date" rather than trigger a false update loop (#168).
      if (typeof version === 'string' && this.parseSemver(version)) {
        return version;
      }
      return this.currentVersion;
    } catch (error) {
      return this.currentVersion;
    }
  }

  /**
   * Parse a strict numeric version ("1", "1.2", "1.2.3", "1.2.3.4", with an
   * optional leading "v") into its integer parts. Returns null for anything
   * non-numeric — "latest", "1.2.3-beta", "", whitespace, an HTML error body —
   * so callers can fail safe instead of computing a bogus comparison.
   *
   * This is the guard against the #168 false-"update available" loop: an
   * unparseable remote version must never be treated as "newer than current".
   */
  parseSemver(version: string): number[] | null {
    return parseNumericVersion(version);
  }

  /**
   * Compares two semantic version strings.
   * @returns 1 if A > B, 0 if A = B (or either side is unparseable), -1 if A < B
   *
   * If either version cannot be parsed as a strict numeric semver, returns 0
   * ("treat as equal") rather than guessing — so a malformed value can never
   * make the plugin claim an update is available (#168).
   */
  private compareVersions(versionA: string, versionB: string): number {
    return compareNumericVersions(versionA, versionB);
  }

  /**
   * Restarts update checking when notifications are re-enabled
   */
  public onUpdateNotificationsEnabled(): void {
    if (this.plugin.settings.showUpdateNotifications) {
      this.startPeriodicUpdateCheck();
      // Do a quick check for updates since they were disabled
      this.checkForUpdatesOnStartup(1000); // Short delay since it's user-initiated
    }
  }

  /**
   * Stops update checking when notifications are disabled
   */
  public onUpdateNotificationsDisabled(): void {
    this.stopPeriodicUpdateCheck();
    this.closeUpdateModal();
  }

  /**
   * Clean up resources when the plugin is unloaded
   */
  public unload(): void {
    this.stopPeriodicUpdateCheck();
    this.closeUpdateModal();
  }

  /**
   * Clear the singleton instance to allow proper cleanup
   */
  public static clearInstance(): void {
    if (VersionCheckerService.instance) {
      VersionCheckerService.instance.unload();
      VersionCheckerService.instance = null;
    }
  }
} 
