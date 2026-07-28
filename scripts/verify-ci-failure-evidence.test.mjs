import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOSTED_JEST_PHASE_MARKER_FILE,
  writeArtifactInspectionEvidence,
  writeBuildProvenance,
  writeJsonEvidence,
} from "./build-provenance.mjs";
import { CHATVIEW_CRITICAL_MUTANTS } from "./check/chatview-critical-mutants.manifest.mjs";
import { CANONICAL_API_BASE_URL } from "./plugin-build-options.mjs";
import { inspectPluginArtifacts } from "./plugin-artifacts.mjs";
import { verifyCiFailureEvidence as verifyCiFailureEvidenceImpl } from "./verify-ci-failure-evidence.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-ci-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    '{"id":"systemsculpt-ai","version":"6.2.6","isDesktopOnly":false}\n',
  );
  fs.writeFileSync(
    path.join(root, "main.js"),
    `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\nconsole.log("main bytes");\n`,
  );
  fs.writeFileSync(path.join(root, "styles.css"), "body {}\n");
  return root;
}

function gitFixture(command, args) {
  assert.equal(command, "git");
  const operation = args.slice(2).join(" ");
  if (operation === "rev-parse HEAD") return { status: 0, stdout: "b".repeat(40) };
  if (operation === "branch --show-current") return { status: 0, stdout: "main\n" };
  if (operation === "status --porcelain --untracked-files=normal") return { status: 0, stdout: "" };
  return { status: 1, stdout: "" };
}

function verifyCiFailureEvidence(options) {
  return verifyCiFailureEvidenceImpl({
    environment: {},
    ...options,
    spawnSyncImpl: gitFixture,
  });
}

function withJestEvidenceDir(t, value) {
  const previous = process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR;
  process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR = value;
  t.after(() => {
    if (typeof previous === "string") process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR = previous;
    else delete process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR;
  });
}

function jestRecord(root) {
  return {
    schemaVersion: 1,
    recordedAt: "2026-07-28T12:00:00.000Z",
    seed: 123,
    cwd: root,
    argv: ["--config", "jest.config.cjs"],
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

function writeHostedJestPhaseMarker(root) {
  return writeJsonEvidence(
    path.join(root, ".cache", "ci-evidence", "jest-seeds", HOSTED_JEST_PHASE_MARKER_FILE),
    jestRecord(root),
  );
}

function writeHostedJestEvidence(root, fileName = "jest-proof.json") {
  return writeJsonEvidence(
    path.join(root, ".cache", "ci-evidence", "jest-seeds", fileName),
    jestRecord(root),
  );
}

function writeRecordedEvidence(
  root,
  kind = "ci-build-failure",
  spawnSyncImpl = gitFixture,
) {
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind,
    spawnSyncImpl,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: inspectPluginArtifacts({ root }),
  });
}

function writeMutationRecord(root, record) {
  return writeJsonEvidence(
    path.join(root, ".cache", "ci-evidence", "chatview-critical-mutants.json"),
    record,
  );
}

function mutationRecord({
  status = "passed",
  baselineStatus = "passed",
  results = CHATVIEW_CRITICAL_MUTANTS.map((mutant) => ({
    id: mutant.id,
    category: mutant.category,
    status: "killed",
    durationMs: 1,
    testPaths: [...mutant.testPaths],
    argv: ["node", "scripts/jest.mjs", "--runTestsByPath", ...mutant.testPaths],
    cwd: "/tmp/mirror",
    output: null,
  })),
  failure = null,
} = {}) {
  return {
    schemaVersion: 1,
    runId: "mutation-run",
    recordedAt: "2026-07-28T12:00:00.000Z",
    status,
    mutantsTotal: CHATVIEW_CRITICAL_MUTANTS.length,
    baseline: baselineStatus === "not_run"
      ? {
          status: "not_run",
          suiteCount: 0,
          argv: null,
          cwd: null,
          output: null,
        }
      : {
          status: baselineStatus,
          suiteCount: 3,
          argv: ["node", "scripts/jest.mjs"],
          cwd: "/tmp/mirror",
          output: null,
        },
    results,
    failure,
  };
}

test("verifies structured CI evidence sidecars for a failed gate", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeRecordedEvidence(root);
  writeHostedJestPhaseMarker(root);
  writeHostedJestEvidence(root);

  const summary = verifyCiFailureEvidence({ root, job: "plugin" });
  assert.equal(summary.jestPhaseStarted, true);
  assert.equal(summary.jestEvidenceCount, 1);
  assert.equal(summary.mutationEvidencePresent, false);
});

