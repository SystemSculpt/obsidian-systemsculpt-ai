/** @jest-environment jsdom */

import { Platform } from "obsidian";
import { PluginUpdateService, parsePluginReleaseInfo } from "../PluginUpdateService";

const releaseBody = (version = "6.6.2") => ({
  contract_version: "plugin-release-v1",
  plugin_id: "systemsculpt-ai",
  latest_version: version,
  release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${version}`,
  published_at: "2026-08-13T16:00:00.000Z",
});

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings = {
    lastLoadedPluginVersion: "6.6.1",
    ...overrides,
  };
  const statusBarEl = document.createElement("div") as HTMLElement & { setText?: (text: string) => void };
  statusBarEl.setText = (text) => { statusBarEl.textContent = text; };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => Object.assign(settings, patch));
  return {
    manifest: { id: "systemsculpt-ai", version: "6.6.1" },
    settings,
    addStatusBarItem: jest.fn(() => statusBarEl),
    addCommand: jest.fn(),
    getSettingsManager: () => ({ updateSettings }),
    statusBarEl,
    updateSettings,
  } as any;
}

describe("PluginUpdateService", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    jest.useRealTimers();
    (Platform as any).isDesktopApp = true;
    (Platform as any).isMobile = false;
    (Platform as any).isMobileApp = false;
  });

  it("accepts only the exact first-party release envelope", () => {
    expect(parsePluginReleaseInfo(releaseBody())).toMatchObject({ latestVersion: "6.6.2" });
    expect(parsePluginReleaseInfo({ ...releaseBody(), token: "forbidden" })).toBeNull();
    expect(parsePluginReleaseInfo({ ...releaseBody(), latest_version: "latest" })).toBeNull();
    expect(parsePluginReleaseInfo({ ...releaseBody(), plugin_id: "other" })).toBeNull();
    expect(parsePluginReleaseInfo("<html>gateway error</html>")).toBeNull();
  });

  it("announces an available release once per session and keeps an update action", async () => {
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(releaseBody());
    const notify = jest.fn();
    const openUpdatePage = jest.fn();
    const service = new PluginUpdateService(plugin, { request, notify, openUpdatePage });

    service.start();
    await service.checkForUpdates();

    expect(notify).toHaveBeenCalledWith(
      "SystemSculpt 6.6.2 is ready. Open Community Plugins to update.",
      12_000,
    );
    expect(plugin.statusBarEl.hidden).toBe(false);
    expect(plugin.statusBarEl.textContent).toBe("Update SystemSculpt to 6.6.2");
    plugin.statusBarEl.click();
    expect(openUpdatePage).toHaveBeenCalledTimes(1);

    notify.mockClear();
    await service.checkForUpdates();
    expect(notify).not.toHaveBeenCalled();
    service.stop();
  });

  it("checks every minute and when the user returns after 30 seconds", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(releaseBody("6.6.1"));
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn(), now: () => now });

    service.start();
    await service.checkForUpdates();
    expect(request).toHaveBeenCalledTimes(1);

    now = 30_000;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);

    now = 90_000;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(3);
    service.stop();
  });

  it("keeps failures quiet in the background and gives manual feedback", async () => {
    const plugin = createPlugin();
    const notify = jest.fn();
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockRejectedValue(new Error("offline")),
      notify,
    });

    await expect(service.checkForUpdates()).resolves.toEqual({ outcome: "unavailable" });
    expect(notify).not.toHaveBeenCalled();
    await service.checkForUpdates({ manual: true });
    expect(notify).toHaveBeenCalledWith("Update check is temporarily unavailable. Try again.", 6_000);
  });

  it("works on mobile without creating a status-bar action", async () => {
    (Platform as any).isDesktopApp = false;
    (Platform as any).isMobile = true;
    (Platform as any).isMobileApp = true;
    const plugin = createPlugin();
    const notify = jest.fn();
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue(releaseBody()),
      notify,
    });

    await service.checkForUpdates();

    expect(notify).toHaveBeenCalledWith(
      "SystemSculpt 6.6.2 is ready. Open Community Plugins to update.",
      12_000,
    );
    expect(plugin.addStatusBarItem).not.toHaveBeenCalled();
  });
});
