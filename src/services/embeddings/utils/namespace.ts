export const MANAGED_EMBEDDING_FAMILY_PREFIX = "systemsculpt:managed:" as const;

const MANAGED_NAMESPACE_PATTERN =
  /^systemsculpt:managed:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):v([1-9]\d*):([1-9]\d*)$/;
const MAX_SCHEMA_VERSION = 1_000_000;
const MAX_DIMENSIONS = 8_192;

export type ManagedNamespaceIdentity = Readonly<{
  generationId: string;
  indexSchemaVersion: number;
  dimensions: number;
}>;

export function parseManagedNamespace(
  namespace: string | null | undefined,
): ManagedNamespaceIdentity | null {
  if (typeof namespace !== "string") return null;
  const match = namespace.match(MANAGED_NAMESPACE_PATTERN);
  if (!match) return null;
  const indexSchemaVersion = Number(match[2]);
  const dimensions = Number(match[3]);
  if (
    !Number.isSafeInteger(indexSchemaVersion)
    || indexSchemaVersion < 1
    || indexSchemaVersion > MAX_SCHEMA_VERSION
    || !Number.isSafeInteger(dimensions)
    || dimensions < 1
    || dimensions > MAX_DIMENSIONS
  ) {
    return null;
  }
  return {
    generationId: match[1],
    indexSchemaVersion,
    dimensions,
  };
}

export function isManagedNamespace(namespace: string | null | undefined): boolean {
  return parseManagedNamespace(namespace) !== null;
}

export function parseNamespaceDimension(namespace: string | undefined | null): number | null {
  return parseManagedNamespace(namespace)?.dimensions ?? null;
}
