import { Notice } from "obsidian";
import { SystemSculptSettings } from "../types";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { SYSTEMSCULPT_API_ENDPOINTS, SYSTEMSCULPT_API_HEADERS } from "../constants/api";
import { CACHE_BUSTER } from "../utils/urlHelpers";
import SystemSculptPlugin from "../main";

/**
 * Service responsible for license validation and entitlement handling
 */
export class LicenseService {
  private plugin: SystemSculptPlugin;
  private baseUrl: string;
  
  constructor(plugin: SystemSculptPlugin, baseUrl: string) {
    this.plugin = plugin;
    this.baseUrl = baseUrl;
  }

  /**
   * Update the base URL
   */
  public updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
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
  public async validateLicense(_forceCheck = false): Promise<boolean> {
    if (!this.licenseKey?.trim()) {
      if (this.plugin.settings.licenseValid) {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      }
      return false;
    }

    const validationEndpoint = SYSTEMSCULPT_API_ENDPOINTS.LICENSE.VALIDATE();
    
    // Apply cache busting using centralized utility
    // This permanently prevents redirect caching issues in Electron/Obsidian
    const endpointWithCacheBuster = CACHE_BUSTER.apply(validationEndpoint);
    
    const fullUrl = `${this.baseUrl}${endpointWithCacheBuster}`;
    
    const headersToSend = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(this.licenseKey);

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

        try {
        } catch {}

        return true;
      }

      // Unexpected body shape; keep existing state but report as invalid this round
      return !!this.plugin.settings.licenseValid;
    } catch (error) {
      // An authoritative reject (server says the key is no longer valid —
      // revoked / expired / refunded) arrives as a 401/403 and MUST downgrade
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
   * rejecting the key (HTTP 401/403), as opposed to a transient/offline
   * failure. Only an authoritative reject should flip `licenseValid` to false.
   */
  private isAuthoritativeReject(error: unknown): boolean {
    return (
      error instanceof SystemSculptError &&
      (error.statusCode === 401 || error.statusCode === 403)
    );
  }


}
