import { App, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { showPopup } from "../ui";

export class LicenseManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private lastValidationTime: number = 0;
  private pendingValidation: Promise<void> | null = null;
  private static readonly VALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
  }

  async initializeLicense(): Promise<void> {
    const licenseKey = this.plugin.settings.licenseKey?.trim();
    const SPath = 'licenseValid'; // Settings path for clarity, though not strictly needed here
    const previousLicenseValidState = this.plugin.settings.licenseValid; // Cache state before validation

    if (!licenseKey) {
      // If there's no key, the license cannot be valid.
      // Only update and notify if it was previously considered valid or was undefined.
      if (previousLicenseValidState === true) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
        new Notice("SystemSculpt license key is empty. Pro features disabled.", 5000);
      } else if (typeof previousLicenseValidState === 'undefined') {
        // Handles fresh installs or scenarios where the setting might not exist yet
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      // If previousLicenseValidState was already false, no action needed.
      return;
    }

    const lastValidated = this.plugin.settings.lastValidated ?? 0;
    this.lastValidationTime = lastValidated;
    const now = Date.now();
    const needsValidation =
      !previousLicenseValidState || now - lastValidated >= LicenseManager.VALIDATION_INTERVAL;

    if (!needsValidation) {
      return;
    }

    // Run the heavy validation work asynchronously so startup can complete.
    this.scheduleDeferredValidation(previousLicenseValidState === true);
  }

  async validateLicenseKey(force = false, showReloadPrompt = true): Promise<boolean> {
    if (!this.plugin.settings.licenseKey) {
      await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      return false;
    }

    try {
      const isValid = await this.plugin.aiService.validateLicense(force);
      await this.plugin.getSettingsManager().updateSettings({ licenseValid: isValid });

      if (isValid) {
        this.lastValidationTime = Date.now();
      }

      return isValid;
    } catch (error) {
      await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      return false;
    }
  }

  private scheduleDeferredValidation(hadValidLicense: boolean): void {
    if (this.pendingValidation) {
      return;
    }

    const scheduler =
      typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
        ? (callback: () => void) => (window as any).requestIdleCallback(callback)
        : (callback: () => void) => setTimeout(callback, 0);

    this.pendingValidation = new Promise<void>((resolve) => {
      scheduler(() => {
        void this.validateLicenseKey(true, false).then((isValidNow) => {
          if (hadValidLicense && !isValidNow) {
            new Notice(
              "Your SystemSculpt Pro license is no longer valid or failed to validate. Pro features may be unavailable.",
              7000
            );
          }
        }).finally(() => {
          this.lastValidationTime = this.plugin.settings.lastValidated ?? Date.now();
          this.pendingValidation = null;
          resolve();
        });
      });
    });
  }
}
