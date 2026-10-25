import {
  ChatMessage,
  MessagePart,
  ChatRole,
  MultiPartContent,
  type ChatAttachmentMetadata,
} from "../../../types";
import { parseAttachedTextContent } from "../../../chat/ChatAttachmentContent";
import { base64ToUtf8, utf8ToBase64 } from "../../../utils/base64";
import { isChatAttachmentContentRef } from "../attachments/ChatAttachmentVaultStore";
import {
  hasChatIdentityMetadata,
  parseChatFrontmatterYaml,
  splitChatFrontmatter,
} from "./ChatFrontmatterIdentity";
import {
  parseAgentConversationId,
  parseChatApprovalMode,
  type ChatMetadata,
  type ParsedChatMarkdown,
} from "./ChatPersistenceTypes";
import {
  normalizeFailedTerminalReceipt,
} from "../FailedTerminalReceipt";
import type { ToolCall } from "../../../types/toolCalls";
import { isAbsoluteNativePath, nativePathPrefixRewriter, nativeToolPath } from "../../../utils/nativeToolPath";

const FRAMED_PAYLOAD_FORMAT = "base64-json-v1";
/** Literal markers in message text are escaped, never treated as structure. */
const RESERVED_MARKERS = [
  "<!-- SYSTEMSCULPT-",
  "<!-- REASONING",
  "<!-- TOOL-CALLS",
] as const;
/**
 * Reasoning is stored inside an HTML comment, and `-->` or `--!>` would close
 * it early. The writer inserts one backslash after the `--` of every
 * `--`, backslashes, optional `!`, `>` run, and this attribute tells the
 * reader to remove it. Messages without the attribute store reasoning
 * verbatim, so older notes read exactly as before.
 */
const REASONING_ESCAPE_ATTRIBUTE = "reasoning-escape";
const REASONING_ESCAPE_VERSION = "v1";
const REASONING_CLOSER_RUN = /--(\\*)(!?)>/gu;
const ESCAPED_REASONING_CLOSER_RUN = /--\\(\\*)(!?)>/gu;
const MARKER_ESCAPE_ATTRIBUTE = "marker-escape";
const MAX_RESPONSE_DURATION_MS = 24 * 60 * 60 * 1_000;

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

type StoredMultipartParseResult =
  | Readonly<{
      state: "absent" | "invalid";
      content: null;
    }>
  | Readonly<{
      state: "valid";
      start: number;
      end: number;
      content: MultiPartContent[];
    }>;

