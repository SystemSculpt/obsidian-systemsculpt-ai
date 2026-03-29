/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";

describe("SystemSculptPlugin.openSettingsTab", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("queues the requested tab before the settings modal finishes mounting", () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, {
      id: "systemsculpt-ai",
      version: "1.0.0",
    } as any);

    const open = jest.fn();
    const openTabById = jest.fn();
    Object.defineProperty(app, "setting", {
      configurable: true,
      value: {
        open,
        openTabById,
        activeTab: { id: "community-plugins" },
      },
    });

    const workspaceTriggerSpy = jest.spyOn(app.workspace, "trigger");

    plugin.openSettingsTab("providers");

    expect(plugin.peekPendingSettingsFocusTab()).toBe("providers");
    expect(open).toHaveBeenCalledTimes(1);
    expect(openTabById).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(openTabById).not.toHaveBeenCalled();
    expect(workspaceTriggerSpy).not.toHaveBeenCalled();
  });

  it("waits for the settings modal to mount before switching to the plugin tab", () => {
    const app = new App();
    const plugin = new SystemSculptPlugin(app, {
      id: "systemsculpt-ai",
      version: "1.0.0",
    } as any);

    let modalMounted = false;
    const settingsApi = {
      activeTab: { id: "community-plugins" as string },
      open: jest.fn(() => {
        window.setTimeout(() => {
          const modal = document.createElement("div");
          modal.className = "modal mod-settings";
          document.body.appendChild(modal);
          modalMounted = true;
        }, 50);
      }),
      openTabById: jest.fn((id: string) => {
        if (!modalMounted) {
          throw new Error("Settings modal not mounted yet");
        }
        settingsApi.activeTab = { id };
      }),
    };
    Object.defineProperty(app, "setting", {
      configurable: true,
      value: settingsApi,
    });

    const workspaceTriggerSpy = jest.spyOn(app.workspace, "trigger");

    plugin.openSettingsTab("providers");

    expect(settingsApi.open).toHaveBeenCalledTimes(1);
    expect(settingsApi.openTabById).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);
    expect(settingsApi.openTabById).toHaveBeenCalledWith("systemsculpt-ai");

    jest.runOnlyPendingTimers();

    expect(workspaceTriggerSpy).toHaveBeenCalledWith(
      "systemsculpt:settings-focus-tab",
      "providers",
    );
  });
});
