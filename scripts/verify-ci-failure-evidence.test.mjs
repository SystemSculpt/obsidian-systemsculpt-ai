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
  return verifyCiFailureEvidenceImpl({ ...options, spawnSyncImpl: gitFixture });
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

function writeRecordedEvidence(root, kind = "ci-build-failure") {
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind,
    spawnSyncImpl: gitFixture,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: inspectPluginArtifacts({ root }),
  });
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

test("accepts pre-Jest CI failures when no hosted Jest phase marker exists", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeRecordedEvidence(root);

  const summary = verifyCiFailureEvidence({ root, job: "compatibility" });
  assert.equal(summary.jestPhaseStarted, false);
  assert.equal(summary.jestEvidenceCount, 0);
});

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
