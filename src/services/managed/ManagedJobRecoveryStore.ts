import { ManagedJobCapability, ManagedJobRecoveryRecord, ManagedPendingDispatch, ManagedRecoveryPhase } from "./ManagedTypes";

export interface ManagedRecoveryAdapter {
  readonly storageDomain: string;
  capabilities: { read: boolean; write: boolean; list: boolean; mkdir: boolean; atomicRename: boolean; remove: boolean };
  read(path: string): Promise<string>; write(path: string, contents: string): Promise<void>; exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>; mkdir(path: string): Promise<void>; rename(from: string, to: string): Promise<void>; remove(path: string): Promise<void>;
}
export class ManagedRecoveryError extends Error { constructor(public readonly code: "recovery_unavailable" | "recovery_corrupt" | "invalid_record" | "stale_revision" | "record_mismatch" | "illegal_transition", message: string) { super(message); this.name = "ManagedRecoveryError"; } }

type WireStatus = "uploading" | "queued" | "processing" | "succeeded" | "completed" | "failed" | "expired" | "unknown";
type WriteJournal = { schemaVersion: 1; phase: "prepared" | "original_moved" | "promoted"; capability: ManagedJobCapability; operationId: string; fromRevision: number; toRevision: number };
type DeleteJournal = { schemaVersion: 1; capability: ManagedJobCapability; operationId: string; revision: number; intent: "delete" };
const capabilities: ManagedJobCapability[] = ["transcription", "document_processing", "image_generation"];
const phases: ManagedRecoveryPhase[] = ["admitted", "content_ready", "prepare_dispatching", "prepared", "create_dispatching", "created", "part_dispatching", "uploading", "abort_dispatching", "upload_aborted", "complete_dispatching", "upload_completed", "start_dispatching", "processing", "result_ready", "local_commit_pending", "completed", "blocked_ambiguous", "abandoned"];
const recordKeys = new Set(["schemaVersion", "revision", "capability", "operationId", "source", "jobId", "completedParts", "phase", "pendingDispatch", "createdAt", "updatedAt"]);
const domainLocks = new Map<string, Map<string, Promise<void>>>();
const dispatchLegality: Record<ManagedJobCapability, Partial<Record<ManagedRecoveryPhase, ManagedPendingDispatch["operation"][]>>> = {
  transcription: { content_ready: ["create"], created: ["part", "complete", "abort"], uploading: ["part", "complete", "abort"], upload_completed: ["start"] },
  document_processing: { content_ready: ["create"], created: ["part", "complete", "abort"], uploading: ["part", "complete", "abort"], upload_completed: ["start"] },
  image_generation: { content_ready: ["prepare", "create"], prepared: ["create"] },
};

export class ManagedJobRecoveryStore {
  private readonly root = ".systemsculpt/managed-jobs";
  private readonly locks: Map<string, Promise<void>>;
  constructor(private readonly adapter: ManagedRecoveryAdapter, private readonly now: () => string = () => new Date().toISOString()) {
    const c = adapter.capabilities;
    if (!c?.read || !c.write || !c.list || !c.mkdir || !c.atomicRename || !c.remove || typeof adapter.storageDomain !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(adapter.storageDomain)) throw new ManagedRecoveryError("recovery_unavailable", "Recovery requires a stable storage domain plus read, write, list, mkdir, atomic rename, and remove.");
    this.locks = domainLocks.get(adapter.storageDomain) ?? new Map<string, Promise<void>>(); domainLocks.set(adapter.storageDomain, this.locks);
  }

  async initialize(): Promise<void> {
    await this.adapter.mkdir(this.root); const files = await this.adapter.list(this.root);
    const bases = new Set(files.map(p => p.replace(/\.(?:tmp|journal|bak|delete-journal|deleting)$/, "")).filter(p => p.endsWith(".json"))); const errors: ManagedRecoveryError[] = [];
    for (const path of [...bases].sort()) { try { await this.serial(path, async () => { await this.recover(path); if (await this.adapter.exists(path)) await this.readCandidate(path); }); } catch (error) { errors.push(error instanceof ManagedRecoveryError ? error : new ManagedRecoveryError("recovery_corrupt", "Recovery initialization failed.")); } }
    if (errors.length) throw errors[0];
  }

