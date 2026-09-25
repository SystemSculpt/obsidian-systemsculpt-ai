/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";

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

describe("SystemSculptPlugin startup phases", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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
});
