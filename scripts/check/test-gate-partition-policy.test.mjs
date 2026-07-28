import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const base = require(path.join(root, "jest.config.cjs"));
const critical = require(path.join(root, "jest.chatview-critical-risk.config.cjs"));
const mobile = require(path.join(root, "jest.mobile-interactions.config.cjs"));
const unit = require(path.join(root, "jest.unit-ci.config.cjs"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const expectedMobileTests = [
  "<rootDir>/src/platform/__tests__/hostCapabilities.test.ts",
  "<rootDir>/src/platform/__tests__/mobileLayout.test.ts",
  "<rootDir>/src/platform/__tests__/mobileHostLayout.test.ts",
  "<rootDir>/src/core/ui/surface/__tests__/PluginSurface.test.ts",
  "<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts",
  "<rootDir>/src/views/chatview/__tests__/agent-workspace-css-contract.test.ts",
  "<rootDir>/src/views/chatview/__tests__/anchored-scroller.test.ts",
  "<rootDir>/src/views/__tests__/similar-notes-css-contract.test.ts",
  "<rootDir>/src/views/studio/__tests__/studio-node-insert-menu.test.ts",
  "<rootDir>/src/views/studio/__tests__/studio-run-host-preflight.test.ts",
  "<rootDir>/src/views/studio/__tests__/studio-context-menu-accessibility.test.ts",
  "<rootDir>/src/views/studio/graph-v3/__tests__/studio-surface-css-contract.test.ts",
  "<rootDir>/src/views/studio/graph-v3/__tests__/studio-graph-workspace-renderer-controls.test.ts",
  "<rootDir>/src/__tests__/systemsculpt-settings-tab.test.ts",
];

test("mobile interactions remain an explicit strict seeded gate", () => {
  assert.equal(mobile.displayName, "mobile-interactions");
  assert.equal(mobile.maxWorkers, 1);
  assert.deepEqual(mobile.testMatch, expectedMobileTests);
  assert.equal(mobile.collectCoverage, false);
  assert.equal(
    packageJson.scripts["test:mobile:interactions"],
    "node scripts/jest.mjs --strict-console --config jest.mobile-interactions.config.cjs "
      + "--runInBand --detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  for (const testPath of mobile.testMatch) {
    assert.equal(fs.existsSync(testPath.replace("<rootDir>", root)), true, testPath);
  }
});

test("the exhaustive unit remainder cannot rerun focused critical and mobile gates", () => {
  assert.equal(unit.displayName, "unit-ci-remainder");
  assert.equal(unit.maxWorkers, 1);
  assert.deepEqual(unit.testMatch, base.testMatch);
  assert.deepEqual(unit.testPathIgnorePatterns, [
    ...base.testPathIgnorePatterns,
    ...critical.testMatch,
    ...mobile.testMatch,
  ]);
  assert.equal(
    packageJson.scripts["test:unit:ci"],
    "node scripts/jest.mjs --strict-console --config jest.unit-ci.config.cjs --runInBand "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
});

test("focused CI gates pin their one intentional overlap and their ignores do not silently widen", () => {
  assert.deepEqual(
    critical.testMatch.filter((testPath) => mobile.testMatch.includes(testPath)),
    ["<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts"],
  );
  assert.equal(new Set(critical.testMatch).size, critical.testMatch.length);
  assert.equal(new Set(mobile.testMatch).size, mobile.testMatch.length);
  assert.deepEqual(
    unit.testPathIgnorePatterns.filter((pattern, index, values) => values.indexOf(pattern) !== index),
    ["<rootDir>/src/views/chatview/__tests__/agent-workspace-ui.test.ts"],
  );
});
