import type SystemSculptPlugin from "../main";
import {
  isThinAgentCommandKind,
  type ThinAgentCommandKind,
} from "../services/managed/ThinAgentV1Contract";
import { isFirstPartyToolName } from "../tools/toolNames";
import { LogLevel } from "./errorHandling";
import {
  boundedThinAgentIdentifier,
  boundedThinAgentTiming,
  isAgentLifecycleCode,
  isAgentLifecyclePhase,
  isCreditsRefreshReason,
  isHistorySyncKind,
  isToolDiagnosticFailureClass,
  isToolDiagnosticOutcome,
  boundedToolDiagnosticItemCount,
  isThinAgentClientInstanceId,
  isThinAgentConversationId,
  isThinAgentFailureCode,
  isThinAgentIncidentId,
  isThinAgentLatencyTraceId,
  isThinAgentServerRunId,
  type AgentLifecyclePhase,
  type CreditsRefreshReason,
  type HistorySyncKind,
  type ToolDiagnosticFailureClass,
  type ToolDiagnosticOutcome,
} from "./ThinAgentLifecycleSchema";

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

export type SupportDiagnosticEvent = Readonly<{
  timestamp: string;
  severity: "info" | "error";
  code: string;
  phase: AgentLifecyclePhase;
  origin?: string;
  cause?: string;
  sequence?: number;
  conversation_id?: string;
  request_id?: string;
  client_instance_id?: string;
  plugin_build_id?: string;
  run_id?: string;
  server_run_id?: string;
  tool_name?: string;
  status?: number;
  retryable?: boolean;
  incident_id?: string;
  failure_code?: string;
  latency_trace_id?: string;
  command_kind?: ThinAgentCommandKind;
  command_segment_ordinal?: number;
  tool_execution_ordinal?: number;
  tool_outcome?: ToolDiagnosticOutcome;
  tool_failure_class?: ToolDiagnosticFailureClass;
  tool_item_count?: number;
  tool_completed_item_count?: number;
  tool_failed_item_count?: number;
  history_sync_kind?: HistorySyncKind;
  history_sync_ordinal?: number;
  response_delivery_mode?: "fetch_stream" | "request_url_buffered";
  client_monotonic_offset_ms?: number;
  client_clock_domain?: "client_turn_monotonic";
  server_timing_app_ms?: number;
  server_timing_auth_ms?: number;
  server_timing_clock_domain?: "server_response_headers_monotonic_duration";
  credits_refresh_reason?: CreditsRefreshReason;
  credits_refresh_sequence?: number;
  credits_refresh_transport?: "fetch" | "request_url";
  credits_refresh_elapsed_ms?: number;
  credits_refresh_clock_domain?: "client_refresh_monotonic_duration";
  credits_refresh_server_auth_ms?: number;
  credits_refresh_server_rate_limit_ms?: number;
  credits_refresh_server_balance_store_ms?: number;
  credits_refresh_server_total_ms?: number;
  credits_refresh_server_timing_clock_domain?:
    "server_response_headers_monotonic_duration";
}>;

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
const MAX_TOOL_EXECUTION_ORDINAL = 512;
const MAX_HISTORY_SYNC_ORDINAL = 2_048;
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
const THIN_AGENT_FAILURE_ORIGINS = new Set([
  "approval_mode_change",
  "chat_hydration",
  "historical_resubmit",
  "run_settlement",
  "session_callback",
  "snapshot_render",
  "unknown",
  "warm_bootstrap",
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
    const sanitized = sanitizeLifecycleMetadata(metadata);
    if (!sanitized) return null;
    const entry = this.write("info", "thin-agent:lifecycle", undefined, {
      source: "AgentLifecycle",
      metadata: redactPersistedLifecycleMetadata(sanitized),
    });
    if (!entry) return null;
    return projectSupportDiagnosticEvent({
      ...entry,
      context: {
        source: "AgentLifecycle",
        metadata: sanitized,
      },
    });
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
      // Sending them through patched console and ErrorCollector would create
      // duplicate entries and reintroduce arbitrary Error messages/stacks.
      return entry;
    }
    this.emitToConsole(entry, error);
    this.forwardToCollector(entry, error);
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
      this.flushPendingEntries();
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
    const adapter: any = this.plugin.app?.vault?.adapter;
    const storage = this.plugin.storage;
    if (!adapter || typeof adapter.stat !== "function" || !storage) {
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

  private forwardToCollector(entry: PluginLogEntry, error?: unknown) {
    const collector = this.plugin.getErrorCollector();
    if (!collector) {
      return;
    }
    collector.captureLog(
      entry.level === "debug" ? "debug" : entry.level,
      entry.context?.source || "SystemSculpt",
      entry.message,
      error && error instanceof Error ? error.stack : undefined
    );
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

function snapshotLifecycleMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    code: metadata.code,
    phase: metadata.phase,
    sequence: metadata.sequence,
    timestamp: metadata.timestamp,
    conversationId: metadata.conversationId,
    requestId: metadata.requestId,
    clientInstanceId: metadata.clientInstanceId,
    pluginBuildId: metadata.pluginBuildId,
    runId: metadata.runId,
    serverRunId: metadata.serverRunId,
    toolName: metadata.toolName,
    toolCallId: metadata.toolCallId,
    status: metadata.status,
    retryable: metadata.retryable,
    incidentId: metadata.incidentId,
    failureCode: metadata.failureCode,
    latencyTraceId: metadata.latencyTraceId,
    commandKind: metadata.commandKind,
    commandSegmentOrdinal: metadata.commandSegmentOrdinal,
    toolExecutionOrdinal: metadata.toolExecutionOrdinal,
    toolOutcome: metadata.toolOutcome,
    toolFailureClass: metadata.toolFailureClass,
    toolItemCount: metadata.toolItemCount,
    toolCompletedItemCount: metadata.toolCompletedItemCount,
    toolFailedItemCount: metadata.toolFailedItemCount,
    historySyncKind: metadata.historySyncKind,
    historySyncOrdinal: metadata.historySyncOrdinal,
    responseDeliveryMode: metadata.responseDeliveryMode,
    clientMonotonicOffsetMs: metadata.clientMonotonicOffsetMs,
    serverTimingAppMs: metadata.serverTimingAppMs,
    serverTimingAuthMs: metadata.serverTimingAuthMs,
    creditsRefreshReason: metadata.creditsRefreshReason,
    creditsRefreshSequence: metadata.creditsRefreshSequence,
    creditsRefreshTransport: metadata.creditsRefreshTransport,
    creditsRefreshElapsedMs: metadata.creditsRefreshElapsedMs,
    creditsRefreshServerAuthMs: metadata.creditsRefreshServerAuthMs,
    creditsRefreshServerRateLimitMs: metadata.creditsRefreshServerRateLimitMs,
    creditsRefreshServerBalanceStoreMs: metadata.creditsRefreshServerBalanceStoreMs,
    creditsRefreshServerTotalMs: metadata.creditsRefreshServerTotalMs,
  };
}

function redactPersistedLifecycleMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const persisted = { ...metadata };
  delete persisted.conversationId;
  delete persisted.requestId;
  delete persisted.clientInstanceId;
  delete persisted.toolCallId;
  return persisted;
}

function sanitizeLifecycleMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  let metadata: Record<string, unknown>;
  try {
    metadata = snapshotLifecycleMetadata(input);
  } catch {
    return null;
  }
  const code = isAgentLifecycleCode(metadata.code)
    ? metadata.code
    : undefined;
  const phase = isAgentLifecyclePhase(metadata.phase)
    ? metadata.phase
    : undefined;
  if (!code || !phase) return null;

  const sanitized: Record<string, unknown> = { code, phase };
  if (Number.isSafeInteger(metadata.sequence) && (metadata.sequence as number) > 0) {
    sanitized.sequence = metadata.sequence;
  }
  if (Number.isSafeInteger(metadata.timestamp) && (metadata.timestamp as number) >= 0) {
    sanitized.timestamp = metadata.timestamp;
  }
  const conversationId = isThinAgentConversationId(metadata.conversationId)
    ? metadata.conversationId
    : undefined;
  const requestId = boundedThinAgentIdentifier(metadata.requestId, 160);
  const clientInstanceId = isThinAgentClientInstanceId(metadata.clientInstanceId)
    ? metadata.clientInstanceId
    : undefined;
  const pluginBuildId = boundedThinAgentIdentifier(metadata.pluginBuildId, 160);
  const runId = boundedThinAgentIdentifier(metadata.runId, 160);
  const serverRunId = isThinAgentServerRunId(metadata.serverRunId)
    ? metadata.serverRunId
    : undefined;
  const toolName = isFirstPartyToolName(metadata.toolName)
    ? metadata.toolName
    : undefined;
  const toolCallId = boundedThinAgentIdentifier(metadata.toolCallId, 160);
  if (conversationId) sanitized.conversationId = conversationId;
  if (requestId) sanitized.requestId = requestId;
  if (clientInstanceId) sanitized.clientInstanceId = clientInstanceId;
  if (pluginBuildId) sanitized.pluginBuildId = pluginBuildId;
  if (runId) sanitized.runId = runId;
  if (serverRunId) sanitized.serverRunId = serverRunId;
  if (toolName) sanitized.toolName = toolName;
  if (toolCallId) sanitized.toolCallId = toolCallId;
  if (
    Number.isInteger(metadata.status)
    && (metadata.status as number) >= 100
    && (metadata.status as number) <= 599
  ) {
    sanitized.status = metadata.status;
  }
  if (typeof metadata.retryable === "boolean") {
    sanitized.retryable = metadata.retryable;
  }
  if (isThinAgentIncidentId(metadata.incidentId)) {
    sanitized.incidentId = metadata.incidentId;
  }
  if (isThinAgentFailureCode(metadata.failureCode)) {
    sanitized.failureCode = metadata.failureCode;
  }
  if (isThinAgentLatencyTraceId(metadata.latencyTraceId)) {
    sanitized.latencyTraceId = metadata.latencyTraceId;
  }
  if (
    isThinAgentCommandKind(metadata.commandKind)
  ) {
    sanitized.commandKind = metadata.commandKind;
  }
  if (
    Number.isSafeInteger(metadata.commandSegmentOrdinal)
    && (metadata.commandSegmentOrdinal as number) > 0
  ) {
    sanitized.commandSegmentOrdinal = metadata.commandSegmentOrdinal;
  }
  if (
    Number.isSafeInteger(metadata.toolExecutionOrdinal)
    && (metadata.toolExecutionOrdinal as number) > 0
    && (metadata.toolExecutionOrdinal as number) <= MAX_TOOL_EXECUTION_ORDINAL
  ) {
    sanitized.toolExecutionOrdinal = metadata.toolExecutionOrdinal;
  }
  if (isToolDiagnosticOutcome(metadata.toolOutcome)) {
    sanitized.toolOutcome = metadata.toolOutcome;
  }
  if (isToolDiagnosticFailureClass(metadata.toolFailureClass)) {
    sanitized.toolFailureClass = metadata.toolFailureClass;
  }
  for (const key of [
    "toolItemCount",
    "toolCompletedItemCount",
    "toolFailedItemCount",
  ] as const) {
    const value = boundedToolDiagnosticItemCount(metadata[key]);
    if (value !== undefined) sanitized[key] = value;
  }
  if (isHistorySyncKind(metadata.historySyncKind)) {
    sanitized.historySyncKind = metadata.historySyncKind;
  }
  if (
    Number.isSafeInteger(metadata.historySyncOrdinal)
    && (metadata.historySyncOrdinal as number) > 0
    && (metadata.historySyncOrdinal as number) <= MAX_HISTORY_SYNC_ORDINAL
  ) {
    sanitized.historySyncOrdinal = metadata.historySyncOrdinal;
  }
  if (
    metadata.responseDeliveryMode === "fetch_stream"
    || metadata.responseDeliveryMode === "request_url_buffered"
  ) {
    sanitized.responseDeliveryMode = metadata.responseDeliveryMode;
  }
  const clientMonotonicOffsetMs = boundedThinAgentTiming(
    metadata.clientMonotonicOffsetMs,
  );
  if (clientMonotonicOffsetMs !== undefined) {
    sanitized.clientMonotonicOffsetMs = clientMonotonicOffsetMs;
    sanitized.clientClockDomain = "client_turn_monotonic";
  }
  const serverTimingAppMs = boundedThinAgentTiming(metadata.serverTimingAppMs);
  const serverTimingAuthMs = boundedThinAgentTiming(metadata.serverTimingAuthMs);
  if (serverTimingAppMs !== undefined) sanitized.serverTimingAppMs = serverTimingAppMs;
  if (serverTimingAuthMs !== undefined) sanitized.serverTimingAuthMs = serverTimingAuthMs;
  if (serverTimingAppMs !== undefined || serverTimingAuthMs !== undefined) {
    sanitized.serverTimingClockDomain = "server_response_headers_monotonic_duration";
  }
  if (isCreditsRefreshReason(metadata.creditsRefreshReason)) {
    sanitized.creditsRefreshReason = metadata.creditsRefreshReason;
  }
  if (
    Number.isSafeInteger(metadata.creditsRefreshSequence)
    && (metadata.creditsRefreshSequence as number) > 0
  ) {
    sanitized.creditsRefreshSequence = metadata.creditsRefreshSequence;
  }
  if (
    metadata.creditsRefreshTransport === "fetch"
    || metadata.creditsRefreshTransport === "request_url"
  ) {
    sanitized.creditsRefreshTransport = metadata.creditsRefreshTransport;
  }
  const creditsRefreshElapsedMs = boundedThinAgentTiming(
    metadata.creditsRefreshElapsedMs,
  );
  if (creditsRefreshElapsedMs !== undefined) {
    sanitized.creditsRefreshElapsedMs = creditsRefreshElapsedMs;
    sanitized.creditsRefreshClockDomain = "client_refresh_monotonic_duration";
  }
  const creditsRefreshServerAuthMs = boundedThinAgentTiming(
    metadata.creditsRefreshServerAuthMs,
  );
  const creditsRefreshServerRateLimitMs = boundedThinAgentTiming(
    metadata.creditsRefreshServerRateLimitMs,
  );
  const creditsRefreshServerBalanceStoreMs = boundedThinAgentTiming(
    metadata.creditsRefreshServerBalanceStoreMs,
  );
  const creditsRefreshServerTotalMs = boundedThinAgentTiming(
    metadata.creditsRefreshServerTotalMs,
  );
  if (creditsRefreshServerAuthMs !== undefined) {
    sanitized.creditsRefreshServerAuthMs = creditsRefreshServerAuthMs;
  }
  if (creditsRefreshServerRateLimitMs !== undefined) {
    sanitized.creditsRefreshServerRateLimitMs = creditsRefreshServerRateLimitMs;
  }
  if (creditsRefreshServerBalanceStoreMs !== undefined) {
    sanitized.creditsRefreshServerBalanceStoreMs = creditsRefreshServerBalanceStoreMs;
  }
  if (creditsRefreshServerTotalMs !== undefined) {
    sanitized.creditsRefreshServerTotalMs = creditsRefreshServerTotalMs;
  }
  if (
    creditsRefreshServerAuthMs !== undefined
    || creditsRefreshServerRateLimitMs !== undefined
    || creditsRefreshServerBalanceStoreMs !== undefined
    || creditsRefreshServerTotalMs !== undefined
  ) {
    sanitized.creditsRefreshServerTimingClockDomain =
      "server_response_headers_monotonic_duration";
  }
  return sanitized;
}

