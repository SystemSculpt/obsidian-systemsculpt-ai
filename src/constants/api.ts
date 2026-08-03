declare const __SYSTEMSCULPT_API_BASE_URL__: string | undefined;
declare const __SS_RELEASE_BUILD__: boolean | undefined;

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

const RELEASE_BUILD =
  typeof __SS_RELEASE_BUILD__ === "boolean" ? __SS_RELEASE_BUILD__ : true;

const COMPILED_API_BASE_URL =
  typeof __SYSTEMSCULPT_API_BASE_URL__ === "string"
    ? __SYSTEMSCULPT_API_BASE_URL__
    : undefined;
if (COMPILED_API_BASE_URL === undefined) {
  // Real bundles always carry the define; src/tests/setup.ts supplies it for
  // Jest hosts. No literal fallback may live here: the artifact gate requires
  // each built artifact to contain exactly one plugin API base, and esbuild
  // keeps dead ternary branches in unminified output.
  throw new Error("The SystemSculpt API base was not compiled into this build.");
}

/**
 * Build-time API ownership. Runtime settings cannot change this route. Route
 * validity (release builds must target the canonical endpoint) is enforced at
 * build time by scripts/plugin-build-options.mjs and the artifact gate in
 * scripts/plugin-artifacts.mjs.
 */
export const API_BASE_URL = normalizeCompiledApiBaseUrl(COMPILED_API_BASE_URL);
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
