/**
 * VersionCheckerService
 * Handles checking for updates by comparing the current plugin version
 * with the latest release from the GitHub repository.
 */
import { requestUrl, Notice, App } from "obsidian";
import SystemSculptPlugin from "../main";
import { DEVELOPMENT_MODE } from "../constants/api";
import { GITHUB_API } from "../constants/externalServices";
import { API_BASE_URL, SYSTEMSCULPT_API_ENDPOINTS } from "../constants/api";

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
  private updateDrawerEl: HTMLElement | null = null;
  private periodicCheckIntervalMs: number = 1000 * 60 * 60; // 1 hour
  private periodicCheckTimeout: NodeJS.Timeout | null = null;
  private startupCheckAbortController: AbortController | null = null;
  
  // Development mode state to track update flow
  private devModeUpdateState: "show-update" | "show-post-update" = "show-update";

  private constructor(currentVersion: string, app: App, plugin: SystemSculptPlugin) {
    this.currentVersion = currentVersion;
    this.app = app;
    this.plugin = plugin;
    
    // Load dev mode state from localStorage if in development mode
    if (DEVELOPMENT_MODE === "DEVELOPMENT") {
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
    if (DEVELOPMENT_MODE === "DEVELOPMENT") {
      this.devModeUpdateState = "show-post-update";
      localStorage.setItem("systemsculpt-dev-update-state", "show-post-update");
    }
  }
  
  /**
   * Resets the development mode update flow
   */
  public resetDevUpdateFlow(): void {
    if (DEVELOPMENT_MODE === "DEVELOPMENT") {
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
    if (DEVELOPMENT_MODE !== "DEVELOPMENT" && !this.plugin.settings.showUpdateNotifications) {
      return;
    }
    
    // Clear any existing timeout
    this.stopPeriodicUpdateCheck();
    
    // Schedule periodic checks
    this.periodicCheckTimeout = setInterval(() => {
      this.checkForUpdatesQuietly();
    }, this.periodicCheckIntervalMs);
  }
  
  /**
   * Stops the periodic update checker
   */
  public stopPeriodicUpdateCheck(): void {
    if (this.periodicCheckTimeout) {
      clearInterval(this.periodicCheckTimeout);
      this.periodicCheckTimeout = null;
    }
  }
  
  /**
   * Checks for updates in background without showing notification
   * if already on the latest version
   */
  private async checkForUpdatesQuietly(): Promise<void> {
    // Don't check if notifications are disabled (unless in development mode)
    if (DEVELOPMENT_MODE !== "DEVELOPMENT" && !this.plugin.settings.showUpdateNotifications) {
      return;
    }
    
    try {
      let versionInfo = await this.checkVersion(true); // Force refresh
      
      // In development mode, always show update available if we're in show-update state
      if (DEVELOPMENT_MODE === "DEVELOPMENT" && this.devModeUpdateState === "show-update") {
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
        this.showUpdateDrawer(versionInfo);
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
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Handle development mode flow
    if (DEVELOPMENT_MODE === "DEVELOPMENT") {
      if (this.devModeUpdateState === "show-post-update") {
        this.showPostUpdateDrawer();
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
        this.showUpdateDrawer(fakeVersionInfo);
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
      this.showPostUpdateDrawer();
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
      if (controller.signal.aborted || (!this.plugin.settings.showUpdateNotifications && DEVELOPMENT_MODE !== "DEVELOPMENT")) {
        return;
      }
      try {
        const versionInfo = await this.checkVersion();
        if (controller.signal.aborted) {
          return;
        }
        if (!versionInfo.isLatest) {
          this.showUpdateDrawer(versionInfo);
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

    setTimeout(runner, timeoutMs);
  }

  /**
   * Shows a post-update notification drawer
   */
  private showPostUpdateDrawer(): void {
    // Remove any existing drawer
    this.removeUpdateDrawer();
    
    // Create drawer element
    this.updateDrawerEl = document.createElement('div');
    this.updateDrawerEl.classList.add('systemsculpt-update-drawer');
    
    // Add accessibility attributes
    this.updateDrawerEl.setAttribute('role', 'dialog');
    this.updateDrawerEl.setAttribute('aria-labelledby', 'update-drawer-title');
    this.updateDrawerEl.setAttribute('aria-describedby', 'update-drawer-message');
    
    // Add drawer content for post-update notification
    this.updateDrawerEl.innerHTML = `
      <div class="systemsculpt-update-drawer-header">
        <div id="update-drawer-title" class="systemsculpt-update-drawer-title">SystemSculpt AI Updated</div>
        <button class="systemsculpt-update-drawer-close" aria-label="Close" type="button"></button>
      </div>
      <div class="systemsculpt-update-drawer-content">
        <div id="update-drawer-message" class="systemsculpt-update-drawer-message">
          Update completed successfully!
        </div>
        <div class="systemsculpt-update-drawer-versions" aria-label="Current version">
          <span class="systemsculpt-update-drawer-latest">v${this.currentVersion}</span>
        </div>
        <button class="systemsculpt-update-drawer-button" type="button">View Changelog</button>
      </div>
    `;
    
    // Add to document
    document.body.appendChild(this.updateDrawerEl);
    
    // Add event listeners
    const closeButton = this.updateDrawerEl.querySelector('.systemsculpt-update-drawer-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        this.removeUpdateDrawer();
      });
      
      // Add keyboard support for close button
      closeButton.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.removeUpdateDrawer();
        }
      });
    }
    
    const changelogButton = this.updateDrawerEl.querySelector('.systemsculpt-update-drawer-button');
    if (changelogButton) {
      changelogButton.addEventListener('click', () => {
        this.openChangelogTab();
        this.removeUpdateDrawer();
      });
      
      // Add keyboard support for changelog button
      changelogButton.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openChangelogTab();
          this.removeUpdateDrawer();
        }
      });
    }
    
    // Add global keyboard listener for Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.removeUpdateDrawer();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
    
    // Show drawer with animation
    setTimeout(() => {
      if (this.updateDrawerEl) {
        this.updateDrawerEl.classList.add('visible');
      }
    }, 100);
    
    // Auto-hide after 20 seconds
    setTimeout(() => {
      this.removeUpdateDrawer();
    }, 20000);
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
   * Shows a custom update drawer in the bottom right corner
   * @param versionInfo Version information to display
   */
  private showUpdateDrawer(versionInfo: VersionInfo): void {
    // Remove any existing drawer
    this.removeUpdateDrawer();
    
    // Create drawer element
    this.updateDrawerEl = document.createElement('div');
    this.updateDrawerEl.classList.add('systemsculpt-update-drawer');
    
    // Add accessibility attributes
    this.updateDrawerEl.setAttribute('role', 'dialog');
    this.updateDrawerEl.setAttribute('aria-labelledby', 'update-drawer-title');
    this.updateDrawerEl.setAttribute('aria-describedby', 'update-drawer-message');
    
    // Add drawer content with minimal styling
    this.updateDrawerEl.innerHTML = `
      <div class="systemsculpt-update-drawer-header">
        <div id="update-drawer-title" class="systemsculpt-update-drawer-title">SystemSculpt AI Update</div>
        <button class="systemsculpt-update-drawer-close" aria-label="Close" type="button"></button>
      </div>
      <div class="systemsculpt-update-drawer-content">
        <div id="update-drawer-message" class="systemsculpt-update-drawer-message">
          Version ${versionInfo.latestVersion} is available.
        </div>
        <div class="systemsculpt-update-drawer-versions" aria-label="Version information">
          <span class="systemsculpt-update-drawer-current">v${versionInfo.currentVersion}</span>
          <span class="systemsculpt-update-drawer-arrow">→</span>
          <span class="systemsculpt-update-drawer-latest">v${versionInfo.latestVersion}</span>
        </div>
        <button class="systemsculpt-update-drawer-button" type="button">Update</button>
      </div>
    `;
    
    // Add to document (CSS is now loaded via CSS import)
    document.body.appendChild(this.updateDrawerEl);
    
    // Add event listeners
    const closeButton = this.updateDrawerEl.querySelector('.systemsculpt-update-drawer-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        this.removeUpdateDrawer();
      });
      
      // Add keyboard support for close button
      closeButton.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.removeUpdateDrawer();
        }
      });
    }
    
    const updateButton = this.updateDrawerEl.querySelector('.systemsculpt-update-drawer-button');
    if (updateButton) {
      updateButton.addEventListener('click', () => {
        this.handleUpdateButtonClick(versionInfo);
      });
      
      // Add keyboard support for update button
      updateButton.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.handleUpdateButtonClick(versionInfo);
        }
      });
    }
    
    // Add global keyboard listener for Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.removeUpdateDrawer();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
    
    // Show drawer with animation
    setTimeout(() => {
      if (this.updateDrawerEl) {
        this.updateDrawerEl.classList.add('visible');
      }
    }, 100);
    
    // Auto-hide after 20 seconds (increased from 15 to give users more time)
    setTimeout(() => {
      this.removeUpdateDrawer();
    }, 20000);
  }
  
  /**
   * Handles the update button click functionality
   * @param versionInfo Version information for the update
   */
  private handleUpdateButtonClick(versionInfo: VersionInfo): void {
    // In development mode, simulate the update
    if (DEVELOPMENT_MODE === "DEVELOPMENT") {
      this.simulateUpdate();
      new Notice(
        "Development Mode: Simulating update...\n\n" +
        "The post-update notification will appear on next reload.",
        5000
      );
      this.removeUpdateDrawer();
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
    
    // Remove the drawer
    this.removeUpdateDrawer();
  }

  /**
   * Removes the update drawer from the DOM
   */
  private removeUpdateDrawer(): void {
    if (this.updateDrawerEl) {
      // First fade out with CSS transition
      this.updateDrawerEl.classList.remove('visible');
      
      // Then remove from DOM after transition completes
      setTimeout(() => {
        if (this.updateDrawerEl && this.updateDrawerEl.parentNode) {
          this.updateDrawerEl.parentNode.removeChild(this.updateDrawerEl);
          this.updateDrawerEl = null;
        }
      }, 300); // Match this with the CSS transition duration
    }
  }

  /**
   * Fetches the latest version from GitHub releases
   * @returns The latest version string
   */
  private async fetchLatestVersion(): Promise<string> {
    // Prefer our server endpoint for latest version to avoid GitHub rate limits
    const apiUrl = `${API_BASE_URL}${SYSTEMSCULPT_API_ENDPOINTS.PLUGINS.LATEST(this.pluginId)}`;
    
    try {
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url: apiUrl,
        method: 'GET',
        headers: { "Accept": "application/json" }
      });

      if (response.status === 403) {
        return this.currentVersion;
      }

      if (!response.status || response.status !== 200) {
        // Gracefully degrade on network errors in Obsidian Electron (e.g., net::ERR_FAILED)
        return this.currentVersion;
      }

      const data = response.json || (response.text ? JSON.parse(response.text) : {});
      const version = data?.data?.latestVersion;
      if (typeof version === 'string') {
        return version;
      }
      return this.currentVersion;
    } catch (error) {
      return this.currentVersion;
    }
  }

  /**
   * Compares two semantic version strings
   * @param versionA First version (typically current)
   * @param versionB Second version (typically latest)
   * @returns 1 if A > B, 0 if A = B, -1 if A < B
   */
  private compareVersions(versionA: string, versionB: string): number {
    const partsA = versionA.split('.').map(part => parseInt(part, 10));
    const partsB = versionB.split('.').map(part => parseInt(part, 10));
    
    // Compare each part of the version
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = i < partsA.length ? partsA[i] : 0;
      const partB = i < partsB.length ? partsB[i] : 0;
      
      if (partA > partB) return 1;
      if (partA < partB) return -1;
    }
    
    return 0; // Versions are equal
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
    this.removeUpdateDrawer();
  }

  /**
   * Clean up resources when the plugin is unloaded
   */
  public unload(): void {
    this.stopPeriodicUpdateCheck();
    this.removeUpdateDrawer();
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
