/**
 * A packed, in-memory copy of one generation's vectors for similarity search.
 *
 * Rows are int8 codes with one scale per row (the portable snapshot's
 * encoding), so a 16.5k-chunk, 1536-dimension vault costs about 25 MB instead
 * of the 113 MB IndexedDB transfer every query used to pay. Each row points at
 * a note slot, so eligibility is decided once per note, not once per chunk.
 * Search returns candidate ids; callers rescore the few winners in Float32.
 *
 * Pure data structure: the storage layer builds it and patches it on every
 * publish, removal and rename.
 */

import { quantizeInt8Into } from "../utils/quantization";

export interface SemanticMatrixCandidate {
  path: string;
  chunkId: number;
  /** Approximate cosine similarity from the int8 codes. */
  score: number;
}

export interface SemanticMatrixSearchOptions {
  signal?: AbortSignal;
  /** Candidates at or below this approximate score are ignored. */
  minScore?: number;
  /** Rows scored between yields to the event loop. */
  rowsPerSlice?: number;
}

const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_ROWS_PER_SLICE = 2_048;

function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: number | undefined;
    const finish = () => {
      if (typeof timer !== "undefined") window.clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = window.setTimeout(finish, 0);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Keep the best `limit` candidates in descending score order. */
function insertTop(top: SemanticMatrixCandidate[], candidate: SemanticMatrixCandidate, limit: number): void {
  if (top.length >= limit && candidate.score <= top[top.length - 1].score) return;
  let low = 0;
  let high = top.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (top[middle].score > candidate.score) low = middle + 1;
    else high = middle;
  }
  top.splice(low, 0, candidate);
  if (top.length > limit) top.pop();
}

export class SemanticMatrix {
  private codes: Int8Array;
  private scales: Float32Array;
  /** Note slot per row; -1 marks a removed row awaiting compaction. */
  private rowSlot: Int32Array;
  private rowChunk: Int32Array;
  private rowCount = 0;
  private liveRows = 0;
  private readonly slotPaths: string[] = [];
  private readonly slotByPath = new Map<string, number>();
  private readonly rowsBySlot = new Map<number, number[]>();
  private readonly freeSlots: number[] = [];

  constructor(readonly dimensions: number, initialRows = 64) {
    const capacity = Math.max(1, initialRows);
    this.codes = new Int8Array(capacity * dimensions);
    this.scales = new Float32Array(capacity);
    this.rowSlot = new Int32Array(capacity);
    this.rowChunk = new Int32Array(capacity);
  }

  get size(): number {
    return this.liveRows;
  }

  /** Approximate heap held by the packed rows. */
  get byteLength(): number {
    return this.codes.byteLength + this.scales.byteLength + this.rowSlot.byteLength + this.rowChunk.byteLength;
  }

  hasPath(path: string): boolean {
    return this.slotByPath.has(path);
  }

  /** Replace every row for one note. Vectors of the wrong length are ignored. */
  upsertPath(path: string, chunks: ReadonlyArray<{ chunkId: number; vector: Float32Array }>): void {
    this.removePath(path);
    this.appendRows(path, chunks);
  }

  /** Add rows to a note, keeping the rows it already has (used while building). */
  appendRows(path: string, chunks: ReadonlyArray<{ chunkId: number; vector: Float32Array }>): void {
    const usable = chunks.filter((chunk) => chunk.vector.length === this.dimensions);
    if (usable.length === 0) return;
    let slot = this.slotByPath.get(path);
    if (slot === undefined) {
      slot = this.freeSlots.pop() ?? this.slotPaths.length;
      this.slotPaths[slot] = path;
      this.slotByPath.set(path, slot);
    }
    const rows = this.rowsBySlot.get(slot) ?? [];
    this.ensureCapacity(this.rowCount + usable.length);
    for (const chunk of usable) {
      const row = this.rowCount;
      this.scales[row] = quantizeInt8Into(chunk.vector, this.codes, row * this.dimensions);
      this.rowSlot[row] = slot;
      this.rowChunk[row] = chunk.chunkId;
      rows.push(row);
      this.rowCount += 1;
      this.liveRows += 1;
    }
    this.rowsBySlot.set(slot, rows);
  }

  removePath(path: string): void {
    const slot = this.slotByPath.get(path);
    if (slot === undefined) return;
    for (const row of this.rowsBySlot.get(slot) ?? []) {
      this.rowSlot[row] = -1;
      this.liveRows -= 1;
    }
    this.rowsBySlot.delete(slot);
    this.slotByPath.delete(path);
    this.slotPaths[slot] = "";
    this.freeSlots.push(slot);
    if (this.rowCount > 1_024 && this.liveRows < this.rowCount / 2) this.compact();
  }

