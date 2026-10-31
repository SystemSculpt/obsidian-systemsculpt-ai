/** @jest-environment jsdom */

import { App, FileSystemAdapter } from "obsidian";
import { hasHostCapability, openLocalFolder } from "../../../platform/hostCapabilities";
import { DiagnosticsFacade, type DiagnosticsFacadeOptions } from "../DiagnosticsFacade";

jest.mock("../../../platform/hostCapabilities", () => ({
  ...jest.requireActual("../../../platform/hostCapabilities"),
  hasHostCapability: jest.fn(),
  openLocalFolder: jest.fn(),
}));

function makeDiagnostics(overrides: Partial<DiagnosticsFacadeOptions> = {}): DiagnosticsFacade {
  return new DiagnosticsFacade({
    getStatus: () => ({ safeMode: false, initializationIssueCount: 0, settingsLoaded: true }),
    areDirectoriesReady: () => true,
    getLogger: () => ({ getSupportDiagnostics: () => [] }),
    getResourceMonitor: () => null,
    getStorage: () => undefined,
    getPluginVersion: () => "6.3.1",
    getObsidianVersion: () => "1.5.0",
    getAdapter: () => new App().vault.adapter,
    ...overrides,
  });
}

function makeStorage() {
  return {
    ensureLocation: jest.fn(async () => undefined),
    getPath: jest.fn(() => ".systemsculpt/diagnostics"),
    writeFile: jest.fn(async () => ({ success: true, path: ".systemsculpt/diagnostics/saved.txt" })),
  };
}

