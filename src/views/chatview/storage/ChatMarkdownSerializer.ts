import {
  ChatMessage,
  MessagePart,
  ChatRole,
  MultiPartContent,
  type ChatAttachmentMetadata,
} from "../../../types";
import { parseAttachedTextContent } from "../attachments/ChatAttachmentContent";
import { isChatAttachmentContentRef } from "../attachments/ChatAttachmentVaultStore";
import * as obsidianApi from "obsidian";
// Dynamically extract to support stub in tests

const { parseYaml } = obsidianApi as any;
import { MessagePartList } from "../utils/MessagePartList";
import {
  parseManagedChatSessionBinding,
  type ChatMetadata,
  type ParsedChatMarkdown,
} from "./ChatPersistenceTypes";

const FRAMED_PAYLOAD_FORMAT = "base64-json-v1";

type FramedMessagePayload =
  | Readonly<{
      version: 1;
      kind: "content";
      content: string | MultiPartContent[];
    }>
  | Readonly<{
      version: 1;
      kind: "parts";
      parts: ReadonlyArray<Readonly<{ type: MessagePart["type"]; data: unknown }>>;
    }>;

/**
 * ChatMarkdownSerializer – central place for converting between in-memory
 * ChatMessage[] objects and the markdown representation used on disk.
 *
 * 2025-06-11: initial extraction from ChatStorageService.  Only implements
 * `serializeMessages()` for now; parsing will be added in a later PR.
 */
export class ChatMarkdownSerializer {
  /**
   * Convert an array of chat messages into the markdown body that lives below
   * the YAML front-matter.  (Front-matter itself is *not* produced here.)
   */
  public static serializeMessages(messages: ChatMessage[]): string {
    const unsupported = messages.find((message) => message.role !== "user" && message.role !== "assistant");
    if (unsupported) {
      throw new Error(`Managed chat persistence does not support ${unsupported.role} messages.`);
    }
    return messages
      .map((msg) => this.messageToMarkdown(msg))
      .join("\n\n");
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  READ-SIDE – parseMarkdown()
  // ────────────────────────────────────────────────────────────────────────────

  /** Parse markdown of a chat file and return metadata + messages. */
  public static parseMarkdown(content: string): ParsedChatMarkdown | null {
    const metadata = this.parseMetadata(content);
    if (!metadata) return null;

    // Prefer modern sequential format
    const sequential = this.parseSequentialFormat(content);
    if (sequential.success) return { metadata, messages: sequential.messages };

    return null;
  }

  // ───────────────────────── Internal parsing helpers ─────────────────────────

  private static parseSequentialFormat(content: string): { success: boolean; messages: ChatMessage[] } {
    const messages: ChatMessage[] = [];
    const messageRegex = /<!-- SYSTEMSCULPT-MESSAGE-START (.*?) -->([\s\S]*?)<!-- SYSTEMSCULPT-MESSAGE-END -->/g;
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(content)) !== null) {
      const attrs = match[1];
      const roleMatch = attrs.match(/role="(.*?)"/);
      const idMatch = attrs.match(/message-id="(.*?)"/);
      if (!roleMatch || !idMatch) continue;

      const role = roleMatch[1];
      if (role !== "user" && role !== "assistant") continue;
      const message_id = idMatch[1];

      if (attrs.includes(`payload-format="${FRAMED_PAYLOAD_FORMAT}"`)) {
        const framedMessage = this.parseFramedMessagePayload(match[2], role, message_id, attrs);
        if (framedMessage) messages.push(framedMessage);
        continue;
      }

      const storedMultipart = this.extractStoredMultipart(match[2]);
      const body = storedMultipart.body;

      const parts: MessagePart[] = [];
      let ts = Date.now();

      const extractedBlocks: Array<{
        type: "reasoning" | "tool_calls";
        data: any;
        start: number;
        end: number;
      }> = [];

      const reasoningRegex = /<!-- REASONING\n([\s\S]*?)\n-->/g;
      let reasoningMatch: RegExpExecArray | null;
      while ((reasoningMatch = reasoningRegex.exec(body)) !== null) {
        const reasoningText = reasoningMatch[1];
        if (reasoningText) {
          extractedBlocks.push({
            type: "reasoning",
            data: reasoningText,
            start: reasoningMatch.index,
            end: reasoningMatch.index + reasoningMatch[0].length,
          });
        }
      }

      const toolCallRegex = /<!-- TOOL-CALLS\n([\s\S]*?)\n-->/g;
      let toolCallMatch: RegExpExecArray | null;
      while ((toolCallMatch = toolCallRegex.exec(body)) !== null) {
        const toolCallJson = toolCallMatch[1]?.trim();
        if (toolCallJson) {
          try {
            const toolCallsArray = JSON.parse(toolCallJson);
            if (Array.isArray(toolCallsArray)) {
              extractedBlocks.push({
                type: "tool_calls",
                data: toolCallsArray,
                start: toolCallMatch.index,
                end: toolCallMatch.index + toolCallMatch[0].length,
              });
            }
          } catch { /* ignore JSON errors */ }
        }
      }

      extractedBlocks.sort((a, b) => {
        if (a.start !== b.start) {
          return a.start - b.start;
        }
        return a.end - b.end;
      });

      const pushContentChunk = (
        rawChunk: string,
        options: { trimLeadingBoundary: boolean; trimTrailingBoundary: boolean },
      ) => {
        const normalizedChunk = this.normalizeSequentialContentChunk(rawChunk, options);
        if (normalizedChunk.trim().length === 0) {
          return;
        }
        parts.push({ id: `content-${ts}`, type: "content", data: normalizedChunk, timestamp: ts++ });
      };

      let cursor = 0;
      for (const block of extractedBlocks) {
        if (block.start > cursor) {
          pushContentChunk(body.slice(cursor, block.start), {
            trimLeadingBoundary: true,
            trimTrailingBoundary: true,
          });
        }

        if (block.type === "reasoning") {
          parts.push({ id: `reasoning-${ts}`, type: "reasoning", data: block.data, timestamp: ts++ });
        } else {
          for (const toolCall of block.data as any[]) {
            const toolId = (toolCall && typeof toolCall.id === "string") ? toolCall.id : String(ts);
            const partId = toolId ? `tool_call_part-${toolId}` : `tool_call-${ts}`;
            parts.push({ id: partId, type: "tool_call", data: toolCall, timestamp: ts++ });
          }
        }

        cursor = Math.max(cursor, block.end);
      }

      if (cursor < body.length) {
        pushContentChunk(body.slice(cursor), {
          trimLeadingBoundary: cursor > 0,
          trimTrailingBoundary: true,
        });
      } else if (parts.length === 0) {
        pushContentChunk(body, {
          trimLeadingBoundary: true,
          trimTrailingBoundary: true,
        });
      }

      const attachmentMetadata = this.extractAttachmentMetadata(attrs, storedMultipart.content);
      if (parts.length > 0 || attachmentMetadata) {
        const reconstructed: ChatMessage = parts.length > 0
          ? this.reconstructMessageFromParts(role, message_id, parts)
          : { role, message_id, content: "" as const };
        const restored = storedMultipart.content
          ? { ...reconstructed, content: storedMultipart.content, messageParts: undefined }
          : reconstructed;
        messages.push(attachmentMetadata ? { ...restored, attachmentMetadata } : restored);
      }
    }

