import { Platform } from "obsidian";
import { hasNodeRuntime } from "./desktopOnly";

export type HostCapability =
  | "node-runtime"
  | "local-filesystem"
  | "absolute-paths"
  | "native-file-picker"
  | "file-manager-reveal"
  | "local-cli"
  | "status-bar";

export type HostCapabilityOwner = Window | Node | null | undefined;

export type HostDeviceType = "Desktop" | "Mobile" | "Unknown";
export type HostOperatingSystem = "Windows" | "macOS" | "Linux" | "iOS" | "Android" | "Unknown";

type HostPlatform = typeof Platform & {
  isDesktopApp?: boolean;
  isAndroidApp?: boolean;
  isIosApp?: boolean;
  isLinux?: boolean;
  isMacOS?: boolean;
  isMobile?: boolean;
  isMobileApp?: boolean;
  isWin?: boolean;
};

type ElectronCapabilityModule = {
  dialog?: {
    showOpenDialog?: (...args: unknown[]) => unknown;
    showOpenDialogSync?: (...args: unknown[]) => unknown;
  };
  remote?: {
    dialog?: {
      showOpenDialog?: (...args: unknown[]) => unknown;
      showOpenDialogSync?: (...args: unknown[]) => unknown;
    };
  };
  shell?: {
    showItemInFolder?: (path: string) => unknown;
    openPath?: (path: string) => unknown;
    openExternal?: (url: string) => unknown;
  };
};

const CAPABILITIES: readonly HostCapability[] = [
  "node-runtime",
  "local-filesystem",
  "absolute-paths",
  "native-file-picker",
  "file-manager-reveal",
  "local-cli",
  "status-bar",
];

function isWindow(value: unknown): value is Window {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Window).window === value &&
    (value as Window).document,
  );
}

function resolveOwnerWindow(owner?: HostCapabilityOwner): Window | undefined {
  if (isWindow(owner)) {
    return owner;
  }
  const ownerWindow = owner?.ownerDocument?.defaultView;
  if (ownerWindow) {
    return ownerWindow;
  }
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.activeWindow ?? window;
}

function isMobileAppHost(): boolean {
  const platform = Platform as HostPlatform;
  return platform.isMobile === true ||
    platform.isMobileApp === true ||
    platform.isDesktopApp === false;
}

function isDesktopAppHost(): boolean {
  const platform = Platform as HostPlatform;
  return platform.isDesktopApp === true && !isMobileAppHost();
}

/**
 * Resolve Electron only through the initiating Obsidian window. Mobile and
 * browser-only hosts return null without evaluating a runtime loader.
 */
export function resolveElectronModule<T = unknown>(owner?: HostCapabilityOwner): T | null {
  if (!isDesktopAppHost()) {
    return null;
  }

  const ownerWindow = resolveOwnerWindow(owner);
  const candidates = [
    (ownerWindow as unknown as { require?: unknown } | undefined)?.require,
    (ownerWindow as unknown as { window?: { require?: unknown } } | undefined)?.window?.require,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "function") {
      continue;
    }
    try {
      const module = candidate("electron") as T | null | undefined;
      if (module != null) {
        return module;
      }
    } catch {
      // Try the next runtime loader, if present.
    }
  }
  return null;
}

export function hasHostCapability(
  capability: HostCapability,
  owner?: HostCapabilityOwner,
): boolean {
  switch (capability) {
    case "node-runtime":
    case "local-filesystem":
      return hasNodeRuntime();
    case "absolute-paths":
    case "status-bar":
      return isDesktopAppHost();
    case "local-cli":
      return isDesktopAppHost() && hasNodeRuntime();
    case "native-file-picker": {
      const electron = resolveElectronModule<ElectronCapabilityModule>(owner);
      const dialog = electron?.dialog ?? electron?.remote?.dialog;
      return typeof dialog?.showOpenDialog === "function" ||
        typeof dialog?.showOpenDialogSync === "function";
    }
    case "file-manager-reveal": {
      const shell = resolveElectronModule<ElectronCapabilityModule>(owner)?.shell;
      return typeof shell?.showItemInFolder === "function" ||
        typeof shell?.openPath === "function" ||
        typeof shell?.openExternal === "function";
    }
  }
}

export function getHostCapabilities(owner?: HostCapabilityOwner): ReadonlySet<HostCapability> {
  return new Set(CAPABILITIES.filter((capability) => hasHostCapability(capability, owner)));
}

export function getHostDeviceType(): HostDeviceType {
  if (isMobileAppHost()) {
    return "Mobile";
  }
  if (isDesktopAppHost()) {
    return "Desktop";
  }
  return "Unknown";
}

export function getHostOperatingSystem(): HostOperatingSystem {
  const platform = Platform as HostPlatform;
  if (platform.isIosApp === true) {
    return "iOS";
  }
  if (platform.isAndroidApp === true) {
    return "Android";
  }
  if (platform.isWin === true) {
    return "Windows";
  }
  if (platform.isMacOS === true) {
    return "macOS";
  }
  if (platform.isLinux === true) {
    return "Linux";
  }
  return "Unknown";
}