  renamePath(oldPath: string, newPath: string): void {
    const slot = this.slotByPath.get(oldPath);
    if (slot === undefined || oldPath === newPath) return;
    this.removePath(newPath);
    this.slotByPath.delete(oldPath);
    this.slotByPath.set(newPath, slot);
    this.slotPaths[slot] = newPath;
  }

  /** Folder rename: every note under `oldPrefix` moves under `newPrefix`. */
  renamePrefix(oldPrefix: string, newPrefix: string): void {
    for (const path of [...this.slotByPath.keys()]) {
      if (path.startsWith(oldPrefix)) this.renamePath(path, `${newPrefix}${path.slice(oldPrefix.length)}`);
    }
  }

  removePrefix(prefix: string): void {
    for (const path of [...this.slotByPath.keys()]) {
      if (path.startsWith(prefix)) this.removePath(path);
    }
  }

  /**
   * Score every eligible row against each query and keep the best `limit`
   * candidates per query. `isEligible` runs once per note. Yields to the event
   * loop between slices and returns empty sets once `signal` aborts.
   */
  async search(
    queries: readonly Float32Array[],
    limit: number,
    isEligible: (path: string) => boolean,
    options: SemanticMatrixSearchOptions = {},
  ): Promise<SemanticMatrixCandidate[][]> {
    const empty = () => queries.map(() => [] as SemanticMatrixCandidate[]);
    const k = Math.max(0, Math.floor(limit));
    const usable = queries.filter((query) => query.length === this.dimensions);
    if (k === 0 || usable.length === 0 || options.signal?.aborted) return empty();

    const eligibleSlots = new Uint8Array(this.slotPaths.length);
    for (const [path, slot] of this.slotByPath) eligibleSlots[slot] = isEligible(path) ? 1 : 0;

    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const slice = Math.max(1, options.rowsPerSlice ?? DEFAULT_ROWS_PER_SLICE);
    const dimensions = this.dimensions;
    const tops = queries.map(() => [] as SemanticMatrixCandidate[]);
    // A mutation between slices may compact the arrays; re-read them per slice.
    for (let start = 0; start < this.rowCount; start += slice) {
      const codes = this.codes;
      const end = Math.min(this.rowCount, start + slice);
      for (let row = start; row < end; row += 1) {
        const slot = this.rowSlot[row];
        if (slot < 0 || eligibleSlots[slot] !== 1) continue;
        const offset = row * dimensions;
        const scale = this.scales[row];
        for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
          const query = queries[queryIndex];
          if (query.length !== dimensions) continue;
          let sum = 0;
          for (let index = 0; index < dimensions; index += 1) sum += query[index] * codes[offset + index];
          const score = sum * scale;
          if (score > minScore) {
            insertTop(tops[queryIndex], { path: this.slotPaths[slot], chunkId: this.rowChunk[row], score }, k);
          }
        }
      }
      if (end < this.rowCount) {
        const rowsBefore = this.rowCount;
        await yieldToEventLoop(options.signal);
        if (options.signal?.aborted) return empty();
        // Compaction renumbers rows; restart rather than skip or repeat any.
        if (this.rowCount < rowsBefore) return this.search(queries, limit, isEligible, options);
      }
    }
    return options.signal?.aborted ? empty() : tops;
  }

  private ensureCapacity(rows: number): void {
    const capacity = this.scales.length;
    if (rows <= capacity) return;
    const next = Math.max(rows, Math.ceil(capacity * 1.25) + 16);
    const codes = new Int8Array(next * this.dimensions);
    codes.set(this.codes.subarray(0, this.rowCount * this.dimensions));
    this.codes = codes;
    this.scales = this.grow(this.scales, next) as Float32Array;
    this.rowSlot = this.grow(this.rowSlot, next) as Int32Array;
    this.rowChunk = this.grow(this.rowChunk, next) as Int32Array;
  }

  private grow(array: Float32Array | Int32Array, length: number): Float32Array | Int32Array {
    const next = array instanceof Float32Array ? new Float32Array(length) : new Int32Array(length);
    next.set(array.subarray(0, this.rowCount));
    return next;
  }

  /** Drop removed rows once they are the majority, keeping row order. */
  private compact(): void {
    let write = 0;
    const dimensions = this.dimensions;
    this.rowsBySlot.clear();
    for (let read = 0; read < this.rowCount; read += 1) {
      const slot = this.rowSlot[read];
      if (slot < 0) continue;
      if (write !== read) {
        this.codes.copyWithin(write * dimensions, read * dimensions, (read + 1) * dimensions);
        this.scales[write] = this.scales[read];
        this.rowSlot[write] = slot;
        this.rowChunk[write] = this.rowChunk[read];
      }
      const rows = this.rowsBySlot.get(slot);
      if (rows) rows.push(write);
      else this.rowsBySlot.set(slot, [write]);
      write += 1;
    }
    this.rowCount = write;
  }
}
