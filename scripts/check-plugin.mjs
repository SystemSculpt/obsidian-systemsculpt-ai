#!/usr/bin/env node

/**
 * Plugin checks have two intentionally different tiers:
 * - --fast: the canonical Obsidian lint, a production artifact build, CSS,
 *   and cheap architecture/policy tests
 * - default: the fast tier plus TypeScript, mobile, and release guards
 *
 * Full unit and integration work belong to their dedicated commands.
 */

import { exec, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildProductionPlugin } from "./plugin-artifacts.mjs";
import { inspectPluginArtifacts } from "./plugin-artifacts.mjs";
import { lintCssDirectory } from "./lint-css.mjs";
import {
  writeArtifactInspectionEvidence,
  writeBuildProvenance,
} from "./build-provenance.mjs";

const args = process.argv.slice(2);
const fast = args.includes("--fast");
const skipTests = args.includes("--skip-tests");
const root = process.cwd();
const defaultTimeoutMs = Number(process.env.SYSTEMSCULPT_CHECK_TIMEOUT_MS || "") || 20 * 60 * 1000;

const FAST_SCRIPT_TESTS = [
  "scripts/check-plugin.test.mjs",
  "scripts/verify-ci-failure-evidence.test.mjs",
  "scripts/chatview-critical-mutants.test.mjs",
  "scripts/check/chatview-critical-risk-policy.test.mjs",
  "scripts/check/chatview-critical-mutants-policy.test.mjs",
  "scripts/check/test-gate-partition-policy.test.mjs",
  "scripts/git-hooks.test.mjs",
  "scripts/github-workflows.test.mjs",
  "scripts/lint-css.test.mjs",
  "scripts/ui-architecture.test.mjs",
  "scripts/plugin-build-options.test.mjs",
  "scripts/check/managed-only-policy.test.mjs",
  "scripts/check/testid-coverage-policy.test.mjs",
  "scripts/e2e/generate-testid-catalog.test.mjs",
  "scripts/e2e/scenarios.test.mjs",
  "scripts/platform-portability.test.mjs",
];

const NORMAL_SCRIPT_TESTS = [
  "scripts/mobile-compatibility.test.mjs",
  "scripts/dev-watcher-service.test.mjs",
  "scripts/plugin-artifacts.test.mjs",
  "scripts/plugin-sync.test.mjs",
  "scripts/release-plugin.test.mjs",
  "scripts/e2e/driver-session.test.mjs",
];

function run(command, options = {}) {
  const startedAt = Date.now();
  try {
    const { timeoutMs = defaultTimeoutMs, ...execOptions } = options;
    const stdout = execSync(command, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: timeoutMs,
      ...execOptions,
    });
    return { ok: true, ms: Date.now() - startedAt, stdout };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      stdout: error.stdout?.toString?.() || "",
      stderr: error.stderr?.toString?.() || "",
      error,
    };
  }
}

function runAsync(command, options = {}) {
  const startedAt = Date.now();
  const { timeoutMs = defaultTimeoutMs, ...execOptions } = options;
  return new Promise((resolve) => {
    exec(command, {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      ...execOptions,
    }, (error, stdout, stderr) => {
      resolve(error
        ? { ok: false, ms: Date.now() - startedAt, stdout: stdout || "", stderr: stderr || "", error }
        : { ok: true, ms: Date.now() - startedAt, stdout: stdout || "" });
    });
  });
}

function checkCss() {
  const cssDir = path.join(root, "src", "css");
  if (!fs.existsSync(cssDir)) return { ok: true, ms: 0, note: "no-css" };

  const startedAt = Date.now();
  const report = lintCssDirectory({ cssDir });
  if (report.errorCount === 0) {
    return { ok: true, ms: Date.now() - startedAt, note: `${report.fileCount} files` };
  }

  const details = report.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.file}:${issue.line} ${issue.message} (selector: ${issue.selector})`)
    .join("\n");
  return {
    ok: false,
    ms: Date.now() - startedAt,
    stderr: `${report.errorCount} CSS error(s):\n${details}`,
  };
}

function checkBundle() {
  const startedAt = Date.now();
  try {
    const inspection = buildProductionPlugin({ root, stdio: "pipe" });
    writeArtifactInspectionEvidence({ root, inspection });
    const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
    writeBuildProvenance({ root, version, kind: "ci-build" });
    return {
      ok: true,
      ms: Date.now() - startedAt,
      stdout: inspection.mainBundle.formattedSize,
    };
  } catch (error) {
    try {
      const inspection = inspectPluginArtifacts({ root });
      writeArtifactInspectionEvidence({ root, inspection });
      const manifestFile = inspection.files["manifest.json"];
      const version = manifestFile?.isRegularFile
        ? JSON.parse(fs.readFileSync(manifestFile.path, "utf8")).version
        : "unknown";
      writeBuildProvenance({ root, version, kind: "ci-build-failure" });
    } catch {
      // The original build failure remains authoritative.
    }
    return {
      ok: false,
      ms: Date.now() - startedAt,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const startedAt = Date.now();
  // The Obsidian rules are type-aware, so running a second TypeScript program
  // beside them makes the edit loop slower through CPU contention. The fast
  // tier keeps the canonical Obsidian lint; the default/full tier adds tsc.
  const parallel = [
    runAsync("npm run check:plugin:obsidian").then((result) => ({ name: "obsidian", ...result })),
  ];

  if (!fast) {
    parallel.push(
      runAsync("npm run check:types").then((result) => ({ name: "types", ...result })),
    );
  }

  if (!skipTests) {
    parallel.push(
      runAsync(`node --test ${FAST_SCRIPT_TESTS.join(" ")}`)
        .then((result) => ({ name: "script-policy", ...result })),
    );
  }

  const results = [
    { name: "css", ...checkCss() },
    { name: "bundle", ...checkBundle() },
    ...await Promise.all(parallel),
  ];

  if (!fast) {
    results.push({
      name: "script-guards",
      ...run(`node --test ${NORMAL_SCRIPT_TESTS.join(" ")}`),
    });
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[plugin] FAIL: ${failure.name}`);
      console.error(failure.stderr || failure.stdout || "No diagnostic output.");
    }
    process.exit(1);
  }

  const elapsedMs = Date.now() - startedAt;
  const names = results.map((result) => result.name).join(", ");
  console.log(`[plugin] PASS${fast ? " [fast]" : ""}: ${names} (${(elapsedMs / 1000).toFixed(1)}s)`);
}

await main();
