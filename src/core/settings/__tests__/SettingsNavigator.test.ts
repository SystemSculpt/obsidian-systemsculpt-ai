/** @jest-environment jsdom */

import { SettingsNavigator, type SettingsNavigationApi, type SettingsNavigatorOptions } from "../SettingsNavigator";

function makeNavigator(settingsApi: SettingsNavigationApi | undefined, overrides: Partial<SettingsNavigatorOptions> = {}) {
  const trigger = jest.fn();
  const cleanups: Array<() => void> = [];
  const navigator = new SettingsNavigator({
    pluginId: "systemsculpt-ai",
    getSettingsApi: () => settingsApi,
    getSettingsContainer: () => undefined,
    isUnloading: () => false,
    registerCleanup: (cleanup) => { cleanups.push(cleanup); },
    triggerFocus: (tab) => trigger("systemsculpt:settings-focus-tab", tab),
    ...overrides,
  });
  return { navigator, trigger, cleanups };
}

describe("SettingsNavigator.openSettingsTab", () => {
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
    const { navigator, trigger } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");
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
    const { navigator, trigger } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");

    expect(navigator.peekPendingSettingsFocusTab()).toBe("providers");
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
    const { navigator, trigger } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");
    jest.advanceTimersByTime(100);
    expect(trigger).not.toHaveBeenCalled();
    settingsApi.activeTab = { id: "systemsculpt-ai" };
    jest.advanceTimersByTime(50);
    jest.runOnlyPendingTimers();
    expect(trigger).toHaveBeenCalledWith("systemsculpt:settings-focus-tab", "providers");
  });

  it("bounds retries when settings never becomes ready", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");
    jest.runAllTimers();

    expect(settingsApi.openTabById.mock.calls.length).toBeLessThanOrEqual(21);
    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels a superseded focus request", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger } = makeNavigator(settingsApi);
    navigator.openSettingsTab("providers");
    settingsApi.openTabById.mockImplementation((id: string) => { settingsApi.activeTab = { id }; });

    navigator.openSettingsTab("account");
    jest.runAllTimers();

    expect(trigger.mock.calls).toEqual([["systemsculpt:settings-focus-tab", "account"]]);
  });

  it("cancels pending retry timers when Obsidian disposes the plugin", () => {
    const settingsApi = { activeTab: { id: "general" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger, cleanups } = makeNavigator(settingsApi);
    navigator.openSettingsTab("providers");
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

  it("keeps the normalized focus request until it is explicitly consumed or cleared", () => {
    const settingsApi = { activeTab: { id: "systemsculpt-ai" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator } = makeNavigator(settingsApi);
    expect(navigator.peekPendingSettingsFocusTab()).toBeNull();

    navigator.openSettingsTab("  custom-tab  ");
    expect(navigator.peekPendingSettingsFocusTab()).toBe("custom-tab");
    jest.runAllTimers();
    expect(navigator.peekPendingSettingsFocusTab()).toBe("custom-tab");
    navigator.clearPendingSettingsFocusTab("different-tab");
    expect(navigator.peekPendingSettingsFocusTab()).toBe("custom-tab");
    navigator.clearPendingSettingsFocusTab(" custom-tab ");
    expect(navigator.peekPendingSettingsFocusTab()).toBeNull();

    navigator.openSettingsTab("   ");
    expect(navigator.consumePendingSettingsFocusTab()).toBe("account");
    expect(navigator.consumePendingSettingsFocusTab()).toBeNull();
    navigator.openSettingsTab();
    navigator.clearPendingSettingsFocusTab();
    expect(navigator.peekPendingSettingsFocusTab()).toBeNull();
  });

  it("defers focus and rechecks the selected tab before dispatch", () => {
    const settingsApi = { activeTab: { id: "systemsculpt-ai" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");
    expect(trigger).not.toHaveBeenCalled();
    settingsApi.activeTab = { id: "general" };
    jest.runAllTimers();

    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("registers cleanup once and cancels the latest request through its owner window", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerWindow = frame.contentWindow!;
    const containerEl = ownerWindow.document.createElement("div");
    ownerWindow.document.body.appendChild(containerEl);
    jest.spyOn(ownerWindow, "setTimeout").mockImplementation((handler, delay) => window.setTimeout(handler, delay));
    const clearTimer = jest.spyOn(ownerWindow, "clearTimeout").mockImplementation((id) => window.clearTimeout(id));
    const settingsApi = { activeTab: { id: "general", containerEl }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger, cleanups } = makeNavigator(settingsApi);

    navigator.openSettingsTab("providers");
    navigator.openSettingsTab("account");
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(cleanups).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    cleanups[0]();
    expect(clearTimer).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    jest.runAllTimers();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("uses the settings container's window when the host has no active tab container", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerWindow = frame.contentWindow!;
    const containerEl = ownerWindow.document.createElement("div");
    ownerWindow.document.body.appendChild(containerEl);
    const timer = jest.spyOn(ownerWindow, "setTimeout").mockImplementation((handler, delay) => window.setTimeout(handler, delay));
    const settingsApi = { activeTab: { id: "systemsculpt-ai" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger } = makeNavigator(settingsApi, { getSettingsContainer: () => containerEl });

    navigator.openSettingsTab("account");
    jest.runAllTimers();

    expect(timer).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("systemsculpt:settings-focus-tab", "account");
  });

  it("does not dispatch focus or retry after unload begins", () => {
    let unloading = false;
    const settingsApi = { activeTab: { id: "systemsculpt-ai" }, open: jest.fn(), openTabById: jest.fn() };
    const { navigator, trigger } = makeNavigator(settingsApi, { isUnloading: () => unloading });
    navigator.openSettingsTab("providers");
    unloading = true;

    jest.runAllTimers();

    expect(trigger).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([undefined, { open: () => { throw new Error("Settings unavailable"); }, openTabById: () => undefined }])(
    "keeps pending focus and shows the notice fallback when settings cannot open (%p)",
    (settingsApi) => {
      const notice = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const { navigator, trigger } = makeNavigator(settingsApi);

      expect(() => navigator.openSettingsTab("account")).not.toThrow();

      expect(navigator.peekPendingSettingsFocusTab()).toBe("account");
      expect(notice).toHaveBeenCalledWith("Notice: Open SystemSculpt AI settings to manage your account and plugin preferences.");
      expect(trigger).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
