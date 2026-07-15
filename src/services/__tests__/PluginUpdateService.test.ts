/** @jest-environment jsdom */

import { PluginUpdateService, parsePluginReleaseInfo } from "../PluginUpdateService";

const releaseBody = (version = "6.0.2") => ({
  contract_version: "plugin-release-v1",
  plugin_id: "systemsculpt-ai",
  latest_version: version,
  release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${version}`,
  published_at: "2026-07-15T16:00:00.000Z",
});

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings = {
    lastAnnouncedPluginRelease: "",
    lastLoadedPluginVersion: "6.0.1",
    ...overrides,
  };
  const statusBarEl = document.createElement("div") as HTMLElement & { setText?: (text: string) => void };
  statusBarEl.setText = (text) => { statusBarEl.textContent = text; };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => Object.assign(settings, patch));
  return {
    manifest: { id: "systemsculpt-ai", version: "6.0.1" },
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
  });

  it("accepts only the exact first-party release envelope", () => {
    expect(parsePluginReleaseInfo(releaseBody())).toMatchObject({ latestVersion: "6.0.2" });
    expect(parsePluginReleaseInfo({ ...releaseBody(), token: "forbidden" })).toBeNull();
    expect(parsePluginReleaseInfo({ ...releaseBody(), latest_version: "latest" })).toBeNull();
    expect(parsePluginReleaseInfo({ ...releaseBody(), plugin_id: "other" })).toBeNull();
    expect(parsePluginReleaseInfo("<html>gateway error</html>")).toBeNull();
  });

  it("announces each new release once and keeps a persistent update action", async () => {
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue({ status: 200, json: releaseBody() });
    const notify = jest.fn();
    const openUpdatePage = jest.fn();
    const service = new PluginUpdateService(plugin, { request, notify, openUpdatePage });

    await service.start();

    expect(notify).toHaveBeenCalledWith(
      "SystemSculpt 6.0.2 is ready. Update in Community plugins.",
      12_000,
    );
    expect(plugin.updateSettings).toHaveBeenCalledWith({ lastAnnouncedPluginRelease: "6.0.2" });
    expect(plugin.statusBarEl.hidden).toBe(false);
    expect(plugin.statusBarEl.textContent).toBe("Update SystemSculpt to 6.0.2");
    plugin.statusBarEl.click();
    expect(openUpdatePage).toHaveBeenCalledTimes(1);

    notify.mockClear();
    await service.checkForUpdates();
    expect(notify).not.toHaveBeenCalled();
    expect(plugin.statusBarEl.hidden).toBe(false);
    service.stop();
  });

  it("shows an installed-version confirmation and hides the action when current", async () => {
    const plugin = createPlugin({ lastLoadedPluginVersion: "6.0.0" });
    plugin.manifest.version = "6.0.2";
    const request = jest.fn().mockResolvedValue({ status: 200, json: releaseBody("6.0.2") });
    const notify = jest.fn();
    const service = new PluginUpdateService(plugin, { request, notify });

    await service.start();

    expect(notify).toHaveBeenCalledWith("SystemSculpt updated to 6.0.2.", 6_000);
    expect(plugin.updateSettings).toHaveBeenCalledWith({ lastLoadedPluginVersion: "6.0.2" });
    expect(plugin.statusBarEl.hidden).toBe(true);
    service.stop();
  });

  it("preserves an existing update action during a transient check failure", async () => {
    const plugin = createPlugin();
    const request = jest.fn()
      .mockResolvedValueOnce({ status: 200, json: releaseBody() })
      .mockRejectedValueOnce(new Error("offline"));
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn() });
    await service.start();

    await expect(service.checkForUpdates()).resolves.toEqual({ outcome: "unavailable" });
    expect(plugin.statusBarEl.hidden).toBe(false);
    service.stop();
  });

  it("gives explicit manual-check feedback without false update claims", async () => {
    const plugin = createPlugin();
    const notify = jest.fn();
    const current = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue({ status: 200, json: releaseBody("6.0.1") }),
      notify,
    });
    await current.checkForUpdates({ manual: true });
    expect(notify).toHaveBeenCalledWith("SystemSculpt 6.0.1 is current.", 5_000);

    const unavailable = new PluginUpdateService(plugin, {
      request: jest.fn().mockRejectedValue(new Error("offline")),
      notify,
    });
    await unavailable.checkForUpdates({ manual: true });
    expect(notify).toHaveBeenCalledWith("Update check is temporarily unavailable. Try again.", 6_000);
  });

  it("rechecks while Obsidian stays open and when the user returns", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue({ status: 200, json: releaseBody("6.0.1") });
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn(), now: () => now });

    await service.start();
    expect(request).toHaveBeenCalledTimes(1);

    now = 5 * 60 * 1000;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);

    now = 10 * 60 * 1000;
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(request).toHaveBeenCalledTimes(3);
    service.stop();
  });
});
