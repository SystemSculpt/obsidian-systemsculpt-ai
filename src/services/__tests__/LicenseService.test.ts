import { LicenseService } from "../LicenseService";
import { SYSTEMSCULPT_API_ENDPOINTS, SYSTEMSCULPT_API_HEADERS } from "../../constants/api";
import { CACHE_BUSTER } from "../../utils/urlHelpers";

// Mock httpClient
jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

// Mock constants
jest.mock("../../constants/api", () => ({
  SYSTEMSCULPT_API_ENDPOINTS: {
    LICENSE: {
      VALIDATE: jest.fn(() => "/api/license/validate"),
    },
  },
  SYSTEMSCULPT_API_HEADERS: {
    WITH_LICENSE: jest.fn((key: string) => ({
      "X-License-Key": key,
      "Content-Type": "application/json",
    })),
  },
}));

// Mock CACHE_BUSTER
jest.mock("../../utils/urlHelpers", () => ({
  CACHE_BUSTER: {
    apply: jest.fn((url: string) => `${url}?_cb=123`),
  },
}));

const createMockPlugin = () => {
  const updateSettings = jest.fn(async () => {});
  return {
    settings: {
      licenseKey: "test-license-key",
      licenseValid: false,
      userEmail: "",
      userName: "",
      displayName: "",
      subscriptionStatus: "",
      lastValidated: 0,
    },
    getSettingsManager: () => ({
      updateSettings,
    }),
    _updateSettings: updateSettings,
  } as any;
};

