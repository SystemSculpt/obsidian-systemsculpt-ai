import type { MessagePart } from "../../../types";

/**
 * Merge consecutive reasoning parts into a single reasoning chain.
 *
 * This is intentionally conservative: only adjacent reasoning parts are merged.
 * If a reasoning block is separated by tool calls or content, it stays separate.
 */
export function mergeAdjacentReasoningParts(parts: MessagePart[]): MessagePart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    return [];
  }

  const merged: MessagePart[] = [];

  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous?.type === "reasoning" && part.type === "reasoning") {
      merged[merged.length - 1] = {
        id: previous.id,
        type: "reasoning",
        timestamp: Math.max(previous.timestamp, part.timestamp),
        data: previous.data + part.data,
      };
      continue;
    }

    merged.push(part);
  }

  return merged;
}

