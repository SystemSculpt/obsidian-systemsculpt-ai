import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMutant,
  assertCuratedMutationTarget,
  buildJestInvocation,
  copyMutationMirror,
  createMutationEvidence,
  repositoryRelativePath,
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
      path.join("/tmp/mirror", "src/example.test.ts"),
    ],
  });
});

test("curated mutation targets must stay lexically within their root", () => {
  assert.throws(
    () => assertCuratedMutationTarget("/repo", "../outside.ts"),
    /must stay within/,
  );
});

test("mutation targets expose canonical repository paths on Windows", () => {
  assert.equal(
    repositoryRelativePath(
      "C:\\repo",
      "C:\\repo\\src\\services\\chat\\ManagedToolExecution.ts",
      path.win32,
    ),
    "src/services/chat/ManagedToolExecution.ts",
  );
});

test("applyMutant rejects a symlinked mirror root and leaves the external file untouched", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mutant-root-link-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const externalRoot = path.join(fixtureRoot, "outside");
  const targetRoot = path.join(fixtureRoot, "mirror");
  const curatedRelativePath = "src/services/chat/ManagedToolExecution.ts";
  const externalFile = path.join(externalRoot, curatedRelativePath);
  const original = "return recordValue(request?.function) ?? recordValue(record.function) ?? record;\n";
  fs.mkdirSync(path.dirname(externalFile), { recursive: true });
  fs.writeFileSync(externalFile, original, "utf8");
  fs.symlinkSync(externalRoot, targetRoot, "dir");

  assert.throws(
    () => applyMutant(
      {
        id: "reader_flat_shape_fallback_removed",
        file: curatedRelativePath,
        anchorLine: 1,
        anchorText: "return recordValue(request?.function) ?? recordValue(record.function) ?? record;",
        replacement: "return recordValue(request?.function) ?? recordValue(record.function);",
        testPaths: [],
      },
      { targetRoot },
    ),
    /root must not be a symlink/,
  );
  assert.equal(fs.readFileSync(externalFile, "utf8"), original);
});

test("copyMutationMirror accepts a regular curated target", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mutant-copy-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const sourceRoot = path.join(fixtureRoot, "repo");
  const targetRoot = path.join(fixtureRoot, "mirror");
  const curatedRelativePath = "src/services/chat/ManagedToolExecution.ts";
  const sourceFile = path.join(sourceRoot, curatedRelativePath);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "testing"), { recursive: true });
  fs.writeFileSync(sourceFile, "export const curated = true;\n", "utf8");

  copyMutationMirror({
    sourceRoot,
    targetRoot,
    entries: ["src", "testing"],
    mutants: [{ file: curatedRelativePath }],
  });

  const mirroredFile = path.join(targetRoot, curatedRelativePath);
  assert.equal(fs.readFileSync(mirroredFile, "utf8"), "export const curated = true;\n");
  assert.equal(fs.lstatSync(mirroredFile).isSymbolicLink(), false);
});

test("copyMutationMirror rejects a symlinked curated source target and leaves the external file untouched", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mutant-source-link-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const sourceRoot = path.join(fixtureRoot, "repo");
  const targetRoot = path.join(fixtureRoot, "mirror");
  const externalFile = path.join(fixtureRoot, "outside.ts");
  const curatedRelativePath = "src/services/chat/ManagedToolExecution.ts";
  const sourceFile = path.join(sourceRoot, curatedRelativePath);
  const original = "export const outside = 'safe';\n";
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "testing"), { recursive: true });
  fs.writeFileSync(externalFile, original, "utf8");
  fs.symlinkSync(externalFile, sourceFile);

  assert.throws(
    () => copyMutationMirror({
      sourceRoot,
      targetRoot,
      entries: ["src", "testing"],
      mutants: [{ file: curatedRelativePath }],
    }),
    /must not include symlinks/,
  );
  assert.equal(fs.readFileSync(externalFile, "utf8"), original);
  assert.equal(fs.existsSync(path.join(targetRoot, curatedRelativePath)), false);
});

test("applyMutant rejects a symlinked mirrored curated target and leaves the external file untouched", (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mutant-mirror-link-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const targetRoot = path.join(fixtureRoot, "mirror");
  const externalFile = path.join(fixtureRoot, "outside.ts");
  const curatedRelativePath = "src/services/chat/ManagedToolExecution.ts";
  const mirroredFile = path.join(targetRoot, curatedRelativePath);
  const original = "return recordValue(request?.function) ?? recordValue(record.function) ?? record;\n";
  fs.mkdirSync(path.dirname(mirroredFile), { recursive: true });
  fs.writeFileSync(externalFile, original, "utf8");
  fs.symlinkSync(externalFile, mirroredFile);

  assert.throws(
    () => applyMutant(
      {
        id: "reader_flat_shape_fallback_removed",
        file: curatedRelativePath,
        anchorLine: 1,
        anchorText: "return recordValue(request?.function) ?? recordValue(record.function) ?? record;",
        replacement: "return recordValue(request?.function) ?? recordValue(record.function);",
        testPaths: [],
      },
      { targetRoot },
    ),
    /must not include symlinks/,
  );
  assert.equal(fs.readFileSync(externalFile, "utf8"), original);
});
