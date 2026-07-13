import type {
  ChatAttachmentContentRef,
  ChatAttachmentMetadata,
  ChatMessage,
  MultiPartContent,
} from "../../../types";
import { sha256HexFromBytesPortable } from "../../../studio/hash";
import {
  DEFAULT_MANAGED_CHAT_INPUT_LIMITS,
  type ManagedChatInputLimits,
} from "../../../services/managed/ManagedChatInputLimits";
import {
  createImageAttachmentPart,
  createTextAttachmentPart,
  parseAttachedTextContent,
  parseImageDataUrl,
} from "./ChatAttachmentContent";

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, "image/png" | "image/jpeg" | "image/webp">> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cpp", "css", "csv", "go", "h", "hpp", "htm", "html", "ini", "java",
  "js", "json", "jsonl", "jsx", "log", "md", "markdown", "mjs", "py", "rb", "rs", "sh",
  "sql", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml", "zsh",
]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/xml",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "application/x-yaml",
]);

export const CHAT_ATTACHMENT_PICKER_ACCEPT = [
  "image/png", "image/jpeg", "image/webp", "application/pdf", ".pdf",
  ...[...TEXT_EXTENSIONS].map((extension) => `.${extension}`),
].join(",");

export function isPdfAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.split(";", 1)[0].trim().toLowerCase() === "application/pdf" || extensionOf(file.name) === "pdf";
}

export type ChatMessageAttachment = Readonly<{
  status: "ready";
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  kind: "document" | "image" | "text";
  contentPart: MultiPartContent;
  contentRef?: ChatAttachmentContentRef;
}>;

export type RestoredChatMessageDraft = Readonly<{
  text: string;
  attachments: readonly ChatMessageAttachment[];
}>;

export type FailedChatMessageAttachment = Readonly<{
  status: "failed";
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  kind: "document";
  error: string;
}>;

export type ChatAttachmentDisplay = ChatMessageAttachment | FailedChatMessageAttachment;

export type ChatDocumentAttachmentProcessor = Readonly<{
  prepare: (input: Readonly<{
    name: string;
    mimeType: "application/pdf";
    bytes: ArrayBuffer;
    fingerprint: `sha256:${string}`;
  }>) => Promise<Readonly<{ operationId: string; markdown: string }>>;
  complete: (operationId: string) => Promise<void>;
  discard: (operationId: string) => Promise<void>;
}>;

export type ChatAttachmentIssueCode =
  | "content_block_limit"
  | "duplicate"
  | "empty"
  | "file_limit"
  | "image_limit"
  | "read_failed"
  | "processing_failed"
  | "request_limit"
  | "text_limit"
  | "too_large"
  | "total_limit"
  | "unsupported";

export type ChatAttachmentIssue = Readonly<{
  code: ChatAttachmentIssueCode;
  fileName: string;
  message: string;
}>;

export type ChatAttachmentIngestionResult = Readonly<{
  accepted: readonly ChatMessageAttachment[];
  issues: readonly ChatAttachmentIssue[];
}>;

export type BrowserFileReader = (file: File) => Promise<ArrayBuffer>;

function extensionOf(name: string): string {
  const leaf = name.split(/[\\/]/).pop() || name;
  const separator = leaf.lastIndexOf(".");
  return separator > 0 && separator < leaf.length - 1 ? leaf.slice(separator + 1).toLowerCase() : "";
}

function safeFileName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() || "attachment";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 180);
  return cleaned || "attachment";
}

function normalizeImageMime(file: Pick<File, "name" | "type">): string | null {
  const declared = file.type.trim().toLowerCase();
  if (declared === "image/jpg") return "image/jpeg";
  if (declared === "image/png" || declared === "image/jpeg" || declared === "image/webp") return declared;
  return IMAGE_MIME_BY_EXTENSION[extensionOf(file.name)] ?? null;
}

function normalizeTextMime(file: Pick<File, "name" | "type">): string | null {
  const declared = file.type.split(";", 1)[0].trim().toLowerCase();
  const supported = declared.startsWith("text/") || TEXT_MIME_TYPES.has(declared) || TEXT_EXTENSIONS.has(extensionOf(file.name));
  if (!supported) return null;
  return declared || "text/plain";
}

function issue(code: ChatAttachmentIssueCode, fileName: string, message: string): ChatAttachmentIssue {
  return Object.freeze({ code, fileName, message });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatMebibytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

export async function readBrowserFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("The file reader returned an unexpected result."));
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Owns ephemeral message attachments. Vault context remains a separate durable
 * concern; every paste, drop, and native picker funnels through this one gate.
 */
