export function buildVectorId(namespace: string, path: string, chunkId: number): string {
  return `${namespace}::${path}#${chunkId}`;
}

