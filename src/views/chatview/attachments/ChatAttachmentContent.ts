import type { MultiPartContent } from "../../../types";

const ATTACHED_TEXT_FILE = /^--- BEGIN ATTACHED FILE: (.+?) \((.+?)\) ---\n([\s\S]*)\n--- END ATTACHED FILE: \1 ---$/;
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
const CHAT_ATTACHMENT_UNAVAILABLE_SENTINEL = "[[SYSTEMSCULPT_ATTACHMENT_UNAVAILABLE]]";

export type ParsedAttachedTextPart = Readonly<{
  name: string;
  mimeType: string;
  body: string;
  unavailable: boolean;
}>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function createAttachedTextContent(name: string, mimeType: string, body: string): string {
  return [
    `--- BEGIN ATTACHED FILE: ${name} (${mimeType}) ---`,
    body,
    `--- END ATTACHED FILE: ${name} ---`,
  ].join("\n");
}

export function parseAttachedTextContent(text: string): ParsedAttachedTextPart | null {
  const match = text.match(ATTACHED_TEXT_FILE);
  if (!match) return null;
  return Object.freeze({
    name: match[1],
    mimeType: match[2],
    body: match[3],
    unavailable: match[3].trim() === CHAT_ATTACHMENT_UNAVAILABLE_SENTINEL,
  });
}

export function createTextAttachmentPart(name: string, mimeType: string, bytes: Uint8Array): MultiPartContent {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  return Object.freeze({
    type: "text" as const,
    text: createAttachedTextContent(name, mimeType, decoded),
  });
}

export function createUnavailableAttachmentPart(name: string, mimeType: string): MultiPartContent {
  return Object.freeze({
    type: "text" as const,
    text: createAttachedTextContent(name, mimeType, CHAT_ATTACHMENT_UNAVAILABLE_SENTINEL),
  });
}

export function createImageAttachmentPart(mimeType: string, bytes: Uint8Array): MultiPartContent {
  return Object.freeze({
    type: "image_url" as const,
    image_url: Object.freeze({ url: `data:${mimeType};base64,${bytesToBase64(bytes)}` }),
  });
}

export function parseImageDataUrl(url: string): Readonly<{ mimeType: string; bytes: Uint8Array }> | null {
  const match = url.match(DATA_IMAGE);
  const bytes = match ? base64ToBytes(match[2]) : null;
  if (!match || !bytes) return null;
  return Object.freeze({ mimeType: match[1], bytes });
}

export function attachmentPartPayloadBytes(part: MultiPartContent): Uint8Array | null {
  if (part.type === "image_url") {
    return parseImageDataUrl(part.image_url.url)?.bytes ?? null;
  }
  return new TextEncoder().encode(part.text);
}
