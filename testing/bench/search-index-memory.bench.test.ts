/**
 * Search modal index memory benchmark. Not part of the check gates; run
 * manually to compare the index's retained heap before/after index changes:
 *
 *   node scripts/jest.mjs --config jest.integration.config.cjs \
 *     --roots '<rootDir>/testing/bench' \
 *     --runTestsByPath testing/bench/search-index-memory.bench.test.ts
 *
 * Builds the modal's content index over a generated vault of NOTE_COUNT notes
 * whose text is generated again on every read, so the vault mock keeps no note
 * text alive and the heap difference is what the index itself retains.
 * Obsidian's own per-file read cache is outside this number. Reports the
 * retained heap, build time and per-query timings as JSON on stdout.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { App, TFile } from "obsidian";
import { SystemSculptSearchEngine } from "../../src/services/search/SystemSculptSearchEngine";
import { generateVault } from "../../src/services/search/__tests__/fixtures/generatedVault";

const NOTE_COUNT = Number(process.env.SEARCH_BENCH_NOTES ?? 9_000);
const MEDIAN_CHARS = Number(process.env.SEARCH_BENCH_MEDIAN_CHARS ?? 5_200);
const NOW = Date.UTC(2026, 9, 25, 12);
const QUERIES = ["project", "pro", "fr", "e", "orange juice", "weekly review plan", "co-op", "café", "東京", "🚀", "zzzz-not-a-note"];

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

function settledHeap(): number {
  for (let pass = 0; pass < 4; pass += 1) gc();
  return process.memoryUsage().heapUsed;
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

describe("search index memory benchmark", () => {
  it("reports retained heap for a generated vault", async () => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    const vault = generateVault({ notes: NOTE_COUNT, seed: 379, now: NOW, medianChars: MEDIAN_CHARS });
    let totalChars = 0;
    for (const file of vault.files) totalChars += vault.read(file).length;

    // Plain functions, not jest.fn: a mock records every returned value, which
    // would keep all note text alive and count it against the index.
    const app = new App();
    const byPath = new Map(vault.files.map((file) => [file.path, file]));
    Object.assign(app.vault, {
      getFiles: () => vault.files,
      cachedRead: async (file: TFile) => vault.read(file),
      getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      on: () => ({}),
      offref: () => undefined,
    });
    Object.assign(app.workspace, { on: () => ({}), offref: () => undefined });
    const plugin = {
      app,
      settings: {
        embeddingsEnabled: false,
        embeddingsExclusions: { ignoreChatHistory: false, respectObsidianExclusions: false },
      },
      vaultFileCache: undefined,
    };

    const baseline = settledHeap();
    let engine: SystemSculptSearchEngine | null = new SystemSculptSearchEngine(app as never, plugin as never);
    const buildStart = performance.now();
    await engine.startIndexing();
    const buildMs = performance.now() - buildStart;
    const indexed = settledHeap();

    const queries: Record<string, { ms: number; results: number }> = {};
    for (const query of QUERIES) {
      await engine.search(query, { mode: "lexical", limit: 30 });
      const start = performance.now();
      const response = await engine.search(query, { mode: "lexical", limit: 30 });
      queries[query] = { ms: Math.round((performance.now() - start) * 10) / 10, results: response.results.length };
    }
    const afterQueries = settledHeap();

    engine.destroy();
    engine = null;
    const released = settledHeap();

    process.stdout.write(`${JSON.stringify({
      notes: vault.files.length,
      textMB: megabytes(totalChars),
      buildMs: Math.round(buildMs),
      retainedMB: megabytes(indexed - baseline),
      retainedAfterQueriesMB: megabytes(afterQueries - baseline),
      afterDestroyMB: megabytes(released - baseline),
      queries,
    }, null, 2)}\n`);
    expect(indexed).toBeGreaterThan(baseline);
  }, 600_000);
});
