/**
 * URL helper utilities for consistent API endpoint handling
 */

import { API_BASE_URL } from "../constants/api";

/**
 * Ensures a server URL has the proper /api/v1 suffix
 * @param serverUrl The base server URL (e.g., "https://api.systemsculpt.com")
 * @returns The normalized URL with /api/v1 suffix
 */
export function normalizeApiUrl(serverUrl: string): string {
  if (!serverUrl) {
    return serverUrl;
  }

  try {
    const parsed = new URL(serverUrl);
    const originalPath = parsed.pathname;
    const trimmedPath = originalPath.replace(/\/+$/, '');

    const hasApiV1 = /\/api\/v1$/i.test(trimmedPath);
    if (hasApiV1) {
      parsed.pathname = trimmedPath || '/api/v1';
      return parsed.toString();
    }

    // Handle hosts that already end with /api
    if (/\/api$/i.test(trimmedPath)) {
      parsed.pathname = `${trimmedPath}/v1`;
      return parsed.toString();
    }

    const basePath = trimmedPath === '' || trimmedPath === '/' ? '' : trimmedPath;
    parsed.pathname = `${basePath}/api/v1`.replace(/\/{2,}/g, '/');
    return parsed.toString();
  } catch {
    // Fallback to legacy behaviour using string manipulation
    const withoutTrailing = serverUrl.replace(/\/+$/, '');
    if (withoutTrailing.endsWith('/api/v1')) {
      return withoutTrailing;
    }
    if (withoutTrailing.endsWith('/api')) {
      return `${withoutTrailing}/v1`;
    }
    return `${withoutTrailing}/api/v1`;
  }
}

const SYSTEMSCULPT_MARKETING_HOSTS = new Set([
  'systemsculpt.com',
  'www.systemsculpt.com'
]);

/**
 * Resolve the canonical SystemSculpt API base URL, correcting common misconfigurations.
 * - Blank / undefined -> production API base
 * - Marketing domains -> api subdomain
 * - Custom hosts -> normalized with /api/v1 suffix preserved
 */
export function resolveSystemSculptApiBaseUrl(serverUrl?: string): string {
  const candidate = (serverUrl || '').trim();
  if (!candidate) {
    return API_BASE_URL;
  }

  let normalized = API_BASE_URL;
  try {
    normalized = normalizeApiUrl(candidate);
    const url = new URL(normalized);
    if (SYSTEMSCULPT_MARKETING_HOSTS.has(url.hostname)) {
      url.hostname = 'api.systemsculpt.com';
      url.port = '';
      return url.toString();
    }
    return url.toString();
  } catch {
    return API_BASE_URL;
  }
}

/**
 * Cache busting constants for Electron redirect issues
 */
export const CACHE_BUSTER = {
  // Only apply to endpoints that might have redirect issues
  shouldApply: (endpoint: string): boolean => {
    // Only license validation has shown redirect issues
    return endpoint.includes('/license/validate');
  },
  
  // Generate cache buster parameter
  generate: (): string => `_t=${Date.now()}`,
  
  // Apply cache buster if needed
  apply: (url: string): string => {
    if (CACHE_BUSTER.shouldApply(url)) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${CACHE_BUSTER.generate()}`;
    }
    return url;
  }
};
