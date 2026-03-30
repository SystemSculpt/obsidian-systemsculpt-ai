/** @jest-environment jsdom */

import { App, Plugin } from "obsidian";
import { ViewManager } from "../views";
import {
  CHAT_VIEW_TYPE,
  EMBEDDINGS_VIEW_TYPE,
  SYSTEMSCULPT_STUDIO_VIEW_TYPE,
} from "../viewTypes";

jest.mock("../../../services/PlatformContext", () => ({
  PlatformContext: {
    get: () => ({
      supportsDesktopOnlyFeatures: () => true,
    }),
  },
}));

type TestApp = App & {
  viewRegistry?: {
    viewByType: Record<string, unknown>;
  };
};

type ViewManagerFixture = {
  app: TestApp;
  plugin: Plugin;
  manager: ViewManager;
};

const fixtures: ViewManagerFixture[] = [];

const createFixture = (registeredViewTypes: string[] = []): ViewManagerFixture => {
  const app = new App() as TestApp;
  app.viewRegistry = {
    viewByType: Object.fromEntries(registeredViewTypes.map((type) => [type, jest.fn()])),
  };

  const plugin = new Plugin(app, { id: "systemsculpt-ai", version: "0.0.0" }) as any;
  plugin.settings = { selectedModelId: "model" };
  plugin.load();

  const fixture = {
    app,
    plugin,
    manager: new ViewManager(plugin, app),
  };

  fixtures.push(fixture);
  return fixture;
};

describe("ViewManager", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    fixtures.splice(0).forEach(({ plugin }) => plugin.unload());
    jest.useRealTimers();
  });

  it("does not register views more than once when initialize is called repeatedly", () => {
    const { plugin, manager } = createFixture();
    const registerViewSpy = jest.spyOn(plugin, "registerView");

    manager.initialize();
    manager.initialize();

    expect(registerViewSpy).toHaveBeenCalledTimes(3);
  });

  it("replaces stale view types that are already present in Obsidian's view registry", () => {
    const { app, plugin, manager } = createFixture([
      CHAT_VIEW_TYPE,
      SYSTEMSCULPT_STUDIO_VIEW_TYPE,
    ]);
    const originalChatCreator = app.viewRegistry?.viewByType[CHAT_VIEW_TYPE];
    const originalStudioCreator = app.viewRegistry?.viewByType[SYSTEMSCULPT_STUDIO_VIEW_TYPE];
    const registerViewSpy = jest.spyOn(plugin, "registerView").mockImplementation((type, creator) => {
      if (!app.viewRegistry) {
        app.viewRegistry = { viewByType: {} };
      }
      app.viewRegistry.viewByType[type] = creator;
    });

    manager.registerView();

    expect(registerViewSpy).toHaveBeenCalledTimes(3);
    expect(app.viewRegistry?.viewByType[CHAT_VIEW_TYPE]).not.toBe(originalChatCreator);
    expect(app.viewRegistry?.viewByType[SYSTEMSCULPT_STUDIO_VIEW_TYPE]).not.toBe(originalStudioCreator);
    expect(app.viewRegistry?.viewByType[EMBEDDINGS_VIEW_TYPE]).toEqual(expect.any(Function));
  });
});
