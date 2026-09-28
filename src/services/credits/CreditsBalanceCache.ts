import type {
  CreditsBalanceObservation,
  CreditsBalanceSnapshot,
} from "../SystemSculptService";

/** Display surfaces reuse a balance this recent instead of asking again. */
export const CREDITS_BALANCE_CACHE_TTL_MS = 60_000;

export type CreditsBalanceReadOptions = Readonly<{
  /** Skip the cache and any older request, e.g. after a billed turn or a purchase. */
  fresh?: boolean;
  onObservation?: (observation: CreditsBalanceObservation) => void;
  signal?: AbortSignal;
}>;

type FetchBalance = (options: Readonly<{
  onObservation?: (observation: CreditsBalanceObservation) => void;
}>) => Promise<CreditsBalanceSnapshot>;

type CreditsBalanceCacheOptions = Readonly<{
  fetch: FetchBalance;
  licenseKey: () => string;
  now?: () => number;
  ttlMs?: number;
}>;

type InFlightRead = Readonly<{
  key: string;
  sequence: number;
  observers: Set<(observation: CreditsBalanceObservation) => void>;
  promise: Promise<CreditsBalanceSnapshot>;
}>;

function abortError(): DOMException {
  return new DOMException("The credits balance read was cancelled.", "AbortError");
}

/**
 * One credits-balance read per minute per license key, shared by every chat
 * view, the settings tab, the credits modal, and indexing preflight (#359).
 *
 * Callers that arrive while a read is in flight join it and receive its
 * transport observation. A fresh read always starts its own request, and an
 * older response never replaces a newer one. Failures are not cached.
 * Subscribers hear each balance that becomes the current account's newest;
 * a stale or previous-account response is never published.
 */
export class CreditsBalanceCache {
  private cached: { key: string; sequence: number; at: number; balance: CreditsBalanceSnapshot } | null = null;
  private inFlight: InFlightRead | null = null;
  private sequence = 0;
  private readonly listeners = new Set<(balance: CreditsBalanceSnapshot) => void>();

  constructor(private readonly options: CreditsBalanceCacheOptions) {}

  read(options: CreditsBalanceReadOptions = {}): Promise<CreditsBalanceSnapshot> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const key = this.options.licenseKey().trim();
    const now = (this.options.now ?? Date.now)();
    const ttlMs = this.options.ttlMs ?? CREDITS_BALANCE_CACHE_TTL_MS;
    if (!options.fresh) {
      const cached = this.cached;
      if (cached && cached.key === key && now - cached.at < ttlMs) {
        return Promise.resolve(cached.balance);
      }
      const inFlight = this.inFlight;
      if (inFlight && inFlight.key === key) {
        if (options.onObservation) inFlight.observers.add(options.onObservation);
        return this.withSignal(inFlight.promise, options.signal);
      }
    }
    return this.withSignal(this.start(key, options.onObservation), options.signal);
  }

  /** The last balance read for the current license key, however old. */
  peek(): CreditsBalanceSnapshot | null {
    const key = this.options.licenseKey().trim();
    return this.cached?.key === key ? this.cached.balance : null;
  }

  subscribe(listener: (balance: CreditsBalanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private start(
    key: string,
    onObservation: CreditsBalanceReadOptions["onObservation"],
  ): Promise<CreditsBalanceSnapshot> {
    const sequence = ++this.sequence;
    const observers = new Set(onObservation ? [onObservation] : []);
    const promise = this.options.fetch({
      onObservation: (observation) => {
        for (const observer of observers) observer(observation);
      },
    }).then(
      (balance) => {
        if (this.inFlight?.sequence === sequence) this.inFlight = null;
        // Only the newest balance for the current account is published. An
        // older or previous-account response still answers its own callers.
        const current = key === this.options.licenseKey().trim();
        if (current && (!this.cached || this.cached.sequence < sequence)) {
          this.cached = { key, sequence, at: (this.options.now ?? Date.now)(), balance };
          this.notify(balance);
        }
        return balance;
      },
      (error: unknown) => {
        if (this.inFlight?.sequence === sequence) this.inFlight = null;
        throw error;
      },
    );
    this.inFlight = { key, sequence, observers, promise };
    return promise;
  }

  private notify(balance: CreditsBalanceSnapshot): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(balance);
      } catch {
        // A subscriber must never fail the read that informed it.
      }
    }
  }

  private withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
  }
}
