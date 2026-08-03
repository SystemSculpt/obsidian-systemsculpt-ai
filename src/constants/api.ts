declare const __SYSTEMSCULPT_API_BASE_URL__: string | undefined;
declare const __SS_RELEASE_BUILD__: boolean | undefined;

export const PRODUCTION_API_BASE_URL = "https://systemsculpt.com/api/plugin";

function normalizeCompiledApiBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The compiled SystemSculpt API base is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/api/plugin"
  ) {
    throw new Error("The compiled SystemSculpt API base is invalid.");
  }
  return raw;
}

/**
 * Select the compiled endpoint. Missing build defines default to the locked
 * release route. Non-release routes must supply one valid build-time endpoint.
 */
export function selectCompiledApiBaseUrl(
  compiledValue: unknown,
  releaseBuild: boolean,
): string {
  if (releaseBuild) {
    if (
      compiledValue !== undefined
      && compiledValue !== PRODUCTION_API_BASE_URL
    ) {
      throw new Error("Release builds require the production SystemSculpt API.");
    }
    return PRODUCTION_API_BASE_URL;
  }
  if (typeof compiledValue !== "string") {
    throw new Error("Development builds require an explicit SystemSculpt API target.");
  }
  return normalizeCompiledApiBaseUrl(compiledValue);
}

const RELEASE_BUILD =
  typeof __SS_RELEASE_BUILD__ === "boolean" ? __SS_RELEASE_BUILD__ : true;
const COMPILED_API_BASE_URL =
  typeof __SYSTEMSCULPT_API_BASE_URL__ === "string"
    ? __SYSTEMSCULPT_API_BASE_URL__
    : undefined;

/** Build-time API ownership. Runtime settings cannot change this route. */
export const API_BASE_URL = selectCompiledApiBaseUrl(
  COMPILED_API_BASE_URL,
  RELEASE_BUILD,
);
export const IS_DEVELOPMENT_BUILD = !RELEASE_BUILD;

export const SYSTEMSCULPT_API_ENDPOINTS = {
  CREDITS: {
    BALANCE: "/credits/balance",
    USAGE: "/credits/usage",
  },
} as const;

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