describe("DiagnosticsFacade support snapshot", () => {
  afterEach(() => jest.restoreAllMocks());

  it("projects only the established support schema and resource metric allowlist", () => {
    const iso = "2026-08-10T14:00:00.000Z";
    const getRecentSamples = jest.fn().mockReturnValue([
      {
        iso,
        heapUsedMB: 12.34,
        heapLimitMB: 1_000_000_000,
        rssMB: 0,
        cpuPercent: 25.56,
        eventLoopLagMs: 3.44,
        freezeDeltaMs: 4.45,
        privatePath: "PRIVATE_RESOURCE_PATH",
        memory: { secret: "PRIVATE_NESTED_VALUE" },
      },
      null,
      [],
      "PRIVATE_SAMPLE_TEXT",
      { iso },
      { iso: "2026-08-10T14:00:00Z", heapUsedMB: 1 },
      {
        iso: "PRIVATE_TIMESTAMP",
        heapUsedMB: -1,
        heapLimitMB: Number.NaN,
        rssMB: Number.POSITIVE_INFINITY,
        cpuPercent: "25",
        freezeDeltaMs: 1_000_000_001,
        eventLoopLagMs: 5,
      },
    ]);
    const diagnostics = makeDiagnostics({
      getStatus: () => ({ safeMode: true, initializationIssueCount: 10_001, settingsLoaded: false }),
      getResourceMonitor: () => ({ getRecentSamples, isRecording: () => true }),
      getPluginVersion: () => "PRIVATE_VERSION",
      getObsidianVersion: () => "1.5.0-private",
    });

    const text = diagnostics.buildDiagnosticsSnapshot();
    const snapshot = JSON.parse(text);

    expect(snapshot).toEqual({
      schema_version: 1,
      generated_at: expect.any(String),
      plugin_version: "unknown",
      obsidian_version: "unknown",
      status: {
        safe_mode: true,
        initialization_issue_count: 9_999,
        settings_loaded: false,
        directories_ready: true,
        resource_monitor_running: true,
      },
      event_count: 0,
      events: [],
      resource_sample_count: 3,
      resources: [
        {
          captured_at: iso,
          heap_used_mb: 12.3,
          heap_limit_mb: 1_000_000_000,
          rss_mb: 0,
          cpu_percent: 25.6,
          event_loop_lag_ms: 3.4,
          freeze_delta_ms: 4.5,
        },
        { heap_used_mb: 1 },
        { event_loop_lag_ms: 5 },
      ],
    });
    expect(new Date(snapshot.generated_at).toISOString()).toBe(snapshot.generated_at);
    expect(text).not.toContain("PRIVATE_");
  });

  it.each([
    { eventLimit: undefined, resourceLimit: undefined, events: 200, resources: 8 },
    { eventLimit: 1_000, resourceLimit: 1_000, events: 500, resources: 24 },
    { eventLimit: -1, resourceLimit: -1, events: 0, resources: 0 },
    { eventLimit: 12.9, resourceLimit: 3.9, events: 12, resources: 3 },
    { eventLimit: Number.NaN, resourceLimit: Number.POSITIVE_INFINITY, events: 200, resources: 8 },
  ])("normalizes event and resource limits ($eventLimit, $resourceLimit)", ({ eventLimit, resourceLimit, events, resources }) => {
    const getSupportDiagnostics = jest.fn(() => []);
    const getRecentSamples = jest.fn(() => []);
    const diagnostics = makeDiagnostics({
      getLogger: () => ({ getSupportDiagnostics }),
      getResourceMonitor: () => ({ getRecentSamples, isRecording: () => false }),
    });

    diagnostics.buildDiagnosticsSnapshot(eventLimit, resourceLimit);

    expect(getSupportDiagnostics).toHaveBeenCalledWith(events);
    expect(getRecentSamples).toHaveBeenCalledWith(resources);
  });

  it("keeps snapshots usable when directory readiness and resource sampling fail", () => {
    const diagnostics = makeDiagnostics({
      areDirectoriesReady: () => { throw new Error("PRIVATE_DIRECTORY_FAILURE"); },
      getResourceMonitor: () => ({
        getRecentSamples: () => { throw new Error("PRIVATE_MONITOR_FAILURE"); },
        isRecording: () => false,
      }),
    });

    const snapshot = JSON.parse(diagnostics.buildDiagnosticsSnapshot());

    expect(snapshot.status.directories_ready).toBe(false);
    expect(snapshot.status.resource_monitor_running).toBe(false);
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.resource_sample_count).toBe(0);
  });

  it("reads current status, logger, monitor, and versions rather than construction-time values", () => {
    let safeMode = false;
    let pluginVersion = "6.3.1";
    let obsidianVersion = "1.5.0";
    let recording = false;
    const getSupportDiagnostics = jest.fn(() => []);
    const diagnostics = makeDiagnostics({
      getStatus: () => ({ safeMode, initializationIssueCount: safeMode ? 1 : 0, settingsLoaded: true }),
      getPluginVersion: () => pluginVersion,
      getObsidianVersion: () => obsidianVersion,
      getLogger: () => ({ getSupportDiagnostics }),
      getResourceMonitor: () => recording ? { getRecentSamples: () => [], isRecording: () => true } : null,
    });
    const initial = JSON.parse(diagnostics.buildDiagnosticsSnapshot());
    safeMode = true;
    pluginVersion = "6.4.0";
    obsidianVersion = "1.6.0";
    recording = true;

    const current = JSON.parse(diagnostics.buildDiagnosticsSnapshot());

    expect(initial.status.safe_mode).toBe(false);
    expect(initial.status.resource_monitor_running).toBe(false);
    expect(current.plugin_version).toBe("6.4.0");
    expect(current.obsidian_version).toBe("1.6.0");
    expect(current.status).toMatchObject({ safe_mode: true, initialization_issue_count: 1, resource_monitor_running: true });
    expect(getSupportDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("exports text without requesting secure randomness when storage is unavailable", async () => {
    const diagnostics = makeDiagnostics();
    jest.replaceProperty(window, "crypto", {} as Crypto);

    const exported = await diagnostics.exportDiagnosticsSnapshot();

    expect(JSON.parse(exported.text).schema_version).toBe(1);
    expect(exported).not.toHaveProperty("path");
  });

  it("uses storage that becomes available after construction", async () => {
    let storage: ReturnType<typeof makeStorage> | undefined;
    const diagnostics = makeDiagnostics({ getStorage: () => storage });
    expect((await diagnostics.exportDiagnosticsSnapshot()).path).toBeUndefined();
    storage = makeStorage();

    const exported = await diagnostics.exportDiagnosticsSnapshot();

    expect(exported.path).toBe(".systemsculpt/diagnostics/saved.txt");
    expect(storage.writeFile).toHaveBeenCalledWith("diagnostics", expect.any(String), exported.text);
  });
});

describe("DiagnosticsFacade.openDiagnosticsFolder", () => {
  beforeEach(() => {
    jest.mocked(hasHostCapability).mockReturnValue(true);
    jest.mocked(openLocalFolder).mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it("returns false when storage is unavailable", async () => {
    const diagnostics = makeDiagnostics();

    await expect(diagnostics.openDiagnosticsFolder()).resolves.toBe(false);

    expect(openLocalFolder).not.toHaveBeenCalled();
  });

  it.each([false, true])("reveals the diagnostics folder even if best-effort creation fails (%s)", async (creationFails) => {
    const storage = makeStorage();
    if (creationFails) storage.ensureLocation.mockRejectedValue(new Error("Directory creation failed"));
    const adapter = new FileSystemAdapter("/vault");
    const diagnostics = makeDiagnostics({ getStorage: () => storage, getAdapter: () => adapter });

    await expect(diagnostics.openDiagnosticsFolder()).resolves.toBe(true);

    expect(storage.ensureLocation).toHaveBeenCalledWith("diagnostics");
    expect(storage.getPath).toHaveBeenCalledWith("diagnostics");
    expect(hasHostCapability).toHaveBeenCalledWith("file-manager-reveal");
    expect(openLocalFolder).toHaveBeenCalledWith("/vault/.systemsculpt/diagnostics");
  });

  it("returns false without a filesystem adapter", async () => {
    const storage = makeStorage();
    const diagnostics = makeDiagnostics({ getStorage: () => storage });

    await expect(diagnostics.openDiagnosticsFolder()).resolves.toBe(false);

    expect(openLocalFolder).not.toHaveBeenCalled();
  });

  it("returns false when the host cannot reveal files", async () => {
    jest.mocked(hasHostCapability).mockReturnValue(false);
    const storage = makeStorage();
    const adapter = new FileSystemAdapter("/vault");
    const diagnostics = makeDiagnostics({ getStorage: () => storage, getAdapter: () => adapter });

    await expect(diagnostics.openDiagnosticsFolder()).resolves.toBe(false);

    expect(openLocalFolder).not.toHaveBeenCalled();
  });

  it("returns the desktop folder opener's failure result", async () => {
    jest.mocked(openLocalFolder).mockResolvedValue(false);
    const storage = makeStorage();
    const adapter = new FileSystemAdapter("/vault");
    const diagnostics = makeDiagnostics({ getStorage: () => storage, getAdapter: () => adapter });

    await expect(diagnostics.openDiagnosticsFolder()).resolves.toBe(false);
  });
});
