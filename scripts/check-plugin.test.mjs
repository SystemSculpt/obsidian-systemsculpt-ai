import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const source = fs.readFileSync(new URL("./check-plugin.mjs", import.meta.url), "utf8");
const jestRunner = fs.readFileSync(new URL("./jest.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("package scripts preserve fast edit and exhaustive verification tiers", () => {
  assert.equal(
    packageJson.scripts.check,
    "npm run check:plugin:fast && npm run test:mobile:interactions "
      + "&& npm run test:chatview:critical && npm run test:mobile:bundle",
  );
  assert.equal(
    packageJson.scripts["check:plugin:obsidian"],
    "npm run lint:obsidian && npm run lint:obsidian:meta && npm run lint:community",
  );
  assert.equal(
    packageJson.scripts["check:ci"],
    "npm run check:plugin && npm run test:mobile:interactions && npm run test:chatview:critical "
      + "&& npm run test:unit:ci && npm run test:embeddings:ci "
      + "&& npm run test:integration:ci",
  );
  assert.equal(
    packageJson.scripts["check:compat"],
    "npm run check:plugin:fast && npm run test:chatview:compat "
      + "&& npm run test:integration:ci",
  );
  assert.equal(
    packageJson.scripts["release:plugin"],
    "npm run check:ci && node scripts/release-plugin.mjs --require-clean --require-tag",
  );
  assert.match(packageJson.scripts["check:mobile"], /npm run test:mobile:interactions/);
  assert.match(packageJson.scripts["check:mobile"], /npm run test:mobile:bundle/);
  assert.equal(
    packageJson.scripts["test:unit:ci"],
    "node scripts/jest.mjs --strict-console --config jest.unit-ci.config.cjs --runInBand "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  assert.equal(
    packageJson.scripts["test:chatview:critical"],
    "node scripts/jest.mjs --strict-console --config jest.chatview-critical-risk.config.cjs "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  assert.equal(
    packageJson.scripts["test:chatview:compat"],
    "node scripts/jest.mjs --strict-console --config jest.chatview-critical-compat.config.cjs "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  assert.equal(
    packageJson.scripts["test:embeddings:ci"],
    "node scripts/jest.mjs --strict-console --config jest.embeddings.config.cjs --runInBand "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  assert.equal(
    packageJson.scripts["test:integration:ci"],
    "node scripts/jest.mjs --strict-console --config jest.integration.config.cjs --runInBand "
      + "--detectOpenHandles --openHandlesTimeout=1000 --randomize --showSeed",
  );
  assert.match(packageJson.scripts["test:leaks"], /--detectOpenHandles/);
});

test("fast plugin checks stay on the measured Obsidian-native tier", () => {
  assert.match(source, /const FAST_SCRIPT_TESTS = \[/);
  assert.match(source, /scripts\/verify-ci-failure-evidence\.test\.mjs/);
  assert.match(source, /scripts\/github-workflows\.test\.mjs/);
  assert.match(source, /scripts\/plugin-release-metadata\.test\.mjs/);
  assert.match(source, /scripts\/git-hooks\.test\.mjs/);
  assert.match(source, /scripts\/lint-css\.test\.mjs/);
  assert.match(source, /npm run check:plugin:obsidian/);
  assert.match(source, /buildProductionPlugin/);
  assert.match(source, /if \(!fast\) \{/);

  const fullOnly = source.slice(source.indexOf("if (!fast)"));
  assert.match(fullOnly, /npm run check:types/);
  // check:ci no longer repeats test:release-script, so the release-script
  // contracts must run in the default plugin tier.
  for (const guard of [
    "scripts/mobile-compatibility.test.mjs",
    "scripts/build-provenance.test.mjs",
    "scripts/plugin-build-options.test.mjs",
    "scripts/plugin-artifacts.test.mjs",
    "scripts/release-plugin.test.mjs",
  ]) {
    assert.ok(source.includes(guard), `${guard} must run inside check:plugin`);
  }
  for (const guard of [
    "scripts/mobile-compatibility.test.mjs",
    "scripts/build-provenance.test.mjs",
    "scripts/plugin-artifacts.test.mjs",
    "scripts/release-plugin.test.mjs",
  ]) {
    assert.ok(
      source.indexOf(guard) > source.indexOf("const NORMAL_SCRIPT_TESTS"),
      `${guard} belongs to the default plugin tier`,
    );
  }
});

test("fast plugin checks include the live managed policy and exclude unbounded Jest work", () => {
  assert.match(source, /scripts\/check\/managed-only-policy\.test\.mjs/);
  assert.doesNotMatch(source, /scripts\/live-chat-smoke\.test\.mjs/);
  assert.doesNotMatch(source, /testing\/native/);
  assert.doesNotMatch(source, /jest\.config\.cjs --passWithNoTests/);
  assert.doesNotMatch(source, /findRelatedTests/);
  assert.doesNotMatch(source, /test:ui:focused/);

  const normalOnly = source.slice(source.indexOf("if (!fast)"));
  assert.match(normalOnly, /NORMAL_SCRIPT_TESTS/);
});

test("randomized Jest gates print a replayable seed before the child starts", () => {
  assert.match(jestRunner, /SYSTEMSCULPT_TEST_SEED/);
  assert.match(jestRunner, /randomInt\(-2147483648, 2147483648\)/);
  assert.ok(
    jestRunner.indexOf("console.log(`[tests] Jest seed:")
      < jestRunner.indexOf("const child = spawn"),
  );
  assert.match(jestRunner, /SYSTEMSCULPT_TEST_EVIDENCE_DIR/);
  assert.match(jestRunner, /HOSTED_JEST_PHASE_MARKER_FILE/);
  assert.match(jestRunner, /schemaVersion: 1/);
  assert.match(jestRunner, /seed: replaySeed/);
  assert.match(jestRunner, /nodeRequireInvocation\(preload, \[jestBin, \.\.\.jestArgs\]\)/);
  assert.doesNotMatch(jestRunner, /requireFlag|nextNodeOptions/);
});

test("failing plugin subgates always emit their captured diagnostic output", () => {
  assert.match(
    source,
    /console\.error\(failure\.stderr \|\| failure\.stdout \|\| "No diagnostic output\."\)/,
  );
  assert.doesNotMatch(source, /if \(verbose \|\| failure\.name === "css"\)/);
});

test("bundle checks always emit structured inspection and provenance sidecars", () => {
  assert.match(source, /writeArtifactInspectionEvidence/);
  assert.match(source, /writeBuildProvenance/);
  assert.match(source, /inspectPluginArtifacts/);
  assert.match(source, /kind: "ci-build"/);
  assert.match(source, /kind: "ci-build-failure"/);
});

test("focused Jest gates point at test files that exist", () => {
  // Jest silently skips a testMatch entry that matches nothing, so a renamed
  // or deleted suite would otherwise drop out of the gate without failing it.
  for (const configFile of [
    "jest.chatview-critical-risk.config.cjs",
    "jest.mobile-interactions.config.cjs",
  ]) {
    const config = require(path.join(root, configFile));
    for (const testPath of config.testMatch) {
      const relative = testPath.replace(/^<rootDir>\//, "");
      assert.equal(
        fs.existsSync(path.join(root, relative)),
        true,
        `${configFile} names a missing suite: ${testPath}`,
      );
    }
  }
});
