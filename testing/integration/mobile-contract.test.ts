/**
 * @jest-environment jsdom
 *
 * Mobile startup contract for the shipped Obsidian plugin bundle.
 *
 * This intentionally loads the compiled `main.js` artifact, then starts the
 * plugin under an iPad-like Obsidian runtime. It does not replace real iOS
 * canary testing, but it catches the fast class of regressions where mobile
 * startup accidentally executes desktop-only services before a device is even
 * involved.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

const IPAD_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setValue(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: true,
    value,
  });
}

function configureIpadRuntime() {
  const { Platform } = require("obsidian");
  Object.assign(Platform, {
    isDesktop: false,
    isDesktopApp: false,
    isMobile: true,
    isMobileApp: true,
    isPhone: false,
    isTablet: true,
    isIosApp: true,
    isAndroidApp: false,
  });

  setValue(window.navigator, "userAgent", IPAD_USER_AGENT);
  setValue(window.navigator, "maxTouchPoints", 5);
  setValue(window.navigator, "hardwareConcurrency", 4);
  setValue(window.navigator, "mediaDevices", {
    getUserMedia: jest.fn(),
  });

  setValue(window, "innerWidth", 1024);
  setValue(window, "innerHeight", 1366);
  setValue(window, "devicePixelRatio", 2);
  setValue(window, "app", { isMobile: true });
  setValue(window, "WebGLRenderingContext", function WebGLRenderingContext() {});
  setValue(globalThis, "screen", { width: 1024, height: 1366 });
}

function loadPluginClass() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bundleModule = require(BUNDLE_PATH);
  return bundleModule?.default ?? bundleModule;
}

describe("built bundle mobile startup contract", () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Built bundle not found at ${BUNDLE_PATH}. Run \`npm run build\` first ` +
          "or use `npm run test:integration`.",
      );
    }
  });

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = "";
    configureIpadRuntime();
  });

  it("starts on an iPad-like runtime without activating desktop-only services", async () => {
    const PluginClass = loadPluginClass();
    const { App, Plugin } = require("obsidian");
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const app = new App();
    app.commands = { removeCommand: jest.fn() };
    app.vault.adapter.mkdir = jest.fn(async () => {});
    app.vault.adapter.write = jest.fn(async () => {});

    const plugin = new PluginClass(app, manifest);
    expect(plugin instanceof Plugin).toBe(true);

    await plugin.onload();
    await plugin.criticalInitializationPromise;
    await plugin.deferredInitializationPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(plugin.failures).toEqual([]);
    expect(plugin.settings).toEqual(
      expect.objectContaining({
        settingsMode: "standard",
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
      }),
    );
    expect(plugin._settingTabs.length).toBeGreaterThan(0);

    const commandIds = plugin._commands.map((command: { id: string }) => command.id);
    expect(commandIds).toContain("open-systemsculpt-chat");
    expect(commandIds).toContain("open-systemsculpt-settings");
    expect(new Set(commandIds).size).toBe(commandIds.length);

    expect(plugin.hasRecorderService()).toBe(false);
    expect(plugin.embeddingsStatusBar).toBeNull();
    expect(plugin.fileContextMenuService).toBeNull();
    expect(plugin.desktopAutomationBridge).toBeNull();
    expect(plugin.hasRegisteredStudioExtensions).toBe(false);

    expect(app.vault.adapter.write).toHaveBeenCalledWith(
      "SystemSculpt/Diagnostics/mobile-startup.json",
      expect.stringContaining('"runtime": "mobile"'),
    );

    plugin.unload();
  });
});
