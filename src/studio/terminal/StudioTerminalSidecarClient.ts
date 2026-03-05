import { Platform } from "obsidian";
import { spawn as spawnChildProcess, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as net from "node:net";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type SystemSculptPlugin from "../../main";
import { nowIso } from "../utils";
import { StudioTerminalRuntimeBootstrap } from "../StudioTerminalRuntimeBootstrap";
import type {
  StudioTerminalSessionSnapshot,
  StudioTerminalSidecarSessionEvent,
  StudioTerminalSidecarSessionEventListener,
  StudioTerminalSidecarStatus,
  StudioTerminalSidecarStatusListener,
  StudioTerminalSpawnOptions,
} from "./StudioTerminalSessionTypes";

const SIDECAR_PROTOCOL = "studio.terminal.sidecar.v1";
const SIDECAR_SCRIPT_FILE_NAME = "studio-terminal-sidecar.cjs";
const SIDECAR_STARTUP_RETRY_MS = 6_000;
const SIDECAR_CONNECT_TIMEOUT_MS = 1_500;
const SIDECAR_REQUEST_TIMEOUT_MS = 8_000;
const SIDECAR_HEARTBEAT_INTERVAL_MS = 5_000;
const SIDECAR_NODE_RUNTIME_PROBE_TIMEOUT_MS = 1_500;
const UNIX_SOCKET_MAX_BYTES = 103;

type SidecarPaths = {
  statePath: string;
  socketPath: string;
  vaultKey: string;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SidecarStatePayload = {
  state?: unknown;
  protocol?: unknown;
  pid?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  lastHeartbeatAt?: unknown;
  lastClientSeenAt?: unknown;
  timeoutMinutes?: unknown;
  timeoutAt?: unknown;
  activeConnections?: unknown;
  sessionCount?: unknown;
  sessions?: unknown;
  lastShutdownReason?: unknown;
  socketPath?: unknown;
  vaultKey?: unknown;
  message?: unknown;
};

type SidecarSessionSummaryPayload = {
  sessionId?: unknown;
  status?: unknown;
  cwd?: unknown;
  shellCommand?: unknown;
  updatedAt?: unknown;
  exitCode?: unknown;
};

type StudioTerminalRuntimeResolution = {
  command: string;
  env: NodeJS.ProcessEnv;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown sidecar error");
}

function looksLikeNodeRuntimePath(command: string): boolean {
  const normalized = basename(String(command || "").trim()).toLowerCase();
  return normalized === "node" || normalized === "node.exe";
}

function probeNodeRuntimeCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const result = spawnSync(command, ["-e", "process.stdout.write('ok')"], {
      env,
      shell: false,
      windowsHide: true,
      timeout: SIDECAR_NODE_RUNTIME_PROBE_TIMEOUT_MS,
      encoding: "utf8",
    });
    return result.status === 0 && String(result.stdout || "").trim() === "ok";
  } catch {
    return false;
  }
}

function sanitizeSidecarKey(value: string): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (normalized.length > 0) {
    return normalized;
  }
  return "default";
}

export function resolveStudioTerminalSocketPath(options: {
  key: string;
  platform?: NodeJS.Platform;
  tempDir?: string;
}): string {
  const key = sanitizeSidecarKey(options.key);
  const platform = options.platform || process.platform;
  const socketName = `systemsculpt-studio-terminal-${key}.sock`;

  if (platform === "win32") {
    return `\\\\.\\pipe\\systemsculpt-studio-terminal-${key}`;
  }

  const resolvedTempDir = String(options.tempDir || tmpdir() || "").trim() || "/tmp";
  const preferred = join(resolvedTempDir, socketName);
  if (Buffer.byteLength(preferred, "utf8") <= UNIX_SOCKET_MAX_BYTES) {
    return preferred;
  }

  const fallback = join("/tmp", socketName);
  if (Buffer.byteLength(fallback, "utf8") <= UNIX_SOCKET_MAX_BYTES) {
    return fallback;
  }

  const compactKey = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return join("/tmp", `sst-sidecar-${compactKey}.sock`);
}

