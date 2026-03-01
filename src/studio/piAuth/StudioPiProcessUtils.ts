export const STUDIO_PI_COMMON_CLI_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/opt/local/bin",
];

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function mergeStudioPiCliPath(rawPath: string): string {
  const segments = String(rawPath || "")
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const seen = new Set(segments);
  for (const segment of STUDIO_PI_COMMON_CLI_PATHS) {
    if (!seen.has(segment)) {
      segments.push(segment);
      seen.add(segment);
    }
  }
  return segments.join(":");
}

export function appendStudioPiOutput(
  existing: string,
  chunk: Buffer | string,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
): string {
  if (existing.length >= maxOutputBytes) {
    return existing;
  }
  const next = existing + chunk.toString();
  if (next.length <= maxOutputBytes) {
    return next;
  }
  return next.slice(0, maxOutputBytes);
}

export function isLikelyMissingStudioPiExecutableError(
  error: unknown,
  commandHints: string[] = []
): boolean {
  const code = String((error as { code?: unknown })?.code || "").trim().toUpperCase();
  if (code === "ENOENT") {
    return true;
  }
  const message = String((error as { message?: unknown })?.message || "").trim().toLowerCase();
  if (!message) {
    return false;
  }
  if (commandHints.some((hint) => message.includes(`spawn ${String(hint || "").toLowerCase()} enoent`))) {
    return true;
  }
  return message.includes("command not found") || message.includes("no such file or directory");
}
