/** @jest-environment jsdom */

import SystemSculptPlugin from "../main";
import { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../types";
import { SystemSculptService } from "../services/SystemSculptService";

jest.mock("../services/SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({})),
  },
}));

describe("SystemSculptPlugin settings tab registration", () => {
  it("registers the settings tab once even when invoked multiple times", () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, { id: "systemsculpt", version: "1.0.0" } as any);
    plugin._internal_settings_systemsculpt_plugin = { ...DEFAULT_SETTINGS };

    const addSpy = jest.spyOn(plugin, "addSettingTab");

    (plugin as any).ensureSettingsTab();
    (plugin as any).ensureSettingsTab();

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect((plugin as any)._settingTabs).toHaveLength(1);
    expect(SystemSculptService.getInstance).not.toHaveBeenCalled();
  });
});