for (const job of ["plugin", "compatibility"]) {
  test(`accepts pre-Jest and pre-mutation ${job} failures`, (t) => {
    const root = fixture(t);
    withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
    writeRecordedEvidence(root);

    const summary = verifyCiFailureEvidence({ root, job });
    assert.equal(summary.jestPhaseStarted, false);
    assert.equal(summary.jestEvidenceCount, 0);
    assert.equal(summary.mutationEvidencePresent, false);
  });
}

test("rejects a started hosted Jest phase that failed to record evidence", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeRecordedEvidence(root);
  writeHostedJestPhaseMarker(root);

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /Hosted Jest phase started but recorded no Jest evidence JSON/,
  );
});

test("rejects missing provenance sidecars", (t) => {
  const root = fixture(t);
  writeArtifactInspectionEvidence({
    root,
    inspection: inspectPluginArtifacts({ root }),
  });

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /Build provenance is missing/,
  );
});

test("rejects provenance with an unresolved git revision", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const provenancePath = path.join(root, ".cache", "ci-evidence", "release-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  provenance.git.revision = "unknown";
  writeJsonEvidence(provenancePath, provenance);

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /must record a full git revision/,
  );
});

test("rejects provenance from a different git revision", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const provenancePath = path.join(root, ".cache", "ci-evidence", "release-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  provenance.git.revision = "a".repeat(40);
  writeJsonEvidence(provenancePath, provenance);

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /does not match recorded provenance revision/,
  );
});

test("rejects evidence when the current git revision cannot be resolved", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);

  assert.throws(
    () => verifyCiFailureEvidenceImpl({
      root,
      job: "compatibility",
      spawnSyncImpl: () => ({ status: 1, stdout: "" }),
    }),
    /Current git revision could not be resolved/,
  );
});

test("accepts evidence bound to the declared hosted SHA and runtime", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const runnerOs = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  }[process.platform];
  const runnerArch = {
    arm: "ARM",
    arm64: "ARM64",
    ia32: "X86",
    x64: "X64",
  }[process.arch];
  assert.ok(runnerOs);
  assert.ok(runnerArch);

  const summary = verifyCiFailureEvidence({
    root,
    job: "compatibility",
    environment: {
      GITHUB_ACTIONS: "true",
      SYSTEMSCULPT_EXPECTED_GIT_SHA: "b".repeat(40),
      SYSTEMSCULPT_EXPECTED_RUNNER_OS: runnerOs,
      SYSTEMSCULPT_EXPECTED_RUNNER_ARCH: runnerArch,
    },
  });
  assert.equal(summary.provenancePath.endsWith("release-provenance.json"), true);
});

test("rejects hosted evidence from a different workflow SHA", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);

  assert.throws(
    () => verifyCiFailureEvidence({
      root,
      job: "compatibility",
      environment: {
        GITHUB_ACTIONS: "true",
        SYSTEMSCULPT_EXPECTED_GIT_SHA: "a".repeat(40),
      },
    }),
    /does not match workflow revision/,
  );
});

test("rejects hosted evidence when the workflow SHA is unavailable", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);

  assert.throws(
    () => verifyCiFailureEvidence({
      root,
      job: "compatibility",
      environment: { GITHUB_ACTIONS: "true" },
    }),
    /requires the workflow Git revision/,
  );
});

test("rejects provenance captured from a dirty worktree", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root, "ci-build-failure", (command, args) => {
    const result = gitFixture(command, args);
    if (args.slice(2).join(" ") === "status --porcelain --untracked-files=normal") {
      return { status: 0, stdout: " M src/main.ts\n" };
    }
    return result;
  });

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /must come from a clean git worktree/,
  );
});

test("rejects evidence when the current worktree became dirty", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);

  assert.throws(
    () => verifyCiFailureEvidenceImpl({
      root,
      job: "compatibility",
      environment: {},
      spawnSyncImpl: (command, args) => {
        const result = gitFixture(command, args);
        if (args.slice(2).join(" ") === "status --porcelain --untracked-files=normal") {
          return { status: 0, stdout: " M src/main.ts\n" };
        }
        return result;
      },
    }),
    /Current git worktree must stay clean/,
  );
});