  createAdmitted(input: { capability: ManagedJobCapability; operationId: string; source: { identity: string; fingerprint: string } }): Promise<ManagedJobRecoveryRecord> {
    const path = this.path(input.capability, input.operationId);
    return this.serial(path, async () => {
      await this.recover(path); if (await this.adapter.exists(path)) throw new ManagedRecoveryError("stale_revision", "Operation already exists.");
      const time = this.now(); const record: ManagedJobRecoveryRecord = { schemaVersion: 1, revision: 1, ...input, phase: "admitted", createdAt: time, updatedAt: time };
      this.validateRecord(record); await this.persist(path, record, 0); return record;
    });
  }
  read(capability: ManagedJobCapability, operationId: string): Promise<ManagedJobRecoveryRecord> { const path = this.path(capability, operationId); return this.serial(path, async () => { await this.recover(path); return this.readRecord(path, capability, operationId); }); }
  markContentReady(c: ManagedJobCapability, id: string, rev: number) { return this.mutate(c, id, rev, r => { if (r.phase !== "admitted") this.illegal(); return { ...r, phase: "content_ready" }; }); }
  abandon(c: ManagedJobCapability, id: string, rev: number) { return this.mutate(c, id, rev, r => { if (r.phase === "completed" || r.phase === "abandoned") this.illegal(); return { ...r, phase: "abandoned", pendingDispatch: undefined }; }); }
  markLocalCommitPending(c: ManagedJobCapability, id: string, rev: number) { return this.mutate(c, id, rev, r => { if (r.phase !== "result_ready") this.illegal(); return { ...r, phase: "local_commit_pending" }; }); }
  completeLocalCommit(c: ManagedJobCapability, id: string, rev: number) { return this.mutate(c, id, rev, r => { if (r.phase !== "local_commit_pending") this.illegal(); return { ...r, phase: "completed" }; }); }

  beginDispatch(c: ManagedJobCapability, id: string, rev: number, pending: ManagedPendingDispatch) {
    return this.mutate(c, id, rev, r => {
      if (!dispatchLegality[c][r.phase]?.includes(pending.operation)) this.illegal("Impossible capability/phase operation.");
      if (pending.operation === "part" && (!Number.isInteger(pending.partNumber) || pending.partNumber! < 1)) throw new ManagedRecoveryError("invalid_record", "Part dispatch requires a positive part number.");
      const idemRequired = c !== "image_generation" && ["create", "complete", "start"].includes(pending.operation);
      if (idemRequired && pending.idempotencyKey !== `${id}:${pending.operation}`) throw new ManagedRecoveryError("invalid_record", "Invalid deterministic idempotency key.");
      if (!idemRequired && c !== "image_generation" && pending.idempotencyKey) throw new ManagedRecoveryError("invalid_record", "Idempotency key is forbidden for this operation.");
      if (c === "image_generation" && pending.idempotencyKey !== undefined && pending.idempotencyKey !== `${id}:create`) throw new ManagedRecoveryError("invalid_record", "Invalid optional image idempotency key.");
      const phase = `${pending.operation}_dispatching` as ManagedRecoveryPhase; return { ...r, phase, pendingDispatch: pending };
    });
  }
  acknowledgeCreated(c: ManagedJobCapability, id: string, rev: number, jobId: string) { return this.ack(c, id, rev, "create_dispatching", "created", { jobId }); }
  acknowledgePrepared(id: string, rev: number) { return this.ack("image_generation", id, rev, "prepare_dispatching", "prepared"); }
  acknowledgePart(c: Exclude<ManagedJobCapability, "image_generation">, id: string, rev: number, part: { partNumber: number; etag: string }) { return this.mutate(c, id, rev, r => { if (r.phase !== "part_dispatching" || r.pendingDispatch?.partNumber !== part.partNumber || !part.etag || part.etag.length > 1024) this.illegal(); return { ...r, phase: "uploading", pendingDispatch: undefined, completedParts: [...(r.completedParts ?? []).filter(x => x.partNumber !== part.partNumber), part] }; }); }
  acknowledgeComplete(c: Exclude<ManagedJobCapability, "image_generation">, id: string, rev: number) { return this.ack(c, id, rev, "complete_dispatching", "upload_completed"); }
  acknowledgeStarted(c: Exclude<ManagedJobCapability, "image_generation">, id: string, rev: number) { return this.ack(c, id, rev, "start_dispatching", "processing"); }
  acknowledgeAbort(c: Exclude<ManagedJobCapability, "image_generation">, id: string, rev: number) { return this.ack(c, id, rev, "abort_dispatching", "upload_aborted"); }

