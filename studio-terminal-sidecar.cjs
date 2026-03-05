#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn: spawnProcess } = require("node:child_process");

const PROTOCOL = "studio.terminal.sidecar.v1";
const DEFAULT_TIMEOUT_MINUTES = 15;
const HEARTBEAT_SWEEP_MS = 30_000;
const FORCE_KILL_GRACE_MS = 8_000;
const RESPONSE_ERROR_CODE = "SIDECAR_ERROR";
const MAX_HISTORY_CHARS_DEFAULT = 2_000_000;

const STATUS_RUNNING = new Set(["running", "starting"]);

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function trimHistory(value, maxChars) {
  if (typeof value !== "string") {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function parseArgv(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    if (!key) {
      continue;
    }
    if (typeof next === "string" && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
      continue;
    }
    parsed[key] = "true";
  }
  return parsed;
}

function ensureDirSync(targetPath) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ type: "error", error: "Unable to serialize payload." });
  }
}

function writeLine(socket, payload) {
  try {
    socket.write(`${safeJson(payload)}\n`);
  } catch {
    // Best effort for disconnected sockets.
  }
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "Unknown sidecar error");
}

function attachStreamByLines(socket, onLine) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += String(chunk || "");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

function resolveSpawn(moduleValue) {
  if (moduleValue && typeof moduleValue.spawn === "function") {
    return moduleValue.spawn;
  }
  if (moduleValue && moduleValue.default && typeof moduleValue.default.spawn === "function") {
    return moduleValue.default.spawn;
  }
  throw new Error("node-pty did not expose spawn().");
}

async function runTaskKill(pid, force) {
  await new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) {
      args.push("/F");
    }
    const child = spawnProcess("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}

async function readProcessTree() {
  return await new Promise((resolve) => {
    const child = spawnProcess("ps", ["-axo", "pid=,ppid="], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8"));
    });
    child.once("error", () => resolve(new Map()));
    child.once("close", () => {
      const map = new Map();
      const text = Buffer.concat(chunks).toString("utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const [pidRaw, ppidRaw] = line.split(/\s+/);
        const pid = Number(pidRaw);
        const ppid = Number(ppidRaw);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
          continue;
        }
        if (!map.has(ppid)) {
          map.set(ppid, new Set());
        }
        map.get(ppid).add(pid);
      }
      resolve(map);
    });
  });
}

async function collectDescendantPids(rootPid) {
  const tree = await readProcessTree();
  const result = new Set();
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!Number.isFinite(current) || result.has(current)) {
      continue;
    }
    result.add(current);
    const children = tree.get(current);
    if (!children) continue;
    for (const child of children) {
      if (!result.has(child)) {
        stack.push(child);
      }
    }
  }
  return Array.from(result.values());
}

async function terminateProcessTree(pid, force) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    await runTaskKill(pid, force);
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  const pids = await collectDescendantPids(pid);
  pids.reverse();
  for (const candidate of pids) {
    try {
      process.kill(candidate, signal);
    } catch {
      // Process already gone.
    }
  }
}

function makeSessionSnapshot(record) {
  return {
    sessionId: record.sessionId,
    projectPath: record.projectPath,
    nodeId: record.nodeId,
    status: record.status,
    cwd: record.cwd,
    shellProfile: record.shellProfile,
    shellCommand: record.shellCommand,
    shellArgs: [...record.shellArgs],
    cols: record.cols,
    rows: record.rows,
    history: record.history,
    historyRevision: record.historyRevision,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    exitCode: record.exitCode,
    errorMessage: record.errorMessage,
  };
}

function makeSessionSummary(record) {
  return {
    sessionId: record.sessionId,
    status: record.status,
    cwd: record.cwd,
    shellCommand: record.shellCommand,
    updatedAt: record.updatedAt,
    exitCode: record.exitCode,
  };
}

function resolveTimeoutMinutes(rawValue) {
  return clampInt(rawValue, DEFAULT_TIMEOUT_MINUTES, 5, 120);
}

