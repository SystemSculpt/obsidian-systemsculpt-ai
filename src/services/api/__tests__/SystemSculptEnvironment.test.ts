/**
 * @jest-environment node
 */
import { SystemSculptEnvironment, ApiEnvironmentConfig } from "../SystemSculptEnvironment";
import { SystemSculptSettings } from "../../../types";

// Mock the url helpers
jest.mock("../../../utils/urlHelpers", () => ({
  resolveSystemSculptApiBaseUrl: jest.fn((url: string) => {
    // Simulate URL normalization
    if (!url) return "https://api.systemsculpt.com/api/v1";
    // Handle marketing domain
    if (url.includes("systemsculpt.com") && !url.includes("api.")) {
      return url.replace("systemsculpt.com", "api.systemsculpt.com");
    }
    // Add /api/v1 if missing
    if (!url.endsWith("/api/v1")) {
      return url.replace(/\/?$/, "/api/v1");
    }
    return url;
  }),
}));

// Mock the API constants
jest.mock("../../../constants/api", () => ({
  API_BASE_URL: "https://api.systemsculpt.com/api/v1",
  SYSTEMSCULPT_API_HEADERS: {
    DEFAULT: {
      "Content-Type": "application/json",
      "User-Agent": "SystemSculpt-Obsidian",
    },
    WITH_LICENSE: (key: string) => ({
      "Content-Type": "application/json",
      "User-Agent": "SystemSculpt-Obsidian",
      "X-License-Key": key,
    }),
  },
}));

describe("SystemSculptEnvironment", () => {
  describe("resolveBaseUrl", () => {
    it("uses default API_BASE_URL when no settings provided", () => {
      const settings = { serverUrl: "" };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings);

      expect(url).toBe("https://api.systemsculpt.com/api/v1");
    });

    it("uses serverUrl from settings when provided", () => {
      const settings = { serverUrl: "https://custom.example.com/api/v1" };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings);

      expect(url).toBe("https://custom.example.com/api/v1");
    });

    it("uses override when provided", () => {
      const settings = { serverUrl: "https://settings.example.com" };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings, "https://override.example.com");

      expect(url).toBe("https://override.example.com/api/v1");
    });

    it("prefers override over settings", () => {
      const settings = { serverUrl: "https://settings.example.com" };
      const override = "https://override.example.com/api/v1";
      const url = SystemSculptEnvironment.resolveBaseUrl(settings, override);

      expect(url).toBe("https://override.example.com/api/v1");
    });

    it("handles whitespace in serverUrl", () => {
      const settings = { serverUrl: "  https://custom.example.com  " };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings);

      expect(url).toBe("https://custom.example.com/api/v1");
    });

    it("handles empty override", () => {
      const settings = { serverUrl: "https://custom.example.com" };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings, "  ");

      expect(url).toBe("https://custom.example.com/api/v1");
    });

    it("handles undefined serverUrl", () => {
      const settings = { serverUrl: undefined as any };
      const url = SystemSculptEnvironment.resolveBaseUrl(settings);

      expect(url).toBe("https://api.systemsculpt.com/api/v1");
    });
  });

  describe("createConfig", () => {
    it("returns config with baseUrl and undefined licenseKey", () => {
      const settings = { serverUrl: "", licenseKey: "" };
      const config = SystemSculptEnvironment.createConfig(settings);

      expect(config.baseUrl).toBe("https://api.systemsculpt.com/api/v1");
      expect(config.licenseKey).toBeUndefined();
    });

    it("includes licenseKey when provided", () => {
      const settings = { serverUrl: "", licenseKey: "my-license-key" };
      const config = SystemSculptEnvironment.createConfig(settings);

      expect(config.licenseKey).toBe("my-license-key");
    });

    it("trims licenseKey whitespace", () => {
      const settings = { serverUrl: "", licenseKey: "  license-123  " };
      const config = SystemSculptEnvironment.createConfig(settings);

      expect(config.licenseKey).toBe("license-123");
    });

    it("uses override for baseUrl", () => {
      const settings = { serverUrl: "", licenseKey: "key" };
      const config = SystemSculptEnvironment.createConfig(
        settings,
        "https://custom.example.com/api/v1"
      );

      expect(config.baseUrl).toBe("https://custom.example.com/api/v1");
    });

    it("returns undefined licenseKey for whitespace-only key", () => {
      const settings = { serverUrl: "", licenseKey: "   " };
      const config = SystemSculptEnvironment.createConfig(settings);

      expect(config.licenseKey).toBeUndefined();
    });

    it("handles null licenseKey", () => {
      const settings = { serverUrl: "", licenseKey: null as any };
      const config = SystemSculptEnvironment.createConfig(settings);

      expect(config.licenseKey).toBeUndefined();
    });
  });

  describe("buildHeaders", () => {
    it("returns default headers when no license key", () => {
      const headers = SystemSculptEnvironment.buildHeaders();

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["User-Agent"]).toBe("SystemSculpt-Obsidian");
      expect(headers["X-License-Key"]).toBeUndefined();
    });

    it("returns default headers for empty license key", () => {
      const headers = SystemSculptEnvironment.buildHeaders("");

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-License-Key"]).toBeUndefined();
    });

    it("includes license key in headers when provided", () => {
      const headers = SystemSculptEnvironment.buildHeaders("my-license");

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-License-Key"]).toBe("my-license");
    });

    it("returns headers for undefined license key", () => {
      const headers = SystemSculptEnvironment.buildHeaders(undefined);

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-License-Key"]).toBeUndefined();
    });
  });
});
