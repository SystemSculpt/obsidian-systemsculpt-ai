import { Platform } from "obsidian";

export type PlatformRuntime = "desktop" | "mobile";
export type PlatformSurface = "desktop" | "mobile";

export interface PlatformEnvironment {
  runtime: PlatformRuntime;
  surface: PlatformSurface;
  isMobileEmulation: boolean;
}

const MOBILE_USER_AGENT_PATTERN = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

function readPlatformFlag(flag: string): boolean {
  const platformAny = Platform as unknown as Record<string, unknown>;
  return platformAny?.[flag] === true;
}

function readAppShell(): { isMobile?: unknown; emulateMobile?: unknown } | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return (window as unknown as { app?: { isMobile?: unknown; emulateMobile?: unknown } }).app;
}

function readUserAgent(): string {
  if (typeof navigator === "undefined") {
    return "";
  }

  return typeof navigator.userAgent === "string" ? navigator.userAgent : "";
}

export function detectPlatformEnvironment(): PlatformEnvironment {
  const isDesktopRuntime =
    readPlatformFlag("isDesktopApp") ||
    readPlatformFlag("isDesktop");
  const isNativeMobileRuntime =
    readPlatformFlag("isMobileApp") ||
    readPlatformFlag("isAndroidApp") ||
    readPlatformFlag("isIosApp");
  const platformPrefersMobileSurface =
    readPlatformFlag("isMobile") ||
    isNativeMobileRuntime;
  const appShell = readAppShell();
  const appShellIsMobile = appShell?.isMobile === true;
  const hasMobileUserAgent = MOBILE_USER_AGENT_PATTERN.test(readUserAgent());
  const isMobileEmulation =
    isDesktopRuntime && (platformPrefersMobileSurface || appShellIsMobile);

  const runtime: PlatformRuntime =
    isDesktopRuntime
      ? "desktop"
      : isNativeMobileRuntime || hasMobileUserAgent
        ? "mobile"
        : "desktop";

  const surface: PlatformSurface =
    platformPrefersMobileSurface || appShellIsMobile || hasMobileUserAgent
      ? "mobile"
      : "desktop";

  return {
    runtime,
    surface,
    isMobileEmulation,
  };
}
