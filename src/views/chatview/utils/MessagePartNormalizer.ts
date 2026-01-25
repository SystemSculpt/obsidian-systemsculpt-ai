import { ChatMessage, MessagePart, MultiPartContent } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";

/**
 * MessagePartNormalizer – central helper to turn any ChatMessage shape (legacy or current)
 * into a chronologically-sorted MessagePart[] array.
 */
export class MessagePartNormalizer {
  /** Returns a chronologically sorted parts array for the given message. */
  public static toParts(message: ChatMessage): MessagePart[] {
    const parts: MessagePart[] = [];
    let timestamp = 0;

    // Already normalized
    if (message.messageParts && message.messageParts.length > 0) {
      return [...message.messageParts].sort((a, b) => a.timestamp - b.timestamp);
    }

    // Reasoning first (matches streaming order)
    if (message.reasoning) {
      parts.push({
        id: `reasoning-${timestamp}`,
        type: "reasoning",
        timestamp: timestamp++,
        data: message.reasoning,
      });
    }

    // Tool calls next (legacy messages store them separately)
    if (message.tool_calls && message.tool_calls.length > 0) {
      message.tool_calls.forEach((tc: ToolCall) => {
        parts.push({
          id: `tool_call_part-${tc.id}`,
          type: "tool_call",
          timestamp: timestamp++,
          data: tc,
        });
      });
    }

    // Content last
    if (typeof message.content === "string" && message.content.trim()) {
      parts.push({
        id: `content-${timestamp}`,
        type: "content",
        timestamp: timestamp++,
        data: message.content as string | MultiPartContent[],
      });
    }

    return parts;
  }
} 