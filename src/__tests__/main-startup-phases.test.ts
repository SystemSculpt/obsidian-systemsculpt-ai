/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { DiagnosticsSessionLifecycle } from "../core/diagnostics/DiagnosticsSessionLifecycle";
import { DEFAULT_SETTINGS } from "../types";

const obsidian = require("obsidian");
jest.mock("../features/audio-processor/AudioProcessorResume", () => ({ resumeAudioProcessorJobs: jest.fn() }));

function makePlugin(app: App = new App()): SystemSculptPlugin {
  return new SystemSculptPlugin(app, {
    id: "systemsculpt-ai",
    version: "6.6.0",
  } as any);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function registeredTaskIds(plugin: SystemSculptPlugin, phase: string): string[] {
  const coordinator = (plugin as any).lifecycleCoordinator;
  return ((coordinator as any).phases.get(phase) ?? []).map((task: { id: string }) => task.id);
}

function runTask(plugin: SystemSculptPlugin, phase: string, id: string): Promise<void> | void {
  const coordinator = (plugin as any).lifecycleCoordinator;
  const task = ((coordinator as any).phases.get(phase) ?? []).find((entry: { id: string }) => entry.id === id);
  if (!task) throw new Error(`Missing ${phase}.${id}`);
  return task.run();
}

describe("SystemSculptPlugin startup phases", () => {
  const idleWindow: Omit<Window, "requestIdleCallback" | "cancelIdleCallback"> & {
    requestIdleCallback?: unknown;
    cancelIdleCallback?: unknown;
  } = window;
  let idleCallbacks: Array<() => void>;

  beforeEach(() => {
    idleCallbacks = [];
    idleWindow.requestIdleCallback = jest.fn((callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    idleWindow.cancelIdleCallback = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete idleWindow.requestIdleCallback;
    delete idleWindow.cancelIdleCallback;
  });

  const runIdleCallbacks = (): void => {
    const pending = idleCallbacks;
    idleCallbacks = [];
    pending.forEach((callback) => callback());
  };

  it("registers ribbons during bootstrap without starting deferred chat restoration", async () => {
    const plugin = makePlugin();
    (plugin as any).configureLifecycle();
    const addRibbon = jest.spyOn(plugin, "addRibbonIcon");
    await runTask(plugin, "bootstrap", "workspace.ribbons");
    expect(addRibbon).toHaveBeenCalledTimes(7);
    expect((plugin as any).viewManager).toBeDefined();
    const initialize = jest.spyOn((plugin as any).viewManager, "initialize");
    // The normal manager entry point still initializes views after bootstrap.
    plugin.getViewManager();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(addRibbon).toHaveBeenCalledTimes(7);
  });

  it("starts update checks after layout-ready instead of in the critical phase", () => {
    const plugin = makePlugin();

    (plugin as any).configureLifecycle();

    expect(registeredTaskIds(plugin, "critical")).not.toContain("updates.start");
    expect(registeredTaskIds(plugin, "layout")).toContain("updates.start");
  });

  it("traces each critical task once and records a failed command registration once", async () => {
    const plugin = makePlugin();
    const tracker = { complete: jest.fn(), fail: jest.fn() };
    const tracer = { startPhase: jest.fn((_phase: string) => tracker), markMilestone: jest.fn() };
    jest.spyOn(plugin as any, "getInitializationTracer").mockReturnValue(tracer);
    jest.spyOn(plugin as any, "initializeSettings").mockResolvedValue(undefined);
    jest.spyOn(plugin as any, "ensureDirectoryManager").mockReturnValue({ initialize: async () => undefined });
    jest.spyOn(plugin as any, "initializeBasicUI").mockResolvedValue(undefined);
    jest.spyOn(plugin as any, "ensureCommandManager").mockImplementation(() => { throw new Error("Command registration failed"); });
    const fileMenu = jest.spyOn(plugin as any, "setupFileContextMenuService").mockImplementation(() => undefined);
    jest.spyOn(plugin, "getLogger").mockReturnValue({ warn: jest.fn() } as any);
    (plugin as any).configureLifecycle();

    await (plugin as any).lifecycleCoordinator.runPhase("critical");

    expect(tracer.startPhase.mock.calls.map(([phase]) => phase)).toEqual([
      "lifecycle.critical.settings.load", "lifecycle.critical.directories.initialize",
      "lifecycle.critical.ui.basic.initialize", "lifecycle.critical.commands.register",
      "lifecycle.critical.fileContextMenu.start",
    ]);
    expect((plugin as any).failures).toEqual(["command registration"]);
    expect(tracker.fail).toHaveBeenCalledTimes(1);
    expect(fileMenu).toHaveBeenCalledTimes(1);
  });

  it.each(["saved capture", "orphaned fragment", "empty vault"])("admits recorder recovery only for pending work: %s", async (source) => {
    const app = new App();
    const plugin = makePlugin(app);
    plugin._internal_settings_systemsculpt_plugin = {
      ...DEFAULT_SETTINGS,
      pendingRecorderCaptures: source === "saved capture" ? [{ filePath: "Recordings/pending.webm" } as any] : [],
    };
    jest.mocked(app.vault.adapter.exists).mockResolvedValue(source === "orphaned fragment");
    jest.mocked(app.vault.adapter.list).mockResolvedValue({ files: [".systemsculpt/recordings-in-progress/orphan.webm"], folders: [] });
    const recoverPendingCaptures = jest.fn();
    const ensure = jest.spyOn(plugin, "ensureRecorderService").mockReturnValue({ recoverPendingCaptures } as any);
    (plugin as any).configureLifecycle();

    await runTask(plugin, "deferred", "recorder.recover");

    expect(ensure).toHaveBeenCalledTimes(source === "empty vault" ? 0 : 1);
    expect(recoverPendingCaptures).toHaveBeenCalledTimes(source === "empty vault" ? 0 : 1);
  });

  it("does not start audio recovery if unload begins during its lazy import", async () => {
    const plugin = makePlugin();
    const resume = require("../features/audio-processor/AudioProcessorResume").resumeAudioProcessorJobs;
    resume.mockReset().mockResolvedValue(undefined);
    (plugin as any).configureLifecycle();
    const recovery = runTask(plugin, "deferred", "audioProcessor.recover");
    (plugin as any).deferredStartup.abort();
    expect((plugin as any).isUnloading).toBe(false);
    await recovery;
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not create a recorder after unloading during a pending disk check", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const exists = deferred<boolean>();
    jest.mocked(app.vault.adapter.exists).mockReturnValue(exists.promise);
    jest.mocked(app.vault.adapter.list).mockResolvedValue({ files: ["orphan.webm"], folders: [] });
    const ensure = jest.spyOn(plugin, "ensureRecorderService");
    (plugin as any).configureLifecycle();
    const recovery = runTask(plugin, "deferred", "recorder.recover");
    (plugin as any).isUnloading = true;
    exists.resolve(true);
    await recovery;
    expect(ensure).not.toHaveBeenCalled();
  });

  it("warns about retired credential files and hides the notice on unload", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const adapter = app.vault.adapter as any;
    const leftBehind = ".systemsculpt/retired-agent/auth.json";
    adapter.exists.mockImplementation(async (path: string) => path === ".systemsculpt" || path === leftBehind);
    adapter.list.mockResolvedValue({ files: [], folders: [".systemsculpt/retired-agent"] });
    adapter.write.mockResolvedValue(undefined);
    const hide = jest.fn();
    const notice = jest.spyOn(obsidian, "Notice").mockImplementation(() => ({ hide }) as any);
    const register = jest.spyOn(plugin, "register");

    await (plugin as any).checkLegacyCredentials();

    expect(notice).toHaveBeenCalledWith(expect.stringContaining(leftBehind), 0);
    const cleanup = register.mock.calls.at(-1)?.[0] as () => void;
    cleanup();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("shows no credential notice once the plugin is unloading", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const adapter = app.vault.adapter as any;
    adapter.exists.mockImplementation(async (path: string) => path === ".systemsculpt" || path === ".systemsculpt/auth.json");
    adapter.write.mockResolvedValue(undefined);
    const notice = jest.spyOn(obsidian, "Notice");
    (plugin as any).isUnloading = true;

    await (plugin as any).checkLegacyCredentials();

    expect(notice).not.toHaveBeenCalled();
  });

  it("runs layout tasks only after the critical phase has loaded settings", async () => {
    const app = new App();
    let layoutReady: (() => void) | null = null;
    (app.workspace as any).onLayoutReady = jest.fn((callback: () => void) => {
      layoutReady = callback;
    });
    const plugin = makePlugin(app);
    const runPhase = jest.fn(async () => undefined);
    const critical = deferred();
    (plugin as any).lifecycleCoordinator = { runPhase };
    (plugin as any).criticalInitializationPromise = critical.promise;

    (plugin as any).registerLayoutReadyHandler(0);
    layoutReady!();
    await settle();
    expect(runPhase).not.toHaveBeenCalled();

    critical.resolve();
    await settle();
    expect(runPhase).toHaveBeenCalledWith("layout");
  });

  it("skips layout tasks when the critical phase failed", async () => {
    const app = new App();
    let layoutReady: (() => void) | null = null;
    (app.workspace as any).onLayoutReady = jest.fn((callback: () => void) => {
      layoutReady = callback;
    });
    const plugin = makePlugin(app);
    const runPhase = jest.fn(async () => undefined);
    const critical = deferred();
    (plugin as any).lifecycleCoordinator = { runPhase };
    (plugin as any).criticalInitializationPromise = critical.promise;

    (plugin as any).registerLayoutReadyHandler(0);
    layoutReady!();
    critical.reject(new Error("critical failed"));
    await settle();

    expect(runPhase).not.toHaveBeenCalled();
    expect((plugin as any).failures).not.toContain("layout initialization");
  });

  it("keeps the diagnostics archive and its file checks off the load path", async () => {
    const app = new App();
    const plugin = makePlugin(app);
    const start = jest.spyOn(DiagnosticsSessionLifecycle.prototype, "start").mockResolvedValue(undefined);
    (plugin as any).configureLifecycle();

    await runTask(plugin, "bootstrap", "storage.prepare");
    expect(start).not.toHaveBeenCalled();
    expect((app.vault.adapter as any).exists).not.toHaveBeenCalled();

    // The first diagnostics write starts the archive before appending.
    const gate = (plugin.storage as any).diagnosticsWriteGate as () => Promise<void>;
    await gate();
    expect(start).toHaveBeenCalledTimes(1);

    start.mockClear();
    await runTask(plugin, "layout", "diagnostics.archive");
    expect(start).not.toHaveBeenCalled();
    runIdleCallbacks();
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("opens the semantic index only once the workspace is idle", async () => {
    const plugin = makePlugin();
    plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS, embeddingsEnabled: true };
    const awaitReady = jest.fn(async () => undefined);
    const getOrCreate = jest.spyOn(plugin, "getOrCreateEmbeddingsManager")
      .mockReturnValue({ awaitReady } as any);
    (plugin as any).configureLifecycle();

    const autostart = runTask(plugin, "layout", "embeddings.autostart");
    await settle();
    expect(getOrCreate).not.toHaveBeenCalled();

    runIdleCallbacks();
    await autostart;
    expect(getOrCreate).toHaveBeenCalledTimes(1);
    expect(awaitReady).toHaveBeenCalledTimes(1);
  });

  it("stays inert when unloaded before deferred startup work begins", async () => {
    const plugin = makePlugin();
    plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS, embeddingsEnabled: true };
    const getOrCreate = jest.spyOn(plugin, "getOrCreateEmbeddingsManager");
    const start = jest.spyOn(DiagnosticsSessionLifecycle.prototype, "start").mockResolvedValue(undefined);
    (plugin as any).configureLifecycle();

    const autostart = runTask(plugin, "layout", "embeddings.autostart");
    await runTask(plugin, "layout", "diagnostics.archive");
    (plugin as any).deferredStartup.abort();
    await autostart;
    runIdleCallbacks();
    await settle();

    expect(getOrCreate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(idleWindow.cancelIdleCallback).toHaveBeenCalledTimes(2);
  });
});
