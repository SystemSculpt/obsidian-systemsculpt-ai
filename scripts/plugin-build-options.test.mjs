import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_API_BASE_URL,
  CANONICAL_WEBSITE_API_BASE_URL,
  createPluginBuildOptions,
  normalizeApiBaseUrl,
  resolveWebsiteApiBaseUrl,
} from "./plugin-build-options.mjs";

test("production API base is the build default", () => {
  const options = createPluginBuildOptions();
  assert.equal(
    options.define.__SYSTEMSCULPT_API_BASE_URL__,
    JSON.stringify(CANONICAL_API_BASE_URL),
  );
  assert.equal(
    options.define.__SYSTEMSCULPT_WEBSITE_API_BASE_URL__,
    JSON.stringify(CANONICAL_WEBSITE_API_BASE_URL),
  );
});

test("API base is injected at build time without a runtime environment lookup", () => {
  const apiBaseUrl = "http://127.0.0.1:3001/api/v1";
  const options = createPluginBuildOptions({ apiBaseUrl });

  assert.equal(
    options.define.__SYSTEMSCULPT_API_BASE_URL__,
    JSON.stringify(apiBaseUrl),
  );
  assert.equal(
    options.define.__SYSTEMSCULPT_WEBSITE_API_BASE_URL__,
    JSON.stringify("http://127.0.0.1:3001/api/plugin"),
  );
  assert.doesNotMatch(options.banner.js, /process\.env|globalThis\.process/);
});

test("explicit website API override wins over loopback derivation", () => {
  const options = createPluginBuildOptions({
    apiBaseUrl: "http://127.0.0.1:3001/api/v1",
    websiteApiBaseUrl: "http://localhost:4000/api/plugin/",
  });
  assert.equal(
    options.define.__SYSTEMSCULPT_WEBSITE_API_BASE_URL__,
    JSON.stringify("http://localhost:4000/api/plugin"),
  );
});

test("non-loopback API overrides do not redirect the website API implicitly", () => {
  assert.equal(
    resolveWebsiteApiBaseUrl({ apiBaseUrl: "https://qa-api.systemsculpt.com/api/v1" }),
    CANONICAL_WEBSITE_API_BASE_URL,
  );
});

test("API base normalization removes trailing slashes", () => {
  assert.equal(
    normalizeApiBaseUrl("http://127.0.0.1:3001/api/v1///"),
    "http://127.0.0.1:3001/api/v1",
  );
});

test("API base rejects relative and stateful URLs", () => {
  assert.throws(() => normalizeApiBaseUrl("/api/v1"), /absolute HTTP\(S\)/);
  assert.throws(
    () => normalizeApiBaseUrl("https://api.systemsculpt.com/api/v1?debug=1"),
    /without credentials, query, or hash/,
  );
});
