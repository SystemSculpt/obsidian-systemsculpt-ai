import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// GitHub records step names with the successful job, so this proof survives
// PR merge-ref deletion and needs neither artifact downloads nor write tokens.
export function provesTree(jobs, tree) {
  const required = jobs.find((job) => job.name === "required");
  return required?.conclusion === "success"
    && required.steps?.some((step) => step.name === `Validated tree ${tree}`
      && step.conclusion === "success")
    && jobs.some((job) => job.name === "plugin" && job.conclusion === "success")
    && ["ubuntu-latest, 22.18.0", "ubuntu-latest, 24.x", "macos-latest, 22.x", "windows-latest, 22.x"]
      .every((lane) => jobs.some((job) => job.name === `compatibility (${lane})`
        && job.conclusion === "success"));
}

export async function findReusableRun({ event, sha, tree, repository, api }) {
  if (event !== "push" || !/^[a-f0-9]{40}$/.test(tree)) return null;
  try {
    const prefix = `repos/${repository}`;
    const pulls = await api(`${prefix}/commits/${sha}/pulls`);
    const candidates = pulls.filter((pr) => pr.merged_at && pr.merge_commit_sha === sha
      && pr.base.ref === "main" && pr.base.repo.full_name === repository)
      .map((pr) => ({ event: "pull_request", sha: pr.head.sha }));
    // A merge queue can publish its tested commit directly to main.
    candidates.push({ event: "merge_group", sha });
    for (const candidate of candidates) {
      const runs = await api(`${prefix}/actions/workflows/ci.yml/runs?event=${candidate.event}&head_sha=${candidate.sha}&status=success`, "workflow_runs");
      for (const run of runs) {
        if (run.status !== "completed" || run.conclusion !== "success"
          || run.event !== candidate.event || run.head_sha !== candidate.sha
          || run.path !== ".github/workflows/ci.yml"
          || run.repository.full_name !== repository) continue;
        const jobs = await api(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs");
        if (provesTree(jobs, tree)) return run.id;
      }
    }
  } catch {
    // Missing permissions, expired job records, or unavailable APIs must never
    // suppress validation. A full run remains the safe fallback.
    return null;
  }
  return null;
}

async function main() {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const api = async (route, key) => {
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", route], { encoding: "utf8" }));
    return pages.flatMap((page) => key ? page[key] : page);
  };
  const reuse = await findReusableRun({
    event: process.env.GITHUB_EVENT_NAME,
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    tree,
    api,
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree}\nreuse=${reuse ?? ""}\n`);
  const message = reuse
    ? `Identical tree ${tree} passed all CI lanes in run ${reuse}; reusing that result.`
    : `Running all CI lanes for tree ${tree}.`;
  console.log(message);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
