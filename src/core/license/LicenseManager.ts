import type { App } from "obsidian";
import { Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import type { LicenseValidationOptions, LicenseValidationResult } from "../../services/LicenseService";
import { LICENSE_SIGNED_OUT_NOTICE } from "../../utils/licenseUtils";

export class LicenseManager {
  private plugin: SystemSculptPlugin;
  private pendingValidation: Promise<void> | null = null;
  private recheck: Readonly<{ licenseKey: string; startedAt: number; done: Promise<void> }> | null = null;
  /** Checks of a key typed into Account settings still running. */
  private enteredKeyChecks = 0;
  private static readonly VALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  /** Refused requests for the same key within this window share one re-check. */
  private static readonly RECHECK_INTERVAL = 60 * 1000;

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

  async validateLicenseKeyDetailed(options: LicenseValidationOptions = {}): Promise<LicenseValidationResult> {
    if (!this.plugin.settings.licenseKey) {
      await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      return { outcome: "rejected", isValid: false, reason: "missing" };
    }

    if (options.enteredKey) this.enteredKeyChecks += 1;
    try {
      return await this.plugin.aiService.validateLicenseDetailed(options);
    } catch {
      return { outcome: "unavailable", isValid: !!this.plugin.settings.licenseValid };
    } finally {
      if (options.enteredKey) this.enteredKeyChecks -= 1;
    }
  }

  /**
   * A hosted request refused the stored key. Ask the server whether the key
   * still works: a key it no longer knows, such as one replaced from the
   * dashboard, signs the plugin out; nothing else changes. Refusals of the
   * same key within a minute share one check, so a burst of failed requests
   * asks once. While a key typed into Account settings is checked, that check
   * decides: a refusal of the typed key must not sign the account out.
   */
  recheckAfterRejection(): Promise<void> {
    const licenseKey = this.plugin.settings.licenseKey?.trim();
    if (!licenseKey || this.enteredKeyChecks > 0) return Promise.resolve();
    const now = Date.now();
    if (this.recheck?.licenseKey === licenseKey && now - this.recheck.startedAt < LicenseManager.RECHECK_INTERVAL) {
      return this.recheck.done;
    }
    const done = this.validateLicenseKeyDetailed({ afterRefusal: true })
      .then((result) => this.announceSignOut(result))
      .catch(() => undefined);
    this.recheck = { licenseKey, startedAt: now, done };
    return done;
  }

  /** A sign-out found in the background is told once, and an open Account tab shows it. */
  private announceSignOut(result: LicenseValidationResult): void {
    if (result.outcome !== "rejected" || !result.signedOut) return;
    new Notice(LICENSE_SIGNED_OUT_NOTICE, 10_000);
    const tab = this.plugin.settingsTab;
    if (!tab?.containerEl?.isConnected) return;
    void Promise.resolve().then(() => tab.refreshAccountSection()).catch(() => undefined);
  }

  private scheduleDeferredValidation(hadValidLicense: boolean): void {
    if (this.pendingValidation) {
      return;
    }

    const scheduler =
      typeof window !== "undefined" && typeof window.requestIdleCallback === "function"
        ? (callback: () => void) => window.requestIdleCallback(callback)
        : (callback: () => void) => window.setTimeout(callback, 0);

    const licenseKey = this.plugin.settings.licenseKey?.trim();
    this.pendingValidation = new Promise<void>((resolve) => {
      scheduler(() => {
        void this.validateLicenseKeyDetailed().then((result) => {
          this.announceSignOut(result);
          if (hadValidLicense && !result.isValid && licenseKey === this.plugin.settings.licenseKey?.trim()) {
            new Notice(
              "Couldn't validate your license. Check your account.",
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
