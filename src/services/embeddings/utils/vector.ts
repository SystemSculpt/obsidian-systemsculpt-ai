export function normalizeInPlace(vector: Float32Array): boolean {
  if (vector.length === 0) return false;
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    sumSq += v * v;
  }
  if (!Number.isFinite(sumSq) || sumSq <= 0) return false;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i] * inv;
  }
  return true;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

