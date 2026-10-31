/** @jest-environment jsdom */

import { Platform } from "obsidian";
import { PlatformRequestClient } from "../PlatformRequestClient";
import {
  PluginReleaseRequestError,
  PluginUpdateService,
  cacheControlMaxAgeMs,
  parsePluginReleaseInfo,
  type PluginReleaseFetch,
} from "../PluginUpdateService";
import fixture from "../../../testing/fixtures/retry-after.json";

const HOUR_MS = 60 * 60_000;

const releaseBody = (version = "6.6.2") => ({
  contract_version: "plugin-release-v1",
  plugin_id: "systemsculpt-ai",
  latest_version: version,
  release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${version}`,
  published_at: "2026-08-13T16:00:00.000Z",
});
const release = (version = "6.6.2", freshForMs?: number) => ({ body: releaseBody(version), freshForMs });

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function createPlugin(overrides: Record<string, unknown> = {}) {
  const settings = {
    ...overrides,
  };
  const statusBarEl = document.createElement("div");
  statusBarEl.setText = (text) => { statusBarEl.textContent = typeof text === "string" ? text : text.textContent; };
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => Object.assign(settings, patch));
  return {
    manifest: { id: "systemsculpt-ai", version: "6.6.1" },
    settings,
    addStatusBarItem: jest.fn(() => statusBarEl),
    addCommand: jest.fn(),
    register: jest.fn(),
    registerInterval: jest.fn((id: number) => id),
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
    Reflect.deleteProperty(document, "hidden");
    Reflect.deleteProperty(window.navigator, "onLine");
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

  it("keeps background release discovery passive: a status-bar action and nothing else", async () => {
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(release());
    const notify = jest.fn();
    const openUpdatePage = jest.fn();
    const service = new PluginUpdateService(plugin, { request, notify, openUpdatePage });

    service.start();
    await settle();
    await service.checkForUpdates();

    expect(request).toHaveBeenCalledTimes(2);
    expect(plugin.addCommand).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    expect(document.querySelector(".modal")).toBeNull();
    expect(plugin.statusBarEl.hidden).toBe(false);
    expect(plugin.statusBarEl.textContent).toBe("Update SystemSculpt to 6.6.2");
    expect(openUpdatePage).not.toHaveBeenCalled();
    plugin.statusBarEl.click();
    expect(openUpdatePage).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("shows no toast or prompt after the plugin itself was updated", async () => {
    const plugin = createPlugin();
    plugin.manifest.version = "6.6.2";
    const notify = jest.fn();
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue(release("6.6.2")),
      notify,
    });

    service.start();
    await settle();

    expect(notify).not.toHaveBeenCalled();
    expect(plugin.updateSettings).not.toHaveBeenCalled();
    service.stop();
  });

  it("answers a manual check with one available result that opens Obsidian's plugin updates", async () => {
    const plugin = createPlugin();
    const notify = jest.fn();
    const openUpdatePage = jest.fn();
    const service = new PluginUpdateService(plugin, {
      request: jest.fn().mockResolvedValue(release()),
      notify,
      openUpdatePage,
    });

    await expect(service.checkForUpdates({ manual: true })).resolves.toMatchObject({ outcome: "update_available" });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("SystemSculpt 6.6.2 is available.", 10_000, {
      label: "Open plugin updates",
      onSelect: expect.any(Function),
    });
    expect(openUpdatePage).not.toHaveBeenCalled();
    notify.mock.calls[0][2].onSelect();
    expect(openUpdatePage).toHaveBeenCalledTimes(1);
    expect(plugin.updateSettings).not.toHaveBeenCalled();
  });

  it("checks at launch, then at most once per six hours with a single timeout", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(release("6.6.1"));
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn(), now: () => now });

    service.start();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(plugin.registerInterval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    // Returning to the app before the window elapses never adds a request.
    now = HOUR_MS;
    window.dispatchEvent(new Event("focus"));
    setHidden(false);
    setHidden(true);
    expect(jest.getTimerCount()).toBe(0);
    setHidden(false);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    now = 6 * HOUR_MS;
    await jest.advanceTimersByTimeAsync(5 * HOUR_MS);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);

    service.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("pauses while hidden or offline and resumes a due check on return", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.fn().mockResolvedValue(release("6.6.1"));
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn(), now: () => now });

    setHidden(false);
    setOnline(false);
    service.start();
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    setOnline(true);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    // Hiding the window disarms the timeout; nothing wakes while hidden.
    setHidden(true);
    expect(jest.getTimerCount()).toBe(0);
    now = 12 * HOUR_MS;
    await jest.advanceTimersByTimeAsync(12 * HOUR_MS);
    expect(request).toHaveBeenCalledTimes(1);

    setHidden(false);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("backs off failed background checks and honors server retry and cache headers", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new PluginReleaseRequestError("busy", 3 * HOUR_MS))
      .mockResolvedValueOnce(release("6.6.1", 12 * HOUR_MS))
      .mockResolvedValue(release("6.6.1"));
    const service = new PluginUpdateService(plugin, { request, notify: jest.fn(), now: () => now });
    const advance = async (ms: number) => {
      now += ms;
      await jest.advanceTimersByTimeAsync(ms);
      await settle();
    };

    service.start();
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    await advance(15 * 60_000 - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(request).toHaveBeenCalledTimes(2);

    await advance(30 * 60_000);
    expect(request).toHaveBeenCalledTimes(3);

    // Retry-After is longer than the one-hour backoff.
    await advance(HOUR_MS);
    expect(request).toHaveBeenCalledTimes(3);
    await advance(2 * HOUR_MS);
    expect(request).toHaveBeenCalledTimes(4);

    // A twelve-hour server cache lifetime stretches the six-hour floor.
    await advance(6 * HOUR_MS);
    expect(request).toHaveBeenCalledTimes(4);
    await advance(6 * HOUR_MS);
    expect(request).toHaveBeenCalledTimes(5);
    service.stop();
  });

  it("reads the release with a request deadline and the server cache lifetime", async () => {
    let now = 0;
    const plugin = createPlugin();
    const request = jest.spyOn(PlatformRequestClient.prototype, "request").mockResolvedValue(
      new Response(JSON.stringify(releaseBody("6.6.1")), {
        status: 200,
        headers: { "cache-control": "public, max-age=43200" },
      }),
    );
    const service = new PluginUpdateService(plugin, { notify: jest.fn(), now: () => now });

    await expect(service.checkForUpdates()).resolves.toMatchObject({ outcome: "up_to_date" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      timeoutMs: 8_000,
      url: expect.stringMatching(/\/releases\/latest$/u),
    }));

    service.start();
    now = 11 * HOUR_MS;
    await jest.advanceTimersByTimeAsync(11 * HOUR_MS);
    expect(request).toHaveBeenCalledTimes(1);
    now = 12 * HOUR_MS;
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    service.stop();
    request.mockRestore();
  });

  it.each(fixture.cases)("schedules $name from the real release transport at the existing 24-hour ceiling", async ({ header, milliseconds }) => {
    jest.setSystemTime(fixture.now);
    setHidden(false);
    setOnline(true);
    const request = jest.spyOn(PlatformRequestClient.prototype, "request").mockImplementation(async () =>
      new Response("busy", { status: 503, headers: header === null ? {} : { "Retry-After": header } }),
    );
    const service = new PluginUpdateService(createPlugin(), { notify: jest.fn() });
    try {
      service.start();
      await settle();
      const wait = Math.max(15 * 60_000, Math.min(24 * HOUR_MS, milliseconds ?? 0));
      await jest.advanceTimersByTimeAsync(wait - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      request.mockRestore();
    }
  });

  it("parses cache hints", () => {
    expect(cacheControlMaxAgeMs("public, max-age=60")).toBe(60_000);
    expect(cacheControlMaxAgeMs("no-store, max-age=600")).toBeUndefined();
    expect(cacheControlMaxAgeMs("private")).toBeUndefined();
    expect(cacheControlMaxAgeMs(null)).toBeUndefined();
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
    let resolveRequest!: (value: PluginReleaseFetch) => void;
    const request = jest.fn(() => new Promise<PluginReleaseFetch>((resolve) => {
      resolveRequest = resolve;
    }));
    const service = new PluginUpdateService(plugin, { request, notify });

    const backgroundCheck = service.checkForUpdates();
    const manualCheck = service.checkForUpdates({ manual: true });
    resolveRequest(release("6.6.1"));

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
      request: jest.fn().mockResolvedValue(release()),
      notify,
    });

    await service.checkForUpdates();
    expect(notify).not.toHaveBeenCalled();
    expect(plugin.addStatusBarItem).not.toHaveBeenCalled();

    // Mobile has no status bar, so the manual check is its update entry point.
    await service.checkForUpdates({ manual: true });
    expect(notify).toHaveBeenCalledWith("SystemSculpt 6.6.2 is available.", 10_000, expect.objectContaining({
      label: "Open plugin updates",
    }));
  });
});
