/**
 * @jest-environment node
 */
import {
  WEB_SEARCH_CONFIG,
  MOBILE_STREAM_CONFIG,
  type WebSearchContextSize,
} from "../webSearch";

describe("WEB_SEARCH_CONFIG", () => {
  it("has MAX_RESULTS defined", () => {
    expect(WEB_SEARCH_CONFIG.MAX_RESULTS).toBeDefined();
    expect(typeof WEB_SEARCH_CONFIG.MAX_RESULTS).toBe("number");
  });

  it("MAX_RESULTS is a reasonable value", () => {
    expect(WEB_SEARCH_CONFIG.MAX_RESULTS).toBeGreaterThan(0);
    expect(WEB_SEARCH_CONFIG.MAX_RESULTS).toBeLessThanOrEqual(20);
  });

  it("has PLUGIN_ID defined", () => {
    expect(WEB_SEARCH_CONFIG.PLUGIN_ID).toBeDefined();
    expect(typeof WEB_SEARCH_CONFIG.PLUGIN_ID).toBe("string");
    expect(WEB_SEARCH_CONFIG.PLUGIN_ID).toBe("web");
  });

  it("has DEFAULT_CONTEXT_SIZE defined", () => {
    expect(WEB_SEARCH_CONFIG.DEFAULT_CONTEXT_SIZE).toBeDefined();
    expect(WEB_SEARCH_CONFIG.DEFAULT_CONTEXT_SIZE).toBe("medium");
  });

  it("DEFAULT_CONTEXT_SIZE is a valid WebSearchContextSize", () => {
    const validSizes: WebSearchContextSize[] = ["low", "medium", "high"];
    expect(validSizes).toContain(WEB_SEARCH_CONFIG.DEFAULT_CONTEXT_SIZE);
  });
});

describe("MOBILE_STREAM_CONFIG", () => {
  it("has CHUNK_SIZE defined", () => {
    expect(MOBILE_STREAM_CONFIG.CHUNK_SIZE).toBeDefined();
    expect(typeof MOBILE_STREAM_CONFIG.CHUNK_SIZE).toBe("number");
  });

  it("CHUNK_SIZE is a reasonable value", () => {
    expect(MOBILE_STREAM_CONFIG.CHUNK_SIZE).toBeGreaterThan(0);
    expect(MOBILE_STREAM_CONFIG.CHUNK_SIZE).toBeLessThanOrEqual(500);
  });

  it("has CHUNK_DELAY_MS defined", () => {
    expect(MOBILE_STREAM_CONFIG.CHUNK_DELAY_MS).toBeDefined();
    expect(typeof MOBILE_STREAM_CONFIG.CHUNK_DELAY_MS).toBe("number");
  });

  it("CHUNK_DELAY_MS is a reasonable value", () => {
    expect(MOBILE_STREAM_CONFIG.CHUNK_DELAY_MS).toBeGreaterThanOrEqual(0);
    expect(MOBILE_STREAM_CONFIG.CHUNK_DELAY_MS).toBeLessThanOrEqual(100);
  });
});

describe("WebSearchContextSize type", () => {
  it("can be low", () => {
    const size: WebSearchContextSize = "low";
    expect(size).toBe("low");
  });

  it("can be medium", () => {
    const size: WebSearchContextSize = "medium";
    expect(size).toBe("medium");
  });

  it("can be high", () => {
    const size: WebSearchContextSize = "high";
    expect(size).toBe("high");
  });
});
