/**
 * @jest-environment jsdom
 *
 * Built-bundle load smoke (issue #215). Loads the compiled `main.js` — the
 * exact artifact Obsidian ships — against the enriched host mock and proves
 * the plugin class loads, constructs, and survives onload with its core
 * surface registered. This is the artifact-level guard the unit suite cannot
 * provide: it catches broken externals, top-level require failures, and
 * onload regressions in bundled dependency code.
 *
 * Run `npm run build` first (npm run test:integration does this for you).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

describe("built bundle (main.js)", () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Built bundle not found at ${BUNDLE_PATH} — run \`npm run build\` first ` +
          "(or use `npm run test:integration`, which builds before testing)."
      );
    }
  });

  it("loads, constructs, and onloads against the mock host", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundleModule = require(BUNDLE_PATH);
    const PluginClass = bundleModule?.default ?? bundleModule;
    expect(typeof PluginClass).toBe("function");

    const { App, Plugin } = require("obsidian");
    expect(Object.getPrototypeOf(PluginClass.prototype) instanceof Object).toBe(true);
    expect(PluginClass.prototype instanceof Plugin).toBe(true);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const plugin = new PluginClass(new App(), manifest);

    await plugin.onload();

    // onload schedules command/service registration in the critical and
    // deferred lifecycle phases without awaiting them — wait for both so the
    // assertions below see the fully initialized surface.
    await plugin.criticalInitializationPromise;
    await plugin.deferredInitializationPromise;

    // Settings migration ran: loadData returned null, so defaults applied.
    expect(plugin.settings).toBeDefined();
    expect(typeof plugin.settings).toBe("object");
    expect(plugin.settings.settingsMode).toBe("standard");
    expect(Array.isArray(plugin.settings.customProviders)).toBe(true);
    expect(plugin.settings.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");

    // Core surface registered through the mock host.
    expect(plugin._commands.length).toBeGreaterThan(0);
    expect(plugin._settingTabs.length).toBeGreaterThan(0);

    const commandIds = plugin._commands.map((command: { id: string }) => command.id);
    expect(new Set(commandIds).size).toBe(commandIds.length);

    plugin.unload();
  });
});
