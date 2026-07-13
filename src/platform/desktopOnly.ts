/**
 * Canonical boundary for Node-dependent desktop code (#207).
 *
 * The plugin manifest is desktop-only, but startup-sensitive modules still
 * route Node builtins (`fs`, `path`, `child_process`, …) through this shared
 * lazy boundary so those subsystems are only evaluated when needed.
 */

/** The managed build always runs inside Obsidian's desktop Electron runtime. */
export function hasNodeRuntime(): boolean {
  return true;
}

/**
 * Lazily load a desktop-only module. The loader performs the `require` so
 * startup-sensitive Node modules remain demand-loaded.
 */
export function loadDesktopOnly<T>(loader: () => T): T {
  return loader();
}