test("rejects provenance captured by a different Node runtime", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);

  assert.throws(
    () => verifyCiFailureEvidence({
      root,
      job: "compatibility",
      runtime: {
        nodeVersion: "v99.0.0",
        platform: process.platform,
        arch: process.arch,
      },
    }),
    /nodeVersion .* does not match current runtime/,
  );
});

test("rejects a declared runner OS that disagrees with Node", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const mismatchedRunnerOs = process.platform === "win32" ? "Linux" : "Windows";

  assert.throws(
    () => verifyCiFailureEvidence({
      root,
      job: "compatibility",
      environment: {
        SYSTEMSCULPT_EXPECTED_RUNNER_OS: mismatchedRunnerOs,
      },
    }),
    /does not match Node platform/,
  );
});

test("rejects a declared runner architecture that disagrees with Node", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const mismatchedRunnerArch = process.arch === "arm64" ? "X64" : "ARM64";

  assert.throws(
    () => verifyCiFailureEvidence({
      root,
      job: "compatibility",
      environment: {
        SYSTEMSCULPT_EXPECTED_RUNNER_ARCH: mismatchedRunnerArch,
      },
    }),
    /does not match Node architecture/,
  );
});

test("rejects malformed nested hosted Jest evidence", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeRecordedEvidence(root);
  writeHostedJestPhaseMarker(root);
  const jestEvidenceDir = path.join(root, ".cache", "ci-evidence", "jest-seeds");
  fs.mkdirSync(jestEvidenceDir, { recursive: true });
  fs.writeFileSync(path.join(jestEvidenceDir, "jest-bad.json"), "{not json}\n");

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "plugin" }),
    /Jest evidence is not valid JSON/,
  );
});

test("accepts complete terminal mutation evidence", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  writeMutationRecord(root, mutationRecord());

  const summary = verifyCiFailureEvidence({ root, job: "plugin" });
  assert.equal(summary.mutationEvidencePresent, true);
});

test("accepts an early mutation infrastructure failure before the baseline starts", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  writeMutationRecord(root, mutationRecord({
    status: "failed",
    baselineStatus: "not_run",
    results: [],
    failure: "Failed to create the isolated source mirror.",
  }));

  const summary = verifyCiFailureEvidence({ root, job: "plugin" });
  assert.equal(summary.mutationEvidencePresent, true);
});

test("rejects mutation evidence that claims success with missing results", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  writeMutationRecord(root, mutationRecord({ results: [] }));

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "plugin" }),
    /passed without a complete killed-mutant record/,
  );
});

test("rejects mutation evidence that omits a curated mutant", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  const record = mutationRecord();
  record.results[0] = {
    ...record.results[0],
    id: "not-the-curated-mutant",
  };
  writeMutationRecord(root, record);

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "plugin" }),
    /result 1 must be/,
  );
});

test("rejects non-terminal mutation evidence", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  writeMutationRecord(root, {
    ...mutationRecord(),
    status: "running",
  });

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "plugin" }),
    /must record a terminal status/,
  );
});

test("rejects a malformed current manifest after provenance capture", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  fs.writeFileSync(path.join(root, "manifest.json"), "{not json}\n");

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /Current manifest\.json is not valid JSON/,
  );
});

test("rejects a missing current artifact after provenance capture", (t) => {
  const root = fixture(t);
  writeRecordedEvidence(root);
  fs.rmSync(path.join(root, "main.js"));

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /Current main\.js no longer matches recorded build provenance/,
  );
});

for (const [fileName, replacement] of [
  ["manifest.json", '{"id":"systemsculpt-ai","version":"9.9.9","isDesktopOnly":false}\n'],
  ["main.js", `const SYSTEMSCULPT_API = ${JSON.stringify(CANONICAL_API_BASE_URL)};\nconsole.log("evil bytes");\n`],
  ["styles.css", "html {}\n"],
]) {
  test(`rejects a swapped ${fileName} after provenance capture`, (t) => {
    const root = fixture(t);
    writeRecordedEvidence(root);
    fs.writeFileSync(path.join(root, fileName), replacement);

    assert.throws(
      () => verifyCiFailureEvidence({ root, job: "compatibility" }),
      fileName === "manifest.json"
        ? /does not match recorded provenance version/
        : new RegExp(`Current ${fileName.replace(".", "\\.")} no longer matches recorded build provenance`),
    );
  });
}
