export type PiToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type ToolFunctionDefinition = {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizePiToolName(rawName: unknown): string {
  let name = asString(rawName).trim();
  if (!name) return "";

  while (name.startsWith("functions.")) {
    name = name.slice("functions.".length);
  }

  if (!name.includes(":")) {
    return name;
  }

  const parts = name
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];

  const mcpToolName = parts.find((part) => /^mcp[-_]/i.test(part));
  if (mcpToolName) {
    return mcpToolName;
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const firstLooksLikeNamespace = /(^|[_-])api$/i.test(first) || /^default_api$/i.test(first);
  const lastLooksLikeProviderSuffix = /^\d+[_-]/.test(last) || /^[a-z]+_[a-z0-9]+$/i.test(last);

  if (firstLooksLikeNamespace) {
    return last;
  }

  if (lastLooksLikeProviderSuffix) {
    return first;
  }

  return first;
}

export function normalizePiTools(tools: unknown[]): PiToolDefinition[] {
  const normalized: PiToolDefinition[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const maybeFunction = (record.function && typeof record.function === "object"
      ? (record.function as ToolFunctionDefinition)
      : undefined);

    const name = sanitizePiToolName(maybeFunction?.name ?? record.name);
    if (!name) continue;

    const parameters = (maybeFunction?.parameters ?? record.parameters) as unknown;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      continue;
    }

    normalized.push({
      name,
      description: asString(maybeFunction?.description ?? record.description),
      parameters: parameters as Record<string, unknown>,
    });
  }

  return normalized;
}
