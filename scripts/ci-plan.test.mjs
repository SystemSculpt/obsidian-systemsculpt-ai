import assert from "node:assert/strict";
import test from "node:test";
import { findReusableRun, provesTree } from "./ci-plan.mjs";

const tree = "a".repeat(40);
const repository = "SystemSculpt/obsidian-systemsculpt-ai";
const sha = "b".repeat(40);
const head = "c".repeat(40);
const jobs = () => [
  { name: "required", conclusion: "success", steps: [{ name: `Validated tree ${tree}`, conclusion: "success" }] },
  { name: "plugin", conclusion: "success" },
  ...["ubuntu-latest, 22.18.0", "ubuntu-latest, 24.x", "macos-latest, 22.x", "windows-latest, 22.x"]
    .map((lane) => ({ name: `compatibility (${lane})`, conclusion: "success" })),
];
const run = () => ({
  id: 405, run_attempt: 2, status: "completed", conclusion: "success", event: "pull_request",
  head_sha: head, path: ".github/workflows/ci.yml", repository: { full_name: repository },
});
const pull = () => ({
  merged_at: "2026-10-24", merge_commit_sha: sha,
  base: { ref: "main", repo: { full_name: repository } }, head: { sha: head },
});
function fixture({ runs = [run()], records = jobs(), pulls = [pull()] } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      event: "push", sha, tree, repository,
      api: async (route) => {
        calls.push(route);
        if (route.endsWith("/pulls")) return pulls;
        if (route.includes("event=merge_group")) return [];
        if (route.includes("/runs?")) return runs;
        if (route.endsWith("/attempts/2/jobs")) return records;
        throw new Error(`Unexpected API call: ${route}`);
      },
    },
  };
}

test("a merge or squash reuses the actual tested tree, not the different PR head SHA", async () => {
  const { options, calls } = fixture();
  assert.equal(await findReusableRun(options), 405);
  assert.ok(calls.some((route) => route.includes(`head_sha=${head}`)));
  assert.ok(calls.some((route) => route.endsWith("/runs/405/attempts/2/jobs")));
});

test("changed base, missing proof, or incomplete matrix requires full CI", async () => {
  assert.equal(await findReusableRun({ ...fixture().options, tree: "d".repeat(40) }), null);
  for (let index = 0; index < jobs().length; index += 1) {
    const records = jobs();
    records.splice(index, 1);
    assert.equal(await findReusableRun(fixture({ records }).options), null);
  }
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    for (let index = 0; index < jobs().length; index += 1) {
      const records = jobs();
      records[index].conclusion = conclusion;
      assert.equal(provesTree(records, tree), false);
    }
    const records = jobs();
    records[0].steps[0].conclusion = conclusion;
    assert.equal(provesTree(records, tree), false);
  }
});

test("only completed successful runs of this workflow and repository qualify", async () => {
  for (const change of [
    { status: "in_progress" }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { event: "push" }, { head_sha: sha }, { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/repo" } }, { run_attempt: 3 },
  ]) {
    assert.equal(await findReusableRun(fixture({ runs: [{ ...run(), ...change }] }).options), null);
  }
});

test("PR, merge-group, and manual events always run full CI without API calls", async () => {
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    const { options, calls } = fixture();
    assert.equal(await findReusableRun({ ...options, event }), null);
    assert.deepEqual(calls, []);
  }
});

test("direct pushes, unrelated PRs, and malformed or unavailable evidence fall back to full CI", async () => {
  for (const pulls of [[], [{ ...pull(), merged_at: null }], [{ ...pull(), merge_commit_sha: head }]]) {
    assert.equal(await findReusableRun(fixture({ pulls }).options), null);
  }
  assert.equal(await findReusableRun({ ...fixture().options, tree: "invalid" }), null);
  assert.equal(await findReusableRun({ ...fixture().options, api: async () => { throw new Error("API unavailable"); } }), null);
  assert.equal(await findReusableRun(fixture({ records: null }).options), null);
  assert.equal(await findReusableRun(fixture({ runs: [{ id: 1 }] }).options), null);
});

test("a merge queue's exact tested commit can be reused on main", async () => {
  const options = fixture({ pulls: [] }).options;
  const original = options.api;
  options.api = async (route) => route.includes("event=merge_group")
    ? [{ ...run(), event: "merge_group", head_sha: sha }]
    : original(route);
  assert.equal(await findReusableRun(options), 405);
});
