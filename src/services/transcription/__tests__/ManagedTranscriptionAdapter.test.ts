import { ManagedJobRecoveryStore, type ManagedRecoveryAdapter } from "../../managed/ManagedJobRecoveryStore";
import { ManagedJobError } from "../../managed/ManagedJobClient";
import { ManagedTranscriptionAdapter } from "../ManagedTranscriptionAdapter";

class MemoryRecoveryAdapter implements ManagedRecoveryAdapter {
  readonly storageDomain = "memory:transcription";
  readonly capabilities = { read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true };
  readonly files = new Map<string, string>();

  async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, contents: string) { this.files.set(path, contents); }
  async exists(path: string) { return this.files.has(path); }
  async list(path: string) { return [...this.files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)); }
  async mkdir(_path: string) {}
  async rename(from: string, to: string) { const value = await this.read(from); this.files.set(to, value); this.files.delete(from); }
  async remove(path: string) { this.files.delete(path); }
}

const jobId = "transcription-job-1";
const etag = "0123456789abcdef0123456789abcdef";

function harness(statuses: Array<{ job: { id: string; status: string }; transcript: string | null; progress: number }> = [
  { job: { id: jobId, status: "succeeded" }, transcript: "managed transcript", progress: 1 },
]) {
  const events: string[] = [];
  const storage = new MemoryRecoveryAdapter();
  const recovery = new ManagedJobRecoveryStore(storage, () => "2026-07-12T12:00:00.000Z");
  const statusQueue = [...statuses];
  const jobs = {
    create: jest.fn(async () => {
      events.push("create");
      return { job: { id: jobId, status: "uploading" }, upload: { part_size_bytes: 4, total_parts: 2 } };
    }),
    uploadPart: jest.fn(async (_id: string, part: number, bytes: ArrayBuffer) => {
      events.push(`part:${part}:${bytes.byteLength}`);
      return { partNumber: part, etag };
    }),
    complete: jest.fn(async () => { events.push("complete"); return { job: { id: jobId, status: "queued" } }; }),
    start: jest.fn(async () => { events.push("start"); return { job: { id: jobId, status: "processing" } }; }),
    status: jest.fn(async () => {
      events.push("status");
      return statusQueue.shift() ?? statuses[statuses.length - 1];
    }),
  };
  const admission = {
    acquireLease: jest.fn(async () => {
      events.push("admission");
      return { outcome: "allowed" as const };
    }),
  };
  const adapter = new ManagedTranscriptionAdapter({
    admission,
    jobs,
    recovery,
    createOperationId: () => "transcription-op-1",
    wait: async () => undefined,
  });
  return { adapter, admission, events, jobs, recovery, storage };
}

