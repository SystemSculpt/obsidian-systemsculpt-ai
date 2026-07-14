/**
 * @jest-environment jsdom
 *
 * Mobile artifact smoke. The source policy test proves static compatibility;
 * this test evaluates and onloads the exact production bundle with every
 * desktop Node adapter made unavailable, then opens Studio through the host
 * interface Obsidian uses on phones and tablets.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");
const DESKTOP_NODE_MODULES = [
  "node:fs/promises",
  "node:path",
  "node:os",
  "node:child_process",
];

const STUDIO_VIEW_TYPE = "systemsculpt-studio-view";
const EMBEDDINGS_VIEW_TYPE = "systemsculpt-embeddings-view";
const CHAT_VIEW_TYPE = "systemsculpt-chat-view";

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function openView(options: {
  creator: (leaf: any) => any;
  host: any;
  plugin: any;
  type: string;
  state?: Record<string, unknown>;
  prepare?: (view: any) => void;
}): Promise<any> {
  const leaf = new options.host.WorkspaceLeaf(options.plugin.app);
  await leaf.setViewState({ type: options.type, state: options.state ?? {} });
  const view = options.creator(leaf);
  leaf.view = view;
  options.plugin.app.workspace.activeLeaf = leaf;
  options.prepare?.(view);
  await view.onOpen();
  await flushAsyncWork();
  await view.onClose();
  return view;
}

describe("built bundle in Obsidian Mobile", () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Built bundle not found at ${BUNDLE_PATH} — run \`npm run build\` first `
          + "(or use `npm run test:integration`, which builds before testing).",
      );
    }
  });

  afterEach(() => {
    for (const specifier of DESKTOP_NODE_MODULES) {
      jest.dontMock(specifier);
    }
  });

  it("onloads cleanly and opens Studio, Similar Notes, and Chat from the production mobile bundle", async () => {
    for (const specifier of DESKTOP_NODE_MODULES) {
      jest.doMock(specifier, () => {
        throw new Error(`Desktop adapter was evaluated on mobile: ${specifier}`);
      });
    }

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(manifest.isDesktopOnly).toBe(false);

    let host: any;
    let plugin: any;
    const layoutReadyCallbacks: Array<() => void | Promise<void>> = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      host = require("obsidian");
      Object.assign(host.Platform, {
        isDesktop: false,
        isDesktopApp: false,
        isMobile: true,
        isMobileApp: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const bundleModule = require(BUNDLE_PATH);
      const PluginClass = bundleModule?.default ?? bundleModule;
      const app = new host.App();
      app.workspace.onLayoutReady = jest.fn((callback: () => void | Promise<void>) => {
        layoutReadyCallbacks.push(callback);
        return { unload: jest.fn() };
      });
      plugin = new PluginClass(app, manifest);
    });

    await plugin.onload();
    await plugin.criticalInitializationPromise;
    await plugin.deferredInitializationPromise;
    for (const callback of layoutReadyCallbacks) {
      await callback();
    }
    await flushAsyncWork();
    await plugin.initializeManagers();
    plugin.ensureViewManager().initialize();
    await flushAsyncWork();

    expect(plugin.failures).toEqual([]);

    expect(plugin._commands.length).toBeGreaterThan(0);
    expect(plugin._settingTabs.length).toBeGreaterThan(0);
    expect(plugin._views.has(STUDIO_VIEW_TYPE)).toBe(true);
    expect(plugin._views.has(EMBEDDINGS_VIEW_TYPE)).toBe(true);
    expect(plugin._views.has(CHAT_VIEW_TYPE)).toBe(true);

    const studioView = await openView({
      creator: plugin._views.get(STUDIO_VIEW_TYPE),
      host,
      plugin,
      type: STUDIO_VIEW_TYPE,
      prepare: (view) => {
        view.contentEl.onWindowMigrated = () => () => {};
      },
    });
    expect(studioView.getViewType()).toBe(STUDIO_VIEW_TYPE);
    expect(studioView.contentEl.textContent).not.toMatch(/Studio is desktop-only/i);

    const embeddingsView = await openView({
      creator: plugin._views.get(EMBEDDINGS_VIEW_TYPE),
      host,
      plugin,
      type: EMBEDDINGS_VIEW_TYPE,
    });
    expect(embeddingsView.getViewType()).toBe(EMBEDDINGS_VIEW_TYPE);
    expect(embeddingsView.contentEl.querySelector(".ss-embeddings-view")).not.toBeNull();

    const chatView = await openView({
      creator: plugin._views.get(CHAT_VIEW_TYPE),
      host,
      plugin,
      type: CHAT_VIEW_TYPE,
      state: {},
    });
    expect(chatView.getViewType()).toBe(CHAT_VIEW_TYPE);
    expect(chatView.contentEl.querySelector(".systemsculpt-agent-workspace")).not.toBeNull();

    plugin.unload();
  });
});
