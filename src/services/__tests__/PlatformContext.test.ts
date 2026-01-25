/**
 * @jest-environment node
 */

// Mock MobileDetection
const mockMobileDetection = {
  isMobileDevice: jest.fn().mockReturnValue(false),
  getDeviceInfo: jest.fn().mockReturnValue({ platform: "desktop" }),
};

jest.mock("../../utils/MobileDetection", () => ({
  MobileDetection: {
    getInstance: jest.fn().mockReturnValue(mockMobileDetection),
  },
}));

import { PlatformContext } from "../PlatformContext";

describe("PlatformContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMobileDetection.isMobileDevice.mockReturnValue(false);

    // Clear and reset fetch avoid suffixes
    PlatformContext.clearFetchAvoidSuffixes();
  });

  describe("singleton", () => {
    it("initialize returns instance", () => {
      const instance = PlatformContext.initialize();

      expect(instance).toBeDefined();
      expect(instance).toBeInstanceOf(PlatformContext);
    });

    it("get returns same instance", () => {
      const instance1 = PlatformContext.get();
      const instance2 = PlatformContext.get();

      expect(instance1).toBe(instance2);
    });

    it("initialize returns same instance on multiple calls", () => {
      const instance1 = PlatformContext.initialize();
      const instance2 = PlatformContext.initialize();

      expect(instance1).toBe(instance2);
    });
  });

  describe("isMobile", () => {
    it("returns false on desktop", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.isMobile()).toBe(false);
    });

    it("returns true on mobile", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(true);
      const context = PlatformContext.get();

      expect(context.isMobile()).toBe(true);
    });
  });

  describe("uiVariant", () => {
    it('returns "desktop" on desktop', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.uiVariant()).toBe("desktop");
    });

    it('returns "mobile" on mobile', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(true);
      const context = PlatformContext.get();

      expect(context.uiVariant()).toBe("mobile");
    });
  });

  describe("preferredTransport", () => {
    it('returns "fetch" on desktop by default', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.preferredTransport()).toBe("fetch");
    });

    it('returns "requestUrl" on mobile', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(true);
      const context = PlatformContext.get();

      expect(context.preferredTransport()).toBe("requestUrl");
    });

    it('returns "requestUrl" for openrouter.ai', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "https://openrouter.ai/v1" })).toBe("requestUrl");
    });

    it('returns "fetch" for non-blocked endpoints on desktop', () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "https://api.openai.com/v1" })).toBe("fetch");
    });

    it("handles empty endpoint", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "" })).toBe("fetch");
    });
  });

  describe("supportsStreaming", () => {
    it("returns true on desktop for allowed endpoints", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.supportsStreaming({ endpoint: "https://api.openai.com/v1" })).toBe(true);
    });

    it("returns false on mobile", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(true);
      const context = PlatformContext.get();

      expect(context.supportsStreaming()).toBe(false);
    });

    it("returns false for openrouter.ai", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.supportsStreaming({ endpoint: "https://openrouter.ai/v1" })).toBe(false);
    });

    it("returns true when no endpoint specified on desktop", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.supportsStreaming()).toBe(true);
    });
  });

  describe("registerFetchAvoidSuffix", () => {
    it("adds new suffix", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      PlatformContext.registerFetchAvoidSuffix("custom-api.example.com");
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "https://custom-api.example.com/v1" })).toBe("requestUrl");
    });

    it("ignores empty suffix", () => {
      PlatformContext.registerFetchAvoidSuffix("");
      // No error should be thrown
    });

    it("handles case insensitively", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      PlatformContext.registerFetchAvoidSuffix("EXAMPLE.COM");
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "https://test.example.com/api" })).toBe("requestUrl");
    });
  });

  describe("clearFetchAvoidSuffixes", () => {
    it("restores default suffixes", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      PlatformContext.registerFetchAvoidSuffix("custom.com");
      PlatformContext.clearFetchAvoidSuffixes();
      const context = PlatformContext.get();

      // Custom suffix should be removed
      expect(context.preferredTransport({ endpoint: "https://custom.com/api" })).toBe("fetch");
      // Default suffix should remain
      expect(context.preferredTransport({ endpoint: "https://openrouter.ai/v1" })).toBe("requestUrl");
    });
  });

  describe("getDeviceInfo", () => {
    it("returns device info from detection", () => {
      mockMobileDetection.getDeviceInfo.mockReturnValue({ platform: "iOS", browser: "Safari" });
      const context = PlatformContext.get();

      const info = context.getDeviceInfo();

      expect(info).toEqual({ platform: "iOS", browser: "Safari" });
    });
  });

  describe("getDetection", () => {
    it("returns MobileDetection instance", () => {
      const context = PlatformContext.get();

      expect(context.getDetection()).toBe(mockMobileDetection);
    });
  });

  describe("shouldAvoidDirectFetch (via preferredTransport)", () => {
    it("handles invalid URL gracefully", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      // Invalid URL should not cause error, should return default
      expect(context.preferredTransport({ endpoint: "not-a-valid-url" })).toBe("fetch");
    });

    it("handles subdomains of blocked suffixes", () => {
      mockMobileDetection.isMobileDevice.mockReturnValue(false);
      const context = PlatformContext.get();

      expect(context.preferredTransport({ endpoint: "https://api.openrouter.ai/v1" })).toBe("requestUrl");
    });
  });
});
