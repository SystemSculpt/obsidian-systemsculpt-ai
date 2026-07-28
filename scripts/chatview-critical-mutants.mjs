#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { CHATVIEW_CRITICAL_MUTANTS } from "./check/chatview-critical-mutants.manifest.mjs";
import {
  DEFAULT_CI_EVIDENCE_DIRECTORY,
  writeJsonEvidence,
} from "./build-provenance.mjs";

const root = process.cwd();
const cacheParent = path.join(root, ".cache", "chatview-mut");
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const runRoot = path.join(cacheParent, runId);
const mirrorRoot = path.join(runRoot, "mirror");
const jestWrapper = path.join(root, "scripts", "jest.mjs");
const jestConfig = path.join(root, "jest.chatview-mutants.config.cjs");
const maxBuffer = 16 * 1024 * 1024;

export function createMutationEvidence({
  runId: evidenceRunId = runId,
  recordedAt = new Date().toISOString(),
} = {}) {
  return {
    schemaVersion: 1,
    runId: evidenceRunId,
    recordedAt,
    status: "running",
    mutantsTotal: CHATVIEW_CRITICAL_MUTANTS.length,
    baseline: {
      status: "not_run",
      suiteCount: 0,
      argv: null,
      cwd: null,
      output: null,
    },
    results: [],
    failure: null,
  };
}

export function writeMutationEvidence({
  root: evidenceRoot = process.cwd(),
  record,
  outputPath,
} = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("Mutation evidence requires a record object.");
  }
  const destination = outputPath || path.join(
    path.resolve(evidenceRoot),
    DEFAULT_CI_EVIDENCE_DIRECTORY,
    "chatview-critical-mutants.json",
  );
  return Object.freeze({
    path: writeJsonEvidence(destination, record),
    record,
  });
}

export function buildJestInvocation(
  testPaths,
  {
    invocationRoot = mirrorRoot,
    wrapperPath = jestWrapper,
    configPath = jestConfig,
  } = {},
) {
  const absoluteTests = testPaths.map((testPath) => path.join(invocationRoot, testPath));
  return Object.freeze({
    cwd: invocationRoot,
    argv: [
      process.execPath,
      wrapperPath,
      "--strict-console",
      "--config",
      configPath,
      "--runInBand",
      "--no-cache",
      "--runTestsByPath",
      ...absoluteTests,
    ],
  });
}

