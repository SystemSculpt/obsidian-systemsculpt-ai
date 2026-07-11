import { ManagedJobRecoveryStore, ManagedRecoveryAdapter } from "../ManagedJobRecoveryStore";
import { ManagedJobRecoveryRecord } from "../ManagedTypes";

class MemoryAdapter implements ManagedRecoveryAdapter {
  capabilities = { read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true };
  files = new Map<string, string>();
  events: string[] = [];
  async read(p: string) { if (!this.files.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return this.files.get(p)!; }
  async write(p: string, v: string) { this.events.push(`write:${p}`); this.files.set(p, v); }
  async exists(p: string) { return this.files.has(p); }
  async list(p: string) { return [...this.files.keys()].filter(k => k.startsWith(p)); }
  async mkdir(p: string) { this.events.push(`mkdir:${p}`); }
  async rename(a: string, b: string) { this.events.push(`rename:${a}:${b}`); if (!this.files.has(a)) throw new Error("missing"); this.files.set(b, this.files.get(a)!); this.files.delete(a); }
  async remove(p: string) { this.events.push(`remove:${p}`); this.files.delete(p); }
}

const initial = { capability: "transcription", operationId: "op-1", source: { identity: "vault:a.wav", fingerprint: "sha256:a" } } as const;

describe("ManagedJobRecoveryStore", () => {
  it("fails closed before creating records when atomic rename is unavailable", async () => {
    const adapter = new MemoryAdapter(); adapter.capabilities.atomicRename = false;
    expect(() => new ManagedJobRecoveryStore(adapter)).toThrow(expect.objectContaining({ code: "recovery_unavailable" }));
    expect(adapter.files.size).toBe(0);
  });

  it("creates admitted records before content reads and enforces revision CAS and legal transitions", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter, () => "2026-01-01T00:00:00.000Z");
    const admitted = await store.createAdmitted(initial);
    expect(admitted).toMatchObject({ schemaVersion: 1, revision: 1, phase: "admitted", operationId: "op-1" });
    const ready = await store.transition(initial.capability, initial.operationId, 1, "content_ready");
    expect(ready.revision).toBe(2);
    await expect(store.transition(initial.capability, initial.operationId, 1, "create_dispatching")).rejects.toMatchObject({ code: "stale_revision" });
    await expect(store.transition(initial.capability, initial.operationId, 2, "completed")).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("durably records dispatch metadata before transport and acknowledges separately", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter);
    let record = await store.createAdmitted(initial); record = await store.transition("transcription", "op-1", record.revision, "content_ready");
    const dispatched = await store.beginDispatch("transcription", "op-1", record.revision, { operation: "create", requestId: "req-1", idempotencyKey: "op-1:create", dispatchedAt: "2026-01-01T00:00:00Z" });
    expect(dispatched.phase).toBe("create_dispatching");
    const acknowledged = await store.acknowledge("transcription", "op-1", dispatched.revision, "created", { jobId: "job-1" });
    expect(acknowledged).toMatchObject({ phase: "created", revision: dispatched.revision + 1, jobId: "job-1", pendingDispatch: undefined });
  });

  it.each([
    ["transcription", "complete_dispatching", "queued", "upload_completed"],
    ["transcription", "complete_dispatching", "uploading", "blocked_ambiguous"],
    ["transcription", "start_dispatching", "processing", "processing"],
    ["document_processing", "start_dispatching", "completed", "result_ready"],
    ["document_processing", "abort_dispatching", "failed", "upload_aborted"],
    ["image_generation", "create_dispatching", "queued", "blocked_ambiguous"],
  ] as const)("reconciles %s %s + %s to %s without ordinal assumptions", (capability, phase, status, expected) => {
    expect(ManagedJobRecoveryStore.reconcile(capability, phase, status)).toBe(expected);
  });

  it("retains completed records and deletes abandoned records with journal first and last", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter);
    const record = await store.createAdmitted(initial);
    const abandoned = await store.transition("transcription", "op-1", record.revision, "abandoned");
    await store.delete("transcription", "op-1", abandoned.revision);
    const journalWrites = adapter.events.findIndex(e => e.includes(".delete-journal"));
    const tombstoneRename = adapter.events.findIndex(e => e.includes(".deleting"));
    const journalRemoval = adapter.events.map((e, i) => [e, i] as const).filter(([e]) => e.includes("remove:") && e.includes(".delete-journal")).at(-1)![1];
    expect(journalWrites).toBeLessThan(tombstoneRename);
    expect(journalRemoval).toBeGreaterThan(tombstoneRename);
    await expect(store.delete("transcription", "completed", 1)).rejects.toBeDefined();
  });

  it("never serializes signed URLs, credentials, providers, or arbitrary payloads", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter);
    const record = await store.createAdmitted(initial);
    await expect(store.update("transcription", "op-1", record.revision, { signedUrl: "https://secret", credential: "x" } as any)).rejects.toMatchObject({ code: "invalid_record" });
    expect([...adapter.files.values()].join(" ")).not.toContain("https://secret");
  });
});
