/**
 * Symmetric int8 quantization with one scale per vector.
 *
 * value ≈ code × scale, with scale = max|value| / 127. For unit-length
 * embeddings this keeps cosine error around 1e-3 at a quarter of Float32's
 * size and half of fp16's, which is why both the portable snapshot and the
 * in-memory search matrix use it.
 */

const INT8_LIMIT = 127;

/** Quantize `vector` into `codes` starting at `offset`; returns the scale. */
export function quantizeInt8Into(vector: Float32Array, codes: Int8Array, offset: number): number {
  let max = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const magnitude = Math.abs(vector[index]);
    if (magnitude > max) max = magnitude;
  }
  const scale = Math.fround(max / INT8_LIMIT);
  if (!(scale > 0) || !Number.isFinite(scale)) {
    codes.fill(0, offset, offset + vector.length);
    return 0;
  }
  const inverse = 1 / scale;
  for (let index = 0; index < vector.length; index += 1) {
    const code = Math.round(vector[index] * inverse);
    codes[offset + index] = code > INT8_LIMIT ? INT8_LIMIT : code < -INT8_LIMIT ? -INT8_LIMIT : code;
  }
  return scale;
}

/**
 * Rebuild a unit-length vector from its codes. Returns null for a zero or
 * non-finite vector, which cannot be a valid embedding.
 */
export function dequantizeInt8(codes: Int8Array, offset: number, dimensions: number, scale: number): Float32Array | null {
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const vector = new Float32Array(dimensions);
  let sumSquares = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = codes[offset + index] * scale;
    vector[index] = value;
    sumSquares += value * value;
  }
  if (!(sumSquares > 0) || !Number.isFinite(sumSquares)) return null;
  const inverseNorm = 1 / Math.sqrt(sumSquares);
  for (let index = 0; index < dimensions; index += 1) vector[index] *= inverseNorm;
  return vector;
}