function projectSupportDiagnosticEvent(entry: PluginLogEntry): SupportDiagnosticEvent | null {
  const timestamp = validIsoTimestamp(entry.timestamp);
  const metadata = entry.context?.metadata;
  if (!timestamp || !metadata) return null;

  const isLifecycle = entry.level === "info"
    && entry.message === "thin-agent:lifecycle"
    && entry.context?.source === "AgentLifecycle";
  const isFailure = entry.level === "error"
    && entry.message === THIN_AGENT_FAILURE_LOG_MESSAGE
    && entry.context?.source === "ThinAgentClient";
  if (!isLifecycle && !isFailure) return null;

  const code = typeof metadata.code === "string"
    && (
      (isLifecycle && isAgentLifecycleCode(metadata.code))
      || (isFailure && (
        SAFE_THIN_AGENT_FAILURE_CODES.has(metadata.code)
        || metadata.code === "client_failure"
      ))
    )
    ? metadata.code
    : undefined;
  const phase = isAgentLifecyclePhase(metadata.phase)
    ? metadata.phase
    : undefined;
  if (!code || !phase) return null;

  const projected: {
    timestamp: string;
    severity: "info" | "error";
    code: string;
    phase: AgentLifecyclePhase;
    origin?: string;
    cause?: string;
    sequence?: number;
    conversation_id?: string;
    request_id?: string;
    client_instance_id?: string;
    plugin_build_id?: string;
    run_id?: string;
    server_run_id?: string;
    tool_name?: string;
    status?: number;
    retryable?: boolean;
    incident_id?: string;
    failure_code?: string;
    latency_trace_id?: string;
    command_kind?: ThinAgentCommandKind;
    command_segment_ordinal?: number;
    tool_execution_ordinal?: number;
    tool_outcome?: ToolDiagnosticOutcome;
    tool_failure_class?: ToolDiagnosticFailureClass;
    tool_item_count?: number;
    tool_completed_item_count?: number;
    tool_failed_item_count?: number;
    history_sync_kind?: HistorySyncKind;
    history_sync_ordinal?: number;
    response_delivery_mode?: "fetch_stream" | "request_url_buffered";
    client_monotonic_offset_ms?: number;
    client_clock_domain?: "client_turn_monotonic";
    server_timing_app_ms?: number;
    server_timing_auth_ms?: number;
    server_timing_clock_domain?: "server_response_headers_monotonic_duration";
    credits_refresh_reason?: SupportDiagnosticEvent["credits_refresh_reason"];
    credits_refresh_sequence?: number;
    credits_refresh_transport?: "fetch" | "request_url";
    credits_refresh_elapsed_ms?: number;
    credits_refresh_clock_domain?: "client_refresh_monotonic_duration";
    credits_refresh_server_auth_ms?: number;
    credits_refresh_server_rate_limit_ms?: number;
    credits_refresh_server_balance_store_ms?: number;
    credits_refresh_server_total_ms?: number;
    credits_refresh_server_timing_clock_domain?:
      "server_response_headers_monotonic_duration";
  } = {
    timestamp,
    severity: isLifecycle ? "info" : "error",
    code,
    phase,
  };
  if (
    isFailure
    && typeof metadata.origin === "string"
    && THIN_AGENT_FAILURE_ORIGINS.has(metadata.origin)
  ) {
    projected.origin = metadata.origin;
  }
  if (
    isFailure
    && typeof metadata.cause === "string"
    && THIN_AGENT_FAILURE_CAUSES.has(metadata.cause)
  ) {
    projected.cause = metadata.cause;
  }
  if (Number.isSafeInteger(metadata.sequence) && (metadata.sequence as number) > 0) {
    projected.sequence = metadata.sequence as number;
  }
  if (
    isLifecycle
    && isThinAgentConversationId(metadata.conversationId)
  ) {
    projected.conversation_id = metadata.conversationId;
  }
  if (isLifecycle) {
    const requestId = boundedThinAgentIdentifier(metadata.requestId, 160);
    const pluginBuildId = boundedThinAgentIdentifier(metadata.pluginBuildId, 160);
    const runId = boundedThinAgentIdentifier(metadata.runId, 160);
    if (requestId) projected.request_id = requestId;
    if (pluginBuildId) projected.plugin_build_id = pluginBuildId;
    if (runId) projected.run_id = runId;
  }
  if (
    isLifecycle
    && isThinAgentClientInstanceId(metadata.clientInstanceId)
  ) {
    projected.client_instance_id = metadata.clientInstanceId;
  }
  if (
    isLifecycle
    && isThinAgentServerRunId(metadata.serverRunId)
  ) {
    projected.server_run_id = metadata.serverRunId;
  }
  if (
    isLifecycle
    && isFirstPartyToolName(metadata.toolName)
  ) {
    projected.tool_name = metadata.toolName;
  }
  if (
    Number.isInteger(metadata.status)
    && (metadata.status as number) >= 100
    && (metadata.status as number) <= 599
  ) {
    projected.status = metadata.status as number;
  }
  if (typeof metadata.retryable === "boolean") {
    projected.retryable = metadata.retryable;
  }
  if (isThinAgentIncidentId(metadata.incidentId)) {
    projected.incident_id = metadata.incidentId;
  }
  if (
    isLifecycle
    && isThinAgentFailureCode(metadata.failureCode)
  ) {
    projected.failure_code = metadata.failureCode;
  }
  if (
    isLifecycle
    && isThinAgentLatencyTraceId(metadata.latencyTraceId)
  ) {
    projected.latency_trace_id = metadata.latencyTraceId;
  }
  if (
    isLifecycle
    && isThinAgentCommandKind(metadata.commandKind)
  ) {
    projected.command_kind = metadata.commandKind as SupportDiagnosticEvent["command_kind"];
  }
  if (
    isLifecycle
    && Number.isSafeInteger(metadata.commandSegmentOrdinal)
    && (metadata.commandSegmentOrdinal as number) > 0
  ) {
    projected.command_segment_ordinal = metadata.commandSegmentOrdinal as number;
  }
  if (
    isLifecycle
    && Number.isSafeInteger(metadata.toolExecutionOrdinal)
    && (metadata.toolExecutionOrdinal as number) > 0
    && (metadata.toolExecutionOrdinal as number) <= MAX_TOOL_EXECUTION_ORDINAL
  ) {
    projected.tool_execution_ordinal = metadata.toolExecutionOrdinal as number;
  }
  if (isLifecycle && isToolDiagnosticOutcome(metadata.toolOutcome)) {
    projected.tool_outcome = metadata.toolOutcome;
  }
  if (isLifecycle && isToolDiagnosticFailureClass(metadata.toolFailureClass)) {
    projected.tool_failure_class = metadata.toolFailureClass;
  }
  const toolItemCount = boundedToolDiagnosticItemCount(metadata.toolItemCount);
  const toolCompletedItemCount = boundedToolDiagnosticItemCount(
    metadata.toolCompletedItemCount,
  );
  const toolFailedItemCount = boundedToolDiagnosticItemCount(
    metadata.toolFailedItemCount,
  );
  if (isLifecycle && toolItemCount !== undefined) {
    projected.tool_item_count = toolItemCount;
  }
  if (isLifecycle && toolCompletedItemCount !== undefined) {
    projected.tool_completed_item_count = toolCompletedItemCount;
  }
  if (isLifecycle && toolFailedItemCount !== undefined) {
    projected.tool_failed_item_count = toolFailedItemCount;
  }
  if (isLifecycle && isHistorySyncKind(metadata.historySyncKind)) {
    projected.history_sync_kind = metadata.historySyncKind;
  }
  if (
    isLifecycle
    && Number.isSafeInteger(metadata.historySyncOrdinal)
    && (metadata.historySyncOrdinal as number) > 0
    && (metadata.historySyncOrdinal as number) <= MAX_HISTORY_SYNC_ORDINAL
  ) {
    projected.history_sync_ordinal = metadata.historySyncOrdinal as number;
  }
  if (
    isLifecycle
    && (
      metadata.responseDeliveryMode === "fetch_stream"
      || metadata.responseDeliveryMode === "request_url_buffered"
    )
  ) {
    projected.response_delivery_mode = metadata.responseDeliveryMode;
  }
  if (isLifecycle) {
    const clientMonotonicOffsetMs = boundedThinAgentTiming(
      metadata.clientMonotonicOffsetMs,
    );
    const serverTimingAppMs = boundedThinAgentTiming(metadata.serverTimingAppMs);
    const serverTimingAuthMs = boundedThinAgentTiming(metadata.serverTimingAuthMs);
    if (clientMonotonicOffsetMs !== undefined) {
      projected.client_monotonic_offset_ms = clientMonotonicOffsetMs;
      projected.client_clock_domain = "client_turn_monotonic";
    }
    if (serverTimingAppMs !== undefined) {
      projected.server_timing_app_ms = serverTimingAppMs;
    }
    if (serverTimingAuthMs !== undefined) {
      projected.server_timing_auth_ms = serverTimingAuthMs;
    }
    if (serverTimingAppMs !== undefined || serverTimingAuthMs !== undefined) {
      projected.server_timing_clock_domain = "server_response_headers_monotonic_duration";
    }
    if (
      isCreditsRefreshReason(metadata.creditsRefreshReason)
    ) {
      projected.credits_refresh_reason = (
        metadata.creditsRefreshReason as SupportDiagnosticEvent["credits_refresh_reason"]
      );
    }
    if (
      Number.isSafeInteger(metadata.creditsRefreshSequence)
      && (metadata.creditsRefreshSequence as number) > 0
    ) {
      projected.credits_refresh_sequence = metadata.creditsRefreshSequence as number;
    }
    if (
      metadata.creditsRefreshTransport === "fetch"
      || metadata.creditsRefreshTransport === "request_url"
    ) {
      projected.credits_refresh_transport = metadata.creditsRefreshTransport;
    }
    const creditsRefreshElapsedMs = boundedThinAgentTiming(
      metadata.creditsRefreshElapsedMs,
    );
    if (creditsRefreshElapsedMs !== undefined) {
      projected.credits_refresh_elapsed_ms = creditsRefreshElapsedMs;
      projected.credits_refresh_clock_domain = "client_refresh_monotonic_duration";
    }
    const creditsRefreshServerAuthMs = boundedThinAgentTiming(
      metadata.creditsRefreshServerAuthMs,
    );
    const creditsRefreshServerRateLimitMs = boundedThinAgentTiming(
      metadata.creditsRefreshServerRateLimitMs,
    );
    const creditsRefreshServerBalanceStoreMs = boundedThinAgentTiming(
      metadata.creditsRefreshServerBalanceStoreMs,
    );
    const creditsRefreshServerTotalMs = boundedThinAgentTiming(
      metadata.creditsRefreshServerTotalMs,
    );
    if (creditsRefreshServerAuthMs !== undefined) {
      projected.credits_refresh_server_auth_ms = creditsRefreshServerAuthMs;
    }
    if (creditsRefreshServerRateLimitMs !== undefined) {
      projected.credits_refresh_server_rate_limit_ms = creditsRefreshServerRateLimitMs;
    }
    if (creditsRefreshServerBalanceStoreMs !== undefined) {
      projected.credits_refresh_server_balance_store_ms = creditsRefreshServerBalanceStoreMs;
    }
    if (creditsRefreshServerTotalMs !== undefined) {
      projected.credits_refresh_server_total_ms = creditsRefreshServerTotalMs;
    }
    if (
      creditsRefreshServerAuthMs !== undefined
      || creditsRefreshServerRateLimitMs !== undefined
      || creditsRefreshServerBalanceStoreMs !== undefined
      || creditsRefreshServerTotalMs !== undefined
    ) {
      projected.credits_refresh_server_timing_clock_domain =
        "server_response_headers_monotonic_duration";
    }
  }
  return Object.freeze(projected);
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
  const candidate = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
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
  const phase = thinAgentPhaseForMethod(context.method);
  const origin = thinAgentOriginForMethod(context.method);
  const cause = code === "client_failure"
    ? thinAgentFailureCause(error)
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

function thinAgentOriginForMethod(method: string | undefined): string {
  switch (method) {
    case "approvalModeChange":
      return "approval_mode_change";
    case "loadChatHydration":
      return "chat_hydration";
    case "agentSession":
    case "reportAgentError":
      return "session_callback";
    case "completedRunSettlement":
      return "run_settlement";
    case "agentSnapshotRender":
      return "snapshot_render";
    case "historicalResubmit":
      return "historical_resubmit";
    case "warmThinConversation":
      return "warm_bootstrap";
    default:
      return "unknown";
  }
}

function thinAgentFailureCause(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "non_error";
  }
  const candidate = error as Record<string, unknown>;
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
  if (error instanceof Error) return "generic_error";
  return "object_error";
}

function thinAgentPhaseForMethod(method: string | undefined): string {
  switch (method) {
    case "approvalModeChange":
      return "session";
    case "loadChatHydration":
    case "warmThinConversation":
      return "start";
    case "agentSession":
    case "reportAgentError":
      return "response";
    case "completedRunSettlement":
      return "persistence";
    case "agentSnapshotRender":
      return "render";
    default:
      return "unknown";
  }
}

function serializeError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) serialized.stack = error.stack;
    const extra = error as any;
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
