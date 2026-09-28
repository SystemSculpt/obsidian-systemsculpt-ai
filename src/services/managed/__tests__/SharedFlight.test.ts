import { SharedFlight } from "../SharedFlight";

function abortable() {
  const starts: AbortSignal[] = [];
  const settle: Array<(value: string) => void> = [];
  const start = jest.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    starts.push(signal);
    settle.push(resolve);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  return { start, starts, settle };
}

describe("SharedFlight", () => {
  it("shares one request among concurrent callers of the same key", async () => {
    const flight = new SharedFlight();
    const { start, settle } = abortable();

    const reads = [flight.run("a", start), flight.run("a", start), flight.run("b", start)];
    expect(start).toHaveBeenCalledTimes(2);
    settle[0]("first");
    settle[1]("second");

    await expect(Promise.all(reads)).resolves.toEqual(["first", "first", "second"]);
    await flight.run("a", async () => "later");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("aborts the shared request only after every caller has left", async () => {
    const flight = new SharedFlight();
    const { start, starts } = abortable();
    const first = new AbortController();
    const second = new AbortController();

    const reads = [flight.run("a", start, first.signal), flight.run("a", start, second.signal)];
    first.abort();
    await expect(reads[0]).rejects.toMatchObject({ name: "AbortError" });
    expect(starts[0].aborted).toBe(false);

    second.abort();
    await expect(reads[1]).rejects.toMatchObject({ name: "AbortError" });
    expect(starts[0].aborted).toBe(true);
  });

  it("keeps the request alive for a caller without a signal", async () => {
    const flight = new SharedFlight();
    const { start, starts, settle } = abortable();
    const cancellable = new AbortController();

    const cancelled = flight.run("a", start, cancellable.signal);
    const kept = flight.run("a", start);
    cancellable.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(starts[0].aborted).toBe(false);
    settle[0]("done");
    await expect(kept).resolves.toBe("done");
  });

  it("starts a new request for a caller arriving after the last one left", async () => {
    const flight = new SharedFlight();
    const { start, settle } = abortable();
    const gone = new AbortController();

    const abandoned = flight.run("a", start, gone.signal);
    gone.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

    const fresh = flight.run("a", start);
    expect(start).toHaveBeenCalledTimes(2);
    settle[1]("fresh");
    await expect(fresh).resolves.toBe("fresh");
  });

  it("does not start a request for an already cancelled caller and shares failures", async () => {
    const flight = new SharedFlight();
    const cancelled = new AbortController();
    cancelled.abort();
    const start = jest.fn(async () => {
      throw new Error("offline");
    });

    await expect(flight.run("a", start, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(start).not.toHaveBeenCalled();
    await expect(Promise.all([flight.run("a", start), flight.run("a", start)])).rejects.toThrow("offline");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
