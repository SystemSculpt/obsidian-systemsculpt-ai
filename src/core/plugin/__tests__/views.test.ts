/** @jest-environment jsdom */

import { App, Platform, Plugin } from "obsidian";
import { ViewManager } from "../views";
import {
  CHAT_VIEW_TYPE,
  EMBEDDINGS_VIEW_TYPE,
  SYSTEMSCULPT_STUDIO_VIEW_TYPE,
} from "../viewTypes";

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
    (Platform as typeof Platform & { isDesktopApp: boolean; isMobile?: boolean }).isDesktopApp = true;
    (Platform as typeof Platform & { isMobile?: boolean }).isMobile = false;
    document.body.classList.remove("is-mobile");
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

  it("opens Similar Notes in the desktop right sidebar", async () => {
    const { app, manager } = createFixture();
    const leaf = {
      setViewState: jest.fn().mockResolvedValue(undefined),
      view: { kind: "embeddings" },
    } as any;
    const getRightLeaf = jest.fn(() => leaf);
    const getLeaf = jest.fn();
    const revealLeaf = jest.fn();
    Object.assign(app.workspace, { getRightLeaf, getLeaf, revealLeaf });

    await manager.activateEmbeddingsView();

    expect(getRightLeaf).toHaveBeenCalledWith(false);
    expect(getLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: EMBEDDINGS_VIEW_TYPE,
      active: true,
    });
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it("opens Similar Notes as a full-width tab in mobile layout", async () => {
    const { app, manager } = createFixture();
    const leaf = {
      setViewState: jest.fn().mockResolvedValue(undefined),
      view: { kind: "embeddings" },
    } as any;
    const getRightLeaf = jest.fn();
    const getLeaf = jest.fn(() => leaf);
    const revealLeaf = jest.fn();
    Object.assign(app.workspace, { getRightLeaf, getLeaf, revealLeaf });
    document.body.classList.add("is-mobile");

    await manager.activateEmbeddingsView();

    expect(getLeaf).toHaveBeenCalledWith("tab");
    expect(getRightLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: EMBEDDINGS_VIEW_TYPE,
      active: true,
    });
    expect(revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it("awaits every ChatView producer barrier and isolates individual failures", async () => {
    const { app, manager } = createFixture();
    let finishSlowClose!: () => void;
    const slowClose = new Promise<void>((resolve) => {
      finishSlowClose = resolve;
    });
    const slowQuiesce = jest.fn(() => slowClose);
    const rejectedQuiesce = jest.fn(async () => {
      throw new Error("simulated stale ChatView close failure");
    });
    jest.spyOn(app.workspace, "getLeavesOfType").mockReturnValue([
      { view: { quiesceIncidentProducers: slowQuiesce } },
      { view: { quiesceIncidentProducers: rejectedQuiesce } },
      { view: {} },
    ] as any);

    let settled = false;
    const quiescing = manager.quiesceChatViewProducers().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(slowQuiesce).toHaveBeenCalledTimes(1);
    expect(rejectedQuiesce).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    finishSlowClose();
    await expect(quiescing).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("bounds a ChatView whose failed-receipt write never settles", async () => {
    const { app, manager } = createFixture();
    const failedReceiptWrite = new Promise<void>(() => undefined);
    const hungQuiesce = jest.fn(async () => {
      await failedReceiptWrite;
    });
    jest.spyOn(app.workspace, "getLeavesOfType").mockReturnValue([
      { view: { quiesceIncidentProducers: hungQuiesce } },
    ] as any);

    let settled = false;
    const quiescing = manager.quiesceChatViewProducers().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(hungQuiesce).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    jest.advanceTimersByTime(999);
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(quiescing).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps normal view and ribbon teardown after producer quiescence", () => {
    const { app, manager } = createFixture();
    const detachLeavesOfType = jest.fn();
    Object.assign(app.workspace, { detachLeavesOfType });
    const cleanup = jest.spyOn((manager as any).ribbonManager, "cleanup");

    manager.unloadViews();

    expect(detachLeavesOfType.mock.calls).toEqual([
      [CHAT_VIEW_TYPE],
      [EMBEDDINGS_VIEW_TYPE],
      [SYSTEMSCULPT_STUDIO_VIEW_TYPE],
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
