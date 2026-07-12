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

test("CI preserves only the secret-free Ubuntu unit and desktop-baselines contexts", () => {
  assert.match(ci, /^\s{2}unit:$/m);
  assert.match(ci, /^\s{2}desktop-baselines:$/m);
  assert.equal((ci.match(/runs-on: ubuntu-latest/g) || []).length, 2);
  assert.doesNotMatch(ci, /secrets\.|pull_request_target|macos-|windows-|android|\bios\b/i);
  assert.doesNotMatch(ci, /native|provider|runtime.smoke|hosted/i);
});

test("unit and desktop-baselines own distinct canonical gates", () => {
  const desktopStart = ci.indexOf("  desktop-baselines:");
  const unit = ci.slice(ci.indexOf("  unit:"), desktopStart);
  const desktop = ci.slice(desktopStart);

  assert.match(unit, /npm run check:plugin:fast/);
  assert.doesNotMatch(unit, /npm test|npm run build|test:integration/);

  assert.match(desktop, /npm run build/);
  assert.match(desktop, /npm run test:integration:ci/);
  assert.doesNotMatch(desktop, /npm test|check:plugin/);
});
