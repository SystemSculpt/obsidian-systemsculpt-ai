/**
 * Minimal in-memory IndexedDB for embeddings storage tests.
 *
 * Covers the surface EmbeddingsStorage uses: versioned open with upgrade,
 * in-line and out-of-line keys, nested-keyPath indexes, get/getAll/getAllKeys
 * with ranges and counts, put/delete/clear/count, and value/key cursors
 * (including "nextunique"). Transactions run strictly one after another and
 * every request settles on a microtask, so tests stay deterministic under
 * fake timers. Values are structured-cloned on the way in and out, which
 * catches callers that accidentally alias stored records.
 */

type Key = string | number;
type Row = { key: Key; value: unknown };

/**
 * Structured clone for the value shapes the embeddings store persists. Jest's
 * sandbox has its own typed-array constructors, and the host structuredClone
 * would hand back arrays from another realm that fail `instanceof` checks.
 */
function clone<T>(value: T): T {
  if (value instanceof Float32Array) return new Float32Array(value) as T;
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): T }).slice();
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = clone(entry);
    return out as T;
  }
  return value;
}

function compareKeys(left: Key, right: Key): number {
  if (typeof left === typeof right) return left < right ? -1 : left > right ? 1 : 0;
  return typeof left === "number" ? -1 : 1;
}

export class FakeKeyRange {
  constructor(
    readonly lower: Key | undefined,
    readonly upper: Key | undefined,
    readonly lowerOpen = false,
    readonly upperOpen = false,
  ) {}