export class ChatMessageAttachmentCollection {
  private readonly entries = new Map<string, ChatAttachmentDisplay>();
  private readonly retryDocuments = new Map<string, Readonly<{ file: File; bytes: ArrayBuffer; fingerprint: `sha256:${string}` }>>();
  private limits: ManagedChatInputLimits;

  public constructor(
    private readonly read: BrowserFileReader = readBrowserFile,
    private readonly documentProcessor?: ChatDocumentAttachmentProcessor,
    limits: ManagedChatInputLimits = DEFAULT_MANAGED_CHAT_INPUT_LIMITS,
  ) {
    this.limits = limits;
  }

  public setLimits(limits: ManagedChatInputLimits): void {
    this.limits = limits;
  }

  public snapshot(): readonly ChatMessageAttachment[] {
    return Object.freeze([...this.entries.values()].filter(
      (entry): entry is ChatMessageAttachment => entry.status === "ready",
    ));
  }

  public displaySnapshot(): readonly ChatAttachmentDisplay[] {
    return Object.freeze([...this.entries.values()]);
  }

  public hasAny(): boolean {
    return this.snapshot().length > 0;
  }

  public hasEntries(): boolean {
    return this.entries.size > 0;
  }

  public hasBlockingFailures(): boolean {
    return [...this.entries.values()].some((entry) => entry.status === "failed");
  }

  public clear(): void {
    this.entries.clear();
    this.retryDocuments.clear();
  }

  public replace(attachments: readonly ChatMessageAttachment[]): void {
    this.clear();
    for (const attachment of attachments) {
      if (this.entries.has(attachment.id)) continue;
      this.entries.set(attachment.id, attachment);
    }
  }

  public mergeReady(
    attachments: readonly ChatMessageAttachment[],
    placement: "append" | "prepend" = "append",
  ): void {
    const current = [...this.entries.values()];
    const ordered: readonly ChatAttachmentDisplay[] = placement === "prepend"
      ? [...attachments, ...current]
      : [...current, ...attachments];
    this.entries.clear();
    for (const attachment of ordered) {
      const existing = this.entries.get(attachment.id);
      if (!existing) {
        this.entries.set(attachment.id, attachment);
      } else if (placement === "prepend" && current.includes(attachment)) {
        // A newer current-draft entry wins a duplicate identity while retaining
        // the older attachment's chronological position.
        this.entries.set(attachment.id, attachment);
      }
    }
    for (const id of this.retryDocuments.keys()) {
      if (this.entries.get(id)?.status !== "failed") this.retryDocuments.delete(id);
    }
  }

  public remove(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.entries.delete(id);
    this.retryDocuments.delete(id);
    return true;
  }

  public async retry(id: string, userText = ""): Promise<ChatAttachmentIngestionResult> {
    const retry = this.retryDocuments.get(id);
    const failed = this.entries.get(id);
    if (!retry || failed?.status !== "failed" || !this.documentProcessor) {
      return Object.freeze({ accepted: Object.freeze([]), issues: Object.freeze([]) });
    }
    try {
      const attachment = await this.preparePdfAttachment(retry.file, retry.bytes, retry.fingerprint);
      const validation = this.validateSubmission(userText, [...this.snapshot(), attachment]);
      if (validation.length > 0) throw new Error(validation[0].message);
      this.entries.set(id, attachment);
      this.retryDocuments.delete(id);
      return Object.freeze({ accepted: Object.freeze([attachment]), issues: Object.freeze([]) });
    } catch (error) {
      const message = this.documentFailureMessage(failed.name, error);
      this.entries.set(id, Object.freeze({ ...failed, error: message }));
      return Object.freeze({
        accepted: Object.freeze([]),
        issues: Object.freeze([issue("processing_failed", failed.name, message)]),
      });
    }
  }

