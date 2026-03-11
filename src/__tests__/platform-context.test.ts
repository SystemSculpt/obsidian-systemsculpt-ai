import { PlatformTransportOptions } from "../services/PlatformContext";
import type { PlatformEnvironment } from "../utils/PlatformEnvironment";

const mobileDetectionMock = {
  isMobileDevice: jest.fn(),
  getDeviceInfo: jest.fn(() => ({
    isMobile: mobileDetectionMock.isMobileDevice(),
    platform: { os: "macOS", name: "macOS", version: "14" },
  })),
};

let mockEnvironment: PlatformEnvironment = {
  runtime: "desktop",
  surface: "desktop",
  isMobileEmulation: false,
};

jest.mock("../utils/MobileDetection", () => ({
  MobileDetection: {
    getInstance: jest.fn(() => mobileDetectionMock),
  },
}));

jest.mock("../utils/PlatformEnvironment", () => ({
  detectPlatformEnvironment: jest.fn(() => mockEnvironment),
}));

const { PlatformContext } = require("../services/PlatformContext");

describe("PlatformContext", () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    (global as any).fetch = jest.fn();
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  beforeEach(() => {
    mobileDetectionMock.isMobileDevice.mockReturnValue(false);
    mockEnvironment = {
      runtime: "desktop",
      surface: "desktop",
      isMobileEmulation: false,
    };
  });

  it("reports desktop capabilities when not mobile", () => {
    const platform = PlatformContext.get();
    expect(platform.isMobile()).toBe(false);
    expect(platform.isDesktopRuntime()).toBe(true);
    expect(platform.supportsDesktopOnlyFeatures()).toBe(true);
    expect(platform.uiVariant()).toBe("desktop");
    expect(platform.preferredTransport()).toBe("fetch");
    expect(platform.supportsStreaming()).toBe(true);
    expect(platform.getDeviceInfo()).toEqual(
      expect.objectContaining({ isMobile: false })
    );
  });

  it("forces requestUrl transport and disables streaming on mobile", () => {
    mobileDetectionMock.isMobileDevice.mockReturnValue(true);
    mockEnvironment = {
      runtime: "mobile",
      surface: "mobile",
      isMobileEmulation: false,
    };
    const platform = PlatformContext.get();
    expect(platform.isMobile()).toBe(true);
    expect(platform.isDesktopRuntime()).toBe(false);
    expect(platform.supportsDesktopOnlyFeatures()).toBe(false);
    expect(platform.uiVariant()).toBe("mobile");
    expect(platform.preferredTransport()).toBe("requestUrl");
    expect(platform.supportsStreaming()).toBe(false);
  });

  it("keeps desktop-only capabilities during desktop mobile emulation", () => {
    mobileDetectionMock.isMobileDevice.mockReturnValue(true);
    mockEnvironment = {
      runtime: "desktop",
      surface: "mobile",
      isMobileEmulation: true,
    };
    const platform = PlatformContext.get();
    expect(platform.isMobile()).toBe(true);
    expect(platform.isDesktopRuntime()).toBe(true);
    expect(platform.supportsDesktopOnlyFeatures()).toBe(true);
    expect(platform.preferredTransport()).toBe("requestUrl");
    expect(platform.supportsStreaming()).toBe(false);
  });

  it("allows direct fetch for OpenRouter on desktop", () => {
    const platform = PlatformContext.get();
    const options: PlatformTransportOptions = {
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    };
    expect(platform.preferredTransport(options)).toBe("fetch");
    expect(platform.supportsStreaming(options)).toBe(true);
  });
});
