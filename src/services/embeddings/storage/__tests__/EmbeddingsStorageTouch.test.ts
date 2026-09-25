import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { EmbeddingsStorage } from "../EmbeddingsStorage";
import type { EmbeddingVector } from "../../types";
import { buildVectorId } from "../../utils/vectorId";
import { installFakeIndexedDb } from "../../__tests__/support/fakeIndexedDb";

const CURRENT = "systemsculpt:managed:semantic-v1:v3:3";
const PREVIOUS = "systemsculpt:managed:semantic-v1:v2:3";

function record(namespace: string, chunkId: number): EmbeddingVector {
  return {
    id: buildVectorId(namespace, "Note.md", chunkId),
    path: "Note.md",
    chunkId,
    vector: new Float32Array([0, 1, 0]),
    metadata: {
      title: "Old title",
      mtime: 5,
      contentHash: `hash-${chunkId}`,
      generation: "semantic-v1",
      dimension: 3,
      createdAt: 5,
      namespace,
      ...(chunkId === 0 ? { complete: true, chunkCount: 2, sourceSha256: "a".repeat(64) } : {}),
    },
  };
}

describe("EmbeddingsStorage.touchPath", () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;
  beforeEach(() => { fake = installFakeIndexedDb(); });
  afterEach(() => fake.restore());

  it("stamps one generation's records current without rewriting vectors", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::touch");
    await storage.initialize();
    await storage.storeVectors([record(CURRENT, 0), record(CURRENT, 1), record(PREVIOUS, 0)]);

    await expect(storage.touchPath("Note.md", CURRENT, { mtime: 9, title: "Note" })).resolves.toBe(true);

    const stored = await storage.getVectorsByPath("Note.md");
    const byId = new Map(stored.map((vector) => [vector.id, vector]));
    expect(byId.get(buildVectorId(CURRENT, "Note.md", 0))?.metadata).toMatchObject({
      mtime: 9,
      title: "Note",
      sourceSha256: "a".repeat(64),
    });
    expect(byId.get(buildVectorId(CURRENT, "Note.md", 1))?.metadata.mtime).toBe(9);
    expect(byId.get(buildVectorId(PREVIOUS, "Note.md", 0))?.metadata.mtime).toBe(5);
    expect(Array.from(byId.get(buildVectorId(CURRENT, "Note.md", 1))!.vector)).toEqual([0, 1, 0]);
    expect(storage.getVectorSync(buildVectorId(CURRENT, "Note.md", 0))?.metadata.mtime).toBe(9);
  });

  it("reports a generation with no root so the caller asks the server", async () => {
    const storage = new EmbeddingsStorage("SystemSculptEmbeddings::touch-missing");
    await storage.initialize();

    await expect(storage.touchPath("Note.md", CURRENT, { mtime: 9, title: "Note" })).resolves.toBe(false);
  });
});
