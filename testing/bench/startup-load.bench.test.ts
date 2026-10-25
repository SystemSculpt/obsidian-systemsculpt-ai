/**
 * @jest-environment jsdom
 *
 * Plugin startup micro-benchmark. Not part of the check gates; run manually to
 * compare what loading the production bundle costs before/after a change:
 *
 *   npm run build
 *   node scripts/jest.mjs --debug-console --config jest.integration.config.cjs \
 *     --roots '<rootDir>/testing' --runTestsByPath testing/bench/startup-load.bench.test.ts
 *
 * V8 reuses a script it has already compiled in the same isolate, so each Jest
 * process measures exactly one cold load: repeat the command for a sample and
 * compare medians, alternating builds. Jest leaves only the checkout's own
 * main.js untransformed, so copy the build under test there for each run.
 * Reports wall-clock milliseconds as JSON on stdout: evaluating main.js, the
 * onload call Obsidian awaits, and the critical and deferred phases after it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "main.js");
const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "manifest.json");

describe("startup cost of the built bundle", () => {
  it("evaluates main.js and runs onload once", async () => {
    const { App } = require("obsidian");
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

    const evaluateStart = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bundleModule = require(BUNDLE_PATH);
    const evaluateMs = performance.now() - evaluateStart;
    const PluginClass = bundleModule?.default ?? bundleModule;

    const plugin = new PluginClass(new App(), manifest);
    const onloadStart = performance.now();
    await plugin.onload();
    const onloadMs = performance.now() - onloadStart;
    await plugin.criticalInitializationPromise;
    const criticalMs = performance.now() - onloadStart;
    await plugin.deferredInitializationPromise;
    const deferredMs = performance.now() - onloadStart;

    plugin.unload();
    await plugin.unloadPromise;

    // eslint-disable-next-line no-console
    console.log(`BENCH_RESULT ${JSON.stringify({
      bundleBytes: readFileSync(BUNDLE_PATH).length,
      evaluateMs: Number(evaluateMs.toFixed(2)),
      onloadMs: Number(onloadMs.toFixed(2)),
      criticalMs: Number(criticalMs.toFixed(2)),
      deferredMs: Number(deferredMs.toFixed(2)),
    })}`);
    expect(evaluateMs).toBeGreaterThan(0);
  });
});