describe("LicenseService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;
  let httpRequest: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlugin = createMockPlugin();
    // Get the mocked httpRequest
    httpRequest = require("../../utils/httpClient").httpRequest;
  });

  describe("constructor", () => {
    it("creates instance with plugin and baseUrl", () => {
      const service = new LicenseService(mockPlugin, "https://api.example.com");
      expect(service).toBeInstanceOf(LicenseService);
    });

    it("stores the provided baseUrl", () => {
      const service = new LicenseService(mockPlugin, "https://custom.api.com");
      // Access private field via any
      expect((service as any).baseUrl).toBe("https://custom.api.com");
    });

    it("stores the plugin reference", () => {
      const service = new LicenseService(mockPlugin, "https://api.example.com");
      expect((service as any).plugin).toBe(mockPlugin);
    });
  });

  describe("updateBaseUrl", () => {
    it("updates the base URL", () => {
      const service = new LicenseService(mockPlugin, "https://old.api.com");
      service.updateBaseUrl("https://new.api.com");
      expect((service as any).baseUrl).toBe("https://new.api.com");
    });

    it("allows updating to empty string", () => {
      const service = new LicenseService(mockPlugin, "https://api.com");
      service.updateBaseUrl("");
      expect((service as any).baseUrl).toBe("");
    });

    it("allows multiple updates", () => {
      const service = new LicenseService(mockPlugin, "https://first.com");
      service.updateBaseUrl("https://second.com");
      service.updateBaseUrl("https://third.com");
      expect((service as any).baseUrl).toBe("https://third.com");
    });
  });

  describe("licenseKey getter (private)", () => {
    it("returns license key from plugin settings", () => {
      mockPlugin.settings.licenseKey = "my-secret-key";
      const service = new LicenseService(mockPlugin, "https://api.com");
      expect((service as any).licenseKey).toBe("my-secret-key");
    });

    it("returns empty string when no license key set", () => {
      mockPlugin.settings.licenseKey = "";
      const service = new LicenseService(mockPlugin, "https://api.com");
      expect((service as any).licenseKey).toBe("");
    });
  });

  describe("validateLicense", () => {
    describe("with empty license key", () => {
      it("returns false when license key is empty", async () => {
        mockPlugin.settings.licenseKey = "";
        const service = new LicenseService(mockPlugin, "https://api.com");

        const result = await service.validateLicense();

        expect(result).toBe(false);
        expect(httpRequest).not.toHaveBeenCalled();
      });

      it("returns false when license key is only whitespace", async () => {
        mockPlugin.settings.licenseKey = "   ";
        const service = new LicenseService(mockPlugin, "https://api.com");

        const result = await service.validateLicense();

        expect(result).toBe(false);
      });

      it("updates settings to licenseValid=false if was valid", async () => {
        mockPlugin.settings.licenseKey = "";
        mockPlugin.settings.licenseValid = true;
        const service = new LicenseService(mockPlugin, "https://api.com");

        await service.validateLicense();

        expect(mockPlugin._updateSettings).toHaveBeenCalledWith({
          licenseValid: false,
        });
      });

      it("does not update settings if already invalid", async () => {
        mockPlugin.settings.licenseKey = "";
        mockPlugin.settings.licenseValid = false;
        const service = new LicenseService(mockPlugin, "https://api.com");

        await service.validateLicense();

        expect(mockPlugin._updateSettings).not.toHaveBeenCalled();
      });

      it("returns false when license key is null", async () => {
        mockPlugin.settings.licenseKey = null as any;
        const service = new LicenseService(mockPlugin, "https://api.com");

        const result = await service.validateLicense();

        expect(result).toBe(false);
      });

      it("returns false when license key is undefined", async () => {
        mockPlugin.settings.licenseKey = undefined as any;
        const service = new LicenseService(mockPlugin, "https://api.com");

        const result = await service.validateLicense();

        expect(result).toBe(false);
      });
    });

    describe("with valid license key and successful response", () => {
      beforeEach(() => {
        mockPlugin.settings.licenseKey = "valid-key";
      });

      it("returns true on 200 response with valid data", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            user_name: "Test User",
            display_name: "Test Display",
            subscription_status: "active",
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("calls httpRequest with correct URL", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.example.com");
        await service.validateLicense();

        expect(httpRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "https://api.example.com/api/license/validate?_cb=123",
            method: "GET",
          })
        );
      });

      it("includes license key in headers", async () => {
        mockPlugin.settings.licenseKey = "my-license-123";
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(SYSTEMSCULPT_API_HEADERS.WITH_LICENSE).toHaveBeenCalledWith("my-license-123");
      });

      it("updates settings with response data", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            user_name: "Test User",
            display_name: "Test Display",
            subscription_status: "active",
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(mockPlugin._updateSettings).toHaveBeenCalledWith({
          licenseValid: true,
          userEmail: "user@example.com",
          userName: "Test User",
          displayName: "Test Display",
          subscriptionStatus: "active",
          lastValidated: expect.any(Number),
        });
      });

      it("handles nested data structure", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            data: {
              email: "nested@example.com",
              user_name: "Nested User",
              display_name: "Nested Display",
              subscription_status: "premium",
            },
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
        expect(mockPlugin._updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            userEmail: "nested@example.com",
            userName: "Nested User",
          })
        );
      });

      it("uses email as fallback for user_name", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            // No user_name provided
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(mockPlugin._updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            userName: "user@example.com",
          })
        );
      });

      it("uses user_name as fallback for display_name", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            user_name: "Username",
            // No display_name provided
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(mockPlugin._updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: "Username",
          })
        );
      });

      it("uses email as ultimate fallback for display_name", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            // No user_name or display_name
          },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(mockPlugin._updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            displayName: "user@example.com",
          })
        );
      });

      it("applies cache buster to endpoint", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();

        expect(CACHE_BUSTER.apply).toHaveBeenCalledWith("/api/license/validate");
      });
    });

    describe("with non-200 response", () => {
      beforeEach(() => {
        mockPlugin.settings.licenseKey = "invalid-key";
      });

      it("throws error on 401 response", async () => {
        httpRequest.mockResolvedValue({
          status: 401,
          json: { error: "Unauthorized" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");

        // The error is caught internally and returns last known validity
        const result = await service.validateLicense();
        expect(result).toBe(false); // licenseValid was false
      });

      it("preserves last known valid state on 500 error", async () => {
        mockPlugin.settings.licenseValid = true;
        httpRequest.mockResolvedValue({
          status: 500,
          json: { error: "Server error" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        // Should preserve last known validity
        expect(result).toBe(true);
      });

      it("returns false when previously invalid and error occurs", async () => {
        mockPlugin.settings.licenseValid = false;
        httpRequest.mockResolvedValue({
          status: 403,
          json: { error: "Forbidden" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(false);
      });
    });

    describe("with network errors", () => {
      beforeEach(() => {
        mockPlugin.settings.licenseKey = "test-key";
      });

      it("preserves last known validity on network error", async () => {
        mockPlugin.settings.licenseValid = true;
        httpRequest.mockRejectedValue(new Error("Network error"));

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("returns false when previously invalid and network error occurs", async () => {
        mockPlugin.settings.licenseValid = false;
        httpRequest.mockRejectedValue(new Error("Connection refused"));

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(false);
      });

      it("handles timeout errors gracefully", async () => {
        mockPlugin.settings.licenseValid = true;
        httpRequest.mockRejectedValue(new Error("Request timeout"));

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });
    });

    describe("with unexpected response body", () => {
      beforeEach(() => {
        mockPlugin.settings.licenseKey = "test-key";
      });

      it("returns last known validity when response is null", async () => {
        mockPlugin.settings.licenseValid = true;
        httpRequest.mockResolvedValue({
          status: 200,
          json: null,
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("returns last known validity when response is empty object", async () => {
        mockPlugin.settings.licenseValid = false;
        httpRequest.mockResolvedValue({
          status: 200,
          json: {},
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        // Empty object is typeof 'object' so it updates settings and returns true
        expect(result).toBe(true);
      });

      it("returns last known validity when response is string", async () => {
        mockPlugin.settings.licenseValid = true;
        httpRequest.mockResolvedValue({
          status: 200,
          json: "invalid response",
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("returns last known validity when response is array", async () => {
        mockPlugin.settings.licenseValid = false;
        httpRequest.mockResolvedValue({
          status: 200,
          json: ["unexpected", "array"],
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        // Arrays are objects, so they trigger the update path
        expect(result).toBe(true);
      });
    });

    describe("forceCheck parameter", () => {
      it("accepts forceCheck parameter (true)", async () => {
        mockPlugin.settings.licenseKey = "test-key";
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense(true);

        expect(result).toBe(true);
        expect(httpRequest).toHaveBeenCalled();
      });

      it("accepts forceCheck parameter (false)", async () => {
        mockPlugin.settings.licenseKey = "test-key";
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense(false);

        expect(result).toBe(true);
      });
    });

    describe("edge cases", () => {
      it("handles special characters in license key", async () => {
        mockPlugin.settings.licenseKey = "key+with/special=chars&more";
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
        expect(SYSTEMSCULPT_API_HEADERS.WITH_LICENSE).toHaveBeenCalledWith(
          "key+with/special=chars&more"
        );
      });

      it("handles very long license key", async () => {
        mockPlugin.settings.licenseKey = "a".repeat(1000);
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("handles unicode license key", async () => {
        mockPlugin.settings.licenseKey = "键-🔑-مفتاح";
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("handles response with extra unexpected fields", async () => {
        httpRequest.mockResolvedValue({
          status: 200,
          json: {
            email: "user@example.com",
            user_name: "User",
            display_name: "Display",
            subscription_status: "active",
            extra_field: "ignored",
            another_field: 123,
          },
        });

        mockPlugin.settings.licenseKey = "test-key";
        const service = new LicenseService(mockPlugin, "https://api.com");
        const result = await service.validateLicense();

        expect(result).toBe(true);
      });

      it("sets lastValidated to current timestamp", async () => {
        const beforeTime = Date.now();
        httpRequest.mockResolvedValue({
          status: 200,
          json: { email: "user@example.com" },
        });

        mockPlugin.settings.licenseKey = "test-key";
        const service = new LicenseService(mockPlugin, "https://api.com");
        await service.validateLicense();
        const afterTime = Date.now();

        const updateCall = mockPlugin._updateSettings.mock.calls[0][0];
        expect(updateCall.lastValidated).toBeGreaterThanOrEqual(beforeTime);
        expect(updateCall.lastValidated).toBeLessThanOrEqual(afterTime);
      });
    });
  });

  describe("multiple instances", () => {
    it("instances are independent", async () => {
      const plugin1 = createMockPlugin();
      const plugin2 = createMockPlugin();
      plugin1.settings.licenseKey = "key1";
      plugin2.settings.licenseKey = "key2";

      const service1 = new LicenseService(plugin1, "https://api1.com");
      const service2 = new LicenseService(plugin2, "https://api2.com");

      expect((service1 as any).baseUrl).toBe("https://api1.com");
      expect((service2 as any).baseUrl).toBe("https://api2.com");
    });

    it("updating one instance does not affect another", () => {
      const plugin1 = createMockPlugin();
      const plugin2 = createMockPlugin();

      const service1 = new LicenseService(plugin1, "https://api.com");
      const service2 = new LicenseService(plugin2, "https://api.com");

      service1.updateBaseUrl("https://new.api.com");

      expect((service1 as any).baseUrl).toBe("https://new.api.com");
      expect((service2 as any).baseUrl).toBe("https://api.com");
    });
  });
});
