export type ErrorLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ErrorContext {
  source?: string;
  method?: string;
  userId?: string;
  modelId?: string;
  providerId?: string;
  metadata?: Record<string, any>;
}

interface ErrorLogEntry {
  timestamp: string;
  level: ErrorLevel;
  message: string;
  context?: ErrorContext;
  error?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<ErrorLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

class ErrorLogger {
  private static instance: ErrorLogger;
  private history: ErrorLogEntry[] = [];
  private readonly maxHistory = 500;
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

  log(level: ErrorLevel, message: string, error?: Error | any, context?: ErrorContext): void {
    const entry: ErrorLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context && Object.keys(context).length > 0 ? context : undefined,
      error: this.serializeError(error)
    };
    if (!entry.error) delete entry.error;
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    if (!this.shouldEmit(level)) {
      return;
    }

    const consoleArgs: any[] = [`[SystemSculpt][${level.toUpperCase()}] ${message}`];
    if (entry.context) {
      consoleArgs.push(entry.context);
    }
    if (error instanceof Error) {
      consoleArgs.push(error);
    } else if (typeof error !== 'undefined') {
      consoleArgs.push(error);
    }

    try {
      this.resolveConsoleMethod(level).apply(console, consoleArgs);
    } catch {
      // Fallback to console.log if target console method is unavailable
      console.log(`[SystemSculpt][${level.toUpperCase()}] ${message}`);
    }
  }

  error(message: string, error?: Error | any, context?: ErrorContext): void {
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

  getHistory(): ErrorLogEntry[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  exportLogs(): string {
    try {
      return JSON.stringify(this.history, null, 2);
    } catch {
      return '[]';
    }
  }

  private shouldEmit(level: ErrorLevel): boolean {
    if (this.debugMode) return true;
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.minimumLevel];
  }

  private resolveConsoleMethod(level: ErrorLevel): (...args: any[]) => void {
    if (typeof console === 'undefined') {
      return () => {};
    }
    switch (level) {
      case 'error':
        return console.error ? console.error.bind(console) : console.log.bind(console);
      case 'warn':
        return console.warn ? console.warn.bind(console) : console.log.bind(console);
      case 'info':
        return console.info ? console.info.bind(console) : console.log.bind(console);
      default:
        return console.debug ? console.debug.bind(console) : console.log.bind(console);
    }
  }

  private serializeError(error: unknown): Record<string, unknown> | undefined {
    if (!error) return undefined;
    if (error instanceof Error) {
      const output: Record<string, unknown> = {
        name: error.name,
        message: error.message
      };
      if (typeof error.stack === 'string') {
        output.stack = error.stack;
      }
      const extra = error as any;
      if (typeof extra.code !== 'undefined') {
        output.code = extra.code;
      }
      if (typeof extra.status !== 'undefined') {
        output.status = extra.status;
      }
      if (typeof extra.retryInMs === 'number') {
        output.retryInMs = extra.retryInMs;
      }
      if (typeof extra.details !== 'undefined') {
        output.details = extra.details;
      }
      return output;
    }
    if (typeof error === 'object') {
      try {
        return JSON.parse(JSON.stringify(error));
      } catch {
        return { message: String(error) };
      }
    }
    return { message: String(error) };
  }
}

export const errorLogger = ErrorLogger.getInstance();
