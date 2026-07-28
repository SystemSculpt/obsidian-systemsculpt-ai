#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CI_EVIDENCE_DIRECTORY,
  HOSTED_JEST_PHASE_MARKER_FILE,
} from "./build-provenance.mjs";

const REQUIRED_ARTIFACTS = ["manifest.json", "main.js", "styles.css"];

function parseJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing at ${filePath}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertArtifactRecord(fileName, record, label) {
  if (!record || typeof record !== "object") {
    throw new Error(`${label} ${fileName} record is missing.`);
  }
  if (typeof record.exists !== "boolean") {
    throw new Error(`${label} ${fileName} must record exists as a boolean.`);
  }
  if (record.exists) {
    if (!Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) {
      throw new Error(`${label} ${fileName} must record a non-negative sizeBytes.`);
    }
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`${label} ${fileName} must record a sha256 hash.`);
    }
    return;
  }
  if (record.sizeBytes !== null || record.sha256 !== null) {
    throw new Error(`${label} ${fileName} must use null size and hash when absent.`);
  }
}

function assertJestEvidence(record, filePath) {
  if (record.schemaVersion !== 1) {
    throw new Error(`Jest evidence ${filePath} must use schemaVersion 1.`);
  }
  if (!Array.isArray(record.argv) || record.argv.length === 0) {
    throw new Error(`Jest evidence ${filePath} must record argv.`);
  }
  for (const field of ["recordedAt", "cwd", "nodeVersion", "platform", "arch"]) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error(`Jest evidence ${filePath} is missing ${field}.`);
    }
  }
  if (record.seed !== null && !Number.isInteger(record.seed)) {
    throw new Error(`Jest evidence ${filePath} must record an integer seed or null.`);
  }
}

function assertMutationEvidence(record, filePath) {
  if (record.schemaVersion !== 1) {
    throw new Error(`Mutation evidence ${filePath} must use schemaVersion 1.`);
  }
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    throw new Error(`Mutation evidence ${filePath} must record runId.`);
  }
  if (!Array.isArray(record.results)) {
    throw new Error(`Mutation evidence ${filePath} must record results.`);
  }
  if (!record.baseline || typeof record.baseline !== "object") {
    throw new Error(`Mutation evidence ${filePath} must record baseline state.`);
  }
  if (record.baseline.status !== "not_run") {
    if (!Array.isArray(record.baseline.argv) || record.baseline.argv.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record baseline argv once it runs.`);
    }
    if (typeof record.baseline.cwd !== "string" || record.baseline.cwd.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record baseline cwd once it runs.`);
    }
  }
  for (const result of record.results) {
    if (!Array.isArray(result?.argv) || result.argv.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record argv for every mutant run.`);
    }
    if (typeof result?.cwd !== "string" || result.cwd.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record cwd for every mutant run.`);
    }
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

function isFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function collectJestEvidenceState(root, evidenceRoot) {
  const configuredDirectory = process.env.SYSTEMSCULPT_TEST_EVIDENCE_DIR?.trim();
  const candidateDirectories = uniquePaths([
    configuredDirectory
      ? path.resolve(root, configuredDirectory)
      : path.join(evidenceRoot, "jest-seeds"),
    path.join(evidenceRoot, "jest-seeds"),
    evidenceRoot,
  ]);
  return Object.freeze({
    markerFiles: candidateDirectories
      .map((directory) => path.join(directory, HOSTED_JEST_PHASE_MARKER_FILE))
      .filter(isFile),
    jestEvidenceFiles: candidateDirectories.flatMap((directory) => {
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
      return fs.readdirSync(directory)
        .filter((entry) => entry !== HOSTED_JEST_PHASE_MARKER_FILE && /^jest-.*\.json$/.test(entry))
        .map((entry) => path.join(directory, entry));
    }),
  });
}

export function verifyCiFailureEvidence({
  root = process.cwd(),
  job = "plugin",
} = {}) {
  if (job !== "plugin" && job !== "compatibility") {
    throw new Error(`Unknown CI job ${job}. Expected plugin or compatibility.`);
  }

  const resolvedRoot = path.resolve(root);
  const evidenceRoot = path.join(resolvedRoot, DEFAULT_CI_EVIDENCE_DIRECTORY);
  const provenancePath = path.join(evidenceRoot, "release-provenance.json");
  const inspectionPath = path.join(evidenceRoot, "plugin-artifact-inspection.json");

  const provenance = parseJsonFile(provenancePath, "Build provenance");
  if (provenance.schemaVersion !== 1) {
    throw new Error("Build provenance must use schemaVersion 1.");
  }
  if (!["ci-build", "ci-build-failure"].includes(provenance.kind)) {
    throw new Error(`Build provenance kind must stay on a CI build variant, found ${provenance.kind}.`);
  }
  if (!provenance.git || typeof provenance.git !== "object") {
    throw new Error("Build provenance must record git identity.");
  }
  for (const fileName of REQUIRED_ARTIFACTS) {
    assertArtifactRecord(fileName, provenance.artifacts?.[fileName], "Build provenance");
  }

  const inspection = parseJsonFile(inspectionPath, "Artifact inspection");
  if (inspection.schemaVersion !== 1) {
    throw new Error("Artifact inspection must use schemaVersion 1.");
  }
  if (!Array.isArray(inspection.missingFiles) || !Array.isArray(inspection.problems)) {
    throw new Error("Artifact inspection must record missingFiles and problems arrays.");
  }

  const { markerFiles, jestEvidenceFiles } = collectJestEvidenceState(
    resolvedRoot,
    evidenceRoot,
  );
  for (const filePath of markerFiles) {
    assertJestEvidence(parseJsonFile(filePath, "Jest phase marker"), filePath);
  }
  if (markerFiles.length > 0 && jestEvidenceFiles.length === 0) {
    throw new Error("Hosted Jest phase started but recorded no Jest evidence JSON.");
  }
  jestEvidenceFiles.sort();
  for (const filePath of jestEvidenceFiles) {
    assertJestEvidence(parseJsonFile(filePath, "Jest evidence"), filePath);
  }

  const mutationEvidencePath = path.join(evidenceRoot, "chatview-critical-mutants.json");
  if (job === "plugin" && fs.existsSync(mutationEvidencePath)) {
    assertMutationEvidence(parseJsonFile(mutationEvidencePath, "Mutation evidence"), mutationEvidencePath);
  }

  return Object.freeze({
    evidenceRoot,
    provenancePath,
    inspectionPath,
    jestPhaseStarted: markerFiles.length > 0,
    jestEvidenceCount: jestEvidenceFiles.length,
    mutationEvidencePresent: job === "plugin" && fs.existsSync(mutationEvidencePath),
  });
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (direct) {
  try {
    const args = process.argv.slice(2);
    const jobIndex = args.findIndex((arg) => arg === "--job");
    const job = jobIndex >= 0 ? args[jobIndex + 1] : "plugin";
    if (jobIndex >= 0 && !job) throw new Error("--job requires a value.");
    const summary = verifyCiFailureEvidence({ job });
    console.log(
      `[ci-evidence] OK job=${job} jestPhaseStarted=${summary.jestPhaseStarted} jestEvidence=${summary.jestEvidenceCount} mutationEvidence=${summary.mutationEvidencePresent}`,
    );
  } catch (error) {
    console.error(`[ci-evidence] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
