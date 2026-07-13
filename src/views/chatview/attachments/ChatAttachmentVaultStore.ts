import { sha256HexFromBytesPortable } from "../../../studio/hash";
import type { ChatAttachmentContentRef, ChatAttachmentMetadata, MultiPartContent } from "../../../types";
import {
  attachmentPartPayloadBytes,
  createImageAttachmentPart,
  createUnavailableAttachmentPart,
} from "./ChatAttachmentContent";

const CHAT_ATTACHMENT_REF_SCHEMA = "systemsculpt-chat-attachment-v1" as const;
const CHAT_ATTACHMENT_STORE_ROOT = ".systemsculpt/chat-attachments";
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type ChatAttachmentStoreAdapter = Readonly<{
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  readBinary: (path: string) => Promise<ArrayBuffer>;
  writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
}>;

export type PersistedReadyAttachment = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  kind: "document" | "image" | "text";
  contentRef: ChatAttachmentContentRef;
}>;

type RuntimeReadyAttachmentLike = Readonly<{
  status: "ready";
  id: string;
  name: string;
  mimeType: string;
  byteLength: number;
  kind: "document" | "image" | "text";
  contentPart: MultiPartContent;
  contentRef?: ChatAttachmentContentRef;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isChatAttachmentContentRef(value: unknown): value is ChatAttachmentContentRef {
  return isRecord(value)
    && value.schema === CHAT_ATTACHMENT_REF_SCHEMA
    && (value.payload === "image-bytes" || value.payload === "utf8-content-part")
    && typeof value.sha256 === "string"
    && SHA256_HEX.test(value.sha256)
    && Number.isSafeInteger(value.byteLength)
    && (value.byteLength as number) >= 0;
}

export function isPersistedReadyAttachment(value: unknown): value is PersistedReadyAttachment {
  return isRecord(value)
    && typeof value.id === "string"
    && !!value.id.trim()
    && typeof value.name === "string"
    && !!value.name.trim()
    && typeof value.mimeType === "string"
    && !!value.mimeType.trim()
    && Number.isSafeInteger(value.byteLength)
    && (value.byteLength as number) >= 0
    && (value.kind === "document" || value.kind === "image" || value.kind === "text")
    && isChatAttachmentContentRef(value.contentRef);
}

function dirname(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? path.slice(0, separator) : "";
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function buildRef(part: MultiPartContent): Readonly<{ ref: ChatAttachmentContentRef; bytes: Uint8Array }> {
  const bytes = attachmentPartPayloadBytes(part);
  if (!bytes) {
    throw new Error("Only valid image and text attachment payloads can be stored.");
  }
  const payload = part.type === "image_url" ? "image-bytes" as const : "utf8-content-part" as const;
  return Object.freeze({
    ref: Object.freeze({
      schema: CHAT_ATTACHMENT_REF_SCHEMA,
      payload,
      sha256: sha256HexFromBytesPortable(bytes),
      byteLength: bytes.byteLength,
    }),
    bytes,
  });
}

export class ChatAttachmentVaultStore {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  public constructor(private readonly adapter: ChatAttachmentStoreAdapter) {}

  public async externalizeAttachments<T extends RuntimeReadyAttachmentLike>(
    attachments: readonly T[],
  ): Promise<readonly (T & Readonly<{ contentRef: ChatAttachmentContentRef }>)[]> {
    const results: Array<T & Readonly<{ contentRef: ChatAttachmentContentRef }>> = [];
    for (const attachment of attachments) {
      const { ref, bytes } = buildRef(attachment.contentPart);
      await this.write(ref, bytes);
      results.push(Object.freeze({
        ...attachment,
        contentRef: ref,
      }) as T & Readonly<{ contentRef: ChatAttachmentContentRef }>);
    }
    return Object.freeze(results);
  }

  public dehydrateAttachment(attachment: RuntimeReadyAttachmentLike): PersistedReadyAttachment {
    const contentRef = attachment.contentRef;
    if (!contentRef || !isChatAttachmentContentRef(contentRef)) {
      throw new Error(`Attachment ${attachment.name} is missing durable storage.`);
    }
    return Object.freeze({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      kind: attachment.kind,
      contentRef,
    });
  }

  public async hydratePersistedAttachment(
    attachment: PersistedReadyAttachment,
  ): Promise<RuntimeReadyAttachmentLike & Readonly<{ contentRef: ChatAttachmentContentRef }>> {
    const contentPart = await this.hydrateContentPart({
      name: attachment.name,
      mimeType: attachment.mimeType,
      contentRef: attachment.contentRef,
    });
    if (!contentPart || (attachment.kind === "image" ? contentPart.type !== "image_url" : contentPart.type !== "text")) {
      throw new Error(`Attachment ${attachment.name} could not be restored.`);
    }
    return Object.freeze({
      status: "ready" as const,
      ...attachment,
      contentPart,
    });
  }

  public async hydrateContentPart(
    metadata: Pick<ChatAttachmentMetadata, "name" | "mimeType" | "contentRef">,
    options: Readonly<{ strict?: boolean }> = {},
  ): Promise<MultiPartContent | null> {
    if (!metadata.contentRef || !isChatAttachmentContentRef(metadata.contentRef)) return null;
    try {
      const bytes = await this.read(metadata.contentRef);
      return metadata.contentRef.payload === "image-bytes"
        ? createImageAttachmentPart(metadata.mimeType, bytes)
        : Object.freeze({
            type: "text" as const,
            text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
          });
    } catch (error) {
      if (options.strict !== false) throw error;
      return createUnavailableAttachmentPart(metadata.name, metadata.mimeType);
    }
  }

  private path(ref: ChatAttachmentContentRef): string {
    const extension = ref.payload === "image-bytes" ? "bin" : "txt";
    return `${CHAT_ATTACHMENT_STORE_ROOT}/${ref.sha256.slice(0, 2)}/${ref.sha256}.${extension}`;
  }

  private async write(ref: ChatAttachmentContentRef, bytes: Uint8Array): Promise<void> {
    const path = this.path(ref);
    const pending = this.pendingWrites.get(path);
    if (pending) return pending;

    const write = this.writeOnce(path, ref, bytes);
    this.pendingWrites.set(path, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(path) === write) this.pendingWrites.delete(path);
    }
  }

  private async writeOnce(
    path: string,
    ref: ChatAttachmentContentRef,
    bytes: Uint8Array,
  ): Promise<void> {
    if (await this.adapter.exists(path)) {
      await this.read(ref);
      return;
    }
    await this.mkdirRecursive(dirname(path));
    // Recheck after directory creation so another store instance can win the
    // race without turning the content-addressed payload into a rewrite log.
    if (await this.adapter.exists(path)) {
      await this.read(ref);
      return;
    }
    await this.adapter.writeBinary(path, arrayBuffer(bytes));
  }

  private async read(ref: ChatAttachmentContentRef): Promise<Uint8Array> {
    const path = this.path(ref);
    if (!await this.adapter.exists(path)) {
      throw new Error(`Attachment payload ${ref.sha256} is missing.`);
    }
    const bytes = new Uint8Array(await this.adapter.readBinary(path));
    if (bytes.byteLength !== ref.byteLength || sha256HexFromBytesPortable(bytes) !== ref.sha256) {
      throw new Error(`Attachment payload ${ref.sha256} is corrupt.`);
    }
    return bytes;
  }

  private async mkdirRecursive(path: string): Promise<void> {
    if (!path) return;
    let current = "";
    for (const segment of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!await this.adapter.exists(current)) {
        await this.adapter.mkdir(current);
      }
    }
  }
}
