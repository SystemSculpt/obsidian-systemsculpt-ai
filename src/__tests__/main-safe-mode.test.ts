/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { AudioTranscriptionPanel } from "../modals/AudioTranscriptionPanel";
import { FreezeMonitor } from "../services/FreezeMonitor";

const createTracer = () => ({
  startPhase: jest.fn(() => ({ complete: jest.fn(), fail: jest.fn() })),
  markMilestone: jest.fn(),
  flushOpenPhases: jest.fn(),
});

const createLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setLogFileName: jest.fn(),
  flushBeforeUnload: jest.fn(async () => undefined),
  dispose: jest.fn(),
});

function makePlugin(): any {
  const app = new App();
  (app as any).vault = { configDir: ".obsidian", adapter: {} };
  const plugin = new SystemSculptPlugin(app, {
    id: "systemsculpt-ai",
    version: "1.0.0",
  } as any);
  jest.spyOn(plugin as any, "getInitializationTracer").mockReturnValue(createTracer());
  jest.spyOn(plugin, "getLogger").mockReturnValue(createLogger() as any);
  return plugin;
}

describe("SystemSculptPlugin safe mode + version gate (#212)", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("enterSafeMode flips the flag and registers a single recovery command (idempotent)", () => {
    const plugin = makePlugin();

    plugin.enterSafeMode("core initialization failed");

    expect(plugin.safeMode).toBe(true);
    const recovery = plugin._commands.filter(
      (c: { id: string }) => c.id === "systemsculpt-show-load-diagnostics"
    );
    expect(recovery).toHaveLength(1);
    expect(recovery[0].name).toMatch(/safe mode/i);

    // A second fatal report must not double-register the command.
    plugin.enterSafeMode("again");
    expect(
      plugin._commands.filter((c: { id: string }) => c.id === "systemsculpt-show-load-diagnostics")
    ).toHaveLength(1);
  });

  it("does not flag a supported Obsidian version (fail-soft no-op)", () => {
    const plugin = makePlugin();
    jest.spyOn(plugin, "getObsidianApiVersion").mockReturnValue("1.7.2");
    plugin.warnIfObsidianVersionUnsupported();
    expect(plugin.failures).not.toContain("unsupported Obsidian version");
  });

  it("flags an unsupported Obsidian version, failing soft without throwing (#212/#147)", () => {
    const plugin = makePlugin();
    jest.spyOn(plugin, "getObsidianApiVersion").mockReturnValue("1.0.0");

    expect(() => plugin.warnIfObsidianVersionUnsupported()).not.toThrow();
    expect(plugin.failures).toContain("unsupported Obsidian version");
  });

  it("onload enters safe mode (and never rethrows) when core initialization throws (#183)", async () => {
    const plugin = makePlugin();
    const debug = jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(plugin as any, "configureLifecycle").mockImplementation(() => {
      throw new Error("simulated fatal init failure");
    });

    // Must resolve, not reject — a fatal init can never bubble to Obsidian's
    // "Failed to load plugin"; it degrades to safe mode instead.
    await expect(plugin.onload()).resolves.toBeUndefined();

    expect(plugin.safeMode).toBe(true);
    expect(plugin._commands.map((c: { id: string }) => c.id)).toContain(
      "systemsculpt-show-load-diagnostics"
    );
    expect(debug).toHaveBeenCalledWith("[SystemSculpt] v1.0.0 build dev");
  });

  it("stops recorder capture before any fallible service teardown", async () => {
    const plugin = makePlugin();
    const order: string[] = [];
    (plugin as any).recorderService = {
      unload: jest.fn(() => { order.push("recorder"); }),
    };
    (plugin as any).settingsManager = {
      destroy: jest.fn(() => {
        order.push("settings");
        throw new Error("simulated settings teardown failure");
      }),
    };

    await expect(plugin.onunload()).resolves.toBeUndefined();

    expect(order).toEqual(["recorder", "settings"]);
    expect((plugin as any).recorderService).toBeNull();
  });

  it("bounds incident persistence drain while its accepted write continues best-effort", async () => {
    jest.useFakeTimers();
    const plugin = makePlugin();
    const order: string[] = [];
    const persisted = jest.fn();
    let finishDrain!: () => void;
    const closeAdmissionAndDrain = jest.fn(() => new Promise<void>((resolve) => {
      finishDrain = () => {
        persisted();
        resolve();
      };
    }));
    (plugin as any).agentIncidentCoordinator = { closeAdmissionAndDrain };
    (plugin as any).recorderService = {
      unload: jest.fn(() => { order.push("recorder"); }),
    };
    (plugin as any).viewManager = {
      quiesceChatViewProducers: jest.fn(async () => undefined),
      unloadViews: jest.fn(() => { order.push("views"); }),
    };

    const unloading = plugin.onunload();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeAdmissionAndDrain).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["recorder", "views"]);

    jest.advanceTimersByTime(1_999);
    await Promise.resolve();
    expect(order).toEqual(["recorder", "views"]);

    jest.advanceTimersByTime(1);
    await unloading;
    expect(order).toEqual(["recorder", "views"]);
    expect((plugin as any).agentIncidentCoordinator).toBeNull();
    expect(persisted).not.toHaveBeenCalled();

    finishDrain();
    await Promise.resolve();
    await Promise.resolve();
    expect(persisted).toHaveBeenCalledTimes(1);
  });

  it("allows the coordinator drain to use its normal bounded persistence window", async () => {
    jest.useFakeTimers();
    const plugin = makePlugin();
    const order: string[] = [];
    const closeAdmissionAndDrain = jest.fn(() => new Promise<void>((resolve) => {
      window.setTimeout(() => {
        order.push("incident-drained");
        resolve();
      }, 1_500);
    }));
    (plugin as any).agentIncidentCoordinator = { closeAdmissionAndDrain };
    (plugin as any).recorderService = {
      unload: jest.fn(() => { order.push("recorder"); }),
    };
    (plugin as any).viewManager = {
      quiesceChatViewProducers: jest.fn(async () => undefined),
      unloadViews: jest.fn(() => { order.push("views"); }),
    };

    const unloading = plugin.onunload();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1_499);
    await Promise.resolve();
    expect(order).toEqual(["recorder", "views"]);

    jest.advanceTimersByTime(1);
    await unloading;
    expect(order).toEqual(["recorder", "views", "incident-drained"]);
    expect(closeAdmissionAndDrain).toHaveBeenCalledTimes(1);
    expect((plugin as any).agentIncidentCoordinator).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("awaits ChatView producer quiescence before closing incident admission", async () => {
    const plugin = makePlugin();
    const order: string[] = [];
    let admissionOpen = true;
    const acceptedFailures: string[] = [];
    let finishChatClose!: () => void;
    const chatClose = new Promise<void>((resolve) => {
      finishChatClose = resolve;
    });
    const closeAdmissionAndDrain = jest.fn(async () => {
      order.push("incident-admission-closed");
      admissionOpen = false;
    });
    (plugin as any).agentIncidentCoordinator = { closeAdmissionAndDrain };
    (plugin as any).recorderService = {
      unload: jest.fn(() => { order.push("recorder"); }),
    };
    (plugin as any).viewManager = {
      quiesceChatViewProducers: jest.fn(async () => {
        order.push("chat-session-stopping");
        await chatClose;
        order.push("chat-session-stopped");
        if (admissionOpen) acceptedFailures.push("terminal-failure");
      }),
      unloadViews: jest.fn(() => {
        order.push("views-detached");
        throw new Error("simulated stale view teardown failure");
      }),
    };

    const unloading = plugin.onunload();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["recorder", "chat-session-stopping"]);
    expect(closeAdmissionAndDrain).not.toHaveBeenCalled();

    finishChatClose();
    await expect(unloading).resolves.toBeUndefined();

    expect(order.slice(0, 5)).toEqual([
      "recorder",
      "chat-session-stopping",
      "chat-session-stopped",
      "views-detached",
      "incident-admission-closed",
    ]);
    expect(acceptedFailures).toEqual(["terminal-failure"]);
    expect(closeAdmissionAndDrain).toHaveBeenCalledTimes(1);
    expect((plugin as any).viewManager).toBeNull();
    expect((plugin as any).agentIncidentCoordinator).toBeNull();
  });

  it("flushes and disposes diagnostics before the unload guard flips", async () => {
    const plugin = makePlugin();
    const order: string[] = [];
    jest.spyOn(FreezeMonitor, "stop").mockImplementation(() => {
      order.push("freeze-monitor");
      throw new Error("simulated monitor stop failure");
    });
    const logger = createLogger();
    logger.flushBeforeUnload.mockImplementation(async () => {
      expect(plugin.isPluginUnloading()).toBe(false);
      order.push("flush");
    });
    logger.dispose.mockImplementation(() => {
      expect(plugin.isPluginUnloading()).toBe(false);
      order.push("dispose");
    });
    (plugin as any).pluginLogger = logger;
    jest.spyOn(plugin, "getLogger").mockReturnValue(logger as any);
    (plugin as any).recorderService = {
      unload: jest.fn(() => {
        expect(plugin.isPluginUnloading()).toBe(false);
        order.push("recorder");
      }),
    };

    await expect(plugin.onunload()).resolves.toBeUndefined();

    expect(logger.flushBeforeUnload).toHaveBeenCalledTimes(1);
    expect(logger.dispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["recorder", "freeze-monitor", "flush", "dispose"]);
    expect(plugin.isPluginUnloading()).toBe(true);
  });

  it("disposes owned transcription panels before transcription service unload", async () => {
    const plugin = makePlugin();
    const order: string[] = [];
    const disposePanels = jest
      .spyOn(AudioTranscriptionPanel, "disposeOwnedBy")
      .mockImplementation((owner) => {
        expect(owner).toBe(plugin);
        order.push("panels");
      });
    (plugin as any).transcriptionService = {
      unload: jest.fn(() => { order.push("transcription"); }),
    };

    await expect(plugin.onunload()).resolves.toBeUndefined();

    expect(disposePanels).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["panels", "transcription"]);
  });
});
