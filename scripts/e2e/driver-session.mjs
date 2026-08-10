import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WebSocketServer } from "ws";
import { extractPluginArtifactId } from "../plugin-artifact-identity.mjs";

/**
 * CLI side of SystemSculptTestDriver/v1.
 *
 * The CLI hosts a localhost WebSocket server and writes a token handshake
 * file into the target plugin folder. The driver inside a development or
 * staging build of the plugin polls for that file and dials out; the plugin
 * never listens on a socket. One session drives one vault.
 */

export const HANDSHAKE_FILE = "e2e-driver.json";
export const PROTOCOL_VERSION = 1;
export const DRIVER_MARKER = "SystemSculptTestDriver/v1";
const WINDOWS_REPLACE_ERROR_CODES = new Set(["EACCES", "EEXIST", "EPERM"]);
const PLUGIN_API_BASE_PATTERN =
  /https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?\/api\/plugin\b/gi;
const HANDSHAKE_LOCK_TIMEOUT_MS = 5000;
const HANDSHAKE_LOCK_STALE_MS = 30000;
const HANDSHAKE_LOCK_RETRY_MS = 10;
const handshakeLockWait = new Int32Array(new SharedArrayBuffer(4));

function temporarySibling(filePath, kind) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${kind}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
}

function withHandshakeFileLock(filePath, operation) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
        fs.fsyncSync(descriptor);
      } catch (error) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.rmSync(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = fs.lstatSync(lockPath);
        if (Date.now() - lock.mtimeMs >= HANDSHAKE_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt >= HANDSHAKE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring handshake lock: ${lockPath}`);
      }
      Atomics.wait(handshakeLockWait, 0, 0, HANDSHAKE_LOCK_RETRY_MS);
    }
  }

  const owned = fs.fstatSync(descriptor);
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      const current = fs.lstatSync(lockPath);
      if (current.dev === owned.dev && current.ino === owned.ino) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

/** Atomically installs a private regular handshake without following an old symlink. */
export function writeHandshakeFileAtomically(filePath, handshake) {
  return withHandshakeFileLock(filePath, () => {
    const tempPath = temporarySibling(filePath, "tmp");
    let backupPath = null;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(handshake, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.chmodSync(tempPath, 0o600);
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        const replaceOnWindows = process.platform === "win32"
          && WINDOWS_REPLACE_ERROR_CODES.has(error?.code)
          && fs.existsSync(filePath);
        if (!replaceOnWindows) throw error;

        const existing = fs.lstatSync(filePath);
        if (!existing.isFile() && !existing.isSymbolicLink()) {
          throw new Error(`Handshake target must be a regular file or symlink: ${filePath}`);
        }
        backupPath = temporarySibling(filePath, "backup");
        fs.renameSync(filePath, backupPath);
        try {
          fs.renameSync(tempPath, filePath);
        } catch (replacementError) {
          try {
            fs.renameSync(backupPath, filePath);
            backupPath = null;
          } catch (restoreError) {
            throw new AggregateError(
              [replacementError, restoreError],
              `Could not replace ${filePath}; the previous handshake remains at ${backupPath}.`,
            );
          }
          throw replacementError;
        }
        fs.rmSync(backupPath, { force: true });
        backupPath = null;
      }

      const installed = fs.lstatSync(filePath);
      if (!installed.isFile() || installed.isSymbolicLink()) {
        throw new Error(`Handshake must be a regular file: ${filePath}`);
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  });
}

/** Removes only the handshake written by this session, never a newer session's file. */
export function removeOwnedHandshakeFile(filePath, { serverId, token }) {
  return withHandshakeFileLock(filePath, () => {
    try {
      const before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink()) return false;
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (value?.serverId !== serverId || value?.token !== token) return false;
      const after = fs.lstatSync(filePath);
      if (before.dev !== after.dev || before.ino !== after.ino) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  });
}

export function resolvePluginTarget({
  root = process.cwd(),
  explicitPath = "",
  vaultName = "",
} = {}) {
  if (explicitPath) {
    return { path: path.resolve(explicitPath), vault: path.basename(explicitPath) };
  }
  const configPath = path.join(root, "systemsculpt-sync.config.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Pass --plugin-dir <path-to-vault-plugin-folder> instead.",
    );
  }
  const targets = Array.isArray(parsed?.pluginTargets) ? parsed.pluginTargets : [];
  const normalized = targets
    .map((entry) => typeof entry === "string" ? { path: entry, vault: path.basename(entry) } : entry)
    .filter((entry) => entry && typeof entry.path === "string" && entry.path.length > 0);
  if (normalized.length === 0) {
    throw new Error("systemsculpt-sync.config.json has no pluginTargets; pass --plugin-dir.");
  }
  if (vaultName) {
    const match = normalized.find((entry) => entry.vault === vaultName);
    if (!match) {
      const known = normalized.map((entry) => entry.vault ?? entry.path).join(", ");
      throw new Error(`No pluginTarget named "${vaultName}". Known targets: ${known}.`);
    }
    return match;
  }
  return normalized[0];
}

export function expectedBuildStampFromTarget(pluginDir) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const id = manifest?.systemsculptDevBuild?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Resolves the immutable identity compiled into the exact installed main.js. */
export function expectedArtifactIdFromTarget(pluginDir) {
  let bundle;
  try {
    bundle = fs.readFileSync(path.join(pluginDir, "main.js"), "utf8");
  } catch {
    throw new Error("Unable to read the installed plugin JavaScript bundle.");
  }
  return extractPluginArtifactId(bundle);
}

/** Resolves the one API route compiled into the exact installed main.js. */
export function expectedApiBaseUrlFromTarget(pluginDir) {
  const mainPath = path.join(pluginDir, "main.js");
  let bundle;
  try {
    bundle = fs.readFileSync(mainPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read ${mainPath}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const apiBaseUrls = Array.from(new Set(
    (bundle.match(PLUGIN_API_BASE_PATTERN) ?? []).map((value) => value.replace(/\/+$/, "")),
  ));
  if (apiBaseUrls.length !== 1) {
    throw new Error(
      `Expected exactly one compiled SystemSculpt API base in ${mainPath}; found `
        + `${apiBaseUrls.length}: ${apiBaseUrls.join(", ") || "none"}.`,
    );
  }
  return apiBaseUrls[0];
}

function validateStepList(value, section, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} ${section} must be an array of action objects.`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const step = value[index];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${label} ${section}[${index}] must be an action object.`);
    }
    if (typeof step.action !== "string" || step.action.trim().length === 0) {
      throw new Error(`${label} ${section}[${index}] requires a non-empty action.`);
    }
    if (step.label !== undefined && typeof step.label !== "string") {
      throw new Error(`${label} ${section}[${index}] label must be a string.`);
    }
    if (
      step.params !== undefined
      && (!step.params || typeof step.params !== "object" || Array.isArray(step.params))
    ) {
      throw new Error(`${label} ${section}[${index}] params must be an object.`);
    }
    return step;
  });
}

/**
 * Normalizes legacy step arrays and cleanup-aware scenario objects.
 *
 * Arrays remain supported so every existing checked-in and ad-hoc scenario
 * keeps working. New scenarios can provide cleanup that the runner guarantees
 * from an outer finally block.
 */
export function validateScenario(value, label = "A scenario") {
  if (Array.isArray(value)) {
    return { steps: validateStepList(value, "steps", label), cleanup: [] };
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an action array or { steps: [...], cleanup: [...] }.`);
  }
  return {
    steps: validateStepList(value.steps, "steps", label),
    cleanup: validateStepList(value.cleanup ?? [], "cleanup", label),
  };
}

