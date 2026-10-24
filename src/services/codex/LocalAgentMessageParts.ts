import { createTextAttachmentPart } from "../../chat/ChatAttachmentContent";
import { base64ToBytes } from "../../utils/base64";

type LocalAgentMessagePart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "file"; mediaType: string; url: string; filename?: string }>;

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "application/x-yaml",
]);

function textFileBytes(part: Extract<LocalAgentMessagePart, { type: "file" }>): Uint8Array | null {
  const mediaType = part.mediaType.toLowerCase();
  if (!mediaType.startsWith("text/") && !TEXT_APPLICATION_TYPES.has(mediaType)) return null;
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix)) return null;
  try {
    return base64ToBytes(part.url.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * The prompt text for one user message part sent to an on-machine agent.
 * Images ride beside the prompt; attached notes and text files are written
 * into it under their name (a vault path for vault notes), the same framing
 * hosted chat uses.
 */
export function localAgentPromptText(part: LocalAgentMessagePart, images: string[], agentName: string): string {
  if (part.type === "text") return part.text;
  if (part.mediaType.startsWith("image/")) {
    images.push(part.url);
    return "";
  }
  const bytes = textFileBytes(part);
  if (bytes) {
    const attached = createTextAttachmentPart(part.filename ?? "attachment", part.mediaType, bytes);
    if (attached.type === "text") return attached.text;
  }
  throw new Error(`This attachment must be converted to text or an image before sending it to ${agentName}.`);
}
