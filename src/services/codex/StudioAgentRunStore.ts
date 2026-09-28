import { validStudioWorkflow, workflowOpen, type StudioWorkflow } from './StudioWorkflow';
import type { App } from 'obsidian';
import { deriveStudioAssetsDir } from '../../studio/paths';
import { isRecord } from '../../studio/utils';
import type { CodexActivity } from './CodexActivity';
import type { CodexRequest } from './LocalCodexClient';
import type { DeepReadonly } from '../../studio/StudioProjectSnapshots';

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type AgentRunMessage = { id: string; from: string; to: string; text: string; at: string; status: 'pending' | 'delivered' | 'failed'; error?: string };
export type StudioAgentRun = {
  schema: 'studio.agent-run.v1'; id: string; projectId: string; projectPath: string; nodeId: string; title: string;
  workflow?: StudioWorkflow; workflowId?: string; assignmentId?: string; preparationPending?: boolean;
  parentRunId?: string; owner: string; machine: string; status: AgentRunStatus; createdAt: string; updatedAt: string; finishedAt?: string;
  threadId: string; turnId: string; request: CodexRequest; result: string; error: string; currentActivity: string;
  activity: CodexActivity[]; messages: AgentRunMessage[]; persistenceError?: string;
};
/** Live observation views: only StudioAgentRuns may mutate the retained records. */
export type StudioAgentRunView = DeepReadonly<StudioAgentRun>;
export type AgentRunMessageView = DeepReadonly<AgentRunMessage>;
/** `before` is the page's oldest run ID: pass it back to read the next older page. */
export type AgentRunPage = { records: StudioAgentRun[]; before: string | null; olderRemaining: number };

export const isActiveAgentRun = (status: AgentRunStatus): boolean => ['queued', 'running', 'waiting'].includes(status);
export const agentRunFolder = (projectPath: string): string => `${deriveStudioAssetsDir(projectPath)}/agent-runs`;
/** Records read when a board opens; older pages load on request. */
export const AGENT_RUN_PAGE_SIZE = 50;
/** On-disk retention mirrors the in-memory cap, plus an age limit. Live runs are never removed. */
export const AGENT_RUN_RETAINED_RECORDS = 1000;
export const AGENT_RUN_RETAINED_DAYS = 90;
/** Background retention yields to the host after this many records. */
const RECORD_BATCH = 50;
const INDEX_WRITE_DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_FILE = /\/(agent_([0-9]+)_[a-f0-9-]+)\.json$/;
const INDEX_SCHEMA = 'studio.agent-run-index.v1';

/**
 * What the board needs to know about a record without reading it: whether it
 * is live, and how recently it changed. Records written by another machine
 * reach the index once this machine reads them.
 */
type IndexEntry = { status: AgentRunStatus; day: string; workflowOpen?: true; workflowId?: string; parentRunId?: string };
/**
 * `complete` means every record on disk was indexed at some point. An index
 * that is missing, damaged or incomplete is seeded from all records before it
 * decides which runs are live.
 */
type RunIndex = { entries: Map<string, IndexEntry>; complete: boolean; seeding: Promise<void> | null; dirty: boolean; timer: number | null };

