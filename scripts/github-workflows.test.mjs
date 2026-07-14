import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
const workflowNames = fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort();
const ci = fs.readFileSync(path.join(workflowsDir, "ci.yml"), "utf8");

test("CI is the only hosted workflow", () => {
  assert.deepEqual(workflowNames, ["ci.yml"]);
});

test("CI preserves one secret-free Ubuntu plugin context", () => {
  assert.match(ci, /^\s{2}plugin:$/m);
  assert.equal((ci.match(/runs-on: ubuntu-latest/g) || []).length, 1);
  assert.doesNotMatch(ci, /secrets\.|pull_request_target|macos-|windows-|android|\bios\b/i);
  assert.doesNotMatch(ci, /native|provider|runtime.smoke|hosted/i);
});

test("the hosted gate is the same seconds-fast local check", () => {
  assert.match(ci, /npm run check/);
  assert.doesNotMatch(ci, /npm test|test:integration|desktop-baselines/);
});
