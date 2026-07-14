import type { ChatMessage, MultiPartContent } from "../../types";
import { parseAttachedTextContent } from "./attachments/ChatAttachmentContent";
import { isChatAttachmentReferencePlaceholder } from "./attachments/ChatAttachmentVaultStore";

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

/**
 * Presents a durable message without requiring reference-backed attachment
 * bytes. Metadata supplies the compact file chips; an already-hydrated image
 * part contributes its preview URL only when those bytes were needed anyway.
 */
export function presentChatMessage(message: Readonly<ChatMessage>): PresentedMessageContent {
  const content = presentMessageContent(message.content);
  if (!message.attachmentMetadata?.length) return content;

  const parts = Array.isArray(message.content) ? message.content : [];
  const attachments = [...message.attachmentMetadata]
    .sort((left, right) => left.contentPartIndex - right.contentPartIndex)
    .map((metadata): PresentedMessageAttachment => {
      const part = parts[metadata.contentPartIndex];
      const attachedText = part?.type === "text" ? parseAttachedTextContent(part.text) : null;
      return {
        kind: metadata.kind === "image" ? "image" : "file",
        label: metadata.name,
        mimeType: metadata.mimeType,
        ...(metadata.kind === "image"
          && part?.type === "image_url"
          && !isChatAttachmentReferencePlaceholder(part)
          ? { url: part.image_url.url }
          : {}),
        ...(attachedText?.unavailable ? { unavailable: true } : {}),
      };
    });

  return { markdown: content.markdown, attachments };
}
