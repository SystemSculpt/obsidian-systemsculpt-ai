import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import { CACHE_BUSTER } from "../utils/urlHelpers";
import type { HttpRequestError } from "../utils/httpClient";
import SystemSculptPlugin from "../main";
import { MANAGED_ADMISSION_CONTRACT } from "./managed/ManagedTypes";
import {
  decodeManagedAdmissionResponse,
  type ManagedLicenseRejectReason,
} from "./managed/ManagedAdmissionResponse";

export type LicenseRejectReason = ManagedLicenseRejectReason | "missing";
export type LicenseValidationResult =
  | Readonly<{ outcome: "valid"; isValid: true }>
  | Readonly<{ outcome: "rejected"; isValid: false; reason: LicenseRejectReason }>
  | Readonly<{ outcome: "unavailable"; isValid: boolean }>;

/**
 * Service responsible for license validation and entitlement handling
 */
export class LicenseService {
  constructor(private readonly plugin: SystemSculptPlugin) {}

  /**
   * Get current license key from settings
   */
  private get licenseKey(): string {
    return this.plugin.settings.licenseKey;
  }

  /**
   * Validate the current license key
   */
  public async validateLicense(_forceCheck = false): Promise<boolean> {
    return (await this.validateLicenseDetailed(_forceCheck)).isValid;
  }

  public async validateLicenseDetailed(_forceCheck = false): Promise<LicenseValidationResult> {
    if (!this.licenseKey?.trim()) {
      if (this.plugin.settings.licenseValid) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      return { outcome: "rejected", isValid: false, reason: "missing" };
    }

    // Apply cache busting using centralized utility
    // This permanently prevents redirect caching issues in Electron/Obsidian
    const fullUrl = CACHE_BUSTER.apply(`${API_BASE_URL}/license/validate`);
    
    const headersToSend = {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey),
      "x-plugin-version": this.plugin.manifest.version,
      "x-systemsculpt-admission-contract": MANAGED_ADMISSION_CONTRACT,
    };

    try {
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url: fullUrl,
        method: 'GET',
        headers: headersToSend,
      });

      const admission = decodeManagedAdmissionResponse(response.status, response.json);
      if (admission.outcome === "allowed") {
        await this.plugin.getSettingsManager().updateSettings({
          licenseValid: true,
          subscriptionStatus: "active",
          lastValidated: Date.now(),
        });
        return { outcome: "valid", isValid: true };
      }

      // Compatibility for servers that predate admission-v1 but return the
      // established successful account envelope. Negotiated responses above
      // remain the only source of authoritative rejection state.
      const legacyProfile = this.readLegacySuccessProfile(response.status, response.json);
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
    } catch (error) {
      const admission = this.isHttpRequestError(error)
        ? decodeManagedAdmissionResponse(error.status, error.json)
        : { outcome: "temporarily_unavailable" as const };

      // Only the exact negotiated 403/license_rejected envelope may downgrade
      // cached validity. Status codes and HTML error pages alone are not proof
      // that a paid license is invalid.
      if (admission.outcome === "license_rejected" && admission.reason) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
        return { outcome: "rejected", isValid: false, reason: admission.reason };
      }
      return this.unavailableResult();
    }
  }

  private unavailableResult(): LicenseValidationResult {
    return { outcome: "unavailable", isValid: !!this.plugin.settings.licenseValid };
  }

  private readLegacySuccessProfile(status: number, value: unknown): {
    email: string;
    userName: string;
    displayName: string;
  } | null {
    if (status !== 200 || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (envelope.status !== "success" || !envelope.data || typeof envelope.data !== "object") return null;
    const profile = envelope.data as Record<string, unknown>;
    if (profile.subscription_status !== "active" || typeof profile.email !== "string") return null;
    const userName = typeof profile.user_name === "string" ? profile.user_name : profile.email;
    const displayName = typeof profile.display_name === "string" ? profile.display_name : userName;
    return { email: profile.email, userName, displayName };
  }

  private isHttpRequestError(error: unknown): error is HttpRequestError {
    return (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
    );
  }

}