const indexEntry = (record: StudioAgentRun): IndexEntry => ({
  status: record.status, day: record.updatedAt.slice(0, 10),
  ...(workflowOpen(record.workflow) ? { workflowOpen: true as const } : {}),
  ...(record.workflowId ? { workflowId: record.workflowId } : {}),
  ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
});
const sameEntry = (a: IndexEntry | undefined, b: IndexEntry): boolean => !!a && a.status === b.status && a.day === b.day && a.workflowOpen === b.workflowOpen && a.workflowId === b.workflowId && a.parentRunId === b.parentRunId;
function readIndexEntry(value: unknown): IndexEntry | null {
  if (!isRecord(value) || !['queued','running','waiting','completed','failed','stopped','interrupted'].includes(String(value.status)) || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
    || (value.workflowOpen !== undefined && value.workflowOpen !== true) || ['workflowId','parentRunId'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) return null;
  return { status: value.status as AgentRunStatus, day: value.day, ...(value.workflowOpen ? { workflowOpen: true as const } : {}), ...(typeof value.workflowId === 'string' ? { workflowId: value.workflowId } : {}), ...(typeof value.parentRunId === 'string' ? { parentRunId: value.parentRunId } : {}) };
}

/**
 * Runs that must stay loaded and on disk: active runs, open workflows and
 * their assignments, and the ancestry of each, as the in-memory prune keeps.
 */
function liveRunIds(entries: ReadonlyMap<string, IndexEntry>, present: ReadonlySet<string>): Set<string> {
  const live = new Set<string>();
  for (const [id, entry] of entries) {
    if (!present.has(id)) continue;
    if (isActiveAgentRun(entry.status) || entry.workflowOpen || (entry.workflowId && entries.get(entry.workflowId)?.workflowOpen)) live.add(id);
  }
  for (const id of [...live]) {
    let parent = entries.get(id)?.parentRunId;
    for (let depth = 0; parent && depth < 8; depth++) { if (present.has(parent)) live.add(parent); parent = entries.get(parent)?.parentRunId; }
  }
  return live;
}

function parseRunRecord(raw: string, projectPath: string, projectId: string): StudioAgentRun {
  const record: unknown = JSON.parse(raw);
  if (!isRecord(record) || record.schema !== 'studio.agent-run.v1' || record.projectId !== projectId || record.projectPath !== projectPath || !/^agent_[0-9]+_[a-f0-9-]+$/.test(String(record.id)) || !isRecord(record.request) || typeof record.request.prompt !== 'string' || typeof record.request.workingDirectory !== 'string' || !Array.isArray(record.activity) || !Array.isArray(record.messages) || !['queued','running','waiting','completed','failed','stopped','interrupted'].includes(String(record.status))) throw new Error('A saved run record is invalid; it was left unchanged.');
  const stringFields = ['id','projectId','projectPath','nodeId','title','owner','machine','createdAt','updatedAt','threadId','turnId','result','error','currentActivity'];
  if (stringFields.some(key => typeof record[key] !== 'string') || record.activity.length > 40 || record.messages.length > 100
    || record.activity.some(item => !isRecord(item) || ['id','kind','title','detail','status','at'].some(key => typeof item[key] !== 'string') || !['command','file','tool','plan','message'].includes(String(item.kind)))
    || record.messages.some(item => !isRecord(item) || ['id','from','to','text','at','status'].some(key => typeof item[key] !== 'string') || !['pending','delivered','failed'].includes(String(item.status)))) throw new Error('A saved run has invalid presentation fields; it was left unchanged.');
  if ((record.workflow !== undefined && !validStudioWorkflow(record.workflow)) || ['workflowId','assignmentId'].some(key => record[key] !== undefined && typeof record[key] !== 'string')) throw new Error('Saved workflow state is invalid; it was left unchanged.');
  return record as StudioAgentRun;
}

/** Vault-side presentation records. Codex remains the authoritative thread store. */
export class StudioAgentRunStore {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly indexes = new Map<string, Promise<RunIndex>>();
  private readonly retention = new Map<string, Promise<number>>();
  private closed = false;
  constructor(private readonly app: App) {}

  /**
   * The newest page of records older than `before` (a run ID), or the newest
   * page overall. The first page also includes every run the index marks as
   * live, however old, so open workflows recover after a reload.
   */
  async list(projectPath: string, projectId: string, options: { before?: string; limit?: number } = {}): Promise<AgentRunPage> {
    const adapter = this.app.vault.adapter, folder = agentRunFolder(projectPath);
    if (!await adapter.exists(folder)) return { records: [], before: null, olderRemaining: 0 };
    const ids = await this.listIds(folder);
    const index = await this.index(projectPath);
    if (!options.before) await this.seedIndex(projectPath, projectId, index, ids);
    const older = options.before ? ids.filter(id => id < options.before!) : ids;
    const page = older.slice(-Math.max(1, options.limit ?? AGENT_RUN_PAGE_SIZE));
    const wanted = new Set(page);
    if (!options.before) for (const id of liveRunIds(index.entries, new Set(ids))) wanted.add(id);
    const paths = ids.filter(id => wanted.has(id)).map(id => `${folder}/${id}.json`);
    const records: StudioAgentRun[] = [];
    for (let offset = 0; offset < paths.length; offset += 4) {
      const batch = await Promise.all(paths.slice(offset, offset + 4).map(async path => {
        const stat = await adapter.stat(path);
        if (!stat || stat.size > 2_000_000) throw new Error('A saved run record exceeds the supported size.');
        return parseRunRecord(await adapter.read(path), projectPath, projectId);
      }));
      records.push(...batch);
    }
    for (const record of records) this.noteRecord(projectPath, index, record);
    return { records, before: page[0] ?? null, olderRemaining: older.length - page.length };
  }
  write(record: StudioAgentRun): Promise<void> {
    const snapshot = JSON.stringify(record);
    if (new TextEncoder().encode(snapshot).byteLength > 2_000_000) return Promise.reject(new Error('The run presentation record exceeds 2 MB.'));
    const path = `${agentRunFolder(record.projectPath)}/${record.id}.json`;
    const previous = this.writes.get(path) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const adapter = this.app.vault.adapter, parts = agentRunFolder(record.projectPath).split('/');
      for (let index = 1; index <= parts.length; index++) {
        const folder = parts.slice(0, index).join('/');
        if (!await adapter.exists(folder)) {
          try { await adapter.mkdir(folder); } catch (error) { if (!await adapter.exists(folder)) throw error; }
        }
      }
      await adapter.write(path, snapshot);
      this.noteRecord(record.projectPath, await this.index(record.projectPath), record);
    });
    this.track(path, pending);
    return pending;
  }

  /**
   * Remove records beyond the newest AGENT_RUN_RETAINED_RECORDS, or unchanged
   * for AGENT_RUN_RETAINED_DAYS, unless they are live or listed in `keep`.
   * Each candidate is re-read first, so a run another machine resumed since
   * it was indexed is kept. Runs once per project per session.
   */
  prune(projectPath: string, projectId: string, keep: ReadonlySet<string>, now = Date.now()): Promise<number> {
    const folder = agentRunFolder(projectPath);
    if (!this.retention.has(folder)) this.retention.set(folder, this.prunePass(projectPath, projectId, keep, now).catch(() => 0));
    return this.retention.get(folder)!;
  }
  async flush(): Promise<void> {
    await Promise.all([...this.retention.values()]);
    for (const [projectPath, pending] of this.indexes) {
      const index = await pending;
      if (index.timer !== null) { window.clearTimeout(index.timer); index.timer = null; }
      this.persistIndex(projectPath, index);
    }
    await Promise.all([...this.writes.values()].map(pending => pending.catch(() => {})));
  }
  /** Stop retention early and save everything pending. */
  async close(): Promise<void> { this.closed = true; await this.flush(); }

  private track(path: string, pending: Promise<void>): void {
    this.writes.set(path, pending);
    void pending.finally(() => { if (this.writes.get(path) === pending) this.writes.delete(path); }).catch(() => {});
  }
  private async listIds(folder: string): Promise<string[]> {
    return (await this.app.vault.adapter.list(folder)).files.map(path => RECORD_FILE.exec(path)?.[1]).filter((id): id is string => !!id).sort();
  }
  private index(projectPath: string): Promise<RunIndex> {
    if (!this.indexes.has(projectPath)) this.indexes.set(projectPath, (async (): Promise<RunIndex> => {
      const path = `${agentRunFolder(projectPath)}/index.json`, entries = new Map<string, IndexEntry>();
      let complete = false;
      try {
        const saved: unknown = await this.app.vault.adapter.exists(path) ? JSON.parse(await this.app.vault.adapter.read(path)) : null;
        if (isRecord(saved) && saved.schema === INDEX_SCHEMA && isRecord(saved.runs)) {
          for (const [id, value] of Object.entries(saved.runs)) { const entry = readIndexEntry(value); if (entry) entries.set(id, entry); }
          complete = saved.complete === true;
        }
      } catch { /* A damaged index is seeded again from the records. */ }
      return { entries, complete, seeding: null, dirty: false, timer: null };
    })());
    return this.indexes.get(projectPath)!;
  }
  private noteRecord(projectPath: string, index: RunIndex, record: StudioAgentRun): void {
    const entry = indexEntry(record);
    if (sameEntry(index.entries.get(record.id), entry)) return;
    index.entries.set(record.id, entry); this.scheduleIndex(projectPath, index);
  }
  private scheduleIndex(projectPath: string, index: RunIndex): void {
    index.dirty = true;
    if (this.closed) { this.persistIndex(projectPath, index); return; }
    if (index.timer === null) index.timer = window.setTimeout(() => { index.timer = null; this.persistIndex(projectPath, index); }, INDEX_WRITE_DELAY_MS);
  }
  private persistIndex(projectPath: string, index: RunIndex): void {
    if (!index.dirty) return;
    index.dirty = false;
    const path = `${agentRunFolder(projectPath)}/index.json`;
    const snapshot = JSON.stringify({ schema: INDEX_SCHEMA, complete: index.complete, runs: Object.fromEntries([...index.entries].sort(([a], [b]) => a.localeCompare(b))) });
    const pending = (this.writes.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
      if (await this.app.vault.adapter.exists(agentRunFolder(projectPath))) await this.app.vault.adapter.write(path, snapshot);
    });
    this.track(path, pending);
  }
  /**
   * One pass over every record the index lacks, four reads at a time, so an
   * old open workflow is found even when the index was never written or was
   * damaged. It runs once per project; unreadable records are skipped, as the
   * board would refuse them anyway.
   */
  private seedIndex(projectPath: string, projectId: string, index: RunIndex, ids: readonly string[]): Promise<void> {
    if (index.complete) return Promise.resolve();
    index.seeding ??= (async () => {
      const adapter = this.app.vault.adapter, folder = agentRunFolder(projectPath);
      const missing = ids.filter(id => !index.entries.has(id));
      for (let start = 0; start < missing.length; start += 4) {
        await Promise.all(missing.slice(start, start + 4).map(async id => {
          try {
            const path = `${folder}/${id}.json`, stat = await adapter.stat(path);
            if (!stat || stat.size > 2_000_000) return;
            index.entries.set(id, indexEntry(parseRunRecord(await adapter.read(path), projectPath, projectId)));
          } catch { /* Left for the board to report when it reads the record. */ }
        }));
      }
      index.complete = true;
      this.scheduleIndex(projectPath, index);
    })().finally(() => { index.seeding = null; });
    return index.seeding;
  }
  private yieldToHost(): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, 0)); }
  private async prunePass(projectPath: string, projectId: string, keep: ReadonlySet<string>, now: number): Promise<number> {
    const adapter = this.app.vault.adapter, folder = agentRunFolder(projectPath);
    if (!await adapter.exists(folder) || typeof adapter.remove !== 'function') return 0;
    if (this.closed) return 0;
    const ids = await this.listIds(folder), present = new Set(ids);
    const index = await this.index(projectPath);
    await this.seedIndex(projectPath, projectId, index, ids);
    if (this.closed) return 0;
    for (const id of index.entries.keys()) if (!present.has(id)) { index.entries.delete(id); index.dirty = true; }
    const cutoff = new Date(now - AGENT_RUN_RETAINED_DAYS * DAY_MS).toISOString().slice(0, 10);
    const newest = new Set(ids.slice(-AGENT_RUN_RETAINED_RECORDS));
    // A run changed no earlier than it was created, which its ID records.
    const created = (id: string): number => { const at = Number(RECORD_FILE.exec(`/${id}.json`)?.[2]); return Number.isFinite(at) && at <= now ? at : now; };
    const lastChanged = (id: string): string => index.entries.get(id)?.day ?? new Date(created(id)).toISOString().slice(0, 10);
    const live = liveRunIds(index.entries, present);
    const candidates = ids.filter(id => !keep.has(id) && !live.has(id) && (!newest.has(id) || lastChanged(id) < cutoff));
    let removed = 0;
    // Drain the whole backlog in the background, yielding between batches.
    for (const [position, id] of candidates.entries()) {
      if (this.closed) break;
      if (position > 0 && position % RECORD_BATCH === 0) await this.yieldToHost();
      if (this.closed) break;
      const path = `${folder}/${id}.json`;
      let record: StudioAgentRun;
      try { record = parseRunRecord(await adapter.read(path), projectPath, projectId); } catch { continue; }
      const entry = indexEntry(record);
      const root = record.workflowId ? index.entries.get(record.workflowId) : undefined;
      // Unknown or open parents keep an assignment; a fresh edit keeps a recent record.
      if (isActiveAgentRun(entry.status) || entry.workflowOpen || root?.workflowOpen || (record.workflowId && !root && present.has(record.workflowId)) || (newest.has(id) && entry.day >= cutoff)) {
        if (!sameEntry(index.entries.get(id), entry)) { index.entries.set(id, entry); index.dirty = true; }
        continue;
      }
      await adapter.remove(path);
      index.entries.delete(id); index.dirty = true; removed++;
    }
    if (index.dirty && !this.closed) this.scheduleIndex(projectPath, index);
    return removed;
  }
}
