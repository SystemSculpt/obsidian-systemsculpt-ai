const DEFAULT_POLL_AFTER_MS = 2_000;
const MAX_POLL_AFTER_MS = 60 * 60 * 1_000;
const TRANSIENT_RETRY_BASE_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;
const DISPATCH_MAX_ATTEMPTS = 4;

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
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, normalizedPollAfterMs(milliseconds));
    const onAbort = () => {
      window.clearTimeout(timeout);
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

export type ManagedJobDispatchOptions<T> = Readonly<{
  send: () => Promise<T>;
  signal: AbortSignal;
  isRetryableError?: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | undefined;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

/**
 * Sends one idempotent managed job request, retrying while the server says the
 * failure is transient.
 *
 * Polling already survives a blip because observeManagedJob retries; the
 * request that starts the work did not, so a lock wait during credit
 * reservation ended a whole Studio run. Every caller carries an idempotency
 * key, so a replay returns the original job instead of paying twice. Attempts
 * are bounded because, unlike polling, there is no server-side job yet to keep
 * waiting on.
 */
export async function dispatchManagedJob<T>(
  options: ManagedJobDispatchOptions<T>,
): Promise<T> {
  const wait = options.wait ?? waitForManagedJob;
  const isRetryable = options.isRetryableError ?? isRetryableManagedJobObservationError;
  let backoffMs = TRANSIENT_RETRY_BASE_MS;

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await options.send();
    } catch (error) {
      throwIfAborted(options.signal);
      if (attempt >= DISPATCH_MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await wait(
        normalizedPollAfterMs(options.retryAfterMs?.(error), backoffMs),
        options.signal,
      );
      backoffMs = Math.min(TRANSIENT_RETRY_MAX_MS, backoffMs * 2);
    }
  }
}
