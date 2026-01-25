import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_SCHEMA_VERSION } from '../../../constants/embeddings';

export interface ParsedNamespace {
  provider: string;
  model: string;
  schema: number;
  dimension: number | null;
}

function escapeNamespaceComponent(value: string): string {
  // Namespace segments are ":"-delimited. Some model IDs (e.g. Ollama "nomic-embed-text:latest")
  // contain ":" which breaks parsing and causes perpetual re-embedding. Escape only what we need.
  return String(value).replace(/%/g, "%25").replace(/:/g, "%3A");
}

function unescapeNamespaceComponent(value: string): string {
  return String(value).replace(/%3A/gi, ":").replace(/%25/gi, "%");
}

/**
 * Normalize model identifiers so equivalent models share a single canonical namespace.
 * This prevents unnecessary re-embedding when we have only renamed the model id string.
 */
export function normalizeModelForNamespace(providerId: string, model: string): string {
  const provider = String(providerId || "").trim();
  const rawModel = String(model || "").trim();
  if (!rawModel) return "unknown";
  if (provider !== "systemsculpt") return rawModel;

  const lower = rawModel.toLowerCase();
  const canonical = DEFAULT_EMBEDDING_MODEL;
  if (lower === canonical.toLowerCase()) return canonical;

  // Legacy/alternate IDs for the same underlying embedding model.
  if (lower === "openai/text-embedding-3-small") return canonical;
  if (lower === "text-embedding-3-small") return canonical;

  return rawModel;
}

/**
 * Parse namespace strings of the form:
 * - `${providerId}:${model}:v${schema}`
 * - `${providerId}:${model}:v${schema}:${dimension}`
 */
export function parseNamespace(namespace: string | undefined | null): ParsedNamespace | null {
  if (!namespace || typeof namespace !== "string") return null;
  const raw = namespace;

  // Fast-path for canonical (escaped) namespaces: provider:model:v{schema}:{dimension?}
  const parts = raw.split(":");
  if (parts.length >= 3) {
    const rawSchema = parts[2] || "";
    if (rawSchema.startsWith("v")) {
      const schema = parseInt(rawSchema.slice(1), 10);
      if (!Number.isFinite(schema) || schema < 0) return null;

      const provider = unescapeNamespaceComponent(parts[0] || "unknown");
      const model = unescapeNamespaceComponent(parts[1] || "unknown");

      let dimension: number | null = null;
      if (parts.length >= 4) {
        const dim = parseInt(parts[3], 10);
        dimension = Number.isFinite(dim) && dim > 0 ? dim : null;
      }

      return { provider, model, schema, dimension };
    }
  }

  // Legacy tolerance: allow ":" inside the model segment (e.g. Ollama "nomic-embed-text:latest")
  // by parsing from the right on the ":v{schema}" marker.
  const legacyMatch = raw.match(/^([^:]+):(.+):v(\d+)(?::(\d+))?$/);
  if (!legacyMatch) return null;

  const schema = parseInt(legacyMatch[3] || "", 10);
  if (!Number.isFinite(schema) || schema < 0) return null;

  const provider = unescapeNamespaceComponent(legacyMatch[1] || "unknown");
  const model = unescapeNamespaceComponent(legacyMatch[2] || "unknown");

  let dimension: number | null = null;
  if (legacyMatch[4]) {
    const dim = parseInt(legacyMatch[4], 10);
    dimension = Number.isFinite(dim) && dim > 0 ? dim : null;
  }

  return { provider, model, schema, dimension };
}

/**
 * Build the full namespace string used to scope embeddings by
 * provider, model, client schema version, and vector dimensionality.
 * Format: `${providerId}:${model}:v${schema}:${dimension}`
 */
export function buildNamespace(providerId: string, model: string, dimension: number): string {
  return buildNamespaceWithSchema(providerId, model, EMBEDDING_SCHEMA_VERSION, dimension);
}

export function buildNamespaceWithSchema(
  providerId: string,
  model: string,
  schemaVersion: number,
  dimension: number
): string {
  const rawProvider = String(providerId || 'unknown');
  const safeProvider = escapeNamespaceComponent(rawProvider);
  const safeModel = escapeNamespaceComponent(normalizeModelForNamespace(rawProvider, model));
  const schema = Number.isFinite(schemaVersion) && schemaVersion >= 0 ? schemaVersion : 0;
  const dim = typeof dimension === 'number' && dimension > 0 ? dimension : 0;
  return `${safeProvider}:${safeModel}:v${schema}:${dim}`;
}

/**
 * Build the namespace prefix used for quick filtering without knowing dimension.
 * Format: `${providerId}:${model}:v${schema}:`
 */
export function buildNamespacePrefix(providerId: string, model: string): string {
  const rawProvider = String(providerId || 'unknown');
  const safeProvider = escapeNamespaceComponent(rawProvider);
  const safeModel = escapeNamespaceComponent(normalizeModelForNamespace(rawProvider, model));
  return `${safeProvider}:${safeModel}:v${EMBEDDING_SCHEMA_VERSION}:`;
}

/**
 * Extract the dimension component from a namespace string.
 * Returns null when parsing fails.
 */
export function parseNamespaceDimension(namespace: string | undefined | null): number | null {
  return parseNamespace(namespace)?.dimension ?? null;
}

/**
 * Check if a given namespace string matches the current schema version
 * for the specified provider/model. Optionally require an exact
 * dimension match when expectedDimension is provided.
 */
export function namespaceMatchesCurrentVersion(
  namespace: string | undefined | null,
  providerId: string,
  model: string,
  expectedDimension?: number
): boolean {
  if (!namespace || typeof namespace !== 'string') return false;
  const prefix = buildNamespacePrefix(providerId, model);
  if (!namespace.startsWith(prefix)) return false;
  if (typeof expectedDimension !== 'number' || expectedDimension <= 0) return true;
  const dim = parseNamespaceDimension(namespace);
  return dim === expectedDimension;
}
