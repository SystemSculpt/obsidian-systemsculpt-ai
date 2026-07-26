import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
const workflowNames = fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort();
const ci = fs.readFileSync(path.join(workflowsDir, "ci.yml"), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const nvmVersion = fs.readFileSync(path.join(process.cwd(), ".nvmrc"), "utf8").trim();

test("CI is the only hosted workflow", () => {
  assert.deepEqual(workflowNames, ["ci.yml"]);
});

test("CI preserves one secret-free Ubuntu plugin context", () => {
  assert.match(ci, /^\s{2}plugin:$/m);
  assert.equal((ci.match(/runs-on: ubuntu-latest/g) || []).length, 1);
  assert.doesNotMatch(ci, /secrets\.|pull_request_target|macos-|windows-|android|\bios\b/i);
  assert.doesNotMatch(ci, /native|provider|runtime.smoke|hosted/i);
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
});

test("the hosted gate is the exact exhaustive local CI contract", () => {
  const runCommands = Array.from(ci.matchAll(/^\s+- run: (npm run [^\n]+)$/gm), (match) => match[1]);
  assert.deepEqual(runCommands, [
    "npm run check:ci",
  ]);
  assert.equal(
    packageJson.scripts["check:ci"],
    "npm run check:plugin && npm test && npm run test:embeddings "
      + "&& npm run test:integration:ci && npm run test:release-script",
  );
  assert.equal(packageJson.scripts["check:full"], "npm run check:ci");
  assert.doesNotMatch(ci, /desktop-baselines/);
});

test("local and hosted CI select the same Node LTS major", () => {
  assert.equal(nvmVersion, "22");
  assert.match(ci, /node-version: "22\.x"/);
});
