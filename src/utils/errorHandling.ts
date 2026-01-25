/**
 * Utility functions for consistent error handling across the application
 */
import { Notice } from 'obsidian';
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
export let currentLogLevel: LogLevel = LogLevel.WARNING;

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
 * Log a warning with consistent formatting
 * @param context The context or component where the warning occurred
 * @param message The warning message
 * @param data Optional data related to the warning
 */
export function logWarning(context: string, message: string, data?: any): void {
    // Only log if current level includes warnings
    if (currentLogLevel >= LogLevel.WARNING) {
        const text = context ? `${context}: ${message}` : message;
        errorLogger.warn(text, {
            source: context,
            metadata: typeof data !== 'undefined' ? { data } : undefined
        });
    }
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


/**
 * Mobile-specific error logger that captures additional mobile context
 * @param context The context or component where the error occurred
 * @param message The error message
 * @param error The error object
 * @param additionalInfo Optional additional information specific to mobile
 */
export async function logMobileError(context: string, message: string, error: any, additionalInfo?: any): Promise<void> {
    // Always log errors to console first
    const text = context ? `${context}: ${message}` : message;
    errorLogger.error(text, error, {
        source: context,
        metadata: typeof additionalInfo !== 'undefined' ? { additionalInfo } : undefined
    });
}


/**
 * Check if running on mobile and log mobile-specific performance issues
 * @param operation Name of the operation being timed
 * @param startTime Performance start time
 * @param threshold Warning threshold in milliseconds
 */
export async function logMobilePerformance(operation: string, startTime: number, threshold: number = 1000): Promise<void> {
    const duration = performance.now() - startTime;
    
    // Check if we're on mobile
    const isMobile = typeof window !== 'undefined' && 
                    ((window as any).app?.isMobile || 
                     /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
    
    if (isMobile && duration > threshold) {
        // Log performance warning to console instead of DebugLogger
        logWarning('Performance', `${operation} took ${duration}ms on mobile (threshold: ${threshold}ms)`);
    }
}

/**
 * Standardized error handling for embedding operations
 * This function logs the error and shows a notice to the user
 *
 * @param context The context or component where the error occurred
 * @param message The error message
 * @param error The error object
 * @param showNotice Whether to show a notice to the user (default: true)
 */
export async function handleEmbeddingError(
    context: string,
    message: string,
    error: any,
    showNotice: boolean = true
): Promise<void> {
    // Log the error
    logError(context, message, error);

    // Extract error message
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Show notice if requested
    if (showNotice) {
        new Notice(`${message}: ${errorMessage}`);
    }
}


/**
 * Safely execute a function and handle any errors
 * @param fn The function to execute
 * @param context The context for error logging
 * @param errorMessage The error message to log
 * @param defaultValue The default value to return if the function fails
 * @returns The result of the function or the default value if it fails
 */
export async function safeExecute<T>(
    fn: () => Promise<T>,
    context: string,
    errorMessage: string,
    defaultValue: T
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        logError(context, errorMessage, error);
        return defaultValue;
    }
}

/**
 * Safely execute a function with retry logic
 * @param fn The function to execute
 * @param context The context for error logging
 * @param errorMessage The error message to log
 * @param defaultValue The default value to return if all retries fail
 * @param maxRetries The maximum number of retries
 * @param delayMs The delay between retries in milliseconds
 * @returns The result of the function or the default value if all retries fail
 */
export async function safeExecuteWithRetry<T>(
    fn: () => Promise<T>,
    context: string,
    errorMessage: string,
    defaultValue: T,
    maxRetries: number = 3,
    delayMs: number = 500
): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            logWarning(
                context,
                `Attempt ${attempt}/${maxRetries} failed: ${errorMessage}`,
                error
            );

            if (attempt < maxRetries) {
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }

    logError(context, `All ${maxRetries} attempts failed: ${errorMessage}`, lastError);
    return defaultValue;
}
