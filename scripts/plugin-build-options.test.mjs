import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_API_BASE_URL,
  createPluginBuildOptions,
  normalizeApiBaseUrl,
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
