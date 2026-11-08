import { emitLogToConsole, type LogConsoleLevel } from "./logConsole";

/** @internal Tests type their fixtures with this. */
export type ErrorLevel = LogConsoleLevel;

/** @internal Tests type their fixtures with this. */
export interface ErrorContext {
  source?: string;
  method?: string;
  userId?: string;
  providerId?: string;
  metadata?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<ErrorLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

/** Console-only compatibility logging; PluginLogger owns persisted diagnostics. */
class ErrorLogger {
  private static instance: ErrorLogger;
  private debugMode = false;
  private minimumLevel: ErrorLevel = 'warn';

  static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger();
    }
    return ErrorLogger.instance;
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = !!enabled;
  }

  setMinimumLevel(level: ErrorLevel): void {
    this.minimumLevel = level;
  }

  log(level: ErrorLevel, message: string, error?: unknown, context?: ErrorContext): void {
    if (!this.shouldEmit(level)) {
      return;
    }

    const consoleArgs: unknown[] = [`[SystemSculpt][${level.toUpperCase()}] ${message}`];
    if (context && Object.keys(context).length > 0) {
      consoleArgs.push(context);
    }
    if (typeof error !== 'undefined') {
      consoleArgs.push(error);
    }

    emitLogToConsole(level, ...consoleArgs);
  }

  error(message: string, error?: unknown, context?: ErrorContext): void {
    this.log('error', message, error, context);
  }

  warn(message: string, context?: ErrorContext): void {
    this.log('warn', message, undefined, context);
  }

  info(message: string, context?: ErrorContext): void {
    this.log('info', message, undefined, context);
  }

  debug(message: string, context?: ErrorContext): void {
    this.log('debug', message, undefined, context);
  }

  private shouldEmit(level: ErrorLevel): boolean {
    if (this.debugMode) return true;
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.minimumLevel];
  }
}

export const errorLogger = ErrorLogger.getInstance();