  delete(c: ManagedJobCapability, id: string, rev: number): Promise<void> {
    const path = this.path(c, id); return this.serial(path, async () => {
      await this.recover(path); const record = await this.readRecord(path, c, id); this.cas(record, rev, c, id);
      if (record.phase !== "abandoned" && record.phase !== "upload_aborted") this.illegal("Only abandoned or upload-aborted records may be deleted.");
      const journal: DeleteJournal = { schemaVersion: 1, capability: c, operationId: id, revision: rev, intent: "delete" };
      await this.adapter.write(`${path}.delete-journal`, JSON.stringify(journal)); this.parseDeleteJournal(await this.adapter.read(`${path}.delete-journal`), path);
      try { await this.adapter.rename(path, `${path}.deleting`); } catch { throw new ManagedRecoveryError("recovery_unavailable", "Atomic delete rename failed."); }
      await this.finishDelete(path, journal);
    });
  }

  static reconcile(c: ManagedJobCapability, phase: ManagedRecoveryPhase, status: WireStatus): ManagedRecoveryPhase {
    const valid: Record<ManagedJobCapability, WireStatus[]> = { transcription: ["uploading", "queued", "processing", "succeeded", "failed", "expired"], document_processing: ["uploading", "queued", "processing", "completed", "failed"], image_generation: ["queued", "processing", "succeeded", "failed", "expired"] };
    if (!valid[c].includes(status)) return "blocked_ambiguous";
    if (c === "image_generation") {
      if (phase === "prepare_dispatching" || phase === "create_dispatching") return "blocked_ambiguous";
      if (phase === "processing") return status === "queued" || status === "processing" ? "processing" : "result_ready";
      return "blocked_ambiguous";
    }
    if (["prepare_dispatching", "create_dispatching", "part_dispatching"].includes(phase)) return "blocked_ambiguous";
    if (phase === "abort_dispatching") return status === "failed" ? "upload_aborted" : "blocked_ambiguous";
    const terminal = c === "document_processing" ? ["completed", "failed"] : ["succeeded", "failed", "expired"];
    if (phase === "complete_dispatching") { if (status === "queued") return "upload_completed"; if (status === "processing") return "processing"; if (terminal.includes(status)) return "result_ready"; return "blocked_ambiguous"; }
    if (phase === "start_dispatching") { if (status === "processing") return "processing"; if (terminal.includes(status)) return "result_ready"; return "blocked_ambiguous"; }
    if (phase === "processing") return terminal.includes(status) ? "result_ready" : "processing";
    return "blocked_ambiguous";
  }

