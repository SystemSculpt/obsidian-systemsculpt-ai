import type SystemSculptPlugin from "../main";
import { LogLevel } from "./errorHandling";
import { isAgentLifecyclePhase, isThinAgentIncidentId } from "./ThinAgentLifecycleSchema";
import { projectLifecycleMetadata, type SupportDiagnosticEvent } from "./SupportDiagnosticEvent";

export type PluginLogLevel = "info" | "warn" | "error" | "debug";

export interface PluginLoggerOptions {
  logFileName?: string;
}

export interface PluginLogContext {
  source?: string;
  method?: string;
  command?: string;
  metadata?: Record<string, unknown>;
}

export type { SupportDiagnosticEvent } from "./SupportDiagnosticEvent";

interface PluginLogEntry {
  timestamp: string;
  level: PluginLogLevel;
  message: string;
  context?: PluginLogContext;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    metadata?: Record<string, unknown>;
  };
}

const LEVEL_TO_THRESHOLD: Record<PluginLogLevel, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARNING,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

const THIN_AGENT_FAILURE_INPUT_MESSAGE = "ChatView agent session failed";
const THIN_AGENT_FAILURE_LOG_MESSAGE = "thin-agent:failure";
const THIN_AGENT_FAILURE_DEDUPE_MS = 1_000;
const MAX_RECENT_THIN_AGENT_FAILURES = 128;
const SAFE_THIN_AGENT_FAILURE_CODES = new Set([
  "agent_turn_failed",
  "approval_failed",
  "context_prepare_failed",
  "context_too_large",
  "context_window_exhausted",
  "history_sync_failed",
  "insufficient_credits",
  "invalid_response_data",
  "invalid_turn_context",
  "local_tool_result_failed",
  "message_save_failed",
  "response_display_failed",
  "response_failed",
  "response_finished_with_pending_vault_action",
  "response_in_progress",
  "response_interrupted",
  "response_save_failed",
  "response_start_failed",
  "response_start_rate_limited",
  "response_state_update_failed",
  "selected_context_unavailable",
  "service_accounting_unavailable",
  "service_cost_unavailable",
  "service_outcome_unknown",
  "service_rate_limited",
  "service_temporarily_unavailable",
  "session_expired",
  "session_history_load_failed",
  "session_interrupted",
  "tool_call_id_conflict",
  "tool_mutation_journal_unavailable",
  "tool_mutation_outcome_unknown",
  "tool_result_display_failed",
  "web_search_unavailable",
]);
const THIN_AGENT_FAILURE_METHODS: Readonly<Record<string, Readonly<{ phase: string; origin: string }>>> = {
  approvalModeChange: { phase: "session", origin: "approval_mode_change" },
  loadChatHydration: { phase: "start", origin: "chat_hydration" },
  agentSession: { phase: "response", origin: "session_callback" },
  reportAgentError: { phase: "response", origin: "session_callback" },
  completedRunSettlement: { phase: "persistence", origin: "run_settlement" },
  agentSnapshotRender: { phase: "render", origin: "snapshot_render" },
  historicalResubmit: { phase: "unknown", origin: "historical_resubmit" },
  warmThinConversation: { phase: "start", origin: "warm_bootstrap" },
};
const THIN_AGENT_FAILURE_ORIGINS = new Set([
  "unknown", ...Object.values(THIN_AGENT_FAILURE_METHODS).map(({ origin }) => origin),
]);
const THIN_AGENT_FAILURE_CAUSES = new Set([
  "aborted",
  "generic_error",
  "history_generation_changed",
  "invalid_data",
  "message_not_found",
  "network",
  "non_error",
  "object_error",
  "preparation_superseded",
  "session_generation_changed",
  "session_not_ready",
  "timed_out",
  "type_error",
  "view_detached",
]);
type NormalizedThinAgentFailure = Readonly<{
  message: typeof THIN_AGENT_FAILURE_LOG_MESSAGE;
  context: PluginLogContext;
  dedupeKey: string;
}>;

/**
 * Structured logger that persists entries for later diagnostics.
 */
