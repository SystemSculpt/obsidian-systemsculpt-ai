import { API_BASE_URL, DEVELOPMENT_MODE, SYSTEMSCULPT_API_HEADERS } from '../../constants/api';
import { SystemSculptSettings } from '../../types';
import { resolveSystemSculptApiBaseUrl } from '../../utils/urlHelpers';

export interface ApiEnvironmentConfig {
  baseUrl: string;
  licenseKey?: string;
}

/**
 * Centralized resolver for SystemSculpt API configuration.
 * Ensures every subsystem derives URLs and headers consistently.
 */
export class SystemSculptEnvironment {
  /**
   * Resolve the canonical base URL for the SystemSculpt API.
   * Applies marketing-domain correction, /api/v1 normalization, and
   * falls back to the compiled API_BASE_URL when the input is blank.
   */
  static resolveBaseUrl(
    settings: Pick<SystemSculptSettings, 'serverUrl'>,
    override?: string
  ): string {
    const candidate = typeof override === 'string' && override.trim().length > 0
      ? override.trim()
      : (settings.serverUrl?.trim() || '');

    // In production builds, never honor localhost/loopback server settings.
    if (candidate && DEVELOPMENT_MODE === 'PRODUCTION') {
      const lower = candidate.toLowerCase();
      if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
        return API_BASE_URL;
      }
    }

    return resolveSystemSculptApiBaseUrl(candidate || API_BASE_URL);
  }

  /**
   * Build a reusable API environment snapshot (base URL + license key).
   */
  static createConfig(
    settings: Pick<SystemSculptSettings, 'serverUrl' | 'licenseKey'>,
    override?: string
  ): ApiEnvironmentConfig {
    return {
      baseUrl: this.resolveBaseUrl(settings, override),
      licenseKey: settings.licenseKey?.trim() || undefined,
    };
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
