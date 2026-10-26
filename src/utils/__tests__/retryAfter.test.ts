import fixture from "../../../testing/fixtures/retry-after.json";
import { parseRetryAfterMs } from "../retryAfter";

describe("parseRetryAfterMs", () => {
  it.each(fixture.cases)("parses $name without imposing a caller's ceiling", ({ header, milliseconds }) => {
    expect(parseRetryAfterMs(header, { now: fixture.now })).toBe(milliseconds ?? undefined);
  });

  it("keeps numeric overflow as a long hint for callers to clamp", () => {
    expect(parseRetryAfterMs("9".repeat(400))).toBe(Number.MAX_VALUE);
    expect(parseRetryAfterMs(null, { payload: { retry_after_seconds: Number.MAX_VALUE } })).toBe(Number.MAX_VALUE);
  });

  it.each([
    [{ retry_after_seconds: 1.25 }, 1_250],
    [{ retry_after_seconds: 0.0000001 }, 1],
    [{ retry_after_seconds: "2.5" }, 2_500],
    [{ retry_after: 3 }, 3_000],
    [{ retry_after_seconds: null, retry_after: "4" }, 4_000],
    [{ retry_after_seconds: "invalid", retry_after: 5 }, 5_000],
    [{ retry_after_seconds: false }, undefined],
    [{ retry_after_seconds: -1 }, undefined],
    [{}, undefined],
  ] as const)("uses chat payload hints %j when the header is absent or invalid", (payload, expected) => {
    expect(parseRetryAfterMs(null, { payload })).toBe(expected);
    expect(parseRetryAfterMs("invalid", { payload })).toBe(expected);
    expect(parseRetryAfterMs("0", { payload })).toBe(0);
  });
});
