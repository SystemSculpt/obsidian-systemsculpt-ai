import { sha256HexFromBytesPortable } from "../../../studio/hash";
import type {
  ChatAttachmentContentRef,
  ChatAttachmentMetadata,
  ChatMessage,
  MultiPartContent,
} from "../../../types";
import {
  attachmentPartPayloadBytes,
  createImageAttachmentPart,
  createUnavailableAttachmentPart,
  parseAttachedTextContent,
} from "./ChatAttachmentContent";

const CHAT_ATTACHMENT_REF_SCHEMA = "systemsculpt-chat-attachment-v1" as const;
export const CHAT_ATTACHMENT_STORE_ROOT = ".systemsculpt/chat-attachments";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const REFERENCE_IMAGE_PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XyG7WQAAAABJRU5ErkJggg==";
const ATTACHMENT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ATTACHMENT_SWEEP_RETRY_MS = 5 * 60 * 1000;

export type ChatAttachmentStoreAdapter = Readonly<{
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  readBinary: (path: string) => Promise<ArrayBuffer>;
  writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  remove?: (path: string) => Promise<void>;
  stat?: (path: string) => Promise<{ mtime: number; ctime?: number } | null>;
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

type AttachmentStoreState = {
  /** Shared by every chat view bound to the same vault adapter. */
  pendingWrites: Map<string, Promise<void>>;
  pendingRemovals: Map<string, Promise<void>>;
  /**
   * In-memory attachments are intentionally protected for the rest of this
   * plugin session. A cancelled queue item becomes collectible after restart,
   * while another open view can never race a still-live composer attachment.
   */
  sessionClaims: Set<string>;
  sweepInFlight: Promise<boolean> | null;
  sweepCompleted: boolean;
  sweepLastAttempt: number;
};

const ATTACHMENT_STORE_STATES = new WeakMap<object, AttachmentStoreState>();

function attachmentStoreState(adapter: ChatAttachmentStoreAdapter): AttachmentStoreState {
  const key = adapter as object;
  const existing = ATTACHMENT_STORE_STATES.get(key);
  if (existing) return existing;
  const created: AttachmentStoreState = {
    pendingWrites: new Map(),
    pendingRemovals: new Map(),
    sessionClaims: new Set(),
    sweepInFlight: null,
    sweepCompleted: false,
    sweepLastAttempt: 0,
  };
  ATTACHMENT_STORE_STATES.set(key, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isChatAttachmentContentRef(value: unknown): value is ChatAttachmentContentRef {
  return isRecord(value)
    && Object.keys(value).every((key) => ["schema", "payload", "sha256", "byteLength"].includes(key))
    && value.schema === CHAT_ATTACHMENT_REF_SCHEMA
    && (value.payload === "image-bytes" || value.payload === "utf8-content-part")
    && typeof value.sha256 === "string"
    && SHA256_HEX.test(value.sha256)
    && Number.isSafeInteger(value.byteLength)
    && (value.byteLength as number) >= 0;
}

export function isPersistedReadyAttachment(value: unknown): value is PersistedReadyAttachment {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "id", "name", "mimeType", "byteLength", "kind", "contentRef",
    ].includes(key))
    && typeof value.id === "string"
    && !!value.id.trim()
    && typeof value.name === "string"
    && !!value.name.trim()
    && typeof value.mimeType === "string"
    && !!value.mimeType.trim()
    && Number.isSafeInteger(value.byteLength)
    && (value.byteLength as number) >= 0
    && (value.kind === "document" || value.kind === "image" || value.kind === "text")
    && isChatAttachmentContentRef(value.contentRef)
    && (value.kind === "image"
      ? value.contentRef.payload === "image-bytes"
      : value.contentRef.payload === "utf8-content-part");
}

export function chatAttachmentRefKey(ref: ChatAttachmentContentRef): string {
  return `${ref.payload}:${ref.sha256}`;
}

export function isChatAttachmentReferencePlaceholder(part: MultiPartContent): boolean {
  return part.type === "text"
    ? part.text === ""
    : part.image_url.url === REFERENCE_IMAGE_PLACEHOLDER;
}

export function collectChatAttachmentRefKeys(
  messages: readonly Readonly<ChatMessage>[],
): ReadonlySet<string> {
  const references = new Set<string>();
  for (const message of messages) {
    for (const metadata of message.attachmentMetadata ?? []) {
      if (metadata.contentRef && isChatAttachmentContentRef(metadata.contentRef)) {
        references.add(chatAttachmentRefKey(metadata.contentRef));
      }
    }
  }
  return references;
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
  private readonly state: AttachmentStoreState;

  public constructor(
    private readonly adapter: ChatAttachmentStoreAdapter,
    private readonly now: () => number = Date.now,
  ) {
    this.state = attachmentStoreState(adapter);
  }

  public async externalizeAttachments<T extends RuntimeReadyAttachmentLike>(
    attachments: readonly T[],
  ): Promise<readonly (T & Readonly<{ contentRef: ChatAttachmentContentRef }>)[]> {
    const results: Array<T & Readonly<{ contentRef: ChatAttachmentContentRef }>> = [];
    for (const attachment of attachments) {
      const { ref, bytes } = buildRef(attachment.contentPart);
      this.claim(ref);
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
    const persisted = {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      kind: attachment.kind,
      contentRef,
    };
    if (!isPersistedReadyAttachment(persisted)) {
      throw new Error(`Attachment ${attachment.name} has an incompatible durable reference.`);
    }
    return Object.freeze(persisted);
  }

  public async hydratePersistedAttachment(
    attachment: PersistedReadyAttachment,
  ): Promise<RuntimeReadyAttachmentLike & Readonly<{ contentRef: ChatAttachmentContentRef }>> {
    if (!isPersistedReadyAttachment(attachment)) {
      throw new Error("Saved queued attachment metadata is invalid.");
    }
    this.claim(attachment.contentRef);
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

  /**
   * Restores only the small queue/composer descriptor. The content bytes stay
   * in CAS until accepted request preparation (or an explicit retry) asks for
   * them.
   */
  public referencePersistedAttachment(
    attachment: PersistedReadyAttachment,
  ): RuntimeReadyAttachmentLike & Readonly<{ contentRef: ChatAttachmentContentRef }> {
    if (!isPersistedReadyAttachment(attachment)) {
      throw new Error("Saved queued attachment metadata is invalid.");
    }
    this.claim(attachment.contentRef);
    return Object.freeze({
      status: "ready" as const,
      ...attachment,
      contentPart: attachment.kind === "image"
        ? Object.freeze({
            type: "image_url" as const,
            image_url: Object.freeze({ url: REFERENCE_IMAGE_PLACEHOLDER }),
          })
        : Object.freeze({ type: "text" as const, text: "" }),
    });
  }

  /**
   * Gives the serializer type-correct attachment slots for a compact, lazy
   * message without reading its CAS payload. This prevents a metadata-only
   * chat save from silently dropping attachment references.
   */
  public materializeMessageReferences(message: Readonly<ChatMessage>): ChatMessage {
    const metadata = message.attachmentMetadata;
    if (!metadata?.some((item) => item.contentRef)) return { ...message };

    const baseParts: MultiPartContent[] = Array.isArray(message.content)
      ? [...message.content]
      : (typeof message.content === "string" && message.content.length > 0)
        ? [{ type: "text", text: message.content.replace(/^\r?\n/, "") }]
        : [];
    const occupied = new Set(metadata.map((item) => item.contentPartIndex));
    const ordinaryParts = baseParts.filter((_part, index) => !occupied.has(index));
    const rebuiltMetadata: ChatAttachmentMetadata[] = [];
    const attachmentParts: MultiPartContent[] = [];

    for (const item of [...metadata].sort((left, right) => left.contentPartIndex - right.contentPartIndex)) {
      if (!Number.isSafeInteger(item.contentPartIndex) || item.contentPartIndex < 0) {
        throw new Error(`Attachment ${item.name} has an invalid content position.`);
      }
      let part: MultiPartContent | undefined;
      if (item.contentRef && isChatAttachmentContentRef(item.contentRef)) {
        const descriptor = this.referencePersistedAttachment({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
          byteLength: item.byteLength,
          kind: item.kind,
          contentRef: item.contentRef,
        });
        part = descriptor.contentPart;
      } else if (!item.contentRef) {
        part = baseParts[item.contentPartIndex];
      } else {
        throw new Error(`Attachment ${item.name} has an invalid durable reference.`);
      }
      if (!part || (item.kind === "image" ? part.type !== "image_url" : part.type !== "text")) {
        throw new Error(`Attachment ${item.name} cannot be persisted without its content.`);
      }
      const contentPartIndex = ordinaryParts.length + attachmentParts.length;
      attachmentParts.push(part);
      rebuiltMetadata.push({ ...item, contentPartIndex });
    }

    return {
      ...message,
      content: [...ordinaryParts, ...attachmentParts],
      attachmentMetadata: rebuiltMetadata,
    };
  }

  /** Protects a live compact transcript from concurrent background cleanup. */
  public claimMessageReferences(messages: readonly Readonly<ChatMessage>[]): void {
    for (const key of collectChatAttachmentRefKeys(messages)) this.state.sessionClaims.add(key);
  }

  /**
   * Resolves one reference-backed durable message only when its payload is
   * actually needed (for a model request or an explicit retry). Chat loading
   * and history rendering intentionally keep these blobs out of memory.
   */
  public async hydrateMessage(message: Readonly<ChatMessage>): Promise<ChatMessage> {
    if (!message.attachmentMetadata?.length) return { ...message };

    const baseParts = Array.isArray(message.content)
      ? [...message.content]
      : (typeof message.content === "string" && message.content.trim().length > 0)
        ? [{ type: "text" as const, text: message.content.replace(/^\r?\n/, "") }]
        : [];
    const rebuiltMetadata = [...message.attachmentMetadata]
      .sort((left, right) => left.contentPartIndex - right.contentPartIndex);
    const occupied = new Set(rebuiltMetadata.map((metadata) => metadata.contentPartIndex));
    const rebuilt: MultiPartContent[] = baseParts.filter((part, index) =>
      !occupied.has(index) && !(part.type === "text" && parseAttachedTextContent(part.text)));
    const ordinaryPartCount = rebuilt.length;
    const nextMetadata: ChatAttachmentMetadata[] = [];
    for (const metadata of rebuiltMetadata) {
      let part: MultiPartContent | null | undefined;
      if (metadata.contentRef) {
        this.claim(metadata.contentRef);
        const compatible = metadata.kind === "image"
          ? metadata.contentRef.payload === "image-bytes"
          : metadata.contentRef.payload === "utf8-content-part";
        part = compatible
          ? await this.hydrateContentPart(metadata, { strict: false })
          : createUnavailableAttachmentPart(metadata.name, metadata.mimeType);
      } else {
        part = baseParts[metadata.contentPartIndex];
      }
      if (!part) continue;
      rebuilt.push(part);
      nextMetadata.push({
        ...metadata,
        contentPartIndex: ordinaryPartCount + nextMetadata.length,
      });
    }
    if (rebuilt.length === 0) return { ...message };
    return {
      ...message,
      content: rebuilt,
      ...(nextMetadata.length ? { attachmentMetadata: nextMetadata } : {}),
    };
  }

  public async hydrateMessages(messages: readonly Readonly<ChatMessage>[]): Promise<ChatMessage[]> {
    const hydrated: ChatMessage[] = [];
    // Serial reads avoid multiplying transient base64/ArrayBuffer pressure for
    // large mixed attachment histories. The final request still contains only
    // the bytes it actually needs.
    for (const message of messages) hydrated.push(await this.hydrateMessage(message));
    return hydrated;
  }

  /** Deletes only well-formed CAS files that no durable chat or queue refers to. */
  public async pruneUnreferenced(
    referencedKeys: ReadonlySet<string>,
    confirmReferences?: () => Promise<ReadonlySet<string> | null>,
  ): Promise<number> {
    if (!this.adapter.list
      || !this.adapter.remove
      || !this.adapter.stat
      || !await this.adapter.exists(CHAT_ATTACHMENT_STORE_ROOT)) return 0;

    const directories = [CHAT_ATTACHMENT_STORE_ROOT];
    const files: string[] = [];
    while (directories.length > 0) {
      const directory = directories.pop()!;
      const entries = await this.adapter.list(directory);
      files.push(...entries.files);
      directories.push(...entries.folders);
    }

    const candidates: Array<Readonly<{ path: string; key: string }>> = [];
    for (const path of files) {
      const prefix = `${CHAT_ATTACHMENT_STORE_ROOT}/`;
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const match = relative.match(/^([a-f0-9]{2})\/([a-f0-9]{64})\.(bin|txt)$/);
      if (!match || match[1] !== match[2].slice(0, 2)) continue;
      const key = `${match[3] === "bin" ? "image-bytes" : "utf8-content-part"}:${match[2]}`;
      const stat = await this.adapter.stat(path);
      const ctime = stat?.ctime;
      if (!stat
        || !Number.isFinite(stat.mtime)
        || !Number.isFinite(ctime)
        || this.now() - Math.max(stat.mtime, ctime as number) < ATTACHMENT_ORPHAN_GRACE_MS) continue;
      candidates.push({ path, key });
    }

    const confirmedReferences = confirmReferences ? await confirmReferences() : referencedKeys;
    if (!confirmedReferences) return 0;
    const reachable = new Set([...referencedKeys, ...confirmedReferences]);
    let removed = 0;
    for (const { path, key } of candidates) {
      // Recheck shared state at deletion time: another view may have admitted
      // this attachment after the directory scan began.
      if (this.state.pendingWrites.has(path)
        || this.state.pendingRemovals.has(path)
        || this.state.sessionClaims.has(key)
        || reachable.has(key)) continue;
      const removal = this.adapter.remove(path);
      this.state.pendingRemovals.set(path, removal);
      try {
        await removal;
        removed += 1;
      } finally {
        if (this.state.pendingRemovals.get(path) === removal) this.state.pendingRemovals.delete(path);
      }
    }
    return removed;
  }

  /**
   * Runs one conservative background mark/sweep per vault adapter and plugin
   * session. A failed-closed scan may retry later, but opening additional chat
   * views does not repeatedly walk the vault on mobile.
   */
  public pruneOncePerSession(
    discoverReferences: () => Promise<ReadonlySet<string> | null>,
  ): Promise<void> {
    if (this.state.sweepCompleted) return Promise.resolve();
    const now = this.now();
    if (!this.state.sweepInFlight
      && this.state.sweepLastAttempt > 0
      && now - this.state.sweepLastAttempt < ATTACHMENT_SWEEP_RETRY_MS) {
      return Promise.resolve();
    }
    if (!this.state.sweepInFlight) {
      this.state.sweepLastAttempt = now;
      this.state.sweepInFlight = (async () => {
        const references = await discoverReferences();
        if (!references) return false;
        let confirmationFailed = false;
        await this.pruneUnreferenced(references, async () => {
          const confirmed = await discoverReferences();
          if (!confirmed) confirmationFailed = true;
          return confirmed;
        });
        if (confirmationFailed) return false;
        return true;
      })().then((completed) => {
        if (completed) this.state.sweepCompleted = true;
        return completed;
      }).finally(() => { this.state.sweepInFlight = null; });
    }
    return this.state.sweepInFlight.then(() => undefined);
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
    const removal = this.state.pendingRemovals.get(path);
    if (removal) await removal.catch(() => undefined);
    const pending = this.state.pendingWrites.get(path);
    if (pending) return pending;

    const write = this.writeOnce(path, ref, bytes);
    this.state.pendingWrites.set(path, write);
    try {
      await write;
    } finally {
      if (this.state.pendingWrites.get(path) === write) this.state.pendingWrites.delete(path);
    }
  }

  private claim(ref: ChatAttachmentContentRef): void {
    if (isChatAttachmentContentRef(ref)) this.state.sessionClaims.add(chatAttachmentRefKey(ref));
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
