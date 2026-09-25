/** @jest-environment jsdom */

import {
  dispatchManagedJob,
  isRetryableManagedJobObservationError,
  normalizedPollAfterMs,
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
        poll_after_ms: reads % 2 === 0 ? 1_500 : 3_000,
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
    expect(waits.slice(0, 4)).toEqual([3_000, 1_500, 3_000, 1_500]);
  });

  it("never polls more than once a second, whatever the server hint", async () => {
    let reads = 0;
    const waits: number[] = [];
    for await (const status of observeManagedJob({
      read: async () => ({ terminal: ++reads > 3, poll_after_ms: [0, 7, 999][reads - 1] }),
      signal: new AbortController().signal,
      pollAfterMs: value => value.poll_after_ms,
      wait: async milliseconds => {
        waits.push(milliseconds);
      },
    })) {
      if (status.terminal) break;
    }

    expect(waits).toEqual([1_000, 1_000, 1_000]);
    expect(normalizedPollAfterMs(0)).toBe(1_000);
    expect(normalizedPollAfterMs(undefined)).toBe(2_000);
  });

  it("backs off transient observations and surfaces the last failure after a bounded streak", async () => {
    let reads = 0;
    const waits: number[] = [];
    const running = async () => {
      for await (const _status of observeManagedJob({
        read: async () => {
          reads += 1;
          throw Object.assign(new Error(`temporarily unavailable ${reads}`), { status: 503 });
        },
        signal: new AbortController().signal,
        isRetryableError: isRetryableManagedJobObservationError,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      })) {
        // Transient reads never yield.
      }
    };

    await expect(running()).rejects.toThrow("temporarily unavailable 14");
    expect(reads).toBe(14);
    expect(waits.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(waits.reduce((total, milliseconds) => total + milliseconds, 0)).toBeLessThanOrEqual(5 * 60_000);
  });

  it("resets the failure streak after a successful read", async () => {
    let reads = 0;
    let yielded = 0;
    for await (const _status of observeManagedJob({
      read: async () => {
        reads += 1;
        if (reads % 3 !== 0) throw Object.assign(new Error("blip"), { status: 503 });
        return { reads };
      },
      signal: new AbortController().signal,
      isRetryableError: isRetryableManagedJobObservationError,
      maxConsecutiveTransientFailures: 3,
      wait: async () => undefined,
    })) {
      yielded += 1;
      if (yielded === 5) break;
    }

    expect(reads).toBe(15);
  });

  it("aborts transient retries during a wait", async () => {
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
          if (reads === 4) controller.abort();
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        },
      })) {
        // Transient reads never yield.
      }
    };

    await expect(running()).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(4);
  });

  it("reads nothing while the host is offline and resumes on reconnect", async () => {
    const onLine = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      const read = jest.fn(async () => ({ terminal: true }));
      const observation = observeManagedJob({
        read,
        signal: new AbortController().signal,
        wait: async () => undefined,
      });
      const first = observation.next();
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(read).not.toHaveBeenCalled();

      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
      window.dispatchEvent(new Event("online"));
      await expect(first).resolves.toMatchObject({ value: { terminal: true } });
      expect(read).toHaveBeenCalledTimes(1);
      await observation.return(undefined as never);
    } finally {
      if (onLine) Object.defineProperty(window.navigator, "onLine", onLine);
      else Reflect.deleteProperty(window.navigator, "onLine");
    }
  });

  it("does not spend the failure budget on reads that failed while offline", async () => {
    let online = true;
    const onLine = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
    try {
      let reads = 0;
      const waitForOnline = jest.fn(async () => {
        online = true;
      });
      for await (const _status of observeManagedJob({
        read: async () => {
          reads += 1;
          if (reads <= 5) {
            online = false;
            throw new TypeError("Failed to fetch");
          }
          return { done: true };
        },
        signal: new AbortController().signal,
        isRetryableError: isRetryableManagedJobObservationError,
        maxConsecutiveTransientFailures: 2,
        wait: async () => undefined,
        waitForOnline,
      })) {
        break;
      }
      expect(reads).toBe(6);
    } finally {
      if (onLine) Object.defineProperty(window.navigator, "onLine", onLine);
      else Reflect.deleteProperty(window.navigator, "onLine");
    }
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