export class PluginLogger {
  private readonly plugin: SystemSculptPlugin;
  private readonly buffer: PluginLogEntry[] = [];
  private readonly pendingFlush: PluginLogEntry[] = [];
  private flushTimer: number | null = null;
  private readonly maxEntries = 600;
  private readonly flushIntervalMs = 1500;
  private logFileName = "systemsculpt.log";
  private readonly maxLogFileBytes = 1_000_000; // 1 MB cap per log file
  private activeFlush: Promise<void> | null = null;
  private preUnloadFlush: Promise<void> | null = null;
  private drainingForUnload = false;
  private readonly recentThinAgentFailures = new Map<string, number>();

  constructor(plugin: SystemSculptPlugin, options?: PluginLoggerOptions) {
    this.plugin = plugin;
    if (options?.logFileName) {
      this.logFileName = options.logFileName;
    }
  }

  info(message: string, context?: PluginLogContext): void {
    this.write("info", message, undefined, context);
  }

  lifecycle(metadata: Record<string, unknown>): SupportDiagnosticEvent | null {
    const projection = projectLifecycleMetadata(metadata);
    if (!projection) return null;
    const entry = this.write("info", "thin-agent:lifecycle", undefined, {
      source: "AgentLifecycle",
      metadata: projection.persisted,
    });
    return entry ? Object.freeze({
      timestamp: entry.timestamp,
      severity: "info",
      ...projection.fields,
    }) : null;
  }

  warn(message: string, context?: PluginLogContext): void {
    this.write("warn", message, undefined, context);
  }

  error(message: string, error?: unknown, context?: PluginLogContext): void {
    this.write("error", message, error, context);
  }

  debug(message: string, context?: PluginLogContext): void {
    this.write("debug", message, undefined, context);
  }

  getRecentEntries(): PluginLogEntry[] {
    return [...this.buffer];
  }

  /**
   * Return the content-free subset that may be copied into a support report.
   * Generic logs remain available only to the local diagnostics file. Rebuild
   * every record from the strict lifecycle/failure allowlists so a caller
   * cannot smuggle messages, stacks, vault data, or arbitrary metadata through
   * a mutated buffered entry.
   */
  getSupportDiagnostics(limit: number = 200): SupportDiagnosticEvent[] {
    const boundedLimit = normalizeSupportLimit(limit);
    if (boundedLimit === 0) return [];

    return this.buffer
      .map(projectSupportDiagnosticEvent)
      .filter((entry): entry is SupportDiagnosticEvent => entry !== null)
      .slice(-boundedLimit);
  }

  setLogFileName(fileName: string): void {
    if (fileName && fileName !== this.logFileName) {
      this.logFileName = fileName;
    }
  }

  private write(
    level: PluginLogLevel,
    message: string,
    error?: unknown,
    context?: PluginLogContext,
  ): PluginLogEntry | null {
    // Disabled means inert (#214/#158): once the plugin is unloading, stop
    // buffering and scheduling new diagnostics so nothing writes after disable.
    if (this.drainingForUnload || this.plugin?.isPluginUnloading?.()) {
      return null;
    }
    if (!this.shouldLog(level, context)) {
      return null;
    }
    const thinAgentFailure = normalizeThinAgentFailure(level, message, error, context);
    if (thinAgentFailure && this.isDuplicateThinAgentFailure(thinAgentFailure.dedupeKey)) {
      return null;
    }

    const entry: PluginLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: thinAgentFailure?.message ?? message,
      context: thinAgentFailure?.context
        ?? (context && Object.keys(context).length > 0 ? sanitizeContext(context) : undefined),
      error: thinAgentFailure ? undefined : error ? serializeError(error) : undefined,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    this.pendingFlush.push(entry);
    this.ensureFlushScheduled();
    if (thinAgentFailure || entry.context?.source === "AgentLifecycle") {
      // Thin-agent diagnostics are already durably persisted here and, when
      // connected, emitted through the strict client-diagnostic contract.
      // Echoing them to the console would reintroduce arbitrary Error
      // messages and stacks.
      return entry;
    }
    this.emitToConsole(entry, error);
    return entry;
  }

  private isDuplicateThinAgentFailure(key: string): boolean {
    const now = Date.now();
    for (const [candidate, recordedAt] of this.recentThinAgentFailures) {
      if (now - recordedAt > THIN_AGENT_FAILURE_DEDUPE_MS) {
        this.recentThinAgentFailures.delete(candidate);
      }
    }
    const prior = this.recentThinAgentFailures.get(key);
    if (prior !== undefined && now - prior <= THIN_AGENT_FAILURE_DEDUPE_MS) {
      return true;
    }
    this.recentThinAgentFailures.set(key, now);
    if (this.recentThinAgentFailures.size > MAX_RECENT_THIN_AGENT_FAILURES) {
      const oldest = this.recentThinAgentFailures.keys().next().value as string | undefined;
      if (oldest) this.recentThinAgentFailures.delete(oldest);
    }
    return false;
  }

