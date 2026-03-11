/**
 * @jest-environment jsdom
 */

var mockPlatform: {
  isDesktopApp: boolean;
  isDesktop: boolean;
  isMobileApp: boolean;
  isAndroidApp: boolean;
  isIosApp: boolean;
  isMobile: boolean;
};

jest.mock("obsidian", () => {
  mockPlatform = {
    isDesktopApp: false,
    isDesktop: false,
    isMobileApp: false,
    isAndroidApp: false,
    isIosApp: false,
    isMobile: false,
  };

  return {
    Platform: mockPlatform,
  };
});

import { detectPlatformEnvironment } from "../PlatformEnvironment";

function resetPlatformFlags(): void {
  mockPlatform.isDesktopApp = false;
  mockPlatform.isDesktop = false;
  mockPlatform.isMobileApp = false;
  mockPlatform.isAndroidApp = false;
  mockPlatform.isIosApp = false;
  mockPlatform.isMobile = false;
}

describe("detectPlatformEnvironment", () => {
  const originalApp = (window as any).app;
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    resetPlatformFlags();
    (window as any).app = undefined;
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      configurable: true,
    });
  });

  afterAll(() => {
    (window as any).app = originalApp;
    Object.defineProperty(navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it("treats native iPad runtime as mobile even if app.emulateMobile exists", () => {
    mockPlatform.isMobileApp = true;
    mockPlatform.isIosApp = true;
    mockPlatform.isMobile = true;
    (window as any).app = {
      isMobile: true,
      emulateMobile: () => {},
    };
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });

    expect(detectPlatformEnvironment()).toEqual({
      runtime: "mobile",
      surface: "mobile",
      isMobileEmulation: false,
    });
  });

  it("keeps desktop runtime during desktop mobile emulation", () => {
    mockPlatform.isDesktopApp = true;
    mockPlatform.isDesktop = true;
    mockPlatform.isMobile = true;
    (window as any).app = {
      isMobile: true,
      emulateMobile: () => {},
    };

    expect(detectPlatformEnvironment()).toEqual({
      runtime: "desktop",
      surface: "mobile",
      isMobileEmulation: true,
    });
  });
});
