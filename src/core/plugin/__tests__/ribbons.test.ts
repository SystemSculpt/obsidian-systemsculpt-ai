/** @jest-environment jsdom */

import { App, Plugin } from "obsidian";
import { RibbonManager } from "../ribbons";

const SYSTEMSCULPT_TOP_TITLES = [
  "YouTube Canvas",
  "Process Meeting Audio",
  "Audio Recorder",
  "Open SystemSculpt Search",
  "Open SystemSculpt Janitor",
  "Open SystemSculpt History",
  "Open SystemSculpt Chat",
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
  });

  it("registers and cleans up ribbons", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const ribbons = getRibbonElements(plugin);
    expect(ribbons).toHaveLength(8);

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

    expect(getRibbonElements(plugin)).toHaveLength(8);
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
});
