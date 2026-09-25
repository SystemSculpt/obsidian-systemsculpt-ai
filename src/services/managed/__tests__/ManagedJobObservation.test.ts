import {
  dispatchManagedJob,
  isRetryableManagedJobObservationError,
  observeManagedJob,
  retryAfterHeaderMs,
} from "../ManagedJobObservation";
import { PlatformRequestTimeoutError } from "../../PlatformRequestClient";

describe("ManagedJobObservation", () => {
  it("keeps observing past historical client limits and follows server poll hints", async () => {
    let reads = 0;
    const waits: number[] = [];
    for await (const status of observeManagedJob({
      read: async () => ({
        terminal: ++reads > 1_000,
        poll_after_ms: reads % 2 === 0 ? 7 : 11,
      }),
      signal: new AbortController().signal,
      pollAfterMs: value => value.poll_after_ms,
      wait: async milliseconds => {
        waits.push(milliseconds);
      },
    })) {
      if (status.terminal) break;
    }

    expect(reads).toBe(1_001);
    expect(waits).toHaveLength(1_000);
    expect(waits.slice(0, 4)).toEqual([11, 7, 11, 7]);
  });

  it("retries transient observations without an attempt cap and aborts during a wait", async () => {
    const controller = new AbortController();
    let reads = 0;
    const running = async () => {
      for await (const _status of observeManagedJob({
        read: async () => {
          reads += 1;
          throw Object.assign(new Error("temporarily unavailable"), {
            status: 503,
          });
        },
        signal: controller.signal,
        isRetryableError: isRetryableManagedJobObservationError,
        wait: async (_milliseconds, signal) => {
          if (reads === 40) controller.abort();
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        },
      })) {
        // Transient reads never yield.
      }
    };

    await expect(running()).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(40);
  });

  it("retries a request that hit its client deadline but never a local cancel", () => {
    expect(isRetryableManagedJobObservationError(new PlatformRequestTimeoutError(30_000))).toBe(true);
    expect(isRetryableManagedJobObservationError(new DOMException("Aborted", "AbortError"))).toBe(false);
  });

  it("parses bounded Retry-After delta seconds and HTTP dates", () => {
    expect(retryAfterHeaderMs("3")).toBe(3_000);
    expect(retryAfterHeaderMs(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"),
    )).toBe(2_000);
    expect(retryAfterHeaderMs("999999")).toBeUndefined();
    expect(retryAfterHeaderMs("not-a-delay")).toBeUndefined();
  });
});

/**
 * The request that starts managed work is idempotent, so replaying it returns
 * the original job rather than paying twice. Before this retry existed, a
 * transient server fault during credit reservation ended a whole Studio run and
 * abandoned recordings that had already finished uploading.
 */
describe("dispatchManagedJob", () => {
  it("replays an idempotent dispatch until the transient fault clears", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const created = await dispatchManagedJob({
      send: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("temporarily unavailable"), {
            status: 503,
            retryable: true,
          });
        }
        return { job: { id: "job_1" } };
      },
      signal: new AbortController().signal,
      wait: async milliseconds => {
        waits.push(milliseconds);
      },
    });

    expect(attempts).toBe(3);
    expect(created).toEqual({ job: { id: "job_1" } });
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("honors the server's Retry-After instead of its own backoff", async () => {
    const waits: number[] = [];
    let attempts = 0;
    await dispatchManagedJob({
      send: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw Object.assign(new Error("temporarily unavailable"), {
            status: 503,
            retryAfterMs: 5_000,
          });
        }
        return "ok";
      },
      signal: new AbortController().signal,
      retryAfterMs: error => (error as { retryAfterMs?: number }).retryAfterMs,
      wait: async milliseconds => {
        waits.push(milliseconds);
      },
    });

    expect(waits).toEqual([5_000]);
  });

  it("gives up after a bounded number of attempts, unlike polling", async () => {
    let attempts = 0;
    await expect(dispatchManagedJob({
      send: async () => {
        attempts += 1;
        throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      },
      signal: new AbortController().signal,
      wait: async () => {},
    })).rejects.toThrow("temporarily unavailable");

    expect(attempts).toBe(4);
  });

  it("never replays a rejection the server called permanent", async () => {
    let attempts = 0;
    await expect(dispatchManagedJob({
      send: async () => {
        attempts += 1;
        throw Object.assign(new Error("payment required"), {
          status: 402,
          retryable: false,
        });
      },
      signal: new AbortController().signal,
      wait: async () => {},
    })).rejects.toThrow("payment required");

    expect(attempts).toBe(1);
  });

  it("stops replaying once the caller aborts", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const pending = dispatchManagedJob({
      send: async () => {
        attempts += 1;
        throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      },
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });
});
