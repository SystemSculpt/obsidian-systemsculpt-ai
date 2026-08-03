import type { ChatMessage } from "../../../types";
import {
  parseAttachedTextContent,
  parseImageDataUrl,
} from "../attachments/ChatAttachmentContent";
import type {
  AgentUserMessage,
  AgentUserMessagePart,
} from "./Protocol";

function imageMediaTypeFromDataUrl(url: string): string {
  const parsed = parseImageDataUrl(url);
  if (!parsed || parsed.bytes.byteLength < 1) {
    throw new Error("An attached image is malformed.");
  }
  return parsed.mimeType;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.byteLength),
    ));
  }
  return btoa(binary);
}

export function thinAgentDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

export function toThinAgentUserMessage(
  message: Readonly<ChatMessage>,
): AgentUserMessage {
  if (message.role !== "user") {
    throw new Error("Only a newly admitted user message can start a response.");
  }
  const parts: AgentUserMessagePart[] = [];
  const attachmentsByIndex = new Map(
    (message.attachmentMetadata ?? []).map((attachment) => [
      attachment.contentPartIndex,
      attachment,
    ] as const),
  );
  if (typeof message.content === "string") {
    if (message.content) parts.push({ type: "text", text: message.content });
  } else {
    for (const [index, part] of (message.content ?? []).entries()) {
      const attachment = attachmentsByIndex.get(index);
      if (part.type === "text") {
        const parsed = attachment ? parseAttachedTextContent(part.text) : null;
        if (attachment && parsed && !parsed.unavailable) {
          parts.push({
            type: "file",
            filename: attachment.kind === "document"
              ? `${attachment.name}.extracted.md`
              : attachment.name,
            mediaType: parsed.mimeType,
            url: thinAgentDataUrl(
              parsed.mimeType,
              new TextEncoder().encode(
                attachment.kind === "document" ? part.text : parsed.body,
              ),
            ),
          });
        } else if (part.text) {
          parts.push({ type: "text", text: part.text });
        }
      } else {
        parts.push({
          type: "file",
          ...(attachment?.name ? { filename: attachment.name } : {}),
          mediaType: imageMediaTypeFromDataUrl(part.image_url.url),
          url: part.image_url.url,
        });
      }
    }
  }
  if (parts.length === 0) {
    throw new Error("A message needs text or an attachment.");
  }
  return { id: message.message_id, role: "user", parts };
}
