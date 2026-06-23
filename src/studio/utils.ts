export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  try {
    const globalCrypto: any = (globalThis as any).crypto;
    if (typeof globalCrypto?.randomUUID === "function") {
      return `${prefix}_${globalCrypto.randomUUID()}`;
    }
  } catch {}

  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * A Studio policy file lives in the vault and can be shared / synced / imported.
 * A bare `"*"` CLI command pattern would match every command, granting arbitrary
 * local command execution on project open with no approval. Such a blanket
 * wildcard is never an acceptable pattern: it is dropped at policy-parse time and
 * refused again inside the CLI gate (defense-in-depth). Legitimate per-command
 * patterns — including path-prefix wildcards like a star-slash-ffmpeg pattern —
 * are NOT blanket wildcards and are preserved.
 *
 * Single source of truth so the parse-time strip and the gate-time refusal can
 * never drift apart.
 */
export function isBlanketCliCommandPattern(pattern: string): boolean {
  return asString(pattern).trim() === "*";
}