  public validateSubmission(
    userText: string,
    attachments: readonly ChatMessageAttachment[] = this.snapshot(),
  ): readonly ChatAttachmentIssue[] {
    const issues: ChatAttachmentIssue[] = [];
    const text = userText.trim();
    const blockCount = attachments.length + (text ? 1 : 0);
    const label = attachments[attachments.length - 1]?.name ?? "Message";
    if (blockCount > this.limits.maxContentBlocksPerMessage) {
      issues.push(issue(
        "content_block_limit",
        label,
        `A message can contain up to ${this.limits.maxContentBlocksPerMessage} text and image blocks. Remove an attachment or combine text files.`,
      ));
    }

    const images = attachments.filter((attachment) => attachment.kind === "image");
    if (images.length > this.limits.maxImagesPerTurn) {
      issues.push(issue(
        "image_limit",
        images[images.length - 1]?.name ?? label,
        `Attach up to ${this.limits.maxImagesPerTurn} images per message.`,
      ));
    }
    const imageBytes = images.reduce((total, attachment) => total + attachment.byteLength, 0);
    if (imageBytes > this.limits.maxTotalImageBytes) {
      issues.push(issue(
        "total_limit",
        images[images.length - 1]?.name ?? label,
        `Images in one message can total up to ${formatMebibytes(this.limits.maxTotalImageBytes)}.`,
      ));
    }

    const textBlocks = [
      ...(text ? [{ name: "Message", bytes: utf8Bytes(text) }] : []),
      ...attachments.flatMap((attachment) => attachment.contentPart.type === "text"
        ? [{ name: attachment.name, bytes: utf8Bytes(attachment.contentPart.text) }]
        : []),
    ];
    const oversizedText = textBlocks.find((block) => block.bytes > this.limits.maxTextBytesPerBlock);
    if (oversizedText) {
      issues.push(issue(
        "text_limit",
        oversizedText.name,
        `${oversizedText.name} exceeds the ${formatMebibytes(this.limits.maxTextBytesPerBlock)} text-block limit. Split or shorten it.`,
      ));
    }
    const textBytes = textBlocks.reduce((total, block) => total + block.bytes, 0);
    if (textBytes > this.limits.maxTotalTextBytes) {
      issues.push(issue(
        "total_limit",
        label,
        `Text in one message can total up to ${formatMebibytes(this.limits.maxTotalTextBytes)}. Remove or shorten an attachment.`,
      ));
    }

    const content = composeUserMessageContent(text, attachments);
    const contentBytes = utf8Bytes(JSON.stringify(content));
    const outerEnvelopeReserve = 64 * 1024;
    if (contentBytes > Math.max(0, this.limits.maxDeltaRequestBytes - outerEnvelopeReserve)) {
      issues.push(issue(
        "request_limit",
        label,
        `This mixed attachment message is too large to send reliably. Reduce the images or text.`,
      ));
    }
    return Object.freeze(issues);
  }

