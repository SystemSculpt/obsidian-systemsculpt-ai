import { Platform } from "obsidian";
import type SystemSculptPlugin from "../main";
import { nowIso } from "./utils";
import { StudioTerminalSidecarBackend } from "./terminal/StudioTerminalSidecarBackend";
import {
  buildStudioTerminalEnv,
  isZshShellCommand,
  shellCandidates,
  stripZshPromptSpacingPrelude,
} from "./terminal/StudioTerminalShell";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  MAX_HISTORY_CHARS,
  MAX_SCROLLBACK,
  MIN_COLS,
  MIN_ROWS,
  MIN_SCROLLBACK,
  clampInt,
  sessionKey,
  trimHistory,
  type StudioTerminalBackend,
  type StudioTerminalProcess,
  type StudioTerminalSessionListener,
  type StudioTerminalSessionRecord,
  type StudioTerminalSessionRequest,
  type StudioTerminalSessionSnapshot,
  type StudioTerminalSidecarStatus,
  type StudioTerminalSidecarStatusListener,
} from "./terminal/StudioTerminalSessionTypes";

export type {
  StudioTerminalShellProfile,
  StudioTerminalSessionEvent,
  StudioTerminalSessionListener,
  StudioTerminalSessionRequest,
  StudioTerminalSessionSnapshot,
  StudioTerminalSessionStatus,
  StudioTerminalSidecarStatus,
  StudioTerminalSidecarStatusListener,
} from "./terminal/StudioTerminalSessionTypes";

