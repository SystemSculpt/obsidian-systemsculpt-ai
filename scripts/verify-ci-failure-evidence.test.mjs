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
import { verifyCiFailureEvidence } from "./verify-ci-failure-evidence.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-ci-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "manifest.json"), '{"version":"6.2.6"}\n');
  fs.writeFileSync(path.join(root, "main.js"), "main bytes\n");
  fs.writeFileSync(path.join(root, "styles.css"), "style bytes\n");
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

test("verifies structured CI evidence sidecars for a failed gate", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind: "ci-build-failure",
    spawnSyncImpl: gitFixture,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: {
      ok: false,
      missingFiles: [],
      problems: ["simulated failure"],
      manifestMobileCompatible: true,
      files: {
        "manifest.json": { exists: true, sizeBytes: 20 },
        "main.js": { exists: true, sizeBytes: 11 },
        "styles.css": { exists: true, sizeBytes: 12 },
      },
      mainBundle: { hasInlineSourceMap: false, hasCanonicalApiBase: true },
    },
  });
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
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind: "ci-build-failure",
    spawnSyncImpl: gitFixture,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: {
      ok: false,
      missingFiles: [],
      problems: ["pre-jest failure"],
      manifestMobileCompatible: true,
      files: {
        "manifest.json": { exists: true, sizeBytes: 20 },
        "main.js": { exists: true, sizeBytes: 11 },
        "styles.css": { exists: true, sizeBytes: 12 },
      },
      mainBundle: { hasInlineSourceMap: false, hasCanonicalApiBase: true },
    },
  });

  const summary = verifyCiFailureEvidence({ root, job: "compatibility" });
  assert.equal(summary.jestPhaseStarted, false);
  assert.equal(summary.jestEvidenceCount, 0);
});

test("rejects a started hosted Jest phase that failed to record evidence", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind: "ci-build-failure",
    spawnSyncImpl: gitFixture,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: {
      ok: false,
      missingFiles: [],
      problems: ["simulated jest wrapper failure"],
      manifestMobileCompatible: true,
      files: {
        "manifest.json": { exists: true, sizeBytes: 20 },
        "main.js": { exists: true, sizeBytes: 11 },
        "styles.css": { exists: true, sizeBytes: 12 },
      },
      mainBundle: { hasInlineSourceMap: false, hasCanonicalApiBase: true },
    },
  });
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
    inspection: {
      ok: true,
      missingFiles: [],
      problems: [],
      manifestMobileCompatible: true,
      files: {},
      mainBundle: {},
    },
  });

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "compatibility" }),
    /Build provenance is missing/,
  );
});

test("rejects malformed nested hosted Jest evidence", (t) => {
  const root = fixture(t);
  withJestEvidenceDir(t, ".cache/ci-evidence/jest-seeds");
  writeBuildProvenance({
    root,
    version: "6.2.6",
    kind: "ci-build-failure",
    spawnSyncImpl: gitFixture,
  });
  writeArtifactInspectionEvidence({
    root,
    inspection: {
      ok: false,
      missingFiles: [],
      problems: [],
      manifestMobileCompatible: true,
      files: {},
      mainBundle: {},
    },
  });
  writeHostedJestPhaseMarker(root);
  const jestEvidenceDir = path.join(root, ".cache", "ci-evidence", "jest-seeds");
  fs.mkdirSync(jestEvidenceDir, { recursive: true });
  fs.writeFileSync(path.join(jestEvidenceDir, "jest-bad.json"), "{not json}\n");

  assert.throws(
    () => verifyCiFailureEvidence({ root, job: "plugin" }),
    /Jest evidence is not valid JSON/,
  );
});
