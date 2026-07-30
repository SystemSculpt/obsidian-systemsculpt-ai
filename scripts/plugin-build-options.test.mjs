import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AGENTS_CHAT_REACT_ENTRYPOINT,
  CANONICAL_API_BASE_URL,
  createHeadlessAgentChatTreeShakingPlugin,
  createPluginBuildOptions,
  normalizeApiBaseUrl,
  resolvePluginBuildStamp,
} from "./plugin-build-options.mjs";

test("production API base is the build default", () => {
  const options = createPluginBuildOptions();
  assert.equal(
    options.define.__SYSTEMSCULPT_API_BASE_URL__,
    JSON.stringify(CANONICAL_API_BASE_URL),
  );
});

test("API base is injected at build time without a runtime environment lookup", () => {
  const apiBaseUrl = "http://127.0.0.1:3001/api/plugin";
  const options = createPluginBuildOptions({ apiBaseUrl });

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

test("release metadata produces one deterministic build define", () => {
  const buildStamp = resolvePluginBuildStamp({ version: "6.2.7" });
  const first = createPluginBuildOptions({ buildStamp });
  const second = createPluginBuildOptions({ buildStamp });

  assert.equal(buildStamp, "release-6.2.7");
  assert.equal(first.define.__SS_BUILD_STAMP__, JSON.stringify(buildStamp));
  assert.equal(second.define.__SS_BUILD_STAMP__, first.define.__SS_BUILD_STAMP__);
});

test("build stamp overrides are explicit and development remains stable", () => {
  assert.equal(
    resolvePluginBuildStamp({
      version: "6.2.7",
      override: "qa-candidate-42",
    }),
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

test("headless agent tree shaking affects only React imports from the maintained transport entrypoint", async () => {
  let onResolve;
  const resolveCalls = [];
  const plugin = createHeadlessAgentChatTreeShakingPlugin();
  plugin.setup({
    onResolve(options, callback) {
      assert.match("react", options.filter);
      assert.match("@ai-sdk/react", options.filter);
      onResolve = callback;
    },
    async resolve(specifier, options) {
      resolveCalls.push({ specifier, options });
      return {
        errors: [],
        warnings: [],
        path: path.join(process.cwd(), "node_modules", specifier, "index.js"),
        external: false,
        sideEffects: true,
        namespace: "file",
        suffix: "",
      };
    },
  });

  assert.equal(typeof onResolve, "function");
  const unrelated = await onResolve({
    path: "react",
    importer: path.join(process.cwd(), "src", "main.ts"),
    namespace: "file",
    resolveDir: path.join(process.cwd(), "src"),
    kind: "import-statement",
    pluginData: undefined,
    with: {},
  });
  assert.equal(unrelated, undefined);
  assert.equal(resolveCalls.length, 0);

  for (const specifier of ["react", "@ai-sdk/react"]) {
    const resolved = await onResolve({
      path: specifier,
      importer: AGENTS_CHAT_REACT_ENTRYPOINT,
      namespace: "file",
      resolveDir: path.dirname(AGENTS_CHAT_REACT_ENTRYPOINT),
      kind: "import-statement",
      pluginData: undefined,
      with: {},
    });
    assert.equal(resolved.sideEffects, false);
    assert.equal(resolveCalls.at(-1).specifier, specifier);

    const recursive = await onResolve({
      path: specifier,
      importer: AGENTS_CHAT_REACT_ENTRYPOINT,
      namespace: "file",
      resolveDir: path.dirname(AGENTS_CHAT_REACT_ENTRYPOINT),
      kind: "import-statement",
      pluginData: resolveCalls.at(-1).options.pluginData,
      with: {},
    });
    assert.equal(recursive, undefined);
  }
});