  private ack(c: ManagedJobCapability, id: string, rev: number, from: ManagedRecoveryPhase, to: ManagedRecoveryPhase, extra: Partial<ManagedJobRecoveryRecord> = {}) { return this.mutate(c, id, rev, r => { if (r.phase !== from) this.illegal(); return { ...r, ...extra, phase: to, pendingDispatch: undefined }; }); }
  private mutate(c: ManagedJobCapability, id: string, rev: number, fn: (r: ManagedJobRecoveryRecord) => ManagedJobRecoveryRecord): Promise<ManagedJobRecoveryRecord> { const path = this.path(c, id); return this.serial(path, async () => { await this.recover(path); const current = await this.readRecord(path, c, id); this.cas(current, rev, c, id); const proposed = fn(current); const next = { ...proposed, schemaVersion: 1 as const, revision: current.revision + 1, capability: current.capability, operationId: current.operationId, source: current.source, createdAt: current.createdAt, updatedAt: this.now() }; this.validateRecord(next); await this.persist(path, next, current.revision); return next; }); }
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> { const previous = this.locks.get(key) ?? Promise.resolve(); let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const tail = previous.catch(() => undefined).then(() => gate); this.locks.set(key, tail); return previous.catch(() => undefined).then(fn).finally(() => { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }); }
  private path(c: ManagedJobCapability, id: string) { if (!capabilities.includes(c) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new ManagedRecoveryError("invalid_record", "Invalid recovery identity."); return `${this.root}/${c}/${id}.json`; }
  private illegal(message = "Illegal recovery transition."): never { throw new ManagedRecoveryError("illegal_transition", message); }
  private cas(r: ManagedJobRecoveryRecord, rev: number, c: ManagedJobCapability, id: string) { if (r.revision !== rev) throw new ManagedRecoveryError("stale_revision", "Recovery revision changed."); if (r.capability !== c || r.operationId !== id) throw new ManagedRecoveryError("record_mismatch", "Recovery identity mismatch."); }

  private validateRecord(v: unknown): asserts v is ManagedJobRecoveryRecord {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ManagedRecoveryError("invalid_record", "Record must be an object."); const x = v as any;
    if (Object.keys(x).some(k => !recordKeys.has(k)) || x.schemaVersion !== 1 || !Number.isInteger(x.revision) || x.revision < 1 || !capabilities.includes(x.capability) || !phases.includes(x.phase)) throw new ManagedRecoveryError("invalid_record", "Invalid recovery schema.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x.operationId) || typeof x.source?.identity !== "string" || x.source.identity.length < 1 || x.source.identity.length > 512 || /(?:https?:\/\/|\b(?:authorization|credential|headers?|prompt|content)\b)/i.test(x.source.identity) || !/^sha256:[a-f0-9]{64}$/.test(x.source.fingerprint)) throw new ManagedRecoveryError("invalid_record", "Invalid source identity/fingerprint.");
    if (typeof x.createdAt !== "string" || !Number.isFinite(Date.parse(x.createdAt)) || typeof x.updatedAt !== "string" || !Number.isFinite(Date.parse(x.updatedAt)) || Date.parse(x.updatedAt) < Date.parse(x.createdAt)) throw new ManagedRecoveryError("invalid_record", "Invalid timestamps.");
    if (x.jobId !== undefined && (typeof x.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(x.jobId))) throw new ManagedRecoveryError("invalid_record", "Invalid first-party job ID.");
    if (x.completedParts !== undefined && (!Array.isArray(x.completedParts) || x.completedParts.length > 50 || x.completedParts.some((p: any) => Object.keys(p).sort().join() !== "etag,partNumber" || !Number.isInteger(p.partNumber) || p.partNumber < 1 || typeof p.etag !== "string" || !/^"?[A-Fa-f0-9]{8,128}(?:-[1-9][0-9]{0,9})?"?$/.test(p.etag) || (p.etag.startsWith('"') !== p.etag.endsWith('"'))))) throw new ManagedRecoveryError("invalid_record", "Invalid completed parts.");
    const phaseOperation: Partial<Record<ManagedRecoveryPhase, ManagedPendingDispatch["operation"]>> = { prepare_dispatching: "prepare", create_dispatching: "create", part_dispatching: "part", abort_dispatching: "abort", complete_dispatching: "complete", start_dispatching: "start" };
    const expectedOperation = phaseOperation[x.phase as ManagedRecoveryPhase]; if (expectedOperation) { if (x.pendingDispatch === undefined) throw new ManagedRecoveryError("invalid_record", "Dispatching phase requires metadata."); this.validateDispatch(x.pendingDispatch); if (x.pendingDispatch.operation !== expectedOperation) throw new ManagedRecoveryError("invalid_record", "Dispatch operation/phase mismatch."); if (expectedOperation === "part" ? !Number.isInteger(x.pendingDispatch.partNumber) || x.pendingDispatch.partNumber < 1 : x.pendingDispatch.partNumber !== undefined) throw new ManagedRecoveryError("invalid_record", "Dispatch part-number mismatch."); const requiresIdem = x.capability !== "image_generation" && ["create", "complete", "start"].includes(expectedOperation); if (requiresIdem && x.pendingDispatch.idempotencyKey !== `${x.operationId}:${expectedOperation}` || !requiresIdem && x.pendingDispatch.idempotencyKey !== undefined && !(x.capability === "image_generation" && expectedOperation === "create" && x.pendingDispatch.idempotencyKey === `${x.operationId}:create`)) throw new ManagedRecoveryError("invalid_record", "Dispatch idempotency mismatch."); } else if (x.pendingDispatch !== undefined) throw new ManagedRecoveryError("invalid_record", "Pending metadata outside dispatching phase.");
    const imageForbidden: ManagedRecoveryPhase[] = ["part_dispatching", "uploading", "abort_dispatching", "upload_aborted", "complete_dispatching", "upload_completed", "start_dispatching"]; const multipartForbidden: ManagedRecoveryPhase[] = ["prepare_dispatching", "prepared"]; if (x.capability === "image_generation" ? imageForbidden.includes(x.phase) : multipartForbidden.includes(x.phase)) throw new ManagedRecoveryError("invalid_record", "Capability/phase mismatch.");
  }
  private validateDispatch(p: any) { const keys = new Set(["operation", "requestId", "idempotencyKey", "partNumber", "dispatchedAt"]); if (!p || typeof p !== "object" || Object.keys(p).some(k => !keys.has(k)) || !["prepare", "create", "part", "abort", "complete", "start"].includes(p.operation) || typeof p.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(p.requestId) || !Number.isFinite(Date.parse(p.dispatchedAt))) throw new ManagedRecoveryError("invalid_record", "Invalid dispatch metadata."); if (p.idempotencyKey !== undefined && (typeof p.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:(?:create|complete|start)$/.test(p.idempotencyKey))) throw new ManagedRecoveryError("invalid_record", "Invalid idempotency key."); }
  private async readRecord(path: string, c: ManagedJobCapability, id: string) { let parsed: unknown; try { parsed = JSON.parse(await this.adapter.read(path)); } catch { throw new ManagedRecoveryError("recovery_corrupt", "Malformed recovery record."); } try { this.validateRecord(parsed); } catch { throw new ManagedRecoveryError("recovery_corrupt", "Invalid recovery record."); } this.cas(parsed, (parsed as ManagedJobRecoveryRecord).revision, c, id); return parsed as ManagedJobRecoveryRecord; }

  private journal(raw: string, path: string): WriteJournal { let x: any; try { x = JSON.parse(raw); } catch { throw new ManagedRecoveryError("recovery_corrupt", "Malformed write journal."); } const identity = this.identity(path); if (!x || Object.keys(x).sort().join() !== "capability,fromRevision,operationId,phase,schemaVersion,toRevision" || x.schemaVersion !== 1 || !["prepared", "original_moved", "promoted"].includes(x.phase) || x.capability !== identity.capability || x.operationId !== identity.operationId || !Number.isInteger(x.fromRevision) || x.toRevision !== x.fromRevision + 1) throw new ManagedRecoveryError("recovery_corrupt", "Invalid write journal."); return x; }
  private parseDeleteJournal(raw: string, path: string): DeleteJournal { let x: any; try { x = JSON.parse(raw); } catch { throw new ManagedRecoveryError("recovery_corrupt", "Malformed delete journal."); } const identity = this.identity(path); if (!x || Object.keys(x).sort().join() !== "capability,intent,operationId,revision,schemaVersion" || x.schemaVersion !== 1 || x.intent !== "delete" || x.capability !== identity.capability || x.operationId !== identity.operationId || !Number.isInteger(x.revision) || x.revision < 1) throw new ManagedRecoveryError("recovery_corrupt", "Invalid delete journal."); return x; }
  private identity(path: string) { const match = path.match(/\/([^/]+)\/([^/]+)\.json$/); if (!match || !capabilities.includes(match[1] as ManagedJobCapability)) throw new ManagedRecoveryError("recovery_corrupt", "Invalid recovery path."); return { capability: match[1] as ManagedJobCapability, operationId: match[2] }; }

  private async persist(path: string, record: ManagedJobRecoveryRecord, fromRevision: number) {
    await this.adapter.mkdir(path.slice(0, path.lastIndexOf("/"))); const temp = `${path}.tmp`, journalPath = `${path}.journal`, backup = `${path}.bak`;
    await this.adapter.write(temp, JSON.stringify(record)); const candidate = await this.readCandidate(temp); if (candidate.revision !== record.revision) throw new ManagedRecoveryError("recovery_corrupt", "Candidate revision mismatch.");
    const base = { schemaVersion: 1 as const, capability: record.capability, operationId: record.operationId, fromRevision, toRevision: record.revision };
    await this.adapter.write(journalPath, JSON.stringify({ ...base, phase: "prepared" }));
    try {
      if (fromRevision > 0) await this.adapter.rename(path, backup);
      if (fromRevision > 0) await this.adapter.write(journalPath, JSON.stringify({ ...base, phase: "original_moved" }));
      await this.adapter.rename(temp, path); await this.readCandidate(path);
      await this.adapter.write(journalPath, JSON.stringify({ ...base, phase: "promoted" }));
      if (await this.adapter.exists(backup)) await this.adapter.remove(backup); await this.adapter.remove(journalPath);
    } catch (e) { if (e instanceof ManagedRecoveryError) throw e; throw new ManagedRecoveryError("recovery_unavailable", "Atomic recovery write interrupted."); }
  }
  private async readCandidate(path: string) { let x: unknown; try { x = JSON.parse(await this.adapter.read(path)); this.validateRecord(x); } catch { throw new ManagedRecoveryError("recovery_corrupt", "Invalid recovery candidate."); } return x as ManagedJobRecoveryRecord; }

  private async recover(path: string) {
    if (await this.adapter.exists(`${path}.delete-journal`)) { const journal = this.parseDeleteJournal(await this.adapter.read(`${path}.delete-journal`), path); const existing = await this.optionalRecord(path); const tombstone = await this.optionalRecord(`${path}.deleting`); if (existing && existing.revision !== journal.revision || tombstone && tombstone.revision !== journal.revision) throw new ManagedRecoveryError("recovery_corrupt", "Delete journal revision mismatch."); await this.finishDelete(path, journal); return; }
    if (!(await this.adapter.exists(`${path}.journal`))) { if (await this.adapter.exists(`${path}.tmp`)) await this.adapter.remove(`${path}.tmp`); if (await this.adapter.exists(`${path}.bak`) || await this.adapter.exists(`${path}.deleting`)) throw new ManagedRecoveryError("recovery_corrupt", "Orphan recovery artifact without journal."); return; }
    const j = this.journal(await this.adapter.read(`${path}.journal`), path); const current = await this.optionalRecord(path), temp = await this.optionalRecord(`${path}.tmp`), backup = await this.optionalRecord(`${path}.bak`);
    for (const candidate of [current, temp, backup]) if (candidate && candidate.capability !== j.capability || candidate && candidate.operationId !== j.operationId) throw new ManagedRecoveryError("recovery_corrupt", "Journal candidate identity mismatch.");
    if (current && current.revision > j.toRevision || temp && temp.revision !== j.toRevision || backup && backup.revision !== j.fromRevision) throw new ManagedRecoveryError("recovery_corrupt", "Journal revision monotonicity failure.");
    if (current?.revision === j.toRevision) { if (await this.adapter.exists(`${path}.tmp`)) await this.adapter.remove(`${path}.tmp`); if (await this.adapter.exists(`${path}.bak`)) await this.adapter.remove(`${path}.bak`); await this.adapter.remove(`${path}.journal`); return; }
    if (temp?.revision === j.toRevision && (current?.revision === j.fromRevision || backup?.revision === j.fromRevision)) { if (current?.revision === j.fromRevision && !(await this.adapter.exists(`${path}.bak`))) await this.adapter.rename(path, `${path}.bak`); await this.adapter.rename(`${path}.tmp`, path); if (await this.adapter.exists(`${path}.bak`)) await this.adapter.remove(`${path}.bak`); await this.adapter.remove(`${path}.journal`); return; }
    if (backup?.revision === j.fromRevision && !temp) { await this.adapter.rename(`${path}.bak`, path); await this.adapter.remove(`${path}.journal`); return; }
    if (j.fromRevision === 0 && temp?.revision === 1) { await this.adapter.rename(`${path}.tmp`, path); await this.adapter.remove(`${path}.journal`); return; }
    throw new ManagedRecoveryError("recovery_corrupt", "Unrecoverable journal artifact combination.");
  }
  private async optionalRecord(path: string) { if (!(await this.adapter.exists(path))) return undefined; return this.readCandidate(path); }
  private async finishDelete(path: string, j: DeleteJournal) { const current = await this.optionalRecord(path); if (current && current.revision !== j.revision) throw new ManagedRecoveryError("recovery_corrupt", "Refusing mismatched record deletion."); for (const suffix of [".deleting", ".tmp", ".bak", ".journal"]) if (await this.adapter.exists(`${path}${suffix}`)) await this.adapter.remove(`${path}${suffix}`); if (await this.adapter.exists(path)) await this.adapter.remove(path); if (await this.adapter.exists(`${path}.delete-journal`)) await this.adapter.remove(`${path}.delete-journal`); }
}
