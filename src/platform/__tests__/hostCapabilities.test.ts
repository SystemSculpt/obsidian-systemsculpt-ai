/** @jest-environment jsdom */

import { Platform } from "obsidian";
import {
  getHostCapabilities,
  getHostDeviceType,
  getHostOperatingSystem,
  hasHostCapability,
  resolveElectronModule,
} from "../hostCapabilities";

describe("host capabilities", () => {
  const platform = Platform as typeof Platform & {
    isDesktopApp?: boolean;
    isAndroidApp?: boolean;
    isIosApp?: boolean;
    isLinux?: boolean;
    isMacOS?: boolean;
    isMobile?: boolean;
    isMobileApp?: boolean;
    isWin?: boolean;
  };
  const originalPlatform = {
    isDesktopApp: platform.isDesktopApp,
    isAndroidApp: platform.isAndroidApp,
    isIosApp: platform.isIosApp,
    isLinux: platform.isLinux,
    isMacOS: platform.isMacOS,
    isMobile: platform.isMobile,
    isMobileApp: platform.isMobileApp,
    isWin: platform.isWin,
  };
  const originalWindowRequire = (window as Window & { require?: unknown }).require;

  beforeEach(() => {
    platform.isDesktopApp = true;
    platform.isAndroidApp = false;
    platform.isIosApp = false;
    platform.isLinux = false;
    platform.isMacOS = false;
    platform.isMobile = false;
    platform.isMobileApp = false;
    platform.isWin = false;
    delete (window as Window & { require?: unknown }).require;
  });

  afterAll(() => {
    platform.isDesktopApp = originalPlatform.isDesktopApp;
    platform.isAndroidApp = originalPlatform.isAndroidApp;
    platform.isIosApp = originalPlatform.isIosApp;
    platform.isLinux = originalPlatform.isLinux;
    platform.isMacOS = originalPlatform.isMacOS;
    platform.isMobile = originalPlatform.isMobile;
    platform.isMobileApp = originalPlatform.isMobileApp;
    platform.isWin = originalPlatform.isWin;
    if (typeof originalWindowRequire === "undefined") {
      delete (window as Window & { require?: unknown }).require;
    } else {
      (window as Window & { require?: unknown }).require = originalWindowRequire;
    }
  });

  it("reports portable and Node-backed desktop capabilities separately", () => {
    expect(hasHostCapability("node-runtime")).toBe(true);
    expect(hasHostCapability("local-filesystem")).toBe(true);
    expect(hasHostCapability("local-cli")).toBe(true);
    expect(hasHostCapability("absolute-paths")).toBe(true);
    expect(hasHostCapability("status-bar")).toBe(true);
    expect(hasHostCapability("native-file-picker")).toBe(false);
    expect(hasHostCapability("file-manager-reveal")).toBe(false);
    expect(getHostDeviceType()).toBe("Desktop");
  });

  it("never evaluates Electron and rejects desktop capabilities on mobile", () => {
    platform.isDesktopApp = false;
    platform.isMobile = true;
    platform.isMobileApp = true;
    const runtimeRequire = jest.fn();
    (window as Window & { require?: unknown }).require = runtimeRequire;

    expect(resolveElectronModule()).toBeNull();
    expect(runtimeRequire).not.toHaveBeenCalled();
    expect(getHostCapabilities()).toEqual(new Set());
    expect(getHostDeviceType()).toBe("Mobile");
  });

  it("owns operating-system labels for feature diagnostics", () => {
    platform.isMacOS = true;
    expect(getHostOperatingSystem()).toBe("macOS");

    platform.isMacOS = false;
    platform.isAndroidApp = true;
    expect(getHostOperatingSystem()).toBe("Android");
  });

  it("resolves Electron from the initiating window and derives native capabilities", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const ownerWindow = iframe.contentWindow!;
    const electron = {
      dialog: { showOpenDialog: jest.fn() },
      shell: { showItemInFolder: jest.fn() },
    };
    const runtimeRequire = jest.fn((specifier: string) => {
      if (specifier !== "electron") throw new Error("Unexpected module");
      return electron;
    });
    (ownerWindow as Window & { require?: unknown }).require = runtimeRequire;

    expect(resolveElectronModule(ownerWindow.document.body)).toBe(electron);
    expect(hasHostCapability("native-file-picker", ownerWindow)).toBe(true);
    expect(hasHostCapability("file-manager-reveal", ownerWindow.document.body)).toBe(true);
    expect(getHostCapabilities(ownerWindow)).toEqual(new Set([
      "node-runtime",
      "local-filesystem",
      "absolute-paths",
      "native-file-picker",
      "file-manager-reveal",
      "local-cli",
      "status-bar",
    ]));
    expect(runtimeRequire).toHaveBeenCalledWith("electron");
    iframe.remove();
  });

  it("treats an unavailable or throwing Electron loader as no native capability", () => {
    (window as Window & { require?: unknown }).require = jest.fn(() => {
      throw new Error("Electron unavailable");
    });

    expect(resolveElectronModule()).toBeNull();
    expect(hasHostCapability("native-file-picker")).toBe(false);
    expect(hasHostCapability("file-manager-reveal")).toBe(false);
  });
});
