/**
 * @jest-environment node
 */

import { BENCH_ROOT_PLACEHOLDER, OBSIDIAN_BENCHMARK_V2 } from "../obsidianCoreV2";

describe("obsidianCoreV2", () => {
  describe("BENCH_ROOT_PLACEHOLDER", () => {
    it("is a placeholder string", () => {
      expect(BENCH_ROOT_PLACEHOLDER).toBe("{{BENCH_ROOT}}");
    });
  });

  describe("OBSIDIAN_BENCHMARK_V2", () => {
    it("has required properties", () => {
      expect(OBSIDIAN_BENCHMARK_V2.id).toBe("obsidian-core-v2");
      expect(OBSIDIAN_BENCHMARK_V2.version).toBe("v2");
      expect(OBSIDIAN_BENCHMARK_V2.title).toBe("Obsidian Core");
    });

    it("has fixture files", () => {
      expect(OBSIDIAN_BENCHMARK_V2.fixture).toBeDefined();
      expect(Object.keys(OBSIDIAN_BENCHMARK_V2.fixture!).length).toBeGreaterThan(0);
    });

    it("includes a ~100KB journal file", () => {
      const content = OBSIDIAN_BENCHMARK_V2.fixture["Journal/2025.md"];
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThanOrEqual(100 * 1024);
    });

    it("has test cases", () => {
      expect(OBSIDIAN_BENCHMARK_V2.cases).toBeDefined();
      expect(OBSIDIAN_BENCHMARK_V2.cases.length).toBeGreaterThan(0);
    });

    it("has unique case IDs", () => {
      const ids = OBSIDIAN_BENCHMARK_V2.cases.map((c) => c.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it("orders cases by non-decreasing difficulty", () => {
      const rank: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
      let last = -1;
      const counts = { easy: 0, medium: 0, hard: 0 };

      for (const testCase of OBSIDIAN_BENCHMARK_V2.cases) {
        expect(testCase.difficulty in rank).toBe(true);
        const next = rank[testCase.difficulty];
        expect(next).toBeGreaterThanOrEqual(last);
        last = next;
        counts[testCase.difficulty] += 1;
      }

      expect(counts.easy).toBeGreaterThan(0);
      expect(counts.medium).toBeGreaterThan(0);
      expect(counts.hard).toBeGreaterThan(0);
    });

    it("has weights", () => {
      expect(OBSIDIAN_BENCHMARK_V2.weights).toEqual({
        correctness: 0.7,
        efficiency: 0.3,
      });
    });

    it("has default efficiency budget", () => {
      expect(OBSIDIAN_BENCHMARK_V2.defaultEfficiencyBudget).toBeDefined();
      expect(OBSIDIAN_BENCHMARK_V2.defaultEfficiencyBudget?.maxToolCalls).toBe(10);
    });

    it("first prompt of each case references the placeholder", () => {
      for (const testCase of OBSIDIAN_BENCHMARK_V2.cases) {
        // First prompt should always reference the sandbox root
        expect(testCase.prompts[0]).toContain(BENCH_ROOT_PLACEHOLDER);
      }
    });
  });
});
