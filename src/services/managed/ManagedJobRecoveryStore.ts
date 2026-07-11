import { ManagedJobCapability, ManagedJobRecoveryRecord, ManagedJobStatus, ManagedPendingDispatch, ManagedRecoveryPhase } from "./ManagedTypes";

export interface ManagedRecoveryAdapter {
  capabilities: { read: boolean; write: boolean; list: boolean; mkdir: boolean; atomicRename: boolean; remove: boolean };
  read(path: string): Promise<string>; write(path: string, contents: string): Promise<void>; exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>; mkdir(path: string): Promise<void>; rename(from: string, to: string): Promise<void>; remove(path: string): Promise<void>;
}
class RecoveryError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = "ManagedRecoveryError"; } }

const transitions: Record<ManagedRecoveryPhase, ManagedRecoveryPhase[]> = {
  admitted: ["content_ready", "abandoned"], content_ready: ["prepare_dispatching", "create_dispatching", "abandoned"],
  prepare_dispatching: ["prepared", "blocked_ambiguous", "abandoned"], prepared: ["create_dispatching", "abandoned"],
  create_dispatching: ["created", "blocked_ambiguous", "abandoned"], created: ["part_dispatching", "complete_dispatching", "abort_dispatching", "processing", "abandoned"],
  part_dispatching: ["uploading", "blocked_ambiguous", "abandoned"], uploading: ["part_dispatching", "complete_dispatching", "abort_dispatching", "abandoned"],
  abort_dispatching: ["upload_aborted", "blocked_ambiguous", "abandoned"], upload_aborted: ["abandoned"],
  complete_dispatching: ["upload_completed", "processing", "result_ready", "blocked_ambiguous", "abandoned"], upload_completed: ["start_dispatching", "abandoned"],
  start_dispatching: ["processing", "result_ready", "blocked_ambiguous", "abandoned"], processing: ["result_ready", "abandoned"],
  result_ready: ["local_commit_pending", "abandoned"], local_commit_pending: ["completed", "abandoned"], completed: [], blocked_ambiguous: ["abandoned"], abandoned: [],
};
const allowedKeys = new Set(["schemaVersion", "revision", "capability", "operationId", "source", "jobId", "completedParts", "phase", "pendingDispatch", "createdAt", "updatedAt"]);

export class ManagedJobRecoveryStore {
  private readonly root = ".systemsculpt/managed-jobs";
  constructor(private readonly adapter: ManagedRecoveryAdapter, private readonly now: () => string = () => new Date().toISOString()) {
    const c = adapter.capabilities;
    if (!c || !c.read || !c.write || !c.list || !c.mkdir || !c.atomicRename || !c.remove) throw new RecoveryError("recovery_unavailable", "Recovery requires read, write, list, mkdir, atomic rename, and remove.");
  }

  async createAdmitted(input: { capability: ManagedJobCapability; operationId: string; source: { identity: string; fingerprint: string } }): Promise<ManagedJobRecoveryRecord> {
    const path = this.path(input.capability, input.operationId); await this.recover(path);
    if (await this.adapter.exists(path)) throw new RecoveryError("stale_revision", "Operation already exists.");
    const time = this.now();
    const record: ManagedJobRecoveryRecord = { schemaVersion: 1, revision: 1, ...input, phase: "admitted", createdAt: time, updatedAt: time };
    await this.persist(path, record, false); return record;
  }

  async read(capability: ManagedJobCapability, operationId: string): Promise<ManagedJobRecoveryRecord> {
    const path = this.path(capability, operationId); await this.recover(path); return this.parse(await this.adapter.read(path), capability, operationId);
  }

  async update(capability: ManagedJobCapability, operationId: string, expectedRevision: number, patch: Partial<ManagedJobRecoveryRecord>): Promise<ManagedJobRecoveryRecord> {
    for (const key of Object.keys(patch)) if (!allowedKeys.has(key)) throw new RecoveryError("invalid_record", `Forbidden recovery field: ${key}`);
    const current = await this.read(capability, operationId); this.cas(current, expectedRevision, capability, operationId);
    const next = { ...current, ...patch, schemaVersion: 1 as const, revision: current.revision + 1, capability, operationId, updatedAt: this.now() };
    this.validate(next); await this.persist(this.path(capability, operationId), next, true); return next;
  }

