import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";
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
import {
  PLUGIN_ARTIFACT_ID_PLUGIN_NAME,
  PLUGIN_ARTIFACT_ID_PREFIX,
  TEST_DRIVER_ARTIFACT_MODULE,
  createPluginArtifactId,
  createPluginArtifactIdentityPlugin,
  extractPluginArtifactId,
  inspectPluginArtifactIdentity,
} from "./plugin-artifact-identity.mjs";

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

test("internal provenance stays ahead of every caller-provided plugin", () => {
  const plugin = { name: "caller-owned-plugin", setup() {} };
  const options = createPluginBuildOptions({ plugins: [plugin] });

  assert.equal(options.plugins[0].name, PLUGIN_ARTIFACT_ID_PLUGIN_NAME);
  assert.equal(options.plugins[1], plugin);
  assert.throws(
    () => createPluginBuildOptions({ overrides: { plugins: [] } }),
    /cannot replace internal plugins/,
  );
});

test("artifact identities use exactly 128 bits and strict lowercase formatting", () => {
  const artifactId = createPluginArtifactId((size) => {
    assert.equal(size, 16);
    return Buffer.alloc(size, 0xab);
  });
  assert.equal(
    artifactId,
    `${PLUGIN_ARTIFACT_ID_PREFIX}${"ab".repeat(16)}`,
  );
  assert.equal(extractPluginArtifactId(`const id = ${JSON.stringify(artifactId)};`), artifactId);
});

test("artifact identity extraction fails closed without echoing bundle content", () => {
  const valid = `${PLUGIN_ARTIFACT_ID_PREFIX}${"1".repeat(32)}`;
  const secret = "private-bundle-content-that-must-not-leak";
  for (const [label, bundle, expected] of [
    ["missing", secret, /identity is missing/],
    ["short", `${PLUGIN_ARTIFACT_ID_PREFIX}${"1".repeat(31)} ${secret}`, /malformed/],
    ["long", `${PLUGIN_ARTIFACT_ID_PREFIX}${"1".repeat(33)} ${secret}`, /malformed/],
    ["uppercase", `${PLUGIN_ARTIFACT_ID_PREFIX}${"A".repeat(32)} ${secret}`, /malformed/],
    ["duplicate", `${valid}\n${valid}\n${secret}`, /ambiguous/],
  ]) {
    assert.throws(
      () => extractPluginArtifactId(bundle),
      (error) => error instanceof Error
        && expected.test(error.message)
        && !error.message.includes(secret)
        && !error.message.includes(valid),
      label,
    );
  }
});

test("one esbuild context mints a distinct exact identity for every rebuild", async () => {
  const context = await esbuild.context(createPluginBuildOptions({
    entryPoint: TEST_DRIVER_ARTIFACT_MODULE,
    outfile: "unused-artifact-identity.js",
    write: false,
    production: true,
    releaseBuild: false,
    testDriver: true,
  }));
  try {
    const first = await context.rebuild();
    const second = await context.rebuild();
    const firstText = first.outputFiles[0].text;
    const secondText = second.outputFiles[0].text;
    const firstId = extractPluginArtifactId(firstText);
    const secondId = extractPluginArtifactId(secondText);

    assert.notEqual(firstId, secondId);
    assert.deepEqual(inspectPluginArtifactIdentity(firstText), {
      prefixCount: 1,
      validCount: 1,
    });
    assert.deepEqual(inspectPluginArtifactIdentity(secondText), {
      prefixCount: 1,
      validCount: 1,
    });
  } finally {
    await context.dispose();
  }
});

test("release builds resolve the virtual module without minting or retaining an identity", async () => {
  let generated = 0;
  const result = await esbuild.build({
    entryPoints: [TEST_DRIVER_ARTIFACT_MODULE],
    bundle: true,
    write: false,
    format: "cjs",
    plugins: [createPluginArtifactIdentityPlugin({
      enabled: false,
      createArtifactId() {
        generated += 1;
        return `${PLUGIN_ARTIFACT_ID_PREFIX}${"2".repeat(32)}`;
      },
    })],
  });
  const bundle = result.outputFiles[0].text;
  assert.equal(generated, 0);
  assert.equal(bundle.includes(PLUGIN_ARTIFACT_ID_PREFIX), false);
  assert.deepEqual(inspectPluginArtifactIdentity(bundle), {
    prefixCount: 0,
    validCount: 0,
  });
});

test("full driver and release bundles enforce the executable provenance boundary", async () => {
  const driverResult = await esbuild.build(createPluginBuildOptions({
    entryPoint: "src/main.ts",
    outfile: "main.js",
    write: false,
    production: true,
    releaseBuild: false,
    testDriver: true,
    apiBaseUrl: LOCAL_AGENT_API_BASE_URL,
    buildStamp: "local-agent",
  }));
  const releaseResult = await esbuild.build(createPluginBuildOptions({
    entryPoint: "src/main.ts",
    outfile: "main.js",
    write: false,
    production: true,
    releaseBuild: true,
    testDriver: false,
    buildStamp: "release-6.3.1",
  }));
  const driverBundle = driverResult.outputFiles[0].text;
  const releaseBundle = releaseResult.outputFiles[0].text;

  assert.equal(driverBundle.includes("SystemSculptTestDriver/v1"), true);
  assert.deepEqual(inspectPluginArtifactIdentity(driverBundle), {
    prefixCount: 1,
    validCount: 1,
  });
  assert.equal(releaseBundle.includes("SystemSculptTestDriver/v1"), false);
  assert.equal(releaseBundle.includes(PLUGIN_ARTIFACT_ID_PREFIX), false);
  assert.deepEqual(inspectPluginArtifactIdentity(releaseBundle), {
    prefixCount: 0,
    validCount: 0,
  });
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