  private shouldLog(level: PluginLogLevel, context?: PluginLogContext): boolean {
    if (this.plugin.settings?.debugMode) {
      return true;
    }

    if (context?.source === "InitializationTracer") {
      if (level === "warn" || level === "error") {
        return true;
      }
      // info/debug entries fall through to standard level gating
    }
    if (context?.source === "AgentLifecycle" && level === "info") {
      return true;
    }

    const settingsLevel = this.plugin.settings?.logLevel ?? LogLevel.WARNING;
    return settingsLevel >= LEVEL_TO_THRESHOLD[level];
  }

  private ensureFlushScheduled() {
    if (this.drainingForUnload || this.plugin?.isPluginUnloading?.()) {
      return;
    }
    if (typeof window === "undefined") {
      void this.flushPendingEntries();
      return;
    }
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingEntries().catch(() => undefined);
    }, this.flushIntervalMs);
  }

  public async flushNow(): Promise<void> {
    await this.flushPendingEntries(true);
  }

  /**
   * Quiesce the logger and persist every entry accepted before plugin unload.
   * Repeated callers share the same drain.
   */
  public flushBeforeUnload(): Promise<void> {
    if (this.preUnloadFlush) return this.preUnloadFlush;
    this.drainingForUnload = true;
    this.cancelFlushTimer();

    const drain = async (): Promise<void> => {
      if (this.activeFlush) await this.activeFlush;
      if (this.pendingFlush.length > 0) {
        await this.flushPendingEntries(true);
      }
    };
    this.preUnloadFlush = drain();
    return this.preUnloadFlush;
  }

  /**
   * Stop the logger for plugin unload (#214/#158): cancel the self-rescheduling
   * flush timer and drop any pending entries so the logger does not keep writing
   * diagnostics to disk after the plugin is disabled.
   */
  public dispose(): void {
    this.drainingForUnload = true;
    this.cancelFlushTimer();
    this.pendingFlush.length = 0;
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) {
      if (typeof window !== "undefined") {
        window.clearTimeout(this.flushTimer);
      }
      this.flushTimer = null;
    }
  }

  private flushPendingEntries(force: boolean = false): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (this.pendingFlush.length === 0) return Promise.resolve();

    const operation = this.performFlush(force);
    this.activeFlush = operation;
    void operation.finally(() => {
      if (this.activeFlush === operation) this.activeFlush = null;
    });
    return operation;
  }

  private async performFlush(force: boolean): Promise<void> {
    // Disabled means inert (#214/#158): never flush once unloading; drop queue.
    if (this.plugin?.isPluginUnloading?.()) {
      this.pendingFlush.length = 0;
      return;
    }
    let entries: PluginLogEntry[] = [];
    try {
      const storage = this.plugin.storage;
      if (!storage) {
        // Storage not ready yet. Normal operation may retry; the unload drain
        // makes one immediate attempt and disposal drops the undurable queue.
        if (!force) {
          this.ensureFlushScheduled();
        }
        return;
      }

      entries = this.pendingFlush.splice(0, this.pendingFlush.length);
      if (entries.length === 0) return;

      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      const result = await storage.appendToFile("diagnostics", this.logFileName, payload);
      if (result?.success === false) {
        throw new Error("Diagnostics storage rejected the log batch.");
      }
      await this.enforceSizeLimit();
    } catch (error) {
      if (entries.length > 0 && !this.plugin?.isPluginUnloading?.()) {
        this.pendingFlush.unshift(...entries);
        if (!force) this.ensureFlushScheduled();
      }
      this.emitToConsole(
        {
          level: "error",
          message: "Failed to flush plugin logs",
          timestamp: new Date().toISOString(),
          context: { source: "PluginLogger" },
          error: serializeError(error),
        },
        error
      );
    }
  }

  private async enforceSizeLimit() {
    // Disabled means inert (#214/#158): this trims the log via a direct adapter
    // write that bypasses the StorageManager guard, so it must bail on unload.
    if (this.plugin?.isPluginUnloading?.()) {
      return;
    }
    const adapter = this.plugin.app.vault.adapter;
    const storage = this.plugin.storage;
    if (!storage) {
      return;
    }

    const path = storage.getPath("diagnostics", this.logFileName);
    try {
      const stats = await adapter.stat(path);
      if (!stats || typeof stats.size !== "number" || stats.size <= this.maxLogFileBytes) {
        return;
      }

      // Re-check after awaiting stat: unload may have begun mid-flight (#214).
      if (this.plugin?.isPluginUnloading?.()) {
        return;
      }
      // Trim file to the last portion of buffered entries to keep context
      const recent = this.buffer.slice(-200).map((entry) => JSON.stringify(entry)).join("\n");
      await adapter.write(path, `${recent}\n`);
    } catch {
      // Ignore trimming failures silently
    }
  }

  private emitToConsole(entry: PluginLogEntry, error?: unknown) {
    if (typeof console === "undefined") {
      return;
    }
    const prefix = `[SystemSculpt][${entry.level.toUpperCase()}] ${entry.message}`;
    const parts: unknown[] = [prefix];
    if (entry.context) {
      parts.push(entry.context);
    }
    if (error) {
      parts.push(error);
    }
    const method = resolveConsoleMethod(entry.level);
    method(...parts);
  }
}

