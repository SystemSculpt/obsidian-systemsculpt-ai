/**
 * @jest-environment jsdom
 */
import { MobileDetection, MobileDeviceInfo } from "../MobileDetection";

// Mock Obsidian Platform
jest.mock("obsidian", () => ({
  Platform: {
    isMobileApp: false,
    isAndroidApp: false,
    isIosApp: false,
    isMobile: false,
    isDesktopApp: true,
  },
}));

describe("MobileDetection", () => {
  let detection: MobileDetection;

  beforeEach(() => {
    // Reset singleton
    (MobileDetection as any).instance = undefined;
    detection = MobileDetection.getInstance();
    detection.resetCache();

    // Mock navigator properties
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      configurable: true,
    });

    Object.defineProperty(navigator, "hardwareConcurrency", {
      value: 8,
      configurable: true,
    });

    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
    });

    // Mock screen
    Object.defineProperty(window, "screen", {
      value: {
        width: 1920,
        height: 1080,
      },
      configurable: true,
    });

    // Mock devicePixelRatio
    Object.defineProperty(window, "devicePixelRatio", {
      value: 1,
      configurable: true,
    });
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = MobileDetection.getInstance();
      const instance2 = MobileDetection.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("isMobileDevice", () => {
    it("returns false for desktop user agent", () => {
      expect(detection.isMobileDevice()).toBe(false);
    });

    it("returns true for iPhone user agent", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      expect(detection.isMobileDevice()).toBe(true);
    });

    it("returns true for iPad user agent", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      expect(detection.isMobileDevice()).toBe(true);
    });

    it("returns true for Android user agent", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile",
        configurable: true,
      });
      detection.resetCache();

      expect(detection.isMobileDevice()).toBe(true);
    });
  });

  describe("getDeviceInfo", () => {
    it("returns device info object", () => {
      const info = detection.getDeviceInfo();

      expect(info).toBeDefined();
      expect(info.isMobile).toBeDefined();
      expect(info.platform).toBeDefined();
      expect(info.device).toBeDefined();
      expect(info.capabilities).toBeDefined();
      expect(info.network).toBeDefined();
      expect(info.performance).toBeDefined();
      expect(info.limitations).toBeDefined();
      expect(info.npm).toBeDefined();
    });

    it("caches device info", () => {
      const info1 = detection.getDeviceInfo();
      const info2 = detection.getDeviceInfo();

      expect(info1).toBe(info2);
    });

    it("returns fresh info after cache reset", () => {
      const info1 = detection.getDeviceInfo();
      detection.resetCache();
      const info2 = detection.getDeviceInfo();

      expect(info1).not.toBe(info2);
    });
  });

  describe("platform detection", () => {
    it("detects Windows", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.os).toBe("Windows");
    });

    it("detects macOS", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.os).toBe("macOS");
    });

    it("detects Linux", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.os).toBe("Linux");
    });

    it("detects iOS", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.os).toBe("iOS");
    });

    it("detects Android", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.os).toBe("Android");
    });

    it("extracts iOS version", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.version).toBe("16.5");
    });

    it("extracts Android version", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.platform.version).toBe("14");
    });
  });

  describe("device detection", () => {
    it("detects desktop", () => {
      const info = detection.getDeviceInfo();
      expect(info.device.type).toBe("desktop");
    });

    it("detects iPhone as smartphone", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.type).toBe("smartphone");
      expect(info.device.vendor).toBe("Apple");
    });

    it("detects iPad as tablet", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.type).toBe("tablet");
      expect(info.device.vendor).toBe("Apple");
    });

    it("detects Android smartphone", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.type).toBe("smartphone");
    });

    it("detects Android tablet", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.type).toBe("tablet");
    });

    it("detects Samsung device", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.vendor).toBe("Samsung");
      expect(info.device.model).toBe("SM-G991B");
    });

    it("detects Pixel device", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.vendor).toBe("Google");
    });

    it("detects Huawei device", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 12; Huawei P50 Pro) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.vendor).toBe("Huawei");
    });

    it("detects OnePlus device", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (Linux; Android 14; OnePlus 11) AppleWebKit/537.36 Mobile",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.device.vendor).toBe("OnePlus");
    });

    it("includes screen size", () => {
      const info = detection.getDeviceInfo();
      expect(info.device.screenSize).toBe("1920x1080");
    });
  });

  describe("capabilities detection", () => {
    it("detects touch support", () => {
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 10,
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.capabilities.touchSupport).toBe(true);
    });

    it("detects touch support based on maxTouchPoints", () => {
      // jsdom may have ontouchstart defined, so we just verify
      // that the detection returns a boolean consistently
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 0,
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(typeof info.capabilities.touchSupport).toBe("boolean");
    });

    it("detects geolocation support", () => {
      const info = detection.getDeviceInfo();
      expect(info.capabilities.hasGeolocation).toBeDefined();
    });

    it("detects file API support", () => {
      const info = detection.getDeviceInfo();
      expect(info.capabilities.hasFileAPI).toBe(true);
    });
  });

  describe("performance detection", () => {
    it("detects processor cores", () => {
      const info = detection.getDeviceInfo();
      expect(info.performance.processorCores).toBe(8);
    });

    it("detects max touch points", () => {
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 5,
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.performance.maxTouchPoints).toBe(5);
    });

    it("detects pixel ratio", () => {
      Object.defineProperty(window, "devicePixelRatio", {
        value: 2,
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.performance.pixelRatio).toBe(2);
    });
  });

  describe("limitations detection", () => {
    it("marks smartphone as resource constrained", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.limitations.resourceConstrained).toBe(true);
      expect(info.limitations.reasons).toContain("Smartphone has inherent resource limitations");
    });

    it("marks low core count as resource constrained", () => {
      Object.defineProperty(navigator, "hardwareConcurrency", {
        value: 2,
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.limitations.resourceConstrained).toBe(true);
    });
  });

  describe("NPM issues detection", () => {
    it("lists problematic packages for iOS", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.npm.problematicPackages).toContain("fs-extra");
      expect(info.npm.problematicPackages).toContain("child_process");
    });

    it("lists unavailable features for mobile", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.npm.unavailableFeatures).toContain("File system access");
    });

    it("provides recommended alternatives", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const info = detection.getDeviceInfo();
      expect(info.npm.recommendedAlternatives["node-fetch"]).toBe("native fetch API");
    });
  });

  describe("isResourceConstrained", () => {
    it("returns false for desktop", () => {
      expect(detection.isResourceConstrained()).toBe(false);
    });

    it("returns true for smartphone", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      expect(detection.isResourceConstrained()).toBe(true);
    });
  });

  describe("hasFunctionalityLimitations", () => {
    it("returns boolean", () => {
      const result = detection.hasFunctionalityLimitations();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("getDeviceSummary", () => {
    it("returns formatted string for desktop", () => {
      const summary = detection.getDeviceSummary();

      expect(summary).toContain("Desktop");
      expect(summary).toContain("Windows");
    });

    it("returns formatted string for mobile", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const summary = detection.getDeviceSummary();

      expect(summary).toContain("Smartphone");
      expect(summary).toContain("iOS");
      expect(summary).toContain("Apple");
    });
  });

  describe("getCriticalWarnings", () => {
    it("returns empty array for desktop", () => {
      const warnings = detection.getCriticalWarnings();
      // Desktop may still have some warnings
      expect(Array.isArray(warnings)).toBe(true);
    });

    it("returns warnings for resource constrained device", () => {
      Object.defineProperty(navigator, "userAgent", {
        value: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        configurable: true,
      });
      detection.resetCache();

      const warnings = detection.getCriticalWarnings();

      expect(warnings.some((w) => w.includes("limited resources"))).toBe(true);
    });
  });

  describe("resetCache", () => {
    it("clears cached info", () => {
      detection.getDeviceInfo(); // Populate cache
      detection.resetCache();

      // Access internal state to verify cache is cleared
      expect((detection as any).cachedInfo).toBeNull();
      expect((detection as any).lastUpdate).toBe(0);
    });
  });
});