  async transition(capability: ManagedJobCapability, operationId: string, expectedRevision: number, phase: ManagedRecoveryPhase): Promise<ManagedJobRecoveryRecord> {
    const current = await this.read(capability, operationId); this.cas(current, expectedRevision, capability, operationId);
    if (!transitions[current.phase].includes(phase)) throw new RecoveryError("illegal_transition", `${current.phase} cannot transition to ${phase}.`);
    return this.update(capability, operationId, expectedRevision, { phase });
  }

  async beginDispatch(capability: ManagedJobCapability, operationId: string, expectedRevision: number, pendingDispatch: ManagedPendingDispatch): Promise<ManagedJobRecoveryRecord> {
    const phase = `${pendingDispatch.operation}_dispatching` as ManagedRecoveryPhase;
    const current = await this.read(capability, operationId); this.cas(current, expectedRevision, capability, operationId);
    if (!transitions[current.phase].includes(phase)) throw new RecoveryError("illegal_transition", `Cannot dispatch ${pendingDispatch.operation}.`);
    if ((["create", "complete", "start"] as string[]).includes(pendingDispatch.operation) && !pendingDispatch.idempotencyKey) throw new RecoveryError("invalid_record", "Idempotency key required.");
    return this.update(capability, operationId, expectedRevision, { phase, pendingDispatch });
  }

  async acknowledge(capability: ManagedJobCapability, operationId: string, expectedRevision: number, phase: ManagedRecoveryPhase, patch: Partial<ManagedJobRecoveryRecord> = {}): Promise<ManagedJobRecoveryRecord> {
    const current = await this.read(capability, operationId); this.cas(current, expectedRevision, capability, operationId);
    if (!current.phase.endsWith("_dispatching") || !transitions[current.phase].includes(phase)) throw new RecoveryError("illegal_transition", "Acknowledgement does not match dispatch.");
    return this.update(capability, operationId, expectedRevision, { ...patch, phase, pendingDispatch: undefined });
  }

  async delete(capability: ManagedJobCapability, operationId: string, expectedRevision: number): Promise<void> {
    const record = await this.read(capability, operationId); this.cas(record, expectedRevision, capability, operationId);
    if (record.phase !== "abandoned" && record.phase !== "upload_aborted") throw new RecoveryError("illegal_transition", "Only abandoned or upload-aborted records may be deleted.");
    const path = this.path(capability, operationId), journal = `${path}.delete-journal`, tombstone = `${path}.deleting`;
    await this.adapter.write(journal, JSON.stringify({ schemaVersion: 1, revision: record.revision, intent: "delete" }));
    const parsed = JSON.parse(await this.adapter.read(journal)); if (parsed.revision !== record.revision) throw new RecoveryError("recovery_unavailable", "Delete journal validation failed.");
    try { await this.adapter.rename(path, tombstone); } catch { throw new RecoveryError("recovery_unavailable", "Atomic delete rename failed."); }
    await this.cleanupDelete(path);
  }

  static reconcile(capability: ManagedJobCapability, phase: ManagedRecoveryPhase, status: ManagedJobStatus): ManagedRecoveryPhase {
    const valid: Record<ManagedJobCapability, ManagedJobStatus[]> = { transcription: ["uploading", "queued", "processing", "succeeded", "failed", "expired"], document_processing: ["uploading", "queued", "processing", "completed", "failed"], image_generation: ["queued", "processing", "succeeded", "failed", "expired"] };
    if (!valid[capability].includes(status)) return "blocked_ambiguous";
    if (phase === "prepare_dispatching" || phase === "create_dispatching" || phase === "part_dispatching") return "blocked_ambiguous";
    if (phase === "abort_dispatching") return status === "failed" ? "upload_aborted" : "blocked_ambiguous";
    const terminal = capability === "document_processing" ? ["completed", "failed"] : ["succeeded", "failed", "expired"];
    if (phase === "complete_dispatching") {
      if (status === "uploading") return "blocked_ambiguous"; if (status === "queued") return "upload_completed";
      if (status === "processing") return "processing"; if (terminal.includes(status)) return "result_ready";
    }
    if (phase === "start_dispatching") {
      if (status === "uploading" || status === "queued") return "blocked_ambiguous"; if (status === "processing") return "processing"; if (terminal.includes(status)) return "result_ready";
    }
    if (phase === "processing") return terminal.includes(status) ? "result_ready" : "processing";
    return "blocked_ambiguous";
  }

