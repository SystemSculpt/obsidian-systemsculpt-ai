import type { ChatMessage, MessagePart, MultiPartContent } from "../../../types";

/** Projects a managed message into its canonical chronological parts. */
export class MessagePartNormalizer {
  /** Returns a chronologically sorted parts array for the given message. */
  public static toParts(message: ChatMessage): MessagePart[] {
    if (message.messageParts && message.messageParts.length > 0) {
      return [...message.messageParts].sort((a, b) => a.timestamp - b.timestamp);
    }

    const content = message.content;
    const hasContent = typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
    return hasContent
      ? [{
        id: "content-0",
        type: "content",
        timestamp: 0,
        data: content as string | MultiPartContent[],
      }]
      : [];
  }
}
