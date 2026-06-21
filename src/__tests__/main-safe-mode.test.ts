/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";

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
  afterEach(() => jest.restoreAllMocks());

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
    // The obsidian mock reports apiVersion 1.5.0 (>= minimum).
    plugin.warnIfObsidianVersionUnsupported();
    expect(plugin.failures).not.toContain("unsupported Obsidian version");
  });

  it("onload enters safe mode (and never rethrows) when core initialization throws (#183)", async () => {
    const plugin = makePlugin();
    jest.spyOn(plugin as any, "writeMobileStartupProbe").mockResolvedValue(undefined);
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
  });
});
