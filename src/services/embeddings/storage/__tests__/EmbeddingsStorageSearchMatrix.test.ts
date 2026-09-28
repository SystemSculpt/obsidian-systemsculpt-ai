import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../EmbeddingsStorage";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { normalizeInPlace } from "../../utils/vector";
import { installFakeIndexedDb } from "../../__tests__/support/fakeIndexedDb";

const NS = "systemsculpt:managed:semantic-v1:v3:2";

function note(path: string, values: number[][], namespace = NS): EmbeddingVector[] {
  return values.map((raw, chunkId) => {
    const vector = Float32Array.from(raw);
    normalizeInPlace(vector);
    return {
      id: buildVectorId(namespace, path, chunkId),
      path,
      chunkId,
      vector,
      metadata: {
        title: path,
        mtime: 1,
        contentHash: `${path}:${chunkId}`,
        generation: "semantic-v1",
        dimension: 2,
        createdAt: 1,
        namespace,
        ...(chunkId === 0 ? { complete: true, chunkCount: values.length } : {}),
      },
    };
  });
}

async function paths(storage: EmbeddingsStorage): Promise<string[]> {
  const matrix = await storage.getSearchMatrix(NS);
  const [top] = await matrix!.search([Float32Array.from([1, 0])], 50, () => true, { minScore: -2 });
  return [...new Set(top.map((candidate) => candidate.path))].sort();
}

describe("EmbeddingsStorage search matrix", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  let storage: EmbeddingsStorage;
  beforeEach(async () => {
    fake = installFakeIndexedDb();
    storage = new EmbeddingsStorage("SystemSculptEmbeddings::matrix");
    await storage.initialize();
  });
  afterEach(() => {
    storage.releaseSearchMatrices();
    fake.restore();
  });

  it("builds once from the store and then follows every mutation without rereading it", async () => {
    await storage.publishPath("A.md", NS, note("A.md", [[1, 0], [1, 1]]));
    await storage.publishPath("B.md", NS, note("B.md", [[0, 1]]));
    await storage.publishPath("Other.md", "systemsculpt:managed:semantic-v1:v4:2", note("Other.md", [[1, 0]], "systemsculpt:managed:semantic-v1:v4:2"));
    await storage.loadEmbeddings();

    const first = await storage.getSearchMatrix(NS);
    expect(await paths(storage)).toEqual(["A.md", "B.md"]);
    expect(await storage.getSearchMatrix(NS)).toBe(first);

    await storage.publishPath("C.md", NS, note("C.md", [[1, 0]]));
    await storage.renameByPath("A.md", "Renamed.md", "Renamed");
    await storage.removeByPath("B.md");
    await storage.publishPath("Folder/D.md", NS, note("Folder/D.md", [[1, 0]]));
    await storage.renameByDirectory("Folder", "Moved");
    expect(await paths(storage)).toEqual(["C.md", "Moved/D.md", "Renamed.md"]);

    await storage.removeByDirectory("Moved");
    expect(await paths(storage)).toEqual(["C.md", "Renamed.md"]);
    expect(await storage.getSearchMatrix(NS)).toBe(first);
  });

  it("replays notes changed while the matrix was being built", async () => {
    await storage.publishPath("A.md", NS, note("A.md", [[1, 0]]));
    await storage.publishPath("B.md", NS, note("B.md", [[1, 0]]));

    const building = storage.getSearchMatrix(NS);
    const racing = Promise.all([
      storage.removeByPath("A.md"),
      storage.publishPath("C.md", NS, note("C.md", [[1, 0]])),
      storage.renameByPath("B.md", "B2.md"),
    ]);
    await Promise.all([building, racing]);

    expect(await paths(storage)).toEqual(["B2.md", "C.md"]);
  });

  it("rebuilds after a bulk change and after release", async () => {
    await storage.publishPath("A.md", NS, note("A.md", [[1, 0]]));
    const first = await storage.getSearchMatrix(NS);

    await storage.retainNamespaces(new Set(["systemsculpt:managed:semantic-v1:v9:2"]));
    const afterSweep = await storage.getSearchMatrix(NS);
    expect(afterSweep).not.toBe(first);
    expect(afterSweep!.size).toBe(0);

    storage.releaseSearchMatrices();
    await storage.publishPath("B.md", NS, note("B.md", [[1, 0]]));
    expect(await paths(storage)).toEqual(["B.md"]);
  });

  it("caches root metadata without vectors and still validates stored roots", async () => {
    const records = note("A.md", [[1, 0]]);
    await storage.storeVectors(records);
    await storage.loadEmbeddings();

    const root = storage.getVectorSync(records[0].id)!;
    expect(root.metadata.namespace).toBe(NS);
    expect("vector" in root).toBe(false);

    await expect(storage.purgeCorruptedVectors()).resolves.toMatchObject({ removedCount: 0, correctedCount: 0 });
    const [stored] = await storage.readRecords([records[0].id]);
    expect(Array.from(stored.vector)).toEqual(Array.from(records[0].vector));
  });
});
