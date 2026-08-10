import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import { CACHE_BUSTER } from "../utils/urlHelpers";
import SystemSculptPlugin from "../main";
import { PlatformRequestClient } from "./PlatformRequestClient";
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
  private readonly requestClient: Pick<PlatformRequestClient, "request">;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    requestClient: Pick<PlatformRequestClient, "request"> = new PlatformRequestClient(),
  ) {
    this.requestClient = requestClient;
  }

  /**
   * Get current license key from settings
   */
  private get licenseKey(): string {
    return this.plugin.settings.licenseKey;
  }

  /**
   * Validate the current license key
   */
  public async validateLicenseDetailed(): Promise<LicenseValidationResult> {
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
      const response = await this.requestClient.request({
        url: fullUrl,
        method: "GET",
        headers: headersToSend,
        cache: "no-store",
      });
      const payload = await this.readJson(response);

      const admission = decodeManagedAdmissionResponse(response.status, payload);
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
      const legacyProfile = this.readLegacySuccessProfile(response.status, payload);
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

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
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

}