  static only(value: Key): FakeKeyRange { return new FakeKeyRange(value, value); }
  static bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false): FakeKeyRange {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
  static lowerBound(lower: Key, open = false): FakeKeyRange { return new FakeKeyRange(lower, undefined, open); }
  static upperBound(upper: Key, open = false): FakeKeyRange {
    return new FakeKeyRange(undefined, upper, false, open);
  }

  includes(key: Key): boolean {
    if (this.lower !== undefined) {
      const order = compareKeys(key, this.lower);
      if (order < 0 || (order === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const order = compareKeys(key, this.upper);
      if (order > 0 || (order === 0 && this.upperOpen)) return false;
    }
    return true;
  }
}

function matches(query: unknown, key: Key): boolean {
  if (query === undefined || query === null) return true;
  if (query instanceof FakeKeyRange) return query.includes(key);
  return compareKeys(query as Key, key) === 0;
}

function readPath(value: unknown, keyPath: string): Key | undefined {
  let current: unknown = value;
  for (const part of keyPath.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" || typeof current === "number" ? current : undefined;
}

class NameList {
  constructor(private readonly names: () => string[]) {}
  contains(name: string): boolean { return this.names().includes(name); }
  get length(): number { return this.names().length; }
}

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: ((event: { target: FakeRequest<T> }) => void) | null = null;
  onerror: ((event: { target: FakeRequest<T> }) => void) | null = null;
  onupgradeneeded: ((event: { target: FakeRequest<T> }) => void) | null = null;
  onblocked: (() => void) | null = null;
  transaction: FakeTransaction | null = null;
}

interface StoreData {
  keyPath: string | null;
  rows: Map<Key, unknown>;
  indexes: Map<string, { keyPath: string; unique: boolean }>;
}

class FakeDatabaseData {
  version = 0;
  stores = new Map<string, StoreData>();
}

class FakeIndex {
  constructor(
    private readonly store: FakeObjectStore,
    readonly name: string,
    readonly keyPath: string,
  ) {}

  entries(): Row[] {
    const rows: Row[] = [];
    for (const [primaryKey, value] of this.store.data.rows) {
      const key = readPath(value, this.keyPath);
      if (key !== undefined) rows.push({ key, value: { primaryKey, value } });
    }
    return rows.sort((left, right) => (
      compareKeys(left.key, right.key)
      || compareKeys((left.value as { primaryKey: Key }).primaryKey, (right.value as { primaryKey: Key }).primaryKey)
    ));
  }

  getAll(query?: unknown, count?: number): FakeRequest<unknown[]> {
    return this.store.tx.request(() => this.entries()
      .filter((row) => matches(query, row.key))
      .slice(0, count ?? Number.MAX_SAFE_INTEGER)
      .map((row) => clone((row.value as { value: unknown }).value)));
  }

  getAllKeys(query?: unknown, count?: number): FakeRequest<Key[]> {
    return this.store.tx.request(() => this.entries()
      .filter((row) => matches(query, row.key))
      .slice(0, count ?? Number.MAX_SAFE_INTEGER)
      .map((row) => (row.value as { primaryKey: Key }).primaryKey));
  }

  count(query?: unknown): FakeRequest<number> {
    return this.store.tx.request(() => this.entries().filter((row) => matches(query, row.key)).length);
  }

  openCursor(query?: unknown, direction = "next"): FakeRequest {
    return this.store.tx.cursor(() => this.entries().filter((row) => matches(query, row.key)), direction, true);
  }

  openKeyCursor(query?: unknown, direction = "next"): FakeRequest {
    return this.store.tx.cursor(() => this.entries().filter((row) => matches(query, row.key)), direction, false);
  }
}

class FakeObjectStore {
  constructor(readonly tx: FakeTransaction, readonly name: string, readonly data: StoreData) {}

  get keyPath(): string | null { return this.data.keyPath; }
  get indexNames(): NameList { return new NameList(() => [...this.data.indexes.keys()]); }

  createIndex(name: string, keyPath: string, options?: { unique?: boolean }): FakeIndex {
    this.data.indexes.set(name, { keyPath, unique: options?.unique === true });
    return this.index(name);
  }

  index(name: string): FakeIndex {
    const index = this.data.indexes.get(name);
    if (!index) throw new Error(`Unknown index ${name}`);
    return new FakeIndex(this, name, index.keyPath);
  }

  private primaryRows(): Row[] {
    return [...this.data.rows.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((left, right) => compareKeys(left.key, right.key));
  }

  put(value: unknown, key?: Key): FakeRequest<Key> {
    this.tx.assertWritable();
    return this.tx.request(() => {
      const resolved = this.data.keyPath ? readPath(value, this.data.keyPath) : key;
      if (resolved === undefined) throw new Error("DataError: missing key");
      this.data.rows.set(resolved, clone(value));
      return resolved;
    });
  }

  add(value: unknown, key?: Key): FakeRequest<Key> { return this.put(value, key); }

  get(query: unknown): FakeRequest {
    return this.tx.request(() => {
      const row = this.primaryRows().find((entry) => matches(query, entry.key));
      return row ? clone(row.value) : undefined;
    });
  }

  getAll(query?: unknown, count?: number): FakeRequest<unknown[]> {
    return this.tx.request(() => this.primaryRows()
      .filter((row) => matches(query, row.key))
      .slice(0, count ?? Number.MAX_SAFE_INTEGER)
      .map((row) => clone(row.value)));
  }

  getAllKeys(query?: unknown, count?: number): FakeRequest<Key[]> {
    return this.tx.request(() => this.primaryRows()
      .filter((row) => matches(query, row.key))
      .slice(0, count ?? Number.MAX_SAFE_INTEGER)
      .map((row) => row.key));
  }

  delete(query: unknown): FakeRequest<undefined> {
    this.tx.assertWritable();
    return this.tx.request(() => {
      for (const key of [...this.data.rows.keys()]) if (matches(query, key)) this.data.rows.delete(key);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    this.tx.assertWritable();
    return this.tx.request(() => { this.data.rows.clear(); return undefined; });
  }

  count(query?: unknown): FakeRequest<number> {
    return this.tx.request(() => this.primaryRows().filter((row) => matches(query, row.key)).length);
  }

  openCursor(query?: unknown, direction = "next"): FakeRequest {
    return this.tx.cursor(
      () => this.primaryRows().map((row) => ({ key: row.key, value: { primaryKey: row.key, value: row.value } })),
      direction,
      true,
      query,
    );
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private readonly pending: Array<() => void> = [];
  private started = false;
  private finished = false;

  constructor(
    private readonly factory: FakeIndexedDbFactory,
    readonly db: FakeDatabase,
    private readonly scope: string[],
    readonly mode: string,
  ) {}

  objectStore(name: string): FakeObjectStore {
    if (!this.scope.includes(name) && this.mode !== "versionchange") {
      throw new Error(`NotFoundError: ${name} is outside the transaction scope`);
    }
    const data = this.db.data.stores.get(name);
    if (!data) throw new Error(`NotFoundError: ${name}`);
    return new FakeObjectStore(this, name, data);
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.error = this.error ?? new Error("AbortError");
    this.pending.length = 0;
    queueMicrotask(() => {
      this.onabort?.();
      this.factory.release(this);
    });
  }

  assertWritable(): void {
    if (this.mode === "readonly") throw new Error("ReadOnlyError");
  }

  request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    request.transaction = this;
    this.enqueue(() => {
      try {
        request.result = operation();
      } catch (error) {
        request.error = error as Error;
        this.error = request.error;
        request.onerror?.({ target: request });
        this.abort();
        return;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  cursor(
    source: () => Row[],
    direction: string,
    withValue: boolean,
    query?: unknown,
  ): FakeRequest {
    const request = new FakeRequest();
    request.transaction = this;
    let position: Row | null = null;
    const advance = () => {
      let rows = source().filter((row) => matches(query, row.key));
      if (direction === "prev" || direction === "prevunique") rows = rows.reverse();
      const unique = direction === "nextunique" || direction === "prevunique";
      const forward = direction === "next" || direction === "nextunique";
      const next = rows.find((row) => {
        if (!position) return true;
        const keyOrder = compareKeys(row.key, position.key) * (forward ? 1 : -1);
        if (keyOrder > 0) return true;
        if (keyOrder < 0 || unique) return false;
        const primary = (row.value as { primaryKey: Key }).primaryKey;
        const last = (position.value as { primaryKey: Key }).primaryKey;
        return compareKeys(primary, last) * (forward ? 1 : -1) > 0;
      }) ?? null;
      position = next;
      if (!next) {
        request.result = null;
      } else {
        const entry = next.value as { primaryKey: Key; value: unknown };
        request.result = {
          key: next.key,
          primaryKey: entry.primaryKey,
          ...(withValue ? { value: clone(entry.value) } : {}),
          continue: () => this.enqueue(advance),
        };
      }
      request.onsuccess?.({ target: request });
    };
    this.enqueue(advance);
    return request;
  }

  start(): void {
    this.started = true;
    this.pump();
  }

  private enqueue(step: () => void): void {
    if (this.finished) return;
    this.pending.push(step);
    if (this.started) this.pump();
  }

  private pumping = false;

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.finished) return;
      const step = this.pending.shift();
      if (step) {
        step();
        this.pump();
        return;
      }
      // Give request callbacks one more turn to enqueue follow-up work.
      queueMicrotask(() => {
        if (this.finished) return;
        if (this.pending.length > 0) {
          this.pump();
          return;
        }
        this.finished = true;
        this.oncomplete?.();
        this.factory.release(this);
      });
    });
  }
}

class FakeDatabase {
  closed = false;
  constructor(
    private readonly factory: FakeIndexedDbFactory,
    readonly name: string,
    readonly data: FakeDatabaseData,
  ) {}

  get version(): number { return this.data.version; }
  get objectStoreNames(): NameList { return new NameList(() => [...this.data.stores.keys()]); }

  createObjectStore(name: string, options?: { keyPath?: string }): FakeObjectStore {
    const data: StoreData = { keyPath: options?.keyPath ?? null, rows: new Map(), indexes: new Map() };
    this.data.stores.set(name, data);
    return new FakeObjectStore(this.factory.upgradeTransaction!, name, data);
  }

  deleteObjectStore(name: string): void {
    this.data.stores.delete(name);
  }

  transaction(names: string | string[], mode = "readonly"): FakeTransaction {
    if (this.closed) throw new Error("InvalidStateError: database closed");
    const scope = Array.isArray(names) ? names : [names];
    for (const name of scope) {
      if (!this.data.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
    }
    return this.factory.schedule(new FakeTransaction(this.factory, this, scope, mode));
  }

  close(): void { this.closed = true; }
}

export class FakeIndexedDbFactory {
  readonly databases = new Map<string, FakeDatabaseData>();
  upgradeTransaction: FakeTransaction | null = null;
  private readonly queue: FakeTransaction[] = [];
  private active: FakeTransaction | null = null;

  open(name: string, version?: number): FakeRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let data = this.databases.get(name);
      if (!data) {
        data = new FakeDatabaseData();
        this.databases.set(name, data);
      }
      const db = new FakeDatabase(this, name, data);
      request.result = db;
      const target = version ?? Math.max(1, data.version);
      if (target > data.version) {
        const upgrade = new FakeTransaction(this, db, [...data.stores.keys()], "versionchange");
        this.upgradeTransaction = upgrade;
        request.transaction = upgrade;
        data.version = target;
        request.onupgradeneeded?.({ target: request });
        this.upgradeTransaction = null;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  deleteDatabase(name: string): FakeRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.databases.delete(name);
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  schedule(tx: FakeTransaction): FakeTransaction {
    this.queue.push(tx);
    this.startNext();
    return tx;
  }

  release(tx: FakeTransaction): void {
    if (this.active === tx) this.active = null;
    this.startNext();
  }

  private startNext(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    next.start();
  }

  /** Every stored value in one store, for assertions. */
  rows(dbName: string, storeName: string): Map<Key, unknown> {
    return this.databases.get(dbName)?.stores.get(storeName)?.rows ?? new Map();
  }
}

/** Install the fake as the global IndexedDB for one test; returns the factory and a restore hook. */
export function installFakeIndexedDb(): { factory: FakeIndexedDbFactory; restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const previous = { indexedDB: g.indexedDB, IDBKeyRange: g.IDBKeyRange };
  const factory = new FakeIndexedDbFactory();
  g.indexedDB = factory;
  g.IDBKeyRange = FakeKeyRange;
  return {
    factory,
    restore: () => {
      g.indexedDB = previous.indexedDB;
      g.IDBKeyRange = previous.IDBKeyRange;
    },
  };
}