export function buildStudioTerminalSidecarChildEnv(options?: {
  baseEnv?: NodeJS.ProcessEnv;
  runtimeVersions?: NodeJS.ProcessVersions | Record<string, string | undefined>;
  runtimeCommand?: string;
  execPath?: string;
}): NodeJS.ProcessEnv {
  const env = { ...(options?.baseEnv || process.env) } as NodeJS.ProcessEnv;
  const runtimeVersions = options?.runtimeVersions || process.versions;
  const electronVersion = String((runtimeVersions as Record<string, string | undefined>).electron || "").trim();
  const runtimeCommand = String(options?.runtimeCommand || "").trim();
  const execPath = String(options?.execPath || process.execPath || "").trim();
  if (electronVersion && runtimeCommand && runtimeCommand === execPath && !looksLikeNodeRuntimePath(runtimeCommand)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return env;
}

export function resolveStudioTerminalSidecarRuntime(options?: {
  execPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runtimeVersions?: NodeJS.ProcessVersions | Record<string, string | undefined>;
  probeCommand?: (command: string, env: NodeJS.ProcessEnv) => boolean;
  fileExists?: (path: string) => boolean;
}): StudioTerminalRuntimeResolution {
  const execPath = String(options?.execPath || process.execPath || "").trim();
  const baseEnv = { ...(options?.baseEnv || process.env) } as NodeJS.ProcessEnv;
  const platform = options?.platform || process.platform;
  const runtimeVersions = options?.runtimeVersions || process.versions;
  const electronVersion = String((runtimeVersions as Record<string, string | undefined>).electron || "").trim();
  const probe = options?.probeCommand || probeNodeRuntimeCommand;
  const fileExists = options?.fileExists || existsSync;

  const envNodePath = String(baseEnv.SYSTEMSCULPT_STUDIO_NODE_PATH || "").trim();
  const commonCandidates = platform === "win32"
    ? ["node.exe", "node"]
    : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "node"];
  const shouldProbeExecPathEarly = !electronVersion || looksLikeNodeRuntimePath(execPath);
  const preferredCandidates = shouldProbeExecPathEarly
    ? [envNodePath, execPath, ...commonCandidates]
    : [envNodePath, ...commonCandidates, execPath];
  const candidates = preferredCandidates.filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index);

  for (const candidate of candidates) {
    if (isAbsolute(candidate) && !fileExists(candidate)) continue;
    const env = buildStudioTerminalSidecarChildEnv({
      baseEnv,
      runtimeVersions,
      runtimeCommand: candidate,
      execPath,
    });
    if (probe(candidate, env)) {
      return { command: candidate, env };
    }
  }

  const fallbackEnv = buildStudioTerminalSidecarChildEnv({
    baseEnv,
    runtimeVersions,
    runtimeCommand: execPath,
    execPath,
  });
  if (!execPath) {
    throw new Error("Unable to resolve Node runtime for terminal sidecar.");
  }
  return { command: execPath, env: fallbackEnv };
}

export function isExpectedTerminalSidecarConnectionError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return message.includes("unable to connect") ||
    message.includes("not connected") ||
    message.includes("timed out") ||
    message.includes("disposed") ||
    message.includes("failed") ||
    message.includes("enoent") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("epipe");
}

