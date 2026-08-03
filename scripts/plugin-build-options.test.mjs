import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_API_BASE_URL,
  LOCAL_AGENT_API_BASE_URL,
  STAGING_API_BASE_URL,
  assertNoRetiredBuildOverrides,
  createPluginBuildOptions,
  normalizeApiBaseUrl,
  resolvePluginBuildArguments,
  resolvePluginBuildStamp,
  resolvePluginBuildTarget,
} from "./plugin-build-options.mjs";

test("production API base is the build default", () => {
  const options = createPluginBuildOptions();
  assert.equal(
    options.define.__SYSTEMSCULPT_API_BASE_URL__,
    JSON.stringify(CANONICAL_API_BASE_URL),
  );
});

test("staging API base is a fixed first-party build target", () => {
  assert.equal(
    STAGING_API_BASE_URL,
    "https://staging.systemsculpt.com/api/plugin",
  );
  assert.equal(normalizeApiBaseUrl(STAGING_API_BASE_URL), STAGING_API_BASE_URL);
});

test("API base is injected at build time without a runtime environment lookup", () => {
  const apiBaseUrl = "http://127.0.0.1:3001/api/plugin";
  const options = createPluginBuildOptions({
    apiBaseUrl,
    production: false,
    releaseBuild: false,
  });

  assert.equal(
    options.define.__SYSTEMSCULPT_API_BASE_URL__,
    JSON.stringify(apiBaseUrl),
  );
  assert.doesNotMatch(options.banner.js, /process\.env|globalThis\.process/);
});

test("API base normalization removes trailing slashes", () => {
  assert.equal(
    normalizeApiBaseUrl("http://127.0.0.1:3001/api/plugin///"),
    "http://127.0.0.1:3001/api/plugin",
  );
});

test("API base rejects relative and stateful URLs", () => {
  assert.throws(() => normalizeApiBaseUrl("/api/plugin"), /absolute HTTP\(S\)/);
  assert.throws(
    () => normalizeApiBaseUrl("https://systemsculpt.com/api/plugin?debug=1"),
    /without credentials, query, or hash/,
  );
  assert.throws(
    () => normalizeApiBaseUrl("https://systemsculpt.com/api/v1"),
    /must end with \/api\/plugin/,
  );
});

test("release metadata produces deterministic locked build defines", () => {
  const buildStamp = resolvePluginBuildStamp({ version: "6.2.7" });
  const first = createPluginBuildOptions({ buildStamp });
  const second = createPluginBuildOptions({ buildStamp });

  assert.equal(buildStamp, "release-6.2.7");
  assert.equal(first.define.__SS_BUILD_STAMP__, JSON.stringify(buildStamp));
  assert.equal(first.define.__SS_RELEASE_BUILD__, "true");
  assert.equal(second.define.__SS_BUILD_STAMP__, first.define.__SS_BUILD_STAMP__);
});

test("production build stamps reject overrides and development remains stable", () => {
  assert.throws(
    () => resolvePluginBuildStamp({
      version: "6.2.7",
      override: "qa-candidate-42",
    }),
    /cannot be overridden/,
  );
  assert.equal(
    resolvePluginBuildStamp({ production: false, override: "qa-candidate-42" }),
    "qa-candidate-42",
  );
  assert.equal(resolvePluginBuildStamp({ production: false }), "dev");
  assert.throws(
    () => resolvePluginBuildStamp({ version: "not-semver" }),
    /semantic manifest version/,
  );
  assert.equal(
    createPluginBuildOptions().define.__SS_BUILD_STAMP__,
    JSON.stringify("dev"),
  );
});

test("caller-provided plugins are preserved without hidden runtime shims", () => {
  const plugin = { name: "caller-owned-plugin", setup() {} };
  const options = createPluginBuildOptions({ plugins: [plugin] });

  assert.deepEqual(options.plugins, [plugin]);
});

test("named build targets select fixed release and development routes", () => {
  assert.deepEqual(resolvePluginBuildTarget("production"), {
    name: "production",
    production: true,
    releaseBuild: true,
    watch: false,
    apiBaseUrl: CANONICAL_API_BASE_URL,
    buildStamp: null,
    testDriver: false,
  });
  assert.equal(resolvePluginBuildTarget("staging").apiBaseUrl, STAGING_API_BASE_URL);
  assert.equal(resolvePluginBuildTarget("staging-watch").watch, true);
  assert.equal(resolvePluginBuildTarget("local-agent").apiBaseUrl, LOCAL_AGENT_API_BASE_URL);
  assert.equal(resolvePluginBuildTarget("local-agent-watch").watch, true);
  assert.equal(resolvePluginBuildTarget("development").production, false);
  assert.throws(() => resolvePluginBuildTarget(), /Unknown plugin build target.*missing/);
  assert.throws(() => resolvePluginBuildTarget("prodution"), /Unknown plugin build target/);
  assert.throws(() => resolvePluginBuildTarget(" production"), /Unknown plugin build target/);
  assert.equal(resolvePluginBuildArguments(["production"]).name, "production");
  assert.throws(() => resolvePluginBuildArguments([]), /exactly one named build target/);
  assert.throws(
    () => resolvePluginBuildArguments(["production", "unexpected"]),
    /exactly one named build target/,
  );
});

test("environment values cannot override the selected API route", () => {
  assert.doesNotThrow(() => assertNoRetiredBuildOverrides({
    PATH: "/bin",
    SYSTEMSCULPT_BUILD_STAMP: "ignored",
    SYSTEMSCULPT_TEST_DRIVER: "ignored",
  }));
  assert.throws(
    () => assertNoRetiredBuildOverrides({
      SYSTEMSCULPT_API_BASE_URL: "http://127.0.0.1:8787/api/plugin",
    }),
    /SYSTEMSCULPT_API_BASE_URL cannot override plugin build routing/,
  );
});

test("release build options reject endpoint, driver, and reserved define overrides", () => {
  assert.throws(
    () => createPluginBuildOptions({ apiBaseUrl: STAGING_API_BASE_URL }),
    /Release plugin builds require https:\/\/systemsculpt\.com\/api\/plugin/,
  );
  assert.throws(
    () => createPluginBuildOptions({ testDriver: true }),
    /cannot include the E2E test driver/,
  );
  assert.throws(
    () => createPluginBuildOptions({
      overrides: { define: { __SYSTEMSCULPT_API_BASE_URL__: JSON.stringify(STAGING_API_BASE_URL) } },
    }),
    /cannot replace reserved define/,
  );
});

test("the E2E test driver define follows non-release production-shaped builds", () => {
  assert.equal(
    createPluginBuildOptions({ production: true }).define.__SS_TEST_DRIVER__,
    "false",
  );
  assert.equal(
    createPluginBuildOptions({ production: false }).define.__SS_TEST_DRIVER__,
    "true",
  );
  assert.equal(
    createPluginBuildOptions({
      production: true,
      releaseBuild: false,
      testDriver: true,
    }).define.__SS_TEST_DRIVER__,
    "true",
  );
});
