import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";

const WINDOWS_REPLACE_ERROR_CODES = new Set(["EACCES", "EEXIST", "EPERM"]);

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function toRepositoryPath(value) {
  return value.replace(/\\/g, "/");
}

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function nodeRequireInvocation(preloadPath, executableArgs = []) {
  return ["--require", preloadPath, ...executableArgs];
}

export function replaceFileAtomically(filePath, bytes, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const sleep = options.sleep || sleepSync;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? Math.max(0, options.maxRetries)
    : 8;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, options.retryDelayMs)
    : 25;
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.systemsculpt-replace-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const backupPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.systemsculpt-replace-${process.pid}-${randomBytes(6).toString("hex")}.bak`,
  );
  const recoverable = (error) =>
    platform === "win32" && WINDOWS_REPLACE_ERROR_CODES.has(error?.code);
  const retry = (operation) => {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        operation();
        return;
      } catch (error) {
        lastError = error;
        if (!recoverable(error) || attempt === maxRetries) throw error;
        sleep(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  };

  try {
    fsImpl.writeFileSync(tempPath, bytes);
    try {
      fsImpl.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (!recoverable(error)) throw error;
      if (!fsImpl.existsSync(filePath)) {
        retry(() => fsImpl.renameSync(tempPath, filePath));
        return;
      }
    }

    retry(() => fsImpl.renameSync(filePath, backupPath));
    try {
      retry(() => fsImpl.renameSync(tempPath, filePath));
    } catch (replacementError) {
      try {
        retry(() => fsImpl.renameSync(backupPath, filePath));
      } catch (restoreError) {
        throw new AggregateError(
          [replacementError, restoreError],
          `Could not replace ${filePath}; the previous file remains at ${backupPath}.`,
        );
      }
      throw replacementError;
    }
    fsImpl.rmSync(backupPath, { force: true });
  } finally {
    fsImpl.rmSync(tempPath, { force: true });
  }
}
