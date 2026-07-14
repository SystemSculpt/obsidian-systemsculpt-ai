import { API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from '../../constants/api';

/**
 * Centralized resolver for SystemSculpt API configuration.
 * Ensures every subsystem derives URLs and headers consistently.
 */
export class SystemSculptEnvironment {
  /**
   * Resolve the canonical base URL for the SystemSculpt API.
   * Development builds may normalize configured overrides, but production
   * builds always pin hosted traffic to the compiled production API.
   */
  static resolveBaseUrl(): string {
    return API_BASE_URL;
  }

  /**
   * Construct headers for authorized requests. Falls back to JSON headers when
   * a license key is not present so callers do not need to special case.
   */
  static buildHeaders(licenseKey?: string): Record<string, string> {
    if (!licenseKey) {
      return { ...SYSTEMSCULPT_API_HEADERS.DEFAULT };
    }
    return SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);
  }
}
