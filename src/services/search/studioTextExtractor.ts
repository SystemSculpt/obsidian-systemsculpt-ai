type UnknownRecord = Record<string, unknown>;

const MAX_VISITED_VALUES = 20_000;
const MAX_CONFIG_DEPTH = 16;
const CONFIG_METADATA_KEYS = new Set([
  "id", "kind", "schema", "version", "type", "nodeId", "parentId", "runId", "threadId",
  "createdAt", "updatedAt", "outputs", "runs", "artifacts",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract authored canvas content without indexing the saved document's machinery. */
export function extractStudioText(raw: string, options: { maxChars: number }): string {
  const maxChars = Math.floor(options.maxChars);
  if (typeof raw !== "string" || !raw || !Number.isFinite(maxChars) || maxChars <= 0) return "";

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!isRecord(document)) return "";
  if (document.schema !== "studio.project.v1" && document.schema !== "studio.project.v2") return "";

  let output = "";
  let visited = 0;
  const exhausted = () => output.length >= maxChars || visited >= MAX_VISITED_VALUES;
  const append = (value: unknown) => {
    if (exhausted() || typeof value !== "string") return;
    const text = value.trim();
    if (!text) return;
    const separator = output ? "\n" : "";
    const remaining = maxChars - output.length - separator.length;
    if (remaining <= 0) return;
    output += separator + text.slice(0, remaining);
  };
  const visitConfig = (value: unknown, depth = 0): void => {
    if (exhausted() || depth > MAX_CONFIG_DEPTH) return;
    visited += 1;
    if (typeof value === "string") {
      append(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (exhausted()) break;
        visitConfig(item, depth + 1);
      }
    } else if (isRecord(value)) {
      for (const key in value) {
        if (exhausted()) break;
        // Config is extensible, but internal presentation state and persisted
        // execution records must not make unrelated searches match a project.
        if (key.startsWith("__studio_") || CONFIG_METADATA_KEYS.has(key)) {
          visited += 1;
          continue;
        }
        visitConfig(value[key], depth + 1);
      }
    }
  };
  const visitItems = (items: unknown, visit: (item: UnknownRecord) => void) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (exhausted()) break;
      visited += 1;
      if (isRecord(item)) visit(item);
    }
  };

  append(document.name);
  // These are the authored fields of the v1 model and v2 serializer. Do not
  // fall back to walking the document: edges, IDs, policies and runs are noise.
  const canvas = document.schema === "studio.project.v2" ? document.canvas : document.graph;
  const diagram = document.schema === "studio.project.v2" ? document.canvas : document.diagram;
  if (isRecord(canvas)) {
    visitItems(canvas.nodes, (node) => {
      append(node.title);
      if (isRecord(node.config)) visitConfig(node.config);
    });
    visitItems(canvas.groups, (group) => append(group.name));
  }
  if (isRecord(diagram)) {
    visitItems(diagram.shapes, (shape) => append(shape.label));
    visitItems(diagram.arrows, (arrow) => append(arrow.label));
  }
  return output;
}
