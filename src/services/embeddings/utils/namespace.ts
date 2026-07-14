export const MANAGED_EMBEDDING_GENERATION = "semantic-v1" as const;
export const MANAGED_EMBEDDING_FAMILY_PREFIX = "systemsculpt:managed:" as const;
export const MANAGED_EMBEDDING_NAMESPACE_PREFIX =
  "systemsculpt:managed:semantic-v1:v2:" as const;
const MANAGED_NAMESPACE_PATTERN =
  /^systemsculpt:managed:semantic-v1:v2:([1-9]\d*)$/;

export function buildManagedNamespace(
  dimension: number,
): `systemsculpt:managed:semantic-v1:v2:${number}` {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error("Managed embedding dimension must be a positive integer.");
  }
  return `${MANAGED_EMBEDDING_NAMESPACE_PREFIX}${dimension}`;
}

export function isManagedNamespace(namespace: string | null | undefined): boolean {
  return typeof namespace === "string" && MANAGED_NAMESPACE_PATTERN.test(namespace);
}

export function parseNamespaceDimension(namespace: string | undefined | null): number | null {
  if (typeof namespace !== "string") return null;
  const match = namespace.match(MANAGED_NAMESPACE_PATTERN);
  if (!match) return null;
  const dimension = Number(match[1]);
  return Number.isSafeInteger(dimension) && dimension > 0 ? dimension : null;
}
