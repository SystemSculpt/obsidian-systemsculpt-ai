import type { App } from "obsidian";
import { Notice } from "obsidian";
import SystemSculptPlugin from "../../main";

export class LicenseManager {
  private plugin: SystemSculptPlugin;
  private pendingValidation: Promise<void> | null = null;
  private static readonly VALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(plugin: SystemSculptPlugin, _app: App) {
    this.plugin = plugin;
  }

  async initializeLicense(): Promise<void> {
    const licenseKey = this.plugin.settings.licenseKey?.trim();
    const previousLicenseValidState = this.plugin.settings.licenseValid; // Cache state before validation

    if (!licenseKey) {
      // If there's no key, the license cannot be valid.
      // Only update and notify if it was previously considered valid or was undefined.
      if (previousLicenseValidState === true) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
        new Notice("License key is empty. Premium features disabled.", 5000);
      } else if (typeof previousLicenseValidState === 'undefined') {
        // Handles fresh installs or scenarios where the setting might not exist yet
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      // If previousLicenseValidState was already false, no action needed.
      return;
    }

    const lastValidated = this.plugin.settings.lastValidated ?? 0;
    const now = Date.now();
    const needsValidation =
      !previousLicenseValidState || now - lastValidated >= LicenseManager.VALIDATION_INTERVAL;

    if (!needsValidation) {
      return;
    }

    // Run the heavy validation work asynchronously so startup can complete.
    this.scheduleDeferredValidation(previousLicenseValidState === true);
  }

  async validateLicenseKey(force = false, _showReloadPrompt = true): Promise<boolean> {
    if (!this.plugin.settings.licenseKey) {
      await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      return false;
    }

    try {
      const isValid = await this.plugin.aiService.validateLicense(force);

      return isValid;
    } catch (error) {
      return !!this.plugin.settings.licenseValid;
    }
  }

  private scheduleDeferredValidation(hadValidLicense: boolean): void {
    if (this.pendingValidation) {
      return;
    }

    const scheduler =
      typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
        ? (callback: () => void) => (window as any).requestIdleCallback(callback)
        : (callback: () => void) => window.setTimeout(callback, 0);

    this.pendingValidation = new Promise<void>((resolve) => {
      scheduler(() => {
        void this.validateLicenseKey(true, false).then((isValidNow) => {
          if (hadValidLicense && !isValidNow) {
            new Notice(
              "Your SystemSculpt license is no longer valid or failed to validate. Premium features may be unavailable.",
              7000
            );
          }
        }).finally(() => {
          this.pendingValidation = null;
          resolve();
        });
      });
    });
  }
}