function parseStatusPayload(
  payload: SidecarStatePayload,
  fallback: { socketPath: string; vaultKey: string },
): StudioTerminalSidecarStatus {
  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions.map((entry): StudioTerminalSidecarStatus["sessions"][number] => {
      const session = (entry || {}) as SidecarSessionSummaryPayload;
      return {
        sessionId: String(session.sessionId || "").trim(),
        status: String(session.status || "").trim(),
        cwd: String(session.cwd || "").trim(),
        shellCommand: String(session.shellCommand || "").trim(),
        updatedAt: String(session.updatedAt || nowIso()).trim() || nowIso(),
        exitCode: Number.isFinite(Number(session.exitCode)) ? Math.floor(Number(session.exitCode)) : null,
      };
    })
    : [];

  const state = String(payload.state || "").trim() || "unknown";
  const protocol = String(payload.protocol || SIDECAR_PROTOCOL).trim() || SIDECAR_PROTOCOL;
  const updatedAt = String(payload.updatedAt || nowIso()).trim() || nowIso();

  return {
    state,
    protocol,
    pid: Number.isFinite(Number(payload.pid)) ? Math.floor(Number(payload.pid)) : null,
    startedAt: payload.startedAt ? String(payload.startedAt) : null,
    updatedAt,
    lastHeartbeatAt: payload.lastHeartbeatAt ? String(payload.lastHeartbeatAt) : null,
    lastClientSeenAt: payload.lastClientSeenAt ? String(payload.lastClientSeenAt) : null,
    timeoutMinutes: Number.isFinite(Number(payload.timeoutMinutes))
      ? Math.max(5, Math.min(120, Math.floor(Number(payload.timeoutMinutes))))
      : 15,
    timeoutAt: payload.timeoutAt ? String(payload.timeoutAt) : null,
    activeConnections: Number.isFinite(Number(payload.activeConnections)) ? Math.max(0, Math.floor(Number(payload.activeConnections))) : 0,
    sessionCount: Number.isFinite(Number(payload.sessionCount)) ? Math.max(0, Math.floor(Number(payload.sessionCount))) : sessions.length,
    sessions,
    lastShutdownReason: String(payload.lastShutdownReason || "").trim(),
    socketPath: String(payload.socketPath || fallback.socketPath || "").trim(),
    vaultKey: String(payload.vaultKey || fallback.vaultKey || "").trim(),
    message: String(payload.message || "").trim(),
  };
}

function parseSnapshot(value: unknown): StudioTerminalSessionSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const snapshot = value as Record<string, unknown>;
  const sessionId = String(snapshot.sessionId || "").trim();
  const projectPath = String(snapshot.projectPath || "").trim();
  const nodeId = String(snapshot.nodeId || "").trim();
  if (!sessionId || !projectPath || !nodeId) {
    return null;
  }

  const shellArgs = Array.isArray(snapshot.shellArgs)
    ? snapshot.shellArgs.map((value) => String(value || ""))
    : [];

  const normalized: StudioTerminalSessionSnapshot = {
    sessionId,
    projectPath,
    nodeId,
    status: String(snapshot.status || "idle") as StudioTerminalSessionSnapshot["status"],
    cwd: String(snapshot.cwd || ""),
    shellProfile: String(snapshot.shellProfile || "auto") as StudioTerminalSessionSnapshot["shellProfile"],
    shellCommand: String(snapshot.shellCommand || ""),
    shellArgs,
    cols: Number.isFinite(Number(snapshot.cols)) ? Math.floor(Number(snapshot.cols)) : 120,
    rows: Number.isFinite(Number(snapshot.rows)) ? Math.floor(Number(snapshot.rows)) : 30,
    history: String(snapshot.history || ""),
    historyRevision: Number.isFinite(Number(snapshot.historyRevision)) ? Math.floor(Number(snapshot.historyRevision)) : 0,
    startedAt: snapshot.startedAt ? String(snapshot.startedAt) : null,
    updatedAt: String(snapshot.updatedAt || nowIso()),
    exitCode: Number.isFinite(Number(snapshot.exitCode)) ? Math.floor(Number(snapshot.exitCode)) : null,
    errorMessage: String(snapshot.errorMessage || ""),
  };

  const webSocketUrl = String(snapshot.webSocketUrl || "").trim();
  if (webSocketUrl) {
    normalized.webSocketUrl = webSocketUrl;
  }

  return normalized;
}

