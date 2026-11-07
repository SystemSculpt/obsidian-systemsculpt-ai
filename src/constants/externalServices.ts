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

/** Tag a systemsculpt.com page a person opens from the plugin; keeps query and #fragment, skips links already tagged. */
function pluginPageLink(href: string, place: string): string {
  const url = new URL(href);
  if ([...url.searchParams.keys()].some((key) => key.startsWith("utm_"))) return href;
  url.searchParams.set("utm_source", "obsidian-plugin");
  url.searchParams.set("utm_medium", "plugin");
  url.searchParams.set("utm_campaign", "evergreen");
  url.searchParams.set("utm_content", place);
  return url.toString();
}

/** External destinations owned by the plugin UI. */
export const SYSTEMSCULPT_WEBSITE = {
  BASE_URL: "https://systemsculpt.com",
  PATREON_SETTINGS: "https://www.patreon.com/SystemSculpt?utm_source=plugin_settings&utm_campaign=patreon_everywhere",
  PATREON_UPGRADE: "https://www.patreon.com/SystemSculpt?utm_source=plugin_upgrade_modal&utm_campaign=patreon_everywhere",
  /** Upgrade modal plan buttons; each `ref` is in the website's checkout-view catalog. */
  YEARLY: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8&ref=plugin_modal_annual",
  /** Monthly checkout from the low-credits offer; `ref` is in the website's checkout-view catalog. */
  MONTHLY_LOW_CREDITS: "https://systemsculpt.com/checkout?resourceId=0db55c50-daa0-4e46-bf8d-f3f6cf47d729&ref=plugin_low_credits",
  /** Hosted Chat composer only; fixed campaign tags survive the browser sign-in handoff. */
  MONTHLY_HOSTED_CHAT: "https://systemsculpt.com/checkout?resourceId=0db55c50-daa0-4e46-bf8d-f3f6cf47d729&utm_source=plugin&utm_medium=chat&cta=plugin_hosted_chat_monthly&utm_campaign=plugin_hosted_chat_nov2026",
  /** The $9 Monthly checkout from a chat agent's image, video or Studio tool. */
  MONTHLY_CHAT_TOOLS: "https://systemsculpt.com/checkout?resourceId=0db55c50-daa0-4e46-bf8d-f3f6cf47d729&utm_source=plugin&utm_medium=chat&cta=plugin_chat_tools_monthly&utm_campaign=plugin_chat_tools_nov2026",
  BUY_CREDITS: "https://systemsculpt.com/buy-credits?utm_source=obsidian-plugin&utm_medium=chat&utm_campaign=upgrade",
  SUBSCRIBE: "https://systemsculpt.com/subscribe?ref=plugin_modal_monthly",
  DOCS: pluginPageLink("https://systemsculpt.com/obsidian-ai-plugin-docs", "docs"),
  BILLING: pluginPageLink("https://systemsculpt.com/dashboard/billing", "account"),
  SUPPORT: pluginPageLink("https://systemsculpt.com/contact", "support"),
  LICENSE: "https://systemsculpt.com/pricing",
  FEEDBACK: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=SystemSculpt%20Feedback%3A%20&body=Please%20describe%20your%20feedback%3A",
} as const;

export const SYSTEMSCULPT_LEGAL_URLS = {
  TERMS: pluginPageLink("https://systemsculpt.com/terms", "terms"),
  PRIVACY: pluginPageLink("https://systemsculpt.com/privacy", "privacy"),
  PRIVACY_DATA_COLLECTED: pluginPageLink("https://systemsculpt.com/privacy#data-collected", "privacy"),
  YOUTUBE_TERMS: "https://www.youtube.com/t/terms",
} as const;