function createSidecarContext(options) {
  const sessions = new Map();
  const clients = new Map();
  let server = null;
  let shuttingDown = false;
  let heartbeatTimer = null;
  let currentTimeoutMinutes = resolveTimeoutMinutes(options.timeoutMinutes);
  let lastClientSeenAt = Date.now();
  let lastShutdownReason = "";

  const state = {
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };

  function statusPayload(extraMessage) {
    const nowMs = Date.now();
    const timeoutMs = currentTimeoutMinutes * 60_000;
    const hasConnections = clients.size > 0;
    const timeoutAt = hasConnections ? null : new Date(lastClientSeenAt + timeoutMs).toISOString();
    return {
      state: hasConnections ? "connected" : "disconnected",
      protocol: PROTOCOL,
      pid: process.pid,
      startedAt: state.startedAt,
      updatedAt: nowIso(),
      lastHeartbeatAt:
        clients.size > 0
          ? new Date(Math.max(...Array.from(clients.values()).map((entry) => entry.lastHeartbeatAt || 0))).toISOString()
          : null,
      lastClientSeenAt: new Date(lastClientSeenAt).toISOString(),
      timeoutMinutes: currentTimeoutMinutes,
      timeoutAt,
      activeConnections: clients.size,
      sessionCount: sessions.size,
      sessions: Array.from(sessions.values()).map(makeSessionSummary),
      lastShutdownReason,
      socketPath: options.socketPath,
      vaultKey: options.vaultKey,
      message: extraMessage ? String(extraMessage) : "",
    };
  }

  async function persistStatus(message) {
    const payload = statusPayload(message);
    state.updatedAt = payload.updatedAt;
    try {
      ensureDirSync(options.statePath);
      await fsp.writeFile(options.statePath, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Best effort.
    }
  }

  function broadcastEvent(eventType, payload) {
    for (const client of clients.values()) {
      writeLine(client.socket, {
        type: "event",
        protocol: PROTOCOL,
        eventType,
        payload,
      });
    }
  }

  async function broadcastStatus(message) {
    const payload = statusPayload(message);
    broadcastEvent("sidecar_status", payload);
    await persistStatus(message);
  }

  function notifySessionSnapshot(record) {
    const snapshot = makeSessionSnapshot(record);
    broadcastEvent("session_snapshot", snapshot);
  }

  function notifySessionData(record, data) {
    if (!data) {
      return;
    }
    broadcastEvent("session_data", {
      sessionId: record.sessionId,
      projectPath: record.projectPath,
      nodeId: record.nodeId,
      historyRevision: record.historyRevision,
      data,
    });
  }

  function createRecord(payload) {
    return {
      sessionId: String(payload.sessionId || "").trim(),
      projectPath: String(payload.projectPath || "").trim(),
      nodeId: String(payload.nodeId || "").trim(),
      status: "idle",
      cwd: String(payload.cwd || "").trim(),
      shellProfile: String(payload.shellProfile || "auto").trim() || "auto",
      shellCommand: "",
      shellArgs: [],
      cols: clampInt(payload.cols, 120, 20, 1000),
      rows: clampInt(payload.rows, 30, 8, 600),
      history: "",
      historyRevision: 0,
      startedAt: null,
      updatedAt: nowIso(),
      exitCode: null,
      errorMessage: "",
      process: null,
      ptyPid: null,
      maxHistoryChars: Math.max(10_000, Math.min(MAX_HISTORY_CHARS_DEFAULT, clampInt(payload.maxHistoryChars, MAX_HISTORY_CHARS_DEFAULT, 10_000, MAX_HISTORY_CHARS_DEFAULT))),
      stopRequested: false,
      exitWaiters: new Set(),
      dataDisposer: null,
      exitDisposer: null,
    };
  }

  function disposeRecordSubscriptions(record) {
    if (typeof record.dataDisposer === "function") {
      try {
        record.dataDisposer();
      } catch {}
    }
    if (typeof record.exitDisposer === "function") {
      try {
        record.exitDisposer();
      } catch {}
    }
    record.dataDisposer = null;
    record.exitDisposer = null;
  }

  function markRecordExited(record, exitCode) {
    disposeRecordSubscriptions(record);
    record.process = null;
    record.status = record.stopRequested ? "stopped" : "failed";
    record.exitCode = Number.isFinite(exitCode) ? Math.floor(exitCode) : null;
    record.errorMessage = record.stopRequested
      ? ""
      : `Terminal exited${record.exitCode !== null ? ` (${record.exitCode})` : ""}.`;
    record.updatedAt = nowIso();
    record.stopRequested = false;
    notifySessionSnapshot(record);
    for (const waiter of record.exitWaiters) {
      try {
        waiter();
      } catch {}
    }
    record.exitWaiters.clear();
  }

  function waitForRecordExit(record, timeoutMs) {
    if (!record.process) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        record.exitWaiters.delete(onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      record.exitWaiters.add(onExit);
    });
  }

  async function stopSessionRecord(record, reason) {
    if (!record || !record.process) {
      return;
    }

    record.stopRequested = true;
    record.updatedAt = nowIso();
    if (reason && !record.errorMessage) {
      record.errorMessage = String(reason);
    }

    const pid = Number(record.ptyPid);
    try {
      await terminateProcessTree(pid, false);
    } catch {}

    try {
      record.process.kill();
    } catch {}

    const exitedGracefully = await waitForRecordExit(record, FORCE_KILL_GRACE_MS);
    if (exitedGracefully) {
      return;
    }

    try {
      await terminateProcessTree(pid, true);
    } catch {}

    try {
      record.process.kill();
    } catch {}

    await waitForRecordExit(record, 1_000);
  }

  async function ensureSession(payload, restart) {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Missing sessionId");
    }

    let record = sessions.get(sessionId);
    if (!record) {
      record = createRecord(payload);
      sessions.set(sessionId, record);
    }

    record.projectPath = String(payload.projectPath || record.projectPath || "").trim();
    record.nodeId = String(payload.nodeId || record.nodeId || "").trim();
    record.cwd = String(payload.cwd || record.cwd || "").trim();
    record.cols = clampInt(payload.cols, record.cols || 120, 20, 1000);
    record.rows = clampInt(payload.rows, record.rows || 30, 8, 600);
    record.shellProfile = String(payload.shellProfile || record.shellProfile || "auto").trim() || "auto";
    record.maxHistoryChars = Math.max(
      10_000,
      Math.min(MAX_HISTORY_CHARS_DEFAULT, clampInt(payload.maxHistoryChars, record.maxHistoryChars || MAX_HISTORY_CHARS_DEFAULT, 10_000, MAX_HISTORY_CHARS_DEFAULT))
    );

    if (record.process && record.status === "running" && !restart) {
      if (typeof record.process.resize === "function") {
        try {
          record.process.resize(record.cols, record.rows);
        } catch {}
      }
      record.updatedAt = nowIso();
      return makeSessionSnapshot(record);
    }

    if (record.process && restart) {
      await stopSessionRecord(record, "Restart requested.");
    }

    const command = String(payload.command || "").trim();
    const args = Array.isArray(payload.args)
      ? payload.args.map((value) => String(value || ""))
      : [];
    const env = payload.env && typeof payload.env === "object" ? payload.env : {};

    if (!command) {
      throw new Error("Terminal session requires a shell command.");
    }
    if (!record.cwd) {
      throw new Error("Terminal session requires cwd.");
    }

    record.history = record.process ? record.history : "";
    record.historyRevision += 1;
    record.status = "starting";
    record.errorMessage = "";
    record.exitCode = null;
    record.shellCommand = command;
    record.shellArgs = [...args];
    record.updatedAt = nowIso();
    notifySessionSnapshot(record);

    const pty = options.spawnPty(command, args, {
      name: "xterm-256color",
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      env,
    });

    record.process = pty;
    record.ptyPid = Number(pty.pid) || null;
    record.status = "running";
    record.startedAt = nowIso();
    record.updatedAt = record.startedAt;
    record.stopRequested = false;
    notifySessionSnapshot(record);

    record.dataDisposer = typeof pty.onData === "function"
      ? pty.onData((chunk) => {
          const data = String(chunk || "");
          if (!data) {
            return;
          }
          record.history = trimHistory(record.history + data, record.maxHistoryChars);
          record.updatedAt = nowIso();
          notifySessionData(record, data);
        })
      : null;

    record.exitDisposer = typeof pty.onExit === "function"
      ? pty.onExit((event) => {
          markRecordExited(record, event && Number.isFinite(event.exitCode) ? Number(event.exitCode) : null);
          void persistStatus();
          void broadcastStatus();
        })
      : null;

    await persistStatus();
    return makeSessionSnapshot(record);
  }

  function getSnapshot(sessionId) {
    const key = String(sessionId || "").trim();
    if (!key) {
      return null;
    }
    const record = sessions.get(key);
    if (!record) {
      return null;
    }
    return makeSessionSnapshot(record);
  }

  function touchClient(client) {
    client.lastHeartbeatAt = Date.now();
    lastClientSeenAt = client.lastHeartbeatAt;
  }

  async function maybeShutdownForHeartbeatTimeout() {
    if (shuttingDown) {
      return;
    }
    if (clients.size > 0) {
      return;
    }
    const timeoutMs = currentTimeoutMinutes * 60_000;
    if (Date.now() - lastClientSeenAt < timeoutMs) {
      return;
    }
    await shutdown("heartbeat_timeout");
  }

  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    lastShutdownReason = String(reason || "shutdown");

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const stopJobs = [];
    for (const record of sessions.values()) {
      stopJobs.push(stopSessionRecord(record, `Sidecar shutdown: ${lastShutdownReason}`));
    }
    await Promise.allSettled(stopJobs);

    if (server) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    if (process.platform !== "win32") {
      try {
        await fsp.rm(options.socketPath, { force: true });
      } catch {}
    }

    await persistStatus(`shutdown:${lastShutdownReason}`);
    process.exit(0);
  }

  async function handleRequest(client, message) {
    const id = Number(message.id);
    const type = String(message.type || "").trim();
    const payload = message.payload && typeof message.payload === "object" ? message.payload : {};

    async function ok(result) {
      if (!Number.isFinite(id)) {
        return;
      }
      writeLine(client.socket, {
        type: "response",
        protocol: PROTOCOL,
        id,
        ok: true,
        result,
      });
    }

    async function fail(error) {
      if (!Number.isFinite(id)) {
        return;
      }
      writeLine(client.socket, {
        type: "response",
        protocol: PROTOCOL,
        id,
        ok: false,
        error: {
          code: RESPONSE_ERROR_CODE,
          message: toErrorMessage(error),
        },
      });
    }

    try {
      if (type === "hello") {
        client.clientId = String(payload.clientId || "").trim() || `client-${Math.random().toString(36).slice(2, 8)}`;
        currentTimeoutMinutes = resolveTimeoutMinutes(payload.timeoutMinutes || currentTimeoutMinutes);
        touchClient(client);
        await ok({
          status: statusPayload(),
        });
        await broadcastStatus();
        return;
      }

      if (type === "heartbeat") {
        touchClient(client);
        await ok({
          acknowledgedAt: nowIso(),
        });
        await persistStatus();
        return;
      }

      if (type === "status") {
        await ok({ status: statusPayload() });
        return;
      }

      if (type === "list_sessions") {
        await ok({
          sessions: Array.from(sessions.values()).map(makeSessionSnapshot),
        });
        return;
      }

      if (type === "peek_session") {
        const snapshot = getSnapshot(payload.sessionId);
        await ok({ snapshot });
        return;
      }

      if (type === "ensure_session") {
        const snapshot = await ensureSession(payload, Boolean(payload.restart));
        await ok({ snapshot });
        await broadcastStatus();
        return;
      }

      if (type === "write") {
        const record = sessions.get(String(payload.sessionId || "").trim());
        if (!record || !record.process || record.status !== "running") {
          await ok({
            ignored: true,
          });
          return;
        }
        const data = String(payload.data || "");
        if (data.length > 0) {
          try {
            record.process.write(data);
          } catch {}
        }
        record.updatedAt = nowIso();
        await ok({ ignored: false });
        return;
      }

      if (type === "resize") {
        const record = sessions.get(String(payload.sessionId || "").trim());
        if (!record) {
          await ok({ ignored: true });
          return;
        }
        record.cols = clampInt(payload.cols, record.cols || 120, 20, 1000);
        record.rows = clampInt(payload.rows, record.rows || 30, 8, 600);
        if (record.process && STATUS_RUNNING.has(record.status)) {
          try {
            record.process.resize(record.cols, record.rows);
          } catch {}
        }
        record.updatedAt = nowIso();
        notifySessionSnapshot(record);
        await ok({ ignored: false });
        return;
      }

      if (type === "clear_history") {
        const record = sessions.get(String(payload.sessionId || "").trim());
        if (!record) {
          await ok({ ignored: true });
          return;
        }
        record.history = "";
        record.historyRevision += 1;
        record.updatedAt = nowIso();
        notifySessionSnapshot(record);
        await ok({ ignored: false });
        return;
      }

      if (type === "stop_session") {
        const record = sessions.get(String(payload.sessionId || "").trim());
        if (!record) {
          await ok({ ignored: true });
          return;
        }
        await stopSessionRecord(record, "Stopped by client.");
        await ok({ ignored: false, snapshot: makeSessionSnapshot(record) });
        await broadcastStatus();
        return;
      }

      if (type === "stop_project_sessions") {
        const projectPath = String(payload.projectPath || "").trim();
        if (!projectPath) {
          throw new Error("Missing projectPath");
        }

        const reason = String(payload.reason || "").trim() || "Stopped by client project termination.";
        const matching = Array.from(sessions.values()).filter((record) => record.projectPath === projectPath);
        const stoppedSessionIds = [];
        for (const record of matching) {
          if (record.process) {
            await stopSessionRecord(record, reason);
          } else if (record.status !== "stopped") {
            record.status = "stopped";
            record.errorMessage = "";
            record.exitCode = null;
            record.updatedAt = nowIso();
            notifySessionSnapshot(record);
          }
          stoppedSessionIds.push(record.sessionId);
          sessions.delete(record.sessionId);
        }

        await ok({
          projectPath,
          removedCount: matching.length,
          stoppedSessionIds,
        });
        await broadcastStatus();
        return;
      }

      if (type === "shutdown") {
        await ok({
          shuttingDown: true,
        });
        await shutdown(String(payload.reason || "client_shutdown"));
        return;
      }

      throw new Error(`Unsupported request type: ${type}`);
    } catch (error) {
      await fail(error);
    }
  }

  function attachClient(socket) {
    const client = {
      socket,
      clientId: "",
      lastHeartbeatAt: Date.now(),
    };
    clients.set(socket, client);
    touchClient(client);
    void broadcastStatus();

    attachStreamByLines(socket, (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      void handleRequest(client, parsed);
    });

    socket.once("error", () => {
      // Best effort close.
    });

    socket.once("close", () => {
      clients.delete(socket);
      lastClientSeenAt = Date.now();
      void broadcastStatus();
    });
  }

  async function startServer() {
    if (process.platform !== "win32") {
      try {
        await fsp.rm(options.socketPath, { force: true });
      } catch {}
      ensureDirSync(options.socketPath);
    }

    server = net.createServer((socket) => {
      attachClient(socket);
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    heartbeatTimer = setInterval(() => {
      void maybeShutdownForHeartbeatTimeout();
    }, HEARTBEAT_SWEEP_MS);

    process.on("SIGTERM", () => {
      void shutdown("sigterm");
    });
    process.on("SIGINT", () => {
      void shutdown("sigint");
    });
    process.on("exit", () => {
      if (process.platform !== "win32") {
        try {
          fs.rmSync(options.socketPath, { force: true });
        } catch {}
      }
    });

    await broadcastStatus("ready");
  }

  return {
    startServer,
  };
}

(async () => {
  const argv = parseArgv(process.argv.slice(2));
  const socketPath = String(argv.socket || argv.socketPath || "").trim();
  const statePath = String(argv.state || argv.statePath || "").trim();
  const pluginInstallDir = String(argv.pluginInstallDir || "").trim();
  const vaultKey = String(argv.vaultKey || "").trim() || "unknown";
  const timeoutMinutes = resolveTimeoutMinutes(argv.timeoutMinutes);

  if (!socketPath || !statePath || !pluginInstallDir) {
    console.error("Sidecar startup failed: missing required args (--socket, --state, --pluginInstallDir)");
    process.exit(1);
  }

  try {
    const modulePath = path.join(pluginInstallDir, "node_modules", "node-pty");
    if (!fs.existsSync(modulePath)) {
      throw new Error(`node-pty runtime missing at ${modulePath}`);
    }
    const nodePty = require(modulePath);
    const spawnPty = resolveSpawn(nodePty);

    const context = createSidecarContext({
      socketPath,
      statePath,
      pluginInstallDir,
      vaultKey,
      timeoutMinutes,
      spawnPty,
    });

    await context.startServer();
  } catch (error) {
    const message = toErrorMessage(error);
    try {
      ensureDirSync(statePath);
      await fsp.writeFile(
        statePath,
        JSON.stringify(
          {
            state: "failed",
            protocol: PROTOCOL,
            pid: process.pid,
            startedAt: nowIso(),
            updatedAt: nowIso(),
            lastShutdownReason: message,
            timeoutMinutes,
            socketPath,
            vaultKey,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {}
    console.error(`Sidecar startup failed: ${message}`);
    process.exit(1);
  }
})();