type AttachmentMetadataParseResult =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "valid"; metadata: ChatAttachmentMetadata[] }>
  | Readonly<{ state: "invalid" }>;

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
  public static serializeMessages(messages: readonly ChatMessage[]): string {
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
    const envelope = splitChatFrontmatter(content);
    if (!envelope) return null;
    const parsedFrontmatter = parseChatFrontmatterYaml(envelope.yamlContent);
    if (!parsedFrontmatter) return null;
    const metadata = this.parseMetadataRecord(parsedFrontmatter);
    if (!metadata) return null;

    // Prefer modern sequential format
    const sequential = this.parseSequentialFormat(envelope.body);
    if (!sequential.success) return null;
    if (sequential.messages.length === 0 && !hasChatIdentityMetadata(parsedFrontmatter)) {
      return null;
    }

    return { metadata, messages: sequential.messages };
  }

  /**
   * The messages as a saved chat would read them back: what loading the note
   * returns after they are written. The reader assigns its own part ids and
   * part timestamps. Null when the messages cannot be saved.
   */
  public static readBack(messages: readonly ChatMessage[]): ChatMessage[] | null {
    try {
      const parsed = this.parseSequentialFormat(this.serializeMessages(messages));
      return parsed.success ? parsed.messages : null;
    } catch {
      return null;
    }
  }

  // ───────────────────────── Internal parsing helpers ─────────────────────────

  private static parseSequentialFormat(content: string): { success: boolean; messages: ChatMessage[] } {
    const messages: ChatMessage[] = [];
    const messageRegex = /<!-- SYSTEMSCULPT-MESSAGE-START (.*?) -->([\s\S]*?)<!-- SYSTEMSCULPT-MESSAGE-END -->/g;
    const markerRegex = /<!-- SYSTEMSCULPT-MESSAGE-(START |END -->)/g;
    let declaredStarts = 0;
    let declaredEnds = 0;
    let markerMatch: RegExpExecArray | null;
    while ((markerMatch = markerRegex.exec(content)) !== null) {
      if (markerMatch[1] === "START ") declaredStarts += 1;
      else declaredEnds += 1;
    }
    if (declaredStarts !== declaredEnds) return { success: false, messages: [] };
    if (declaredStarts === 0 && content.trim().length > 0) return { success: false, messages: [] };

    let parsedBlocks = 0;
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(content)) !== null) {
      parsedBlocks += 1;
      const attrs = match[1];
      const roleMatch = attrs.match(/role="(.*?)"/);
      const idMatch = attrs.match(/message-id="(.*?)"/);
      if (!roleMatch || !idMatch || !idMatch[1]) return { success: false, messages: [] };

      const role = roleMatch[1];
      if (role !== "user" && role !== "assistant") return { success: false, messages: [] };
      const message_id = idMatch[1];

      if (attrs.includes(`payload-format="${FRAMED_PAYLOAD_FORMAT}"`)) {
        const framedMessage = this.parseFramedMessagePayload(match[2], role, message_id, attrs);
        if (!framedMessage) return { success: false, messages: [] };
        messages.push(framedMessage);
        continue;
      }

      const body = match[2];
      const storedMultipart = this.parseStoredMultipart(body);
      if (storedMultipart.state === "invalid") return { success: false, messages: [] };
      const reasoningEscape = this.textEscape(attrs, REASONING_ESCAPE_ATTRIBUTE);
      const markerEscape = this.textEscape(attrs, MARKER_ESCAPE_ATTRIBUTE);
      if (reasoningEscape === "invalid" || markerEscape === "invalid") return { success: false, messages: [] };
      const restoreMarkers = (text: string) => markerEscape === "escaped" ? this.unescapeMarkers(text) : text;

      const parts: MessagePart[] = [];
      let ts = Date.now();

      const extractedBlocks: Array<
        | { type: "reasoning"; data: string; start: number; end: number }
        | { type: "tool_calls"; data: ToolCall[]; start: number; end: number }
        | { type: "content"; data: MultiPartContent[]; start: number; end: number }
        | { type: "stored_multipart"; start: number; end: number }
      > = [];
      // Keep the original offsets until every structural span is checked.
      // Stripping legacy metadata first hides a block nested inside reasoning.
      if (storedMultipart.state === "valid") {
        extractedBlocks.push({ type: "stored_multipart", start: storedMultipart.start, end: storedMultipart.end });
      }

      const reasoningRegex = /<!-- REASONING\r?\n([\s\S]*?)\r?\n-->/g;
      let reasoningMatch: RegExpExecArray | null;
      while ((reasoningMatch = reasoningRegex.exec(body)) !== null) {
        const reasoningText = reasoningMatch[1];
        extractedBlocks.push({
          type: "reasoning",
          data: restoreMarkers(reasoningEscape === "escaped"
            ? this.unescapeReasoning(reasoningText)
            : reasoningText),
          start: reasoningMatch.index,
          end: reasoningMatch.index + reasoningMatch[0].length,
        });
      }

      const toolCallRegex = /<!-- TOOL-CALLS\r?\n([\s\S]*?)\r?\n-->/g;
      let toolCallMatch: RegExpExecArray | null;
      while ((toolCallMatch = toolCallRegex.exec(body)) !== null) {
        const toolCallJson = toolCallMatch[1]?.trim();
        if (!toolCallJson) return { success: false, messages: [] };
        try {
          const toolCallsValue: unknown = JSON.parse(toolCallJson);
          if (
            !Array.isArray(toolCallsValue)
            || !toolCallsValue.every((value) => value && typeof value === "object" && !Array.isArray(value))
          ) {
            return { success: false, messages: [] };
          }
          extractedBlocks.push({
            type: "tool_calls",
            data: toolCallsValue as ToolCall[],
            start: toolCallMatch.index,
            end: toolCallMatch.index + toolCallMatch[0].length,
          });
        } catch {
          return { success: false, messages: [] };
        }
      }

      const contentPartRegex = /<!-- SYSTEMSCULPT-PART-CONTENT base64="([A-Za-z0-9+/=]+)" -->\r?\n[\s\S]*?\r?\n<!-- SYSTEMSCULPT-PART-CONTENT-END -->/gu;
      for (const block of body.matchAll(contentPartRegex)) {
        try {
          const data = this.decodeBase64Json(block[1]);
          if (!Array.isArray(data) || !data.length || !data.every((part) => this.isStoredContentPart(part))) {
            return { success: false, messages: [] };
          }
          extractedBlocks.push({ type: "content", data, start: block.index, end: block.index + block[0].length });
        } catch { return { success: false, messages: [] }; }
      }

      extractedBlocks.sort((a, b) => {
        if (a.start !== b.start) {
          return a.start - b.start;
        }
        return a.end - b.end;
      });

      let checkedThrough = 0;
      for (const block of extractedBlocks) {
        if (block.start < checkedThrough || RESERVED_MARKERS.some((marker) => body.slice(checkedThrough, block.start).includes(marker))) {
          return { success: false, messages: [] };
        }
        checkedThrough = block.end;
      }
      if (RESERVED_MARKERS.some((marker) => body.slice(checkedThrough).includes(marker))) return { success: false, messages: [] };

      // Legacy metadata holds the whole message's content, and its prose is
      // only the display of it. The stored content stands once, where the
      // note first shows it, so reasoning and tools around it keep their order.
      const storedContent = storedMultipart.content;
      let storedContentPlaced = false;
      const placeStoredContent = () => {
        if (!storedContent || storedContentPlaced) return;
        storedContentPlaced = true;
        parts.push({ id: `content-${ts}`, type: "content", data: storedContent, timestamp: ts++ });
      };
      const pushContentChunk = (
        rawChunk: string,
        options: { trimLeadingBoundary: boolean; trimTrailingBoundary: boolean },
      ) => {
        const normalizedChunk = this.normalizeSequentialContentChunk(rawChunk, options);
        if (normalizedChunk.length === 0) {
          return;
        }
        // Blank lines between blocks are layout, not the display of the content.
        if (storedContent) {
          if (normalizedChunk.trim()) placeStoredContent();
        } else parts.push({ id: `content-${ts}`, type: "content", data: restoreMarkers(normalizedChunk), timestamp: ts++ });
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
        } else if (block.type === "content") {
          parts.push({ id: `content-${ts}`, type: "content", data: block.data, timestamp: ts++ });
        } else if (block.type === "stored_multipart") {
          placeStoredContent();
        } else if (block.type === "tool_calls") {
          for (const toolCall of block.data) {
            const toolId = typeof toolCall.id === "string" ? toolCall.id : String(ts);
            const partId = toolId ? `tool_call_part-${toolId}` : `tool_call-${ts}`;
            parts.push({ id: partId, type: "tool_call", data: toolCall, timestamp: ts++ });
          }
        }

        cursor = Math.max(cursor, block.end);
      }

      if (cursor < body.length) {
        // With no blocks the chunk still begins with the newline the writer
        // puts after the START marker. Keeping it prepended one newline to
        // the message on every load and save.
        pushContentChunk(body.slice(cursor), {
          trimLeadingBoundary: true,
          trimTrailingBoundary: true,
        });
      } else if (parts.length === 0 && storedMultipart.state !== "valid") {
        pushContentChunk(body, {
          trimLeadingBoundary: true,
          trimTrailingBoundary: true,
        });
      }

      const attachmentMetadata = this.extractAttachmentMetadata(attrs, storedMultipart.content);
      if (attachmentMetadata.state === "invalid") return { success: false, messages: [] };
      const reconstructed: ChatMessage = parts.length > 0
        ? this.reconstructMessageFromParts(role, message_id, parts)
        : { role, message_id, content: "" as const };
      // Metadata alone stays the plain multipart message it was written as.
      const restored = storedMultipart.state === "valid" && extractedBlocks.length === 1
        ? { ...reconstructed, messageParts: undefined }
        : reconstructed;
      const withMetadata = this.withAdditiveMetadata(restored, attrs);
      messages.push(attachmentMetadata.state === "valid" ? { ...withMetadata, attachmentMetadata: attachmentMetadata.metadata } : withMetadata);
    }

    if (parsedBlocks !== declaredStarts || messages.length !== declaredStarts) {
      return { success: false, messages: [] };
    }
    return { success: true, messages };
  }

  private static reconstructMessageFromParts(role: ChatRole, message_id: string, messageParts: MessagePart[]): ChatMessage {
    let reasoning = "";
    const contents: Array<string | MultiPartContent[]> = [];
    const tool_calls: ToolCall[] = [];
    for (const part of messageParts) {
      if (part.type === "content") contents.push(part.data ?? "");
      else if (part.type === "reasoning") reasoning += String(part.data ?? "");
      else if (part.type === "tool_call") tool_calls.push(part.data);
    }
    // Attached images and files keep the message multipart; text alone is one string.
    const content = contents.some((data) => Array.isArray(data))
      ? contents.flatMap((data): MultiPartContent[] => typeof data !== "string"
        ? data
        : data ? [{ type: "text", text: data }] : [])
      : contents.join("");
    return { role, message_id, content, reasoning, tool_calls, messageParts };
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
        if (attachmentMetadata.state === "invalid") return null;
        const timestamp = Date.now();
        const restored = this.withAdditiveMetadata(
          multipart
            ? { role, message_id, content: multipart }
            : decoded.content.length > 0
              ? this.reconstructMessageFromParts(role, message_id, [{
                  id: `content-${timestamp}`,
                  type: "content",
                  data: decoded.content,
                  timestamp,
                }])
              : { role, message_id, content: "" },
          attributes,
        );
        return attachmentMetadata.state === "valid"
          ? { ...restored, attachmentMetadata: attachmentMetadata.metadata }
          : restored;
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
      const restored = this.withAdditiveMetadata(
        this.reconstructMessageFromParts(role, message_id, parts),
        attributes,
      );
      const attachmentMetadata = this.extractAttachmentMetadata(attributes, null);
      if (attachmentMetadata.state === "invalid") return null;
      return attachmentMetadata.state === "valid"
        ? { ...restored, attachmentMetadata: attachmentMetadata.metadata }
        : restored;
    } catch {
      return null;
    }
  }

  /** Restore bounded presentation metadata without making it part of message content. */
  private static withAdditiveMetadata(
    message: ChatMessage,
    attributes: string,
  ): ChatMessage {
    if (message.role !== "assistant") return message;

    let restored = message;
    const terminalOutcome = this.uniqueAdditiveAttribute(
      attributes,
      "terminal-outcome",
    );
    if (terminalOutcome === "cancelled") {
      restored = { ...restored, terminalOutcome: "cancelled" };
    } else if (terminalOutcome === "failed") {
      const retryableValue = this.uniqueAdditiveAttribute(
        attributes,
        "terminal-retryable",
      );
      const encodedFailureMessage = this.uniqueAdditiveAttribute(attributes, "terminal-failure-message");
      let terminalFailureMessage: unknown;
      if (encodedFailureMessage !== undefined) {
        try { terminalFailureMessage = this.decodeBase64Json(encodedFailureMessage); }
        catch { /* Invalid additive metadata does not invalidate the transcript. */ }
      }
      const failedReceipt = normalizeFailedTerminalReceipt({
        terminalOutcome,
        terminalFailureMessage,
        terminalReportId: this.uniqueAdditiveAttribute(
          attributes,
          "terminal-report-id",
        ),
        terminalIncidentId: this.uniqueAdditiveAttribute(
          attributes,
          "terminal-incident-id",
        ),
        terminalFailureCode: this.uniqueAdditiveAttribute(
          attributes,
          "terminal-failure-code",
        ),
        terminalRetryable: retryableValue === "true"
          ? true
          : retryableValue === "false"
            ? false
            : undefined,
        terminalServerRunId: this.uniqueAdditiveAttribute(
          attributes,
          "terminal-server-run-id",
        ),
      });
      if (failedReceipt) restored = { ...restored, ...failedReceipt };
    }
    const durationMatch = attributes.match(
      /(?:^|\s)response-duration-ms="([0-9]+)"(?:\s|$)/u,
    );
    if (!durationMatch) return restored;
    const responseDurationMs = Number(durationMatch[1]);
    return this.isResponseDurationMs(responseDurationMs)
      ? { ...restored, responseDurationMs }
      : restored;
  }

  private static uniqueAdditiveAttribute(
    attributes: string,
    name: string,
  ): string | undefined {
    const pattern = new RegExp(
      `(?:^|\\s)${name}="([^"]*)"(?=\\s|$)`,
      "gu",
    );
    const matches = [...attributes.matchAll(pattern)];
    return matches.length === 1 ? matches[0][1] : undefined;
  }

  private static isResponseDurationMs(value: unknown): value is number {
    return Number.isSafeInteger(value)
      && (value as number) >= 0
      && (value as number) <= MAX_RESPONSE_DURATION_MS;
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

  private static parseStoredMultipart(body: string): StoredMultipartParseResult {
    const declarations = body.match(/<!-- SYSTEMSCULPT-CONTENT-PARTS base64\r?\n/gu) ?? [];
    if (declarations.length === 0) return { state: "absent", content: null };
    const marker = /<!-- SYSTEMSCULPT-CONTENT-PARTS base64\r?\n([A-Za-z0-9+/=]+)\r?\n-->/;
    const match = marker.exec(body);
    if (declarations.length !== 1 || !match) return { state: "invalid", content: null };
    try {
      const binary = atob(match[1]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => this.isStoredContentPart(part))) {
        return { state: "invalid", content: null };
      }
      return { state: "valid", start: match.index, end: match.index + match[0].length, content: parsed };
    } catch {
      return { state: "invalid", content: null };
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
    return utf8ToBase64(JSON.stringify(value));
  }

  private static decodeBase64Json(value: string): unknown {
    return JSON.parse(base64ToUtf8(value)) as unknown;
  }

  private static extractAttachmentMetadata(
    attributes: string,
    content: MultiPartContent[] | null,
  ): AttachmentMetadataParseResult {
    const match = attributes.match(/(?:^|\s)attachment-metadata="([A-Za-z0-9+/=]+)"(?:\s|$)/);
    if (!match) return { state: "absent" };
    try {
      const parsed = this.decodeBase64Json(match[1]);
      if (!Array.isArray(parsed) || parsed.length === 0) return { state: "invalid" };
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
      return valid
        ? { state: "valid", metadata: parsed as ChatAttachmentMetadata[] }
        : { state: "invalid" };
    } catch {
      return { state: "invalid" };
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
    const envelope = splitChatFrontmatter(content);
    return envelope ? this.parseMetadataYaml(envelope.yamlContent) : null;
  }

  private static parseMetadataYaml(yamlContent: string): ChatMetadata | null {
    const parsed = parseChatFrontmatterYaml(yamlContent);
    return parsed ? this.parseMetadataRecord(parsed) : null;
  }

  private static parseMetadataRecord(parsed: Record<string, unknown>): ChatMetadata | null {
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!id) return null;
    const now = new Date().toISOString();
    const created = typeof parsed.created === "string" ? parsed.created : now;
    const lastModified = typeof parsed.lastModified === "string" ? parsed.lastModified : now;
    const title = typeof parsed.title === "string" ? parsed.title : "Untitled Chat";
    const context_files = parsed.context_files;
    const versionRaw = parsed.version ?? 0;

    const processedContextFiles = Array.isArray(context_files)
      ? context_files.map((file: unknown): NonNullable<ChatMetadata["context_files"]>[number] => {
          if (typeof file === "string") {
            const isExtraction = file.includes("/Extractions/");
            return { path: file, type: isExtraction ? "extraction" : "source" };
          } else if (file && typeof file === "object" && !Array.isArray(file)) {
            const fileRecord = file as Record<string, unknown>;
            if (typeof fileRecord.path !== "string" || !fileRecord.path) {
              return { path: "", type: "source" };
            }
            return {
              path: fileRecord.path,
              type: fileRecord.type === "extraction" ? "extraction" : "source",
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
      approvalMode: parseChatApprovalMode(parsed.approvalMode),
      agentConversationId: parseAgentConversationId(parsed.agentConversationId),
    };
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
    let escapesReasoning = false;
    const orderedParts = msg.messageParts?.reduce<MessagePart[]>((parts, part) => {
      const previous = parts[parts.length - 1];
      if (previous?.type === "content" && part.type === "content"
        && typeof previous.data === "string" && typeof part.data === "string") {
        parts[parts.length - 1] = { ...previous, data: previous.data + part.data };
      } else parts.push(part);
      return parts;
    }, []);
    const textValues = orderedParts?.length
      ? orderedParts.filter((part) => part.type !== "tool_call")
        .map((part) => typeof part.data === "string" ? part.data : this.multipartDisplay(part.data))
      : [typeof msg.content === "string" ? msg.content : this.multipartDisplay(msg.content ?? [])];
    const escapesMarkers = textValues.some((value) => value.includes("\r")
      || RESERVED_MARKERS.some((marker) => value.includes(marker)));
    const storeText = (text: string) => escapesMarkers ? this.escapeMarkers(text) : text;

    if (orderedParts && orderedParts.length > 0) {
      // New format – iterate through parts in order.
      orderedParts.forEach((part: MessagePart) => {
        switch (part.type) {
          case "content":
            if (Array.isArray(part.data)) {
              // Only attachment data is encoded; the accompanying prose stays Markdown.
              messageBody += `\n<!-- SYSTEMSCULPT-PART-CONTENT base64="${this.encodeStoredMultipart(part.data)}" -->\n${storeText(this.multipartDisplay(part.data))}\n<!-- SYSTEMSCULPT-PART-CONTENT-END -->\n`;
            } else messageBody += storeText(part.data);
            break;
          case "reasoning":
            if (typeof part.data === "string") {
              // Preserve reasoning without trimming or normalization. The
              // only change is the reversible comment-closer escape.
              const text = storeText(part.data);
              const escaped = this.escapeReasoning(text);
              if (escaped !== text) escapesReasoning = true;
              messageBody += `\n<!-- REASONING\n${escaped}\n-->\n`;
            }
            break;
          case "tool_call": {
            // Also escape < so quoted message markers stay inert in JSON.
            const toolCallArray = [this.portableToolCall(part.data)];
            // `>` only occurs inside JSON strings, where \u003e is the same
            // character, so the comment can never be closed early. Compact
            // JSON: readers parse it the same, and it is a third smaller.
            const toolCallJson = JSON.stringify(toolCallArray)
              .replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
            messageBody += `\n<!-- TOOL-CALLS\n${toolCallJson}\n-->\n`;
            break;
          }
        }
      });
    } else {
      // User messages and simple assistant messages do not need ordered parts.
      let contentString = "";
      if (typeof msg.content === "string") {
        contentString = storeText(msg.content);
      } else if (Array.isArray(msg.content) && this.canPersistAttachmentRefs(msg)) {
        contentString = storeText(this.multipartTextWithoutAttachments(msg.content, msg.attachmentMetadata ?? []));
      } else if (Array.isArray(msg.content)) {
        contentString = [
          storeText(this.multipartDisplay(msg.content)),
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
    // Additive attribute: older parsers ignore unknown attributes, so a note
    // written with this marker still loads everywhere.
    if (msg.terminalOutcome === "cancelled") {
      attributes += " terminal-outcome=\"cancelled\"";
    } else {
      const failedReceipt = msg.role === "assistant"
        ? normalizeFailedTerminalReceipt(msg)
        : null;
      if (failedReceipt) {
        attributes += " terminal-outcome=\"failed\"";
        if (failedReceipt.terminalReportId) {
          attributes += ` terminal-report-id="${failedReceipt.terminalReportId}"`;
        }
        if (failedReceipt.terminalIncidentId) {
          attributes += ` terminal-incident-id="${failedReceipt.terminalIncidentId}"`;
        }
        attributes += ` terminal-failure-code="${failedReceipt.terminalFailureCode}"`;
        if (failedReceipt.terminalFailureMessage !== undefined) {
          attributes += ` terminal-failure-message="${this.encodeBase64Json(failedReceipt.terminalFailureMessage)}"`;
        }
        attributes += ` terminal-retryable="${String(failedReceipt.terminalRetryable)}"`;
        if (failedReceipt.terminalServerRunId) {
          attributes += ` terminal-server-run-id="${failedReceipt.terminalServerRunId}"`;
        }
      }
    }
    if (msg.role === "assistant" && this.isResponseDurationMs(msg.responseDurationMs)) {
      attributes += ` response-duration-ms="${msg.responseDurationMs}"`;
    }
    if (Array.isArray(msg.content) && msg.attachmentMetadata?.length) {
      attributes += ` attachment-metadata="${this.encodeBase64Json(msg.attachmentMetadata)}"`;
    }

    if (escapesMarkers) attributes += ` ${MARKER_ESCAPE_ATTRIBUTE}="v1"`;
    if (escapesReasoning) {
      attributes += ` ${REASONING_ESCAPE_ATTRIBUTE}="${REASONING_ESCAPE_VERSION}"`;
    }

    const messageStart = `<!-- SYSTEMSCULPT-MESSAGE-START ${attributes} -->`;

    return `${messageStart}\n${messageBody}\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;
  }

  /** Native roots are live presentation context, not portable transcript data. */
  private static portableToolCall(tool: ToolCall): ToolCall {
    if (!tool.native) return tool;
    const { workingDirectory, vaultRoot = workingDirectory, vaultRootAlias, homeDirectory } = tool.native;
    const resolve = (path: string) => nativeToolPath(path, workingDirectory, vaultRoot, vaultRootAlias, homeDirectory);
    const cwd = resolve(workingDirectory);
    const savedCwd = vaultRoot === "." ? workingDirectory : cwd.vaultPath ?? (cwd.displayPath === "Vault root" ? "." : "..");
    const native = { ...tool.native, workingDirectory: savedCwd, vaultRoot: "." };
    delete native.vaultRootAlias;
    delete native.homeDirectory;
    delete native.permissionSuggestions;

    // Structured path arguments become relative to the saved working
    // directory; paths outside the vault never become vault links. Native text
    // (commands, results, errors, request descriptions) keeps its wording, with
    // the vault's absolute prefix spelled from that directory and the home
    // folder as ~. The live tool record and native session stay unchanged, and
    // replayed history leaves tool results out.
    const savedSegments = savedCwd.split("/").filter((segment) => segment && segment !== ".");
    // The working directory and each ancestor up to the vault root, under every root spelling.
    const relativeDirectories = savedCwd === ".." ? [] : [vaultRoot, vaultRootAlias]
      .filter((root): root is string => !!root && isAbsoluteNativePath(root))
      .flatMap((root) => Array.from({ length: savedSegments.length + 1 }, (_, up): [string, string] => [
        [root, ...savedSegments.slice(0, savedSegments.length - up)].join("/"),
        Array.from({ length: up }, () => "..").join("/") || ".",
      ]));
    const portableText = nativePathPrefixRewriter([...relativeDirectories, ...(homeDirectory ? [[homeDirectory, "~"] as const] : [])]);
    const portablePath = (path: string): string => {
      const target = resolve(path);
      const targetPath = target.vaultPath ?? (target.displayPath === "Vault root" ? "." : null);
      if (targetPath === null) {
        return target.displayPath.startsWith("~/") ? target.displayPath.replace(/ \(outside vault\)$/u, "") : path;
      }
      if (savedCwd === "..") return path;
      const from = savedSegments;
      const to = targetPath.split("/").filter((segment) => segment && segment !== ".");
      let common = 0;
      while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
      return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/") || ".";
    };
    const portableInput = (value: unknown, key = ""): unknown => {
      if (typeof value === "string") return ["file_path", "path", "move_path", "cwd", "workingDirectory"].includes(key) ? portablePath(value) : portableText(value);
      if (Array.isArray(value)) return value.map((item) => portableInput(item, key));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, portableInput(item, field)]));
    };
    let request = tool.request;
    if (request?.function?.arguments) {
      let input: unknown;
      try { input = JSON.parse(request.function.arguments); } catch { /* In-flight, incomplete arguments stay text. */ }
      const argumentsText = input === undefined ? portableText(request.function.arguments) : JSON.stringify(portableInput(input));
      request = { ...request, function: { ...request.function, arguments: argumentsText } };
    }
    if (typeof native.description === "string") native.description = portableText(native.description);
    return { ...tool, native, ...(request ? { request } : {}), ...(tool.result ? { result: portableInput(tool.result) as ToolCall["result"] } : {}) };
  }

  /** Escape & first so literal entities also survive a save/load exactly. */
  private static escapeMarkers(text: string): string {
    return text.replace(/&/gu, "&amp;").replace(/\r/gu, "&#13;").replace(/<!-- (?:SYSTEMSCULPT-|REASONING|TOOL-CALLS)/gu,
      (marker) => `&lt;${marker.slice(1)}`);
  }

  private static unescapeMarkers(text: string): string {
    return text.replace(/&lt;(?=!-- (?:SYSTEMSCULPT-|REASONING|TOOL-CALLS))|&amp;|&#13;/gu,
      (entity) => entity === "&amp;" ? "&" : entity === "&#13;" ? "\r" : "<");
  }

  private static escapeReasoning(text: string): string {
    return text.replace(
      REASONING_CLOSER_RUN,
      (_run, backslashes: string, bang: string) => `--${backslashes}\\${bang}>`,
    );
  }

  private static unescapeReasoning(text: string): string {
    return text.replace(
      ESCAPED_REASONING_CLOSER_RUN,
      (_run, backslashes: string, bang: string) => `--${backslashes}${bang}>`,
    );
  }

  /** Unknown or repeated escape declarations fail closed. */
  private static textEscape(attributes: string, attribute: string): "verbatim" | "escaped" | "invalid" {
    const declarations = [...attributes.matchAll(
      new RegExp(`(?:^|\\s)${attribute}="([^"]*)"(?=\\s|$)`, "gu"),
    )];
    if (declarations.length === 0) return "verbatim";
    return declarations.length === 1 && declarations[0][1] === REASONING_ESCAPE_VERSION
      ? "escaped"
      : "invalid";
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
