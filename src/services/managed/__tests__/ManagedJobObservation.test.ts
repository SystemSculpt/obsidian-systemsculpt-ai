import {
  isRetryableManagedJobObservationError,
  observeManagedJob,
  retryAfterHeaderMs,
} from "../ManagedJobObservation";

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
