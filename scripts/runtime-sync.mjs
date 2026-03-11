import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RUNTIME_SYNC_STATE_FILE_NAME = ".systemsculpt-runtime-sync.json";
const RUNTIME_SYNC_SCHEMA = "systemsculpt.runtime-sync.v1";

function resolveStateFilePath(targetPath) {
  return path.join(targetPath, RUNTIME_SYNC_STATE_FILE_NAME);
}

function hashFileContents(absolutePath, hash) {
  if (!fs.existsSync(absolutePath)) {
    hash.update("missing\n");
    return;
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    hash.update(`non-file:${stats.mode}\n`);
    return;
  }

  hash.update(`${stats.size}:${Math.trunc(stats.mtimeMs)}\n`);
  hash.update(fs.readFileSync(absolutePath));
  hash.update("\n");
}

export function computeRuntimeSyncSignature(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || process.cwd()));
  const runtimePaths = Array.isArray(options.runtimePaths) ? options.runtimePaths : [];
  const signatureFiles = Array.isArray(options.signatureFiles) ? options.signatureFiles : [];
  const hash = createHash("sha256");

  hash.update(`${RUNTIME_SYNC_SCHEMA}\n`);
  hash.update("runtime-paths\n");
  runtimePaths.forEach((relativePath) => {
    hash.update(`${String(relativePath || "").trim()}\n`);
  });

  hash.update("signature-files\n");
  signatureFiles.forEach((relativePath) => {
    const normalizedPath = String(relativePath || "").trim();
    hash.update(`${normalizedPath}\n`);
    hashFileContents(path.join(rootDir, normalizedPath), hash);
  });

  return hash.digest("hex");
}

function readRuntimeSyncState(targetPath) {
  const statePath = resolveStateFilePath(targetPath);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRuntimeSyncState(targetPath) {
  fs.rmSync(resolveStateFilePath(targetPath), {
    force: true,
  });
}

export function runtimePathsNeedSync(options = {}) {
  const targetPath = path.resolve(String(options.targetPath || ""));
  const runtimePaths = Array.isArray(options.runtimePaths) ? options.runtimePaths : [];
  const sourceSignature = String(options.sourceSignature || "").trim();
  if (!targetPath || !sourceSignature) {
    return true;
  }

  const state = readRuntimeSyncState(targetPath);
  if (!state || state.schema !== RUNTIME_SYNC_SCHEMA || state.sourceSignature !== sourceSignature) {
    return true;
  }

  return runtimePaths.some((relativePath) => {
    const normalizedPath = String(relativePath || "").trim();
    if (!normalizedPath) {
      return false;
    }
    return !fs.existsSync(path.join(targetPath, normalizedPath));
  });
}

export function writeRuntimeSyncState(options = {}) {
  const targetPath = path.resolve(String(options.targetPath || ""));
  const sourceSignature = String(options.sourceSignature || "").trim();
  const runtimePaths = Array.isArray(options.runtimePaths) ? options.runtimePaths : [];
  if (!targetPath || !sourceSignature) {
    return;
  }

  fs.writeFileSync(
    resolveStateFilePath(targetPath),
    `${JSON.stringify(
      {
        schema: RUNTIME_SYNC_SCHEMA,
        sourceSignature,
        runtimePathCount: runtimePaths.length,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

