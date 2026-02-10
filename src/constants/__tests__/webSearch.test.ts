/**
 * @jest-environment node
 */
import {
  MOBILE_STREAM_CONFIG,
} from "../webSearch";

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
