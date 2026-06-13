#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 15_000;

function fail(message) {
  throw new Error(message);
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function splitNames(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    names: splitNames(env.SYSTEMSCULPT_REQUIRED_GITHUB_CHECKS || ""),
    repo: String(env.GITHUB_REPOSITORY || "").trim(),
    ref: String(env.GITHUB_SHA || "").trim(),
    waitTimeoutMs: numberOption(env.SYSTEMSCULPT_GITHUB_CHECK_WAIT_TIMEOUT_MS, 0),
    pollIntervalMs: numberOption(env.SYSTEMSCULPT_GITHUB_CHECK_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--name") {
      options.names.push(...splitNames(argv[index + 1]));
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      options.ref = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--wait-timeout-ms") {
      options.waitTimeoutMs = numberOption(argv[index + 1], options.waitTimeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Math.max(1000, numberOption(argv[index + 1], options.pollIntervalMs));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    fail(`Unknown argument: ${arg}`);
  }

  options.names = Array.from(new Set(options.names));
  return options;
}

function usage() {
  console.log(`Usage: node scripts/check-github-required-checks.mjs --name <check> [options]

Require one or more GitHub check runs to be successful for a commit.

Options:
  --name <check>              Required check name. May be repeated or comma-separated.
  --repo <owner/repo>         GitHub repository. Default: GITHUB_REPOSITORY or origin remote.
  --ref <sha-or-ref>          Commit SHA/ref. Default: GITHUB_SHA or HEAD.
  --wait-timeout-ms <n>       Poll until checks appear/pass. Default: 0.
  --poll-interval-ms <n>      Poll interval while waiting. Default: ${DEFAULT_POLL_INTERVAL_MS}.
  --help, -h                  Show this help.
`);
}

export function parseGithubRepoFromRemote(remoteUrl) {
  const text = String(remoteUrl || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) {
    return "";
  }
  return `${match[1]}/${match[2]}`;
}

function runText(command, args, spawnImpl = spawnSync) {
  const result = spawnImpl(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : "."}`);
  }
  return String(result.stdout || "").trim();
}

export function resolveDefaultRepo(dependencies = {}) {
  const env = dependencies.env || process.env;
  const spawnImpl = dependencies.spawnImpl || spawnSync;
  const githubRepository = String(env.GITHUB_REPOSITORY || "").trim();
  if (githubRepository) {
    return githubRepository;
  }

  try {
    const remoteUrl = runText("git", ["remote", "get-url", "origin"], spawnImpl);
    const repo = parseGithubRepoFromRemote(remoteUrl);
    if (repo) {
      return repo;
    }
  } catch {}

  try {
    return runText("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], spawnImpl);
  } catch {}

  return "";
}

export function resolveDefaultRef(dependencies = {}) {
  const env = dependencies.env || process.env;
  const spawnImpl = dependencies.spawnImpl || spawnSync;
  const githubSha = String(env.GITHUB_SHA || "").trim();
  if (githubSha) {
    return githubSha;
  }
  try {
    return runText("git", ["rev-parse", "HEAD"], spawnImpl);
  } catch {}
  return "";
}

function runJson(command, args, spawnImpl = spawnSync) {
  const raw = runText(command, args, spawnImpl);
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Failed to parse ${command} ${args.join(" ")} output as JSON: ${error.message}`);
  }
}

export function normalizeCheckRunsPayload(payload) {
  const runs = Array.isArray(payload?.check_runs)
    ? payload.check_runs
    : Array.isArray(payload)
      ? payload
      : [];
  return runs
    .filter((run) => run && typeof run === "object")
    .map((run) => ({
      id: Number(run.id) || 0,
      name: String(run.name || "").trim(),
      status: String(run.status || "").trim().toLowerCase(),
      conclusion: String(run.conclusion || "").trim().toLowerCase() || null,
      startedAt: String(run.started_at || run.startedAt || "").trim() || null,
      completedAt: String(run.completed_at || run.completedAt || "").trim() || null,
      htmlUrl: String(run.html_url || run.htmlUrl || "").trim() || null,
      detailsUrl: String(run.details_url || run.detailsUrl || "").trim() || null,
      workflowName: String(run.workflow_name || run.workflowName || "").trim() || null,
    }))
    .filter((run) => run.name);
}

