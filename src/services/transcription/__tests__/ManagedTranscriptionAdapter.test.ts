import { ManagedJobRecoveryStore, type ManagedRecoveryAdapter } from "../../managed/ManagedJobRecoveryStore";
import { ManagedJobError } from "../../managed/ManagedJobClient";
import {
  ManagedTranscriptionAdapter,
  ManagedTranscriptionInterruptedError,
  ManagedTranscriptionRetryError,
} from "../ManagedTranscriptionAdapter";

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
const hexSeed = (char: string) => (/^[a-f0-9]$/i.test(char) ? char.toLowerCase() : (char.charCodeAt(0) % 16).toString(16));
const opaqueIdentity = (char: string) => `transcription:${hexSeed(char).repeat(64)}`;
const fingerprintFor = (char: string) => `sha256:${hexSeed(char).repeat(64)}`;
const audioBytes = (values: number[] = [1, 2, 3, 4, 5, 6]) => new Uint8Array(values).buffer;
const multipartUpload = (
  char: string,
  options: Partial<{
    contentType: string;
    bytes: number[];
    timestamped: boolean;
    language: string;
  }> = {},
) => {
  const contentType = options.contentType ?? "audio/webm";
  const bytes = options.bytes ?? [1, 2, 3, 4, 5, 6];
  return {
    createRequest: {
      filename: `${opaqueIdentity(char).slice("transcription:".length)}.webm`,
      contentType,
      contentLengthBytes: bytes.length,
      ...(options.timestamped === undefined ? {} : { timestamped: options.timestamped }),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    partSizeBytes: 4,
    totalParts: Math.ceil(bytes.length / 4),
  };
};
const source = (
  char: string,
  options: Partial<{
    filename: string;
    contentType: string;
    bytes: number[];
    release: () => void;
  }> = {},
) => ({
  identity: opaqueIdentity(char),
  fingerprint: () => fingerprintFor(char),
  load: async () => ({
    filename: options.filename ?? "demo.webm",
    contentType: options.contentType ?? "audio/webm",
    bytes: audioBytes(options.bytes),
  }),
  ...(options.release ? { release: options.release } : {}),
});

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
    abortUpload: jest.fn(async () => {
      events.push("abort");
      return { job: { id: jobId, status: "failed" } };
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
      identity: opaqueIdentity("a"),
      fingerprint: () => `sha256:${"a".repeat(64)}`,
      load: async () => {
        events.push(storage.files.has(".systemsculpt/managed-jobs/transcription/transcription-op-1.json") ? "read:recorded" : "read:unrecorded");
        return { filename: "demo.webm", contentType: "audio/webm", bytes: audioBytes() };
      },
      release: () => { events.push("release"); },
    });

    expect(result).toMatchObject({ kind: "transcript", text: "managed transcript" });
    if (result.kind !== "transcript") throw new Error("Expected transcript result.");
    expect(result.text).toBe("managed transcript");
    expect(events).toEqual([
      "admission", "read:recorded", "create", "part:1:4", "part:2:2", "complete", "release", "start", "status",
    ]);
    expect(jobs.create).toHaveBeenCalledWith(
      { filename: `${"a".repeat(64)}.webm`, contentType: "audio/webm", contentLengthBytes: 6 },
      "transcription-op-1",
      expect.any(AbortSignal),
    );
    await expect(recovery.read("transcription", result.operationId)).resolves.toMatchObject({
      phase: "result_ready",
      jobId,
      multipartUpload: multipartUpload("a"),
      source: {
        identity: opaqueIdentity("a"),
        fingerprint: fingerprintFor("a"),
      },
      completedParts: [{ partNumber: 1, etag }, { partNumber: 2, etag }],
    });
    const persisted = [...storage.files.values()].join("\n");
    expect(persisted).not.toContain("https://");
    expect(persisted).not.toContain("managed transcript");
    expect(persisted).not.toContain("Content");
    expect(persisted).not.toContain("Prompts");
    expect(persisted).not.toContain("demo.webm");
  });

  it("removes each polling abort listener after a normal timer resolution", async () => {
    jest.useFakeTimers();
    try {
      const { admission, jobs, recovery } = harness([
        { job: { id: jobId, status: "processing" }, transcript: null, progress: 0.5 },
        { job: { id: jobId, status: "succeeded" }, transcript: "managed transcript", progress: 1 },
      ]);
      const adapter = new ManagedTranscriptionAdapter({
        admission,
        jobs,
        recovery,
        createOperationId: () => "listener-cleanup-op",
        maxPolls: 2,
      });
      const controller = new AbortController();
      const add = jest.spyOn(controller.signal, "addEventListener");
      const remove = jest.spyOn(controller.signal, "removeEventListener");
      const running = adapter.transcribe({
        identity: opaqueIdentity("2"),
        fingerprint: () => `sha256:${"2".repeat(64)}`,
        load: async () => ({ filename: "listener.webm", contentType: "audio/webm", bytes: audioBytes() }),
      }, { signal: controller.signal });

      await jest.advanceTimersByTimeAsync(2_000);
      await expect(running).resolves.toMatchObject({ operationId: "listener-cleanup-op" });
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("blocks before audio reads or recovery creation when admission is denied", async () => {
    const { adapter, admission, events, storage } = harness();
    admission.acquireLease.mockResolvedValueOnce({ outcome: "license_required" } as any);
    const load = jest.fn();
    const fingerprint = jest.fn(() => `sha256:${"b".repeat(64)}`);

    await expect(adapter.transcribe({
      identity: opaqueIdentity("b"),
      fingerprint,
      load,
    })).rejects.toThrow("license_required");

    expect(load).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(storage.files.size).toBe(0);
  });

  it("rejects non-opaque source identities before any recovery write", async () => {
    const { adapter, storage } = harness();

    await expect(adapter.transcribe({
      identity: "vault:recordings/raw-path.webm",
      fingerprint: () => `sha256:${"9".repeat(64)}`,
      load: async () => ({ filename: "raw-path.webm", contentType: "audio/webm", bytes: audioBytes([1]) }),
    })).rejects.toThrow("opaque transcription hash");

    expect(storage.files.size).toBe(0);
  });

  it("resumes acknowledged processing by job ID and refetches a pending local result", async () => {
    const { adapter, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "resume-op",
      source: { identity: opaqueIdentity("c"), fingerprint: fingerprintFor("c") },
    });
    record = await recovery.markContentReady("transcription", "resume-op", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-op", record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: "resume-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("c").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "resume-op", record.revision, jobId, multipartUpload("c"));
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

    await expect(adapter.resume("resume-op", source("c"))).resolves.toMatchObject({ kind: "transcript", operationId: "resume-op", text: "managed transcript" });
  });

  it("reconnects an exact preserved source match after restart without creating a duplicate job", async () => {
    const events: string[] = [];
    const shared = new MemoryRecoveryAdapter();
    const seedRecovery = new ManagedJobRecoveryStore(shared, () => "2026-07-12T12:00:00.000Z");
    let record = await seedRecovery.createAdmitted({
      capability: "transcription",
      operationId: "preserved-processing-op",
      source: { identity: opaqueIdentity("c"), fingerprint: fingerprintFor("c") },
    });
    record = await seedRecovery.markContentReady("transcription", "preserved-processing-op", record.revision);
    record = await seedRecovery.beginDispatch("transcription", "preserved-processing-op", record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: "preserved-processing-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("c", { bytes: [1, 2, 3] }).createRequest,
    });
    record = await seedRecovery.acknowledgeCreated("transcription", "preserved-processing-op", record.revision, jobId, multipartUpload("c", { bytes: [1, 2, 3] }));
    record = await seedRecovery.beginDispatch("transcription", "preserved-processing-op", record.revision, {
      operation: "complete", requestId: "complete-1", idempotencyKey: "preserved-processing-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await seedRecovery.acknowledgeComplete("transcription", "preserved-processing-op", record.revision);
    record = await seedRecovery.beginDispatch("transcription", "preserved-processing-op", record.revision, {
      operation: "start", requestId: "start-1", idempotencyKey: "preserved-processing-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    await seedRecovery.acknowledgeStarted("transcription", "preserved-processing-op", record.revision);

    const jobs = {
      create: jest.fn(),
      uploadPart: jest.fn(),
      abortUpload: jest.fn(),
      complete: jest.fn(),
      start: jest.fn(),
      status: jest.fn(async () => {
        events.push("status");
        return { job: { id: jobId, status: "succeeded" }, transcript: "managed transcript", progress: 1 };
      }),
    };
    const adapter = new ManagedTranscriptionAdapter({
      admission: { acquireLease: jest.fn(async () => ({ outcome: "allowed" as const })) },
      jobs: jobs as any,
      recovery: new ManagedJobRecoveryStore(shared, () => "2026-07-12T12:00:00.000Z"),
      createOperationId: () => "fresh-op-that-must-not-dispatch",
      wait: async () => undefined,
    });

    const onOperationIdAdopted = jest.fn(async (operationId: string) => {
      events.push(`persist:${operationId}`);
    });
    await expect(adapter.transcribe({
      identity: opaqueIdentity("c"),
      fingerprint: () => `sha256:${"c".repeat(64)}`,
      load: async () => ({ filename: "resume.webm", contentType: "audio/webm", bytes: audioBytes([1, 2, 3]) }),
    }, { onOperationIdAdopted })).resolves.toMatchObject({ kind: "transcript", operationId: "preserved-processing-op", text: "managed transcript" });

    expect(onOperationIdAdopted).toHaveBeenCalledWith("preserved-processing-op");
    expect(events).toEqual(["persist:preserved-processing-op", "status"]);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("preserves an adopted exact-source operation when local ID persistence fails", async () => {
    const { adapter, admission, jobs, recovery } = harness();
    await recovery.createAdmitted({
      capability: "transcription",
      operationId: "preserved-before-persistence",
      source: {
        identity: opaqueIdentity("p"),
        fingerprint: fingerprintFor("p"),
      },
    });
    const persistenceError = new Error("settings storage unavailable");

    const failure = await adapter.transcribe(source("p"), {
      operationId: "fresh-operation",
      onOperationIdAdopted: async () => { throw persistenceError; },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ManagedTranscriptionRetryError);
    expect(failure).toMatchObject({
      operationId: "preserved-before-persistence",
      retryDisposition: "resume",
      recoveryPhase: "admitted",
      originalError: persistenceError,
    });
    expect(admission.acquireLease).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
    await expect(recovery.read(
      "transcription",
      "preserved-before-persistence",
    )).resolves.toMatchObject({ phase: "admitted" });
  });

  it("resumes a created upload from persisted multipart metadata without replaying create", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "resume-created-op",
      source: { identity: opaqueIdentity("r"), fingerprint: fingerprintFor("r") },
    });
    record = await recovery.markContentReady("transcription", "resume-created-op", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-created-op", record.revision, {
      operation: "create",
      requestId: "create-r",
      idempotencyKey: "resume-created-op:create",
      dispatchedAt: "2026-07-12T12:00:00.000Z",
      createRequest: multipartUpload("r", { timestamped: true, language: "fr" }).createRequest,
    });
    await recovery.acknowledgeCreated(
      "transcription",
      "resume-created-op",
      record.revision,
      jobId,
      multipartUpload("r", { timestamped: true, language: "fr" }),
    );
    jobs.create.mockClear();

    await expect(adapter.resume("resume-created-op", source("r", { filename: "renamed.webm" }))).resolves.toMatchObject({
      kind: "transcript",
      operationId: "resume-created-op",
      text: "managed transcript",
    });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).toHaveBeenNthCalledWith(1, jobId, 1, expect.any(ArrayBuffer), expect.any(AbortSignal));
    expect(jobs.uploadPart).toHaveBeenNthCalledWith(2, jobId, 2, expect.any(ArrayBuffer), expect.any(AbortSignal));
  });

  it("fails closed when an acknowledged created upload is missing persisted multipart metadata", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "legacy-created-op",
      source: { identity: opaqueIdentity("l"), fingerprint: fingerprintFor("l") },
    });
    record = await recovery.markContentReady("transcription", "legacy-created-op", record.revision);
    record = await recovery.beginDispatch("transcription", "legacy-created-op", record.revision, {
      operation: "create", requestId: "create-l", idempotencyKey: "legacy-created-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("l").createRequest,
    });
    await recovery.acknowledgeCreated("transcription", "legacy-created-op", record.revision, jobId);

    await expect(adapter.resume("legacy-created-op", source("l"))).rejects.toThrow(/persisted upload metadata is missing/i);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("fails closed when multiple preserved operations match the exact same source", async () => {
    const { adapter, jobs, recovery } = harness();
    for (const operationId of ["dup-op-1", "dup-op-2"] as const) {
      let record = await recovery.createAdmitted({
        capability: "transcription",
        operationId,
        source: { identity: opaqueIdentity("d"), fingerprint: fingerprintFor("a") },
      });
      record = await recovery.markContentReady("transcription", operationId, record.revision);
      record = await recovery.beginDispatch("transcription", operationId, record.revision, {
        operation: "create", requestId: `${operationId}-create`, idempotencyKey: `${operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("d").createRequest,
      });
      record = await recovery.acknowledgeCreated("transcription", operationId, record.revision, `${jobId}-${operationId}`, multipartUpload("d"));
      record = await recovery.beginDispatch("transcription", operationId, record.revision, {
        operation: "complete", requestId: `${operationId}-complete`, idempotencyKey: `${operationId}:complete`, dispatchedAt: "2026-07-12T12:00:00.000Z",
      });
      record = await recovery.acknowledgeComplete("transcription", operationId, record.revision);
      record = await recovery.beginDispatch("transcription", operationId, record.revision, {
        operation: "start", requestId: `${operationId}-start`, idempotencyKey: `${operationId}:start`, dispatchedAt: "2026-07-12T12:00:00.000Z",
      });
      await recovery.acknowledgeStarted("transcription", operationId, record.revision);
    }

    await expect(adapter.transcribe({
      identity: opaqueIdentity("d"),
      fingerprint: () => fingerprintFor("a"),
      load: async () => ({ filename: "dup.webm", contentType: "audio/webm", bytes: audioBytes([1]) }),
    })).rejects.toThrow(/multiple preserved transcription operations match this exact audio/i);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("deterministically replays a preserved create dispatch instead of guessing", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "ambiguous-op",
      source: { identity: opaqueIdentity("d"), fingerprint: fingerprintFor("d") },
    });
    record = await recovery.markContentReady("transcription", "ambiguous-op", record.revision);
    await recovery.beginDispatch("transcription", "ambiguous-op", record.revision, {
      operation: "create", requestId: "create-ambiguous", idempotencyKey: "ambiguous-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("d").createRequest,
    });

    await expect(adapter.resume("ambiguous-op", source("d"))).resolves.toMatchObject({
      kind: "transcript",
      operationId: "ambiguous-op",
      text: "managed transcript",
    });
    expect(jobs.create).toHaveBeenCalledTimes(1);
    expect(jobs.create).toHaveBeenCalledWith(
      multipartUpload("d").createRequest,
      "ambiguous-op",
      expect.any(AbortSignal),
    );
  });

  it("treats repeated begin-local-commit calls as idempotent and prunes completion", async () => {
    const { adapter, recovery, storage } = harness();
    const result = await adapter.transcribe({
      identity: opaqueIdentity("e"),
      fingerprint: () => `sha256:${"e".repeat(64)}`,
      load: async () => ({ filename: "idempotent.webm", contentType: "audio/webm", bytes: audioBytes() }),
    });
    await adapter.beginLocalCommit(result.operationId);
    await adapter.beginLocalCommit(result.operationId);
    await adapter.completeLocalCommit(result.operationId);
    await expect(recovery.read("transcription", result.operationId)).resolves.toMatchObject({ phase: "completed" });
    await adapter.acknowledgeCompleted(result.operationId);
    await expect(recovery.read("transcription", result.operationId)).rejects.toThrow();
    expect([...storage.files.keys()].filter((path) => path.includes(result.operationId))).toEqual([]);
  });

  it("returns a completed receipt on delayed exact-source retry until explicit acknowledgement", async () => {
    const { adapter, admission, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "completed-op",
      source: { identity: opaqueIdentity("k"), fingerprint: fingerprintFor("k") },
    });
    record = await recovery.markContentReady("transcription", "completed-op", record.revision);
    record = await recovery.beginDispatch("transcription", "completed-op", record.revision, {
      operation: "create", requestId: "create-k", idempotencyKey: "completed-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("k").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "completed-op", record.revision, jobId, multipartUpload("k"));
    record = await recovery.beginDispatch("transcription", "completed-op", record.revision, {
      operation: "complete", requestId: "complete-k", idempotencyKey: "completed-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "completed-op", record.revision);
    record = await recovery.beginDispatch("transcription", "completed-op", record.revision, {
      operation: "start", requestId: "start-k", idempotencyKey: "completed-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeStarted("transcription", "completed-op", record.revision);
    record = await recovery.applyReconciliation("transcription", "completed-op", record.revision, "succeeded");
    record = await recovery.markLocalCommitPending("transcription", "completed-op", record.revision);
    record = await recovery.recordLocalCommitReceipt("transcription", "completed-op", record.revision, {
      kind: "exact",
      outputPath: "Recovered/completed.md",
      contentSha256: "a".repeat(64),
    });
    await recovery.completeLocalCommit("transcription", "completed-op", record.revision);
    admission.acquireLease.mockClear();
    jobs.create.mockClear();
    jobs.status.mockClear();

    await expect(adapter.transcribe(source("k"))).resolves.toMatchObject({
      kind: "local_receipt",
      operationId: "completed-op",
      recoveryPhase: "completed",
      receipt: {
        kind: "exact",
        outputPath: "Recovered/completed.md",
      },
    });
    expect(admission.acquireLease).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.status).not.toHaveBeenCalled();
  });

  it("does not reuse a completed receipt when the exact fingerprint no longer matches", async () => {
    const { adapter, admission, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "completed-mismatch-op",
      source: { identity: opaqueIdentity("m"), fingerprint: fingerprintFor("m") },
    });
    record = await recovery.markContentReady("transcription", "completed-mismatch-op", record.revision);
    record = await recovery.beginDispatch("transcription", "completed-mismatch-op", record.revision, {
      operation: "create", requestId: "create-m", idempotencyKey: "completed-mismatch-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("m").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "completed-mismatch-op", record.revision, jobId, multipartUpload("m"));
    record = await recovery.beginDispatch("transcription", "completed-mismatch-op", record.revision, {
      operation: "complete", requestId: "complete-m", idempotencyKey: "completed-mismatch-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "completed-mismatch-op", record.revision);
    record = await recovery.beginDispatch("transcription", "completed-mismatch-op", record.revision, {
      operation: "start", requestId: "start-m", idempotencyKey: "completed-mismatch-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeStarted("transcription", "completed-mismatch-op", record.revision);
    record = await recovery.applyReconciliation("transcription", "completed-mismatch-op", record.revision, "succeeded");
    record = await recovery.markLocalCommitPending("transcription", "completed-mismatch-op", record.revision);
    record = await recovery.recordLocalCommitReceipt("transcription", "completed-mismatch-op", record.revision, {
      kind: "exact",
      outputPath: "Recovered/mismatch.md",
      contentSha256: "b".repeat(64),
    });
    await recovery.completeLocalCommit("transcription", "completed-mismatch-op", record.revision);

    await expect(adapter.transcribe({
      ...source("m"),
      fingerprint: () => fingerprintFor("a"),
    })).resolves.toMatchObject({
      kind: "transcript",
      operationId: "transcription-op-1",
      text: "managed transcript",
    });
    expect(admission.acquireLease).toHaveBeenCalledTimes(1);
    expect(jobs.create).toHaveBeenCalledTimes(1);
  });

  it("acknowledges completed records by deleting them and rejects non-completed records", async () => {
    const { adapter, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "ack-noncompleted-op",
      source: { identity: opaqueIdentity("n"), fingerprint: fingerprintFor("n") },
    });
    await expect(adapter.acknowledgeCompleted("ack-noncompleted-op")).rejects.toThrow(/only be acknowledged/i);
    await expect(recovery.read("transcription", "ack-noncompleted-op")).resolves.toMatchObject({ phase: "admitted" });

    record = await recovery.markContentReady("transcription", "ack-noncompleted-op", record.revision);
    record = await recovery.beginDispatch("transcription", "ack-noncompleted-op", record.revision, {
      operation: "create", requestId: "create-n", idempotencyKey: "ack-noncompleted-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("n").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "ack-noncompleted-op", record.revision, jobId, multipartUpload("n"));
    record = await recovery.beginDispatch("transcription", "ack-noncompleted-op", record.revision, {
      operation: "complete", requestId: "complete-n", idempotencyKey: "ack-noncompleted-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "ack-noncompleted-op", record.revision);
    record = await recovery.beginDispatch("transcription", "ack-noncompleted-op", record.revision, {
      operation: "start", requestId: "start-n", idempotencyKey: "ack-noncompleted-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeStarted("transcription", "ack-noncompleted-op", record.revision);
    record = await recovery.applyReconciliation("transcription", "ack-noncompleted-op", record.revision, "succeeded");
    record = await recovery.markLocalCommitPending("transcription", "ack-noncompleted-op", record.revision);
    record = await recovery.recordLocalCommitReceipt("transcription", "ack-noncompleted-op", record.revision, {
      kind: "exact",
      outputPath: "Recovered/ack.md",
      contentSha256: "c".repeat(64),
    });
    await recovery.completeLocalCommit("transcription", "ack-noncompleted-op", record.revision);

    await expect(adapter.acknowledgeCompleted("ack-noncompleted-op")).resolves.toBeUndefined();
    await expect(recovery.read("transcription", "ack-noncompleted-op")).rejects.toThrow();
    await expect(adapter.acknowledgeCompleted("ack-noncompleted-op")).resolves.toBeUndefined();
  });

  it("resumes an explicit operation after output-policy identity changes when audio bytes still match", async () => {
    const { adapter, jobs, recovery } = harness();
    await recovery.createAdmitted({
      capability: "transcription",
      operationId: "policy-change-op",
      source: { identity: opaqueIdentity("a"), fingerprint: fingerprintFor("a") },
    });

    await expect(adapter.resume("policy-change-op", {
      ...source("b"),
      fingerprint: () => fingerprintFor("a"),
    })).resolves.toMatchObject({
      kind: "transcript",
      operationId: "policy-change-op",
      text: "managed transcript",
    });

    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ filename: `${"a".repeat(64)}.webm` }),
      "policy-change-op",
      expect.any(AbortSignal),
    );
  });

  it("finalizes published Studio transcription cleanup idempotently", async () => {
    const { adapter, recovery } = harness();
    const result = await adapter.transcribe(source("8"), { operationId: "studio-published-op" });
    await adapter.beginLocalCommit(result.operationId);

    await expect(adapter.finalizePublishedLocalCommit(result.operationId)).resolves.toBeUndefined();
    await expect(recovery.read("transcription", result.operationId)).rejects.toThrow();
    await expect(adapter.finalizePublishedLocalCommit(result.operationId)).resolves.toBeUndefined();
  });

  it.each([
    ["transcription_failed", "failed"],
    ["job_expired", "expired"],
  ] as const)("classifies terminal %s status as safe to restart and prunes recovery", async (code, _status) => {
    const { adapter, jobs, recovery, storage } = harness();
    jobs.status.mockRejectedValueOnce(new ManagedJobError(code, `terminal ${code}`));

    const failure = await adapter.transcribe({
      identity: opaqueIdentity("f"),
      fingerprint: () => `sha256:${"f".repeat(64)}`,
      load: async () => ({ filename: "terminal.webm", contentType: "audio/webm", bytes: audioBytes() }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ManagedTranscriptionRetryError);
    expect(failure).toMatchObject({ retryDisposition: "restart" });
    await expect(recovery.read("transcription", "transcription-op-1")).rejects.toThrow();
    expect([...storage.files.keys()].some((path) => path.endsWith("transcription-op-1.json"))).toBe(false);
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
      identity: opaqueIdentity("1"),
      fingerprint: () => `sha256:${"1".repeat(64)}`,
      load: async () => ({ filename: "abort.webm", contentType: "audio/webm", bytes: audioBytes([1, 2, 3, 4]) }),
    }, { signal: controller.signal });
    await waiting;
    controller.abort();
    release();

    await expect(running).rejects.toMatchObject({
      name: "AbortError",
      operationId: "abort-before-create",
      retryDisposition: "resume",
      resumeAvailable: true,
    });
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
      identity: opaqueIdentity("2"),
      fingerprint: () => `sha256:${"2".repeat(64)}`,
      load: async () => ({ filename: "status-race.webm", contentType: "audio/webm", bytes: audioBytes() }),
    }, { signal: controller.signal, onProgress: progress });
    await waiting;
    const progressBeforeAbort = progress.mock.calls.length;
    controller.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toHaveBeenCalledTimes(progressBeforeAbort);
    expect(jobs.abortUpload).not.toHaveBeenCalled();
    await expect(recovery.read("transcription", "transcription-op-1")).resolves.toMatchObject({ phase: "processing" });
  });

  it("aborts and prunes an acknowledged unfinished upload instead of leaving duplicate work", async () => {
    const { adapter, jobs, recovery, storage } = harness();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    jobs.uploadPart.mockImplementationOnce(async (_id, part) => {
      entered();
      await delayed;
      return { partNumber: part, etag };
    });
    const controller = new AbortController();
    const running = adapter.transcribe({
      identity: opaqueIdentity("3"),
      fingerprint: () => `sha256:${"3".repeat(64)}`,
      load: async () => ({ filename: "unfinished.webm", contentType: "audio/webm", bytes: audioBytes() }),
    }, { signal: controller.signal });
    await waiting;
    controller.abort();
    release();

    const interruption = await running.catch((error: unknown) => error);
    expect(interruption).toBeInstanceOf(ManagedTranscriptionInterruptedError);
    expect(interruption).toMatchObject({
      name: "AbortError",
      operationId: "transcription-op-1",
      resumeAvailable: false,
    });
    expect(jobs.abortUpload).toHaveBeenCalledWith(jobId);
    await expect(recovery.read("transcription", "transcription-op-1")).rejects.toThrow();
    expect([...storage.files.keys()].filter((path) => path.includes("transcription-op-1"))).toEqual([]);
  });

  it("resumes upload-completed work by starting the same acknowledged job without re-uploading", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "resume-upload-complete",
      source: { identity: opaqueIdentity("4"), fingerprint: fingerprintFor("4") },
    });
    record = await recovery.markContentReady("transcription", "resume-upload-complete", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-upload-complete", record.revision, {
      operation: "create", requestId: "create-resume", idempotencyKey: "resume-upload-complete:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("4").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "resume-upload-complete", record.revision, jobId, multipartUpload("4"));
    record = await recovery.beginDispatch("transcription", "resume-upload-complete", record.revision, {
      operation: "complete", requestId: "complete-resume", idempotencyKey: "resume-upload-complete:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    await recovery.acknowledgeComplete("transcription", "resume-upload-complete", record.revision);
    jobs.create.mockClear();
    jobs.uploadPart.mockClear();
    jobs.complete.mockClear();
    jobs.start.mockClear();

    await expect(adapter.resume("resume-upload-complete", source("4"))).resolves.toMatchObject({ kind: "transcript", operationId: "resume-upload-complete", text: "managed transcript" });
    expect(jobs.start).toHaveBeenCalledWith(jobId, "resume-upload-complete", expect.any(AbortSignal));
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it("replays a preserved complete dispatch idempotently before starting transcription", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "resume-complete-dispatch",
      source: { identity: opaqueIdentity("9"), fingerprint: fingerprintFor("9") },
    });
    record = await recovery.markContentReady("transcription", "resume-complete-dispatch", record.revision);
    record = await recovery.beginDispatch("transcription", "resume-complete-dispatch", record.revision, {
      operation: "create", requestId: "create-resume", idempotencyKey: "resume-complete-dispatch:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("9").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "resume-complete-dispatch", record.revision, jobId, multipartUpload("9"));
    record = await recovery.beginDispatch("transcription", "resume-complete-dispatch", record.revision, {
      operation: "part", requestId: "part-1", partNumber: 1, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgePart("transcription", "resume-complete-dispatch", record.revision, { partNumber: 1, etag });
    record = await recovery.beginDispatch("transcription", "resume-complete-dispatch", record.revision, {
      operation: "part", requestId: "part-2", partNumber: 2, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgePart("transcription", "resume-complete-dispatch", record.revision, { partNumber: 2, etag });
    await recovery.beginDispatch("transcription", "resume-complete-dispatch", record.revision, {
      operation: "complete", requestId: "complete-resume", idempotencyKey: "resume-complete-dispatch:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    jobs.complete.mockClear();
    jobs.start.mockClear();

    await expect(adapter.resume("resume-complete-dispatch", source("9"))).resolves.toMatchObject({ kind: "transcript", operationId: "resume-complete-dispatch", text: "managed transcript" });
    expect(jobs.complete).toHaveBeenCalledWith(jobId, [{ partNumber: 1, etag }, { partNumber: 2, etag }], "resume-complete-dispatch", expect.any(AbortSignal));
    expect(jobs.start).toHaveBeenCalledWith(jobId, "resume-complete-dispatch", expect.any(AbortSignal));
  });

  it("replays a preserved create dispatch for exact preserved work", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "preserved-ambiguous",
      source: { identity: opaqueIdentity("5"), fingerprint: fingerprintFor("5") },
    });
    record = await recovery.markContentReady("transcription", "preserved-ambiguous", record.revision);
    record = await recovery.beginDispatch("transcription", "preserved-ambiguous", record.revision, {
      operation: "create", requestId: "ambiguous-create", idempotencyKey: "preserved-ambiguous:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("5").createRequest,
    });

    await expect(adapter.resume("preserved-ambiguous", source("5"))).resolves.toMatchObject({
      kind: "transcript",
      operationId: "preserved-ambiguous",
      text: "managed transcript",
    });
    expect(jobs.create).toHaveBeenCalledTimes(1);
    expect(jobs.uploadPart).toHaveBeenCalled();
  });

  it("exposes a typed interruption contract for recorder retry decisions", () => {
    const error = new ManagedTranscriptionInterruptedError("typed-op", true, "processing");
    expect(error).toMatchObject({
      name: "AbortError",
      operationId: "typed-op",
      resumeAvailable: true,
      recoveryPhase: "processing",
    });
  });

  it("preserves acknowledged processing after a transient status failure for same-operation resume", async () => {
    const { adapter, jobs, recovery } = harness();
    jobs.status.mockRejectedValueOnce(new Error("network unavailable"));

    const failure = await adapter.transcribe({
      identity: opaqueIdentity("6"),
      fingerprint: () => `sha256:${"6".repeat(64)}`,
      load: async () => ({ filename: "network.webm", contentType: "audio/webm", bytes: audioBytes() }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ManagedTranscriptionRetryError);
    expect(failure).toMatchObject({
      operationId: "transcription-op-1",
      retryDisposition: "resume",
      recoveryPhase: "processing",
    });
    await expect(recovery.read("transcription", "transcription-op-1")).resolves.toMatchObject({ phase: "processing", jobId });
  });

  it("preserves acknowledged processing when the polling limit expires", async () => {
    const { admission, jobs, recovery } = harness([
      { job: { id: jobId, status: "processing" }, transcript: null, progress: 0.5 },
    ]);
    const adapter = new ManagedTranscriptionAdapter({
      admission,
      jobs,
      recovery,
      createOperationId: () => "poll-timeout-op",
      wait: async () => undefined,
      maxPolls: 1,
    });

    const failure = await adapter.transcribe({
      identity: opaqueIdentity("7"),
      fingerprint: () => `sha256:${"7".repeat(64)}`,
      load: async () => ({ filename: "timeout.webm", contentType: "audio/webm", bytes: audioBytes() }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ManagedTranscriptionRetryError);
    expect(failure).toMatchObject({
      operationId: "poll-timeout-op",
      retryDisposition: "resume",
      recoveryPhase: "processing",
    });
  });

  it("replays a preserved start dispatch idempotently instead of guessing from queued status", async () => {
    const { adapter, jobs, recovery } = harness([
      { job: { id: jobId, status: "queued" }, transcript: null, progress: 0.1 },
      { job: { id: jobId, status: "succeeded" }, transcript: "managed transcript", progress: 1 },
    ]);
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "queued-start-op",
      source: { identity: opaqueIdentity("8"), fingerprint: fingerprintFor("8") },
    });
    record = await recovery.markContentReady("transcription", "queued-start-op", record.revision);
    record = await recovery.beginDispatch("transcription", "queued-start-op", record.revision, {
      operation: "create", requestId: "queued-create", idempotencyKey: "queued-start-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("8").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "queued-start-op", record.revision, jobId, multipartUpload("8"));
    record = await recovery.beginDispatch("transcription", "queued-start-op", record.revision, {
      operation: "complete", requestId: "queued-complete", idempotencyKey: "queued-start-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "queued-start-op", record.revision);
    await recovery.beginDispatch("transcription", "queued-start-op", record.revision, {
      operation: "start", requestId: "queued-start", idempotencyKey: "queued-start-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    jobs.start.mockClear();

    await expect(adapter.resume("queued-start-op", source("8"))).resolves.toMatchObject({ kind: "transcript", operationId: "queued-start-op", text: "managed transcript" });
    expect(jobs.start).toHaveBeenCalledWith(jobId, "queued-start-op", expect.any(AbortSignal));
    await expect(recovery.read("transcription", "queued-start-op")).resolves.toMatchObject({ phase: "result_ready" });
  });

  it("retires unrecoverable local-commit-pending state after terminal status expiry", async () => {
    const { adapter, jobs, recovery } = harness();
    let record = await recovery.createAdmitted({
      capability: "transcription",
      operationId: "pending-local-commit-op",
      source: { identity: opaqueIdentity("e"), fingerprint: fingerprintFor("e") },
    });
    record = await recovery.markContentReady("transcription", "pending-local-commit-op", record.revision);
    record = await recovery.beginDispatch("transcription", "pending-local-commit-op", record.revision, {
      operation: "create", requestId: "create-local", idempotencyKey: "pending-local-commit-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest: multipartUpload("e").createRequest,
    });
    record = await recovery.acknowledgeCreated("transcription", "pending-local-commit-op", record.revision, jobId, multipartUpload("e"));
    record = await recovery.beginDispatch("transcription", "pending-local-commit-op", record.revision, {
      operation: "complete", requestId: "complete-local", idempotencyKey: "pending-local-commit-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("transcription", "pending-local-commit-op", record.revision);
    record = await recovery.beginDispatch("transcription", "pending-local-commit-op", record.revision, {
      operation: "start", requestId: "start-local", idempotencyKey: "pending-local-commit-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeStarted("transcription", "pending-local-commit-op", record.revision);
    record = await recovery.applyReconciliation("transcription", "pending-local-commit-op", record.revision, "succeeded");
    await recovery.markLocalCommitPending("transcription", "pending-local-commit-op", record.revision);
    jobs.status.mockRejectedValueOnce(new ManagedJobError("job_expired", "expired after local commit started"));

    const failure = await adapter.resume("pending-local-commit-op", source("e")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ManagedTranscriptionRetryError);
    expect(failure).toMatchObject({
      operationId: "pending-local-commit-op",
      retryDisposition: "restart",
      recoveryPhase: "local_commit_pending",
    });
    await expect(recovery.read("transcription", "pending-local-commit-op")).rejects.toThrow();
  });
});
