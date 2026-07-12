import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateReleasePackage } from "./release-plugin.mjs";
import {
  CANONICAL_API_BASE_URL,
  CANONICAL_WEBSITE_API_BASE_URL,
} from "./plugin-build-options.mjs";

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "5.11.0";
  const files = {
    "manifest.json": { id: "systemsculpt-ai", version, minAppVersion: "1.8.0" },
    "package.json": { name: "systemsculpt-ai", version },
    "package-lock.json": { version, packages: { "": { version } } },
    "versions.json": { [version]: "1.8.0" },
    ...overrides,
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`);
  }
  fs.writeFileSync(
    path.join(root, "main.js"),
    `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\nconst SYSTEMSCULPT_WEBSITE_API = ${JSON.stringify(CANONICAL_WEBSITE_API_BASE_URL)};\n`,
  );
  fs.writeFileSync(path.join(root, "styles.css"), "production\n");
  return root;
}

test("validates one semantic version and exactly the three plugin artifacts", (t) => {
  const root = fixture(t);
  const result = validateReleasePackage({ root, build: false });
  assert.equal(result.version, "5.11.0");
  assert.deepEqual(result.files, ["manifest.json", "main.js", "styles.css"]);
});

test("rejects inconsistent package versions", (t) => {
  const root = fixture(t, { "package.json": { name: "systemsculpt-ai", version: "5.10.0" } });
  assert.throws(() => validateReleasePackage({ root, build: false }), /package\.json version/);
});

test("runs the production builder before validating artifacts", (t) => {
  const root = fixture(t);
  let called = false;
  validateReleasePackage({
    root,
    buildImpl(options) {
      called = options.root === root;
      return { ok: true };
    },
  });
  assert.equal(called, true);
});
