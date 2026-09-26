import type { ToolCallResult } from "../../types/toolCalls";

/*
 * Saved chats keep a bounded summary of each tool result; the server holds
 * the full result. History only presents a result's outcome, its error, item
 * outcomes and the paths behind artifact links, so structure and short values
 * are kept while long text (a read note's whole content, search snippets) is
 * cut. Lists keep every entry a batch can produce, so history still counts
 * each item's outcome; only longer lists keep their head.
 */
export const DURABLE_TOOL_TEXT_LIMIT = 512;
/** Twice the most operations a vault batch tool accepts (100). */
export const DURABLE_TOOL_LIST_LIMIT = 200;
const DURABLE_TOOL_DEPTH_LIMIT = 6;
const OMITTED_VALUE = "[omitted]";

function boundedText(value: string): string {
  if (value.length <= DURABLE_TOOL_TEXT_LIMIT) return value;
  let end = DURABLE_TOOL_TEXT_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}… [${value.length - end} more characters]`;
}

function boundedValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return boundedText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= DURABLE_TOOL_DEPTH_LIMIT) return OMITTED_VALUE;
  if (Array.isArray(value)) {
    return value
      .slice(0, DURABLE_TOOL_LIST_LIMIT)
      .map((entry) => boundedValue(entry, depth + 1));
  }
  const bounded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    bounded[key] = boundedValue(entry, depth + 1);
  }
  return bounded;
}

/** A new, bounded copy of a tool result for the saved chat transcript. */
export function durableToolResult(result: ToolCallResult): ToolCallResult {
  return {
    success: result.success,
    ...(result.data === undefined ? {} : { data: boundedValue(result.data, 0) }),
    ...(result.error
      ? {
          error: {
            code: String(result.error.code),
            message: boundedText(String(result.error.message)),
            ...(result.error.details === undefined
              ? {}
              : { details: boundedValue(result.error.details, 0) }),
          },
        }
      : {}),
  };
}
