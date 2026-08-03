const DEFAULT_POLL_AFTER_MS = 2_000;
const MAX_POLL_AFTER_MS = 60 * 60 * 1_000;
const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;

export type ManagedJobPollHint = Readonly<{
  poll_after_ms?: number;
}>;

export type ManagedJobObservationOptions<T> = Readonly<{
  initial?: T;
  read: () => Promise<T>;
  signal: AbortSignal;
  pollAfterMs?: (value: T) => number | undefined;
  isRetryableError?: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | undefined;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

function abortError(): DOMException {
  return new DOMException("Stopped waiting for the managed job.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export async function waitForManagedJob(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    // Managed polling is host-level work, not UI bound to a popout window.
    // eslint-disable-next-line obsidianmd/no-global-this
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, normalizedPollAfterMs(milliseconds));
    const onAbort = () => {
      // eslint-disable-next-line obsidianmd/no-global-this
      globalThis.clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throwIfAborted(signal);
}

export function normalizedPollAfterMs(
  value: unknown,
  fallback = DEFAULT_POLL_AFTER_MS,
): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_POLL_AFTER_MS
    ? value as number
    : fallback;
}

export function retryAfterHeaderMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^(0|[1-9]\d*)$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return milliseconds <= MAX_POLL_AFTER_MS ? milliseconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const milliseconds = Math.max(0, timestamp - now);
  return milliseconds <= MAX_POLL_AFTER_MS ? milliseconds : undefined;
}

export function isRetryableManagedJobObservationError(error: unknown): boolean {
  if (
    error instanceof DOMException
    && error.name === "AbortError"
  ) {
    return false;
  }
  if (error instanceof TypeError) return true;
  const candidate = error as {
    retryable?: unknown;
    status?: unknown;
  } | null;
  return candidate?.retryable === true
    || candidate?.status === 429
    || (typeof candidate?.status === "number" && candidate.status >= 500);
}

/**
 * Observes one durable server job until the caller recognizes a terminal
 * status and returns from the loop. It never decides that a valid job took too
 * long. Server poll hints control normal cadence; transport failures retry
 * without an attempt cap and remain abortable.
 */
export async function* observeManagedJob<T>(
  options: ManagedJobObservationOptions<T>,
): AsyncGenerator<T, never, void> {
  const wait = options.wait ?? waitForManagedJob;
  let next = options.initial;
  let hasNext = options.initial !== undefined;
  let transientRetryMs = TRANSIENT_RETRY_BASE_MS;

  while (true) {
    throwIfAborted(options.signal);
    if (!hasNext) {
      try {
        next = await options.read();
        throwIfAborted(options.signal);
        transientRetryMs = TRANSIENT_RETRY_BASE_MS;
      } catch (error) {
        throwIfAborted(options.signal);
        if (!options.isRetryableError?.(error)) throw error;
        await wait(
          normalizedPollAfterMs(
            options.retryAfterMs?.(error),
            transientRetryMs,
          ),
          options.signal,
        );
        transientRetryMs = Math.min(
          TRANSIENT_RETRY_MAX_MS,
          transientRetryMs * 2,
        );
        continue;
      }
    }

    yield next as T;
    await wait(
      normalizedPollAfterMs(options.pollAfterMs?.(next as T)),
      options.signal,
    );
    hasNext = false;
    next = undefined;
  }
}