export class StudioTerminalSessionManager {
  private readonly sessions = new Map<string, StudioTerminalSessionRecord>();
  private readonly backend: StudioTerminalBackend;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options?: {
      backend?: StudioTerminalBackend;
    }
  ) {
    this.backend = options?.backend || new StudioTerminalSidecarBackend(plugin);
  }

  private createRecord(projectPath: string, nodeId: string): StudioTerminalSessionRecord {
    return {
      sessionId: sessionKey(projectPath, nodeId),
      projectPath,
      nodeId,
      status: "idle",
      cwd: "",
      shellProfile: "auto",
      shellCommand: "",
      shellArgs: [],
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      history: "",
      historyRevision: 0,
      startedAt: null,
      updatedAt: nowIso(),
      exitCode: null,
      errorMessage: "",
      process: null,
      startPromise: null,
      observers: new Set(),
      maxHistoryChars: MAX_HISTORY_CHARS,
      stopRequested: false,
      stripZshPromptSpacingPrelude: false,
      zshStartupBuffer: "",
    };
  }

  private readSnapshot(record: StudioTerminalSessionRecord): StudioTerminalSessionSnapshot {
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
      webSocketUrl: record.webSocketUrl,
    };
  }

  private hydrateRecordFromSnapshot(record: StudioTerminalSessionRecord, snapshot: StudioTerminalSessionSnapshot): void {
    record.status = snapshot.status;
    record.cwd = snapshot.cwd;
    record.shellProfile = snapshot.shellProfile;
    record.shellCommand = snapshot.shellCommand;
    record.shellArgs = [...snapshot.shellArgs];
    record.cols = snapshot.cols;
    record.rows = snapshot.rows;
    record.history = snapshot.history;
    record.historyRevision = snapshot.historyRevision;
    record.startedAt = snapshot.startedAt;
    record.updatedAt = snapshot.updatedAt;
    record.exitCode = snapshot.exitCode;
    record.errorMessage = snapshot.errorMessage;
    record.webSocketUrl = snapshot.webSocketUrl;
  }

  private notifySnapshot(record: StudioTerminalSessionRecord): void {
    const snapshot = this.readSnapshot(record);
    for (const listener of record.observers) {
      try {
        listener({
          type: "snapshot",
          snapshot,
        });
      } catch {}
    }
  }

  private notifyData(record: StudioTerminalSessionRecord, data: string): void {
    if (!data) {
      return;
    }
    for (const listener of record.observers) {
      try {
        listener({
          type: "data",
          sessionId: record.sessionId,
          projectPath: record.projectPath,
          nodeId: record.nodeId,
          historyRevision: record.historyRevision,
          data,
        });
      } catch {}
    }
  }

  private upsertRecord(projectPath: string, nodeId: string): StudioTerminalSessionRecord {
    const key = sessionKey(projectPath, nodeId);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const created = this.createRecord(projectPath, nodeId);
    this.sessions.set(key, created);
    return created;
  }

  subscribe(
    options: {
      projectPath: string;
      nodeId: string;
    },
    listener: StudioTerminalSessionListener
  ): () => void {
    const projectPath = String(options.projectPath || "").trim();
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return () => {};
    }
    const record = this.upsertRecord(projectPath, nodeId);
    record.observers.add(listener);
    try {
      listener({
        type: "snapshot",
        snapshot: this.readSnapshot(record),
      });
    } catch {}
    return () => {
      record.observers.delete(listener);
    };
  }

  getSnapshot(options: { projectPath: string; nodeId: string }): StudioTerminalSessionSnapshot | null {
    const key = sessionKey(String(options.projectPath || "").trim(), String(options.nodeId || "").trim());
    const record = this.sessions.get(key);
    if (!record) {
      return null;
    }
    return this.readSnapshot(record);
  }

  async peekSession(options: { projectPath: string; nodeId: string }): Promise<StudioTerminalSessionSnapshot | null> {
    const projectPath = String(options.projectPath || "").trim();
    const nodeId = String(options.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      return null;
    }
    const key = sessionKey(projectPath, nodeId);

    if (typeof this.backend.peekSession !== "function") {
      const record = this.sessions.get(key);
      return record ? this.readSnapshot(record) : null;
    }

    const snapshot = await this.backend.peekSession({ sessionId: key });
    if (!snapshot) {
      return null;
    }

    const record = this.upsertRecord(projectPath, nodeId);
    this.hydrateRecordFromSnapshot(record, snapshot);
    this.notifySnapshot(record);
    return this.readSnapshot(record);
  }

  getSidecarStatus(): StudioTerminalSidecarStatus | null {
    if (typeof this.backend.getSidecarStatus !== "function") {
      return null;
    }
    return this.backend.getSidecarStatus();
  }

  subscribeSidecarStatus(listener: StudioTerminalSidecarStatusListener): () => void {
    if (typeof this.backend.subscribeSidecarStatus !== "function") {
      return () => {};
    }
    return this.backend.subscribeSidecarStatus(listener);
  }

  async refreshSidecarStatus(): Promise<StudioTerminalSidecarStatus | null> {
    if (typeof this.backend.refreshSidecarStatus === "function") {
      return await this.backend.refreshSidecarStatus();
    }
    return this.getSidecarStatus();
  }

  async ensureSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    const projectPath = String(request.projectPath || "").trim();
    const nodeId = String(request.nodeId || "").trim();
    if (!projectPath || !nodeId) {
      throw new Error("Terminal session requires projectPath and nodeId.");
    }
    if (!Platform.isDesktopApp) {
      throw new Error("Interactive terminal sessions are desktop-only.");
    }

    const record = this.upsertRecord(projectPath, nodeId);
    if (record.status === "running" && record.process) {
      return this.readSnapshot(record);
    }
    if (record.startPromise) {
      return await record.startPromise;
    }

    const cols = clampInt(request.cols, record.cols || DEFAULT_COLS, MIN_COLS, 1000);
    const rows = clampInt(request.rows, record.rows || DEFAULT_ROWS, MIN_ROWS, 600);
    const scrollback = clampInt(request.scrollback, DEFAULT_SCROLLBACK, MIN_SCROLLBACK, MAX_SCROLLBACK);
    const cwd = String(request.cwd || "").trim();
    if (!cwd) {
      throw new Error("Terminal session requires a non-empty cwd.");
    }

    record.cols = cols;
    record.rows = rows;
    record.cwd = cwd;
    record.shellProfile = (String(request.shellProfile || "auto").trim() || "auto") as StudioTerminalSessionRecord["shellProfile"];
    record.maxHistoryChars = Math.max(10_000, Math.min(MAX_HISTORY_CHARS, scrollback * 400));
    record.errorMessage = "";
    record.exitCode = null;
    const shouldResetHistory =
      !(this.backend.keepsSessionsOnDispose === true && record.status === "running" && !record.process);
    record.status = shouldResetHistory ? "starting" : "running";
    record.stopRequested = false;
    record.updatedAt = nowIso();
    if (shouldResetHistory) {
      record.history = "";
      record.historyRevision += 1;
    }
    this.notifySnapshot(record);

    record.startPromise = this.startRecord(record).finally(() => {
      record.startPromise = null;
    });
    return await record.startPromise;
  }

  async restartSession(request: StudioTerminalSessionRequest): Promise<StudioTerminalSessionSnapshot> {
    await this.stopSession({
      projectPath: request.projectPath,
      nodeId: request.nodeId,
    });
    return await this.ensureSession(request);
  }

  async terminateProjectSessions(options: { projectPath: string; reason?: string }): Promise<void> {
    const projectPath = String(options.projectPath || "").trim();
    if (!projectPath) {
      return;
    }

    const matchingRecords = Array.from(this.sessions.values()).filter((record) => record.projectPath === projectPath);
    if (matchingRecords.length === 0) {
      return;
    }

    if (typeof this.backend.terminateProjectSessions === "function") {
      await this.backend.terminateProjectSessions({
        projectPath,
        reason: String(options.reason || "").trim(),
      });
    } else {
      await Promise.allSettled(
        matchingRecords.map((record) =>
          this.stopSession({
            projectPath: record.projectPath,
            nodeId: record.nodeId,
          })
        )
      );
    }

    for (const record of matchingRecords) {
      try {
        record.process?.dispose?.();
      } catch {}
      record.process = null;
      record.startPromise = null;
      record.stopRequested = false;
      record.status = "stopped";
      record.exitCode = null;
      record.errorMessage = "";
      record.updatedAt = nowIso();
      this.notifySnapshot(record);
      record.observers.clear();
      this.sessions.delete(record.sessionId);
    }
  }

  async stopSession(options: { projectPath: string; nodeId: string }): Promise<void> {
    const key = sessionKey(String(options.projectPath || "").trim(), String(options.nodeId || "").trim());
    const record = this.sessions.get(key);

    if (typeof this.backend.stopSession === "function") {
      await this.backend.stopSession(key);
      if (record) {
        record.stopRequested = true;
        record.status = "stopped";
        record.updatedAt = nowIso();
        this.notifySnapshot(record);
      }
      return;
    }

    if (!record) {
      return;
    }
    record.stopRequested = true;
    const process = record.process;
    if (process) {
      try {
        process.kill();
      } catch {}
      return;
    }
    record.status = "stopped";
    record.updatedAt = nowIso();
    this.notifySnapshot(record);
  }

  clearHistory(options: { projectPath: string; nodeId: string }): void {
    const key = sessionKey(String(options.projectPath || "").trim(), String(options.nodeId || "").trim());
    const record = this.sessions.get(key);
    if (!record) {
      return;
    }
    record.history = "";
    record.historyRevision += 1;
    record.updatedAt = nowIso();
    this.notifySnapshot(record);
    if (typeof this.backend.clearHistory === "function") {
      void Promise.resolve(this.backend.clearHistory(key)).catch(() => {});
    }
  }

  writeInput(options: { projectPath: string; nodeId: string; data: string }): void {
    const key = sessionKey(String(options.projectPath || "").trim(), String(options.nodeId || "").trim());
    const record = this.sessions.get(key);
    if (!record) {
      return;
    }
    const data = String(options.data || "");
    if (!data) {
      return;
    }
    if (record.process && record.status === "running") {
      try {
        record.process.write(data);
      } catch {}
      return;
    }
    if (typeof this.backend.writeInput === "function") {
      void Promise.resolve(
        this.backend.writeInput({
          sessionId: key,
          data,
        })
      ).catch(() => {});
    }
  }

  resizeSession(options: { projectPath: string; nodeId: string; cols: number; rows: number }): void {
    const key = sessionKey(String(options.projectPath || "").trim(), String(options.nodeId || "").trim());
    const record = this.sessions.get(key);
    if (!record) {
      return;
    }
    const cols = clampInt(options.cols, record.cols || DEFAULT_COLS, MIN_COLS, 1000);
    const rows = clampInt(options.rows, record.rows || DEFAULT_ROWS, MIN_ROWS, 600);
    if (record.cols === cols && record.rows === rows) {
      return;
    }
    record.cols = cols;
    record.rows = rows;
    record.updatedAt = nowIso();
    if (record.process && record.status === "running") {
      try {
        record.process.resize(cols, rows);
      } catch {}
    } else if (typeof this.backend.resizeSession === "function") {
      void Promise.resolve(
        this.backend.resizeSession({
          sessionId: key,
          cols,
          rows,
        })
      ).catch(() => {});
    }
    this.notifySnapshot(record);
  }

  async dispose(): Promise<void> {
    if (this.backend.keepsSessionsOnDispose === true) {
      for (const record of this.sessions.values()) {
        try {
          record.process?.dispose?.();
        } catch {}
        record.process = null;
        record.startPromise = null;
        record.observers.clear();
      }
      this.sessions.clear();
      if (typeof this.backend.dispose === "function") {
        await this.backend.dispose();
      }
      return;
    }

    const stopJobs: Promise<void>[] = [];
    for (const record of this.sessions.values()) {
      stopJobs.push(
        this.stopSession({
          projectPath: record.projectPath,
          nodeId: record.nodeId,
        })
      );
    }
    await Promise.allSettled(stopJobs);
    this.sessions.clear();
    if (typeof this.backend.dispose === "function") {
      await this.backend.dispose();
    }
  }

  private async startRecord(record: StudioTerminalSessionRecord): Promise<StudioTerminalSessionSnapshot> {
    const env = buildStudioTerminalEnv(process.env);
    const candidates = shellCandidates(record.shellProfile);
    const failureMessages: string[] = [];

    for (const candidate of candidates) {
      try {
        const process = await this.backend.spawn({
          command: candidate.command,
          args: candidate.args,
          cwd: record.cwd,
          cols: record.cols,
          rows: record.rows,
          env,
          sessionId: record.sessionId,
          projectPath: record.projectPath,
          nodeId: record.nodeId,
          shellProfile: record.shellProfile,
          maxHistoryChars: record.maxHistoryChars,
        });
        this.attachProcess(record, process, candidate.command, candidate.args);
        return this.readSnapshot(record);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failureMessages.push(`${candidate.command}: ${message}`);
        // Module-load failures are independent of shell candidate selection.
        if (message.includes("node-pty") || message.includes("module specifier")) {
          break;
        }
      }
    }

    record.status = "failed";
    record.errorMessage =
      failureMessages.length > 0
        ? `Unable to launch shell (${failureMessages.join(" | ")})`
        : "Unable to launch shell.";
    record.updatedAt = nowIso();
    this.notifySnapshot(record);
    this.plugin.getLogger().warn(`Studio terminal failed to launch: ${record.errorMessage}`, {
      source: "StudioTerminalSessionManager",
      metadata: {
        projectPath: record.projectPath,
        nodeId: record.nodeId,
        error: record.errorMessage,
      },
    });
    return this.readSnapshot(record);
  }

  private attachProcess(
    record: StudioTerminalSessionRecord,
    process: StudioTerminalProcess,
    shellCommand: string,
    shellArgs: string[]
  ): void {
    record.process = process;
    record.shellCommand = shellCommand;
    record.shellArgs = [...shellArgs];
    if ('webSocketUrl' in process && typeof process.webSocketUrl === 'string') {
      record.webSocketUrl = process.webSocketUrl;
    }
    record.status = "running";
    record.startedAt = nowIso();
    record.updatedAt = record.startedAt;
    record.exitCode = null;
    record.errorMessage = "";
    record.stripZshPromptSpacingPrelude = isZshShellCommand(shellCommand);
    record.zshStartupBuffer = "";
    this.notifySnapshot(record);

    const disposeData = process.onData((chunk) => {
      const rawData = String(chunk || "");
      if (!rawData) {
        return;
      }
      if (record.stripZshPromptSpacingPrelude) {
        record.zshStartupBuffer += rawData;
        const shouldFlushStartupBuffer =
          record.zshStartupBuffer.includes("\u001b[?2004h") ||
          record.zshStartupBuffer.includes("\n") ||
          record.zshStartupBuffer.length >= 8_192;
        if (!shouldFlushStartupBuffer) {
          return;
        }
        const strippedStartup = stripZshPromptSpacingPrelude(record.zshStartupBuffer);
        record.zshStartupBuffer = "";
        record.stripZshPromptSpacingPrelude = false;
        if (!strippedStartup) {
          return;
        }
        record.history = trimHistory(record.history + strippedStartup, record.maxHistoryChars);
        record.updatedAt = nowIso();
        this.notifyData(record, strippedStartup);
        return;
      }

      record.history = trimHistory(record.history + rawData, record.maxHistoryChars);
      record.updatedAt = nowIso();
      this.notifyData(record, rawData);
    });

    const disposeExit = process.onExit((event) => {
      disposeData();
      disposeExit();
      try {
        process.dispose?.();
      } catch {}
      record.process = null;
      record.status = record.stopRequested ? "stopped" : "failed";
      record.exitCode = Number.isFinite(event.exitCode) ? Math.floor(event.exitCode) : null;
      record.errorMessage = record.stopRequested ? "" : `Terminal exited${record.exitCode !== null ? ` (${record.exitCode})` : ""}.`;
      record.updatedAt = nowIso();
      record.stopRequested = false;
      this.notifySnapshot(record);
    });
  }
}
