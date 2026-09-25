type Flight = {
  readonly controller: AbortController;
  promise: Promise<unknown>;
  waiters: number;
  /** A caller without a signal cannot cancel, so the request always finishes. */
  pinned: boolean;
};

function abortError(): DOMException {
  return new DOMException("The shared request was cancelled.", "AbortError");
}

/**
 * Coalesces identical concurrent reads: callers with the same key while a
 * request is in flight share it instead of sending their own.
 *
 * The shared request has its own signal, which aborts only once every waiting
 * caller has aborted. Each caller still sees its own abort immediately, and a
 * caller arriving after the shared request was abandoned starts a new one.
 */
export class SharedFlight {
  private readonly flights = new Map<string, Flight>();

  run<T>(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      // A synchronous throw becomes this flight's rejection.
      const started = (async () => start(controller.signal))();
      const created: Flight = { controller, promise: started, waiters: 0, pinned: false };
      created.promise = started.finally(() => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      // Every caller may have left; the settled request must not go unhandled.
      created.promise.catch(() => undefined);
      this.flights.set(key, created);
      flight = created;
    }

    const joined = flight;
    joined.waiters += 1;
    if (!signal) {
      joined.pinned = true;
      return joined.promise as Promise<T>;
    }
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => {
        joined.waiters -= 1;
        if (joined.waiters === 0 && !joined.pinned) {
          if (this.flights.get(key) === joined) this.flights.delete(key);
          joined.controller.abort();
        }
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([joined.promise as Promise<T>, aborted])
      .finally(() => signal.removeEventListener("abort", onAbort));
  }
}
