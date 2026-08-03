import type { DataAdapter } from "obsidian";

type JournalRecord = Readonly<{
  conversationId: string;
  toolCallId: string;
  fingerprint: string;
  state: "started" | "completed";
  result?: unknown;
  updatedAt: number;
}>;

type LegacyJournalFile = Readonly<{
  version: 2;
  records: readonly JournalRecord[];
}>;

type KeyedJournalFile = Readonly<{
  version: 1;
  record: JournalRecord;
}>;

type MutationJournalAdapter = Pick<DataAdapter, "exists" | "read" | "write" | "mkdir">
  & Partial<Pick<DataAdapter, "list" | "remove" | "stat">>;

const KEYED_RECORD_VERSION = 1;
const LEGACY_MIGRATION_MARKER = "_legacy-v2-migrated.json";
const RECORD_FILE_NAME = /^[a-f0-9]{64}\.json$/;
export const MAX_LEGACY_JOURNAL_CHARACTERS = 4 * 1024 * 1024;
export const MAX_LEGACY_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MAX_LEGACY_JOURNAL_RECORDS = 10_000;

export function canonicalAgentToolInput(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAgentToolInput).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalAgentToolInput(object[key])}`,
  ).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  // The vault journal is host-level state shared across popout windows.
  // eslint-disable-next-line obsidianmd/no-global-this
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(name: string, input: unknown): Promise<string> {
  return sha256(`${name}\n${canonicalAgentToolInput(input)}`);
}

function recordKey(conversationId: string, toolCallId: string): string {
  return JSON.stringify([conversationId, toolCallId]);
}

async function recordFileName(conversationId: string, toolCallId: string): Promise<string> {
  return `${await sha256(recordKey(conversationId, toolCallId))}.json`;
}

function parseRecord(value: unknown): JournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation journal contains an invalid record.");
  }
  const item = value as Record<string, unknown>;
  if (!(typeof item.conversationId === "string"
    && item.conversationId.length > 0
    && typeof item.toolCallId === "string"
    && item.toolCallId.length > 0
    && typeof item.fingerprint === "string"
    && /^[a-f0-9]{64}$/.test(item.fingerprint)
    && (item.state === "started" || item.state === "completed")
    && Number.isSafeInteger(item.updatedAt)
    && (item.updatedAt as number) >= 0
    && (item.state === "completed" || item.result === undefined))) {
    throw new Error("Mutation journal contains an invalid record.");
  }
  return {
    conversationId: item.conversationId,
    toolCallId: item.toolCallId,
    fingerprint: item.fingerprint,
    state: item.state,
    ...(item.state === "completed" ? { result: item.result } : {}),
    updatedAt: item.updatedAt as number,
  };
}

function parseLegacyJournal(value: unknown): LegacyJournalFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation journal must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2 || !Array.isArray(candidate.records)) {
    throw new Error("Mutation journal version is unsupported.");
  }
  if (candidate.records.length > MAX_LEGACY_JOURNAL_RECORDS) {
    throw new Error("Mutation journal has too many legacy records to migrate.");
  }
  const records = candidate.records.map(parseRecord);
  const keys = records.map((record) => recordKey(record.conversationId, record.toolCallId));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Mutation journal contains duplicate action identities.");
  }
  return { version: 2, records };
}

function parseKeyedJournal(value: unknown): JournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation journal record file must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== KEYED_RECORD_VERSION) {
    throw new Error("Mutation journal record version is unsupported.");
  }
  return parseRecord(candidate.record);
}

function parseMigrationMarker(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation journal migration marker is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.legacyVersion !== 2) {
    throw new Error("Mutation journal migration marker is invalid.");
  }
}

function recordsCanMerge(first: JournalRecord, second: JournalRecord): boolean {
  return first.fingerprint === second.fingerprint
    && (first.state !== "completed"
      || second.state !== "completed"
      || canonicalAgentToolInput(first.result) === canonicalAgentToolInput(second.result));
}

function mergeMigratedRecord(existing: JournalRecord, legacy: JournalRecord): JournalRecord {
  if (!recordsCanMerge(existing, legacy)) {
    throw new Error("Mutation journal migration found conflicting records.");
  }
  if (legacy.state === "completed" && existing.state === "started") return legacy;
  if (existing.state === "completed" && legacy.state === "started") return existing;
  return legacy.updatedAt > existing.updatedAt ? legacy : existing;
}

type SharedJournalState = {
  initialization: Promise<void> | null;
  operations: Promise<void>;
  directoryReady: boolean;
  unavailable: boolean;
};

const SHARED_JOURNALS = new WeakMap<object, Map<string, SharedJournalState>>();

function sharedJournalState(adapter: object, path: string): SharedJournalState {
  let byPath = SHARED_JOURNALS.get(adapter);
  if (!byPath) {
    byPath = new Map();
    SHARED_JOURNALS.set(adapter, byPath);
  }
  let state = byPath.get(path);
  if (!state) {
    state = {
      initialization: null,
      operations: Promise.resolve(),
      directoryReady: false,
      unavailable: false,
    };
    byPath.set(path, state);
  }
  return state;
}

export type ThinAgentMutationInspection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "replay"; result: unknown }>
  | Readonly<{ kind: "outcome-unknown" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "journal-unavailable" }>;

export type ThinAgentMutationClaim =
  | Readonly<{ kind: "execute" }>
  | Exclude<ThinAgentMutationInspection, Readonly<{ kind: "absent" }>>;

/**
 * Crash-safe receipt store for local vault mutations. Each action has one
 * keyed receipt file. Receipts live until their conversation is deleted.
 */
export class AgentMutationJournal {
  private readonly state: SharedJournalState;
  private readonly recordsPath: string;
  private readonly migrationMarkerPath: string;

  constructor(
    private readonly adapter: MutationJournalAdapter,
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = sharedJournalState(adapter, path);
    this.recordsPath = `${path}.records`;
    this.migrationMarkerPath = `${this.recordsPath}/${LEGACY_MIGRATION_MARKER}`;
  }

  public async inspect(
    conversationId: string,
    toolCallId: string,
    name: string,
    input: unknown,
  ): Promise<ThinAgentMutationInspection> {
    const [inputFingerprint, storagePath] = await Promise.all([
      fingerprint(name, input),
      this.recordPath(conversationId, toolCallId),
    ]);
    return this.serialize(async () => {
      await this.ensureInitialized();
      if (this.state.unavailable) return { kind: "journal-unavailable" };
      let existing: JournalRecord | null;
      try {
        existing = await this.readRecord(storagePath, conversationId, toolCallId);
      } catch {
        this.state.unavailable = true;
        return { kind: "journal-unavailable" };
      }
      if (!existing) return { kind: "absent" };
      if (existing.fingerprint !== inputFingerprint) return { kind: "conflict" };
      return existing.state === "completed"
        ? { kind: "replay", result: existing.result }
        : { kind: "outcome-unknown" };
    });
  }

  public async claim(
    conversationId: string,
    toolCallId: string,
    name: string,
    input: unknown,
  ): Promise<ThinAgentMutationClaim> {
    const [inputFingerprint, storagePath] = await Promise.all([
      fingerprint(name, input),
      this.recordPath(conversationId, toolCallId),
    ]);
    return this.serialize(async () => {
      await this.ensureInitialized();
      if (this.state.unavailable) return { kind: "journal-unavailable" };
      let existing: JournalRecord | null;
      try {
        existing = await this.readRecord(storagePath, conversationId, toolCallId);
      } catch {
        this.state.unavailable = true;
        return { kind: "journal-unavailable" };
      }
      if (existing) {
        if (existing.fingerprint !== inputFingerprint) return { kind: "conflict" };
        return existing.state === "completed"
          ? { kind: "replay", result: existing.result }
          : { kind: "outcome-unknown" };
      }
      const record: JournalRecord = {
        conversationId,
        toolCallId,
        fingerprint: inputFingerprint,
        state: "started",
        updatedAt: this.now(),
      };
      try {
        await this.writeRecord(storagePath, record);
      } catch (error) {
        this.state.unavailable = true;
        throw error;
      }
      return { kind: "execute" };
    });
  }

  public async complete(
    conversationId: string,
    toolCallId: string,
    name: string,
    input: unknown,
    result: unknown,
  ): Promise<void> {
    const [inputFingerprint, storagePath] = await Promise.all([
      fingerprint(name, input),
      this.recordPath(conversationId, toolCallId),
    ]);
    await this.serialize(async () => {
      await this.ensureInitialized();
      if (this.state.unavailable) throw new Error("Mutation journal is unavailable.");
      let existing: JournalRecord | null;
      try {
        existing = await this.readRecord(storagePath, conversationId, toolCallId);
      } catch {
        this.state.unavailable = true;
        throw new Error("Mutation journal is unavailable.");
      }
      if (!existing || existing.fingerprint !== inputFingerprint) {
        throw new Error("Mutation journal identity changed before completion.");
      }
      try {
        await this.writeRecord(storagePath, {
          conversationId,
          toolCallId,
          fingerprint: inputFingerprint,
          state: "completed",
          result,
          updatedAt: this.now(),
        });
      } catch (error) {
        this.state.unavailable = true;
        throw error;
      }
    });
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    await this.serialize(async () => {
      await this.ensureInitialized();
      if (this.state.unavailable) throw new Error("Mutation journal is unavailable.");
      const list = this.adapter.list;
      const remove = this.adapter.remove;
      if (!list || !remove) {
        throw new Error("Mutation journal adapter cannot delete conversations.");
      }
      try {
        if (!(await this.adapter.exists(this.recordsPath))) return;
        const listed = await list.call(this.adapter, this.recordsPath);
        const prefix = `${this.recordsPath}/`;
        for (const storagePath of listed.files) {
          const fileName = storagePath.startsWith(prefix) ? storagePath.slice(prefix.length) : "";
          if (!RECORD_FILE_NAME.test(fileName)) continue;
          const record = parseKeyedJournal(JSON.parse(await this.adapter.read(storagePath)));
          if (await this.recordPath(record.conversationId, record.toolCallId) !== storagePath) {
            throw new Error("Mutation journal contains a colliding record file.");
          }
          if (record.conversationId === conversationId) {
            await remove.call(this.adapter, storagePath);
          }
        }
      } catch (error) {
        this.state.unavailable = true;
        throw error;
      }
    });
  }

  public idle(): Promise<void> {
    return this.state.operations;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.state.operations.then(operation);
    this.state.operations = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.state.initialization) {
      this.state.initialization = this.initialize().catch(() => {
        this.state.unavailable = true;
      });
    }
    await this.state.initialization;
  }

  private async initialize(): Promise<void> {
    if (!(await this.adapter.exists(this.path))) return;
    if (await this.adapter.exists(this.migrationMarkerPath)) {
      parseMigrationMarker(JSON.parse(await this.adapter.read(this.migrationMarkerPath)));
      return;
    }

    const stat = this.adapter.stat;
    if (!stat) throw new Error("Mutation journal adapter cannot size legacy data.");
    const legacyStat = await stat.call(this.adapter, this.path);
    if (!legacyStat || legacyStat.type !== "file"
      || !Number.isSafeInteger(legacyStat.size)
      || legacyStat.size < 0
      || legacyStat.size > MAX_LEGACY_JOURNAL_BYTES) {
      throw new Error("Mutation journal is too large to migrate safely.");
    }
    const serializedLegacy = await this.adapter.read(this.path);
    if (serializedLegacy.length > MAX_LEGACY_JOURNAL_CHARACTERS
      || new TextEncoder().encode(serializedLegacy).byteLength
        > MAX_LEGACY_JOURNAL_BYTES) {
      throw new Error("Mutation journal is too large to migrate safely.");
    }
    const legacy = parseLegacyJournal(JSON.parse(serializedLegacy));
    await this.ensureRecordDirectory();
    for (const legacyRecord of legacy.records) {
      const storagePath = await this.recordPath(
        legacyRecord.conversationId,
        legacyRecord.toolCallId,
      );
      const existing = await this.readRecord(
        storagePath,
        legacyRecord.conversationId,
        legacyRecord.toolCallId,
      );
      const record = existing ? mergeMigratedRecord(existing, legacyRecord) : legacyRecord;
      if (record !== existing) await this.writeRecord(storagePath, record);
    }
    await this.adapter.write(this.migrationMarkerPath, JSON.stringify({
      version: 1,
      legacyVersion: 2,
    }));
  }

  private async recordPath(conversationId: string, toolCallId: string): Promise<string> {
    return `${this.recordsPath}/${await recordFileName(conversationId, toolCallId)}`;
  }

  private async readRecord(
    storagePath: string,
    conversationId: string,
    toolCallId: string,
  ): Promise<JournalRecord | null> {
    if (!(await this.adapter.exists(storagePath))) return null;
    const record = parseKeyedJournal(JSON.parse(await this.adapter.read(storagePath)));
    if (record.conversationId !== conversationId || record.toolCallId !== toolCallId) {
      throw new Error("Mutation journal contains a colliding record file.");
    }
    return record;
  }

  private async writeRecord(storagePath: string, record: JournalRecord): Promise<void> {
    await this.ensureRecordDirectory();
    const keyed: KeyedJournalFile = {
      version: KEYED_RECORD_VERSION,
      record: parseRecord(record),
    };
    await this.adapter.write(storagePath, JSON.stringify(keyed));
  }

  private async ensureRecordDirectory(): Promise<void> {
    if (this.state.directoryReady) return;
    const parent = this.recordsPath.split("/").slice(0, -1).join("/");
    if (parent && !(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
    if (!(await this.adapter.exists(this.recordsPath))) await this.adapter.mkdir(this.recordsPath);
    this.state.directoryReady = true;
  }
}
