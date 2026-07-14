import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./check-plugin.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("package scripts preserve fast edit and exhaustive verification tiers", () => {
  assert.equal(packageJson.scripts.check, "npm run check:plugin:fast");
  assert.equal(packageJson.scripts["check:all"], "npm run check:full");
  assert.equal(
    packageJson.scripts["check:full"],
    "npm run check:plugin && npm test "
      + "&& npm run test:embeddings && npm run test:integration && npm run test:release-script",
  );
});

test("fast plugin checks stay on the measured Obsidian-native tier", () => {
  assert.match(source, /const FAST_SCRIPT_TESTS = \[/);
  assert.match(source, /scripts\/github-workflows\.test\.mjs/);
  assert.match(source, /scripts\/lint-css\.test\.mjs/);
  assert.match(source, /npm run check:plugin:obsidian/);
  assert.match(source, /buildProductionPlugin/);
  assert.match(source, /if \(!fast\) \{/);

  const fullOnly = source.slice(source.indexOf("if (!fast)"));
  assert.match(fullOnly, /npm run check:types/);
  assert.ok(
    source.indexOf("scripts/mobile-compatibility.test.mjs")
      > source.indexOf("const NORMAL_SCRIPT_TESTS"),
  );
});

test("fast plugin checks include the live managed policy and exclude unbounded Jest work", () => {
  assert.match(source, /scripts\/check\/managed-only-policy\.test\.mjs/);
  assert.doesNotMatch(source, /testing\/native/);
  assert.doesNotMatch(source, /jest\.config\.cjs --passWithNoTests/);
  assert.doesNotMatch(source, /findRelatedTests/);
  assert.doesNotMatch(source, /test:ui:focused/);

  const normalOnly = source.slice(source.indexOf("if (!fast)"));
  assert.match(normalOnly, /NORMAL_SCRIPT_TESTS/);
});
