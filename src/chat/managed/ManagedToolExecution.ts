/**
 * Server-owned managed tools never have a client-owned result row. The
 * execution marker is authoritative for current transcripts, while the tool
 * name fallback keeps older or imported saved chats safe after reload.
 */
const SERVER_EXECUTED_MANAGED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
]);

export type ManagedToolCallFunction = Readonly<{
  name: string;
  arguments: string;
}>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function argumentsJson(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return null;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function toolCallFunctionRecord(record: Record<string, unknown>): Record<string, unknown> {
  const request = recordValue(record.request);
  return recordValue(request?.function) ?? recordValue(record.function) ?? record;
}

function toolCallFunctionName(fn: Record<string, unknown>): string | null {
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  return name || null;
}

/**
 * Reads current, older nested, and oldest flat persisted tool-call shapes
 * without making every historical consumer duplicate unsafe property access.
 */
export function readManagedToolCallFunction(call: unknown): ManagedToolCallFunction | null {
  const record = recordValue(call);
  if (!record) return null;
  const fn = toolCallFunctionRecord(record);
  const name = toolCallFunctionName(fn);
  if (!name) return null;
  const normalizedArguments = argumentsJson(fn.arguments);
  if (normalizedArguments === null) return null;
  return {
    name,
    arguments: normalizedArguments,
  };
}

export function isServerExecutedManagedToolName(name: unknown): boolean {
  return typeof name === "string" && SERVER_EXECUTED_MANAGED_TOOL_NAMES.has(name);
}

export function isServerExecutedManagedToolCall(call: unknown): boolean {
  const record = recordValue(call);
  if (!record) return false;
  return record.executedOn === "server"
    || isServerExecutedManagedToolName(toolCallFunctionName(toolCallFunctionRecord(record)));
}