  public async addFiles(files: readonly File[], userText = ""): Promise<ChatAttachmentIngestionResult> {
    const accepted: ChatMessageAttachment[] = [];
    const issues: ChatAttachmentIssue[] = [];

    for (const file of files) {
      const name = safeFileName(file.name);
      const availableBlocks = this.limits.maxContentBlocksPerMessage - (userText.trim() ? 1 : 0);
      if (this.entries.size >= availableBlocks) {
        issues.push(issue("file_limit", name, `You can attach up to ${availableBlocks} files with this message.`));
        continue;
      }
      if (file.size <= 0) {
        issues.push(issue("empty", name, `${name} is empty.`));
        continue;
      }

      const pdf = isPdfAttachmentFile(file);
      const imageMime = pdf ? null : normalizeImageMime(file);
      const textMime = imageMime || pdf ? null : normalizeTextMime(file);
      if (!pdf && !imageMime && !textMime) {
        issues.push(issue("unsupported", name, `${name} is not supported. Attach PDF, image, Markdown, text, or source files.`));
        continue;
      }
      if (imageMime && !this.limits.imageMimeTypes.includes(imageMime)) {
        issues.push(issue("unsupported", name, `${name} uses an image format this SystemSculpt server does not accept.`));
        continue;
      }

      const maxBytes = pdf
        ? this.limits.maxDocumentBytes
        : imageMime ? this.limits.maxImageBytes : this.limits.maxTextBytesPerBlock;
      if (file.size > maxBytes) {
        issues.push(issue("too_large", name, `${name} is too large. The limit is ${formatMebibytes(maxBytes)} for this file type.`));
        continue;
      }
      const existingImages = this.snapshot().filter((attachment) => attachment.kind === "image");
      if (imageMime && existingImages.length >= this.limits.maxImagesPerTurn) {
        issues.push(issue("image_limit", name, `Attach up to ${this.limits.maxImagesPerTurn} images per message.`));
        continue;
      }
      if (imageMime && existingImages.reduce((total, attachment) => total + attachment.byteLength, 0) + file.size > this.limits.maxTotalImageBytes) {
        issues.push(issue("total_limit", name, `Images in one message can total up to ${formatMebibytes(this.limits.maxTotalImageBytes)}.`));
        continue;
      }

      let buffer: ArrayBuffer;
      try {
        buffer = await this.read(file);
      } catch {
        issues.push(issue("read_failed", name, `${name} could not be read.`));
        continue;
      }
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength === 0) {
        issues.push(issue("empty", name, `${name} is empty.`));
        continue;
      }
      const hash = sha256HexFromBytesPortable(bytes);
      const kind = pdf ? "document" as const : imageMime ? "image" as const : "text" as const;
      const id = `${kind}-${hash}`;
      if (this.entries.has(id)) {
        issues.push(issue("duplicate", name, `${name} is already attached.`));
        continue;
      }

      const fingerprint = `sha256:${hash}` as const;
      let attachment: ChatMessageAttachment;
      if (pdf) {
        if (!this.documentProcessor) {
          const message = `${name} needs document processing, which is unavailable right now.`;
          const failed = Object.freeze({ status: "failed" as const, id, name, mimeType: "application/pdf", byteLength: bytes.byteLength, kind: "document" as const, error: message });
          this.entries.set(id, failed);
          this.retryDocuments.set(id, Object.freeze({ file, bytes: buffer, fingerprint }));
          issues.push(issue("processing_failed", name, message));
          continue;
        }
        try {
          attachment = await this.preparePdfAttachment(file, buffer, fingerprint);
        } catch (error) {
          const message = this.documentFailureMessage(name, error);
          const failed = Object.freeze({ status: "failed" as const, id, name, mimeType: "application/pdf", byteLength: bytes.byteLength, kind: "document" as const, error: message });
          this.entries.set(id, failed);
          this.retryDocuments.set(id, Object.freeze({ file, bytes: buffer, fingerprint }));
          issues.push(issue("processing_failed", name, message));
          continue;
        }
      } else {
        const mimeType = imageMime ?? textMime!;
        attachment = Object.freeze({
          status: "ready" as const,
          id,
          name,
          mimeType,
          byteLength: bytes.byteLength,
          kind,
          contentPart: kind === "image"
            ? createImageAttachmentPart(mimeType, bytes)
            : createTextAttachmentPart(name, mimeType, bytes),
        });
      }
      const validation = this.validateSubmission(userText, [...this.snapshot(), attachment]);
      if (validation.length > 0) {
        issues.push(validation[0]);
        continue;
      }
      this.entries.set(id, attachment);
      accepted.push(attachment);
    }

    return Object.freeze({ accepted: Object.freeze(accepted), issues: Object.freeze(issues) });
  }

  private async preparePdfAttachment(
    file: File,
    bytes: ArrayBuffer,
    fingerprint: `sha256:${string}`,
  ): Promise<ChatMessageAttachment> {
    if (!this.documentProcessor) throw new Error("Document processing is unavailable.");
    const name = safeFileName(file.name);
    const prepared = await this.documentProcessor.prepare({
      name,
      mimeType: "application/pdf",
      bytes,
      fingerprint,
    });
    const markdownBytes = new TextEncoder().encode(prepared.markdown);
    const contentPart = createTextAttachmentPart(name, "application/pdf", markdownBytes);
    const contentBytes = contentPart.type === "text" ? utf8Bytes(contentPart.text) : 0;
    if (markdownBytes.byteLength < 1 || contentBytes > this.limits.maxTextBytesPerBlock) {
      await this.documentProcessor.discard(prepared.operationId);
      throw new Error(`The extracted document text is empty or exceeds ${formatMebibytes(this.limits.maxTextBytesPerBlock)}.`);
    }
    const attachment = Object.freeze({
      status: "ready" as const,
      id: `document-${fingerprint.slice("sha256:".length)}`,
      name,
      mimeType: "application/pdf",
      byteLength: bytes.byteLength,
      kind: "document" as const,
      contentPart,
    });
    try {
      // The extracted text is the entire local effect of this managed job.
      // Once the immutable ready attachment exists there is no later vault or
      // transcript commit to recover, so settle the operation immediately.
      await this.documentProcessor.complete(prepared.operationId);
    } catch (error) {
      await this.documentProcessor.discard(prepared.operationId).catch(() => undefined);
      throw error;
    }
    return attachment;
  }

  private documentFailureMessage(name: string, error: unknown): string {
    const detail = error instanceof Error ? error.message.trim() : "";
    return detail ? `${name} could not be processed: ${detail}` : `${name} could not be processed.`;
  }
}

