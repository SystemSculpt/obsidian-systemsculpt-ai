import { PlatformTransportOptions } from "../services/PlatformContext";

const mobileDetectionMock = {
  isMobileDevice: jest.fn(),
  getDeviceInfo: jest.fn(() => ({
    isMobile: mobileDetectionMock.isMobileDevice(),
    platform: { os: "macOS", name: "macOS", version: "14" },
  })),
};

jest.mock("../utils/MobileDetection", () => ({
  MobileDetection: {
    getInstance: jest.fn(() => mobileDetectionMock),
  },
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
  });

  it("reports desktop capabilities when not mobile", () => {
    const platform = PlatformContext.get();
    expect(platform.isMobile()).toBe(false);
    expect(platform.uiVariant()).toBe("desktop");
    expect(platform.preferredTransport()).toBe("fetch");
    expect(platform.supportsStreaming()).toBe(true);
    expect(platform.getDeviceInfo()).toEqual(
      expect.objectContaining({ isMobile: false })
    );
  });

  it("forces requestUrl transport and disables streaming on mobile", () => {
    mobileDetectionMock.isMobileDevice.mockReturnValue(true);
    const platform = PlatformContext.get();
    expect(platform.isMobile()).toBe(true);
    expect(platform.uiVariant()).toBe("mobile");
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
