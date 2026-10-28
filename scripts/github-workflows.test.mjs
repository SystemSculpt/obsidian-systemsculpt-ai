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
const releaseMetadataSource = normalizeLineEndings(
  fs.readFileSync(path.join(workflowsDir, "publish-release-metadata.yml"), "utf8"),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const nvmVersion = fs.readFileSync(path.join(process.cwd(), ".nvmrc"), "utf8").trim();
const workflow = parse(ci);
const releaseMetadataWorkflow = parse(releaseMetadataSource);

test("hosted workflows separate secret-free CI from release publication", () => {
  assert.deepEqual(workflowNames, ["ci.yml", "publish-release-metadata.yml"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["required", "plugin", "compatibility"]);
  assert.deepEqual(Object.keys(workflow.on), [
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
});

test("only a published stable release can update first-party release metadata", () => {
  assert.deepEqual(releaseMetadataWorkflow.on, { release: { types: ["published"] } });
  assert.deepEqual(releaseMetadataWorkflow.permissions, { contents: "read" });
  assert.equal(releaseMetadataWorkflow.concurrency.group, "publish-release-metadata");
  assert.equal(releaseMetadataWorkflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(releaseMetadataWorkflow.jobs), ["verify", "publish"]);

  const releaseVerification = releaseMetadataWorkflow.jobs.verify;
  assert.equal(
    releaseVerification.if,
    "${{ github.event.release.draft == false && github.event.release.prerelease == false }}",
  );
  assert.deepEqual(releaseVerification.permissions, {
    contents: "read",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write",
  });
  assert.equal(releaseVerification["runs-on"], "ubuntu-latest");
  assert.equal(releaseVerification["timeout-minutes"], 20);
  assert.deepEqual(
    releaseVerification.steps.filter((step) => step.uses).map((step) => step.uses),
    [
      "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    ],
  );
  assert.equal(releaseVerification.steps[0].with.ref, "${{ github.event.release.tag_name }}");
  assert.equal(releaseVerification.steps[0].with["fetch-depth"], 0);
  assert.equal(releaseVerification.steps[1].with["node-version"], "22.x");
  assert.equal(releaseVerification.steps[1].with.cache, "npm");
  assert.equal(releaseVerification.steps[2].run, "npm ci --no-audit --no-fund");

  const build = releaseVerification.steps.find((step) => step.name === "Build tagged release");
  const compare = releaseVerification.steps.find((step) => step.name === "Compare published release assets");
  const attest = releaseVerification.steps.find((step) => step.name === "Attest exact published assets");
  assert.match(build.run, /git rev-parse HEAD/);
  assert.match(build.run, /release-plugin\.mjs/);
  assert.match(build.run, /--expected-revision=/);
  assert.match(build.run, /--expected-tag=/);
  assert.equal(compare.env.GH_TOKEN, "${{ github.token }}");
  assert.match(compare.run, /gh release download/);
  assert.match(compare.run, /for artifact in manifest\.json main\.js styles\.css/);
  assert.match(compare.run, /cmp --silent/);
  assert.match(compare.run, /sha256sum/);
  assert.match(attest.with["subject-path"], /published-release\/manifest\.json/);
  assert.match(attest.with["subject-path"], /published-release\/main\.js/);
  assert.match(attest.with["subject-path"], /published-release\/styles\.css/);

  const job = releaseMetadataWorkflow.jobs.publish;
  assert.equal(
    job.if,
    "${{ github.event.release.draft == false && github.event.release.prerelease == false }}",
  );
  assert.equal(job.needs, "verify");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.environment, "production-release-metadata");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 5);
  assert.deepEqual(job.steps.filter((step) => step.uses).map((step) => step.uses), [
    "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  ]);
  assert.equal(job.steps[0].with.ref, "${{ github.event.release.tag_name }}");

  const validate = job.steps.find((step) => step.name === "Validate release identity");
  const publish = job.steps.find((step) => step.name === "Publish release metadata");
  const verify = job.steps.find((step) => step.name === "Verify SystemSculpt release endpoint");
  assert.equal(validate.run, "node scripts/plugin-release-metadata.mjs --check");
  assert.match(publish.run, /plugin\/releases\/latest\.json/);
  assert.match(publish.run, /--assert-not-older=/);
  assert.match(publish.run, /list-objects-v2/);
  assert.match(publish.run, /Unexpected release metadata object count/);
  assert.match(publish.run, /--cache-control "no-store"/);
  assert.match(publish.env.AWS_ACCESS_KEY_ID, /secrets\.RELEASE_METADATA_R2_ACCESS_KEY_ID/);
  assert.match(publish.env.AWS_SECRET_ACCESS_KEY, /secrets\.RELEASE_METADATA_R2_SECRET_ACCESS_KEY/);
  assert.match(publish.env.R2_BUCKET_NAME, /vars\.RELEASE_METADATA_R2_BUCKET_NAME/);
  assert.match(publish.env.R2_ENDPOINT, /vars\.RELEASE_METADATA_R2_ENDPOINT/);
  assert.equal(
    verify.run,
    "node scripts/plugin-release-metadata.mjs --verify-url=https://systemsculpt.com/api/plugin/releases/latest",
  );
  assert.doesNotMatch(releaseMetadataSource, /pull_request_target|contents: write|GITHUB_TOKEN/);
});

test("PRs require lint, types, build, changed-area and money tests", () => {
  const job = workflow.jobs.required;
  assert.equal(job.if, "${{ github.event_name == 'pull_request' }}");
  assert.equal(job.needs, undefined);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.steps[0].with["fetch-depth"], 0);
  assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run), [
    "npm ci --no-audit --no-fund",
    "npm run check:plugin:fast",
    "npm run check:types",
    "npm run test:changed:ci",
  ]);
  assert.equal(packageJson.scripts["test:changed:ci"], "node scripts/test-changed.mjs");
  assert.doesNotMatch(ci, /secrets\.|pull_request_target|merge_group|ci-plan|evidence|Validated tree/);
  assert.deepEqual(workflow.permissions, { contents: "read" });
});

test("main and dispatch run the full suite and four compatibility lanes without aggregation", () => {
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  for (const name of ["plugin", "compatibility"]) {
    const job = workflow.jobs[name];
    assert.equal(job.if, "${{ github.event_name != 'pull_request' }}");
    assert.equal(job.needs, undefined);
    assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  }
  assert.equal(workflow.jobs.plugin.steps.at(-1).run, "npm run check:ci");
  assert.equal(workflow.jobs.compatibility.steps.at(-1).run, "npm run check:compat");
  assert.equal(workflow.jobs.compatibility.strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs.compatibility.strategy.matrix.include, [
    { os: "ubuntu-latest", node: "22.18.0" },
    { os: "ubuntu-latest", node: "24.x" },
    { os: "macos-latest", node: "22.x" },
    { os: "windows-latest", node: "22.x" },
  ]);
});

test("local and hosted CI select the same Node LTS major", () => {
  assert.equal(nvmVersion, "22");
  assert.match(ci, /node-version: "22\.x"/);
});
