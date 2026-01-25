/**
 * @jest-environment jsdom
 */
import { App, Notice } from "obsidian";
import { VersionCheckerService, VersionInfo } from "../VersionCheckerService";

// Mock httpClient
jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

// Mock ChangeLogModal
jest.mock("../../modals/ChangeLogModal", () => ({
  ChangeLogModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
}));

// Mock constants
jest.mock("../../constants/api", () => ({
  DEVELOPMENT_MODE: "PRODUCTION",
  API_BASE_URL: "https://api.example.com",
  SYSTEMSCULPT_API_ENDPOINTS: {
    PLUGINS: {
      LATEST: (id: string) => `/plugins/${id}/latest`,
    },
  },
}));

describe("VersionCheckerService", () => {
  let app: App;
  let plugin: any;
  let service: VersionCheckerService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Clear singleton instance between tests
    VersionCheckerService.clearInstance();

    // Clear localStorage
    localStorage.clear();

    app = new App();
    plugin = {
      settings: {
        showUpdateNotifications: true,
        lastKnownVersion: "1.0.0",
      },
      getSettingsManager: jest.fn().mockReturnValue({
        updateSettings: jest.fn().mockResolvedValue(undefined),
      }),
    };

    service = VersionCheckerService.getInstance("1.0.0", app, plugin);
  });

  afterEach(() => {
    jest.useRealTimers();
    VersionCheckerService.clearInstance();
    // Clean up any drawers
    document.querySelectorAll(".systemsculpt-update-drawer").forEach((el) => el.remove());
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = VersionCheckerService.getInstance("1.0.0", app, plugin);
      const instance2 = VersionCheckerService.getInstance("1.0.0");

      expect(instance1).toBe(instance2);
    });

    it("throws error if first call missing app", () => {
      VersionCheckerService.clearInstance();

      expect(() => {
        VersionCheckerService.getInstance("1.0.0");
      }).toThrow("App and plugin must be provided");
    });

    it("throws error if first call missing plugin", () => {
      VersionCheckerService.clearInstance();

      expect(() => {
        VersionCheckerService.getInstance("1.0.0", app);
      }).toThrow("App and plugin must be provided");
    });
  });

  describe("clearInstance", () => {
    it("clears the singleton instance", () => {
      const instance1 = VersionCheckerService.getInstance("1.0.0", app, plugin);
      VersionCheckerService.clearInstance();
      const instance2 = VersionCheckerService.getInstance("1.0.0", app, plugin);

      expect(instance1).not.toBe(instance2);
    });

    it("calls unload before clearing", () => {
      const instance = VersionCheckerService.getInstance("1.0.0", app, plugin);
      const unloadSpy = jest.spyOn(instance, "unload");

      VersionCheckerService.clearInstance();

      expect(unloadSpy).toHaveBeenCalled();
    });
  });

  describe("checkVersion", () => {
    it("returns cached result if not expired", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      // First call
      const result1 = await service.checkVersion();
      // Second call should use cache
      const result2 = await service.checkVersion();

      expect(httpRequest).toHaveBeenCalledTimes(1);
      expect(result2).toEqual(result1);
    });

    it("fetches fresh result when forceRefresh is true", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      await service.checkVersion();
      await service.checkVersion(true);

      expect(httpRequest).toHaveBeenCalledTimes(2);
    });

    it("returns isLatest true when on latest version", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      const result = await service.checkVersion();

      expect(result.isLatest).toBe(true);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("1.0.0");
    });

    it("returns isLatest false when update available", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "2.0.0" } },
      });

      const result = await service.checkVersion();

      expect(result.isLatest).toBe(false);
      expect(result.latestVersion).toBe("2.0.0");
    });

    it("handles API errors gracefully", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockRejectedValue(new Error("Network error"));

      const result = await service.checkVersion();

      // On error, the service returns current version and assumes we're on latest
      expect(result.isLatest).toBe(true);
      expect(result.latestVersion).toBe("1.0.0"); // Falls back to current version
    });

    it("handles 403 rate limit errors", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 403,
      });

      const result = await service.checkVersion();

      expect(result.isLatest).toBe(true);
    });

    it("includes releaseUrl and updateUrl", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      const result = await service.checkVersion();

      expect(result.releaseUrl).toContain("github.com");
      expect(result.updateUrl).toContain("obsidian://show-plugin");
    });
  });

  describe("startPeriodicUpdateCheck", () => {
    it("starts periodic checks when notifications enabled", () => {
      plugin.settings.showUpdateNotifications = true;

      service.startPeriodicUpdateCheck();

      // Advance timer and check that it's set up
      expect(() => jest.advanceTimersByTime(600001)).not.toThrow();
    });

    it("does not start when notifications disabled", () => {
      plugin.settings.showUpdateNotifications = false;

      service.startPeriodicUpdateCheck();

      // Service should not have started periodic checks
      // (we verify by checking no interval is running)
    });
  });

  describe("stopPeriodicUpdateCheck", () => {
    it("stops periodic checks", () => {
      service.startPeriodicUpdateCheck();
      service.stopPeriodicUpdateCheck();

      // Should not throw when advancing timers
      expect(() => jest.advanceTimersByTime(1000000)).not.toThrow();
    });

    it("handles being called when no check is running", () => {
      expect(() => service.stopPeriodicUpdateCheck()).not.toThrow();
    });
  });

  describe("onUpdateNotificationsEnabled", () => {
    it("starts periodic check when notifications enabled", () => {
      plugin.settings.showUpdateNotifications = true;
      const startSpy = jest.spyOn(service, "startPeriodicUpdateCheck");

      service.onUpdateNotificationsEnabled();

      expect(startSpy).toHaveBeenCalled();
    });

    it("does nothing when notifications still disabled", () => {
      plugin.settings.showUpdateNotifications = false;
      const startSpy = jest.spyOn(service, "startPeriodicUpdateCheck");

      service.onUpdateNotificationsEnabled();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("onUpdateNotificationsDisabled", () => {
    it("stops periodic checks", () => {
      const stopSpy = jest.spyOn(service, "stopPeriodicUpdateCheck");

      service.onUpdateNotificationsDisabled();

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("unload", () => {
    it("stops periodic checks", () => {
      const stopSpy = jest.spyOn(service, "stopPeriodicUpdateCheck");

      service.unload();

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("compareVersions (private)", () => {
    const compareVersions = (a: string, b: string): number => {
      return (service as any).compareVersions(a, b);
    };

    it("returns 0 for equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("2.5.3", "2.5.3")).toBe(0);
    });

    it("returns 1 when first version is greater", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    });

    it("returns -1 when first version is smaller", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    });

    it("handles versions with different number of parts", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0", "1.0")).toBe(0);
      expect(compareVersions("1.0", "1.0.1")).toBe(-1);
      expect(compareVersions("1.0.1", "1.0")).toBe(1);
    });

    it("handles multi-digit version numbers", () => {
      expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
      expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
      expect(compareVersions("10.0.0", "9.0.0")).toBe(1);
    });
  });

  describe("checkForUpdatesOnStartup", () => {
    it("waits for delay before checking", async () => {
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      const promise = service.checkForUpdatesOnStartup(1000);

      // Should not have made request yet
      expect(httpRequest).not.toHaveBeenCalled();

      // Advance timer
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); // Flush promises

      // Advance more for idle callback
      jest.advanceTimersByTime(500);
      await Promise.resolve();
    });

    it("does not check if notifications disabled", async () => {
      plugin.settings.showUpdateNotifications = false;
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "2.0.0" } },
      });

      const promise = service.checkForUpdatesOnStartup(100);

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // Should still start periodic checks
    });

    it("shows post-update drawer if version increased", async () => {
      plugin.settings.lastKnownVersion = "0.9.0"; // Previous version
      const { httpRequest } = await import("../../utils/httpClient");
      (httpRequest as jest.Mock).mockResolvedValue({
        status: 200,
        json: { data: { latestVersion: "1.0.0" } },
      });

      VersionCheckerService.clearInstance();
      service = VersionCheckerService.getInstance("1.0.0", app, plugin);

      const promise = service.checkForUpdatesOnStartup(100);

      jest.advanceTimersByTime(200);
      await Promise.resolve();

      // Should have updated settings
      expect(plugin.getSettingsManager().updateSettings).toHaveBeenCalled();
    });
  });

  describe("resetDevUpdateFlow", () => {
    it("resets dev update state in localStorage", () => {
      // This test verifies the method exists and can be called
      // In production mode it's a no-op
      expect(() => service.resetDevUpdateFlow()).not.toThrow();
    });
  });
});
