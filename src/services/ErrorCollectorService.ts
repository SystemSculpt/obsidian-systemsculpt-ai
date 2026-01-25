type CapturedLevel = "log" | "info" | "warn" | "error" | "debug";

export interface CapturedLogEntry {
  timestampMs: number;
  iso: string;
  level: CapturedLevel;
  context: string;
  message: string;
  stack?: string;
}

const MAX_CONSOLE_ARGS = 5;

/**
 * Captures SystemSculpt logs/errors for later inspection, even before the plugin bootstraps.
 */
export class ErrorCollectorService {
  private static earlyBuffer: CapturedLogEntry[] = [];
  private static maxEarlyLogs = 250;
  private static consolePatched = false;
  private static originalConsole: Partial<Record<CapturedLevel, (...args: any[]) => void>> = {};
  private static activeInstances: Set<ErrorCollectorService> = new Set();

  static initializeEarlyLogsCapture(maxLogs: number = 250): void {
    if (typeof console === "undefined" || this.consolePatched) {
      return;
    }

    this.maxEarlyLogs = maxLogs;
    (["log", "info", "warn", "error", "debug"] as CapturedLevel[]).forEach((level) => {
      const original = (console as any)[level]?.bind(console) ?? console.log.bind(console);
      this.originalConsole[level] = original;
      (console as any)[level] = (...args: any[]) => {
        try {
          this.pushEarly(level, args);
        } catch {
          // ignore capture failures
        }
        original(...args);
      };
    });
    this.consolePatched = true;
  }

  private static pushEarly(level: CapturedLevel, args: any[]) {
    const first = args[0];
    const isSystemSculpt = typeof first === "string" && first.startsWith("[SystemSculpt");
    const entry: CapturedLogEntry = {
      timestampMs: Date.now(),
      iso: new Date().toISOString(),
      level,
      context: isSystemSculpt ? "SystemSculptLogger" : "console",
      message: stringifyArgs(args),
    };
    this.earlyBuffer.push(entry);
    if (this.earlyBuffer.length > this.maxEarlyLogs) {
      this.earlyBuffer.shift();
    }
    if (this.activeInstances.size > 0) {
      this.activeInstances.forEach((instance) => {
        if (isSystemSculpt) {
          if (!instance.captureAll && (level === "error" || level === "warn")) {
            instance.appendEntry({ ...entry });
          }
        } else if (instance.captureAll || level === "error" || level === "warn") {
          instance.appendEntry({ ...entry });
        }
      });
    }
  }

  private logs: CapturedLogEntry[] = [];
  private errors: CapturedLogEntry[] = [];
  private maxLogs: number;
  private captureAll = false;

  constructor(maxLogs: number = 500) {
    this.maxLogs = maxLogs;
    this.logs = [...ErrorCollectorService.earlyBuffer];
    this.errors = this.logs.filter((entry) => entry.level === "error");
    ErrorCollectorService.activeInstances.add(this);
    ErrorCollectorService.earlyBuffer = [];
  }

  enableCaptureAllLogs(): void {
    this.captureAll = true;
  }

  captureLog(level: CapturedLevel, context: string, message: string, stack?: string): void {
    if (!this.captureAll && level !== "error" && level !== "warn") {
      // Keep non-critical logs only when explicitly enabled
      return;
    }
    this.appendEntry({
      timestampMs: Date.now(),
      iso: new Date().toISOString(),
      level,
      context,
      message,
      stack,
    });
  }

  captureError(context: string, error: Error | string, stack?: string): void {
    const normalizedMessage = typeof error === "string" ? error : error.message;
    const normalizedStack =
      stack || (typeof error !== "string" && error instanceof Error ? error.stack || undefined : undefined);
    this.appendEntry({
      timestampMs: Date.now(),
      iso: new Date().toISOString(),
      level: "error",
      context,
      message: normalizedMessage || "Unknown error",
      stack: normalizedStack,
    });
  }

  getAllLogs(): string[] {
    return this.logs.map(formatEntry);
  }

  getLogsSince(sinceEpochMs: number): string[] {
    return this.logs.filter((entry) => entry.timestampMs >= sinceEpochMs).map(formatEntry);
  }

  getErrorLogs(): string[] {
    return this.errors.map(formatEntry);
  }

  clearLogs(): void {
    this.logs = [];
    this.errors = [];
  }

  unload(): void {
    this.restoreConsole();
    this.logs = [];
    this.errors = [];
    ErrorCollectorService.activeInstances.delete(this);
  }

  private appendEntry(entry: CapturedLogEntry) {
    this.logs.push(entry);
    if (entry.level === "error") {
      this.errors.push(entry);
    }

    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    if (this.errors.length > this.maxLogs) {
      this.errors.shift();
    }
  }

  private restoreConsole() {
    if (!ErrorCollectorService.consolePatched || typeof console === "undefined") {
      return;
    }
    (["log", "info", "warn", "error", "debug"] as CapturedLevel[]).forEach((level) => {
      const original = ErrorCollectorService.originalConsole[level];
      if (original) {
        (console as any)[level] = original;
      }
    });
    ErrorCollectorService.consolePatched = false;
    ErrorCollectorService.originalConsole = {};
    ErrorCollectorService.earlyBuffer = [];
  }
}

function stringifyArgs(args: any[]): string {
  try {
    const limited = args.slice(0, MAX_CONSOLE_ARGS);
    return limited
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
        return JSON.stringify(value, null, 2);
      })
      .join(" ");
  } catch {
    return args.map(String).join(" ");
  }
}

function formatEntry(entry: CapturedLogEntry): string {
  const header = `[${entry.iso}] [${entry.level.toUpperCase()}] [${entry.context}] ${entry.message}`;
  return entry.stack ? `${header}\n${entry.stack}` : header;
}
