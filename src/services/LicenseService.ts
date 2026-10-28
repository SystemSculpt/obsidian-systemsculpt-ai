import type SystemSculptPlugin from "../main";
import type { SystemSculptSettings } from "../types";
import type { ManagedAdmission } from "./managed/ManagedAdmission";
import type { ManagedLicenseRejectReason } from "./managed/ManagedAdmissionResponse";

type LicenseRejectReason = ManagedLicenseRejectReason | "missing";
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
  private validationSequence = 0;

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
    const sequence = ++this.validationSequence;
    const licenseKey = this.licenseKey?.trim();
    if (!licenseKey) {
      if (this.plugin.settings.licenseValid) {
        if (!await this.applyValidationSettings(licenseKey, sequence, { licenseValid: false })) return this.unavailableResult();
      }
      return { outcome: "rejected", isValid: false, reason: "missing" };
    }

    try {
      const admission = await this.admission().checkLicense(signal, { fresh: true });
      // A result for a replaced or removed key cannot update the current account.
      if (sequence !== this.validationSequence || licenseKey !== this.licenseKey?.trim()) return this.unavailableResult();
      if (admission.outcome === "allowed") {
        if (!await this.applyValidationSettings(licenseKey, sequence, {
          licenseValid: true,
          subscriptionStatus: "active",
          lastValidated: Date.now(),
        })) return this.unavailableResult();
        return { outcome: "valid", isValid: true };
      }
      // Only the exact negotiated 403/license_rejected envelope may downgrade
      // cached validity. Status codes and HTML error pages alone are not proof
      // that a paid license is invalid.
      if (admission.outcome === "license_rejected" && admission.reason) {
        if (!await this.applyValidationSettings(licenseKey, sequence, { licenseValid: false })) return this.unavailableResult();
        return { outcome: "rejected", isValid: false, reason: admission.reason };
      }

      // Compatibility for servers that predate admission-v1 but return the
      // established successful account envelope. Negotiated responses above
      // remain the only source of authoritative rejection state.
      const legacyProfile = admission.legacyProfile;
      if (legacyProfile) {
        if (!await this.applyValidationSettings(licenseKey, sequence, {
          licenseValid: true,
          userEmail: legacyProfile.email,
          userName: legacyProfile.userName,
          displayName: legacyProfile.displayName,
          subscriptionStatus: "active",
          lastValidated: Date.now(),
        })) return this.unavailableResult();
        return { outcome: "valid", isValid: true };
      }

      return this.unavailableResult();
    } catch {
      return this.unavailableResult();
    }
  }

  private async applyValidationSettings(
    licenseKey: string | undefined,
    sequence: number,
    patch: Partial<SystemSculptSettings>,
  ): Promise<boolean> {
    let applied = false;
    await this.plugin.getSettingsManager().updateSettings((current) => {
      if (sequence !== this.validationSequence || licenseKey !== current.licenseKey?.trim()) return {};
      applied = true;
      return patch;
    });
    return applied;
  }

  private unavailableResult(): LicenseValidationResult {
    return { outcome: "unavailable", isValid: !!this.plugin.settings.licenseValid };
  }
}
