import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./check-plugin.mjs", import.meta.url), "utf8");

test("fast plugin checks stay on the measured deterministic tier", () => {
  assert.match(source, /const FAST_SCRIPT_TESTS = \[/);
  assert.match(source, /scripts\/github-workflows\.test\.mjs/);
  assert.match(source, /scripts\/lint-css\.test\.mjs/);
  assert.match(source, /npm run check:types/);
  assert.match(source, /buildProductionPlugin/);
  assert.match(source, /if \(!fast\) \{/);
});

test("fast plugin checks exclude egress and unbounded Jest work", () => {
  assert.doesNotMatch(source, /network-egress-inventory\.test/);
  assert.doesNotMatch(source, /testing\/native/);
  assert.doesNotMatch(source, /jest\.config\.cjs --passWithNoTests/);
  assert.doesNotMatch(source, /findRelatedTests/);

  const normalOnly = source.slice(source.indexOf("if (!fast)"));
  assert.match(normalOnly, /NORMAL_SCRIPT_TESTS/);
  assert.doesNotMatch(source, /check:egress/);
});
