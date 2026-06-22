import { describe, expect, it } from "@jest/globals";
import { normalizeEmbeddingsResponse } from "../embeddingResponse";

describe("normalizeEmbeddingsResponse", () => {
  it("reads the OpenAI/LM Studio `data: [{embedding,index}]` batch shape", () => {
    const out = normalizeEmbeddingsResponse({
      data: [
        { index: 0, embedding: [0.1, 0.2] },
        { index: 1, embedding: [0.3, 0.4] },
      ],
    });
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  it("sorts the `data[]` shape by index when every item is indexed", () => {
    const out = normalizeEmbeddingsResponse({
      data: [
        { index: 2, embedding: [3] },
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    });
    expect(out).toEqual([[1], [2], [3]]);
  });

  it("preserves order for the `data[]` shape when index is absent", () => {
    const out = normalizeEmbeddingsResponse({
      data: [{ embedding: [1] }, { embedding: [2] }],
    });
    expect(out).toEqual([[1], [2]]);
  });

  it("reads a top-level singular `{embedding: [...]}` (LM Studio single -> #153)", () => {
    const out = normalizeEmbeddingsResponse({ embedding: [0.5, 0.6, 0.7] });
    expect(out).toEqual([[0.5, 0.6, 0.7]]);
  });

  it("reads a top-level plural `{embeddings: [[...]]}`", () => {
    const out = normalizeEmbeddingsResponse({
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(out).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("reads a raw 2D array response", () => {
    const out = normalizeEmbeddingsResponse([
      [1, 2],
      [3, 4],
    ]);
    expect(out).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("wraps a raw single vector `[...]` into a 2D array", () => {
    expect(normalizeEmbeddingsResponse([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("returns null for unrecognized shapes (caller throws UNEXPECTED_RESPONSE)", () => {
    expect(normalizeEmbeddingsResponse({ unexpected: "format" })).toBeNull();
    expect(normalizeEmbeddingsResponse(null)).toBeNull();
    expect(normalizeEmbeddingsResponse("nope")).toBeNull();
    expect(normalizeEmbeddingsResponse({ data: [] })).toBeNull();
    expect(normalizeEmbeddingsResponse({ embedding: "%%%" })).toBeNull();
    // A base64 embedding payload is not a number[] -> unrecognized (out of scope).
    expect(
      normalizeEmbeddingsResponse({ data: [{ index: 0, embedding: "AACAPw==" }] }),
    ).toBeNull();
  });

  it("rejects non-finite values rather than emitting NaN vectors", () => {
    expect(
      normalizeEmbeddingsResponse({ data: [{ index: 0, embedding: [1, NaN] }] }),
    ).toBeNull();
  });
});
