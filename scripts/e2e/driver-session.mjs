import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WebSocketServer } from "ws";

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

export class DriverSession {
  constructor({ pluginDir, connectTimeoutMs = 20000, actionTimeoutMs = 60000 }) {
    this.pluginDir = pluginDir;
    this.connectTimeoutMs = connectTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.serverId = crypto.randomUUID();
    this.token = crypto.randomUUID();
    this.handshakePath = path.join(pluginDir, HANDSHAKE_FILE);
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
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    const { port } = this.server.address();
    fs.writeFileSync(this.handshakePath, JSON.stringify({
      version: PROTOCOL_VERSION,
      serverId: this.serverId,
      port,
      token: this.token,
      createdAt: new Date().toISOString(),
    }, null, 2));

    this.hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `No driver connected within ${this.connectTimeoutMs}ms. Is Obsidian running with a ` +
            "development or staging build of SystemSculpt AI (the release build excludes the driver)?",
        ));
      }, this.connectTimeoutMs);
      this.server.on("connection", (socket) => {
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
          clearTimeout(timer);
          this.socket = socket;
          socket.on("message", (data) => this.handleMessage(String(data)));
          socket.on("close", () => this.failPending(new Error("The driver connection closed.")));
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
    if (!this.socket) return Promise.reject(new Error("The driver session is not connected."));
    const id = this.nextId;
    this.nextId += 1;
    // A step may declare its own wait budget (waitFor timeoutMs); the session
    // timeout must always outlast it or long waits die at the transport.
    const declaredMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 0;
    const timeoutMs = Math.max(this.actionTimeoutMs, declaredMs + 5000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Driver action "${action}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "action", id, action, params }));
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
      fs.rmSync(this.handshakePath, { force: true });
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
  let diagnostics = null;
  for (const [index, step] of steps.entries()) {
    const label = step.label ?? `${index + 1}. ${step.action}`;
    if (failed) {
      results.push({ label, action: step.action, skipped: true });
      continue;
    }
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
      diagnostics = await captureFailureDiagnostics(session);
    }
  }
  return { ok: !failed, steps: results, ...(diagnostics ? { diagnostics } : {}) };
}
