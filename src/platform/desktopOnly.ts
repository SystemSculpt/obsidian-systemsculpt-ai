import { PlatformContext } from "../services/PlatformContext";

/**
 * Canonical boundary for Node-dependent desktop code (#207).
 *
 * The plugin manifest is desktop-only, but startup-sensitive modules still
 * route Node builtins (`fs`, `path`, `child_process`, …) through this shared
 * lazy boundary so those subsystems are only evaluated when needed.
 */

/** True iff the current platform seam allows Node.js access. */
export function hasNodeRuntime(): boolean {
  return PlatformContext.get().supportsNodeApis();
}

/**
 * Lazily load a desktop-only module. The loader MUST perform the `require`
 * itself so it stays lazy, e.g.
 * `loadDesktopOnly(() => require("./PiSdkDesktopSupport"))`.
 */
export function loadDesktopOnly<T>(loader: () => T): T | null {
  return hasNodeRuntime() ? loader() : null;
}
