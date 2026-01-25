// Simple no-op stub replacing the previous complex DebugLogger implementation.
// This keeps the public API intact so the rest of the codebase continues to compile,
// but all methods now do nothing.

import type { App } from "obsidian";

export class DebugLogger {
  private static instance: DebugLogger = new DebugLogger();

  private constructor() {}

  // Called by the plugin on load – we keep it for compatibility.
  static initialize(_app: App): void {}

  // Standard singleton accessor – always returns the same stub instance.
  static getInstance(): DebugLogger {
    return DebugLogger.instance;
  }

  // Generic logging helpers – now no-ops.
  log(..._args: unknown[]): void {}
  logToolCall(..._args: unknown[]): void {}
  logStreamChunk(..._args: unknown[]): void {}
  logUserAction(..._args: unknown[]): void {}
  logAPIRequest(..._args: unknown[]): void {}
  logAPIResponse(..._args: unknown[]): void {}
  logToolApproval(..._args: unknown[]): void {}
  logToolExecution(..._args: unknown[]): void {}
  logChatViewLoad(..._args: unknown[]): void {}
  logChatViewRender(..._args: unknown[]): void {}
  logChatViewStructure(..._args: unknown[]): void {}
  logChatSave(..._args: unknown[]): void {}
  logError(..._args: unknown[]): void {}
  setEnabled(_enabled: boolean): void {}
  clearLog(): void {}
  async exportMobileLogs(): Promise<string> { return ""; }
  logMobileError(..._args: unknown[]): void {}
  logMobilePerformance(..._args: unknown[]): void {}
  logGlobalUncaughtError(..._args: unknown[]): void {}
}

// Utility wrapper previously exposed by the old implementation.
export async function debugLog(..._args: unknown[]): Promise<void> {
  // Intentionally left blank – logging disabled for production.
} 