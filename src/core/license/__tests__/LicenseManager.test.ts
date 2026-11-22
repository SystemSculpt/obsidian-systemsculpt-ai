/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";
import { LicenseManager } from "../LicenseManager";
import { LICENSE_SIGNED_OUT_NOTICE } from "../../../utils/licenseUtils";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

const mockedNotice = Notice as unknown as jest.Mock;

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
        validateLicenseDetailed: jest.fn().mockResolvedValue({ outcome: "valid", isValid: true }),
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
      expect(mockedNotice).toHaveBeenCalledWith("License key is empty. Premium features disabled.", 5000);
    });

    it("sets licenseValid to false when license key is only whitespace", async () => {
      mockPlugin.settings.licenseKey = "   ";
      mockPlugin.settings.licenseValid = true;

      await manager.initializeLicense();

      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({
        licenseValid: false,
      });
      expect(mockedNotice).toHaveBeenCalledWith("License key is empty. Premium features disabled.", 5000);
    });

    it("skips validation when license was recently validated", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = Date.now() - 1000; // 1 second ago

      await manager.initializeLicense();

      expect(mockPlugin.aiService.validateLicenseDetailed).not.toHaveBeenCalled();
    });

    it("schedules validation when license was not validated recently", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      await manager.initializeLicense();

      // Fast-forward to allow deferred validation
      jest.runAllTimers();
      await Promise.resolve();

      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalled();
    });

    it("schedules validation when license is not valid", async () => {
      mockPlugin.settings.licenseValid = false;
      mockPlugin.settings.lastValidated = Date.now() - 1000;

      await manager.initializeLicense();

      jest.runAllTimers();
      await Promise.resolve();

      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalled();
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

  describe("validateLicenseKeyDetailed", () => {
    it("returns the result owned by LicenseService without a redundant settings write", async () => {
      mockPlugin.aiService.validateLicenseDetailed.mockResolvedValue({ outcome: "valid", isValid: true });

      const result = await manager.validateLicenseKeyDetailed();

      expect(result.isValid).toBe(true);
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("returns a LicenseService rejection without a redundant settings write", async () => {
      mockPlugin.aiService.validateLicenseDetailed.mockResolvedValue({ outcome: "rejected", isValid: false, reason: "invalid" });

      const result = await manager.validateLicenseKeyDetailed();

      expect(result.isValid).toBe(false);
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("returns false when no license key exists", async () => {
      mockPlugin.settings.licenseKey = "";

      const result = await manager.validateLicenseKeyDetailed();

      expect(result.isValid).toBe(false);
      expect(mockPlugin.aiService.validateLicenseDetailed).not.toHaveBeenCalled();
    });

    it("preserves last-known-good state on an unexpected validation error", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.aiService.validateLicenseDetailed.mockRejectedValue(
        new Error("Network error")
      );

      const result = await manager.validateLicenseKeyDetailed();

      expect(result.isValid).toBe(true);
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("delegates to the service with no options", async () => {
      await manager.validateLicenseKeyDetailed();

      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledWith({});
    });

    it("passes on a key the user just entered", async () => {
      await manager.validateLicenseKeyDetailed({ enteredKey: true });

      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledWith({ enteredKey: true });
    });
  });

  describe("scheduleDeferredValidation", () => {
    it("uses idle scheduling at the exact validation boundary and can schedule again after settlement", async () => {
      const idle = jest.fn((callback: IdleRequestCallback) => {
        window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 10 }), 0);
        return 1;
      });
      const previous = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
      Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: idle });
      try {
        mockPlugin.settings.licenseValid = true;
        mockPlugin.settings.lastValidated = Date.now() - 24 * 60 * 60 * 1000;
        await manager.initializeLicense();
        expect(idle).toHaveBeenCalledTimes(1);
        await jest.runAllTimersAsync();
        expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);
        expect(mockedNotice).not.toHaveBeenCalled();

        await manager.initializeLicense();
        await jest.runAllTimersAsync();
        expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(2);
      } finally {
        if (previous) Object.defineProperty(window, "requestIdleCallback", previous);
        else Reflect.deleteProperty(window, "requestIdleCallback");
      }
    });

    it("validates an absent timestamp but does not announce lost access during an outage", async () => {
      mockPlugin.settings.licenseValid = true;
      delete mockPlugin.settings.lastValidated;
      mockPlugin.aiService.validateLicenseDetailed.mockRejectedValue(new Error("offline"));
      await manager.initializeLicense();
      await jest.runAllTimersAsync();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
      expect(mockedNotice).not.toHaveBeenCalled();
    });

    it("treats an absent key as signed out without warning a fresh install", async () => {
      delete mockPlugin.settings.licenseKey;
      delete mockPlugin.settings.licenseValid;
      await manager.initializeLicense();
      expect(mockSettingsManager.updateSettings).toHaveBeenCalledWith({ licenseValid: false });
      expect(mockPlugin.aiService.validateLicenseDetailed).not.toHaveBeenCalled();
      expect(mockedNotice).not.toHaveBeenCalled();
    });

    it("does not warn about a license the user removed while validation was pending", async () => {
      mockPlugin.settings.licenseValid = true;
      let finish!: (value: unknown) => void;
      mockPlugin.aiService.validateLicenseDetailed.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      await manager.initializeLicense();
      jest.runOnlyPendingTimers();
      mockPlugin.settings.licenseKey = "";
      mockPlugin.settings.licenseValid = false;
      finish({ outcome: "unavailable", isValid: false });
      await jest.runAllTimersAsync();
      expect(mockedNotice).not.toHaveBeenCalled();
    });

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
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);
    });

    it("runs validation when license becomes invalid", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settings.lastValidated = 0;
      mockPlugin.aiService.validateLicenseDetailed.mockResolvedValue({ outcome: "rejected", isValid: false, reason: "invalid" });

      await manager.initializeLicense();

      jest.runAllTimers();
      await (manager as any).pendingValidation;

      // LicenseService owns the state transition; the manager only schedules it.
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalled();
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
      expect(mockedNotice).toHaveBeenCalledWith(
        "Couldn't validate your license. Check your account.",
        7000,
      );
    });

    it("says why when startup validation signs out a replaced key", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.settingsTab = { containerEl: { isConnected: true }, refreshAccountSection: jest.fn() };
      mockPlugin.aiService.validateLicenseDetailed.mockImplementation(async () => {
        mockPlugin.settings.licenseKey = "";
        mockPlugin.settings.licenseValid = false;
        return { outcome: "rejected", isValid: false, reason: "invalid", signedOut: true };
      });

      await manager.initializeLicense();
      await jest.runAllTimersAsync();

      expect(mockedNotice.mock.calls).toEqual([[LICENSE_SIGNED_OUT_NOTICE, 10_000]]);
      expect(mockPlugin.settingsTab.refreshAccountSection).toHaveBeenCalledTimes(1);
    });
  });

  describe("recheckAfterRejection", () => {
    it("asks the server once per key per minute, however many requests were refused", async () => {
      mockPlugin.settings.licenseValid = true;

      await Promise.all([manager.recheckAfterRejection(), manager.recheckAfterRejection()]);
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);
      // A refusal only ever signs out an unknown key; it changes nothing else.
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledWith({ afterRefusal: true });

      jest.advanceTimersByTime(59_999);
      await manager.recheckAfterRejection();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1);
      await manager.recheckAfterRejection();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(2);

      mockPlugin.settings.licenseKey = "next-key-456";
      await manager.recheckAfterRejection();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(3);
      expect(mockedNotice).not.toHaveBeenCalled();
    });

    it("leaves a typed key to its own check, which never signs the account out", async () => {
      let finish!: (result: unknown) => void;
      mockPlugin.aiService.validateLicenseDetailed.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const entered = manager.validateLicenseKeyDetailed({ enteredKey: true });

      await manager.recheckAfterRejection();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(1);

      finish({ outcome: "rejected", isValid: false, reason: "invalid" });
      await entered;
      await manager.recheckAfterRejection();
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenCalledTimes(2);
      expect(mockPlugin.aiService.validateLicenseDetailed).toHaveBeenLastCalledWith({ afterRefusal: true });
    });

    it("does nothing without a stored key", async () => {
      mockPlugin.settings.licenseKey = " ";

      await manager.recheckAfterRejection();

      expect(mockPlugin.aiService.validateLicenseDetailed).not.toHaveBeenCalled();
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("tells the user and refreshes open settings when the server signed the key out", async () => {
      mockPlugin.settingsTab = { containerEl: { isConnected: true }, refreshAccountSection: jest.fn() };
      mockPlugin.aiService.validateLicenseDetailed.mockResolvedValue({ outcome: "rejected", isValid: false, reason: "invalid", signedOut: true });

      await manager.recheckAfterRejection();

      expect(mockedNotice.mock.calls).toEqual([[LICENSE_SIGNED_OUT_NOTICE, 10_000]]);
      expect(mockPlugin.settingsTab.refreshAccountSection).toHaveBeenCalledTimes(1);
    });

    it.each([
      { outcome: "valid", isValid: true },
      { outcome: "unavailable", isValid: true },
      { outcome: "rejected", isValid: false, reason: "expired" },
      { outcome: "rejected", isValid: false, reason: "revoked" },
    ])("stays quiet when the re-check keeps the key (%j)", async (result) => {
      mockPlugin.settingsTab = { containerEl: { isConnected: true }, refreshAccountSection: jest.fn() };
      mockPlugin.aiService.validateLicenseDetailed.mockResolvedValue(result);

      await manager.recheckAfterRejection();

      expect(mockedNotice).not.toHaveBeenCalled();
      expect(mockPlugin.settingsTab.refreshAccountSection).not.toHaveBeenCalled();
    });

    it("settles quietly when the check itself fails", async () => {
      mockPlugin.settings.licenseValid = true;
      mockPlugin.aiService.validateLicenseDetailed.mockRejectedValue(new Error("offline"));

      await expect(manager.recheckAfterRejection()).resolves.toBeUndefined();
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
      expect(mockedNotice).not.toHaveBeenCalled();
    });
  });
});
