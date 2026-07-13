import type { ChatMessage, MultiPartContent } from "../../types";
import { parseAttachedTextContent } from "./attachments/ChatAttachmentContent";

export type PresentedMessageAttachment = Readonly<{
  kind: "file" | "image";
  label: string;
  mimeType?: string;
  url?: string;
  unavailable?: boolean;
}>;

export type PresentedMessageContent = Readonly<{
  markdown: string;
  attachments: readonly PresentedMessageAttachment[];
}>;

function presentPart(part: MultiPartContent, imageIndex: number): Readonly<{
  markdown?: string;
  attachment?: PresentedMessageAttachment;
}> {
  if (part.type === "image_url") {
    return {
      attachment: {
        kind: "image",
        label: `Attached image ${imageIndex + 1}`,
        url: part.image_url.url,
      },
    };
  }

  const attached = parseAttachedTextContent(part.text);
  if (attached) {
    return {
      attachment: {
        kind: "file",
        label: attached.name,
        mimeType: attached.mimeType,
        ...(attached.unavailable ? { unavailable: true } : {}),
      },
    };
  }
  return { markdown: part.text };
}

/**
 * Converts durable model content into the small visual interface used by chat.
 * Attached file payloads stay in the model request without flooding the user
 * bubble; images remain visible after the chat is reloaded.
 */
export function presentMessageContent(content: ChatMessage["content"]): PresentedMessageContent {
  if (typeof content === "string") return { markdown: content, attachments: [] };
  if (!Array.isArray(content)) return { markdown: "", attachments: [] };

  const markdown: string[] = [];
  const attachments: PresentedMessageAttachment[] = [];
  let imageIndex = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const presented = presentPart(part, imageIndex);
    if (presented.markdown?.trim()) markdown.push(presented.markdown);
    if (presented.attachment) {
      attachments.push(presented.attachment);
      if (presented.attachment.kind === "image") imageIndex += 1;
    }
  }
  return { markdown: markdown.join("\n\n"), attachments };
}
