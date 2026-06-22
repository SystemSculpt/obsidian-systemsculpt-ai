/**
 * embeddingsRetry - a single retry/backoff layer for embedding provider calls.
 *
 * The providers raise typed `EmbeddingsProviderError`s with `transient` and
 * `retryInMs` (see #208 PR-2), but nothing retries a rate limit: the managed
 * SystemSculptProvider deliberately *stops* on 429 ("no point retrying" at the
 * request level), and the CustomProvider has no retry at all. That is the gap
 * behind #127 (bulk rebuild stalls at 0.2% on a 429) and #150 (429 handling).
 *
 * This wrapper owns that retry. It retries only transient, non-license errors,
 * honors a server-provided `retryInMs` (Retry-After) when present, and otherwise
 * backs off exponentially with half-jitter up to a cap. It composes with the
 * managed provider's internal 5xx fast-path rather than replacing it: SS still
 * retries a flaky 5xx within a single request, while this layer adds the
 * rate-limit/backoff retry across the batch that neither provider performs.
 *
 * `sleep` and `random` are injectable so the policy is unit-testable without
 * real timers or nondeterminism.
 */

import { EmbeddingsProviderError, isEmbeddingsProviderError } from "../providers/ProviderError";

export interface EmbeddingsRetryOptions {
  /** Maximum retry attempts AFTER the first try (so total attempts = maxRetries + 1). */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  baseDelayMs?: number;
  /** Upper bound for any single backoff wait, in ms. */
  maxDelayMs?: number;
}

export interface EmbeddingsRetryDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1) for jitter. */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: EmbeddingsProviderError }) => void;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Only *locally* recoverable transient errors are worth retrying in place — a
 * rate limit (429), a transient 5xx, a transport blip — where waiting briefly
 * and re-issuing the same batch can succeed.
 *
 * Excluded:
 *  - permanent errors (non-transient 4xx, malformed response): retrying wastes calls.
 *  - license/auth errors: retrying can deepen a lockout.
 *  - HOST_UNAVAILABLE: a whole-host cooldown / WAF block with its own dedicated
 *    handling (global backoff + per-chunk HTML-403 isolation in the processor).
 *    A local retry would fight that design and block on a long cooldown.
 */
export function isRetriableEmbeddingsError(error: unknown): error is EmbeddingsProviderError {
  return (
    isEmbeddingsProviderError(error) &&
    error.transient === true &&
    error.licenseRelated !== true &&
    error.code !== "HOST_UNAVAILABLE"
  );
}

/**
 * Compute the wait before retry `attempt` (1-based). A server-provided
 * `retryInMs` (Retry-After) wins, capped at `maxDelayMs`. Otherwise: exponential
 * backoff `base * 2^(attempt-1)`, capped, then half-jittered into
 * `[50%, 100%]` of the cap using `randomFraction` (in [0, 1)).
 */
export function computeBackoffMs(
  attempt: number,
  options: EmbeddingsRetryOptions = {},
  retryInMs?: number,
  randomFraction = 0,
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  if (typeof retryInMs === "number" && Number.isFinite(retryInMs) && retryInMs >= 0) {
    return Math.min(retryInMs, cap);
  }

  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, cap);
  const jittered = capped * (0.5 + 0.5 * clamp01(randomFraction));
  return Math.round(jittered);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `operation`, retrying transient provider errors with backoff. Non-retriable
 * errors propagate immediately; after `maxRetries` exhausted retries the last
 * error is rethrown unchanged (so the caller still sees a typed error).
 */
export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: EmbeddingsRetryOptions = {},
  deps: EmbeddingsRetryDeps = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      attempt++;
      if (attempt > maxRetries || !isRetriableEmbeddingsError(error)) {
        throw error;
      }
      const delayMs = computeBackoffMs(attempt, options, error.retryInMs, random());
      deps.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
