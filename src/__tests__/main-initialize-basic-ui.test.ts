/** @jest-environment jsdom */

import { App, Platform } from "obsidian";
import SystemSculptPlugin from "../main";
import { DEFAULT_SETTINGS } from "../types";

function pluginReadyForBasicUi(app: App): SystemSculptPlugin {
  const plugin = new SystemSculptPlugin(app, {
    id: "systemsculpt-ai",
    version: "1.0.0",
  } as any);
  plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS };
  (plugin as any).directoryManager = { isInitialized: () => true };
  return plugin;
}

describe("SystemSculptPlugin.initializeBasicUI", () => {
  afterEach(() => {
    (Platform as any).isDesktop = true;
  });

  it("skips UI initialization after unload has started", async () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, {
      id: "systemsculpt-ai",
      version: "1.0.0",
    } as any);

    const addStatusBarItemSpy = jest.spyOn(plugin, "addStatusBarItem");
    (plugin as any).isUnloading = true;

    await (plugin as any).initializeBasicUI();

    expect(addStatusBarItemSpy).not.toHaveBeenCalled();
    expect(plugin.embeddingsStatusBar).toBeNull();
  });

  it("mounts the semantic index status item in Obsidian desktop", async () => {
    const app = new App();
    const plugin = pluginReadyForBasicUi(app);
    const addStatusBarItemSpy = jest.spyOn(plugin, "addStatusBarItem");
    (Platform as any).isDesktop = true;

    await (plugin as any).initializeBasicUI();

    expect(addStatusBarItemSpy).toHaveBeenCalledTimes(1);
    expect(plugin.embeddingsStatusBar).not.toBeNull();
    plugin.removeChild(plugin.embeddingsStatusBar!);
    plugin.embeddingsStatusBar = null;
  });

  it("does not invoke the desktop-only status bar API in Obsidian mobile", async () => {
    const app = new App();
    const plugin = pluginReadyForBasicUi(app);
    const addStatusBarItemSpy = jest.spyOn(plugin, "addStatusBarItem");
    (Platform as any).isDesktop = false;

    await (plugin as any).initializeBasicUI();

    expect(addStatusBarItemSpy).not.toHaveBeenCalled();
    expect(plugin.embeddingsStatusBar).toBeNull();
  });
});
