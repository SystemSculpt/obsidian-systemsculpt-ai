import { Platform } from "obsidian";

/**
 * The one host seam for capabilities Obsidian only exposes on desktop.
 *
 * Node modules must never be imported by a feature module. Keeping every
 * literal Node `require` here makes the production bundle safe to evaluate in
 * Obsidian Mobile while preserving the desktop implementation on demand.
 */

export class DesktopHostUnavailableError extends Error {
  constructor(capability: string) {
    super(`${capability} is available in Obsidian Desktop only.`);
    this.name = "DesktopHostUnavailableError";
  }
}

/** True only inside Obsidian's desktop Electron host with a Node runtime. */
export function hasNodeRuntime(): boolean {
  return Platform.isDesktopApp &&
    typeof process !== "undefined" &&
    typeof process.versions?.node === "string";
}

/**
 * Lazily load a desktop-only module. The loader performs the `require` so
 * startup-sensitive Node modules remain demand-loaded.
 */
export function loadDesktopOnly<T>(
  loader: () => T,
  capability = "This feature",
): T {
  if (!hasNodeRuntime()) {
    throw new DesktopHostUnavailableError(capability);
  }
  return loader();
}

type DesktopFs = typeof import("node:fs/promises");
type DesktopPath = typeof import("node:path");
type DesktopOs = typeof import("node:os");
type DesktopChildProcess = typeof import("node:child_process");

/** Lazily loaded Node modules. Call only after the feature has entered a desktop path. */
export const desktopHost = {
  fs(): DesktopFs {
    return loadDesktopOnly(
      () => require("node:fs/promises") as DesktopFs,
      "Local filesystem access",
    );
  },

  path(): DesktopPath {
    return loadDesktopOnly(
      () => require("node:path") as DesktopPath,
      "Local filesystem paths",
    );
  },

  os(): DesktopOs {
    return loadDesktopOnly(
      () => require("node:os") as DesktopOs,
      "Temporary local storage",
    );
  },

  childProcess(): DesktopChildProcess {
    return loadDesktopOnly(
      () => require("node:child_process") as DesktopChildProcess,
      "CLI execution",
    );
  },

  environment(): Record<string, string | undefined> {
    if (!hasNodeRuntime()) {
      throw new DesktopHostUnavailableError("CLI environment access");
    }
    return process.env;
  },
} as const;
