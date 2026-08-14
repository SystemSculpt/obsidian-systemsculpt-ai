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
    lastAnnouncedPluginRelease: "",
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

  it("shows one prompt per release and keeps an update action", async () => {
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(releaseBody());
    const notify = jest.fn();
    const openUpdatePage = jest.fn();
    const showUpdatePrompt = jest.fn().mockResolvedValue(false);
    const service = new PluginUpdateService(plugin, {
      request,
      notify,
      openUpdatePage,
      showUpdatePrompt,
    });

    service.start();
    await service.checkForUpdates();

    expect(showUpdatePrompt).toHaveBeenCalledWith("6.6.2");
    expect(plugin.updateSettings).toHaveBeenCalledWith({ lastAnnouncedPluginRelease: "6.6.2" });
    expect(notify).not.toHaveBeenCalled();
    expect(plugin.statusBarEl.hidden).toBe(false);
    expect(plugin.statusBarEl.textContent).toBe("Update SystemSculpt to 6.6.2");
    plugin.statusBarEl.click();
    expect(openUpdatePage).toHaveBeenCalledTimes(1);

    showUpdatePrompt.mockClear();
    await service.checkForUpdates();
    expect(showUpdatePrompt).not.toHaveBeenCalled();
    service.stop();
  });

  it("opens the Obsidian update page from the prompt", async () => {
    const plugin = createPlugin();
    const openUpdatePage = jest.fn();
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue(releaseBody()),
      notify: jest.fn(),
      openUpdatePage,
      showUpdatePrompt: jest.fn().mockResolvedValue(true),
    });

    await service.checkForUpdates();

    expect(openUpdatePage).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a dismissed release unless the user checks manually", async () => {
    const plugin = createPlugin({ lastAnnouncedPluginRelease: "6.6.2" });
    const showUpdatePrompt = jest.fn().mockResolvedValue(false);
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue(releaseBody()),
      notify: jest.fn(),
      showUpdatePrompt,
    });

    await service.checkForUpdates();
    expect(showUpdatePrompt).not.toHaveBeenCalled();

    await service.checkForUpdates({ manual: true });
    expect(showUpdatePrompt).toHaveBeenCalledWith("6.6.2");
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

  it("adds manual feedback to an in-flight background check", async () => {
    const plugin = createPlugin();
    const notify = jest.fn();
    let resolveRequest!: (value: unknown) => void;
    const request = jest.fn(() => new Promise<unknown>((resolve) => {
      resolveRequest = resolve;
    }));
    const service = new PluginUpdateService(plugin, { request, notify });

    const backgroundCheck = service.checkForUpdates();
    const manualCheck = service.checkForUpdates({ manual: true });
    resolveRequest(releaseBody("6.6.1"));

    await expect(Promise.all([backgroundCheck, manualCheck])).resolves.toEqual([
      expect.objectContaining({ outcome: "up_to_date" }),
      expect.objectContaining({ outcome: "up_to_date" }),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("SystemSculpt 6.6.1 is current.", 5_000);
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
      showUpdatePrompt: jest.fn().mockResolvedValue(false),
    });

    await service.checkForUpdates();

    expect(notify).not.toHaveBeenCalled();
    expect(plugin.addStatusBarItem).not.toHaveBeenCalled();
  });
});
