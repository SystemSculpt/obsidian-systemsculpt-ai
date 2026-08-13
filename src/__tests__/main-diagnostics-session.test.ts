/** @jest-environment jsdom */

import { App, Platform } from "obsidian";
import SystemSculptPlugin from "../main";
import { DiagnosticsSessionLifecycle } from "../core/diagnostics/DiagnosticsSessionLifecycle";

const DIAGNOSTICS_PATH = ".systemsculpt/diagnostics";
const DAY_MS = 24 * 60 * 60 * 1_000;

function makePlugin(app: App = new App()): SystemSculptPlugin {
  return new SystemSculptPlugin(app, {
    id: "systemsculpt-ai",
    version: "6.6.0",
  } as any);
}

function installStorage(plugin: SystemSculptPlugin, writeFile: jest.Mock = jest.fn(async () => ({ success: true, path: "saved" }))): jest.Mock {
  plugin.storage = {
    initialize: jest.fn(async () => undefined),
    writeFile,
    getPath: jest.fn(() => DIAGNOSTICS_PATH),
  } as any;
  jest.spyOn(plugin as any, "rotateDiagnosticsFile").mockResolvedValue(undefined);
  return writeFile;
}

async function prepareAndWaitForCleanup(plugin: SystemSculptPlugin): Promise<void> {
  const originalRun = DiagnosticsSessionLifecycle.prototype.run;
  let cleanup: Promise<void> | undefined;
  const run = jest.spyOn(DiagnosticsSessionLifecycle.prototype, "run").mockImplementation(function (this: DiagnosticsSessionLifecycle, now?: number) {
    cleanup = originalRun.call(this, now);
    return cleanup;
  });

  await (plugin as any).prepareDiagnosticsSession();
  expect(cleanup).toBeDefined();
  await cleanup;
  run.mockRestore();
}

