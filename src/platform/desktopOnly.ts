import { Platform } from "obsidian";

export type DesktopCpuUsage = Readonly<{ user: number; system: number }>;

export type DesktopProcess = Readonly<{
  versions?: Readonly<{ node?: string }>;
  env?: Record<string, string | undefined>;
  memoryUsage?: () => Readonly<{
    rss?: number;
    external?: number;
    heapUsed?: number;
    heapTotal?: number;
  }>;
  cpuUsage?: () => DesktopCpuUsage;
  getCPUUsage?: () => Readonly<{
    percentCPUUsage?: number;
    user?: number;
    system?: number;
  }>;
}>;

declare const process: DesktopProcess | undefined;

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

export function getDesktopProcess(): DesktopProcess | null {
  return typeof process === "undefined" ? null : process;
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

type DesktopWindow = Window & {
  require?: (specifier: string) => unknown;
};

function loadDesktopModule<T>(specifier: string, capability: string): T {
  if (!Platform.isDesktop || !hasNodeRuntime()) {
    throw new DesktopHostUnavailableError(capability);
  }
  const moduleLoader = (window as DesktopWindow).require;
  if (typeof moduleLoader !== "function") {
    throw new DesktopHostUnavailableError(capability);
  }
  return moduleLoader(specifier) as T;
}

/** Lazily loaded Node modules. Call only after the feature has entered a desktop path. */
export const desktopHost = {
  async fs() {
    return loadDesktopModule<DesktopFs>("node:fs/promises", "Local filesystem access");
  },

  async path() {
    return loadDesktopModule<DesktopPath>("node:path", "Local filesystem paths");
  },

  async os() {
    return loadDesktopModule<DesktopOs>("node:os", "Temporary local storage");
  },

  async childProcess() {
    return loadDesktopModule<DesktopChildProcess>("node:child_process", "CLI execution");
  },

  environment(): Record<string, string | undefined> {
    const runtimeProcess = getDesktopProcess();
    if (!hasNodeRuntime() || !runtimeProcess?.env) {
      throw new DesktopHostUnavailableError("CLI environment access");
    }
    return runtimeProcess.env;
  },
} as const;
