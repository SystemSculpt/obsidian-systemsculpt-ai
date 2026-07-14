import { extractPrimaryPathArg, splitToolName } from "./toolPolicy";

const ARTIFACT_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multi_edit",
  "move",
  "open",
]);

function collectNestedPaths(
  value: unknown,
  paths: Set<string>,
  maxPaths: number,
  depth = 0,
): void {
  if (depth > 5 || paths.size >= maxPaths || value === null || typeof value === "undefined") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNestedPaths(item, paths, maxPaths, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "destination"] as const) {
    const path = record[key];
    if (typeof path === "string" && path.trim()) paths.add(path.trim());
    if (paths.size >= maxPaths) return;
  }
  for (const nested of Object.values(record)) {
    collectNestedPaths(nested, paths, maxPaths, depth + 1);
    if (paths.size >= maxPaths) return;
  }
}

/** Return the bounded set of vault files created, read, edited, moved, or opened by a tool. */
export function collectToolArtifactPaths(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  maxPaths = 20,
): string[] {
  const canonicalName = splitToolName(toolName).canonicalName;
  if (!ARTIFACT_TOOLS.has(canonicalName)) return [];
  const paths = new Set<string>();
  const primary = extractPrimaryPathArg(toolName, input);
  if (primary) paths.add(primary);
  collectNestedPaths(input, paths, maxPaths);
  collectNestedPaths(result, paths, maxPaths);
  return [...paths].slice(0, maxPaths);
}

/** Return only files that a mixed-result tool explicitly reports as successful. */
export function collectSuccessfulToolArtifactPaths(
  toolName: string,
  result: unknown,
  maxPaths = 20,
): string[] {
  const canonicalName = splitToolName(toolName).canonicalName;
  if (!ARTIFACT_TOOLS.has(canonicalName) || !result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() && paths.size < maxPaths) paths.add(value.trim());
  };
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entry = value as Record<string, unknown>;
    if (entry.success === false || typeof entry.error !== "undefined") return;
    add(canonicalName === "move" ? entry.destination ?? entry.path : entry.path ?? entry.destination);
  };
  for (const key of ["results", "files"] as const) {
    const entries = record[key];
    if (Array.isArray(entries)) entries.forEach(inspect);
  }
  if (Array.isArray(record.opened)) record.opened.forEach(add);
  return [...paths];
}
