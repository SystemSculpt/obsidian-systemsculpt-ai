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

        // Reset embeddings cooldown so user can immediately use embeddings after fixing their license
        try {
          this.plugin.embeddingsManager?.resetLicenseCooldown();
        } catch {}

        return true;
      }

      // Unexpected body shape; keep existing state but report as invalid this round
      return !!this.plugin.settings.licenseValid;
    } catch (error) {
      // Offline or server error: preserve last known good validity
      return !!this.plugin.settings.licenseValid;
    }
  }


}