export function composeUserMessageContent(
  text: string,
  attachments: readonly ChatMessageAttachment[] = [],
): string | MultiPartContent[] {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  const parts: MultiPartContent[] = [];
  if (trimmed) parts.push({ type: "text", text: trimmed });
  parts.push(...attachments.map((attachment) => attachment.contentPart));
  return parts;
}

export function composeAttachmentMetadata(
  text: string,
  attachments: readonly ChatMessageAttachment[] = [],
): ChatAttachmentMetadata[] | undefined {
  if (attachments.length === 0) return undefined;
  const firstAttachmentIndex = text.trim() ? 1 : 0;
  return attachments.map((attachment, index) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    kind: attachment.kind,
    contentPartIndex: firstAttachmentIndex + index,
    ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
  }));
}

function attachmentFromMetadata(
  metadata: ChatAttachmentMetadata,
  content: readonly MultiPartContent[],
): ChatMessageAttachment | null {
  if (!Number.isSafeInteger(metadata.contentPartIndex) || metadata.contentPartIndex < 0) return null;
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0) return null;
  if (!metadata.id || !metadata.name || !metadata.mimeType) return null;
  if (!["document", "image", "text"].includes(metadata.kind)) return null;
  const contentPart = content[metadata.contentPartIndex];
  if (!contentPart) return null;
  if (metadata.kind === "image" && contentPart.type !== "image_url") return null;
  if (metadata.kind !== "image" && contentPart.type !== "text") return null;
  if (contentPart.type === "text" && parseAttachedTextContent(contentPart.text)?.unavailable) return null;
  return Object.freeze({
    status: "ready" as const,
    id: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    kind: metadata.kind,
    contentPart,
    ...(metadata.contentRef ? { contentRef: metadata.contentRef } : {}),
  });
}

function fallbackAttachment(part: MultiPartContent, index: number): ChatMessageAttachment | null {
  if (part.type === "image_url") {
    const parsed = parseImageDataUrl(part.image_url.url);
    if (!parsed) return null;
    const { mimeType, bytes } = parsed;
    const hash = sha256HexFromBytesPortable(bytes);
    return Object.freeze({
      status: "ready" as const,
      id: `image-${hash}`,
      name: `Attached image ${index + 1}`,
      mimeType,
      byteLength: bytes.byteLength,
      kind: "image" as const,
      contentPart: part,
    });
  }
  const parsed = parseAttachedTextContent(part.text);
  if (!parsed || parsed.unavailable) return null;
  const bytes = new TextEncoder().encode(parsed.body);
  const kind = parsed.mimeType.toLowerCase() === "application/pdf" ? "document" as const : "text" as const;
  return Object.freeze({
    status: "ready" as const,
    id: `${kind}-${sha256HexFromBytesPortable(bytes)}`,
    name: safeFileName(parsed.name),
    mimeType: parsed.mimeType,
    byteLength: bytes.byteLength,
    kind,
    contentPart: part,
  });
}

/**
 * Rebuilds the editable composer draft from one durable user message. Modern
 * messages retain exact attachment identity; pre-metadata chats get a safe,
 * deterministic best-effort reconstruction from their stored content parts.
 */
export function restoreChatMessageDraft(message: Readonly<ChatMessage>): RestoredChatMessageDraft {
  if (typeof message.content === "string") {
    return Object.freeze({ text: message.content, attachments: Object.freeze([]) });
  }
  if (!Array.isArray(message.content)) {
    return Object.freeze({ text: "", attachments: Object.freeze([]) });
  }

  const content = message.content;
  const indexedAttachments = new Map<number, ChatMessageAttachment>();
  for (const metadata of message.attachmentMetadata ?? []) {
    const attachment = attachmentFromMetadata(metadata, content);
    if (attachment && !indexedAttachments.has(metadata.contentPartIndex)) {
      indexedAttachments.set(metadata.contentPartIndex, attachment);
    }
  }
  let imageIndex = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (indexedAttachments.has(index)) continue;
    const attachment = fallbackAttachment(content[index], imageIndex);
    if (!attachment) continue;
    indexedAttachments.set(index, attachment);
    if (attachment.kind === "image") imageIndex += 1;
  }

  const text = content
    .map((part, index) => indexedAttachments.has(index) || part.type !== "text" ? "" : part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const attachments = [...indexedAttachments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, attachment]) => attachment);
  return Object.freeze({ text, attachments: Object.freeze(attachments) });
}
