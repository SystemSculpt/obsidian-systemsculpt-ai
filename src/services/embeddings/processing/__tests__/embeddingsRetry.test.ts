import { describe, expect, it, jest } from "@jest/globals";
import { EmbeddingsProviderError } from "../../providers/ProviderError";
import {
  computeBackoffMs,
  isRetriableEmbeddingsError,
  withProviderRetry,
} from "../embeddingsRetry";

function providerError(
  overrides: Partial<ConstructorParameters<typeof EmbeddingsProviderError>[1]> = {},
): EmbeddingsProviderError {
  return new EmbeddingsProviderError("boom", {
    code: "RATE_LIMITED",
    transient: true,
    ...overrides,
  });
}

describe("isRetriableEmbeddingsError", () => {
  it("is true only for transient, non-license provider errors", () => {
    expect(isRetriableEmbeddingsError(providerError({ transient: true }))).toBe(true);
    expect(isRetriableEmbeddingsError(providerError({ transient: false }))).toBe(false);
    expect(
      isRetriableEmbeddingsError(
        providerError({ transient: true, licenseRelated: true, code: "LICENSE_INVALID" }),
      ),
    ).toBe(false);
  });

  it("never retries HOST_UNAVAILABLE (host cooldown / WAF has its own handling)", () => {
    expect(
      isRetriableEmbeddingsError(providerError({ transient: true, code: "HOST_UNAVAILABLE" })),
    ).toBe(false);
  });

  it("is false for plain errors and non-errors", () => {
    expect(isRetriableEmbeddingsError(new Error("nope"))).toBe(false);
    expect(isRetriableEmbeddingsError(null)).toBe(false);
    expect(isRetriableEmbeddingsError("429")).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  it("honors a server retryInMs, capped at maxDelayMs", () => {
    expect(computeBackoffMs(1, { maxDelayMs: 30_000 }, 2_000)).toBe(2_000);
    expect(computeBackoffMs(1, { maxDelayMs: 5_000 }, 60_000)).toBe(5_000);
  });

  it("grows exponentially from the base when no retryInMs is given", () => {
    // randomFraction=1 -> full (100%) of the capped exponential, no reduction.
    expect(computeBackoffMs(1, { baseDelayMs: 1_000 }, undefined, 1)).toBe(1_000);
    expect(computeBackoffMs(2, { baseDelayMs: 1_000 }, undefined, 1)).toBe(2_000);
    expect(computeBackoffMs(3, { baseDelayMs: 1_000 }, undefined, 1)).toBe(4_000);
  });

  it("applies half-jitter into [50%, 100%] of the capped delay", () => {
    expect(computeBackoffMs(1, { baseDelayMs: 1_000 }, undefined, 0)).toBe(500);
    expect(computeBackoffMs(1, { baseDelayMs: 1_000 }, undefined, 1)).toBe(1_000);
  });

  it("caps the exponential growth at maxDelayMs", () => {
    expect(computeBackoffMs(20, { baseDelayMs: 1_000, maxDelayMs: 30_000 }, undefined, 1)).toBe(30_000);
  });
});

describe("withProviderRetry", () => {
  const noSleep = { sleep: jest.fn(async () => undefined), random: () => 1 };

  it("returns immediately on success without sleeping", async () => {
    const sleep = jest.fn(async () => undefined);
    const op = jest.fn(async () => "ok");

    const result = await withProviderRetry(op, {}, { sleep, random: () => 1 });

    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient error then succeeds", async () => {
    const op = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(providerError({ code: "RATE_LIMITED", retryInMs: 1_500 }))
      .mockResolvedValueOnce("recovered");
    const sleep = jest.fn(async () => undefined);

    const result = await withProviderRetry(op, {}, { sleep, random: () => 1 });

    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_500); // honored Retry-After
  });

  it("does not retry a non-transient error", async () => {
    const op = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(providerError({ code: "HTTP_ERROR", transient: false }));

    await expect(withProviderRetry(op, {}, noSleep)).rejects.toMatchObject({
      code: "HTTP_ERROR",
    });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and rethrows the last typed error", async () => {
    const op = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(providerError({ code: "RATE_LIMITED", transient: true }));
    const sleep = jest.fn(async () => undefined);

    await expect(
      withProviderRetry(op, { maxRetries: 2 }, { sleep, random: () => 1 }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(op).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports each retry via onRetry", async () => {
    const op = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(providerError({ retryInMs: 1_000 }))
      .mockResolvedValueOnce("ok");
    const onRetry = jest.fn();

    await withProviderRetry(op, {}, { sleep: jest.fn(async () => undefined), random: () => 1, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 1_000 }),
    );
  });
});
