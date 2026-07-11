import { ManagedJobRecoveryStore, ManagedRecoveryAdapter } from "../ManagedJobRecoveryStore";
import { ManagedJobCapability, ManagedRecoveryPhase } from "../ManagedTypes";

class MemoryAdapter implements ManagedRecoveryAdapter {
  capabilities = { read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true };
  storageDomain = "memory:vault-1";
  events: string[] = []; failAt = -1; boundaries = 0;
  constructor(public files = new Map<string, string>()) {}
  private boundary(event: string) { this.events.push(event); if (this.boundaries++ === this.failAt) throw new Error("injected crash"); }
  async read(p: string) { if (!this.files.has(p)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return this.files.get(p)!; }
  async write(p: string, v: string) { this.boundary(`write:${p}`); this.files.set(p, v); }
  async exists(p: string) { return this.files.has(p); }
  async list(p: string) { return [...this.files.keys()].filter(k => k.startsWith(p)); }
  async mkdir(p: string) { this.boundary(`mkdir:${p}`); }
  async rename(a: string, b: string) { this.boundary(`rename:${a}:${b}`); if (!this.files.has(a)) throw new Error("missing"); this.files.set(b, this.files.get(a)!); this.files.delete(a); }
  async remove(p: string) { this.boundary(`remove:${p}`); this.files.delete(p); }
  clone() { return new MemoryAdapter(new Map(this.files)); }
}
const initial = { capability: "transcription", operationId: "op-1", source: { identity: "vault:a.wav", fingerprint: `sha256:${"a".repeat(64)}` } } as const;
const create = async (store: ManagedJobRecoveryStore, value = initial) => store.createAdmitted(value);

describe("ManagedJobRecoveryStore hardening", () => {
  it("fails closed without atomic rename and serializes same-operation create/CAS mutations", async () => {
    const bad = new MemoryAdapter(); bad.capabilities.atomicRename = false;
    expect(() => new ManagedJobRecoveryStore(bad)).toThrow(expect.objectContaining({ code: "recovery_unavailable" }));
    const sharedFiles = new Map<string, string>(); const adapter = new MemoryAdapter(sharedFiles); const siblingAdapter = new MemoryAdapter(sharedFiles);
    const store = new ManagedJobRecoveryStore(adapter); const siblingStore = new ManagedJobRecoveryStore(siblingAdapter);
    const creates = await Promise.allSettled([create(store), create(siblingStore)]);
    expect(creates.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const admitted = await store.read("transcription", "op-1");
    const mutations = await Promise.allSettled([
      store.markContentReady("transcription", "op-1", admitted.revision),
      store.markContentReady("transcription", "op-1", admitted.revision),
    ]);
    expect(mutations.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(mutations.filter(x => x.status === "rejected")).toHaveLength(1);
  });

  it("exposes only legal typed mutations and preserves immutable identity and creation time", async () => {
    const store = new ManagedJobRecoveryStore(new MemoryAdapter(), () => "2026-01-01T00:00:00.000Z");
    const admitted = await create(store); const ready = await store.markContentReady("transcription", "op-1", admitted.revision);
    const dispatch = await store.beginDispatch("transcription", "op-1", ready.revision, { operation: "create", requestId: "req-1", idempotencyKey: "op-1:create", dispatchedAt: "2026-01-01T00:00:00.000Z" });
    const ack = await store.acknowledgeCreated("transcription", "op-1", dispatch.revision, "job-1");
    expect(ack).toMatchObject({ capability: "transcription", operationId: "op-1", createdAt: admitted.createdAt, phase: "created", jobId: "job-1" });
    expect((store as any).update).toBeUndefined(); expect((store as any).transition).toBeUndefined();
  });

  it("recovers every write boundary including original moved before journal phase update", async () => {
    const baseline = new MemoryAdapter(); const initialStore = new ManagedJobRecoveryStore(baseline); const admitted = await create(initialStore);
    for (let failAt = 0; failAt < 12; failAt++) {
      const adapter = baseline.clone(); adapter.failAt = failAt; const store = new ManagedJobRecoveryStore(adapter);
      await store.markContentReady("transcription", "op-1", admitted.revision).catch(() => undefined);
      adapter.failAt = -1;
      const recovered = new ManagedJobRecoveryStore(adapter); await recovered.initialize();
      const record = await recovered.read("transcription", "op-1");
      expect([1, 2]).toContain(record.revision);
      expect(adapter.files.has(".systemsculpt/managed-jobs/transcription/op-1.json.journal")).toBe(false);
    }
  });

  it("quarantines malformed/stale journals and never overwrites a newer record", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter); await create(store);
    const path = ".systemsculpt/managed-jobs/transcription/op-1.json";
    adapter.files.set(`${path}.journal`, JSON.stringify({ schemaVersion: 1, phase: "promoted", fromRevision: 5, toRevision: 6 }));
    await expect(new ManagedJobRecoveryStore(adapter).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" });
    expect(JSON.parse(adapter.files.get(path)!).revision).toBe(1);
    adapter.files.set(`${path}.journal`, "{");
    await expect(new ManagedJobRecoveryStore(adapter).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" });
  });

  it("validates delete journals, protects newer records, and removes the journal last", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter); const admitted = await create(store);
    const abandoned = await store.abandon("transcription", "op-1", admitted.revision);
    await store.delete("transcription", "op-1", abandoned.revision);
    const journalWrite = adapter.events.findIndex(x => x.includes("write:") && x.includes("delete-journal"));
    const tombstone = adapter.events.findIndex(x => x.includes("rename:") && x.includes(".deleting"));
    const journalRemove = adapter.events.findLastIndex(x => x.includes("remove:") && x.includes("delete-journal"));
    expect(journalWrite).toBeLessThan(tombstone); expect(journalRemove).toBeGreaterThan(tombstone);

    const guarded = new MemoryAdapter(); const guardedStore = new ManagedJobRecoveryStore(guarded); await create(guardedStore);
    const path = ".systemsculpt/managed-jobs/transcription/op-1.json";
    guarded.files.set(`${path}.delete-journal`, JSON.stringify({ schemaVersion: 1, capability: "transcription", operationId: "op-1", revision: 100, intent: "delete" }));
    await expect(new ManagedJobRecoveryStore(guarded).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" });
    expect(guarded.files.has(path)).toBe(true);
  });

  it("validates every standalone canonical record, quarantines corruption, and continues other recovery", async () => {
    const adapter = new MemoryAdapter(); const goodStore = new ManagedJobRecoveryStore(adapter); await create(goodStore);
    adapter.files.set(".systemsculpt/managed-jobs/document_processing/bad.json", JSON.stringify({ schemaVersion: 99 }));
    adapter.files.set(".systemsculpt/managed-jobs/transcription/bad-etag.json", JSON.stringify({ ...(await goodStore.read("transcription", "op-1")), operationId: "bad-etag", completedParts: [{ partNumber: 1, etag: "https://authorization.example" }] }));
    adapter.files.set(".systemsculpt/managed-jobs/image_generation/orphan.json.tmp", JSON.stringify({ junk: true }));
    await expect(new ManagedJobRecoveryStore(adapter).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" });
    expect(adapter.files.has(".systemsculpt/managed-jobs/image_generation/orphan.json.tmp")).toBe(false);
    expect((await goodStore.read("transcription", "op-1")).revision).toBe(1);
  });

  it("recovers deletion after every write/rename/remove boundary without resurrection", async () => {
    const baseline = new MemoryAdapter(); const baseStore = new ManagedJobRecoveryStore(baseline); const admitted = await create(baseStore); await baseStore.abandon("transcription", "op-1", admitted.revision);
    for (let failAt = 0; failAt < 10; failAt++) {
      const adapter = baseline.clone(); adapter.failAt = failAt; const store = new ManagedJobRecoveryStore(adapter);
      await store.delete("transcription", "op-1", 2).catch(() => undefined); adapter.failAt = -1;
      const recovered = new ManagedJobRecoveryStore(adapter); await recovered.initialize();
      const path = ".systemsculpt/managed-jobs/transcription/op-1.json";
      if (adapter.files.has(`${path}.delete-journal`)) throw new Error("delete journal survived recovery");
      if (adapter.files.has(path)) expect(JSON.parse(adapter.files.get(path)!).phase).toBe("abandoned");
    }
  });

  it("rejects impossible capability dispatches, missing part numbers, and bad idempotency", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter); let record = await create(store); record = await store.markContentReady("transcription", "op-1", record.revision);
    await expect(store.beginDispatch("transcription", "op-1", record.revision, { operation: "prepare", requestId: "r", dispatchedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(store.beginDispatch("transcription", "op-1", record.revision, { operation: "create", requestId: "r", idempotencyKey: "wrong", dispatchedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_record" });
    await expect(store.beginDispatch("transcription", "op-1", record.revision, { operation: "create", requestId: "https://credential.example", idempotencyKey: "op-1:create", dispatchedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_record" });
    const image = await create(store, { capability: "image_generation", operationId: "img-1", source: { identity: "vault:image.png", fingerprint: `sha256:${"b".repeat(64)}` } }); const ready = await store.markContentReady("image_generation", "img-1", image.revision);
    await expect(store.beginDispatch("image_generation", "img-1", ready.revision, { operation: "part", requestId: "r", dispatchedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(store.beginDispatch("image_generation", "img-1", ready.revision, { operation: "create", requestId: "r", idempotencyKey: "img-1:create", dispatchedAt: "2026-01-01T00:00:00Z" })).resolves.toMatchObject({ phase: "create_dispatching" });
  });

  it("enforces exhaustive phase/pendingDispatch/capability canonical coherence", async () => {
    const baseAdapter = new MemoryAdapter(); const baseStore = new ManagedJobRecoveryStore(baseAdapter); const valid = await create(baseStore);
    const badRecords = [
      { ...valid, phase: "create_dispatching", pendingDispatch: undefined },
      { ...valid, phase: "admitted", pendingDispatch: { operation: "create", requestId: "req-1", idempotencyKey: "op-1:create", dispatchedAt: "2026-01-01T00:00:00Z" } },
      { ...valid, phase: "part_dispatching", pendingDispatch: { operation: "create", requestId: "req-1", idempotencyKey: "op-1:create", partNumber: 1, dispatchedAt: "2026-01-01T00:00:00Z" } },
      { ...valid, phase: "part_dispatching", pendingDispatch: { operation: "part", requestId: "req-1", dispatchedAt: "2026-01-01T00:00:00Z" } },
      { ...valid, capability: "image_generation", phase: "complete_dispatching", pendingDispatch: { operation: "complete", requestId: "req-1", dispatchedAt: "2026-01-01T00:00:00Z" } },
      { ...valid, completedParts: [{ partNumber: 1, etag: "x-amz-signature=abc" }] },
      { ...valid, completedParts: [{ partNumber: 1, etag: "%68%74%74%70%3A%2F%2Fx" }] },
    ];
    for (const [index, record] of badRecords.entries()) {
      const adapter = new MemoryAdapter(); adapter.files.set(`.systemsculpt/managed-jobs/${record.capability}/bad-${index}.json`, JSON.stringify({ ...record, operationId: `bad-${index}` }));
      await expect(new ManagedJobRecoveryStore(adapter).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" });
    }
  });

  it("enforces unique capability-bounded completed part identities and legal acknowledgements", async () => {
    const etag = "a".repeat(32); const baseAdapter = new MemoryAdapter(); const baseStore = new ManagedJobRecoveryStore(baseAdapter); const valid = await create(baseStore);
    const cases = [
      ["transcription", [{ partNumber: 0, etag }]], ["transcription", [{ partNumber: 51, etag }]], ["transcription", [{ partNumber: 1, etag }, { partNumber: 1, etag: "b".repeat(32) }]],
      ["document_processing", [{ partNumber: 0, etag }]], ["document_processing", [{ partNumber: 4, etag }]], ["document_processing", [{ partNumber: 3, etag }, { partNumber: 3, etag: "b".repeat(32) }]],
      ["image_generation", [{ partNumber: 1, etag }]],
    ] as const;
    for (const [index, [capability, completedParts]] of cases.entries()) { const adapter = new MemoryAdapter(); adapter.files.set(`.systemsculpt/managed-jobs/${capability}/bad-part-${index}.json`, JSON.stringify({ ...valid, capability, operationId: `bad-part-${index}`, completedParts })); await expect(new ManagedJobRecoveryStore(adapter).initialize()).rejects.toMatchObject({ code: "recovery_corrupt" }); }
    for (const [capability, partNumber] of [["transcription", 1], ["transcription", 50], ["document_processing", 1], ["document_processing", 3]] as const) { const adapter = new MemoryAdapter(); adapter.files.set(`.systemsculpt/managed-jobs/${capability}/good-${partNumber}.json`, JSON.stringify({ ...valid, capability, operationId: `good-${partNumber}`, completedParts: [{ partNumber, etag }] })); await expect(new ManagedJobRecoveryStore(adapter).initialize()).resolves.toBeUndefined(); }

    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter); let record = await create(store); record = await store.markContentReady("transcription", "op-1", record.revision); record = await store.beginDispatch("transcription", "op-1", record.revision, { operation: "create", requestId: "r", idempotencyKey: "op-1:create", dispatchedAt: "2026-01-01T00:00:00Z" }); record = await store.acknowledgeCreated("transcription", "op-1", record.revision, "job");
    await expect(store.beginDispatch("transcription", "op-1", record.revision, { operation: "part", requestId: "r", partNumber: 51, dispatchedAt: "2026-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_record" });
    record = await store.beginDispatch("transcription", "op-1", record.revision, { operation: "part", requestId: "r", partNumber: 50, dispatchedAt: "2026-01-01T00:00:00Z" });
    await expect(store.acknowledgePart("transcription", "op-1", record.revision, { partNumber: 49, etag })).rejects.toMatchObject({ code: "illegal_transition" });
    await expect(store.acknowledgePart("transcription", "op-1", record.revision, { partNumber: 50, etag })).resolves.toMatchObject({ completedParts: [{ partNumber: 50, etag }] });
  });

  it.each([
    ["transcription", "complete_dispatching", "queued", "upload_completed"], ["transcription", "complete_dispatching", "processing", "processing"], ["transcription", "complete_dispatching", "failed", "result_ready"],
    ["document_processing", "start_dispatching", "queued", "blocked_ambiguous"], ["document_processing", "start_dispatching", "processing", "processing"], ["document_processing", "start_dispatching", "completed", "result_ready"],
    ["transcription", "abort_dispatching", "failed", "upload_aborted"], ["image_generation", "create_dispatching", "queued", "blocked_ambiguous"],
  ] as const)("atomically applies reconciliation %s %s %s → %s", async (capability, phase, status, expected) => {
    const adapter = new MemoryAdapter(); const operation = phase.replace("_dispatching", "") as any; const id = `reconcile-${capability}`; const pending: any = { operation, requestId: "req-1", dispatchedAt: "2026-01-01T00:00:00Z" }; if (capability !== "image_generation" && ["create", "complete", "start"].includes(operation)) pending.idempotencyKey = `${id}:${operation}`;
    const record = { schemaVersion: 1, revision: 1, capability, operationId: id, source: { identity: "vault:source", fingerprint: `sha256:${"a".repeat(64)}` }, jobId: "job", phase, pendingDispatch: pending, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    adapter.files.set(`.systemsculpt/managed-jobs/${capability}/${id}.json`, JSON.stringify(record)); const store = new ManagedJobRecoveryStore(adapter);
    const applied = await store.applyReconciliation(capability, id, 1, status); expect(applied.phase).toBe(expected); expect(applied.pendingDispatch).toBeUndefined();
    await expect(store.applyReconciliation(capability, id, 1, status)).rejects.toMatchObject({ code: "stale_revision" });
  });

  it("strictly rejects content, URLs, headers, credentials, invalid lengths and formats", async () => {
    const adapter = new MemoryAdapter(); const store = new ManagedJobRecoveryStore(adapter);
    await expect(create(store, { ...initial, source: { identity: "https://signed.example/x", fingerprint: "bad" } })).rejects.toMatchObject({ code: "invalid_record" });
    await expect(create(store, { ...initial, operationId: "x".repeat(129) })).rejects.toMatchObject({ code: "invalid_record" });
    expect(JSON.stringify([...adapter.files.values()])).not.toMatch(/signed|authorization|headers|content/i);
  });

  it("is capability-exhaustive for every dispatching phase/status Cartesian product", () => {
    const statuses = ["uploading", "queued", "processing", "succeeded", "completed", "failed", "expired", "unknown"] as const;
    const phases = ["prepare_dispatching", "create_dispatching", "part_dispatching", "complete_dispatching", "start_dispatching", "abort_dispatching"] as const;
    const capabilities: ManagedJobCapability[] = ["transcription", "document_processing", "image_generation"];
    for (const capability of capabilities) for (const phase of phases) for (const status of statuses) {
      const result = ManagedJobRecoveryStore.reconcile(capability, phase, status);
      expect(["blocked_ambiguous", "upload_completed", "processing", "result_ready", "upload_aborted"]).toContain(result);
      if (capability === "image_generation" && phase !== "create_dispatching" && phase !== "prepare_dispatching") expect(result).toBe("blocked_ambiguous");
      if (capability === "document_processing" && status === "expired") expect(result).toBe("blocked_ambiguous");
    }
  });
});
