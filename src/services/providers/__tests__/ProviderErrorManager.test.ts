/**
 * @jest-environment node
 */
import { App } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
}));

// Mock notifications
jest.mock("../../../core/ui/notifications", () => ({
  showNoticeWhenReady: jest.fn(),
}));

// Mock main plugin
jest.mock("../../../main", () => {
  return jest.fn().mockImplementation(() => ({
    emitter: {
      emitWithProvider: jest.fn(),
    },
  }));
});

import { ProviderErrorManager } from "../ProviderErrorManager";
import type SystemSculptPlugin from "../../../main";

describe("ProviderErrorManager", () => {
  let manager: ProviderErrorManager;
  let mockPlugin: SystemSculptPlugin;
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      emitter: {
        emitWithProvider: jest.fn(),
      },
    } as unknown as SystemSculptPlugin;

    mockApp = {} as App;

    manager = new ProviderErrorManager(mockPlugin, mockApp);
  });

  describe("reportSystemSculptError", () => {
    it("reports error with timestamp and provider type", () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      manager.reportSystemSculptError({
        providerId: "test-provider",
        errorCode: "AUTH_ERROR",
        message: "Authentication failed",
      });

      const errors = manager.getSystemSculptErrors("test-provider");
      expect(errors).toHaveLength(1);
      expect(errors[0].providerId).toBe("test-provider");
      expect(errors[0].providerType).toBe("systemsculpt");
      expect(errors[0].timestamp).toBe(now);
      expect(errors[0].errorCode).toBe("AUTH_ERROR");
      expect(errors[0].message).toBe("Authentication failed");

      jest.spyOn(Date, "now").mockRestore();
    });

    it("emits error event with provider namespace", () => {
      manager.reportSystemSculptError({
        providerId: "test-provider",
        errorCode: "TEST",
        message: "Test error",
      });

      expect(mockPlugin.emitter.emitWithProvider).toHaveBeenCalledWith(
        "providerError",
        "systemsculpt",
        expect.objectContaining({
          providerId: "test-provider",
          providerType: "systemsculpt",
        })
      );
    });

    it("maintains error history limit", () => {
      for (let i = 0; i < 15; i++) {
        manager.reportSystemSculptError({
          providerId: "test-provider",
          errorCode: `ERROR_${i}`,
          message: `Error ${i}`,
        });
      }

      const errors = manager.getSystemSculptErrors("test-provider");
      expect(errors.length).toBeLessThanOrEqual(10);
      // Oldest errors should be removed
      expect(errors[0].errorCode).toBe("ERROR_5");
    });

    it("stores errors per provider", () => {
      manager.reportSystemSculptError({
        providerId: "provider-1",
        errorCode: "E1",
        message: "Error 1",
      });

      manager.reportSystemSculptError({
        providerId: "provider-2",
        errorCode: "E2",
        message: "Error 2",
      });

      expect(manager.getSystemSculptErrors("provider-1")).toHaveLength(1);
      expect(manager.getSystemSculptErrors("provider-2")).toHaveLength(1);
    });

    it("includes license-related flag", () => {
      manager.reportSystemSculptError({
        providerId: "test-provider",
        errorCode: "LICENSE",
        message: "License expired",
        licenseRelated: true,
      });

      const errors = manager.getSystemSculptErrors("test-provider");
      expect(errors[0].licenseRelated).toBe(true);
    });

    it("includes API endpoint in error", () => {
      manager.reportSystemSculptError({
        providerId: "test-provider",
        errorCode: "API_ERROR",
        message: "API failed",
        apiEndpoint: "/v1/chat",
      });

      const errors = manager.getSystemSculptErrors("test-provider");
      expect(errors[0].apiEndpoint).toBe("/v1/chat");
    });
  });

  describe("reportCustomProviderError", () => {
    it("reports error with timestamp and provider type", () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      manager.reportCustomProviderError({
        providerId: "custom-1",
        providerName: "My OpenAI",
        errorCode: "RATE_LIMIT",
        message: "Rate limited",
      });

      const errors = manager.getCustomProviderErrors("custom-1");
      expect(errors).toHaveLength(1);
      expect(errors[0].providerType).toBe("custom");
      expect(errors[0].providerName).toBe("My OpenAI");
      expect(errors[0].timestamp).toBe(now);

      jest.spyOn(Date, "now").mockRestore();
    });

    it("emits error event with custom namespace", () => {
      manager.reportCustomProviderError({
        providerId: "custom-1",
        providerName: "Test Provider",
        errorCode: "TEST",
        message: "Test error",
      });

      expect(mockPlugin.emitter.emitWithProvider).toHaveBeenCalledWith(
        "providerError",
        "custom",
        expect.objectContaining({
          providerId: "custom-1",
          providerType: "custom",
        })
      );
    });

    it("maintains error history limit", () => {
      for (let i = 0; i < 15; i++) {
        manager.reportCustomProviderError({
          providerId: "custom-1",
          providerName: "Test",
          errorCode: `ERROR_${i}`,
          message: `Error ${i}`,
        });
      }

      const errors = manager.getCustomProviderErrors("custom-1");
      expect(errors.length).toBeLessThanOrEqual(10);
    });

    it("includes auth-related flag", () => {
      manager.reportCustomProviderError({
        providerId: "custom-1",
        providerName: "Test",
        errorCode: "AUTH",
        message: "Invalid API key",
        authRelated: true,
      });

      const errors = manager.getCustomProviderErrors("custom-1");
      expect(errors[0].authRelated).toBe(true);
    });

    it("includes endpoint in error", () => {
      manager.reportCustomProviderError({
        providerId: "custom-1",
        providerName: "Test",
        errorCode: "ERROR",
        message: "Failed",
        endpoint: "https://api.example.com/v1",
      });

      const errors = manager.getCustomProviderErrors("custom-1");
      expect(errors[0].endpoint).toBe("https://api.example.com/v1");
    });
  });

  describe("getErrorSummary", () => {
    it("returns empty summary when no errors", () => {
      const summary = manager.getErrorSummary();
      expect(summary.systemsculpt).toEqual([]);
      expect(summary.custom).toEqual([]);
    });

    it("summarizes systemsculpt errors", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error 1",
      });
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E2",
        message: "Error 2",
      });

      const summary = manager.getErrorSummary();
      expect(summary.systemsculpt).toHaveLength(1);
      expect(summary.systemsculpt[0].providerId).toBe("ss-1");
      expect(summary.systemsculpt[0].errorCount).toBe(2);
      expect(summary.systemsculpt[0].lastError?.errorCode).toBe("E2");
    });

    it("summarizes custom provider errors", () => {
      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom 1",
        errorCode: "E1",
        message: "Error 1",
      });

      const summary = manager.getErrorSummary();
      expect(summary.custom).toHaveLength(1);
      expect(summary.custom[0].providerId).toBe("c-1");
      expect(summary.custom[0].errorCount).toBe(1);
    });

    it("summarizes multiple providers", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error",
      });
      manager.reportSystemSculptError({
        providerId: "ss-2",
        errorCode: "E2",
        message: "Error",
      });

      const summary = manager.getErrorSummary();
      expect(summary.systemsculpt).toHaveLength(2);
    });
  });

  describe("clearProviderErrors", () => {
    it("clears systemsculpt provider errors", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error",
      });

      manager.clearProviderErrors("ss-1", "systemsculpt");

      expect(manager.getSystemSculptErrors("ss-1")).toEqual([]);
    });

    it("clears custom provider errors", () => {
      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom",
        errorCode: "E1",
        message: "Error",
      });

      manager.clearProviderErrors("c-1", "custom");

      expect(manager.getCustomProviderErrors("c-1")).toEqual([]);
    });

    it("only clears specified provider", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error",
      });
      manager.reportSystemSculptError({
        providerId: "ss-2",
        errorCode: "E2",
        message: "Error",
      });

      manager.clearProviderErrors("ss-1", "systemsculpt");

      expect(manager.getSystemSculptErrors("ss-1")).toEqual([]);
      expect(manager.getSystemSculptErrors("ss-2")).toHaveLength(1);
    });
  });

  describe("cleanupOldErrors", () => {
    it("removes errors older than cleanup interval", () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      jest.spyOn(Date, "now").mockReturnValue(oldTime);

      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "OLD",
        message: "Old error",
      });

      jest.spyOn(Date, "now").mockRestore();

      manager.cleanupOldErrors();

      expect(manager.getSystemSculptErrors("ss-1")).toEqual([]);
    });

    it("keeps recent errors", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "RECENT",
        message: "Recent error",
      });

      manager.cleanupOldErrors();

      expect(manager.getSystemSculptErrors("ss-1")).toHaveLength(1);
    });

    it("cleans up custom provider errors too", () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000;
      jest.spyOn(Date, "now").mockReturnValue(oldTime);

      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom",
        errorCode: "OLD",
        message: "Old error",
      });

      jest.spyOn(Date, "now").mockRestore();

      manager.cleanupOldErrors();

      expect(manager.getCustomProviderErrors("c-1")).toEqual([]);
    });
  });

  describe("getProviderHealth", () => {
    it("returns healthy status with no errors", () => {
      const health = manager.getProviderHealth("ss-1", "systemsculpt");

      expect(health.status).toBe("healthy");
      expect(health.recentErrorCount).toBe(0);
      expect(health.lastErrorTime).toBeUndefined();
    });

    it("returns warning status with 1-2 recent errors", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error",
      });

      const health = manager.getProviderHealth("ss-1", "systemsculpt");

      expect(health.status).toBe("warning");
      expect(health.recentErrorCount).toBe(1);
      expect(health.lastErrorTime).toBeDefined();
    });

    it("returns error status with 3+ recent errors", () => {
      for (let i = 0; i < 3; i++) {
        manager.reportSystemSculptError({
          providerId: "ss-1",
          errorCode: `E${i}`,
          message: `Error ${i}`,
        });
      }

      const health = manager.getProviderHealth("ss-1", "systemsculpt");

      expect(health.status).toBe("error");
      expect(health.recentErrorCount).toBe(3);
    });

    it("only counts errors within 15 minute window", () => {
      const oldTime = Date.now() - 20 * 60 * 1000; // 20 minutes ago
      jest.spyOn(Date, "now").mockReturnValue(oldTime);

      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "OLD",
        message: "Old error",
      });

      jest.spyOn(Date, "now").mockRestore();

      // Add a recent error
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "RECENT",
        message: "Recent error",
      });

      const health = manager.getProviderHealth("ss-1", "systemsculpt");

      expect(health.recentErrorCount).toBe(1);
      expect(health.status).toBe("warning");
    });

    it("checks custom provider health", () => {
      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom",
        errorCode: "E1",
        message: "Error",
      });

      const health = manager.getProviderHealth("c-1", "custom");

      expect(health.status).toBe("warning");
      expect(health.recentErrorCount).toBe(1);
    });

    it("returns last error time", () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom",
        errorCode: "E1",
        message: "Error",
      });

      jest.spyOn(Date, "now").mockRestore();

      const health = manager.getProviderHealth("c-1", "custom");
      expect(health.lastErrorTime).toBe(now);
    });
  });

  describe("clearAllErrors", () => {
    it("clears all systemsculpt and custom errors", () => {
      manager.reportSystemSculptError({
        providerId: "ss-1",
        errorCode: "E1",
        message: "Error",
      });
      manager.reportCustomProviderError({
        providerId: "c-1",
        providerName: "Custom",
        errorCode: "E1",
        message: "Error",
      });

      manager.clearAllErrors();

      expect(manager.getSystemSculptErrors("ss-1")).toEqual([]);
      expect(manager.getCustomProviderErrors("c-1")).toEqual([]);
      expect(manager.getErrorSummary()).toEqual({
        systemsculpt: [],
        custom: [],
      });
    });
  });

  describe("getSystemSculptErrors", () => {
    it("returns empty array for unknown provider", () => {
      expect(manager.getSystemSculptErrors("unknown")).toEqual([]);
    });
  });

  describe("getCustomProviderErrors", () => {
    it("returns empty array for unknown provider", () => {
      expect(manager.getCustomProviderErrors("unknown")).toEqual([]);
    });
  });
});
