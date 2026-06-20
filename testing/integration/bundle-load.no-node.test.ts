/**
 * @jest-environment jsdom
 *
 * Built-bundle load smoke with the Node runtime ABSENT (issue #207).
 *
 * Why this exists — the dangerous gap bundle-load.mobile.test.ts cannot close:
 * that test flips the Obsidian Platform flags to mobile but still runs on
 * Node, where `require("fs")` RESOLVES. Obsidian on Android/iOS has no Node
 * runtime at all — `require("fs")` throws. So an eager (module-eval or
 * onload-path) Node-builtin touch passes the jsdom mobile smoke yet hard-crashes
 * a real phone with "Failed to load SystemSculpt AI" (the #181 class).
 *
 * This test simulates the phone faithfully: it compiles and runs the shipped
 * `main.js` with a `require` we fully control — every Node builtin, Electron,
 * and the Node-only externalized deps throw exactly as they would on a device,
 * while `obsidian` resolves to the host mock. (Patching Node's module loader
 * would NOT work here: under jest, the bundle's `require` is jest's runtime, not
 * Node's, so jest would happily resolve `fs`.) If any eager path reaches for
 * Node, the require throws and this red-builds — in the required `ci.yml`
 * integration job, with no device and no secrets.
 *
 * It also locks the esbuild `safe-node-externals` wrapping into the artifact so
 * the proper-lockfile / graceful-fs degrade-to-{} cannot silently regress.
 *
 * Run `npm run build` first (npm run test:integration does this for you).
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { Platform } from "obsidian";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

// esbuild externalizes every Node builtin (builtin-modules), Electron, and the
// two Node-only npm deps. On a phone none of these resolve. Obsidian itself is
// always provided by the host, so it is the one external that must still load.
const MOBILE_ABSENT = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
  "proper-lockfile",
  "graceful-fs",
]);

/**
 * Compile + execute the CommonJS bundle in the current (jsdom) global with a
 * caller-supplied `require`, so we — not jest, not Node — decide what resolves.
 * Mirrors Node's module wrapper; `new Function` keeps the bundle in the test's
 * jsdom realm (window/document available, as on a device webview).
 */
function loadBundleWithRequire(requireImpl: (request: string) => unknown): unknown {
  const code = readFileSync(BUNDLE_PATH, "utf8");
  const moduleObj: { exports: unknown } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    code
  );
  factory.call(
    moduleObj.exports,
    moduleObj.exports,
    requireImpl,
    moduleObj,
    BUNDLE_PATH,
    path.dirname(BUNDLE_PATH)
  );
  return moduleObj.exports;
}

describe("built bundle (main.js) with the Node runtime absent (#207)", () => {
  const platformAny = Platform as unknown as Record<string, boolean>;
  let savedFlags: Record<string, boolean>;

  beforeAll(() => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Built bundle not found at ${BUNDLE_PATH} — run \`npm run build\` first ` +
          "(or use `npm run test:integration`, which builds before testing)."
      );
    }
    savedFlags = { ...platformAny };
    platformAny.isDesktop = false;
    platformAny.isDesktopApp = false;
    platformAny.isMobile = true;
    platformAny.isMobileApp = true;
  });

  afterAll(() => {
    Object.assign(platformAny, savedFlags);
  });

  it("module-evaluates and onloads when every Node builtin require() throws (simulated phone)", async () => {
    const mobileRequire = (request: string): unknown => {
      if (MOBILE_ABSENT.has(request)) {
        throw new Error(
          `Cannot find module '${request}' — simulated mobile (no Node runtime, #207)`
        );
      }
      // The host always provides obsidian; everything else is bundled inline.
      return require(request);
    };

    // Module-eval under the mobile require: an eager Node touch throws HERE.
    const bundleModule = loadBundleWithRequire(mobileRequire) as
      | { default?: unknown }
      | unknown;
    const PluginClass =
      (bundleModule as { default?: unknown })?.default ?? bundleModule;
    expect(typeof PluginClass).toBe("function");

    const { App, Plugin } = require("obsidian");
    expect((PluginClass as { prototype: unknown }).prototype instanceof Plugin).toBe(true);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let plugin: any;
    try {
      plugin = new (PluginClass as new (...args: unknown[]) => unknown)(new App(), manifest);
      // The core guard: the eager + critical + deferred startup path must not
      // require a Node builtin on a phone. Any reach for Node rejects here.
      await plugin.onload();
      await plugin.criticalInitializationPromise;
      await plugin.deferredInitializationPromise;
    } finally {
      if (plugin) {
        try {
          plugin.unload();
        } catch {
          /* ignore unload errors during teardown */
        }
      }
    }

    // Settings + the core command/settings surface still come up with no Node.
    expect(plugin.settings).toBeDefined();
    expect(plugin.settings.selectedModelId).toBe("systemsculpt@@systemsculpt/ai-agent");
    expect(plugin._commands.length).toBeGreaterThan(0);
    expect(plugin._settingTabs.length).toBeGreaterThan(0);
  });

  it("ships the safe-node-externals try/catch wrapping (mobile degrade-to-{})", () => {
    // Guards the esbuild `safe-node-externals` post-process: each Node-only
    // external required BY NAME must stay wrapped so it degrades to {} on mobile
    // instead of throwing at require time. proper-lockfile is the one actually
    // bundled; graceful-fs is only a transitive dep of the externalized
    // proper-lockfile, so it must never appear in the bundle as a bare require.
    const code = readFileSync(BUNDLE_PATH, "utf8");
    const SAFE_EXTERNALS = ["proper-lockfile", "graceful-fs"] as const;

    // The real dep must be present and wrapped — drops out if the plugin regresses.
    expect(code).toContain('try { return require("proper-lockfile"); } catch { return {}; }');

    // No UNWRAPPED require of a safe external may survive for any of them.
    for (const mod of SAFE_EXTERNALS) {
      const allRequires = (code.match(new RegExp(`require\\("${mod}"\\)`, "g")) || []).length;
      const wrappedRequires =
        code.split(`try { return require("${mod}"); } catch { return {}; }`).length - 1;
      expect(allRequires).toBe(wrappedRequires);
    }
  });
});
