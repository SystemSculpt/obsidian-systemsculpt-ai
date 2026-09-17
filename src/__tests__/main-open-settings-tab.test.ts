/** @jest-environment jsdom */

import { App } from "obsidian";
import SystemSculptPlugin from "../main";

function makePlugin(settingsApi: unknown) {
  const app = new App();
  Object.defineProperty(app, "setting", { configurable: true, value: settingsApi });
  const plugin = new SystemSculptPlugin(app, { id: "systemsculpt-ai", version: "1.0.0" } as any);
  return { plugin, trigger: jest.spyOn(app.workspace, "trigger") };
}

describe("SystemSculptPlugin.openSettingsTab", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("selects the plugin in a detached settings window without a main-window modal", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerWindow = frame.contentWindow!;
    const containerEl = ownerWindow.document.createElement("div");
    ownerWindow.document.body.appendChild(containerEl);
    const timer = jest.spyOn(ownerWindow, "setTimeout").mockImplementation((handler, delay) => window.setTimeout(handler, delay));
    const settingsApi = {
      activeTab: { id: "general", containerEl },
      open: jest.fn(),
      openTabById: jest.fn((id: string) => { settingsApi.activeTab = { id, containerEl }; }),
    };
    const { plugin, trigger } = makePlugin(settingsApi);

    plugin.openSettingsTab("providers");
    jest.runOnlyPendingTimers();

    expect(document.querySelector(".modal.mod-settings")).toBeNull();
    expect(settingsApi.open).not.toHaveBeenCalled();
    expect(settingsApi.openTabById).toHaveBeenCalledWith("systemsculpt-ai");
    expect(timer).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("systemsculpt:settings-focus-tab", "providers");
  });

  it("retries a legacy API that throws until settings finishes mounting", () => {
    let ready = false;
    const settingsApi = {
      activeTab: { id: "community-plugins" },
      open: jest.fn(() => { window.setTimeout(() => { ready = true; }, 50); }),
      openTabById: jest.fn((id: string) => {
        if (!ready) throw new Error("Settings not mounted yet");
        settingsApi.activeTab = { id };
      }),
    };
    const { plugin, trigger } = makePlugin(settingsApi);

    plugin.openSettingsTab("providers");

    expect(plugin.peekPendingSettingsFocusTab()).toBe("providers");
    expect(settingsApi.open).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    jest.runOnlyPendingTimers();
    expect(settingsApi.activeTab.id).toBe("systemsculpt-ai");
    expect(trigger).toHaveBeenCalledWith("systemsculpt:settings-focus-tab", "providers");
  });

  it("does not report focus before a no-op API has actually selected the plugin", () => {
    const settingsApi = {
      activeTab: { id: "general" },
      open: jest.fn(),
      openTabById: jest.fn(),
    };
    const { plugin, trigger } = makePlugin(settingsApi);

    plugin.openSettingsTab("providers");
    jest.advanceTimersByTime(100);
    expect(trigger).not.toHaveBeenCalled();
    settingsApi.activeTab = { id: "systemsculpt-ai" };
    jest.advanceTimersByTime(50);
    jest.runOnlyPendingTimers();
    expect(trigger).toHaveBeenCalledWith("systemsculpt:settings-focus-tab", "providers");
  });

  it("bounds retries when settings never becomes ready", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { plugin, trigger } = makePlugin(settingsApi);

    plugin.openSettingsTab("providers");
    jest.runAllTimers();

    expect(settingsApi.openTabById.mock.calls.length).toBeLessThanOrEqual(21);
    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels a superseded focus request", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { plugin, trigger } = makePlugin(settingsApi);
    plugin.openSettingsTab("providers");
    settingsApi.openTabById.mockImplementation((id: string) => { settingsApi.activeTab = { id }; });

    plugin.openSettingsTab("account");
    jest.runAllTimers();

    expect(trigger.mock.calls).toEqual([["systemsculpt:settings-focus-tab", "account"]]);
  });

  it("cancels pending retry timers when Obsidian disposes the plugin", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { plugin, trigger } = makePlugin(settingsApi);
    const cleanups: Array<() => void> = [];
    jest.spyOn(plugin, "register").mockImplementation((cleanup) => { cleanups.push(cleanup); });
    plugin.openSettingsTab("providers");
    const attempts = settingsApi.openTabById.mock.calls.length;
    expect(cleanups).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    cleanups.forEach((cleanup) => cleanup());
    expect(jest.getTimerCount()).toBe(0);
    jest.runAllTimers();

    expect(settingsApi.openTabById).toHaveBeenCalledTimes(attempts);
    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
