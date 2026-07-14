import { sha256HexFromBytesPortable } from "../../studio/hash";
import type { AgentQueuedFollowUp } from "./AgentWorkspace";
import type { ChatMessageAttachment } from "./attachments/ChatMessageAttachments";
import {
  ChatAttachmentVaultStore,
  chatAttachmentRefKey,
  isPersistedReadyAttachment,
  type PersistedReadyAttachment,
} from "./attachments/ChatAttachmentVaultStore";

const QUEUE_SCHEMA_VERSION = 1 as const;
const QUEUE_ROOT = ".systemsculpt/chat-queues";

export type AgentQueueStorageAdapter = Readonly<{
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  read: (path: string) => Promise<string>;
  write: (path: string, contents: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
}>;

type QueueRecord = Readonly<{
  schemaVersion: typeof QUEUE_SCHEMA_VERSION;
  key: string;
  updatedAt: string;
  items: readonly StoredQueueItem[];
}>;

type StoredQueueItem = Readonly<{
  id: string;
  text: string;
  webSearch: boolean;
  includeContextFiles: boolean;
  attachments?: readonly PersistedReadyAttachment[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAttachment(value: unknown): value is ChatMessageAttachment {
  if (!isRecord(value) || value.status !== "ready") return false;
  if (!Object.keys(value).every((key) => [
    "status", "id", "name", "mimeType", "byteLength", "kind", "contentPart", "contentRef",
  ].includes(key))) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;
  if (typeof value.mimeType !== "string" || !value.mimeType.trim()) return false;
  if (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) return false;
  if (!["document", "image", "text"].includes(String(value.kind))) return false;
  if (!isRecord(value.contentPart) || typeof value.contentPart.type !== "string") return false;
  return true;
}

function isStoredQueueItem(value: unknown): value is StoredQueueItem {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => [
    "id", "text", "webSearch", "includeContextFiles", "attachments",
  ].includes(key))) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.text !== "string") return false;
  if (typeof value.webSearch !== "boolean" || typeof value.includeContextFiles !== "boolean") return false;
  if (typeof value.attachments === "undefined") return value.text.trim().length > 0;
  return Array.isArray(value.attachments)
    && value.attachments.length > 0
    && value.attachments.every(isPersistedReadyAttachment);
}

function isQueueItem(value: unknown): value is AgentQueuedFollowUp {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => [
    "id", "text", "webSearch", "includeContextFiles", "attachments",
  ].includes(key))) return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.text !== "string") return false;
  if (typeof value.webSearch !== "boolean" || typeof value.includeContextFiles !== "boolean") return false;
  if (typeof value.attachments === "undefined") return value.text.trim().length > 0;
  return Array.isArray(value.attachments)
    && value.attachments.length > 0
    && value.attachments.every(isAttachment);
}

/**
 * Durable queue port. Attachments are written once into the vault store and
 * queue state keeps only compact descriptors plus content references.
 */
