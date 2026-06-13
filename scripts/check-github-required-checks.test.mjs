import test from "node:test";
import assert from "node:assert/strict";

import {
  checkRequiredGithubChecks,
  evaluateRequiredChecks,
  parseArgs,
  parseGithubRepoFromRemote,
  selectLatestCheckRun,
} from "./check-github-required-checks.mjs";

test("parseArgs accepts repeated and comma-separated check names", () => {
  const parsed = parseArgs([
    "--name",
    "windows-e2e,desktop-baselines",
    "--name",
    "unit",
    "--repo",
    "SystemSculpt/obsidian-systemsculpt-ai",
    "--ref",
    "abc123",
    "--wait-timeout-ms",
    "60000",
    "--poll-interval-ms",
    "5000",
  ]);

  assert.deepEqual(parsed.names, ["windows-e2e", "desktop-baselines", "unit"]);
  assert.equal(parsed.repo, "SystemSculpt/obsidian-systemsculpt-ai");
  assert.equal(parsed.ref, "abc123");
  assert.equal(parsed.waitTimeoutMs, 60000);
  assert.equal(parsed.pollIntervalMs, 5000);
});

test("parseGithubRepoFromRemote recognizes HTTPS and SSH GitHub remotes", () => {
  assert.equal(
    parseGithubRepoFromRemote("https://github.com/SystemSculpt/obsidian-systemsculpt-ai.git"),
    "SystemSculpt/obsidian-systemsculpt-ai",
  );
  assert.equal(
    parseGithubRepoFromRemote("git@github.com:SystemSculpt/obsidian-systemsculpt-ai.git"),
    "SystemSculpt/obsidian-systemsculpt-ai",
  );
});

test("selectLatestCheckRun prefers the newest matching check by completed time", () => {
  const run = selectLatestCheckRun(
    [
      {
        id: 1,
        name: "windows-e2e",
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-06-13T10:00:00Z",
      },
      {
        id: 2,
        name: "windows-e2e",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-13T10:05:00Z",
      },
    ],
    "windows-e2e",
  );

  assert.equal(run?.id, 2);
  assert.equal(run?.conclusion, "success");
});

test("evaluateRequiredChecks separates success, missing, pending, and failed checks", () => {
  const evaluation = evaluateRequiredChecks(
    {
      check_runs: [
        { name: "unit", status: "completed", conclusion: "success" },
        { name: "windows-e2e", status: "in_progress", conclusion: null },
        { name: "desktop-baselines", status: "completed", conclusion: "failure" },
      ],
    },
    ["unit", "windows-e2e", "desktop-baselines", "release"],
  );

  assert.equal(evaluation.ok, false);
  assert.deepEqual(evaluation.missing.map((entry) => entry.name), ["release"]);
  assert.deepEqual(evaluation.pending.map((entry) => entry.name), ["windows-e2e"]);
  assert.deepEqual(evaluation.failed.map((entry) => entry.name), ["desktop-baselines"]);
});

test("checkRequiredGithubChecks polls pending checks until they pass", async () => {
  const calls = [];
  const result = await checkRequiredGithubChecks(
    {
      names: ["windows-e2e"],
      repo: "SystemSculpt/obsidian-systemsculpt-ai",
      ref: "abc123",
      waitTimeoutMs: 10_000,
      pollIntervalMs: 1_000,
    },
    {
      log() {},
      sleepImpl() {
        return Promise.resolve();
      },
      now() {
        return calls.length === 0 ? 0 : 1;
      },
      async fetchImpl({ repo, ref }) {
        calls.push({ repo, ref });
        return {
          check_runs: [
            calls.length === 1
              ? { name: "windows-e2e", status: "in_progress", conclusion: null }
              : { name: "windows-e2e", status: "completed", conclusion: "success" },
          ],
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test("checkRequiredGithubChecks fails red checks without retrying them", async () => {
  await assert.rejects(
    () =>
      checkRequiredGithubChecks(
        {
          names: ["windows-e2e"],
          repo: "SystemSculpt/obsidian-systemsculpt-ai",
          ref: "abc123",
          waitTimeoutMs: 10_000,
        },
        {
          log() {},
          async fetchImpl() {
            return {
              check_runs: [
                { name: "windows-e2e", status: "completed", conclusion: "failure" },
              ],
            };
          },
        },
      ),
    /windows-e2e: completed\/failure/,
  );
});
