type RetryAfterOptions = Readonly<{
  now?: number;
  /** Legacy chat error bodies may carry seconds instead of an HTTP header. */
  payload?: Record<string, unknown>;
}>;

function delayMs(value: unknown, now: number): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? Math.ceil(Math.min(Number.MAX_VALUE, value * 1_000))
      : undefined;
  }
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    // A valid but overflowing delta is still a long wait, not a missing hint.
    return Math.ceil(Math.min(Number.MAX_VALUE, Number(raw) * 1_000));
  }
  // HTTP dates start with a weekday. In particular, never let Date.parse
  // reinterpret a negative delta or other malformed numeric value as a date.
  if (!/^[a-z]{3}(?:,|[a-z]+,| )/i.test(raw)) return undefined;
  // The obsolete asctime HTTP form omits GMT but is still defined in UTC.
  const date = /^[a-z]{3} [a-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/i.test(raw)
    ? `${raw} GMT`
    : raw;
  const at = Date.parse(date);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * One Retry-After decoder, in milliseconds. Decimal seconds retain chat's
 * fractional-hint compatibility. Callers apply their existing wait ceilings;
 * parsing never discards a hint just because it exceeds one of those ceilings.
 */
export function parseRetryAfterMs(
  header: string | null,
  { now = Date.now(), payload }: RetryAfterOptions = {},
): number | undefined {
  return delayMs(header, now)
    ?? delayMs(payload?.retry_after_seconds, now)
    ?? delayMs(payload?.retry_after, now);
}
