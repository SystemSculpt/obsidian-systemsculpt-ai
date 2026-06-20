/**
 * @jest-environment jsdom
 *
 * Built-bundle load smoke on MOBILE emulation (issue #215). Mirrors
 * bundle-load.test.ts, but flips the Obsidian Platform flags to mobile before
 * loading the compiled `main.js`, proving the shipped artifact constructs and
 * survives `onload()` on phones/tablets — not just desktop.
 *
 * Why this exists: the desktop bundle-load smoke never exercises the mobile
 * code paths (Platform.isDesktop defaults true in the mock), and the real
 * device harness (`test:native:android/ios`) is local-only and never gates a
 * PR. A v5 mobile-startup regression (the #207 class) can therefore ship green.
 * This test runs in the required `ci.yml` integration job — no device, no
 * secrets — so a broken mobile onload red-builds immediately.
 *
 * Run `npm run build` first (npm run test:integration does this for you).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Platform } from "obsidian";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

describe("built bundle (main.js) on mobile emulation", () => {
  const platformAny = Platform as unknown as Record<string, boolean>;
  let savedFlags: Record<string, boolean>;

  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Built bundle not found at ${BUNDLE_PATH} — run \`npm run build\` first ` +
          "(or use `npm run test:integration`, which builds before testing)."
      );
    }
    // Emulate a mobile host before the bundle is required/onloaded, so any
    // desktop-only branch taken at module-eval or onload runs under mobile
    // flags. Mirrors the flip used by the #201 provider-listing guard.
    savedFlags = { ...platformAny };
    platformAny.isDesktop = false;
    platformAny.isDesktopApp = false;
    platformAny.isMobile = true;
    platformAny.isMobileApp = true;
  });

  afterAll(() => {
    Object.assign(platformAny, savedFlags);
  });

  it("loads, constructs, and onloads on mobile with its core surface registered", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundleModule = require(BUNDLE_PATH);
    const PluginClass = bundleModule?.default ?? bundleModule;
    expect(typeof PluginClass).toBe("function");

    const { App, Plugin } = require("obsidian");
    expect(PluginClass.prototype instanceof Plugin).toBe(true);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const plugin = new PluginClass(new App(), manifest);

    // The core regression guard: onload must not throw on mobile. A
    // desktop-only path reached under mobile flags would reject one of these.
    await plugin.onload();
    await plugin.criticalInitializationPromise;
    await plugin.deferredInitializationPromise;

    // Settings still migrate + defaults apply under mobile flags.
    expect(plugin.settings).toBeDefined();
    expect(typeof plugin.settings).toBe("object");
    expect(plugin.settings.settingsMode).toBe("standard");
    expect(Array.isArray(plugin.settings.customProviders)).toBe(true);
    expect(plugin.settings.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");

    // Core surface still registers on mobile.
    expect(plugin._commands.length).toBeGreaterThan(0);
    expect(plugin._settingTabs.length).toBeGreaterThan(0);

    const commandIds = plugin._commands.map((command: { id: string }) => command.id);
    expect(new Set(commandIds).size).toBe(commandIds.length);

    // #207 graceful degradation: the desktop-only recorder service is WITHHELD
    // on mobile. Its construction is gated behind !PlatformContext.isMobileRuntime()
    // (src/main.ts:1689) because recording needs desktop audio APIs. A regression
    // that ungates it — re-introducing desktop-only code on phones, the #181/#207
    // failure class — flips this to non-null. The desktop guard
    // (bundle-load.test.ts) asserts the same service IS initialized off-mobile, so
    // this is a real gate, not a vacuous default (the field defaulting to null).
    expect(plugin.recorderService).toBeNull();

    plugin.unload();
  });
});
