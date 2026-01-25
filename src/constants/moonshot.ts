/**
 * Moonshot (Kimi) API constants and helpers
 */

export const MOONSHOT_API_BASE_URL = "https://api.moonshot.ai/v1";

/**
 * Detect whether a custom provider endpoint is targeting Moonshot/Kimi APIs.
 * We look for common Moonshot hostnames while tolerating arbitrary path suffixes.
 */
export function isMoonshotEndpoint(endpoint: string): boolean {
  if (!endpoint) {
    return false;
  }

  const lower = endpoint.toLowerCase();
  if (lower.includes("moonshot.ai") || lower.includes("moonshot.cn")) {
    return true;
  }

  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return host.includes("moonshot.ai") || host.includes("moonshot.cn");
  } catch {
    return false;
  }
}

