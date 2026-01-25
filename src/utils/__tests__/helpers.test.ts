/**
 * @jest-environment node
 */
import { sleep } from "../helpers";

describe("helpers", () => {
  describe("sleep", () => {
    it("resolves after specified time", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      // Allow some tolerance for timing
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });

    it("resolves with undefined", async () => {
      const result = await sleep(10);

      expect(result).toBeUndefined();
    });

    it("handles 0 milliseconds", async () => {
      const start = Date.now();
      await sleep(0);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it("is a promise", () => {
      const result = sleep(10);

      expect(result).toBeInstanceOf(Promise);
    });

    it("can be awaited multiple times in sequence", async () => {
      const start = Date.now();
      await sleep(20);
      await sleep(20);
      await sleep(20);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(55);
    });

    it("can be used with Promise.all", async () => {
      const start = Date.now();
      await Promise.all([sleep(30), sleep(30), sleep(30)]);
      const elapsed = Date.now() - start;

      // All should resolve in parallel, so elapsed should be ~30ms not ~90ms
      expect(elapsed).toBeLessThan(80);
    });
  });
});