describe("SystemSculptPlugin diagnostics session wiring", () => {
  const platform = Platform as typeof Platform & {
    isAndroidApp?: boolean;
    isDesktopApp?: boolean;
    isIosApp?: boolean;
    isLinux?: boolean;
    isMacOS?: boolean;
    isMobileApp?: boolean;
    isWin?: boolean;
  };
  const originalPlatform = {
    isAndroidApp: platform.isAndroidApp,
    isDesktopApp: platform.isDesktopApp,
    isIosApp: platform.isIosApp,
    isLinux: platform.isLinux,
    isMacOS: platform.isMacOS,
    isMobileApp: platform.isMobileApp,
    isWin: platform.isWin,
  };

  beforeEach(() => {
    platform.isAndroidApp = false;
    platform.isDesktopApp = true;
    platform.isIosApp = false;
    platform.isLinux = false;
    platform.isMacOS = true;
    platform.isMobileApp = false;
    platform.isWin = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    platform.isAndroidApp = originalPlatform.isAndroidApp;
    platform.isDesktopApp = originalPlatform.isDesktopApp;
    platform.isIosApp = originalPlatform.isIosApp;
    platform.isLinux = originalPlatform.isLinux;
    platform.isMacOS = originalPlatform.isMacOS;
    platform.isMobileApp = originalPlatform.isMobileApp;
    platform.isWin = originalPlatform.isWin;
  });

  it.each([
    { isAndroidApp: true, isIosApp: false, operatingSystem: "Android" },
    { isAndroidApp: false, isIosApp: true, operatingSystem: "iOS" },
  ])("writes the exact mobile metadata allowlist to both session files on $operatingSystem", async ({ isAndroidApp, isIosApp, operatingSystem }) => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-08-13T16:00:00.000Z"));
    platform.isAndroidApp = isAndroidApp;
    platform.isDesktopApp = false;
    platform.isIosApp = isIosApp;
    platform.isMacOS = false;
    platform.isMobileApp = true;
    const app = new App();
    (app.vault as any).getName = () => "PRIVATE_VAULT_CANARY";
    (app.vault as any).configDir = ".private-config-canary";
    (app as any).plugins = { enabledPlugins: new Set(["private-plugin-canary"]) };
    expect((app.vault.adapter as any).getBasePath).toBeUndefined();
    const plugin = makePlugin(app);
    const writeFile = installStorage(plugin);
    jest.spyOn(plugin as any, "formatDiagnosticsFileTimestamp").mockReturnValue("20260813-160000");
    jest.spyOn(DiagnosticsSessionLifecycle.prototype, "run").mockResolvedValue(undefined);
    const metadata = {
      schemaVersion: 2,
      sessionId: "20260813-160000",
      startedAt: "2026-08-13T16:00:00.000Z",
      environment: {
        pluginVersion: "6.6.0",
        obsidianVersion: "1.5.0",
        hostDevice: "Mobile",
        operatingSystem,
      },
    };

    await expect((plugin as any).prepareDiagnosticsSession()).resolves.toBeUndefined();

    expect(writeFile.mock.calls).toEqual([
      ["diagnostics", "session-latest.json", metadata],
      ["diagnostics", `session-${metadata.sessionId}.json`, metadata],
    ]);
    expect(writeFile.mock.calls[0]?.[2]).toEqual(writeFile.mock.calls[1]?.[2]);
    expect(JSON.stringify(writeFile.mock.calls)).not.toMatch(/PRIVATE_VAULT_CANARY|private-config-canary|private-plugin-canary/u);
  });

  it("does not wait for detached archive cleanup during diagnostics startup", async () => {
    const plugin = makePlugin();
    installStorage(plugin);
    const cleanup = jest.spyOn(DiagnosticsSessionLifecycle.prototype, "run").mockReturnValue(new Promise<void>(() => undefined));

    await expect((plugin as any).prepareDiagnosticsSession()).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((plugin as any).diagnosticsSessionLifecycle).toBeInstanceOf(DiagnosticsSessionLifecycle);
  });

  it.each([
    {
      operation: "list",
      configure: (adapter: any, path: string) => {
        adapter.list.mockImplementation(async (listedPath: string) => {
          expect(listedPath).toBe(DIAGNOSTICS_PATH);
          throw new Error("PRIVATE_LIST_FAILURE");
        });
      },
      warning: "[SystemSculpt][Diagnostics] Archive cleanup skipped 1 file checks and 0 removals",
    },
    {
      operation: "stat",
      configure: (adapter: any, path: string) => {
        adapter.list.mockResolvedValue({ files: [path], folders: [] });
        adapter.stat.mockRejectedValue(new Error("PRIVATE_STAT_FAILURE"));
      },
      warning: "[SystemSculpt][Diagnostics] Archive cleanup skipped 1 file checks and 0 removals",
    },
    {
      operation: "read",
      configure: (adapter: any, path: string) => {
        adapter.list.mockResolvedValue({ files: [path], folders: [] });
        adapter.stat.mockResolvedValue({ type: "file", ctime: Date.now(), mtime: Date.now(), size: 2 });
        adapter.read.mockRejectedValue(new Error("PRIVATE_READ_FAILURE"));
      },
      warning: "[SystemSculpt][Diagnostics] Archive cleanup skipped 1 file checks and 0 removals",
    },
    {
      operation: "remove",
      configure: (adapter: any, path: string) => {
        adapter.list.mockResolvedValue({ files: [path], folders: [] });
        adapter.stat.mockResolvedValue({ type: "file", ctime: Date.now(), mtime: Date.now() - 15 * DAY_MS, size: 3 });
        adapter.remove.mockRejectedValue(new Error("PRIVATE_REMOVE_FAILURE"));
      },
      warning: "[SystemSculpt][Diagnostics] Archive cleanup skipped 0 file checks and 1 removals",
    },
  ])("contains an adapter $operation failure and emits only a privacy-safe warning", async ({ operation, configure, warning: expectedWarning }) => {
    const app = new App();
    const adapter = app.vault.adapter as any;
    const path = operation === "read"
      ? `${DIAGNOSTICS_PATH}/session-20260812-160000.json`
      : `${DIAGNOSTICS_PATH}/systemsculpt-20260729-160000.log`;
    configure(adapter, path);
    const plugin = makePlugin(app);
    installStorage(plugin);
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(prepareAndWaitForCleanup(plugin)).resolves.toBeUndefined();

    expect(warning.mock.calls).toEqual([[expectedWarning]]);
    const serializedWarnings = JSON.stringify(warning.mock.calls);
    expect(serializedWarnings).not.toContain(DIAGNOSTICS_PATH);
    expect(serializedWarnings).not.toContain(`PRIVATE_${operation.toUpperCase()}_FAILURE`);
  });

  it("removes an oversize session archive without reading it", async () => {
    const app = new App();
    const adapter = app.vault.adapter as any;
    const path = `${DIAGNOSTICS_PATH}/session-20260812-160000.json`;
    adapter.list.mockResolvedValue({ files: [path], folders: [] });
    adapter.stat.mockResolvedValue({ type: "file", ctime: Date.now(), mtime: Date.now(), size: 64 * 1024 + 1 });
    adapter.read.mockRejectedValue(new Error("OVERSIZE_SESSION_MUST_NOT_BE_READ"));
    adapter.remove.mockResolvedValue(undefined);
    const plugin = makePlugin(app);
    installStorage(plugin);

    await expect(prepareAndWaitForCleanup(plugin)).resolves.toBeUndefined();

    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.remove.mock.calls).toEqual([[path]]);
  });

  it("closes diagnostics cleanup admission during unload", async () => {
    const plugin = makePlugin();
    const close = jest.fn();
    (plugin as any).diagnosticsSessionLifecycle = { close };
    jest.spyOn(plugin as any, "getInitializationTracer").mockReturnValue({
      startPhase: jest.fn(() => ({ complete: jest.fn(), fail: jest.fn() })),
      flushOpenPhases: jest.fn(),
    });
    jest.spyOn(plugin, "getLogger").mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      flushBeforeUnload: jest.fn(async () => undefined),
      dispose: jest.fn(),
    } as any);

    await expect(plugin.onunload()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