  private path(capability: ManagedJobCapability, operationId: string) { if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new RecoveryError("invalid_record", "Invalid operation ID."); return `${this.root}/${capability}/${operationId}.json`; }
  private cas(record: ManagedJobRecoveryRecord, revision: number, capability: ManagedJobCapability, operationId: string) { if (record.revision !== revision) throw new RecoveryError("stale_revision", "Recovery record revision changed."); if (record.capability !== capability || record.operationId !== operationId) throw new RecoveryError("record_mismatch", "Recovery record identity mismatch."); }
  private parse(raw: string, capability: ManagedJobCapability, operationId: string) { let value: unknown; try { value = JSON.parse(raw); } catch { throw new RecoveryError("quarantined_record", "Malformed recovery record."); } this.validate(value); const record = value as ManagedJobRecoveryRecord; if (record.capability !== capability || record.operationId !== operationId) throw new RecoveryError("record_mismatch", "Recovery record identity mismatch."); return record; }
  private validate(value: any): asserts value is ManagedJobRecoveryRecord { if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.revision) || value.revision < 1 || !transitions[value.phase as ManagedRecoveryPhase] || typeof value.operationId !== "string" || !value.source || typeof value.source.identity !== "string" || typeof value.source.fingerprint !== "string") throw new RecoveryError("quarantined_record", "Malformed or future recovery record."); for (const k of Object.keys(value)) if (!allowedKeys.has(k)) throw new RecoveryError("invalid_record", `Forbidden recovery field: ${k}`); const serialized = JSON.stringify(value).toLowerCase(); if (/signed.?url|credential|provider|storage|authorization|x-license-key/.test(serialized)) throw new RecoveryError("invalid_record", "Recovery record contains ephemeral or secret data."); }

  private async persist(path: string, record: ManagedJobRecoveryRecord, hasOriginal: boolean) {
    const slash = path.lastIndexOf("/"); await this.adapter.mkdir(path.slice(0, slash));
    const temp = `${path}.tmp`, journal = `${path}.journal`, backup = `${path}.bak`, body = JSON.stringify(record);
    await this.adapter.write(temp, body); this.validate(JSON.parse(await this.adapter.read(temp)));
    await this.adapter.write(journal, JSON.stringify({ phase: "prepared", revision: record.revision }));
    try {
      if (hasOriginal) { await this.adapter.rename(path, backup); await this.adapter.write(journal, JSON.stringify({ phase: "original_moved", revision: record.revision })); }
      await this.adapter.rename(temp, path); this.validate(JSON.parse(await this.adapter.read(path)));
      await this.adapter.write(journal, JSON.stringify({ phase: "promoted", revision: record.revision }));
      if (await this.adapter.exists(backup)) await this.adapter.remove(backup); await this.adapter.remove(journal);
    } catch { throw new RecoveryError("recovery_unavailable", "Atomic recovery write failed."); }
  }

  private async recover(path: string) {
    const deleteJournal = `${path}.delete-journal`; if (await this.adapter.exists(deleteJournal)) { await this.cleanupDelete(path); return; }
    const journal = `${path}.journal`; if (!(await this.adapter.exists(journal))) return;
    let entry: any; try { entry = JSON.parse(await this.adapter.read(journal)); } catch { throw new RecoveryError("quarantined_record", "Malformed write journal."); }
    const temp = `${path}.tmp`, backup = `${path}.bak`;
    if (entry.phase === "prepared") { if (await this.adapter.exists(temp)) await this.adapter.remove(temp); await this.adapter.remove(journal); return; }
    if (entry.phase === "original_moved") { if (await this.adapter.exists(temp)) { const candidate = JSON.parse(await this.adapter.read(temp)); this.validate(candidate); await this.adapter.rename(temp, path); } else if (await this.adapter.exists(backup)) await this.adapter.rename(backup, path); }
    if (entry.phase === "promoted" || entry.phase === "original_moved") { if (await this.adapter.exists(path)) this.validate(JSON.parse(await this.adapter.read(path))); if (await this.adapter.exists(backup)) await this.adapter.remove(backup); await this.adapter.remove(journal); }
  }
  private async cleanupDelete(path: string) { for (const suffix of [".deleting", ".tmp", ".bak", ".journal"]) if (await this.adapter.exists(`${path}${suffix}`)) await this.adapter.remove(`${path}${suffix}`); if (await this.adapter.exists(path)) await this.adapter.remove(path); if (await this.adapter.exists(`${path}.delete-journal`)) await this.adapter.remove(`${path}.delete-journal`); }
}
