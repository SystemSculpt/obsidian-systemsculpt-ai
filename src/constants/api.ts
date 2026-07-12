declare const __SYSTEMSCULPT_API_BASE_URL__: string | undefined;

export const PRODUCTION_API_BASE_URL = "https://api.systemsculpt.com/api/v1";

/** Build-time API ownership. Local QA overrides this through esbuild only. */
export const API_BASE_URL =
  typeof __SYSTEMSCULPT_API_BASE_URL__ === "string" && __SYSTEMSCULPT_API_BASE_URL__.trim()
    ? __SYSTEMSCULPT_API_BASE_URL__.replace(/\/+$/, "")
    : PRODUCTION_API_BASE_URL;

export const WEBSITE_API_BASE_URL = "https://systemsculpt.com/api/plugin";
export const IS_DEVELOPMENT_BUILD = API_BASE_URL !== PRODUCTION_API_BASE_URL;

export const SYSTEMSCULPT_API_ENDPOINTS = {
  LICENSE: { VALIDATE: () => "/license/validate" },
  CREDITS: {
    BALANCE: "/credits/balance",
    USAGE: "/credits/usage",
  },
} as const;

export interface LicenseValidationResponse {
  email: string;
  subscription_status: string;
  license_key: string;
  user_name?: string;
  display_name?: string;
  has_agents_pack_access?: boolean;
}

export const SYSTEMSCULPT_API_HEADERS = {
  DEFAULT: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-SystemSculpt-Client": "obsidian-plugin",
  },
  WITH_LICENSE: (licenseKey: string) => ({
    ...SYSTEMSCULPT_API_HEADERS.DEFAULT,
    "x-license-key": licenseKey,
  }),
} as const;
