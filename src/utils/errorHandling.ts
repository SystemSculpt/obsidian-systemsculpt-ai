/**
 * Utility functions for consistent error handling across the application
 */
import { errorLogger } from './errorLogger';

/**
 * Log levels for controlling verbosity
 */
export enum LogLevel {
    ERROR = 0,
    WARNING = 1,
    INFO = 2,
    DEBUG = 3
}

/**
 * Current log level - only messages at this level or lower will be logged
 * Default to ERROR and WARNING only
 */
let currentLogLevel: LogLevel = LogLevel.WARNING;

function mapLogLevelToErrorLevel(level: LogLevel): 'error' | 'warn' | 'info' | 'debug' {
    switch (level) {
        case LogLevel.DEBUG:
            return 'debug';
        case LogLevel.INFO:
            return 'info';
        case LogLevel.WARNING:
            return 'warn';
        case LogLevel.ERROR:
        default:
            return 'error';
    }
}

/**
 * Set the current log level
 * @param level The log level to set
 */
export function setLogLevel(level: LogLevel): void {
    currentLogLevel = level;
    errorLogger.setMinimumLevel(mapLogLevelToErrorLevel(level));
}

/**
 * Standard error logger with consistent formatting
 * @param context The context or component where the error occurred
 * @param message The error message
 * @param error The error object
 */
export function logError(context: string, message: string, error: any): void {
    const text = context ? `${context}: ${message}` : message;
    errorLogger.error(text, error, {
        source: context
    });
}

/**
 * Log an informational message with consistent formatting
 */
export function logInfo(context: string, message: string, data?: any): void {
    if (currentLogLevel >= LogLevel.INFO) {
        const text = context ? `${context}: ${message}` : message;
        errorLogger.info(text, {
            source: context,
            metadata: typeof data !== 'undefined' ? { data } : undefined
        });
    }
}

/**
 * Log a debug message with consistent formatting
 */
export function logDebug(context: string, message: string, data?: any): void {
    if (currentLogLevel >= LogLevel.DEBUG) {
        const text = context ? `${context}: ${message}` : message;
        errorLogger.debug(text, {
            source: context,
            metadata: typeof data !== 'undefined' ? { data } : undefined
        });
    }
}