export class AgentQueueStateRepository {
  public constructor(
    private readonly adapter: AgentQueueStorageAdapter,
    private readonly attachments: ChatAttachmentVaultStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async load(key: string): Promise<readonly AgentQueuedFollowUp[]> {
    const normalizedKey = this.normalizeKey(key);
    const path = this.path(normalizedKey);
    if (!await this.adapter.exists(path)) return Object.freeze([]);
    let parsed: unknown;
    try { parsed = JSON.parse(await this.adapter.read(path)) as unknown; }
    catch { throw new Error("Saved queued follow-ups are corrupted."); }
    if (!isRecord(parsed)
      || parsed.schemaVersion !== QUEUE_SCHEMA_VERSION
      || parsed.key !== normalizedKey
      || typeof parsed.updatedAt !== "string"
      || !Array.isArray(parsed.items)
      || !parsed.items.every(isStoredQueueItem)) {
      throw new Error("Saved queued follow-ups are invalid.");
    }
    return Object.freeze(parsed.items.map((item) => ({
      id: item.id,
      text: item.text,
      webSearch: item.webSearch,
      includeContextFiles: item.includeContextFiles,
      ...(item.attachments?.length ? {
        attachments: Object.freeze(item.attachments.map((attachment) =>
          this.attachments.referencePersistedAttachment(attachment))),
      } : {}),
    })));
  }

  public async save(key: string, items: readonly AgentQueuedFollowUp[]): Promise<void> {
    const normalizedKey = this.normalizeKey(key);
    if (!items.every(isQueueItem)) {
      throw new Error("Only valid follow-ups can be queued for a chat.");
    }
    const path = this.path(normalizedKey);
    if (items.length === 0) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
      return;
    }
    await this.ensureRoot();
    const record: QueueRecord = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      key: normalizedKey,
      updatedAt: this.now().toISOString(),
      items: await Promise.all(items.map(async (item) => ({
        id: item.id,
        text: item.text,
        webSearch: item.webSearch,
        includeContextFiles: item.includeContextFiles,
        ...(item.attachments?.length ? {
          attachments: Object.freeze(await Promise.all(item.attachments.map(async (attachment) => {
            if (attachment.contentRef) return this.attachments.dehydrateAttachment(attachment);
            const [externalized] = await this.attachments.externalizeAttachments([attachment]);
            return this.attachments.dehydrateAttachment(externalized);
          }))),
        } : {}),
      }))),
    };
    await this.adapter.write(path, JSON.stringify(record));
  }

  public async move(fromKey: string, toKey: string, items: readonly AgentQueuedFollowUp[]): Promise<void> {
    const from = this.normalizeKey(fromKey);
    const to = this.normalizeKey(toKey);
    await this.save(to, items);
    if (from !== to) await this.save(from, []);
  }

  /** Returns every attachment reachable from a durable queue record. */
  public async collectAttachmentRefKeys(): Promise<ReadonlySet<string> | null> {
    if (!this.adapter.list) return null;
    try {
      if (!await this.adapter.exists(QUEUE_ROOT)) return new Set();
      const entries = await this.adapter.list(QUEUE_ROOT);
      if (entries.folders.length > 0 || entries.files.some((candidate) => !candidate.endsWith(".json"))) {
        return null;
      }
      const references = new Set<string>();
      for (const path of entries.files) {
        const parsed = JSON.parse(await this.adapter.read(path)) as unknown;
        if (!isRecord(parsed)
          || parsed.schemaVersion !== QUEUE_SCHEMA_VERSION
          || typeof parsed.key !== "string"
          || typeof parsed.updatedAt !== "string"
          || !Number.isFinite(Date.parse(parsed.updatedAt))
          || !Array.isArray(parsed.items)
          || !parsed.items.every(isStoredQueueItem)) {
          return null;
        }
        let normalizedKey: string;
        try { normalizedKey = this.normalizeKey(parsed.key); }
        catch { return null; }
        if (normalizedKey !== parsed.key || this.path(normalizedKey) !== path) return null;
        for (const item of parsed.items) {
          for (const attachment of item.attachments ?? []) {
            references.add(chatAttachmentRefKey(attachment.contentRef));
          }
        }
      }
      return references;
    } catch {
      return null;
    }
  }

  private normalizeKey(key: string): string {
    const normalized = key.trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
      throw new Error("Queued follow-ups require a valid chat draft key.");
    }
    return normalized;
  }

  private path(key: string): string {
    const digest = sha256HexFromBytesPortable(new TextEncoder().encode(key));
    return `${QUEUE_ROOT}/${digest}.json`;
  }

  private async ensureRoot(): Promise<void> {
    if (!await this.adapter.exists(".systemsculpt")) await this.adapter.mkdir(".systemsculpt");
    if (!await this.adapter.exists(QUEUE_ROOT)) await this.adapter.mkdir(QUEUE_ROOT);
  }
}
