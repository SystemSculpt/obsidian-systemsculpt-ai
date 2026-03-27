/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";

describe("SystemSculptPlugin.initializeBasicUI", () => {
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
});
