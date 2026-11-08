import { estimateTextTokens } from "../tokenCounting";

describe("estimateTextTokens", () => {
  it("returns zero for empty input", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  it("is deterministic and increases with ordinary text size", () => {
    const short = estimateTextTokens("Hello world");
    const long = estimateTextTokens("Hello world. This is a substantially longer local display estimate.");

    expect(estimateTextTokens("Hello world")).toBe(short);
    expect(long).toBeGreaterThan(short);
  });

  it("accounts for CJK text and emoji without a tokenizer dependency", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
    expect(estimateTextTokens("😀😀")).toBeGreaterThanOrEqual(4);
  });

  it("accounts for URL characters separately from ordinary text", () => {
    const url = "https://systemsculpt.com/a/long/path";

    expect(estimateTextTokens(url)).toBe(Math.ceil(url.length / 3.2));
  });

  it("remains a generic estimate without managed model-limit behavior", () => {
    const largeText = "x".repeat(40_000);

    expect(estimateTextTokens(largeText)).toBe(10_000);
  });
});
