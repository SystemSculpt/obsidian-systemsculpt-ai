import type { DataAdapter } from "obsidian";

type JournalRecord = Readonly<{
  conversationId: string;
  toolCallId: string;
  fingerprint: string;
  state: "started" | "completed";
  result?: unknown;
  updatedAt: number;
}>;

type JournalFile = Readonly<{
  version: 2;
  records: readonly JournalRecord[];
}>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`,
  ).join(",")}}`;
}

async function fingerprint(name: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${name}\n${stableJson(input)}`);
  // The vault journal is host-level state shared across popout windows.
  // eslint-disable-next-line obsidianmd/no-global-this
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function recordKey(conversationId: string, toolCallId: string): string {
  return `${conversationId}\0${toolCallId}`;
}

function parseJournal(value: unknown): JournalFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mutation journal must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2 || !Array.isArray(candidate.records)) {
    throw new Error("Mutation journal version is unsupported.");
  }
  const records = candidate.records.map((entry): JournalRecord => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Mutation journal contains an invalid record.");
    }
    const item = entry as Record<string, unknown>;
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
  });
  const keys = records.map((record) => recordKey(record.conversationId, record.toolCallId));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Mutation journal contains duplicate action identities.");
  }
  return { version: 2, records };
}

type SharedJournalState = {
  loaded: Promise<void> | null;
  records: Map<string, JournalRecord>;
  writes: Promise<void>;
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
      loaded: null,
      records: new Map(),
      writes: Promise.resolve(),
      unavailable: false,
    };
    byPath.set(path, state);
  }
  return state;
}

export type ThinAgentMutationClaim =
  | Readonly<{ kind: "execute" }>
  | Readonly<{ kind: "replay"; result: unknown }>
  | Readonly<{ kind: "outcome-unknown" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "journal-unavailable" }>;

/**
 * Crash-safe receipt store for local vault mutations. Receipts have no rolling
 * ceiling: they live for the bound server conversation and can be removed only
 * through deleteConversation() when that conversation is deliberately deleted.
 */
export class AgentMutationJournal {
  private readonly state: SharedJournalState;

  constructor(
    private readonly adapter: Pick<DataAdapter, "exists" | "read" | "write" | "mkdir">,
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.state = sharedJournalState(adapter, path);
  }

  public async claim(
    conversationId: string,
    toolCallId: string,
    name: string,
    input: unknown,
  ): Promise<ThinAgentMutationClaim> {
    await this.ensureLoaded();
    if (this.state.unavailable) return { kind: "journal-unavailable" };
    const inputFingerprint = await fingerprint(name, input);
    const key = recordKey(conversationId, toolCallId);
    const existing = this.state.records.get(key);
    if (existing) {
      if (existing.fingerprint !== inputFingerprint) return { kind: "conflict" };
      return existing.state === "completed"
        ? { kind: "replay", result: existing.result }
        : { kind: "outcome-unknown" };
    }
    this.state.records.set(key, {
      conversationId,
      toolCallId,
      fingerprint: inputFingerprint,
      state: "started",
      updatedAt: this.now(),
    });
    await this.persist();
    return { kind: "execute" };
  }

  public async complete(
    conversationId: string,
    toolCallId: string,
    name: string,
    input: unknown,
    result: unknown,
  ): Promise<void> {
    await this.ensureLoaded();
    if (this.state.unavailable) throw new Error("Mutation journal is unavailable.");
    const inputFingerprint = await fingerprint(name, input);
    const key = recordKey(conversationId, toolCallId);
    const existing = this.state.records.get(key);
    if (!existing || existing.fingerprint !== inputFingerprint) {
      throw new Error("Mutation journal identity changed before completion.");
    }
    this.state.records.set(key, {
      conversationId,
      toolCallId,
      fingerprint: inputFingerprint,
      state: "completed",
      result,
      updatedAt: this.now(),
    });
    await this.persist();
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded();
    if (this.state.unavailable) throw new Error("Mutation journal is unavailable.");
    let changed = false;
    for (const [key, record] of this.state.records) {
      if (record.conversationId !== conversationId) continue;
      this.state.records.delete(key);
      changed = true;
    }
    if (changed) await this.persist();
  }

  public idle(): Promise<void> {
    return this.state.writes;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.state.loaded) {
      this.state.loaded = (async () => {
        if (!(await this.adapter.exists(this.path))) return;
        try {
          const parsed = parseJournal(JSON.parse(await this.adapter.read(this.path)));
          this.state.records = new Map(parsed.records.map((record) => [
            recordKey(record.conversationId, record.toolCallId),
            record,
          ]));
        } catch {
          this.state.records = new Map();
          this.state.unavailable = true;
        }
      })();
    }
    await this.state.loaded;
  }

  private persist(): Promise<void> {
    const parent = this.path.split("/").slice(0, -1).join("/");
    const snapshot: JournalFile = {
      version: 2,
      records: [...this.state.records.values()],
    };
    const pending = this.state.writes.then(async () => {
      if (parent && !(await this.adapter.exists(parent))) await this.adapter.mkdir(parent);
      await this.adapter.write(this.path, JSON.stringify(snapshot));
    }).catch((error) => {
      this.state.unavailable = true;
      throw error;
    });
    this.state.writes = pending.catch(() => undefined);
    return pending;
  }
}
