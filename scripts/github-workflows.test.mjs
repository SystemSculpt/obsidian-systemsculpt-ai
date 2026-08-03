import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { normalizeLineEndings } from "./platform-portability.mjs";

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
const workflowNames = fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort();
const ci = normalizeLineEndings(
  fs.readFileSync(path.join(workflowsDir, "ci.yml"), "utf8"),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const nvmVersion = fs.readFileSync(path.join(process.cwd(), ".nvmrc"), "utf8").trim();
const workflow = parse(ci);

test("CI is the only hosted workflow", () => {
  assert.deepEqual(workflowNames, ["ci.yml"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["plugin", "compatibility", "required"]);
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "merge_group",
    "push",
    "workflow_dispatch",
  ]);
});

test("CI preserves a secret-free exhaustive Linux gate and compatibility matrix", () => {
  assert.match(ci, /^\s{2}plugin:$/m);
  assert.match(ci, /^\s{2}compatibility:$/m);
  assert.match(ci, /^\s{2}required:$/m);
  assert.equal((ci.match(/runs-on: ubuntu-latest/g) || []).length, 2);
  assert.doesNotMatch(ci, /secrets\.|pull_request_target|android|\bios\b/i);
  assert.doesNotMatch(ci, /native|provider|runtime.smoke|hosted/i);
  assert.match(ci, /^permissions:\n\s+contents: read$/m);
  assert.match(ci, /^\s{2}merge_group:$/m);
  assert.match(ci, /os: macos-latest/);
  assert.match(ci, /os: windows-latest/);
  assert.match(ci, /node: "22\.18\.0"/);
  assert.match(ci, /node: "24\.x"/);
  assert.match(ci, /fail-fast: false/);
  assert.doesNotMatch(ci, /continue-on-error:\s*true/);
  assert.equal(workflow.jobs.compatibility.strategy.matrix.include.length, 4);
  assert.deepEqual(workflow.jobs.required.needs, ["plugin", "compatibility"]);
  assert.equal(workflow.jobs.required.if, "${{ always() }}");
  assert.equal(workflow.jobs.required["runs-on"], "ubuntu-latest");
  assert.equal(workflow.jobs.required["timeout-minutes"], 2);
  assert.deepEqual(
    workflow.jobs.required.steps[0].env,
    {
      PLUGIN_RESULT: "${{ needs.plugin.result }}",
      COMPATIBILITY_RESULT: "${{ needs.compatibility.result }}",
    },
  );
  assert.match(workflow.jobs.required.steps[0].run, /PLUGIN_RESULT/);
  assert.match(workflow.jobs.required.steps[0].run, /COMPATIBILITY_RESULT/);
  assert.match(workflow.jobs.required.steps[0].run, /failure\|cancelled\|skipped/);
  assert.match(workflow.jobs.required.steps[0].run, /did not succeed/);
  assert.equal(
    workflow.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR,
    ".cache/ci-evidence/jest-seeds",
  );
  const pluginCheckStep = workflow.jobs.plugin.steps.find((step) => step.id === "run_check_ci");
  const compatibilityCheckStep = workflow.jobs.compatibility.steps.find((step) => step.id === "run_check_compat");
  const pluginVerifyStep = workflow.jobs.plugin.steps.find((step) => step.name === "Verify structured failure evidence");
  const compatibilityVerifyStep = workflow.jobs.compatibility.steps.find((step) => step.name === "Verify structured failure evidence");
  assert.equal(pluginCheckStep?.run, "npm run check:ci");
  assert.equal(compatibilityCheckStep?.run, "npm run check:compat");
  assert.equal(pluginCheckStep?.["timeout-minutes"], 13);
  assert.equal(compatibilityCheckStep?.["timeout-minutes"], 18);
  assert.ok(pluginCheckStep["timeout-minutes"] < workflow.jobs.plugin["timeout-minutes"]);
  assert.ok(compatibilityCheckStep["timeout-minutes"] < workflow.jobs.compatibility["timeout-minutes"]);
  assert.equal(pluginVerifyStep?.if, "${{ failure() && steps.run_check_ci.conclusion == 'failure' }}");
  assert.equal(compatibilityVerifyStep?.if, "${{ failure() && steps.run_check_compat.conclusion == 'failure' }}");
  assert.equal(pluginVerifyStep?.id, "verify_plugin_failure_evidence");
  assert.equal(
    compatibilityVerifyStep?.id,
    "verify_compatibility_failure_evidence",
  );
  for (const verifyStep of [pluginVerifyStep, compatibilityVerifyStep]) {
    assert.deepEqual(verifyStep?.env, {
      SYSTEMSCULPT_EXPECTED_GIT_SHA: "${{ github.sha }}",
      SYSTEMSCULPT_EXPECTED_RUNNER_ARCH: "${{ runner.arch }}",
      SYSTEMSCULPT_EXPECTED_RUNNER_OS: "${{ runner.os }}",
    });
  }
  assert.match(pluginVerifyStep?.run || "", /verify-ci-failure-evidence\.mjs --job plugin/);
  assert.match(compatibilityVerifyStep?.run || "", /verify-ci-failure-evidence\.mjs --job compatibility/);
  assert.ok(
    workflow.jobs.plugin.steps.findIndex((step) => step.id === "run_check_ci")
      < workflow.jobs.plugin.steps.findIndex((step) => step.name === "Verify structured failure evidence"),
  );
  assert.ok(
    workflow.jobs.plugin.steps.findIndex((step) => step.name === "Verify structured failure evidence")
      < workflow.jobs.plugin.steps.findIndex((step) => step.name === "Upload failure evidence"),
  );
  assert.ok(
    workflow.jobs.compatibility.steps.findIndex((step) => step.id === "run_check_compat")
      < workflow.jobs.compatibility.steps.findIndex((step) => step.name === "Verify structured failure evidence"),
  );
  assert.ok(
    workflow.jobs.compatibility.steps.findIndex((step) => step.name === "Verify structured failure evidence")
      < workflow.jobs.compatibility.steps.findIndex((step) => step.name === "Upload failure evidence"),
  );
  const pluginUploadStep = workflow.jobs.plugin.steps.find(
    (step) => step.name === "Upload failure evidence",
  );
  const compatibilityUploadStep = workflow.jobs.compatibility.steps.find(
    (step) => step.name === "Upload failure evidence",
  );
  const uploadSteps = [pluginUploadStep, compatibilityUploadStep];
  assert.equal(uploadSteps.length, 2);
  const uses = [
    ...workflow.jobs.plugin.steps,
    ...workflow.jobs.compatibility.steps,
  ]
    .map((step) => step.uses)
    .filter(Boolean);
  assert.deepEqual(uses, [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ]);
  for (const step of uploadSteps) {
    assert.ok(step);
    assert.equal(
      step.uses,
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    assert.equal(step.with["if-no-files-found"], "error");
    assert.equal(step.with["include-hidden-files"], true);
    assert.equal(step.with["retention-days"], 14);
    assert.match(step.with.path, /\.cache\/ci-evidence/);
    assert.match(step.with.path, /coverage-summary\.json/);
    assert.match(step.with.path, /main\.js/);
  }
  assert.equal(
    pluginUploadStep.if,
    "${{ always() && steps.verify_plugin_failure_evidence.conclusion == 'success' }}",
  );
  assert.equal(
    compatibilityUploadStep.if,
    "${{ always() && steps.verify_compatibility_failure_evidence.conclusion == 'success' }}",
  );
});

test("the hosted gate is the exact exhaustive local CI contract", () => {
  assert.equal(
    workflow.jobs.plugin.steps.find((step) => step.id === "run_check_ci")?.run,
    "npm run check:ci",
  );
  assert.equal(
    workflow.jobs.compatibility.steps.find((step) => step.id === "run_check_compat")?.run,
    "npm run check:compat",
  );
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
  assert.equal(packageJson.scripts["check:full"], "npm run check:ci");
  assert.doesNotMatch(ci, /desktop-baselines/);
});

test("local and hosted CI select the same Node LTS major", () => {
  assert.equal(nvmVersion, "22");
  assert.match(ci, /node-version: "22\.x"/);
});