function checkRunTimestamp(run) {
  const parsed = Date.parse(run.completedAt || run.startedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectLatestCheckRun(checkRuns, name) {
  const normalizedName = String(name || "").trim().toLowerCase();
  return normalizeCheckRunsPayload(checkRuns)
    .filter((run) => run.name.toLowerCase() === normalizedName)
    .sort((left, right) => {
      const timeDiff = checkRunTimestamp(right) - checkRunTimestamp(left);
      return timeDiff || Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}

export function evaluateRequiredChecks(payload, names) {
  const requiredNames = Array.from(new Set((Array.isArray(names) ? names : []).map((name) => String(name || "").trim()).filter(Boolean)));
  const runs = normalizeCheckRunsPayload(payload);
  const checks = requiredNames.map((name) => {
    const run = selectLatestCheckRun(runs, name);
    if (!run) {
      return { name, ok: false, state: "missing", run: null };
    }
    if (run.status !== "completed") {
      return { name, ok: false, state: "pending", run };
    }
    if (run.conclusion !== "success") {
      return { name, ok: false, state: "failed", run };
    }
    return { name, ok: true, state: "success", run };
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    missing: checks.filter((check) => check.state === "missing"),
    pending: checks.filter((check) => check.state === "pending"),
    failed: checks.filter((check) => check.state === "failed"),
  };
}

export function formatCheckResult(check) {
  if (!check.run) {
    return `${check.name}: missing`;
  }
  const conclusion = check.run.conclusion || "none";
  const url = check.run.htmlUrl || check.run.detailsUrl || "";
  return `${check.name}: ${check.run.status}/${conclusion}${url ? ` (${url})` : ""}`;
}

export function fetchGithubCheckRuns({ repo, ref, spawnImpl = spawnSync } = {}) {
  if (!repo) {
    fail("Missing GitHub repository. Pass --repo owner/name or configure an origin remote.");
  }
  if (!ref) {
    fail("Missing GitHub ref. Pass --ref or run from a git checkout.");
  }

  return runJson(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "--method",
      "GET",
      `repos/${repo}/commits/${ref}/check-runs`,
      "-f",
      "per_page=100",
    ],
    spawnImpl
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkRequiredGithubChecks(options = {}, dependencies = {}) {
  const names = Array.from(new Set((options.names || []).map((name) => String(name || "").trim()).filter(Boolean)));
  if (names.length < 1) {
    fail("At least one required check name is needed.");
  }

  const repo = String(options.repo || resolveDefaultRepo(dependencies)).trim();
  const ref = String(options.ref || resolveDefaultRef(dependencies)).trim();
  const waitTimeoutMs = numberOption(options.waitTimeoutMs, 0);
  const pollIntervalMs = Math.max(1000, numberOption(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  const fetchImpl = dependencies.fetchImpl || fetchGithubCheckRuns;
  const log = typeof dependencies.log === "function" ? dependencies.log : console.log.bind(console);
  const now = dependencies.now || (() => Date.now());
  const sleepImpl = dependencies.sleepImpl || sleep;
  const deadline = now() + waitTimeoutMs;
  let lastEvaluation = null;

  while (true) {
    const payload = await fetchImpl({ repo, ref, spawnImpl: dependencies.spawnImpl || spawnSync });
    const evaluation = evaluateRequiredChecks(payload, names);
    lastEvaluation = evaluation;

    for (const check of evaluation.checks) {
      log(`[github-checks] ${formatCheckResult(check)}`);
    }

    if (evaluation.ok) {
      return { repo, ref, ...evaluation };
    }

    const retryable = evaluation.missing.length > 0 || evaluation.pending.length > 0;
    if (!retryable || now() >= deadline) {
      break;
    }
    await sleepImpl(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }

  const failing = [
    ...(lastEvaluation?.missing || []),
    ...(lastEvaluation?.pending || []),
    ...(lastEvaluation?.failed || []),
  ];
  fail(`Required GitHub check did not pass for ${repo}@${ref}: ${failing.map(formatCheckResult).join("; ")}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  await checkRequiredGithubChecks(options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[github-checks] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
