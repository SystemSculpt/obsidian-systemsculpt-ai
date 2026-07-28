import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { REQUIRED_PLUGIN_ARTIFACTS } from "./plugin-artifacts.mjs";
import { replaceFileAtomically } from "./platform-portability.mjs";

export const DEFAULT_CI_EVIDENCE_DIRECTORY = ".cache/ci-evidence";
export const HOSTED_JEST_PHASE_MARKER_FILE = "hosted-jest-phase-started.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitOutput(root, args, spawnSyncImpl) {
  const result = spawnSyncImpl("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result?.error || result?.status !== 0) return null;
  return String(result.stdout || "").trim();
}

function artifactRecord(root, fileName) {
  const filePath = path.join(root, fileName);
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({
      exists: false,
      isRegularFile: false,
      isSymbolicLink: false,
      sizeBytes: null,
      sha256: null,
    });
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return Object.freeze({
      exists: true,
      isRegularFile: false,
      isSymbolicLink: stats.isSymbolicLink(),
      sizeBytes: null,
      sha256: null,
    });
  }
  const bytes = fs.readFileSync(filePath);
  return Object.freeze({
    exists: true,
    isRegularFile: true,
    isSymbolicLink: false,
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

export function createBuildProvenance({
  root = process.cwd(),
  version = "unknown",
  kind = "ci-build",
  recordedAt = new Date().toISOString(),
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const revision = gitOutput(resolvedRoot, ["rev-parse", "HEAD"], spawnSyncImpl);
  const branch = gitOutput(resolvedRoot, ["branch", "--show-current"], spawnSyncImpl);
  const status = gitOutput(
    resolvedRoot,
    ["status", "--porcelain", "--untracked-files=normal"],
    spawnSyncImpl,
  );
  return Object.freeze({
    schemaVersion: 1,
    kind,
    version,
    recordedAt,
    nodeVersion,
    platform,
    arch,
    git: Object.freeze({
      revision: revision || "unknown",
      branch: branch || "detached",
      dirty: status === null ? null : status.length > 0,
    }),
    artifacts: Object.freeze(Object.fromEntries(
      REQUIRED_PLUGIN_ARTIFACTS.map((fileName) => [
        fileName,
        artifactRecord(resolvedRoot, fileName),
      ]),
    )),
  });
}

export function writeJsonEvidence(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  replaceFileAtomically(resolvedPath, `${JSON.stringify(value, null, 2)}\n`);
  return resolvedPath;
}

export function writeBuildProvenance(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const record = createBuildProvenance({ ...options, root });
  const outputPath = options.outputPath || path.join(
    root,
    DEFAULT_CI_EVIDENCE_DIRECTORY,
    "release-provenance.json",
  );
  return Object.freeze({
    path: writeJsonEvidence(outputPath, record),
    record,
  });
}

export function createArtifactInspectionEvidenceRecord({
  inspection,
  recordedAt = new Date().toISOString(),
} = {}) {
  if (!inspection || typeof inspection !== "object") {
    throw new Error("Artifact inspection evidence requires an inspection object.");
  }
  const mainBundle = { ...(inspection.mainBundle || {}) };
  delete mainBundle.path;
  return Object.freeze({
    schemaVersion: 1,
    recordedAt,
    ok: inspection.ok === true,
    missingFiles: [...(inspection.missingFiles || [])],
    problems: [...(inspection.problems || [])],
    manifestMobileCompatible: inspection.manifestMobileCompatible === true,
    files: Object.freeze(Object.fromEntries(
      Object.entries(inspection.files || {}).map(([fileName, file]) => [
        fileName,
        {
          exists: file?.exists === true,
          isRegularFile: file?.isRegularFile === true,
          isSymbolicLink: file?.isSymbolicLink === true,
          sizeBytes: typeof file?.sizeBytes === "number" ? file.sizeBytes : null,
        },
      ]),
    )),
    mainBundle: Object.freeze(mainBundle),
  });
}

export function writeArtifactInspectionEvidence({
  root = process.cwd(),
  inspection,
  recordedAt = new Date().toISOString(),
  outputPath,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const record = createArtifactInspectionEvidenceRecord({
    inspection,
    recordedAt,
  });
  const destination = outputPath || path.join(
    resolvedRoot,
    DEFAULT_CI_EVIDENCE_DIRECTORY,
    "plugin-artifact-inspection.json",
  );
  return Object.freeze({
    path: writeJsonEvidence(destination, record),
    record,
  });
}
