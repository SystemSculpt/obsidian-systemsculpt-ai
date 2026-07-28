#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  createArtifactInspectionEvidenceRecord,
  createBuildProvenance,
  DEFAULT_CI_EVIDENCE_DIRECTORY,
  HOSTED_JEST_PHASE_MARKER_FILE,
} from "./build-provenance.mjs";
import {
  inspectPluginArtifacts,
  REQUIRED_PLUGIN_ARTIFACTS,
} from "./plugin-artifacts.mjs";
import { CHATVIEW_CRITICAL_MUTANTS } from "./check/chatview-critical-mutants.manifest.mjs";

const FULL_GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUNNER_OS_TO_NODE_PLATFORM = Object.freeze({
  Linux: "linux",
  macOS: "darwin",
  Windows: "win32",
});
const RUNNER_ARCH_TO_NODE_ARCH = Object.freeze({
  ARM: "arm",
  ARM64: "arm64",
  X64: "x64",
  X86: "ia32",
});

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
  if (record.exists && record.isRegularFile === false) {
    if (record.sizeBytes !== null || record.sha256 !== null) {
      throw new Error(
        `${label} ${fileName} must not hash a non-regular artifact path.`,
      );
    }
    return;
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

function assertInspectionFileRecord(fileName, record, label) {
  if (!record || typeof record !== "object") {
    throw new Error(`${label} ${fileName} record is missing.`);
  }
  if (typeof record.exists !== "boolean") {
    throw new Error(`${label} ${fileName} must record exists as a boolean.`);
  }
  if (record.exists && record.isRegularFile === false) {
    if (record.sizeBytes !== null) {
      throw new Error(
        `${label} ${fileName} must not size a non-regular artifact path.`,
      );
    }
    return;
  }
  if (record.exists) {
    if (!Number.isInteger(record.sizeBytes) || record.sizeBytes < 0) {
      throw new Error(`${label} ${fileName} must record a non-negative sizeBytes.`);
    }
    return;
  }
  if (record.sizeBytes !== null) {
    throw new Error(`${label} ${fileName} must use null sizeBytes when absent.`);
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
  if (
    typeof record.recordedAt !== "string"
    || !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    throw new Error(`Mutation evidence ${filePath} must record a valid recordedAt timestamp.`);
  }
  if (!["passed", "failed", "survivor_failure"].includes(record.status)) {
    throw new Error(`Mutation evidence ${filePath} must record a terminal status.`);
  }
  if (record.mutantsTotal !== CHATVIEW_CRITICAL_MUTANTS.length) {
    throw new Error(
      `Mutation evidence ${filePath} must record all ${CHATVIEW_CRITICAL_MUTANTS.length} curated mutants.`,
    );
  }
  if (!Array.isArray(record.results)) {
    throw new Error(`Mutation evidence ${filePath} must record results.`);
  }
  if (!record.baseline || typeof record.baseline !== "object") {
    throw new Error(`Mutation evidence ${filePath} must record baseline state.`);
  }
  if (!["not_run", "passed", "failed", "infrastructure_failure"].includes(record.baseline.status)) {
    throw new Error(`Mutation evidence ${filePath} has an invalid baseline status.`);
  }
  if (!Number.isInteger(record.baseline.suiteCount) || record.baseline.suiteCount < 0) {
    throw new Error(`Mutation evidence ${filePath} must record a non-negative baseline suiteCount.`);
  }
  if (record.baseline.status === "not_run") {
    if (
      record.baseline.suiteCount !== 0
      || record.baseline.argv !== null
      || record.baseline.cwd !== null
    ) {
      throw new Error(
        `Mutation evidence ${filePath} must keep a not-run baseline empty.`,
      );
    }
  } else {
    if (!Array.isArray(record.baseline.argv) || record.baseline.argv.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record baseline argv once it runs.`);
    }
    if (typeof record.baseline.cwd !== "string" || record.baseline.cwd.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record baseline cwd once it runs.`);
    }
  }
  if (
    record.results.length > 0
    && record.baseline.status !== "passed"
  ) {
    throw new Error(
      `Mutation evidence ${filePath} cannot record mutant results before its baseline passes.`,
    );
  }
  if (record.results.length > CHATVIEW_CRITICAL_MUTANTS.length) {
    throw new Error(`Mutation evidence ${filePath} records more results than curated mutants.`);
  }
  for (const [index, result] of record.results.entries()) {
    const expectedMutant = CHATVIEW_CRITICAL_MUTANTS[index];
    if (result?.id !== expectedMutant.id) {
      throw new Error(
        `Mutation evidence ${filePath} result ${index + 1} must be ${expectedMutant.id}.`,
      );
    }
    if (result.category !== expectedMutant.category) {
      throw new Error(
        `Mutation evidence ${filePath} result ${result.id} has the wrong category.`,
      );
    }
    if (JSON.stringify(result.testPaths) !== JSON.stringify(expectedMutant.testPaths)) {
      throw new Error(
        `Mutation evidence ${filePath} result ${result.id} has the wrong targeted tests.`,
      );
    }
    if (!["killed", "survived", "infrastructure_failure"].includes(result.status)) {
      throw new Error(
        `Mutation evidence ${filePath} result ${result.id} has an invalid status.`,
      );
    }
    if (!Number.isInteger(result.durationMs) || result.durationMs < 0) {
      throw new Error(
        `Mutation evidence ${filePath} result ${result.id} must record a non-negative durationMs.`,
      );
    }
    if (!Array.isArray(result?.argv) || result.argv.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record argv for every mutant run.`);
    }
    if (typeof result?.cwd !== "string" || result.cwd.length === 0) {
      throw new Error(`Mutation evidence ${filePath} must record cwd for every mutant run.`);
    }
  }
  const hasFailure = typeof record.failure === "string" && record.failure.length > 0;
  if (record.status === "passed") {
    if (
      record.baseline.status !== "passed"
      || record.results.length !== CHATVIEW_CRITICAL_MUTANTS.length
      || record.results.some((result) => result.status !== "killed")
      || record.failure !== null
    ) {
      throw new Error(
        `Mutation evidence ${filePath} passed without a complete killed-mutant record.`,
      );
    }
    return;
  }
  if (!hasFailure) {
    throw new Error(`Mutation evidence ${filePath} must explain its terminal failure.`);
  }
  if (
    record.status === "survivor_failure"
    && (
      record.baseline.status !== "passed"
      || record.results.length !== CHATVIEW_CRITICAL_MUTANTS.length
      || !record.results.some((result) => result.status === "survived")
      || record.results.some((result) => result.status === "infrastructure_failure")
    )
  ) {
    throw new Error(
      `Mutation evidence ${filePath} must completely record every survivor.`,
    );
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

function isFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function configuredEnvironmentValue(environment, ...names) {
  for (const name of names) {
    const value = environment?.[name];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function assertRuntimeBinding({
  provenance,
  currentProvenance,
  environment,
  runtime,
}) {
  if (provenance.git.dirty !== false) {
    throw new Error("Build provenance must come from a clean git worktree.");
  }
  if (currentProvenance.git.dirty !== false) {
    throw new Error("Current git worktree must stay clean while verifying CI evidence.");
  }

  const expectedGitRevision = configuredEnvironmentValue(
    environment,
    "SYSTEMSCULPT_EXPECTED_GIT_SHA",
    "GITHUB_SHA",
  )?.toLowerCase();
  if (environment?.GITHUB_ACTIONS === "true" && !expectedGitRevision) {
    throw new Error("Hosted CI evidence requires the workflow Git revision.");
  }
  if (expectedGitRevision) {
    if (!FULL_GIT_REVISION.test(expectedGitRevision)) {
      throw new Error("Expected workflow Git revision must be a full Git hash.");
    }
    if (provenance.git.revision !== expectedGitRevision) {
      throw new Error(
        `Recorded provenance revision ${provenance.git.revision} does not match workflow revision ${expectedGitRevision}.`,
      );
    }
  }

  for (const [fieldName, currentValue] of [
    ["nodeVersion", runtime.nodeVersion],
    ["platform", runtime.platform],
    ["arch", runtime.arch],
  ]) {
    if (provenance[fieldName] !== currentValue) {
      throw new Error(
        `Build provenance ${fieldName} ${provenance[fieldName]} does not match current runtime ${currentValue}.`,
      );
    }
  }

  const declaredRunnerOs = configuredEnvironmentValue(
    environment,
    "SYSTEMSCULPT_EXPECTED_RUNNER_OS",
    "RUNNER_OS",
  );
  if (declaredRunnerOs) {
    const expectedPlatform = RUNNER_OS_TO_NODE_PLATFORM[declaredRunnerOs];
    if (!expectedPlatform) {
      throw new Error(`Unsupported declared runner OS ${declaredRunnerOs}.`);
    }
    if (runtime.platform !== expectedPlatform) {
      throw new Error(
        `Declared runner OS ${declaredRunnerOs} does not match Node platform ${runtime.platform}.`,
      );
    }
  }

  const declaredRunnerArch = configuredEnvironmentValue(
    environment,
    "SYSTEMSCULPT_EXPECTED_RUNNER_ARCH",
    "RUNNER_ARCH",
  );
  if (declaredRunnerArch) {
    const expectedArch = RUNNER_ARCH_TO_NODE_ARCH[declaredRunnerArch];
    if (!expectedArch) {
      throw new Error(`Unsupported declared runner architecture ${declaredRunnerArch}.`);
    }
    if (runtime.arch !== expectedArch) {
      throw new Error(
        `Declared runner architecture ${declaredRunnerArch} does not match Node architecture ${runtime.arch}.`,
      );
    }
  }
}

function assertCurrentArtifactBinding(
  resolvedRoot,
  provenance,
  inspection,
  spawnSyncImpl,
  environment,
  runtime,
) {
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  const currentManifest = parseJsonFile(manifestPath, "Current manifest.json");
  if (typeof currentManifest.version !== "string" || currentManifest.version.length === 0) {
    throw new Error("Current manifest.json must record a non-empty version.");
  }
  if (typeof provenance.version !== "string" || provenance.version.length === 0) {
    throw new Error("Build provenance must record a non-empty version.");
  }
  if (currentManifest.version !== provenance.version) {
    throw new Error(
      `Current manifest.json version ${currentManifest.version} does not match recorded provenance version ${provenance.version}.`,
    );
  }

  const currentProvenance = createBuildProvenance({
    root: resolvedRoot,
    version: currentManifest.version,
    spawnSyncImpl,
  });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(currentProvenance.git.revision)) {
    throw new Error("Current git revision could not be resolved.");
  }
  if (currentProvenance.git.revision !== provenance.git.revision) {
    throw new Error(
      `Current git revision ${currentProvenance.git.revision} does not match recorded provenance revision ${provenance.git.revision}.`,
    );
  }
  assertRuntimeBinding({
    provenance,
    currentProvenance,
    environment,
    runtime,
  });
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    const currentRecord = currentProvenance.artifacts?.[fileName];
    const recordedRecord = provenance.artifacts?.[fileName];
    if (!sameJson(currentRecord, recordedRecord)) {
      throw new Error(
        `Current ${fileName} no longer matches recorded build provenance.`,
      );
    }
  }

  const currentInspection = createArtifactInspectionEvidenceRecord({
    inspection: inspectPluginArtifacts({ root: resolvedRoot }),
    recordedAt: inspection.recordedAt,
  });
  if (!sameJson(currentInspection.missingFiles, inspection.missingFiles)) {
    throw new Error("Current missing artifact set does not match recorded artifact inspection.");
  }
  if (currentInspection.ok !== inspection.ok) {
    throw new Error("Current artifact inspection ok flag does not match recorded artifact inspection.");
  }
  if (currentInspection.manifestMobileCompatible !== inspection.manifestMobileCompatible) {
    throw new Error(
      "Current artifact inspection mobile-compatibility flag does not match recorded artifact inspection.",
    );
  }
  if (!inspection.mainBundle || typeof inspection.mainBundle !== "object") {
    throw new Error("Artifact inspection must record a mainBundle object.");
  }
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    const currentRecord = currentInspection.files?.[fileName];
    const recordedRecord = inspection.files?.[fileName];
    if (!sameJson(currentRecord, recordedRecord)) {
      throw new Error(
        `Current ${fileName} no longer matches recorded artifact inspection.`,
      );
    }
  }
  for (const [fieldName, recordedValue] of Object.entries(inspection.mainBundle)) {
    if (!sameJson(currentInspection.mainBundle?.[fieldName], recordedValue)) {
      throw new Error(
        `Current artifact inspection mainBundle.${fieldName} does not match recorded artifact inspection.`,
      );
    }
  }
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
  spawnSyncImpl = spawnSync,
  environment = process.env,
  runtime = Object.freeze({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }),
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
  if (typeof provenance.version !== "string" || provenance.version.length === 0) {
    throw new Error("Build provenance must record a non-empty version.");
  }
  if (!["ci-build", "ci-build-failure"].includes(provenance.kind)) {
    throw new Error(`Build provenance kind must stay on a CI build variant, found ${provenance.kind}.`);
  }
  if (!provenance.git || typeof provenance.git !== "object") {
    throw new Error("Build provenance must record git identity.");
  }
  if (!FULL_GIT_REVISION.test(provenance.git.revision)) {
    throw new Error("Build provenance must record a full git revision.");
  }
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    assertArtifactRecord(fileName, provenance.artifacts?.[fileName], "Build provenance");
  }

  const inspection = parseJsonFile(inspectionPath, "Artifact inspection");
  if (inspection.schemaVersion !== 1) {
    throw new Error("Artifact inspection must use schemaVersion 1.");
  }
  if (typeof inspection.ok !== "boolean") {
    throw new Error("Artifact inspection must record ok as a boolean.");
  }
  if (typeof inspection.manifestMobileCompatible !== "boolean") {
    throw new Error("Artifact inspection must record manifestMobileCompatible as a boolean.");
  }
  if (!Array.isArray(inspection.missingFiles) || !Array.isArray(inspection.problems)) {
    throw new Error("Artifact inspection must record missingFiles and problems arrays.");
  }
  if (!inspection.files || typeof inspection.files !== "object") {
    throw new Error("Artifact inspection must record file entries.");
  }
  for (const fileName of REQUIRED_PLUGIN_ARTIFACTS) {
    assertInspectionFileRecord(fileName, inspection.files[fileName], "Artifact inspection");
  }

  assertCurrentArtifactBinding(
    resolvedRoot,
    provenance,
    inspection,
    spawnSyncImpl,
    environment,
    runtime,
  );

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