export class StudioTerminalSidecarClient {
  private readonly runtimeBootstrap: StudioTerminalRuntimeBootstrap;
  private readonly sidecarStatusObservers = new Set<StudioTerminalSidecarStatusListener>();
  private readonly sessionObservers = new Map<string, Set<StudioTerminalSidecarSessionEventListener>>();
  private sidecarPathsCache: SidecarPaths | null = null;
  private connectPromise: Promise<void> | null = null;
  private sidecarStatus: StudioTerminalSidecarStatus | null = null;
  private disposed = false;
  private socket: net.Socket | null = null;
  private socketBuffer = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly clientId = `studio-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options?: { runtimeBootstrap?: StudioTerminalRuntimeBootstrap }
  ) {
    this.runtimeBootstrap = options?.runtimeBootstrap || new StudioTerminalRuntimeBootstrap(plugin);
  }

  private resolveVaultBasePath(): string {
    const adapter = this.plugin.app.vault.adapter as any;
    if (typeof adapter.getBasePath === "function") {
      const fromGetter = String(adapter.getBasePath() || "").trim();
      if (fromGetter) return fromGetter;
    }
    if (typeof adapter.basePath === "string" && adapter.basePath.trim().length > 0) {
      return adapter.basePath.trim();
    }
    return "";
  }

  private resolvePluginInstallDir(): string {
    const manifestDir = String((this.plugin.manifest as any).dir || "").trim();
    if (manifestDir) {
      if (isAbsolute(manifestDir)) return manifestDir;
      const vaultBasePath = this.resolveVaultBasePath();
      if (vaultBasePath) return join(vaultBasePath, manifestDir);
    }
    const vaultBasePath = this.resolveVaultBasePath();
    const configDir = String(this.plugin.app.vault.configDir || "").trim();
    const pluginId = String(this.plugin.manifest.id || "").trim();
    if (vaultBasePath && configDir && pluginId) {
      return join(vaultBasePath, configDir, "plugins", pluginId);
    }
    throw new Error("Unable to resolve the plugin installation directory.");
  }

  private resolveSidecarPaths(): SidecarPaths {
    if (this.sidecarPathsCache) return this.sidecarPathsCache;
    const pluginId = String(this.plugin.manifest.id || "systemsculpt-ai").trim() || "systemsculpt-ai";
    const vaultBasePath = this.resolveVaultBasePath();
    const fingerprint = `${pluginId}::${vaultBasePath || "unknown"}`;
    const key = createHash("sha1").update(fingerprint).digest("hex").slice(0, 24);
    const socketPath = resolveStudioTerminalSocketPath({ key });
    const statePath = join(tmpdir(), "systemsculpt-studio-terminal", `${key}.json`);
    this.sidecarPathsCache = { statePath, socketPath, vaultKey: key };
    return this.sidecarPathsCache;
  }

  private readConfiguredTimeoutMinutes(): number {
    const configured = (this.plugin.settings as any).studioTerminalSidecarTimeoutMinutes;
    const parsed = Number(configured);
    if (!Number.isFinite(parsed)) return 15;
    return Math.max(5, Math.min(120, Math.floor(parsed)));
  }

  private notifySidecarStatus(status: StudioTerminalSidecarStatus): void {
    this.sidecarStatus = status;
    for (const listener of this.sidecarStatusObservers) {
      try {
        listener(status);
      } catch {
        // Listener errors must not break transport.
      }
    }
  }

  private notifySessionEvent(sessionId: string, event: StudioTerminalSidecarSessionEvent): void {
    const listeners = this.sessionObservers.get(sessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break transport.
      }
    }
  }

  private buildDisconnectedStatus(message: string): StudioTerminalSidecarStatus {
    const paths = this.resolveSidecarPaths();
    return {
      state: "disconnected",
      protocol: SIDECAR_PROTOCOL,
      pid: null,
      startedAt: null,
      updatedAt: nowIso(),
      lastHeartbeatAt: null,
      lastClientSeenAt: null,
      timeoutMinutes: this.readConfiguredTimeoutMinutes(),
      timeoutAt: null,
      activeConnections: 0,
      sessionCount: 0,
      sessions: [],
      lastShutdownReason: "",
      socketPath: paths.socketPath,
      vaultKey: paths.vaultKey,
      message,
    };
  }

  private async readSidecarState(): Promise<StudioTerminalSidecarStatus | null> {
    const paths = this.resolveSidecarPaths();
    try {
      if (!existsSync(paths.statePath)) return null;
      const raw = await readFile(paths.statePath, "utf8");
      const payload = JSON.parse(raw) as SidecarStatePayload;
      return parseStatusPayload(payload, {
        socketPath: paths.socketPath,
        vaultKey: paths.vaultKey,
      });
    } catch {
      return null;
    }
  }

  private rejectPendingRequests(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const entry of pending) {
      clearTimeout(entry.timeout);
      try {
        entry.reject(error);
      } catch {
        // Ignore listener-level errors.
      }
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendRequest("heartbeat", {}, SIDECAR_REQUEST_TIMEOUT_MS, { skipEnsureConnected: true }).catch(() => {
        // Heartbeat errors are handled by socket lifecycle callbacks.
      });
    }, SIDECAR_HEARTBEAT_INTERVAL_MS);
  }

  private handleSocketClosed(reason: string): void {
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
      } catch {
        // Ignore cleanup errors.
      }
      this.socket = null;
    }
    this.socketBuffer = "";

    const error = new Error(`Unable to connect to terminal sidecar: ${reason}`);
    this.rejectPendingRequests(error);

    const nextStatus = this.buildDisconnectedStatus(error.message);
    this.notifySidecarStatus(nextStatus);
  }

  private attachSocket(socket: net.Socket): void {
    this.socket = socket;
    this.socketBuffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.socketBuffer += String(chunk || "");
      let newlineIndex = this.socketBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.socketBuffer.slice(0, newlineIndex).trim();
        this.socketBuffer = this.socketBuffer.slice(newlineIndex + 1);
        newlineIndex = this.socketBuffer.indexOf("\n");
        if (!line) {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.handleIncomingMessage(message);
      }
    });

    socket.once("error", (error) => {
      this.handleSocketClosed(toErrorMessage(error));
    });

    socket.once("close", () => {
      this.handleSocketClosed("socket closed");
    });
  }

  private handleIncomingMessage(message: Record<string, unknown>): void {
    const type = String(message.type || "").trim();
    if (type === "response") {
      const id = Number(message.id);
      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      if (message.ok === true) {
        try {
          pending.resolve((message.result || {}) as Record<string, unknown>);
        } catch (error) {
          pending.reject(new Error(toErrorMessage(error)));
        }
        return;
      }
      const errorPayload = message.error && typeof message.error === "object"
        ? (message.error as Record<string, unknown>)
        : {};
      pending.reject(new Error(String(errorPayload.message || "Terminal sidecar request failed.")));
      return;
    }

    if (type !== "event") {
      return;
    }

    const eventType = String(message.eventType || "").trim();
    const payload = message.payload && typeof message.payload === "object"
      ? (message.payload as Record<string, unknown>)
      : null;
    if (!payload) {
      return;
    }

    if (eventType === "sidecar_status") {
      const status = parseStatusPayload(payload as SidecarStatePayload, this.resolveSidecarPaths());
      this.notifySidecarStatus(status);
      return;
    }

    if (eventType === "session_snapshot") {
      const snapshot = parseSnapshot(payload);
      if (!snapshot) {
        return;
      }
      this.notifySessionEvent(snapshot.sessionId, {
        type: "snapshot",
        snapshot,
      });
      return;
    }

    if (eventType === "session_data") {
      const sessionId = String(payload.sessionId || "").trim();
      if (!sessionId) {
        return;
      }
      this.notifySessionEvent(sessionId, {
        type: "data",
        sessionId,
        projectPath: String(payload.projectPath || ""),
        nodeId: String(payload.nodeId || ""),
        historyRevision: Number.isFinite(Number(payload.historyRevision))
          ? Math.floor(Number(payload.historyRevision))
          : 0,
        data: String(payload.data || ""),
      });
    }
  }

  private async connectSocket(socketPath: string): Promise<void> {
    const socket = net.createConnection(socketPath);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.destroy();
        } catch {
          // Best effort cleanup.
        }
        reject(new Error(`Timed out connecting to terminal sidecar at ${socketPath}.`));
      }, SIDECAR_CONNECT_TIMEOUT_MS);

      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          reject(new Error(toErrorMessage(error)));
          return;
        }
        resolve();
      };

      socket.once("connect", () => finish());
      socket.once("error", (error) => finish(error));
    });

    this.attachSocket(socket);

    const helloResult = await this.sendRequest(
      "hello",
      {
        clientId: this.clientId,
        timeoutMinutes: this.readConfiguredTimeoutMinutes(),
      },
      SIDECAR_REQUEST_TIMEOUT_MS,
      { skipEnsureConnected: true }
    );

    const statusPayload = helloResult.status && typeof helloResult.status === "object"
      ? (helloResult.status as SidecarStatePayload)
      : null;
    if (statusPayload) {
      this.notifySidecarStatus(parseStatusPayload(statusPayload, this.resolveSidecarPaths()));
    } else {
      const fallback = await this.readSidecarState();
      if (fallback) {
        this.notifySidecarStatus(fallback);
      }
    }

    this.startHeartbeat();
  }

  private async spawnSidecarProcess(): Promise<void> {
    const pluginInstallDir = this.resolvePluginInstallDir();
    const sidecarScriptPath = join(pluginInstallDir, SIDECAR_SCRIPT_FILE_NAME);

    if (!existsSync(sidecarScriptPath)) {
      await this.runtimeBootstrap.ensureSidecarEntrypoint(pluginInstallDir);
    }
    if (!existsSync(sidecarScriptPath)) {
      throw new Error(`Terminal sidecar runtime missing at ${sidecarScriptPath}. Please rebuild plugin.`);
    }

    await this.runtimeBootstrap.ensureNodePtyRuntime(pluginInstallDir);

    const paths = this.resolveSidecarPaths();
    const timeoutMinutes = this.readConfiguredTimeoutMinutes();
    const args = [
      sidecarScriptPath,
      "--socket", paths.socketPath,
      "--state", paths.statePath,
      "--pluginInstallDir", pluginInstallDir,
      "--vaultKey", paths.vaultKey,
      "--timeoutMinutes", String(timeoutMinutes),
    ];

    const runtime = resolveStudioTerminalSidecarRuntime({ baseEnv: process.env });

    if (existsSync(paths.statePath)) {
      try {
        await unlink(paths.statePath);
      } catch {
        // Best effort cleanup.
      }
    }

    if (process.platform !== "win32" && existsSync(paths.socketPath)) {
      try {
        await unlink(paths.socketPath);
      } catch {
        // Best effort cleanup.
      }
    }

    const child: ChildProcess = spawnChildProcess(runtime.command, args, {
      cwd: pluginInstallDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: runtime.env,
    });
    child.unref();
  }

  private async ensureConnected(): Promise<void> {
    if (this.disposed) {
      throw new Error("Terminal sidecar client has been disposed.");
    }
    if (!Platform.isDesktopApp) {
      throw new Error("Interactive terminal sessions are desktop-only.");
    }
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = (async () => {
      const paths = this.resolveSidecarPaths();
      try {
        await this.connectSocket(paths.socketPath);
        return;
      } catch {
        // Fall through and spawn a fresh sidecar.
      }

      await this.spawnSidecarProcess();
      const deadline = Date.now() + SIDECAR_STARTUP_RETRY_MS;
      let lastError: Error | null = null;
      while (Date.now() < deadline) {
        try {
          await this.connectSocket(paths.socketPath);
          return;
        } catch (error) {
          lastError = new Error(toErrorMessage(error));
          await sleep(150);
        }
      }

      const state = await this.readSidecarState();
      if (state) {
        this.notifySidecarStatus(state);
      }

      throw new Error(
        `Unable to connect to terminal sidecar: ${lastError ? lastError.message : "startup timed out."}`
      );
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async sendRequest(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = SIDECAR_REQUEST_TIMEOUT_MS,
    options?: {
      skipEnsureConnected?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    if (!options?.skipEnsureConnected) {
      await this.ensureConnected();
    }

    if (!this.socket || this.socket.destroyed) {
      throw new Error("Unable to connect to terminal sidecar: socket is not connected.");
    }

    const id = this.nextRequestId++;
    const socket = this.socket;

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Terminal sidecar request timed out (${type}).`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout,
      });

      const message = JSON.stringify({
        type,
        id,
        payload,
      });
      socket.write(`${message}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error(toErrorMessage(error)));
      });
    });
  }

  getSidecarStatus(): StudioTerminalSidecarStatus | null {
    return this.sidecarStatus;
  }

  subscribeSidecarStatus(listener: StudioTerminalSidecarStatusListener): () => void {
    this.sidecarStatusObservers.add(listener);
    if (this.sidecarStatus) {
      try {
        listener(this.sidecarStatus);
      } catch {
        // Listener errors must not break transport.
      }
    }
    return () => {
      this.sidecarStatusObservers.delete(listener);
    };
  }

  subscribeSessionEvents(
    options: { sessionId: string },
    listener: StudioTerminalSidecarSessionEventListener,
  ): () => void {
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) {
      return () => {};
    }

    let listeners = this.sessionObservers.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessionObservers.set(sessionId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.sessionObservers.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.sessionObservers.delete(sessionId);
      }
    };
  }

  async fetchStatus(): Promise<StudioTerminalSidecarStatus> {
    const result = await this.sendRequest("status", {});
    const payload = result.status && typeof result.status === "object"
      ? (result.status as SidecarStatePayload)
      : null;
    if (!payload) {
      throw new Error("Terminal sidecar returned an invalid status payload.");
    }

    const status = parseStatusPayload(payload, this.resolveSidecarPaths());
    this.notifySidecarStatus(status);
    return status;
  }

  async peekSession(options: { sessionId: string }): Promise<StudioTerminalSessionSnapshot | null> {
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) {
      return null;
    }

    const result = await this.sendRequest("peek_session", { sessionId });
    return parseSnapshot(result.snapshot);
  }

  async ensureSession(options: StudioTerminalSpawnOptions): Promise<StudioTerminalSessionSnapshot> {
    const payload: Record<string, unknown> = {
      sessionId: String(options.sessionId || "").trim(),
      projectPath: String(options.projectPath || "").trim(),
      nodeId: String(options.nodeId || "").trim(),
      shellProfile: String(options.shellProfile || "auto").trim() || "auto",
      command: String(options.command || "").trim(),
      args: Array.isArray(options.args) ? options.args.map((value) => String(value || "")) : [],
      cwd: String(options.cwd || "").trim(),
      cols: options.cols,
      rows: options.rows,
      env: options.env,
      maxHistoryChars: options.maxHistoryChars,
      restart: Boolean(options.restart),
    };

    const result = await this.sendRequest("ensure_session", payload);
    const snapshot = parseSnapshot(result.snapshot);
    if (!snapshot) {
      throw new Error("Terminal sidecar returned an invalid session snapshot.");
    }
    return snapshot;
  }

  async writeInput(options: { sessionId: string; data: string }): Promise<void> {
    const sessionId = String(options.sessionId || "").trim();
    const data = String(options.data || "");
    if (!sessionId || !data) {
      return;
    }

    await this.sendRequest("write", {
      sessionId,
      data,
    });
  }

  async resizeSession(options: { sessionId: string; cols: number; rows: number }): Promise<void> {
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) {
      return;
    }

    await this.sendRequest("resize", {
      sessionId,
      cols: options.cols,
      rows: options.rows,
    });
  }

  async clearHistory(sessionId: string): Promise<void> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      return;
    }

    await this.sendRequest("clear_history", {
      sessionId: normalizedSessionId,
    });
  }

  async stopSession(sessionId: string): Promise<StudioTerminalSessionSnapshot | null> {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      return null;
    }

    const result = await this.sendRequest("stop_session", {
      sessionId: normalizedSessionId,
    });
    return parseSnapshot(result.snapshot);
  }

  async stopProjectSessions(options: { projectPath: string; reason?: string }): Promise<void> {
    const projectPath = String(options.projectPath || "").trim();
    if (!projectPath) {
      return;
    }

    await this.sendRequest("stop_project_sessions", {
      projectPath,
      reason: String(options.reason || "").trim(),
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopHeartbeat();

    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch {
        // Best effort shutdown.
      }
    }
    this.socket = null;

    this.rejectPendingRequests(new Error("Terminal sidecar client has been disposed."));
    this.sidecarStatusObservers.clear();
    this.sessionObservers.clear();
  }
}
