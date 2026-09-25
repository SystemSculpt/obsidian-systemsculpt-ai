import type SystemSculptPlugin from "../main";
import type { ManagedAdmission } from "./managed/ManagedAdmission";
import type { ManagedLicenseRejectReason } from "./managed/ManagedAdmissionResponse";

export type LicenseRejectReason = ManagedLicenseRejectReason | "missing";
export type LicenseValidationResult =
  | Readonly<{ outcome: "valid"; isValid: true }>
  | Readonly<{ outcome: "rejected"; isValid: false; reason: LicenseRejectReason }>
  | Readonly<{ outcome: "unavailable"; isValid: boolean }>;

type LicenseAdmission = Pick<ManagedAdmission, "checkLicense">;

/**
 * Projects license validation into settings (licenseValid, lastValidated,
 * and the legacy profile fields). The read itself goes through the plugin's
 * managed admission, so explicit validation and managed operations share one
 * license source of truth and one cache (#386).
 */
export class LicenseService {
  constructor(
    private readonly plugin: SystemSculptPlugin,
    private readonly admission: () => LicenseAdmission = () => plugin.getManagedCapabilityGraph().admission,
  ) {}

  /**
   * Get current license key from settings
   */
  private get licenseKey(): string {
    return this.plugin.settings.licenseKey;
  }

  /**
   * Validate the current license key with a fresh admission read. An aborted
   * or timed-out check is "unavailable": it never downgrades the cached
   * validity.
   */
  public async validateLicenseDetailed(signal?: AbortSignal): Promise<LicenseValidationResult> {
    if (!this.licenseKey?.trim()) {
      if (this.plugin.settings.licenseValid) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      return { outcome: "rejected", isValid: false, reason: "missing" };
    }

    try {
      const admission = await this.admission().checkLicense(signal, { fresh: true });
      if (admission.outcome === "allowed") {
        await this.plugin.getSettingsManager().updateSettings({
          licenseValid: true,
          subscriptionStatus: "active",
          lastValidated: Date.now(),
        });
        return { outcome: "valid", isValid: true };
      }
      // Only the exact negotiated 403/license_rejected envelope may downgrade
      // cached validity. Status codes and HTML error pages alone are not proof
      // that a paid license is invalid.
      if (admission.outcome === "license_rejected" && admission.reason) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
        return { outcome: "rejected", isValid: false, reason: admission.reason };
      }

      // Compatibility for servers that predate admission-v1 but return the
      // established successful account envelope. Negotiated responses above
      // remain the only source of authoritative rejection state.
      const legacyProfile = admission.legacyProfile;
      if (legacyProfile) {
        await this.plugin.getSettingsManager().updateSettings({
          licenseValid: true,
          userEmail: legacyProfile.email,
          userName: legacyProfile.userName,
          displayName: legacyProfile.displayName,
          subscriptionStatus: "active",
          lastValidated: Date.now(),
        });
        return { outcome: "valid", isValid: true };
      }

      return this.unavailableResult();
    } catch {
      return this.unavailableResult();
    }
  }

  private unavailableResult(): LicenseValidationResult {
    return { outcome: "unavailable", isValid: !!this.plugin.settings.licenseValid };
  }
}
