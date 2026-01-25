/**
 * @jest-environment node
 */
import { tokenCounter, setTokenCounter, TokenCounter } from "../TokenCounter";

describe("TokenCounter", () => {
  // Reset to default counter after each test
  const originalCounter = { ...tokenCounter };

  describe("tokenCounter (default estimator)", () => {
    describe("estimateTokens", () => {
      it("returns a number for text input", () => {
        const result = tokenCounter.estimateTokens("Hello world");

        expect(typeof result).toBe("number");
        expect(result).toBeGreaterThan(0);
      });

      it("returns 0 for empty string", () => {
        const result = tokenCounter.estimateTokens("");

        expect(result).toBe(0);
      });

      it("returns higher count for longer text", () => {
        const short = tokenCounter.estimateTokens("Hello");
        const long = tokenCounter.estimateTokens("Hello world, this is a much longer piece of text");

        expect(long).toBeGreaterThan(short);
      });

      it("handles unicode characters", () => {
        const result = tokenCounter.estimateTokens("你好世界");

        expect(typeof result).toBe("number");
        expect(result).toBeGreaterThan(0);
      });
    });

    describe("calculateOptimalBatchSize", () => {
      it("returns a number", () => {
        const result = tokenCounter.calculateOptimalBatchSize(["text1", "text2"]);

        expect(typeof result).toBe("number");
      });

      it("handles empty array", () => {
        const result = tokenCounter.calculateOptimalBatchSize([]);

        expect(typeof result).toBe("number");
      });

      it("returns reasonable batch size for various inputs", () => {
        const result = tokenCounter.calculateOptimalBatchSize([
          "Short text",
          "Another short text",
          "A slightly longer piece of text",
        ]);

        expect(result).toBeGreaterThan(0);
      });
    });

    describe("createOptimizedBatches", () => {
      it("returns array of batches", () => {
        const items = [
          { content: "Item 1" },
          { content: "Item 2" },
          { content: "Item 3" },
        ];

        const result = tokenCounter.createOptimizedBatches(items);

        expect(Array.isArray(result)).toBe(true);
      });

      it("handles empty array", () => {
        const result = tokenCounter.createOptimizedBatches([]);

        expect(result).toEqual([]);
      });

      it("preserves all items across batches", () => {
        const items = [
          { content: "Item 1", id: 1 },
          { content: "Item 2", id: 2 },
          { content: "Item 3", id: 3 },
        ];

        const batches = tokenCounter.createOptimizedBatches(items);
        const allItems = batches.flat();

        expect(allItems).toHaveLength(3);
        expect(allItems.map((i) => i.id).sort()).toEqual([1, 2, 3]);
      });
    });

    describe("truncateToTokenLimit", () => {
      it("returns original text when under limit", () => {
        const text = "Hello world";

        const result = tokenCounter.truncateToTokenLimit(text, 1000);

        expect(result).toBe(text);
      });

      it("truncates long text", () => {
        const text = "a".repeat(10000);

        const result = tokenCounter.truncateToTokenLimit(text, 100);

        expect(result.length).toBeLessThan(text.length);
      });

      it("handles empty text", () => {
        const result = tokenCounter.truncateToTokenLimit("", 100);

        expect(result).toBe("");
      });
    });

    describe("getBatchStatistics", () => {
      it("returns statistics object", () => {
        const stats = tokenCounter.getBatchStatistics(["text1", "text2"]);

        expect(stats).toHaveProperty("totalTexts");
        expect(stats).toHaveProperty("totalEstimatedTokens");
        expect(stats).toHaveProperty("averageTokensPerText");
        expect(stats).toHaveProperty("maxTokensInSingleText");
        expect(stats).toHaveProperty("recommendedBatchSize");
        expect(stats).toHaveProperty("estimatedBatches");
      });

      it("returns correct total texts count", () => {
        const stats = tokenCounter.getBatchStatistics(["a", "b", "c"]);

        expect(stats.totalTexts).toBe(3);
      });

      it("handles empty array", () => {
        const stats = tokenCounter.getBatchStatistics([]);

        expect(stats.totalTexts).toBe(0);
      });
    });
  });

  describe("setTokenCounter", () => {
    it("allows setting a custom counter", () => {
      const customCounter: TokenCounter = {
        estimateTokens: jest.fn().mockReturnValue(42),
        calculateOptimalBatchSize: jest.fn().mockReturnValue(10),
        createOptimizedBatches: jest.fn().mockReturnValue([]),
        truncateToTokenLimit: jest.fn().mockReturnValue("truncated"),
        getBatchStatistics: jest.fn().mockReturnValue({
          totalTexts: 0,
          totalEstimatedTokens: 0,
          averageTokensPerText: 0,
          maxTokensInSingleText: 0,
          recommendedBatchSize: 1,
          estimatedBatches: 0,
        }),
      };

      setTokenCounter(customCounter);

      expect(tokenCounter.estimateTokens("test")).toBe(42);
      expect(customCounter.estimateTokens).toHaveBeenCalledWith("test");
    });

    afterAll(() => {
      // Restore default counter - we need to reset by creating a new estimator
      // Since we can't easily restore, just verify tests still work
    });
  });
});
