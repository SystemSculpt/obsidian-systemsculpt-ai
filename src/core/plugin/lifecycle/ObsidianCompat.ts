import { compareNumericVersions, parseNumericVersion } from "../../../utils/semver";

/**
 * Minimum Obsidian version SystemSculpt is verified against at runtime. Keep in
 * sync with manifest.json's `minAppVersion`. Obsidian enforces minAppVersion at
 * install time, but a user who side-loads or force-enables on an older build can
 * still reach onload — this gate lets us fail SOFT with a clear message instead
 * of crashing on a missing newer API (#147/#212).
 */
export const MINIMUM_OBSIDIAN_VERSION = "1.7.2";

export interface ObsidianCompatResult {
  supported: boolean;
  currentVersion: string;
  minimumVersion: string;
}

/**
 * Fail-soft Obsidian version check. An unknown/unparseable current version is
 * treated as SUPPORTED — we never block the user on a version we cannot read,
 * only on one we can read and that is genuinely too old.
 */
export function checkObsidianCompatibility(
  currentVersion: string | undefined | null,
  minimumVersion: string = MINIMUM_OBSIDIAN_VERSION,
): ObsidianCompatResult {
  const current = typeof currentVersion === "string" ? currentVersion : "";
  if (!parseNumericVersion(current)) {
    return { supported: true, currentVersion: current, minimumVersion };
  }
  return {
    supported: compareNumericVersions(current, minimumVersion) >= 0,
    currentVersion: current,
    minimumVersion,
  };
}
