/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { DiagnosticsSessionLifecycle } from "../core/diagnostics/DiagnosticsSessionLifecycle";
import { DEFAULT_SETTINGS } from "../types";

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
  const idleWindow = window as Window & { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };
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

  it("starts update checks after layout-ready instead of in the critical phase", () => {
    const plugin = makePlugin();

    (plugin as any).configureLifecycle();

    expect(registeredTaskIds(plugin, "critical")).not.toContain("updates.start");
    expect(registeredTaskIds(plugin, "layout")).toContain("updates.start");
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
    jest.spyOn(plugin as any, "maybeShowAccountOnboarding").mockImplementation(() => undefined);

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