describe("ManagedTranscriptionAdapter", () => {
  it("admits and records recovery before reading audio, then executes the exact managed lifecycle", async () => {
    const { adapter, events, jobs, recovery, storage } = harness();
    const result = await adapter.transcribe({
      identity: "vault:recordings/demo.webm",
      fingerprint: () => `sha256:${"a".repeat(64)}`,
      load: async () => {
        events.push(storage.files.has(".systemsculpt/managed-jobs/transcription/transcription-op-1.json") ? "read:recorded" : "read:unrecorded");
        return { filename: "demo.webm", contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer };
      },
    });

    expect(result.text).toBe("managed transcript");
    expect(events).toEqual([
      "admission", "read:recorded", "create", "part:1:4", "part:2:2", "complete", "start", "status",
    ]);
    expect(jobs.create).toHaveBeenCalledWith(
      { filename: "demo.webm", contentType: "audio/webm", contentLengthBytes: 6 },
      "transcription-op-1",
      expect.any(AbortSignal),
    );
    await expect(recovery.read("transcription", result.operationId)).resolves.toMatchObject({
      phase: "result_ready",
      jobId,
      completedParts: [{ partNumber: 1, etag }, { partNumber: 2, etag }],
    });
    const persisted = [...storage.files.values()].join("\n");
    expect(persisted).not.toContain("https://");
    expect(persisted).not.toContain("managed transcript");
  });

  it("blocks before audio reads or recovery creation when admission is denied", async () => {
    const { adapter, admission, events, storage } = harness();
    admission.acquireLease.mockResolvedValueOnce({ outcome: "license_required" } as any);
    const load = jest.fn();
    const fingerprint = jest.fn(() => `sha256:${"b".repeat(64)}`);

    await expect(adapter.transcribe({
      identity: "vault:recordings/demo.webm",
      fingerprint,
      load,
    })).rejects.toThrow("license_required");

    expect(load).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(storage.files.size).toBe(0);
  });

  it("resumes acknowledged processing by job ID and refetches a pending local result", async () => {
    const { adapter, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "resume-op",
      source: { identity: "vault:recordings/resume.webm", fingerprint: `sha256:${"c".repeat(64)}` },
    });
    record = await recovery.markContentReady("transcription", "resume-op", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-op", record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: "resume-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeCreated("transcription", "resume-op", record.revision, jobId);
    record = await recovery.beginDispatch("transcription", "resume-op", record.revision, {
      operation: "complete", requestId: "complete-1", idempotencyKey: "resume-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "resume-op", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-op", record.revision, {
      operation: "start", requestId: "start-1", idempotencyKey: "resume-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeStarted("transcription", "resume-op", record.revision);
    record = await recovery.applyReconciliation("transcription", "resume-op", record.revision, "succeeded");
    await recovery.markLocalCommitPending("transcription", "resume-op", record.revision);

    await expect(adapter.resume("resume-op")).resolves.toEqual({ operationId: "resume-op", text: "managed transcript" });
  });

  it("never guesses or redispatches an ambiguous create", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "ambiguous-op",
      source: { identity: "vault:recordings/ambiguous.webm", fingerprint: `sha256:${"d".repeat(64)}` },
    });
    record = await recovery.markContentReady("transcription", "ambiguous-op", record.revision);
    await recovery.beginDispatch("transcription", "ambiguous-op", record.revision, {
      operation: "create", requestId: "create-ambiguous", idempotencyKey: "ambiguous-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });

    await expect(adapter.resume("ambiguous-op")).rejects.toThrow(/ambiguous/i);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.status).not.toHaveBeenCalled();
  });

  it("treats repeated local-commit calls as idempotent", async () => {
    const { adapter, recovery } = harness();
    const result = await adapter.transcribe({
      identity: "vault:recordings/idempotent.webm",
      fingerprint: () => `sha256:${"e".repeat(64)}`,
      load: async () => ({ filename: "idempotent.webm", contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer }),
    });
    await adapter.beginLocalCommit(result.operationId);
    await adapter.beginLocalCommit(result.operationId);
    await adapter.completeLocalCommit(result.operationId);
    await adapter.completeLocalCommit(result.operationId);
    await expect(recovery.read("transcription", result.operationId)).resolves.toMatchObject({ phase: "completed" });
  });

  it.each([
    ["transcription_failed", "failed"],
    ["job_expired", "expired"],
  ] as const)("records terminal %s status without deleting recovery", async (code, _status) => {
    const { adapter, jobs, recovery, storage } = harness();
    jobs.status.mockRejectedValueOnce(new ManagedJobError(code, `terminal ${code}`));

    await expect(adapter.transcribe({
      identity: "vault:recordings/terminal.webm",
      fingerprint: () => `sha256:${"f".repeat(64)}`,
      load: async () => ({ filename: "terminal.webm", contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer }),
    })).rejects.toMatchObject({ code });

    await expect(recovery.read("transcription", "transcription-op-1")).resolves.toMatchObject({ phase: "result_ready", jobId });
    expect([...storage.files.keys()].some((path) => path.endsWith("transcription-op-1.json"))).toBe(true);
  });

  it("does not dispatch create when abort wins a delayed recovery transition", async () => {
    const { admission, jobs, recovery } = harness();
    const originalBeginDispatch = recovery.beginDispatch.bind(recovery);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const recoveryPort = new Proxy(recovery, {
      get(target, property) {
        if (property === "beginDispatch") {
          return async (...args: Parameters<typeof recovery.beginDispatch>) => {
            const record = await originalBeginDispatch(...args);
            entered();
            await delayed;
            return record;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const adapter = new ManagedTranscriptionAdapter({
      admission,
      jobs,
      recovery: recoveryPort,
      createOperationId: () => "abort-before-create",
      wait: async () => undefined,
    });
    const controller = new AbortController();
    const running = adapter.transcribe({
      identity: "vault:recordings/abort.webm",
      fingerprint: () => `sha256:${"1".repeat(64)}`,
      load: async () => ({ filename: "abort.webm", contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3, 4]).buffer }),
    }, { signal: controller.signal });
    await waiting;
    controller.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(jobs.create).not.toHaveBeenCalled();
    await expect(recovery.read("transcription", "abort-before-create")).resolves.toMatchObject({ phase: "create_dispatching" });
  });

  it("does not reconcile or publish progress when abort wins a delayed status response", async () => {
    const { adapter, jobs, recovery } = harness();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    jobs.status.mockImplementationOnce(async () => {
      entered();
      await delayed;
      return { job: { id: jobId, status: "succeeded" }, transcript: "late transcript", progress: 1 };
    });
    const progress = jest.fn();
    const controller = new AbortController();
    const running = adapter.transcribe({
      identity: "vault:recordings/status-race.webm",
      fingerprint: () => `sha256:${"2".repeat(64)}`,
      load: async () => ({ filename: "status-race.webm", contentType: "audio/webm", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer }),
    }, { signal: controller.signal, onProgress: progress });
    await waiting;
    const progressBeforeAbort = progress.mock.calls.length;
    controller.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toHaveBeenCalledTimes(progressBeforeAbort);
    await expect(recovery.read("transcription", "transcription-op-1")).resolves.toMatchObject({ phase: "processing" });
  });
});
