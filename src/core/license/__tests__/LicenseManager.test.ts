/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";
import { LicenseManager } from "../LicenseManager";

describe("LicenseManager", () => {
  let manager: LicenseManager;
  let mockPlugin: any;
  let mockApp: App;
  let mockSettingsManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockSettingsManager = {
      updateSettings: jest.fn().mockResolvedValue(undefined),
    };

    mockPlugin = {
      settings: {
        licenseKey: "test-key-123",
        licenseValid: false,
        lastValidated: 0,
      },
      aiService: {
        validateLicense: jest.fn().mockResolvedValue(true),
      },
      getSettingsManager: jest.fn(() => mockSettingsManager),
    };

    mockApp = new App();

    manager = new LicenseManager(mockPlugin, mockApp);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("initializeLicense", () => {
    it("sets licenseValid to false when no license key", async () => {
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = true;

      await manager.initializeLicense();

      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });

    it("sets licenseValid to false when license key is only whitespace", async () => {
      mockPlugin.settings.licenseKey = "   ";
      mockPlugin.settings.licenseValid = true;

      await manager.initializeLicense();

      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });

    it("skips validation when license was recently validated", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = Date.now() - 1000; // 1 second ago

      await manager.initializeLicense();

      expect(mockPlugin.aiService.validateLicense).not.toHaveBeenCalled();
    });

    it("schedules validation when license was not validated recently", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      await manager.initializeLicense();

      // Fast-forward to allow deferred validation
      jest.runAllTimers();
      await Promise.resolve();

      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalled();
    });

    it("schedules validation when license is not valid", async () => {
      mockPlugin.settings.licenseValid = false;
      mockPlugin.settings.lastValidated = Date.now() - 1000;

      await manager.initializeLicense();

      jest.runAllTimers();
      await Promise.resolve();

      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalled();
    });

    it("handles undefined licenseValid state", async () => {
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = undefined;

      await manager.initializeLicense();

      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });

    it("does not update settings when already invalid and no key", async () => {
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = false;

      await manager.initializeLicense();

      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("validateLicenseKey", () => {
    it("returns true and updates settings when license is valid", async () => {
      mockPlugin.aiService.validateLicense.mockResolvedValue(true);

      const result = await manager.validateLicenseKey();

      expect(result).toBe(true);
      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: true,
      });
    });

    it("returns false and updates settings when license is invalid", async () => {
      mockPlugin.aiService.validateLicense.mockResolvedValue(false);

      const result = await manager.validateLicenseKey();

      expect(result).toBe(false);
      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });

    it("returns false when no license key exists", async () => {
      mockPlugin.settings.licenseKey = "";

      const result = await manager.validateLicenseKey();

      expect(result).toBe(false);
      expect(mockPlugin.aiService.validateLicense).not.toHaveBeenCalled();
    });

    it("returns false and updates settings on validation error", async () => {
      mockPlugin.aiService.validateLicense.mockRejectedValue(
        new Error("Network error")
      );

      const result = await manager.validateLicenseKey();

      expect(result).toBe(false);
      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });

    it("passes force parameter to aiService", async () => {
      await manager.validateLicenseKey(true);

      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalledWith(true);
    });

    it("passes default force=false to aiService", async () => {
      await manager.validateLicenseKey();

      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalledWith(false);
    });
  });

  describe("scheduleDeferredValidation", () => {
    it("does not schedule multiple validations simultaneously", async () => {
      mockPlugin.settings.licenseValid = false;
      mockPlugin.settings.lastValidated = 0;

      // Call initializeLicense multiple times
      await manager.initializeLicense();
      await manager.initializeLicense();
      await manager.initializeLicense();

      jest.runAllTimers();
      await Promise.resolve();

      // Should only validate once
      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalledTimes(1);
    });

    it("runs validation when license becomes invalid", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = 0;
      mockPlugin.aiService.validateLicense.mockResolvedValue(false);

      await manager.initializeLicense();

      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve(); // Allow promise chain to complete

      // Verify validation was called and license updated to invalid
      expect(mockPlugin.aiService.validateLicense).toHaveBeenCalled();
      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
    });
  });
});
