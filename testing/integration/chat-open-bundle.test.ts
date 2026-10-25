/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
import { App, Menu, Platform, TFile, WorkspaceLeaf, requestUrl } from "obsidian";
import { hostRequest } from "./host-request";
import { captureStartupIdentity, expectProductionStartupIdentity } from "./startup-identity-assertions";

const BUNDLE_PATH = path.resolve(__dirname, "../../main.js");
const CHAT_VIEW_TYPE = "systemsculpt-chat-view";

function hostResponse(payload: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(payload),
    json: payload,
    arrayBuffer: new ArrayBuffer(0),
  };
}

describe.each(["desktop", "mobile"])("chat-open entry points in the built bundle (%s)", (host) => {
  const originalPlatform = { ...Platform };
  let plugin: any;
  let app: App;
  let leaves: any[];
  let openedViews: any[];
  let factory: jest.Mock;
  let creditsRequests: string[];
  let unexpectedRequests: string[];
  let file: TFile;
  const originalHas = Object.getOwnPropertyDescriptor(Headers.prototype, "has");

  beforeAll(() => {
    if (!originalHas) {
      Object.defineProperty(Headers.prototype, "has", {
        configurable: true,
        value(this: Headers, name: string) { return this.get(name) !== null; },
      });
    }
  });

  afterAll(() => {
    if (!originalHas) Reflect.deleteProperty(Headers.prototype, "has");
  });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    Object.assign(Platform, {
      isDesktop: host === "desktop", isDesktopApp: host === "desktop",
      isMobile: host === "mobile", isMobileApp: host === "mobile",
    });
    leaves = [];
    openedViews = [];
    creditsRequests = [];
    unexpectedRequests = [];
    app = new App();
    file = new TFile({ path: "Example.md", name: "Example.md", extension: "md" } as any);
    jest.mocked(app.vault.getAbstractFileByPath).mockImplementation((value) => value === file.path ? file : null);
    jest.mocked(app.vault.cachedRead).mockResolvedValue("A note to discuss.");
    jest.mocked(app.workspace.getActiveFile).mockReturnValue(file);
    jest.mocked(app.workspace.getLeavesOfType).mockImplementation((type) =>
      leaves.filter((leaf) => leaf.view?.getViewType() === type));
    app.workspace.setActiveLeaf = jest.fn();
    app.workspace.revealLeaf = jest.fn(async () => undefined);
    app.workspace.getLeaf = jest.fn(() => {
      const leaf = new WorkspaceLeaf(app) as any;
      // Obsidian owns view construction/opening. Model that boundary here,
      // rather than the base mock's state-only setViewState implementation.
      leaf.open = jest.fn(async (view) => {
        if (leaf.view) await leaf.view.onClose();
        leaf.view = view;
        openedViews.push(view);
        document.body.appendChild(view.containerEl);
        view.load();
        await view.onOpen();
      });
      leaf.setViewState = jest.fn(async (state) => {
        leaf._viewState = state;
        if (leaf.view?.getViewType() !== state.type) {
          await leaf.open(plugin._views.get(state.type)(leaf));
        }
        await leaf.view.setState(state.state ?? {});
      });
      leaves.push(leaf);
      return leaf;
    });

    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../manifest.json"), "utf8"));
    jest.mocked(requestUrl).mockImplementation(hostRequest(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/credits/balance")) {
        creditsRequests.push(url);
        return hostResponse({
          included_remaining: 1000, add_on_remaining: 0, total_remaining: 1000,
          included_per_month: 1000, usage_class: "customer",
          cycle_anchor_at: "2026-10-01T00:00:00.000Z",
          cycle_started_at: "2026-10-01T00:00:00.000Z",
          cycle_ends_at: "2026-11-01T00:00:00.000Z", turn_in_flight_until: null,
        });
      }
      if (url.endsWith("/releases/latest")) {
        return hostResponse({
          contract_version: "plugin-release-v1", plugin_id: manifest.id,
          latest_version: manifest.version,
          release_url: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/releases/tag/${manifest.version}`,
          published_at: "2026-10-24T00:00:00.000Z",
        });
      }
      unexpectedRequests.push(url);
      throw new Error(`Unexpected host request: ${url}`);
    }));
    jest.spyOn(window, "fetch").mockImplementation(async (input) => {
      unexpectedRequests.push(String(input));
      throw new Error("Unexpected fetch in chat-open integration test");
    });
    const bundle = require(BUNDLE_PATH);
    const PluginClass = bundle.default ?? bundle;
    plugin = new PluginClass(app, manifest);
    const startupIdentity = captureStartupIdentity();
    plugin.load();
    await jest.advanceTimersByTimeAsync(1500);
    expectProductionStartupIdentity(startupIdentity, manifest.version);
    plugin.settings.licenseKey = "chat-open-integration-license";
    plugin.settings.licenseValid = true;
    // Deliberately select hosted execution; no native CLI or real network.
    plugin.settings.textExecutionBackend = "systemsculpt";
    plugin.settings.textExecutionBackendExplicit = true;
    const registeredFactory = plugin._views.get(CHAT_VIEW_TYPE);
    factory = jest.fn((leaf) => {
      const view = registeredFactory(leaf);
      jest.spyOn(view, "onOpen");
      jest.spyOn(view, "addFileToContext");
      return view;
    });
    plugin._views.set(CHAT_VIEW_TYPE, factory);
    creditsRequests.length = 0;
  });

  afterEach(async () => {
    for (const view of new Set(openedViews)) {
      await view.onClose();
      view.unload();
    }
    plugin?.unload();
    await jest.advanceTimersByTimeAsync(0);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.assign(Platform, originalPlatform);
    document.body.replaceChildren();
    expect(unexpectedRequests).toEqual([]);
  });

  function command(id: string) {
    const found = plugin._commands.find((candidate: any) => candidate.id === id);
    expect(found).toBeDefined();
    return found;
  }

  it.each([
    "ribbon", "open command", "new chat command", "post-sign-in destination",
    "file command", "file menu", "single-selection files menu",
  ])("%s constructs and opens one chat and fetches credits once", async (entry) => {
    if (entry === "ribbon") {
      const ribbons = plugin._ribbons.filter((ribbon: HTMLElement) => ribbon.title === "Open chat");
      expect(ribbons).toHaveLength(1);
      ribbons[0].callback();
    } else if (entry === "open command") {
      void command("open-systemsculpt-chat").callback();
    } else if (entry === "new chat command") {
      void command("chat-new-chat").callback();
    } else if (entry === "post-sign-in destination") {
      void plugin.openNewChat();
    } else if (entry === "file command") {
      expect(command("chat-with-file").checkCallback(true)).toBe(true);
      expect(leaves).toHaveLength(0);
      expect(command("chat-with-file").checkCallback(false)).toBe(true);
    } else {
      const event = entry === "file menu" ? "file-menu" : "files-menu";
      const menu = new Menu() as any;
      const registrations = jest.mocked(app.workspace.on).mock.calls.filter(([name]: unknown[]) => name === event);
      expect(registrations).toHaveLength(1);
      (registrations[0][1] as Function)(menu, event === "file-menu" ? file : [file], "file-explorer");
      menu.items.find((item: any) => item.title === "Chat with file").click();
    }
    await jest.advanceTimersByTimeAsync(100);

    expect(leaves).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect({ instances: openedViews.length, creditsRequests: creditsRequests.length })
      .toEqual({ instances: 1, creditsRequests: 1 });
    expect(leaves[0].open).toHaveBeenCalledTimes(1);
    expect(leaves[0].view.onOpen).toHaveBeenCalledTimes(1);
    expect(leaves[0].view).toBe(factory.mock.results[0].value);
    expect(leaves[0].view.getViewType()).toBe(CHAT_VIEW_TYPE);
    expect(leaves[0].view.creditsBalance?.totalRemaining).toBe(1000);
    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(leaves[0], { focus: true });
    if (entry.includes("file")) {
      expect(leaves[0].view.addFileToContext).toHaveBeenCalledTimes(1);
      expect(leaves[0].view.addFileToContext).toHaveBeenCalledWith(file);
      expect(leaves[0].view.containerEl.textContent).toContain("Example.md");
    } else {
      expect(leaves[0].view.addFileToContext).not.toHaveBeenCalled();
    }
  });
});
