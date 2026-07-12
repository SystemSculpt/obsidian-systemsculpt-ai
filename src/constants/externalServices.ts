/** External destinations owned by the plugin UI and update flow. */
export const GITHUB_API = {
  BASE_URL: "https://api.github.com",
  RELEASES: (owner: string, repo: string) =>
    `https://api.github.com/repos/${owner}/${repo}/releases`,
  RELEASE_URL: (owner: string, repo: string) =>
    `https://github.com/${owner}/${repo}/releases`,
} as const;

export const SYSTEMSCULPT_WEBSITE = {
  BASE_URL: "https://systemsculpt.com",
  LIFETIME: "https://systemsculpt.com/lifetime",
  MONTHLY: "https://systemsculpt.com/resources/a05a7abf-b8bb-41cf-9190-8b795d117fda",
  DOCS: "https://systemsculpt.com/docs",
  SUPPORT: "https://systemsculpt.com/contact",
  LICENSE: "https://systemsculpt.com/resources?tab=license",
  FEEDBACK: "https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues/new?title=SystemSculpt%20Feedback%3A%20&body=Please%20describe%20your%20feedback%3A",
} as const;

export const SYSTEMSCULPT_LEGAL_URLS = {
  TERMS: "https://systemsculpt.com/terms",
  PRIVACY: "https://systemsculpt.com/privacy",
} as const;
