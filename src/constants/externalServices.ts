/** Keep offer parameters intact while attributing first-party purchase visits. */
export function withPluginAttribution(href: string, surface: string): string {
  try {
    const url = new URL(href);
    if (!["https://systemsculpt.com", "https://www.systemsculpt.com"].includes(url.origin)
      || !["/pricing", "/subscribe", "/checkout", "/buy-credits"].includes(url.pathname)) return href;
    url.searchParams.set("utm_source", "obsidian-plugin");
    url.searchParams.set("utm_medium", surface);
    url.searchParams.set("utm_campaign", "upgrade");
    return url.toString();
  } catch {
    return href;
  }
}

/** External destinations owned by the plugin UI. */
export const SYSTEMSCULPT_WEBSITE = {
  BASE_URL: "https://systemsculpt.com",
  YEARLY: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
  SUBSCRIBE: "https://systemsculpt.com/subscribe",
  DOCS: "https://systemsculpt.com/obsidian-ai-plugin-docs",
  BILLING: "https://systemsculpt.com/dashboard/billing",
  SUPPORT: "https://systemsculpt.com/contact",
  LICENSE: "https://systemsculpt.com/pricing",
  FEEDBACK: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=SystemSculpt%20Feedback%3A%20&body=Please%20describe%20your%20feedback%3A",
} as const;

export const SYSTEMSCULPT_LEGAL_URLS = {
  TERMS: "https://systemsculpt.com/terms",
  PRIVACY: "https://systemsculpt.com/privacy",
} as const;