export function locateMutationSpan(source, fileName, mutant) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const matches = [];
  const visit = (node) => {
    const start = node.getStart(sourceFile);
    const candidate = source.slice(start, node.end);
    if (candidate.replace(/\r\n/g, "\n") === mutant.anchorText.replace(/\r\n/g, "\n")) {
      matches.push({ start, end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(
      `${mutant.id} expected one AST anchor in ${fileName}, found ${matches.length}.`,
    );
  }
  const [{ start, end }] = matches;
  const line = source.slice(0, start).split(/\r?\n/).length;
  return { start, end, line };
}

export function assertMutationParses(source, fileName, mutantId) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (sourceFile.parseDiagnostics.length === 0) return;
  const diagnostic = sourceFile.parseDiagnostics[0];
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  throw new Error(`${mutantId} produced invalid TypeScript: ${message}`);
}

function copyMirror() {
  fs.mkdirSync(mirrorRoot, { recursive: true });
  for (const entry of ["src", "testing"]) {
    fs.cpSync(path.join(root, entry), path.join(mirrorRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

function runJest(testPaths) {
  const invocation = buildJestInvocation(testPaths);
  return spawnSync(
    invocation.argv[0],
    invocation.argv.slice(1),
    {
      cwd: invocation.cwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer,
      env: {
        ...process.env,
        SYSTEMSCULPT_MUTANT_ROOT: mirrorRoot,
        SYSTEMSCULPT_TEST_EVIDENCE_DIR: "",
      },
    },
  );
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function assertInfrastructureResult(result, label) {
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated by ${result.signal}.`);
  const output = commandOutput(result);
  if (/No tests found/i.test(output)) {
    throw new Error(`${label} did not discover its targeted tests.\n${output}`);
  }
  if (/Test suite failed to run|Syntax Error|SyntaxError|Expression expected/i.test(output)) {
    throw new Error(`${label} failed before semantic test execution.\n${output}`);
  }
}

function uniqueTestPaths() {
  return [...new Set(CHATVIEW_CRITICAL_MUTANTS.flatMap((mutant) => mutant.testPaths))].sort();
}

function applyMutant(mutant) {
  const filePath = path.join(mirrorRoot, mutant.file);
  const source = fs.readFileSync(filePath, "utf8");
  const span = locateMutationSpan(source, mutant.file, mutant);
  if (Math.abs(span.line - mutant.anchorLine) > 8) {
    throw new Error(
      `${mutant.id} moved from line ${mutant.anchorLine} to ${span.line}; review its intent.`,
    );
  }
  const replacement = source.includes("\r\n")
    ? mutant.replacement.replace(/\n/g, "\r\n")
    : mutant.replacement;
  const mutated = `${source.slice(0, span.start)}${replacement}${source.slice(span.end)}`;
  assertMutationParses(mutated, mutant.file, mutant.id);
  fs.writeFileSync(filePath, mutated);
  return () => fs.writeFileSync(filePath, source);
}

async function main() {
  const evidence = createMutationEvidence();
  fs.mkdirSync(cacheParent, { recursive: true });
  try {
    copyMirror();
    const targetedSuites = uniqueTestPaths();
    const baselineInvocation = buildJestInvocation(targetedSuites);
    const baseline = runJest(targetedSuites);
    try {
      assertInfrastructureResult(baseline, "Mutation baseline");
    } catch (error) {
      evidence.baseline = {
        status: "infrastructure_failure",
        suiteCount: targetedSuites.length,
        argv: [...baselineInvocation.argv],
        cwd: baselineInvocation.cwd,
        output: commandOutput(baseline) || null,
      };
      throw error;
    }
    if (baseline.status !== 0) {
      evidence.baseline = {
        status: "failed",
        suiteCount: targetedSuites.length,
        argv: [...baselineInvocation.argv],
        cwd: baselineInvocation.cwd,
        output: commandOutput(baseline) || null,
      };
      throw new Error(`Mutation baseline failed.\n${commandOutput(baseline)}`);
    }
    evidence.baseline = {
      status: "passed",
      suiteCount: targetedSuites.length,
      argv: [...baselineInvocation.argv],
      cwd: baselineInvocation.cwd,
      output: null,
    };
    console.log(`[mutants] BASELINE PASS: ${targetedSuites.length} targeted suites`);

    const survivors = [];
    for (const mutant of CHATVIEW_CRITICAL_MUTANTS) {
      const startedAt = Date.now();
      const invocation = buildJestInvocation(mutant.testPaths);
      const restore = applyMutant(mutant);
      let result;
      try {
        result = runJest(mutant.testPaths);
      } finally {
        restore();
      }
      const durationMs = Date.now() - startedAt;
      try {
        assertInfrastructureResult(result, mutant.id);
      } catch (error) {
        evidence.results.push({
          id: mutant.id,
          category: mutant.category,
          status: "infrastructure_failure",
          durationMs,
          testPaths: [...mutant.testPaths],
          argv: [...invocation.argv],
          cwd: invocation.cwd,
          output: commandOutput(result) || null,
        });
        throw error;
      }
      if (result.status === 0) {
        const output = commandOutput(result) || null;
        survivors.push({ mutant, output });
        evidence.results.push({
          id: mutant.id,
          category: mutant.category,
          status: "survived",
          durationMs,
          testPaths: [...mutant.testPaths],
          argv: [...invocation.argv],
          cwd: invocation.cwd,
          output,
        });
        console.error(`[mutants] SURVIVED: ${mutant.id}`);
      } else {
        evidence.results.push({
          id: mutant.id,
          category: mutant.category,
          status: "killed",
          durationMs,
          testPaths: [...mutant.testPaths],
          argv: [...invocation.argv],
          cwd: invocation.cwd,
          output: null,
        });
        console.log(`[mutants] KILLED: ${mutant.id} (${durationMs}ms)`);
      }
    }

    if (survivors.length > 0) {
      evidence.status = "survivor_failure";
      const details = survivors.map(({ mutant, output }) =>
        `${mutant.id}\n${output || "Targeted tests passed without diagnostic output."}`,
      ).join("\n\n");
      throw new Error(`${survivors.length} critical mutant(s) survived.\n\n${details}`);
    }
    evidence.status = "passed";
    console.log(`[mutants] PASS: ${CHATVIEW_CRITICAL_MUTANTS.length} of ${CHATVIEW_CRITICAL_MUTANTS.length} killed`);
  } catch (error) {
    if (evidence.status === "running") evidence.status = "failed";
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeMutationEvidence({ root, record: evidence });
  }
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (direct) {
  try {
    await main();
  } catch (error) {
    console.error(`[mutants] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
