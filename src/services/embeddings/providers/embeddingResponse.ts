/**
 * embeddingResponse - a single, robust normalizer for the many shapes that
 * OpenAI-compatible (and not-quite-compatible) embedding endpoints return.
 *
 * Different servers wrap embeddings differently, and the divergence is the root
 * cause of #153 (LM Studio "Unsupported response format"): LM Studio's
 * `/v1/embeddings` can answer with a top-level `{ embedding: [...] }` /
 * `{ embeddings: [...] }` instead of OpenAI's `{ data: [{ embedding }] }`, and
 * the old inline parser only recognized the `data[]` and raw-2D-array shapes.
 *
 * Centralizing the shape handling here (pure, no I/O) means every provider gets
 * the same coverage and new shapes are added in one tested place rather than
 * re-discovered per endpoint.
 *
 * Returns a 2D number array (one vector per input, in order) or `null` when the
 * payload matches no known shape — the caller turns `null` into a typed
 * UNEXPECTED_RESPONSE error so the failure is classifiable rather than silent.
 */

/** True when `value` is a non-empty array whose every element is a finite number. */
function isNumberVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** Extract the `data: [{ embedding, index }]` (OpenAI / LM Studio batch) shape. */
function fromOpenAiList(data: Record<string, unknown>): number[][] | null {
  const list = data.data;
  if (!Array.isArray(list) || list.length === 0) return null;

  const items = list as Array<Record<string, unknown>>;
  // Only trust `index` for ordering when every item carries a numeric one;
  // some servers omit it, and a partial sort would scramble the results.
  const allIndexed = items.every((item) => typeof item.index === "number");
  const ordered = allIndexed
    ? [...items].sort((a, b) => (a.index as number) - (b.index as number))
    : items;

  const vectors: number[][] = [];
  for (const item of ordered) {
    if (!isNumberVector(item.embedding)) return null;
    vectors.push(item.embedding);
  }
  return vectors;
}

/**
 * Normalize an embeddings response body into a 2D array of vectors, or `null`
 * when the shape is unrecognized. Handles, in order:
 *  - OpenAI / LM Studio batch:   `{ data: [{ embedding, index }] }`
 *  - top-level plural:           `{ embeddings: [[...], ...] }`
 *  - top-level singular:         `{ embedding: [...] }`              (LM Studio / Ollama single)
 *  - raw 2D array:               `[[...], [...]]`
 *  - raw single vector:          `[...]`
 */
export function normalizeEmbeddingsResponse(data: unknown): number[][] | null {
  if (data == null) return null;

  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    const fromList = fromOpenAiList(obj);
    if (fromList) return fromList;

    // `{ embeddings: [[...]] }` — plural top-level (some OpenAI-compatible
    // servers, and the SystemSculpt managed contract).
    if (Array.isArray(obj.embeddings)) {
      const rows = obj.embeddings as unknown[];
      if (rows.length > 0 && rows.every(isNumberVector)) return rows as number[][];
      return null;
    }

    // `{ embedding: [...] }` — singular top-level (LM Studio / Ollama single
    // input). This is the shape the old parser missed -> #153.
    if (isNumberVector(obj.embedding)) return [obj.embedding];

    return null;
  }

  if (Array.isArray(data)) {
    // Raw 2D array: `[[...], [...]]`.
    if (data.length > 0 && data.every(isNumberVector)) return data as number[][];
    // Raw single vector: `[...]` of numbers.
    if (isNumberVector(data)) return [data];
    return null;
  }

  return null;
}
