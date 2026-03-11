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

const SYSTEMSCULPT_SECONDARY_TITLES = ["Open Similar Notes Panel"];
const SYSTEMSCULPT_RIBBON_DIVIDER_CLASS = "ss-systemsculpt-ribbon-divider";

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

const getRibbonContainerChildren = (plugin: any): HTMLElement[] =>
  Array.from(plugin._ribbonActionsEl.children as HTMLCollectionOf<HTMLElement>);

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

  it("keeps the SystemSculpt ribbon cluster grouped at the very top in the curated order", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    seedCoreRibbonActions(plugin, ["Open quick switcher", "Open graph view", "Open command palette"]);
    manager.initialize();
    await flushAsyncWork();

    const titles = getRibbonTitles(plugin);
    expect(titles.slice(0, 7)).toEqual(SYSTEMSCULPT_TOP_TITLES);
    expect(
      titles.filter((title) => SYSTEMSCULPT_TOP_TITLES.includes(title))
    ).toEqual(SYSTEMSCULPT_TOP_TITLES);
    expect(titles[7]).toBe("Open quick switcher");
    expect(titles.slice(-1)).toEqual(SYSTEMSCULPT_SECONDARY_TITLES);
  });

  it("inserts a subtle divider between the SystemSculpt block and the rest of the ribbon", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    seedCoreRibbonActions(plugin, ["Open quick switcher", "Open graph view"]);
    manager.initialize();
    await flushAsyncWork();

    const containerChildren = getRibbonContainerChildren(plugin);
    expect(containerChildren[7]?.classList.contains(SYSTEMSCULPT_RIBBON_DIVIDER_CLASS)).toBe(true);
    expect(containerChildren[8]?.getAttribute("aria-label")).toBe("Open quick switcher");
  });

  it("keeps the SystemSculpt ribbon cluster topmost even when later ribbon actions are prepended", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    plugin.addRibbonIcon("sparkles", "Later Ribbon Action", jest.fn());
    await flushAsyncWork();

    const titles = getRibbonTitles(plugin);
    expect(titles.slice(0, 7)).toEqual(SYSTEMSCULPT_TOP_TITLES);
    expect(titles[7]).toBe("Later Ribbon Action");
    expect(titles.slice(-1)).toEqual(SYSTEMSCULPT_SECONDARY_TITLES);
  });

  it("does not add custom ribbon-branding classes to the top cluster", async () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    await flushAsyncWork();

    const ribbons = getRibbonElements(plugin);
    ribbons.slice(0, 7).forEach((ribbon) => {
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