    return { success: true, messages };
  }

  private static reconstructMessageFromParts(role: ChatRole, message_id: string, messageParts: MessagePart[]): ChatMessage {
    const list = new MessagePartList(messageParts);
    return {
      role,
      message_id,
      content: list.contentMarkdown(""),
      reasoning: list.reasoningMarkdown(),
      tool_calls: list.toolCalls,
      messageParts,
    };
  }

  private static parseFramedMessagePayload(
    body: string,
    role: "user" | "assistant",
    message_id: string,
    attributes: string,
  ): ChatMessage | null {
    try {
      const decoded = this.decodeBase64Json(body.trim());
      if (!this.isFramedMessagePayload(decoded)) return null;

      if (decoded.kind === "content") {
        const multipart = Array.isArray(decoded.content) ? decoded.content : null;
        const attachmentMetadata = this.extractAttachmentMetadata(attributes, multipart);
        const timestamp = Date.now();
        const restored: ChatMessage = multipart
          ? { role, message_id, content: multipart }
          : decoded.content.length > 0
            ? this.reconstructMessageFromParts(role, message_id, [{
                id: `content-${timestamp}`,
                type: "content",
                data: decoded.content,
                timestamp,
              }])
            : { role, message_id, content: "" };
        return attachmentMetadata ? { ...restored, attachmentMetadata } : restored;
      }

      let timestamp = Date.now();
      const parts: MessagePart[] = decoded.parts.map((part) => {
        const currentTimestamp = timestamp++;
        if (part.type === "reasoning") {
          return {
            id: `reasoning-${currentTimestamp}`,
            type: "reasoning",
            data: part.data as string,
            timestamp: currentTimestamp,
          };
        }
        if (part.type === "content") {
          return {
            id: `content-${currentTimestamp}`,
            type: "content",
            data: part.data as string | MultiPartContent[],
            timestamp: currentTimestamp,
          };
        }
        if (part.type === "tool_call") {
          const toolId = typeof (part.data as { id?: unknown }).id === "string"
            ? (part.data as { id: string }).id
            : String(currentTimestamp);
          return {
            id: `tool_call_part-${toolId}`,
            type: "tool_call",
            data: part.data as Extract<MessagePart, { type: "tool_call" }>["data"],
            timestamp: currentTimestamp,
          };
        }
        throw new Error("Unsupported framed message part.");
      });
      const restored = this.reconstructMessageFromParts(role, message_id, parts);
      const attachmentMetadata = this.extractAttachmentMetadata(attributes, null);
      return attachmentMetadata ? { ...restored, attachmentMetadata } : restored;
    } catch {
      return null;
    }
  }

  private static isFramedMessagePayload(value: unknown): value is FramedMessagePayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    if (payload.version !== 1) return false;

    if (payload.kind === "content") {
      if (!Object.keys(payload).every((key) => ["version", "kind", "content"].includes(key))) return false;
      return typeof payload.content === "string"
        || (Array.isArray(payload.content)
          && payload.content.length > 0
          && payload.content.every((part) => this.isStoredContentPart(part)));
    }

    if (payload.kind !== "parts"
      || !Object.keys(payload).every((key) => ["version", "kind", "parts"].includes(key))
      || !Array.isArray(payload.parts)
      || payload.parts.length === 0) return false;

    return payload.parts.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const part = value as Record<string, unknown>;
      if (!Object.keys(part).every((key) => ["type", "data"].includes(key))) return false;
      if (part.type === "reasoning") return typeof part.data === "string";
      if (part.type === "content") {
        return typeof part.data === "string"
          || (Array.isArray(part.data)
            && part.data.length > 0
            && part.data.every((item) => this.isStoredContentPart(item)));
      }
      return part.type === "tool_call"
        && !!part.data
        && typeof part.data === "object"
        && !Array.isArray(part.data);
    });
  }

  private static extractStoredMultipart(body: string): { body: string; content: MultiPartContent[] | null } {
    const marker = /\n?<!-- SYSTEMSCULPT-CONTENT-PARTS base64\n([A-Za-z0-9+/=]+)\n-->/;
    const match = body.match(marker);
    if (!match) return { body, content: null };
    try {
      const binary = atob(match[1]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => this.isStoredContentPart(part))) {
        return { body, content: null };
      }
      return { body: body.replace(match[0], ""), content: parsed as MultiPartContent[] };
    } catch {
      return { body, content: null };
    }
  }

  private static isStoredContentPart(value: unknown): value is MultiPartContent {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const part = value as Record<string, unknown>;
    if (part.type === "text") return Object.keys(part).length === 2 && typeof part.text === "string";
    if (part.type !== "image_url" || Object.keys(part).length !== 2) return false;
    const image = part.image_url;
    return !!image && typeof image === "object" && !Array.isArray(image)
      && Object.keys(image).length === 1
      && typeof (image as Record<string, unknown>).url === "string"
      && /^data:image\/(?:png|jpeg|webp);base64,/.test((image as Record<string, unknown>).url as string);
  }

  private static encodeStoredMultipart(content: MultiPartContent[]): string {
    return this.encodeBase64Json(content);
  }

  private static encodeBase64Json(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    }
    return btoa(binary);
  }

  private static decodeBase64Json(value: string): unknown {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  private static extractAttachmentMetadata(
    attributes: string,
    content: MultiPartContent[] | null,
  ): ChatAttachmentMetadata[] | null {
    const match = attributes.match(/(?:^|\s)attachment-metadata="([A-Za-z0-9+/=]+)"(?:\s|$)/);
    if (!match) return null;
    try {
      const parsed = this.decodeBase64Json(match[1]);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const indices = new Set<number>();
      const valid = parsed.every((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const item = value as Record<string, unknown>;
        if (!Object.keys(item).every((key) => [
          "id", "name", "mimeType", "byteLength", "kind", "contentPartIndex", "contentRef",
        ].includes(key))) return false;
        if (typeof item.id !== "string" || !item.id.trim()) return false;
        if (typeof item.name !== "string" || !item.name.trim()) return false;
        if (typeof item.mimeType !== "string" || !item.mimeType.trim()) return false;
        if (!Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0) return false;
        if (!Number.isSafeInteger(item.contentPartIndex) || (item.contentPartIndex as number) < 0) return false;
        if (!new Set(["document", "image", "text"]).has(String(item.kind))) return false;
        if (typeof item.contentRef !== "undefined" && !isChatAttachmentContentRef(item.contentRef)) return false;
        const partIndex = item.contentPartIndex as number;
        if (indices.has(partIndex)) return false;
        const part = content?.[partIndex];
        if (part && (item.kind === "image" ? part.type !== "image_url" : part.type !== "text")) return false;
        indices.add(partIndex);
        return true;
      });
      return valid ? parsed as ChatAttachmentMetadata[] : null;
    } catch {
      return null;
    }
  }

  private static multipartDisplay(content: MultiPartContent[]): string {
    let imageIndex = 0;
    return content.map((part) => {
      if (part.type === "image_url") {
        imageIndex += 1;
        return `> [!info] Attached image ${imageIndex}`;
      }
      const attachmentName = part.text.match(/^--- BEGIN ATTACHED FILE: (.+?) \(/)?.[1];
      return attachmentName ? `> [!info] Attached file: ${attachmentName}` : part.text;
    }).filter(Boolean).join("\n\n");
  }

  private static normalizeSequentialContentChunk(
    chunk: string,
    options: { trimLeadingBoundary: boolean; trimTrailingBoundary: boolean },
  ): string {
    let normalized = chunk;

    if (options.trimLeadingBoundary) {
      normalized = normalized.replace(/^\r?\n/, "");
    }

    if (options.trimTrailingBoundary) {
      normalized = normalized.replace(/\r?\n$/, "");
    }

    return normalized;
  }

  // ───────────────────────── Front-matter helpers ─────────────────────────

  public static parseMetadata(content: string): ChatMetadata | null {
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatterMatch) return null;

    const yamlContent = frontMatterMatch[1];
    if (!this.isValidYamlFrontmatter(yamlContent)) return null;

    const parsed: any = parseYaml(yamlContent);
    if (!parsed || typeof parsed !== "object") return null;

    const {
      id = "",
      created = new Date().toISOString(),
      lastModified = new Date().toISOString(),
      title = "Untitled Chat",
      context_files = [],
      version: versionRaw = 0,
    } = parsed;

    if (!id) return null;

    const processedContextFiles = Array.isArray(context_files)
      ? context_files.map((file: any): NonNullable<ChatMetadata["context_files"]>[number] => {
          if (typeof file === "string") {
            const isExtraction = file.includes("/Extractions/");
            return { path: file, type: isExtraction ? "extraction" : "source" };
          } else if (file && typeof file === "object" && file.path) {
            return {
              path: file.path,
              type: file.type || "source",
            };
          } else {
            return { path: "", type: "source" };
          }
        }).filter((file) => file.path.length > 0)
      : [];
    const tags = this.normalizeTags(parsed.tags);

    return {
      id,
      created,
      lastModified,
      title,
      version: Number(versionRaw) || 0,
      ...(tags.length > 0 ? { tags } : {}),
      context_files: processedContextFiles,
      chatFontSize: parsed.chatFontSize as "small" | "medium" | "large" | undefined,
      approvalMode: parsed.approvalMode === "full-access" ? "full-access" : "ask",
      managedSession: parseManagedChatSessionBinding(parsed.managedSession, id),
    };
  }

  private static isValidYamlFrontmatter(content: string): boolean {
    return /\bid\s*:/i.test(content);
  }

  private static normalizeTags(value: unknown): string[] {
    const candidates = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return [...new Set(candidates
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim().replace(/^#+/, ""))
      .filter(Boolean))];
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private static messageToMarkdown(msg: ChatMessage): string {
    let messageBody = "";

    if (msg.messageParts && msg.messageParts.length > 0) {
      // New format – iterate through parts in order.
      msg.messageParts.forEach((part: MessagePart) => {
        switch (part.type) {
          case "content":
            messageBody += part.data as string;
            break;
          case "reasoning":
            if (typeof part.data === "string") {
              // Preserve reasoning verbatim without trimming or normalization
              messageBody += `\n<!-- REASONING\n${part.data as string}\n-->\n`;
            }
            break;
          case "tool_call":
            const toolCallArray = [part.data];
            messageBody += `\n<!-- TOOL-CALLS\n${JSON.stringify(toolCallArray, null, 2)}\n-->\n`;
            break;
        }
      });
    } else {
      // User messages and simple assistant messages do not need ordered parts.
      let contentString = "";
      if (typeof msg.content === "string") {
        contentString = msg.content;
      } else if (Array.isArray(msg.content) && this.canPersistAttachmentRefs(msg)) {
        contentString = this.multipartTextWithoutAttachments(msg.content, msg.attachmentMetadata ?? []);
      } else if (Array.isArray(msg.content)) {
        contentString = [
          this.multipartDisplay(msg.content),
          `<!-- SYSTEMSCULPT-CONTENT-PARTS base64\n${this.encodeStoredMultipart(msg.content)}\n-->`,
        ].filter(Boolean).join("\n");
      }
      messageBody = contentString;
    }

    const hasToolCalls = msg.messageParts?.some((part) => part.type === "tool_call") === true;
    const hasReasoning = msg.messageParts?.some((part) => part.type === "reasoning") === true;
    const isStreaming = !!msg.streaming;

    let attributes = `role="${msg.role}" message-id="${msg.message_id}"`;
    if (hasToolCalls) attributes += " has-tool-calls=\"true\"";
    if (hasReasoning) attributes += " has-reasoning=\"true\"";
    if (isStreaming) attributes += " streaming=\"true\"";
    if (Array.isArray(msg.content) && msg.attachmentMetadata?.length) {
      attributes += ` attachment-metadata="${this.encodeBase64Json(msg.attachmentMetadata)}"`;
    }

    if (this.needsFramedPayload(msg)) {
      attributes += ` payload-format="${FRAMED_PAYLOAD_FORMAT}"`;
      messageBody = this.encodeBase64Json(this.createFramedMessagePayload(msg));
    }

    const messageStart = `<!-- SYSTEMSCULPT-MESSAGE-START ${attributes} -->`;

    return `${messageStart}\n${messageBody}\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;
  }

  private static needsFramedPayload(message: ChatMessage): boolean {
    const persisted = message.messageParts?.length
      ? message.messageParts.map((part) => part.data)
      : this.persistedSimpleContent(message);
    return this.containsReservedFraming(persisted);
  }

  private static containsReservedFraming(value: unknown, seen = new Set<object>()): boolean {
    if (typeof value === "string") {
      return value.includes("<!-- SYSTEMSCULPT-")
        || value.includes("<!-- REASONING")
        || value.includes("<!-- TOOL-CALLS")
        || /(?:^|\r?\n)-->/.test(value);
    }
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Array.isArray(value)
      ? value.some((item) => this.containsReservedFraming(item, seen))
      : Object.values(value).some((item) => this.containsReservedFraming(item, seen));
  }

  private static createFramedMessagePayload(message: ChatMessage): FramedMessagePayload {
    if (message.messageParts?.length) {
      return {
        version: 1,
        kind: "parts",
        parts: message.messageParts.map((part) => ({ type: part.type, data: part.data })),
      };
    }
    return { version: 1, kind: "content", content: this.persistedSimpleContent(message) };
  }

  private static persistedSimpleContent(message: ChatMessage): string | MultiPartContent[] {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return this.canPersistAttachmentRefs(message)
      ? this.multipartTextWithoutAttachments(message.content, message.attachmentMetadata ?? [])
      : message.content;
  }

  private static canPersistAttachmentRefs(message: ChatMessage): boolean {
    if (!Array.isArray(message.content) || !message.attachmentMetadata?.length) return false;
    const parts = message.content;
    const attachmentIndices = new Set<number>();
    return message.attachmentMetadata.every((metadata) => {
      if (!metadata.contentRef || !isChatAttachmentContentRef(metadata.contentRef)) return false;
      if (!Number.isSafeInteger(metadata.contentPartIndex) || metadata.contentPartIndex < 0) return false;
      if (attachmentIndices.has(metadata.contentPartIndex)) return false;
      const part = parts[metadata.contentPartIndex];
      if (!part) return false;
      if (metadata.kind === "image" ? part.type !== "image_url" : part.type !== "text") return false;
      attachmentIndices.add(metadata.contentPartIndex);
      return true;
    });
  }

  private static multipartTextWithoutAttachments(
    content: MultiPartContent[],
    attachmentMetadata: readonly ChatAttachmentMetadata[],
  ): string {
    const attachmentIndices = new Set(attachmentMetadata.map((metadata) => metadata.contentPartIndex));
    return content
      .map((part, index) => {
        if (attachmentIndices.has(index) || part.type !== "text") return "";
        const attached = parseAttachedTextContent(part.text);
        return attached ? "" : part.text;
      })
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  }
}

// ───────────────────────── Local interfaces ─────────────────────────
