export type StudioTerminalShellProfile = "auto" | "pwsh" | "powershell" | "cmd" | "bash" | "zsh";
export type StudioTerminalSessionStatus = "idle" | "starting" | "running" | "stopped" | "failed";

export type StudioTerminalSessionSnapshot = {
  sessionId: string;
  projectPath: string;
  nodeId: string;
  status: StudioTerminalSessionStatus;
  cwd: string;
  shellProfile: StudioTerminalShellProfile;
  shellCommand: string;
  shellArgs: string[];
  cols: number;
  rows: number;
  history: string;
  historyRevision: number;
  startedAt: string | null;
  updatedAt: string;
  exitCode: number | null;
  errorMessage: string;
  webSocketUrl?: string;
};

export type StudioTerminalSessionEvent =
  | {
    type: "snapshot";
    snapshot: StudioTerminalSessionSnapshot;
  }
  | {
    type: "data";
    sessionId: string;
    projectPath: string;
    nodeId: string;
    historyRevision: number;
    data: string;
  };

export type StudioTerminalSessionListener = (event: StudioTerminalSessionEvent) => void;
export type StudioTerminalSidecarSessionEvent = StudioTerminalSessionEvent;
export type StudioTerminalSidecarSessionEventListener = (event: StudioTerminalSidecarSessionEvent) => void;

export type StudioTerminalSessionRequest = {
  projectPath: string;
  nodeId: string;
  cwd: string;
  shellProfile?: StudioTerminalShellProfile;
  cols?: number;
  rows?: number;
  scrollback?: number;
};

export type StudioTerminalSpawnOptions = {
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  sessionId?: string;
  projectPath?: string;
  nodeId?: string;
  shellProfile?: StudioTerminalShellProfile;
  maxHistoryChars?: number;
  restart?: boolean;
};

export type StudioTerminalProcessExit = {
  exitCode: number;
  signal?: number | string | null;
};

export type StudioTerminalProcess = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (data: string) => void) => () => void;
  onExit: (listener: (event: StudioTerminalProcessExit) => void) => () => void;
  dispose?: () => void;
};

export type StudioTerminalBackend = {
  spawn: (options: StudioTerminalSpawnOptions) => Promise<StudioTerminalProcess>;
  peekSession?: (options: { sessionId: string }) => Promise<StudioTerminalSessionSnapshot | null>;
  writeInput?: (options: { sessionId: string; data: string }) => Promise<void> | void;
  resizeSession?: (options: { sessionId: string; cols: number; rows: number }) => Promise<void> | void;
  clearHistory?: (sessionId: string) => Promise<void> | void;
  stopSession?: (sessionId: string) => Promise<void> | void;
  terminateProjectSessions?: (options: { projectPath: string; reason?: string }) => Promise<void> | void;
  getSidecarStatus?: () => StudioTerminalSidecarStatus | null;
  subscribeSidecarStatus?: (listener: StudioTerminalSidecarStatusListener) => () => void;
  refreshSidecarStatus?: () => Promise<StudioTerminalSidecarStatus | null>;
  keepsSessionsOnDispose?: boolean;
  dispose?: () => Promise<void>;
};

export type StudioTerminalSidecarSessionSummary = {
  sessionId: string;
  status: string;
  cwd: string;
  shellCommand: string;
  updatedAt: string;
  exitCode: number | null;
};

export type StudioTerminalSidecarStatus = {
  state: string;
  protocol: string;
  pid: number | null;
  startedAt: string | null;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  lastClientSeenAt: string | null;
  timeoutMinutes: number;
  timeoutAt: string | null;
  activeConnections: number;
  sessionCount: number;
  sessions: StudioTerminalSidecarSessionSummary[];
  lastShutdownReason: string;
  socketPath: string;
  vaultKey: string;
  message: string;
};

export type StudioTerminalSidecarStatusListener = (status: StudioTerminalSidecarStatus) => void;

export type StudioTerminalSessionRecord = {
  sessionId: string;
  projectPath: string;
  nodeId: string;
  status: StudioTerminalSessionStatus;
  cwd: string;
  shellProfile: StudioTerminalShellProfile;
  shellCommand: string;
  shellArgs: string[];
  cols: number;
  rows: number;
  history: string;
  historyRevision: number;
  startedAt: string | null;
  updatedAt: string;
  exitCode: number | null;
  errorMessage: string;
  process: StudioTerminalProcess | null;
  startPromise: Promise<StudioTerminalSessionSnapshot> | null;
  observers: Set<StudioTerminalSessionListener>;
  maxHistoryChars: number;
  stopRequested: boolean;
  stripZshPromptSpacingPrelude: boolean;
  zshStartupBuffer: string;
  webSocketUrl?: string;
};

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const MIN_COLS = 20;
export const MIN_ROWS = 8;
export const DEFAULT_SCROLLBACK = 4_000;
export const MIN_SCROLLBACK = 200;
export const MAX_SCROLLBACK = 50_000;
export const MAX_HISTORY_CHARS = 2_000_000;

export function sessionKey(projectPath: string, nodeId: string): string {
  return `${projectPath}::${nodeId}`;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function trimHistory(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}
