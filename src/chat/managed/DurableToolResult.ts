import { MAX_BATCH_OPERATIONS } from "../../tools/vault/constants";
import type { ChatMessage } from "../../types";
import type { ToolCall, ToolCallResult } from "../../types/toolCalls";

/*
 * Saved chats keep a bounded summary of each tool result; the server holds
 * the full result. History only presents a result's outcome, its error, item
 * outcomes and the paths behind artifact links, so structure and short values
 * are kept while long text (a read note's whole content, search snippets) is
 * cut. Lists keep every entry a batch can produce, so history still counts
 * each item's outcome; only longer lists keep their head.
 *
 * Bounding is idempotent: a bounded result bounds to itself, so a result read
 * back from a saved chat compares equal to the server's bounded copy.
 */
export const DURABLE_TOOL_TEXT_LIMIT = 512;
/** Twice the most operations a vault batch tool accepts. */
export const DURABLE_TOOL_LIST_LIMIT = 2 * MAX_BATCH_OPERATIONS;
const DURABLE_TOOL_DEPTH_LIMIT = 6;
const OMITTED_VALUE = "[omitted]";

function omittedMarker(omitted: number): string {
  return `… [${omitted} more characters]`;
}

/**
 * Long text keeps its head and says how much was cut. The marker counts
 * toward the limit, so bounded text is never cut again.
 */
function boundedText(value: string): string {
  if (value.length <= DURABLE_TOOL_TEXT_LIMIT) return value;
  // The marker for the whole length is at least as long as the final one.
  let end = DURABLE_TOOL_TEXT_LIMIT - omittedMarker(value.length).length;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${omittedMarker(value.length - end)}`;
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

/**
 * `message` with each tool result in its saved, bounded form. A message
 * without tool calls is returned as is, and a call listed both in
 * `tool_calls` and in a message part stays one shared object.
 */
export function withDurableToolResults(message: ChatMessage): ChatMessage {
  const parts = message.messageParts;
  if (!message.tool_calls?.length && !parts?.some((part) => part.type === "tool_call")) {
    return message;
  }
  const bounded = new Map<ToolCall, ToolCall>();
  const durable = (call: ToolCall): ToolCall => {
    let copy = bounded.get(call);
    if (!copy) {
      copy = call.result && typeof call.result === "object"
        ? { ...call, result: durableToolResult(call.result) }
        : call;
      bounded.set(call, copy);
    }
    return copy;
  };
  return {
    ...message,
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(durable) } : {}),
    ...(parts
      ? {
          messageParts: parts.map((part) => part.type === "tool_call"
            ? { ...part, data: durable(part.data) }
            : part),
        }
      : {}),
  };
}
