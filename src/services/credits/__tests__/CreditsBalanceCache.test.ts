import { CreditsBalanceCache } from "../CreditsBalanceCache";
import type { CreditsBalanceSnapshot } from "../../SystemSculptService";

function balance(totalRemaining: number): CreditsBalanceSnapshot {
  return { totalRemaining, availableUnreserved: totalRemaining } as unknown as CreditsBalanceSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("CreditsBalanceCache", () => {
  let now: number;
  let licenseKey: string;

  beforeEach(() => {
    now = 1_000;
    licenseKey = "license-a";
  });

  const create = (fetch: jest.Mock) => new CreditsBalanceCache({
    fetch,
    licenseKey: () => licenseKey,
    now: () => now,
  });

  it("serves views from one read per minute per license key", async () => {
    const fetch = jest.fn(async () => balance(5));
    const cache = create(fetch);

    await expect(cache.read()).resolves.toMatchObject({ totalRemaining: 5 });
    now += 59_999;
    await cache.read();
    await cache.read();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1;
    await cache.read();
    expect(fetch).toHaveBeenCalledTimes(2);

    licenseKey = "license-b";
    await cache.read();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares an in-flight read and its transport observation with every caller", async () => {
    const pending = deferred<CreditsBalanceSnapshot>();
    const fetch = jest.fn((options: { onObservation?: (value: unknown) => void }) => {
      void pending.promise.then(() => options.onObservation?.({ transport: "fetch", status: 200 }));
      return pending.promise.then(async (value) => {
        await Promise.resolve();
        return value;
      });
    });
    const cache = create(fetch as unknown as jest.Mock);
    const first = jest.fn();
    const second = jest.fn();

    const reads = [cache.read({ onObservation: first }), cache.read({ onObservation: second })];
    pending.resolve(balance(3));
    await expect(Promise.all(reads)).resolves.toEqual([balance(3), balance(3)]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ transport: "fetch", status: 200 });
    expect(second).toHaveBeenCalledWith({ transport: "fetch", status: 200 });
  });

  it("starts a fresh read that an older response can never overwrite", async () => {
    const older = deferred<CreditsBalanceSnapshot>();
    const fresh = deferred<CreditsBalanceSnapshot>();
    const fetch = jest.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(fresh.promise);
    const cache = create(fetch);

    const stale = cache.read();
    const current = cache.read({ fresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);

    fresh.resolve(balance(1));
    await current;
    older.resolve(balance(9));
    await stale;

    await expect(cache.read()).resolves.toMatchObject({ totalRemaining: 1 });
    expect(cache.peek()).toMatchObject({ totalRemaining: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const fetch = jest.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(balance(2));
    const cache = create(fetch);

    await expect(cache.read()).rejects.toThrow("offline");
    await expect(cache.read()).resolves.toMatchObject({ totalRemaining: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers of every server balance", async () => {
    const fetch = jest.fn(async () => balance(4));
    const cache = create(fetch);
    const listener = jest.fn();
    const unsubscribe = cache.subscribe(listener);

    await cache.read();
    await cache.read();
    await cache.read({ fresh: true });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await cache.read({ fresh: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("cancels one caller without failing the shared read", async () => {
    const pending = deferred<CreditsBalanceSnapshot>();
    const fetch = jest.fn(() => pending.promise);
    const cache = create(fetch);
    const controller = new AbortController();

    const cancelled = cache.read({ signal: controller.signal });
    const kept = cache.read();
    controller.abort();
    pending.resolve(balance(6));

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(kept).resolves.toMatchObject({ totalRemaining: 6 });
  });
});
