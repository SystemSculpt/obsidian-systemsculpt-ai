import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import { CACHE_BUSTER } from "../utils/urlHelpers";
import type { HttpRequestError } from "../utils/httpClient";
import SystemSculptPlugin from "../main";

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
    if (!this.licenseKey?.trim()) {
      if (this.plugin.settings.licenseValid) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      return false;
    }

    // Apply cache busting using centralized utility
    // This permanently prevents redirect caching issues in Electron/Obsidian
    const fullUrl = CACHE_BUSTER.apply(`${API_BASE_URL}/license/validate`);
    
    const headersToSend = {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey),
      "x-plugin-version": this.plugin.manifest.version,
    };

    try {
      const { httpRequest } = await import('../utils/httpClient');
      const response = await httpRequest({
        url: fullUrl,
        method: 'GET',
        headers: headersToSend,
      });

      if (response.status !== 200) {
        throw new SystemSculptError(
          `License validation failed with status ${response.status}`,
          ERROR_CODES.INVALID_LICENSE,
          response.status
        );
      }

      const apiResponse: any = response.json;
      
      // Handle both direct response and nested data structure
      const responseData = apiResponse?.data || apiResponse;

      // Treat any 200 as valid; rely on presence of expected fields
      if (responseData && typeof responseData === 'object') {
        await this.plugin.getSettingsManager().updateSettings({
          licenseValid: true,
          userEmail: responseData.email,
          userName: responseData.user_name || responseData.email,
          displayName: responseData.display_name || responseData.user_name || responseData.email,
          subscriptionStatus: responseData.subscription_status,
          lastValidated: Date.now(),
        });

        return true;
      }

      // Unexpected body shape; keep existing state but report as invalid this round
      return !!this.plugin.settings.licenseValid;
    } catch (error) {
      // An authoritative reject (invalid request/key, revoked, expired, refunded)
      // arrives as a 400/401/403/404 and MUST downgrade
      // the cached validity, otherwise a revoked license keeps granting
      // managed-model access indefinitely. Any other failure (offline, DNS
      // blip, timeout, 5xx) is transient: preserve last-known-good validity so
      // a flaky connection never logs a paying user out.
      if (this.isAuthoritativeReject(error)) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
        return false;
      }
      return !!this.plugin.settings.licenseValid;
    }
  }

  /**
   * Whether an error from license validation is the server *authoritatively*
   * rejecting the key (HTTP 400/401/403/404), as opposed to a transient/offline
   * failure. Only an authoritative reject should flip `licenseValid` to false.
   */
  private isAuthoritativeReject(error: unknown): boolean {
    const status = error instanceof SystemSculptError
      ? error.statusCode
      : this.isHttpRequestError(error)
        ? error.status
        : undefined;

    return status !== undefined && [400, 401, 403, 404].includes(status);
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
