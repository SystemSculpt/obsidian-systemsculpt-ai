import { SemanticMatrix } from "../SemanticMatrix";
import { normalizeInPlace } from "../../utils/vector";

function unit(...values: number[]): Float32Array {
  const vector = Float32Array.from(values);
  normalizeInPlace(vector);
  return vector;
}

const everyNote = () => true;

describe("SemanticMatrix", () => {
  it("ranks notes by approximate cosine similarity and returns their chunk", async () => {
    const matrix = new SemanticMatrix(3);
    matrix.upsertPath("Near.md", [{ chunkId: 0, vector: unit(1, 0.1, 0) }, { chunkId: 2, vector: unit(0.9, 0.3, 0) }]);
    matrix.upsertPath("Far.md", [{ chunkId: 0, vector: unit(0, 0, 1) }]);
    matrix.upsertPath("Middle.md", [{ chunkId: 0, vector: unit(1, 1, 0) }]);

    const [top] = await matrix.search([unit(1, 0, 0)], 3, everyNote);

    expect(top.map((candidate) => `${candidate.path}#${candidate.chunkId}`)).toEqual(["Near.md#0", "Near.md#2", "Middle.md#0"]);
    expect(top[0].score).toBeGreaterThan(0.99);
    expect(top[0].score).toBeLessThan(1.001);
  });

  it("decides eligibility once per note, not once per chunk", async () => {
    const matrix = new SemanticMatrix(2);
    matrix.upsertPath("A.md", Array.from({ length: 5 }, (_, chunkId) => ({ chunkId, vector: unit(1, chunkId / 10) })));
    matrix.upsertPath("B.md", [{ chunkId: 0, vector: unit(1, 0) }]);
    const isEligible = jest.fn((path: string) => path !== "B.md");

    const [top] = await matrix.search([unit(1, 0)], 10, isEligible);

    expect(isEligible).toHaveBeenCalledTimes(2);
    expect(new Set(top.map((candidate) => candidate.path))).toEqual(new Set(["A.md"]));
  });

  it("follows publishes, removals and renames of notes and folders", async () => {
    const matrix = new SemanticMatrix(2);
    matrix.upsertPath("Folder/A.md", [{ chunkId: 0, vector: unit(1, 0) }]);
    matrix.upsertPath("Folder/B.md", [{ chunkId: 0, vector: unit(1, 0.2) }]);
    matrix.upsertPath("C.md", [{ chunkId: 0, vector: unit(0, 1) }]);
    const paths = async () => (await matrix.search([unit(1, 0.1)], 10, everyNote, { minScore: -1 }))[0]
      .map((candidate) => candidate.path)
      .sort();

    matrix.renamePath("C.md", "D.md");
    matrix.renamePrefix("Folder/", "Moved/");
    expect(await paths()).toEqual(["D.md", "Moved/A.md", "Moved/B.md"]);

    matrix.upsertPath("D.md", [{ chunkId: 0, vector: unit(1, 0.1) }, { chunkId: 1, vector: unit(1, 0.1) }]);
    matrix.removePrefix("Moved/");
    expect(await paths()).toEqual(["D.md", "D.md"]);
    expect(matrix.size).toBe(2);

    matrix.removePath("D.md");
    expect(await paths()).toEqual([]);
  });

  it("stays correct across compaction after many removals", async () => {
    const matrix = new SemanticMatrix(2);
    for (let index = 0; index < 3_000; index += 1) {
      matrix.upsertPath(`Note-${index}.md`, [{ chunkId: 0, vector: unit(1, index / 3_000) }]);
    }
    for (let index = 0; index < 2_990; index += 1) matrix.removePath(`Note-${index}.md`);
    matrix.upsertPath("X.md", [{ chunkId: 0, vector: unit(-1, 1) }]);
    matrix.upsertPath("Y.md", [{ chunkId: 0, vector: unit(-1, 0.5) }]);

    const [all] = await matrix.search([unit(1, 1)], 50, everyNote, { minScore: -2 });
    const [top] = await matrix.search([unit(-1, 1)], 2, everyNote);

    expect(matrix.size).toBe(12);
    expect(all.map((candidate) => candidate.path).sort()).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `Note-${2_990 + index}.md`),
      "X.md",
      "Y.md",
    ].sort());
    expect(top.map((candidate) => candidate.path)).toEqual(["X.md", "Y.md"]);
  });

  it("returns nothing once cancelled between slices", async () => {
    jest.useFakeTimers();
    try {
      const matrix = new SemanticMatrix(2);
      for (let index = 0; index < 100; index += 1) matrix.upsertPath(`N${index}.md`, [{ chunkId: 0, vector: unit(1, 0) }]);
      const controller = new AbortController();

      const search = matrix.search([unit(1, 0)], 5, everyNote, { signal: controller.signal, rowsPerSlice: 10 });
      controller.abort();
      await jest.advanceTimersByTimeAsync(0);

      await expect(search).resolves.toEqual([[]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("packs int8 rows: a quarter of Float32", () => {
    const matrix = new SemanticMatrix(1536, 1_000);
    const vector = unit(...Array.from({ length: 1536 }, (_, index) => Math.sin(index)));
    for (let index = 0; index < 1_000; index += 1) matrix.upsertPath(`N${index}.md`, [{ chunkId: 0, vector }]);

    expect(matrix.byteLength).toBeLessThan(1_000 * 1536 * 4 / 3.9);
  });
});