function sanitizeContext(context: PluginLogContext): PluginLogContext {
  const safeContext: PluginLogContext = {};
  if (context.source) safeContext.source = context.source;
  if (context.method) safeContext.method = context.method;
  if (context.command) safeContext.command = context.command;
  if (context.metadata) {
    try {
      safeContext.metadata = JSON.parse(JSON.stringify(context.metadata));
    } catch {
      safeContext.metadata = { note: "metadata_unserializable" };
    }
  }
  return safeContext;
}

function projectSupportDiagnosticEvent(entry: PluginLogEntry): SupportDiagnosticEvent | null {
  try {
    const timestamp = validIsoTimestamp(entry.timestamp);
    const metadata = entry.context?.metadata;
    if (!timestamp || !metadata) return null;
    if (entry.level === "info" && entry.message === "thin-agent:lifecycle" && entry.context?.source === "AgentLifecycle") {
      const projection = projectLifecycleMetadata(metadata);
      return projection ? Object.freeze({ timestamp, severity: "info", ...projection.fields }) : null;
    }
    if (entry.level !== "error" || entry.message !== THIN_AGENT_FAILURE_LOG_MESSAGE || entry.context?.source !== "ThinAgentClient") return null;
    const { code, phase, origin, cause, sequence, status, retryable, incidentId } = metadata;
    if (typeof code !== "string" || (!SAFE_THIN_AGENT_FAILURE_CODES.has(code) && code !== "client_failure") || !isAgentLifecyclePhase(phase)) return null;
    return Object.freeze({
      timestamp,
      severity: "error",
      code,
      phase,
      ...(typeof origin === "string" && THIN_AGENT_FAILURE_ORIGINS.has(origin) ? { origin } : {}),
      ...(typeof cause === "string" && THIN_AGENT_FAILURE_CAUSES.has(cause) ? { cause } : {}),
      ...(Number.isSafeInteger(sequence) && (sequence as number) > 0 ? { sequence: sequence as number } : {}),
      ...(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? { status: status as number } : {}),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(isThinAgentIncidentId(incidentId) ? { incident_id: incidentId } : {}),
    });
  } catch {
    return null;
  }
}

function normalizeSupportLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 200;
  return Math.min(500, Math.max(0, Math.floor(limit)));
}

function validIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? value : null;
}

