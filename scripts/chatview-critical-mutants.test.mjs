import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildJestInvocation,
  createMutationEvidence,
  writeMutationEvidence,
} from "./chatview-critical-mutants.mjs";

test("mutation evidence records structured status in the shared CI evidence directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mutant-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const record = createMutationEvidence({
    runId: "mutant-run",
    recordedAt: "2026-07-28T12:00:00.000Z",
  });
  record.status = "passed";
  record.baseline = {
    status: "passed",
    suiteCount: 3,
    argv: ["node", "scripts/jest.mjs"],
    cwd: "/tmp/mirror",
    output: null,
  };
  record.results.push({
    id: "example-mutant",
    category: "test",
    status: "killed",
    durationMs: 12,
    testPaths: ["src/example.test.ts"],
    argv: ["node", "scripts/jest.mjs", "--runTestsByPath", "/tmp/mirror/src/example.test.ts"],
    cwd: "/tmp/mirror",
    output: null,
  });

  const evidence = writeMutationEvidence({ root, record });
  const parsed = JSON.parse(fs.readFileSync(evidence.path, "utf8"));
  assert.equal(parsed.runId, "mutant-run");
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.results[0].status, "killed");
  assert.equal(parsed.baseline.argv[1], "scripts/jest.mjs");
});

test("mutation invocations record the exact child Jest command", () => {
  const invocation = buildJestInvocation(
    ["src/example.test.ts"],
    {
      invocationRoot: "/tmp/mirror",
      wrapperPath: "/repo/scripts/jest.mjs",
      configPath: "/repo/jest.chatview-mutants.config.cjs",
    },
  );
  assert.deepEqual(invocation, {
    cwd: "/tmp/mirror",
    argv: [
      process.execPath,
      "/repo/scripts/jest.mjs",
      "--strict-console",
      "--config",
      "/repo/jest.chatview-mutants.config.cjs",
      "--runInBand",
      "--no-cache",
      "--runTestsByPath",
      "/tmp/mirror/src/example.test.ts",
    ],
  });
});
