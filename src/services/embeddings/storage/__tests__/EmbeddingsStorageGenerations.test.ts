import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../EmbeddingsStorage";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { createLocalEmptyEmbeddingMarkerForRevision } from "../../LocalEmptyEmbeddingMarker";
import { installFakeIndexedDb } from "../../__tests__/support/fakeIndexedDb";

const V2 = "systemsculpt:managed:semantic-v1:v2:3";
const V3 = "systemsculpt:managed:semantic-v1:v3:3";
const V4 = "systemsculpt:managed:semantic-v1:v4:3";
const LEGACY = "systemsculpt:openrouter/openai/text-embedding-3-small:v2:3";

function record(namespace: string, path: string, chunkId: number, createdAt = 1): EmbeddingVector {
  return {
    id: buildVectorId(namespace, path, chunkId),
    path,
    chunkId,
    vector: new Float32Array([1, 0, 0]),
    metadata: {
      title: path,
      mtime: 1,
      contentHash: `${path}:${chunkId}`,
      generation: "semantic-v1",
      dimension: 3,
      createdAt,
      namespace,
      ...(chunkId === 0 ? { complete: true, chunkCount: 2 } : {}),
    },
  };
}

describe("EmbeddingsStorage generation retention", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  async function seededStorage(): Promise<EmbeddingsStorage> {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::generations");
    await storage.initialize();
    await storage.storeVectors([
      record(V2, "A.md", 0, 10), record(V2, "A.md", 1, 10),
      record(V3, "A.md", 0, 20), record(V3, "A.md", 1, 20),
      record(V4, "A.md", 0, 30),
      record(LEGACY, "A.md", 0, 5), record(LEGACY, "B.md", 0, 5),
      // A chunk whose root is already gone must not survive either.
      record(V2, "Orphan.md", 3, 10),
      createLocalEmptyEmbeddingMarkerForRevision({ path: "Empty.md", basename: "Empty", mtime: 1 }, ""),
    ]);
    await storage.loadEmbeddings();
    return storage;
  }

  it("keeps only the requested managed generations and local empty markers", async () => {
    const storage = await seededStorage();

    const removed = await storage.retainNamespaces(new Set([V3, V4]));

    expect(removed).toBe(5);
    expect((await storage.listStoredNamespaces()).sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      V3,
      V4,
    ].sort());
    expect(storage.getVectorSync(buildVectorId(V2, "A.md", 0))).toBeNull();
    expect(storage.getVectorSync(buildVectorId(LEGACY, "B.md", 0))).toBeNull();
    expect(storage.getVectorSync(buildVectorId(V3, "A.md", 0))).not.toBeNull();
    expect(storage.getDistinctPaths().sort()).toEqual(["A.md", "Empty.md"]);
  });

  it("drops only non-managed namespaces when no generation is trusted yet", async () => {
    const storage = await seededStorage();

    await storage.retainNamespaces(null);

    expect((await storage.listStoredNamespaces()).sort()).toEqual([
      "systemsculpt:local-empty:v1:1",
      V2,
      V3,
      V4,
    ].sort());
  });

  it("names the most recently written generation as in progress", async () => {
    const storage = await seededStorage();

    expect(storage.peekLatestManagedNamespace()).toBe(V4);
    expect(storage.listRootNamespaces()).toEqual(
      ["systemsculpt:local-empty:v1:1", LEGACY, V2, V3, V4].sort(),
    );
  });
});
