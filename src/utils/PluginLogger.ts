import type SystemSculptPlugin from "../main";
import { LogLevel } from "./errorHandling";

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
  private isFlushing = false;

  constructor(plugin: SystemSculptPlugin, options?: PluginLoggerOptions) {
    this.plugin = plugin;
    if (options?.logFileName) {
      this.logFileName = options.logFileName;
    }
  }

  info(message: string, context?: PluginLogContext): void {
    this.write("info", message, undefined, context);
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

  setLogFileName(fileName: string): void {
    if (fileName && fileName !== this.logFileName) {
      this.logFileName = fileName;
    }
  }

  private write(level: PluginLogLevel, message: string, error?: unknown, context?: PluginLogContext) {
    if (!this.shouldLog(level, context)) {
      return;
    }

    const entry: PluginLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context && Object.keys(context).length > 0 ? sanitizeContext(context) : undefined,
      error: error ? serializeError(error) : undefined,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      this.buffer.shift();
    }

    this.pendingFlush.push(entry);
    this.ensureFlushScheduled();
    this.emitToConsole(entry, error);
    this.forwardToCollector(entry, error);
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

    const settingsLevel = this.plugin.settings?.logLevel ?? LogLevel.WARNING;
    return settingsLevel >= LEVEL_TO_THRESHOLD[level];
  }

  private ensureFlushScheduled() {
    if (typeof window === "undefined") {
      this.flushPendingEntries();
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

  private async flushPendingEntries(force: boolean = false) {
    if (this.isFlushing || this.pendingFlush.length === 0) {
      return;
    }
    this.isFlushing = true;
    try {
      const storage = this.plugin.storage;
      if (!storage) {
        // Storage not ready yet; retry once it becomes available.
        this.isFlushing = false;
        if (force) {
          // Avoid tight loops when force flushing without storage
          await new Promise((resolve) => setTimeout(resolve, this.flushIntervalMs));
        } else {
          this.ensureFlushScheduled();
        }
        return;
      }

      const entries = this.pendingFlush.splice(0, this.pendingFlush.length);
      if (entries.length === 0) {
        this.isFlushing = false;
        return;
      }

      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await storage.appendToFile("diagnostics", this.logFileName, payload);
      await this.enforceSizeLimit();
    } catch (error) {
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
    } finally {
      this.isFlushing = false;
    }
  }

  private async enforceSizeLimit() {
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
      return console.error ? console.error.bind(console) : console.log.bind(console);
    case "warn":
      return console.warn ? console.warn.bind(console) : console.log.bind(console);
    case "info":
      return console.info ? console.info.bind(console) : console.log.bind(console);
    case "debug":
    default:
      return console.debug ? console.debug.bind(console) : console.log.bind(console);
  }
}
