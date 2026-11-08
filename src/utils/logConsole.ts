export type LogConsoleLevel = "info" | "warn" | "error" | "debug";

/** Console dispatch only: callers own level filtering, context and persistence. */
export function emitLogToConsole(level: LogConsoleLevel, ...args: unknown[]): void {
  if (typeof console === "undefined") return;

  // Obsidian lint permits debug, warn and error, not info/log.
  const preferred = level === "error" ? console.error
    : level === "warn" ? console.warn
    : console.debug;
  const method = typeof preferred === "function" ? preferred
    : typeof console.debug === "function" ? console.debug
    : console.warn;
  if (typeof method !== "function") return;

  try {
    method.apply(console, args);
  } catch {
    // Do not retry: a console hook may have emitted before throwing.
  }
}
