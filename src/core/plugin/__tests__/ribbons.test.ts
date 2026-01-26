import { App, Plugin } from "obsidian";
import { RibbonManager } from "../ribbons";

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

describe("RibbonManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers and cleans up ribbons", () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();

    const ribbons = (plugin as any)._ribbons;
    expect(ribbons).toHaveLength(7);

    const handles = [...ribbons];
    manager.cleanup();

    expect((plugin as any)._ribbons).toHaveLength(0);
    handles.forEach((ribbon) => {
      expect(ribbon.removed).toBe(true);
    });
  });

  it("does not register ribbons more than once", () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    manager.initialize();

    expect((plugin as any)._ribbons).toHaveLength(7);
  });

  it("prevents re-registering after cleanup", () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();
    manager.cleanup();
    manager.initialize();

    expect((plugin as any)._ribbons).toHaveLength(0);
  });

  it("removes ribbons when the plugin unloads", () => {
    const { app, plugin } = createPlugin();
    const manager = new RibbonManager(plugin, app);

    manager.initialize();

    const handles = [...(plugin as any)._ribbons];
    plugin.unload();

    expect((plugin as any)._ribbons).toHaveLength(0);
    handles.forEach((ribbon) => {
      expect(ribbon.removed).toBe(true);
    });
  });
});
