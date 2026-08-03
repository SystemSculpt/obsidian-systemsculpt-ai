import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./check-plugin.mjs", import.meta.url), "utf8");
const jestRunner = fs.readFileSync(new URL("./jest.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("package scripts preserve fast edit and exhaustive verification tiers", () => {
  assert.equal(
    packageJson.scripts.check,
    "npm run check:plugin:fast && npm run test:mobile:interactions "
      + "&& npm run test:chatview:critical && npm run test:thin-agent:endurance "
      + "&& npm run test:mobile:bundle",
  );
  assert.equal(packageJson.scripts["check:all"], "npm run check:full");
  assert.equal(
    packageJson.scripts["check:ci"],
    "npm run check:plugin && npm run test:mobile:interactions && npm run test:chatview:critical "
      + "&& npm run test:thin-agent:endurance && npm run test:chatview:mutants "
      + "&& npm run test:unit:ci && npm run test:embeddings:ci "
      + "&& npm run test:integration:ci && npm run test:release-script",
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
  assert.equal(packageJson.scripts["check:full"], "npm run check:ci");
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
    packageJson.scripts["test:chatview:mutants"],
    "node scripts/chatview-critical-mutants.mjs",
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
  assert.match(source, /scripts\/chatview-critical-mutants\.test\.mjs/);
  assert.match(source, /scripts\/github-workflows\.test\.mjs/);
  assert.match(source, /scripts\/check\/chatview-critical-risk-policy\.test\.mjs/);
  assert.match(source, /scripts\/check\/chatview-critical-mutants-policy\.test\.mjs/);
  assert.match(source, /scripts\/check\/test-gate-partition-policy\.test\.mjs/);
  assert.match(source, /scripts\/git-hooks\.test\.mjs/);
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
  assert.doesNotMatch(source, /scripts\/live-chat-smoke\.test\.mjs/);
  assert.doesNotMatch(source, /testing\/native/);
  assert.doesNotMatch(source, /jest\.config\.cjs --passWithNoTests/);
  assert.doesNotMatch(source, /findRelatedTests/);
  assert.doesNotMatch(source, /test:ui:focused/);
  assert.doesNotMatch(packageJson.scripts.check, /test:chatview:mutants/);
  assert.doesNotMatch(packageJson.scripts["check:compat"], /test:chatview:mutants/);

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
