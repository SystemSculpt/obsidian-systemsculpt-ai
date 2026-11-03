import { apiVersion } from "obsidian";
import { API_BASE_URL } from "../../constants/api";
import { getHostOperatingSystem } from "../../platform/hostCapabilities";

/**
 * Client tags sent only to the first-party SystemSculpt API so its server-side
 * usage metrics can split by plugin version, Obsidian version and platform.
 * Obsidian forbids client-side telemetry; these headers ride on requests the
 * plugin already makes and carry no note content, ids or keys.
 */
let pluginVersion = "";

export function setClientPluginVersion(version: string): void {
  pluginVersion = typeof version === "string" ? version.trim() : "";
}

export type ClientPlatformTag = "ios" | "android" | "macos" | "windows" | "linux";

const PLATFORM_TAGS: Record<string, ClientPlatformTag> = {
  iOS: "ios", Android: "android", macOS: "macos", Windows: "windows", Linux: "linux",
};

export function clientPlatformTag(): ClientPlatformTag | null {
  return PLATFORM_TAGS[getHostOperatingSystem()] ?? null;
}

const API_ORIGIN = new URL(API_BASE_URL).origin;

export function isSystemSculptApiUrl(url: string): boolean {
  try {
    return new URL(url).origin === API_ORIGIN;
  } catch {
    return false;
  }
}

export function clientIdentityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (pluginVersion) headers["x-plugin-version"] = pluginVersion;
  const obsidianVersion = typeof apiVersion === "string" ? apiVersion.trim() : "";
  if (obsidianVersion) headers["x-obsidian-version"] = obsidianVersion;
  const platform = clientPlatformTag();
  if (platform) headers["x-systemsculpt-platform"] = platform;
  return headers;
}

/** Identity headers for API URLs; caller headers win on a name clash. */
export function withClientIdentityHeaders(
  url: string,
  headers: Record<string, string>,
): Record<string, string> {
  if (!isSystemSculptApiUrl(url)) return headers;
  const identity = clientIdentityHeaders();
  const taken = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  for (const name of Object.keys(identity)) {
    if (taken.has(name)) delete identity[name];
  }
  return { ...identity, ...headers };
}
