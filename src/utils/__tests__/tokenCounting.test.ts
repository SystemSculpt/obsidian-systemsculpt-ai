import { countTextTokens, estimateTextTokens } from "../tokenCounting";

describe("countTextTokens", () => {
  it.each(["", "Hello world", "你好世界", "😀😀", "https://systemsculpt.com/a/long/path", "x".repeat(40000)])(
    "keeps uncached estimates identical to cached counts for %s",
    (text) => expect(estimateTextTokens(text)).toBe(countTextTokens(text)),
  );

  it("returns zero for empty input", () => {
    expect(countTextTokens("")).toBe(0);
  });

  it("is deterministic and increases with ordinary text size", () => {
    const short = countTextTokens("Hello world");
    const long = countTextTokens("Hello world. This is a substantially longer local display estimate.");

    expect(countTextTokens("Hello world")).toBe(short);
    expect(long).toBeGreaterThan(short);
  });

  it("accounts for CJK text and emoji without a tokenizer dependency", () => {
    expect(countTextTokens("你好世界")).toBe(4);
    expect(countTextTokens("😀😀")).toBeGreaterThanOrEqual(4);
  });

  it("remains a generic estimate without managed model-limit behavior", () => {
    const largeText = "x".repeat(40_000);

    expect(countTextTokens(largeText)).toBe(10_000);
  });
});
