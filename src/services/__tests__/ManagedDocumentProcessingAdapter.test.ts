import fixture from "../../../testing/fixtures/managed/managed-job-protocol-v1.json";
import { ManagedJobClient, MANAGED_JOB_DESCRIPTORS, MANAGED_JOB_OPERATION_STATUSES } from "../managed/ManagedJobClient";
import { ManagedJobRecoveryStore, type ManagedRecoveryAdapter } from "../managed/ManagedJobRecoveryStore";
import { ManagedDocumentProcessingAdapter } from "../managed/ManagedDocumentProcessingAdapter";
import { HostedTransportAdapter } from "../managed/adapters/HostedTransportAdapter";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

class MemoryRecoveryAdapter implements ManagedRecoveryAdapter {
  readonly storageDomain = "memory:documents";
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

const documentId = "document-1";
const etag = "0123456789abcdef0123456789abcdef";
const downloaded = {
  content: [],
  text: "managed document",
  markdown: "# Managed document",
  images: [],
  metadata: { title: "Managed" },
};
const createRequest = {
  filename: "report.pdf",
  contentType: "application/pdf",
  contentLengthBytes: 6,
} as const;

function managedHarness() {
  const events: string[] = [];
  const storage = new MemoryRecoveryAdapter();
  const recovery = new ManagedJobRecoveryStore(storage, () => "2026-07-12T12:00:00.000Z");
  const jobs = {
    create: jest.fn(async () => { events.push("create"); return { document: { id: documentId, status: "uploading" }, upload: { part_size_bytes: 4, total_parts: 2 } }; }),
    uploadPart: jest.fn(async (_id: string, part: number, bytes: ArrayBuffer) => { events.push(`part:${part}:${bytes.byteLength}`); return { partNumber: part, etag }; }),
    complete: jest.fn(async () => { events.push("complete"); return { document: { id: documentId, status: "queued" } }; }),
    start: jest.fn(async () => { events.push("start"); return { document: { id: documentId, status: "processing" } }; }),
    status: jest.fn(async () => { events.push("status:completed"); return { document: { id: documentId, status: "completed", error: null, progress: 1 } }; }),
    download: jest.fn(async () => { events.push("download"); return { result: downloaded }; }),
  };
  const admission = { acquireLease: jest.fn(async () => { events.push("admission"); return { outcome: "allowed" as const }; }) };
  const adapter = new ManagedDocumentProcessingAdapter({
    admission,
    jobs,
    recovery,
    createOperationId: () => "document-op-1",
    wait: async () => undefined,
  });
  return { adapter, admission, events, jobs, recovery, storage };
}

describe("managed document processing adapter contract", () => {
  it("matches the immutable Plan 019 document descriptor without an expired status", () => {
    const expected = fixture.descriptors.find((item) => item.capability === "document_processing")!;
    const actual = MANAGED_JOB_DESCRIPTORS.document_processing;
    expect(actual.statuses).toEqual([...expected.statuses.non_terminal, ...expected.statuses.terminal]);
    expect(actual.statuses).not.toContain("expired");
    expect(MANAGED_JOB_OPERATION_STATUSES.document_processing).toEqual(expected.status_discriminants);
    expect(Object.entries(actual.paths).map(([name, [method, path]]) => ({ name, method, path })))
      .toEqual(expected.operations.map(({ name, method, path }) => ({ name, method, path })));
  });

  it("resumes an existing document with status only and rejects server cancellation before transport", async () => {
    const request = jest.fn().mockResolvedValue(json({ document: { id: "document-1", status: "processing", error: null, progress: 0.5 } }));
    const transport = new HostedTransportAdapter({ baseUrl: "https://api.test", pluginVersion: "1.0.0", licenseKey: () => "license", requestClient: { request } as any });
    const client = new ManagedJobClient(transport);

    await expect(client.documents.resume("document-1")).resolves.toMatchObject({ document: { status: "processing" } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].url).toContain("/api/plugin/documents/document-1");
    await expect(client.documents.cancel()).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("admits and records recovery before reading bytes, then runs create, parts, complete, start, completed status, and download", async () => {
    const { adapter, events, jobs, recovery, storage } = managedHarness();
    const result = await adapter.process({
      identity: "vault:documents/report.pdf",
      fingerprint: () => { events.push("fingerprint"); return `sha256:${"a".repeat(64)}`; },
      load: async () => {
        events.push(storage.files.has(".systemsculpt/managed-jobs/document_processing/document-op-1.json") ? "read:recorded" : "read:unrecorded");
        return { filename: "report.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer };
      },
    });

    expect(result).toEqual({ operationId: "document-op-1", documentId, result: downloaded });
    expect(events).toEqual([
      "admission", "fingerprint", "read:recorded", "create", "part:1:4", "part:2:2", "complete", "start", "status:completed", "download",
    ]);
    expect(jobs.create).toHaveBeenCalledWith(
      { filename: "report.pdf", contentType: "application/pdf", contentLengthBytes: 6 },
      "document-op-1",
      expect.any(AbortSignal),
    );
    await expect(recovery.read("document_processing", result.operationId)).resolves.toMatchObject({
      phase: "result_ready",
      jobId: documentId,
      completedParts: [{ partNumber: 1, etag }, { partNumber: 2, etag }],
    });
    expect([...storage.files.values()].join("\n")).not.toMatch(/managed document|https:\/\//);
  });

  it("blocks before fingerprinting, recovery, or vault reads when admission is denied", async () => {
    const { adapter, admission, events, storage } = managedHarness();
    admission.acquireLease.mockResolvedValueOnce({ outcome: "license_required" } as any);
    const fingerprint = jest.fn(() => `sha256:${"b".repeat(64)}`);
    const load = jest.fn();

    await expect(adapter.process({ identity: "vault:documents/report.pdf", fingerprint, load }))
      .rejects.toThrow("license_required");
    expect(fingerprint).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(storage.files.size).toBe(0);
  });

  it("resumes only an acknowledged processing job with status then download and no dispatch", async () => {
    const { adapter, jobs, recovery } = managedHarness();
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId: "resume-op",
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"c".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", "resume-op", record.revision);
    record = await recovery.beginDispatch("document_processing", "resume-op", record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: "resume-op:create", dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
    });
    record = await recovery.acknowledgeCreated("document_processing", "resume-op", record.revision, documentId);
    record = await recovery.beginDispatch("document_processing", "resume-op", record.revision, {
      operation: "complete", requestId: "complete-1", idempotencyKey: "resume-op:complete", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("document_processing", "resume-op", record.revision);
    record = await recovery.beginDispatch("document_processing", "resume-op", record.revision, {
      operation: "start", requestId: "start-1", idempotencyKey: "resume-op:start", dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    await recovery.acknowledgeStarted("document_processing", "resume-op", record.revision);

    await expect(adapter.resume("resume-op")).resolves.toEqual({ operationId: "resume-op", documentId, result: downloaded });
    expect(jobs.status).toHaveBeenCalledTimes(1);
    expect(jobs.download).toHaveBeenCalledTimes(1);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it.each(["create", "part"] as const)("blocks ambiguous %s dispatch without status, download, or redispatch", async (operation) => {
    const { adapter, jobs, recovery } = managedHarness();
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId: `ambiguous-${operation}`,
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"d".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", record.operationId, record.revision);
    if (operation !== "create") {
      record = await recovery.beginDispatch("document_processing", record.operationId, record.revision, {
        operation: "create", requestId: "create-1", idempotencyKey: `${record.operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
      });
      record = await recovery.acknowledgeCreated("document_processing", record.operationId, record.revision, documentId);
    }
    await recovery.beginDispatch("document_processing", record.operationId, record.revision, {
      operation,
      requestId: `${operation}-ambiguous`,
      ...(operation === "create" ? { idempotencyKey: `${record.operationId}:${operation}` } : { partNumber: 1 }),
      ...(operation === "create" ? { createRequest } : {}),
      dispatchedAt: "2026-07-12T12:00:00.000Z",
    });

    await expect(adapter.resume(record.operationId)).rejects.toThrow(/ambiguous/i);
    expect(jobs.status).not.toHaveBeenCalled();
    expect(jobs.download).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it("replays an interrupted upload completion with the recorded parts and operation ID before starting", async () => {
    const { adapter, events, jobs, recovery } = managedHarness();
    const operationId = "resume-complete-op";
    const completedParts = [
      { partNumber: 1, etag },
      { partNumber: 2, etag },
    ];
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId,
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"e".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", operationId, record.revision);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: `${operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
    });
    record = await recovery.acknowledgeCreated("document_processing", operationId, record.revision, documentId);
    for (const part of completedParts) {
      record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
        operation: "part", requestId: `part-${part.partNumber}`, partNumber: part.partNumber, dispatchedAt: "2026-07-12T12:00:00.000Z",
      });
      record = await recovery.acknowledgePart("document_processing", operationId, record.revision, part);
    }
    await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "complete", requestId: "complete-ambiguous", idempotencyKey: `${operationId}:complete`, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });

    await expect(adapter.resume(operationId)).resolves.toEqual({ operationId, documentId, result: downloaded });
    expect(events).toEqual(["complete", "start", "status:completed", "download"]);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    expect(jobs.complete).toHaveBeenCalledWith(documentId, completedParts, operationId, expect.any(AbortSignal));
    expect(jobs.start).toHaveBeenCalledTimes(1);
    expect(jobs.start).toHaveBeenCalledWith(documentId, operationId, expect.any(AbortSignal));
    expect(jobs.status).toHaveBeenCalledTimes(1);
    expect(jobs.download).toHaveBeenCalledTimes(1);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
  });

  it("fails closed before transport when upload-completion recovery has no acknowledged parts", async () => {
    const { adapter, jobs, recovery } = managedHarness();
    const operationId = "resume-complete-without-parts";
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId,
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"e".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", operationId, record.revision);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: `${operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
    });
    record = await recovery.acknowledgeCreated("document_processing", operationId, record.revision, documentId);
    await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "complete", requestId: "complete-ambiguous", idempotencyKey: `${operationId}:complete`, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });

    await expect(adapter.resume(operationId)).rejects.toThrow(/without acknowledged parts/i);
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.start).not.toHaveBeenCalled();
    expect(jobs.status).not.toHaveBeenCalled();
    expect(jobs.download).not.toHaveBeenCalled();
  });

  it("starts from an acknowledged upload-completed recovery boundary without replaying completion", async () => {
    const { adapter, events, jobs, recovery } = managedHarness();
    const operationId = "resume-upload-completed-op";
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId,
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"f".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", operationId, record.revision);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: `${operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
    });
    record = await recovery.acknowledgeCreated("document_processing", operationId, record.revision, documentId);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "complete", requestId: "complete-1", idempotencyKey: `${operationId}:complete`, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    await recovery.acknowledgeComplete("document_processing", operationId, record.revision);

    await expect(adapter.resume(operationId)).resolves.toEqual({ operationId, documentId, result: downloaded });
    expect(events).toEqual(["start", "status:completed", "download"]);
    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.start).toHaveBeenCalledWith(documentId, operationId, expect.any(AbortSignal));
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
  });

  it("replays an interrupted start with the same operation ID before polling and downloading", async () => {
    const { adapter, events, jobs, recovery } = managedHarness();
    const operationId = "resume-start-op";
    let record = await recovery.createAdmitted({
      capability: "document_processing",
      operationId,
      source: { identity: "vault:documents/report.pdf", fingerprint: `sha256:${"e".repeat(64)}` },
    });
    record = await recovery.markContentReady("document_processing", operationId, record.revision);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "create", requestId: "create-1", idempotencyKey: `${operationId}:create`, dispatchedAt: "2026-07-12T12:00:00.000Z", createRequest,
    });
    record = await recovery.acknowledgeCreated("document_processing", operationId, record.revision, documentId);
    record = await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "complete", requestId: "complete-1", idempotencyKey: `${operationId}:complete`, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });
    record = await recovery.acknowledgeComplete("document_processing", operationId, record.revision);
    await recovery.beginDispatch("document_processing", operationId, record.revision, {
      operation: "start", requestId: "start-ambiguous", idempotencyKey: `${operationId}:start`, dispatchedAt: "2026-07-12T12:00:00.000Z",
    });

    await expect(adapter.resume(operationId)).resolves.toEqual({ operationId, documentId, result: downloaded });
    expect(events).toEqual(["start", "status:completed", "download"]);
    expect(jobs.start).toHaveBeenCalledTimes(1);
    expect(jobs.start).toHaveBeenCalledWith(documentId, operationId, expect.any(AbortSignal));
    expect(jobs.status).toHaveBeenCalledTimes(1);
    expect(jobs.download).toHaveBeenCalledTimes(1);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.uploadPart).not.toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
    const resumedRecord = await recovery.read("document_processing", operationId);
    expect(resumedRecord).toMatchObject({
      phase: "result_ready",
      jobId: documentId,
    });
    expect(resumedRecord.pendingDispatch).toBeUndefined();
  });

  it("fences a late download with the conversion signal", async () => {
    const { adapter, jobs } = managedHarness();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    jobs.download.mockImplementationOnce(async () => { entered(); await delayed; return { result: downloaded }; });
    const controller = new AbortController();
    const running = adapter.process({
      identity: "vault:documents/report.pdf",
      fingerprint: () => `sha256:${"f".repeat(64)}`,
      load: async () => ({ filename: "report.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4, 5, 6]).buffer }),
    }, { signal: controller.signal });
    await waiting;
    controller.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});