function normalizeThinAgentFailure(
  level: PluginLogLevel,
  message: string,
  error: unknown,
  context?: PluginLogContext,
): NormalizedThinAgentFailure | null {
  if (
    level !== "error"
    || message !== THIN_AGENT_FAILURE_INPUT_MESSAGE
    || context?.source !== "AgentChatView"
  ) {
    return null;
  }
  const candidate = snapshotThinAgentError(error);
  const code = typeof candidate.code === "string"
    && SAFE_THIN_AGENT_FAILURE_CODES.has(candidate.code)
    ? candidate.code
    : "client_failure";
  const status = Number.isInteger(candidate.status)
    && (candidate.status as number) >= 100
    && (candidate.status as number) <= 599
    ? candidate.status as number
    : undefined;
  const incidentCandidate = candidate.incidentId ?? candidate.requestId;
  const incidentId = isThinAgentIncidentId(incidentCandidate)
    ? incidentCandidate
    : undefined;
  const method = context.method;
  const { phase, origin } = method && Object.prototype.hasOwnProperty.call(THIN_AGENT_FAILURE_METHODS, method)
    ? THIN_AGENT_FAILURE_METHODS[method]
    : { phase: "unknown", origin: "unknown" };
  const cause = code === "client_failure"
    ? thinAgentFailureCause(candidate)
    : undefined;
  const metadata: Record<string, unknown> = {
    code,
    phase,
    ...(cause ? { origin, cause } : {}),
    ...(status === undefined ? {} : { status }),
    ...(typeof candidate.retryable === "boolean"
      ? { retryable: candidate.retryable }
      : {}),
    ...(incidentId ? { incidentId } : {}),
  };
  return {
    message: THIN_AGENT_FAILURE_LOG_MESSAGE,
    context: {
      source: "ThinAgentClient",
      metadata,
    },
    dedupeKey: JSON.stringify(metadata),
  };
}

type ThinAgentErrorSnapshot = Readonly<{
  isObject: boolean;
  isError: boolean;
  code?: unknown;
  status?: unknown;
  incidentId?: unknown;
  requestId?: unknown;
  retryable?: unknown;
  name?: unknown;
  message?: unknown;
}>;

function snapshotThinAgentError(error: unknown): ThinAgentErrorSnapshot {
  try {
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      return { isObject: false, isError: false };
    }
    const source = error as Record<string, unknown>;
    return {
      isObject: true,
      isError: error instanceof Error,
      code: source.code,
      status: source.status,
      incidentId: source.incidentId,
      requestId: source.requestId,
      retryable: source.retryable,
      name: source.name,
      message: source.message,
    };
  } catch {
    // A hostile error must remain content-free, never fall back to raw logging.
    return { isObject: true, isError: false };
  }
}

function thinAgentFailureCause(candidate: ThinAgentErrorSnapshot): string {
  if (!candidate.isObject) {
    return "non_error";
  }
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (
    name === "ConversationPreparationCancelled"
    || message === "Conversation preparation was superseded."
  ) {
    return "preparation_superseded";
  }
  if (
    name === "AbortError"
    || ["ABORT_ERR", "ERR_ABORTED", "ERR_CANCELED"].includes(code)
  ) {
    return "aborted";
  }
  if (
    name === "TimeoutError"
    || ["ETIMEDOUT", "ERR_TIMEOUT"].includes(code)
  ) {
    return "timed_out";
  }
  if (
    name === "NetworkError"
    || ["ECONNABORTED", "ECONNRESET", "ENETDOWN", "ENETUNREACH"].includes(code)
  ) {
    return "network";
  }
  if (message === "This chat changed while the response was starting.") {
    return "session_generation_changed";
  }
  if (message === "This chat changed while its history was loading.") {
    return "history_generation_changed";
  }
  if (message === "SystemSculpt is no longer available in this chat.") {
    return "view_detached";
  }
  if (
    message === "SystemSculpt is not ready. Retry this message."
    || message === "This chat session is no longer ready. Retry this message."
  ) {
    return "session_not_ready";
  }
  if (/^message .+ not found$/u.test(message)) return "message_not_found";
  if (name === "TypeError") return "type_error";
  if (name === "SyntaxError") return "invalid_data";
  if (candidate.isError) return "generic_error";
  return "object_error";
}

function serializeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) serialized.stack = error.stack;
    const extra = error as Error & { code?: unknown; status?: unknown };
    if (typeof extra.code !== "undefined") serialized.code = extra.code;
    if (typeof extra.status !== "undefined") serialized.status = extra.status;
    return serialized;
  }
  if (typeof error === "object") {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}

function resolveConsoleMethod(level: PluginLogLevel): (...args: unknown[]) => void {
  if (typeof console === "undefined") {
    return () => {};
  }
  switch (level) {
    case "error":
      return console.error ? console.error.bind(console) : console.warn.bind(console);
    case "warn":
      return console.warn ? console.warn.bind(console) : console.debug.bind(console);
    case "info":
      return console.debug ? console.debug.bind(console) : console.warn.bind(console);
    case "debug":
    default:
      return console.debug ? console.debug.bind(console) : console.warn.bind(console);
  }
}