/**
 * Resolves every supported ESM scenario shape without silently dropping a
 * separately exported cleanup journey.
 */
export async function scenarioFromModule(module, label = "A scenario module") {
  const exported = module.default ?? module.scenario ?? module.steps;
  const resolvedExport = typeof exported === "function" ? await exported() : exported;
  const resolvedCleanup = typeof module.cleanup === "function"
    ? await module.cleanup()
    : module.cleanup;
  if (resolvedCleanup !== undefined && !Array.isArray(resolvedCleanup)) {
    throw new Error(`${label} cleanup export must resolve to an array of steps.`);
  }
  let scenario = resolvedExport;
  if (resolvedCleanup !== undefined) {
    if (Array.isArray(resolvedExport)) {
      scenario = { steps: resolvedExport, cleanup: resolvedCleanup };
    } else if (resolvedExport && typeof resolvedExport === "object") {
      scenario = {
        ...resolvedExport,
        cleanup: resolvedExport.cleanup === undefined
          ? resolvedCleanup
          : Array.isArray(resolvedExport.cleanup)
            ? [...resolvedExport.cleanup, ...resolvedCleanup]
            : resolvedExport.cleanup,
      };
    }
  }
  return validateScenario(scenario, label);
}

export class DriverSession {
  constructor({ pluginDir, connectTimeoutMs = 20000, actionTimeoutMs = 60000 }) {
    this.pluginDir = pluginDir;
    this.connectTimeoutMs = connectTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.serverId = crypto.randomUUID();
    this.token = crypto.randomUUID();
    this.handshakePath = path.join(pluginDir, HANDSHAKE_FILE);
    this.expectedArtifactId = null;
    this.server = null;
    this.socket = null;
    this.hello = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (!fs.existsSync(this.pluginDir)) {
      throw new Error(`Plugin folder does not exist: ${this.pluginDir}`);
    }
    // Capture executable provenance before granting the live process a socket.
    this.expectedArtifactId = expectedArtifactIdFromTarget(this.pluginDir);
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    const { port } = this.server.address();
    writeHandshakeFileAtomically(this.handshakePath, {
      version: PROTOCOL_VERSION,
      serverId: this.serverId,
      port,
      token: this.token,
      createdAt: new Date().toISOString(),
    });

    this.hello = await new Promise((resolve, reject) => {
      let claimedSocket = null;
      const timer = setTimeout(() => {
        reject(new Error(
          `No driver connected within ${this.connectTimeoutMs}ms. Is Obsidian running with a ` +
            "development or staging build of SystemSculpt AI (the release build excludes the driver)?",
        ));
      }, this.connectTimeoutMs);
      this.server.on("connection", (socket) => {
        socket.on("error", (error) => {
          if (this.socket === socket) this.failPending(error);
        });
        socket.on("close", () => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.failPending(new Error("The driver connection closed."));
        });
        if (this.socket) {
          socket.close(1008, "session already connected");
          return;
        }
        socket.once("message", (raw) => {
          let message;
          try {
            message = JSON.parse(String(raw));
          } catch {
            socket.close(1008, "invalid hello");
            return;
          }
          if (
            message?.type !== "hello" ||
            message.token !== this.token ||
            message.serverId !== this.serverId ||
            message.marker !== DRIVER_MARKER
          ) {
            socket.close(1008, "invalid hello");
            return;
          }
          // Re-read after the authenticated hello so a concurrent sync cannot
          // authorize the old in-memory driver against newly installed bytes.
          let expectedArtifactId;
          try {
            expectedArtifactId = expectedArtifactIdFromTarget(this.pluginDir);
          } catch (error) {
            claimedSocket = socket;
            clearTimeout(timer);
            socket.close(1008, "installed artifact invalid");
            reject(error);
            return;
          }
          this.expectedArtifactId = expectedArtifactId;
          if (message.artifactId !== expectedArtifactId) {
            claimedSocket = socket;
            clearTimeout(timer);
            socket.close(1008, "loaded artifact mismatch");
            reject(new Error(
              "Loaded plugin executable does not match the installed JavaScript bundle.",
            ));
            return;
          }
          if (this.socket || claimedSocket) {
            socket.close(1008, "session already connected");
            return;
          }
          claimedSocket = socket;
          clearTimeout(timer);
          this.socket = socket;
          socket.on("message", (data) => this.handleMessage(String(data)));
          resolve(message);
        });
      });
    });
    return this.hello;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message?.type !== "result" || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.message ?? "The driver reported an unknown error."));
  }

  failPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  run(action, params = {}) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("The driver session is not connected."));
    const id = this.nextId;
    this.nextId += 1;
    // A step may declare its own wait budget (waitFor timeoutMs); the session
    // timeout must always outlast it or long waits die at the transport.
    const declaredMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 0;
    const timeoutMs = declaredMs > 0
      ? Math.max(this.actionTimeoutMs, declaredMs + 5000)
      : this.actionTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try {
          if (this.socket === socket) {
            /** @type {import("../../src/testing/driver/protocol").TestDriverActionCancel} */
            const cancellation = { type: "cancel", id };
            socket.send(JSON.stringify(cancellation));
          }
        } catch {
          // The timeout remains authoritative if cancellation cannot be sent.
        }
        reject(new Error(`Driver action "${action}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "action", id, action, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      if (this.socket) this.socket.close(1000, "session complete");
    } catch {
      // Socket may already be closed.
    }
    try {
      if (this.server) this.server.close();
    } catch {
      // Server may already be closed.
    }
    try {
      removeOwnedHandshakeFile(this.handshakePath, {
        serverId: this.serverId,
        token: this.token,
      });
    } catch {
      // Handshake cleanup is best-effort.
    }
  }
}

/**
 * Captures what the app can still say about a failure, at the moment it fails.
 *
 * Without this, a failed step reports only its own timeout text, and
 * diagnosing it means re-running separate log and notice commands against an
 * app whose state has already moved on. Best-effort by design: a diagnostics
 * failure must never replace the original error.
 */
async function captureFailureDiagnostics(session) {
  const diagnostics = {};
  const collect = async (key, action, params) => {
    try { diagnostics[key] = await session.run(action, params); }
    catch (error) {
      diagnostics[`${key}Error`] = error instanceof Error ? error.message : String(error);
    }
  };
  await collect("logs", "logs", { level: "warn", limit: 40 });
  await collect("notices", "notices", { limit: 20 });
  await collect("chat", "snapshot", { scope: "chat" });
  return diagnostics;
}

export async function runSteps(session, steps) {
  const results = [];
  let failed = false;
  let blocked = false;
  let diagnostics = null;
  for (const [index, step] of steps.entries()) {
    const label = step.label ?? `${index + 1}. ${step.action}`;
    if (blocked && step.resumeAfterFailure !== true) {
      results.push({ label, action: step.action, skipped: true });
      continue;
    }
    if (step.resumeAfterFailure === true) blocked = false;
    const startedAt = Date.now();
    try {
      const result = await session.run(step.action, step.params ?? {});
      results.push({ label, action: step.action, ok: true, ms: Date.now() - startedAt, result });
    } catch (error) {
      failed = true;
      blocked = true;
      const failedStep = {
        label,
        action: step.action,
        ok: false,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(failedStep);
      const failureDiagnostics = await captureFailureDiagnostics(session);
      failedStep.diagnostics = failureDiagnostics;
      diagnostics ??= failureDiagnostics;
    }
  }
  return { ok: !failed, steps: results, ...(diagnostics ? { diagnostics } : {}) };
}

async function runCleanupSteps(session, steps) {
  const results = [];
  let failed = false;
  for (const [index, step] of steps.entries()) {
    const label = step.label ?? `cleanup ${index + 1}. ${step.action}`;
    const startedAt = Date.now();
    try {
      const result = await session.run(step.action, step.params ?? {});
      results.push({ label, action: step.action, ok: true, ms: Date.now() - startedAt, result });
    } catch (error) {
      failed = true;
      results.push({
        label,
        action: step.action,
        ok: false,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: !failed, steps: results };
}

/** Runs cleanup exactly once even when the primary runner throws unexpectedly. */
export async function runScenario(session, value) {
  const scenario = validateScenario(value);
  let outcome;
  let cleanupOutcome = { ok: true, steps: [] };
  try {
    outcome = await runSteps(session, scenario.steps);
  } finally {
    cleanupOutcome = await runCleanupSteps(session, scenario.cleanup);
  }
  return {
    ...outcome,
    ok: outcome.ok && cleanupOutcome.ok,
    cleanup: cleanupOutcome.steps,
  };
}
