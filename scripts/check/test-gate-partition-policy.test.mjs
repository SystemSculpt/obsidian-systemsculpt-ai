import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const base = require(path.join(root, "jest.config.cjs"));
const critical = require(path.join(root, "jest.chatview-critical-risk.config.cjs"));
const compat = require(path.join(root, "jest.chatview-critical-compat.config.cjs"));
const mobile = require(path.join(root, "jest.mobile-interactions.config.cjs"));
const unit = require(path.join(root, "jest.unit-ci.config.cjs"));

test("every focused gate points at test files that exist", () => {
  for (const config of [critical, mobile]) {
    for (const testPath of config.testMatch) {
      assert.equal(fs.existsSync(testPath.replace("<rootDir>", root)), true, testPath);
    }
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
});

test("the compatibility gate reuses the critical suites without repeating coverage work", () => {
  assert.equal(compat.displayName, "chatview-critical-compat");
  assert.deepEqual(compat.testMatch, critical.testMatch);
  assert.equal(compat.collectCoverage, false);
  assert.equal(compat.coverageThreshold, undefined);
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
