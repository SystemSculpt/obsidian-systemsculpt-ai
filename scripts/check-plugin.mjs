#!/usr/bin/env node

/**
 * Plugin checks have two intentionally different tiers:
 * - --fast: TypeScript, a production artifact build, CSS, and tiny policy tests
 * - default: the fast tier followed by broader bounded script guards
 *
 * Full unit and integration work belong to their dedicated commands.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildProductionPlugin } from "./plugin-artifacts.mjs";
import { lintCssDirectory } from "./lint-css.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const fast = args.includes("--fast");
const skipTests = args.includes("--skip-tests");
const root = process.cwd();
const defaultTimeoutMs = Number(process.env.SYSTEMSCULPT_CHECK_TIMEOUT_MS || "") || 20 * 60 * 1000;

const FAST_SCRIPT_TESTS = [
  "scripts/check-plugin.test.mjs",
  "scripts/github-workflows.test.mjs",
  "scripts/lint-css.test.mjs",
  "scripts/check/managed-only-policy.test.mjs",
];

const NORMAL_SCRIPT_TESTS = [
  "scripts/plugin-artifacts.test.mjs",
  "scripts/plugin-sync.test.mjs",
  "scripts/release-plugin.test.mjs",
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
    return {
      ok: true,
      ms: Date.now() - startedAt,
      stdout: inspection.mainBundle.formattedSize,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const results = [
    { name: "css", ...checkCss() },
    { name: "types", ...run("npm run check:types") },
    { name: "bundle", ...checkBundle() },
  ];

  if (!skipTests) {
    results.push({
      name: "script-policy",
      ...run(`node --test ${FAST_SCRIPT_TESTS.join(" ")}`),
    });
  }

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
      if (verbose || failure.name === "css") {
        console.error(failure.stderr || failure.stdout || "No diagnostic output.");
      }
    }
    process.exit(1);
  }

  const elapsedMs = results.reduce((total, result) => total + result.ms, 0);
  const names = results.map((result) => result.name).join(", ");
  console.log(`[plugin] PASS${fast ? " [fast]" : ""}: ${names} (${(elapsedMs / 1000).toFixed(1)}s)`);
}

await main();
