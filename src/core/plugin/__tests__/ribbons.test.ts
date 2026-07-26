/** @jest-environment jsdom */

import { App, Plugin } from "obsidian";
import { RibbonManager } from "../ribbons";

const audioProcessorOpenMock = jest.fn();
const audioProcessorModalMock = jest.fn().mockImplementation(() => ({
  open: audioProcessorOpenMock,
}));
const audioProcessorResumeMock = jest.fn().mockResolvedValue(undefined);
const audioProcessorAvailabilityMock = jest.fn().mockResolvedValue(true);

jest.mock("../../../features/audio-processor", () => ({
  AudioProcessorModal: audioProcessorModalMock,
  canOpenAudioProcessor: audioProcessorAvailabilityMock,
  resumeAudioProcessorJobs: audioProcessorResumeMock,
}));

const SYSTEMSCULPT_TOP_TITLES = [
  "Audio Recorder",
  "Open Audio Processor",
  "Open search",
  "Open janitor",
  "Open history",
  "Open chat",
];

const createPlugin = () => {
  const app = new App();
  const plugin = new Plugin(app, { id: "systemsculpt", version: "0.0.0" }) as any;
  plugin.settings = { selectedModelId: "model" };
  plugin.getViewManager = jest.fn(() => ({
    activateEmbeddingsView: jest.fn().mockResolvedValue(undefined),
  }));
  plugin.load();
  return { app, plugin };
};

const getRibbonElements = (plugin: any): HTMLElement[] =>
  Array.from(plugin._ribbons as HTMLElement[]);

const getRibbonTitles = (plugin: any): string[] =>
  getRibbonElements(plugin).map((ribbon) => ribbon.getAttribute("aria-label") || ribbon.title || "");

const seedCoreRibbonActions = (plugin: any, titles: string[]) => {
  titles.forEach((title) => {
    const ribbon = document.createElement("div");
    ribbon.className = "clickable-icon side-dock-ribbon-action";
    ribbon.setAttribute("aria-label", title);
    ribbon.title = title;
    plugin._ribbonActionsEl.append(ribbon);
  });
};

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("RibbonManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    audioProcessorAvailabilityMock.mockResolvedValue(true);
  });

  it("registers and cleans up ribbons", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const ribbons = getRibbonElements(plugin);
    expect(ribbons).toHaveLength(7);

    const handles = [...ribbons];
    manager.cleanup();

    expect(getRibbonElements(plugin)).toHaveLength(0);
    handles.forEach((ribbon) => {
      expect(ribbon.isConnected).toBe(false);
    });
  });

  it("does not register ribbons more than once", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    manager.initialize();
    await flushAsyncWork();

    expect(getRibbonElements(plugin)).toHaveLength(7);
  });

  it("opens Audio Processor through the native ribbon action", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const audioProcessorRibbon = getRibbonElements(plugin).find(
      (ribbon) => ribbon.getAttribute("aria-label") === "Open Audio Processor",
    );
    expect(audioProcessorRibbon).toBeDefined();

    await (audioProcessorRibbon as HTMLElement & { callback: () => Promise<void> }).callback();
    await flushAsyncWork();

    expect(audioProcessorAvailabilityMock).toHaveBeenCalledWith(plugin);
    expect(audioProcessorResumeMock).toHaveBeenCalledWith(plugin, {
      notifyOnDiscoveryFailure: true,
    });
    expect(audioProcessorModalMock).toHaveBeenCalledWith(plugin, {
      initialTab: "audio",
    });
    expect(audioProcessorOpenMock).toHaveBeenCalledTimes(1);
  });

  it("registers the expected SystemSculpt ribbon actions without removing native ribbons", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    seedCoreRibbonActions(plugin, ["Open quick switcher", "Open graph view", "Open command palette"]);
    manager.initialize();
    await flushAsyncWork();

    const titles = getRibbonTitles(plugin);
    expect(titles).toEqual(expect.arrayContaining(SYSTEMSCULPT_TOP_TITLES));
    expect(titles).toContain("Open Similar Notes Panel");
    expect(titles).toContain("Open quick switcher");
    expect(titles).toContain("Open graph view");
    expect(titles).toContain("Open command palette");
  });

  it("does not inject a divider into the ribbon container", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    seedCoreRibbonActions(plugin, ["Open quick switcher", "Open graph view"]);
    manager.initialize();
    await flushAsyncWork();

    expect(
      plugin._ribbonActionsEl.querySelector(".ss-systemsculpt-ribbon-divider")
    ).toBeNull();
  });

  it("leaves later ribbon actions untouched", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    plugin.addRibbonIcon("sparkles", "Later Ribbon Action", jest.fn());
    await flushAsyncWork();

    const titles = getRibbonTitles(plugin);
    expect(titles).toContain("Later Ribbon Action");
    expect(titles).toEqual(expect.arrayContaining(SYSTEMSCULPT_TOP_TITLES));
    expect(titles).toContain("Open Similar Notes Panel");
  });

  it("does not add custom ribbon-branding classes to SystemSculpt ribbons", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const ribbons = getRibbonElements(plugin);
    ribbons.forEach((ribbon) => {
      expect(ribbon.className).not.toContain("ss-systemsculpt-ribbon-action");
      expect(ribbon.dataset.ssRibbonGroup).toBeUndefined();
    });
  });

  it("prevents re-registering after cleanup", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();
    manager.cleanup();
    manager.initialize();

    expect(getRibbonElements(plugin)).toHaveLength(0);
  });

  it("removes ribbons when the plugin unloads", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const handles = [...getRibbonElements(plugin)];
    plugin.unload();

    expect(getRibbonElements(plugin)).toHaveLength(0);
    handles.forEach((ribbon) => {
      expect(ribbon.isConnected).toBe(false);
    });
  });

  // #134/#214: ribbon init is deferred (a setTimeout in ViewManager), so the
  // queued callback can fire after onunload flips the unloading flag. The guard
  // must keep that late init from re-adding icons to a disabled plugin.
  it("does not register ribbons when the plugin is already unloading (#134)", async () => {
    const { app, plugin } = createPlugin();
    plugin.isPluginUnloading = jest.fn(() => true);
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    expect(plugin.isPluginUnloading).toHaveBeenCalled();
    expect(getRibbonElements(plugin)).toHaveLength(0);
  });
});
