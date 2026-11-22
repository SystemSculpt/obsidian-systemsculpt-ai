import { ManagedJobError } from "../ManagedJobClient";
import { completeManagedRecoveryUpload, uploadManagedParts } from "../ManagedMultipartUpload";
import { ManagedJobRecoveryStore, type ManagedRecoveryAdapter } from "../ManagedJobRecoveryStore";
import { ManagedJobDispatch } from "../ManagedJobDispatch";
import type { ManagedJobRecoveryRecord } from "../ManagedTypes";

function harness() {
  const events: string[] = [];
  const source = {
    sizeBytes: 6,
    readSlice: jest.fn(async (start: number, end: number) => {
      events.push(`read:${start}:${end}`);
      return Uint8Array.from({ length: end - start }, (_, i) => start + i).buffer;
    }),
  };
  const controller = new AbortController();
  const sendPart = jest.fn(async (partNumber: number, _bytes: ArrayBuffer) => {
    events.push(`send:${partNumber}`);
    return { partNumber, etag: `etag-${partNumber}` };
  });
  const checkpoint = {
    begin: jest.fn(async (partNumber: number) => { events.push(`begin:${partNumber}`); }),
    acknowledge: jest.fn(async ({ partNumber }: { partNumber: number }) => { events.push(`ack:${partNumber}`); }),
  };
  return {
    events, controller,
    options: { source, plan: { partSizeBytes: 4, totalParts: 2 }, sendPart, checkpoint, signal: controller.signal, wait: jest.fn(async () => undefined) },
  };
}

describe("shared managed multipart uploads", () => {
  it("uploads bounded slices and durably acknowledges each before reading the next", async () => {
    const h = harness();
    await expect(uploadManagedParts(h.options)).resolves.toEqual([{ partNumber: 1, etag: "etag-1" }, { partNumber: 2, etag: "etag-2" }]);
    expect(h.events).toEqual(["read:0:4", "begin:1", "send:1", "ack:1", "read:4:6", "begin:2", "send:2", "ack:2"]);
  });

  it("does not reread or resend recovered parts", async () => {
    const h = harness();
    await uploadManagedParts({ ...h.options, completedParts: [{ partNumber: 1, etag: "saved" }] });
    expect(h.events).toEqual(["read:4:6", "begin:2", "send:2", "ack:2"]);
  });

  it("retries the same verified bytes without rereading or replacing the pending dispatch", async () => {
    const h = harness();
    h.options.sendPart.mockRejectedValueOnce(new ManagedJobError("temporarily_unavailable", "Retry", 503, null, true, null, 7_000));
    await uploadManagedParts(h.options);
    expect(h.options.source.readSlice).toHaveBeenCalledTimes(2);
    expect(h.options.checkpoint.begin).toHaveBeenCalledTimes(2);
    expect(h.options.sendPart.mock.calls[0]).toEqual(h.options.sendPart.mock.calls[1]);
    expect(h.options.wait).toHaveBeenCalledWith(7_000, h.controller.signal);
  });

  it.each(["read", "begin", "acknowledge"] as const)("stops before further transport when cancelled during %s", async (boundary) => {
    const h = harness();
    if (boundary === "read") h.options.source.readSlice.mockImplementationOnce(async () => { h.controller.abort(); return new ArrayBuffer(4); });
    else if (boundary === "begin") h.options.checkpoint.begin.mockImplementationOnce(async () => { h.controller.abort(); });
    else h.options.checkpoint.acknowledge.mockImplementationOnce(async () => { h.controller.abort(); });
    await expect(uploadManagedParts(h.options)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.options.sendPart).toHaveBeenCalledTimes(boundary === "acknowledge" ? 1 : 0);
  });

  it("never dispatches truncated source bytes or an invalid recovered part", async () => {
    const h = harness();
    await expect(uploadManagedParts({ ...h.options, completedParts: [{ partNumber: 3, etag: "invalid" }] })).rejects.toThrow("checkpoint");
    expect(h.options.source.readSlice).not.toHaveBeenCalled();
    h.options.source.readSlice.mockResolvedValueOnce(new ArrayBuffer(3));
    await expect(uploadManagedParts(h.options)).rejects.toThrow("changed");
    expect(h.options.sendPart).not.toHaveBeenCalled();
  });

  it("does not advance after an invalid acknowledgement or failed durable checkpoint", async () => {
    const h = harness();
    h.options.sendPart.mockResolvedValueOnce({ partNumber: 2, etag: "wrong-part" });
    await expect(uploadManagedParts(h.options)).rejects.toThrow("different");
    expect(h.options.checkpoint.acknowledge).not.toHaveBeenCalled();
    h.options.checkpoint.acknowledge.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(uploadManagedParts(h.options)).rejects.toThrow("disk unavailable");
    expect(h.options.source.readSlice).toHaveBeenCalledTimes(2);
  });

  it("replays the retained pending part and checkpoints its current revision", async () => {
    const h = harness();
    const record: ManagedJobRecoveryRecord = {
      schemaVersion: 1, revision: 4, capability: "transcription", operationId: "op-1", jobId: "job-1",
      phase: "part_dispatching", source: { identity: "source", fingerprint: "hash" },
      pendingDispatch: { operation: "part", requestId: "retained", partNumber: 2, dispatchedAt: "now" },
      multipartUpload: { ...h.options.plan, createRequest: { filename: "audio.wav", contentType: "audio/wav", contentLengthBytes: 6 } },
      completedParts: [{ partNumber: 1, etag: "saved" }], createdAt: "now", updatedAt: "now",
    };
    const acknowledged = { ...record, revision: 5, phase: "uploading" as const, pendingDispatch: undefined, completedParts: [...record.completedParts!, { partNumber: 2, etag: "etag-2" }] };
    const recovery = {
      beginDispatch: jest.fn(async () => ({ ...acknowledged, revision: 6, phase: "complete_dispatching" as const })),
      acknowledgePart: jest.fn(async () => acknowledged),
      acknowledgeCreated: jest.fn(),
      acknowledgeComplete: jest.fn(async () => ({ ...acknowledged, revision: 7, phase: "upload_completed" as const })),
    };
    const jobs = { create: jest.fn(), uploadPart: async (_jobId: string, partNumber: number, bytes: ArrayBuffer) => h.options.sendPart(partNumber, bytes), complete: jest.fn(async () => ({})) };
    await expect(completeManagedRecoveryUpload({
      record, loadSource: async () => h.options.source, createRequest: jest.fn(), jobs, dispatch: new ManagedJobDispatch(recovery), recovery,
      signal: h.controller.signal, wait: h.options.wait, sourceChangedMessage: "changed",
    })).resolves.toMatchObject({ revision: 7, phase: "upload_completed" });
    // The pending part keeps its recorded dispatch; only completion begins a new one.
    expect(recovery.beginDispatch).toHaveBeenCalledTimes(1);
    expect(recovery.beginDispatch).toHaveBeenCalledWith("transcription", "op-1", 5, expect.objectContaining({ operation: "complete" }));
    expect(recovery.acknowledgePart).toHaveBeenCalledWith("transcription", "op-1", 4, { partNumber: 2, etag: "etag-2" });
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.complete).toHaveBeenCalledWith("job-1", [{ partNumber: 1, etag: "saved" }, { partNumber: 2, etag: "etag-2" }], "op-1", h.controller.signal);
    expect(h.options.source.readSlice).toHaveBeenCalledWith(4, 6);
  });
});

class MemoryRecoveryAdapter implements ManagedRecoveryAdapter {
  capabilities = { read: true, write: true, list: true, mkdir: true, atomicRename: true, remove: true };
  storageDomain = "memory:upload-seam";
  constructor(readonly files = new Map<string, string>()) {}
  async read(path: string) { if (!this.files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return this.files.get(path)!; }
  async write(path: string, contents: string) { this.files.set(path, contents); }
  async exists(path: string) { return this.files.has(path); }
  async list(path: string) { return [...this.files.keys()].filter((key) => key.startsWith(path)); }
  async mkdir() { return undefined; }
  async rename(from: string, to: string) { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
  async remove(path: string) { this.files.delete(path); }
}

describe("ledger-backed upload recovery", () => {
  const etag = (partNumber: number) => `"${String(partNumber).repeat(8)}"`;
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);

  /** A plugin session: its own store over the shared vault files, as after a restart. */
  function session(files: Map<string, string>) {
    const store = new ManagedJobRecoveryStore(new MemoryRecoveryAdapter(files));
    const controller = new AbortController();
    const calls: string[] = [];
    const progress: unknown[] = [];
    const source = {
      sizeBytes: bytes.byteLength,
      readSlice: jest.fn(async (start: number, end: number) => bytes.slice(start, end).buffer),
    };
    const jobs = {
      create: jest.fn(async (request: { contentLengthBytes: number }, operationId: string) => {
        calls.push(`create:${operationId}:${request.contentLengthBytes}`);
        return { job: { id: "job-1", status: "uploading" }, upload: { part_size_bytes: 4, total_parts: 2 } };
      }),
      uploadPart: jest.fn(async (jobId: string, partNumber: number, _bytes: ArrayBuffer) => {
        calls.push(`part:${jobId}:${partNumber}`);
        return { partNumber, etag: etag(partNumber) };
      }),
      complete: jest.fn(async (jobId: string, parts: Array<{ partNumber: number }>) => {
        calls.push(`complete:${jobId}:${parts.map((part) => part.partNumber).join(",")}`);
        return {};
      }),
    };
    const loadSource = jest.fn(async () => source);
    const run = (record: ManagedJobRecoveryRecord) => completeManagedRecoveryUpload({
      record,
      loadSource,
      createRequest: () => ({ filename: `${"a".repeat(64)}.webm`, contentType: "audio/webm", contentLengthBytes: bytes.byteLength }),
      jobs,
      dispatch: new ManagedJobDispatch(store),
      recovery: store,
      signal: controller.signal,
      wait: async () => undefined,
      onProgress: (event) => progress.push(event),
      sourceChangedMessage: "The selected audio changed while it was being read.",
    });
    return { store, controller, calls, progress, source, jobs, loadSource, run };
  }

  async function admitted(files: Map<string, string>): Promise<ManagedJobRecoveryRecord> {
    const store = new ManagedJobRecoveryStore(new MemoryRecoveryAdapter(files));
    const record = await store.createAdmitted({
      capability: "transcription",
      operationId: "op-upload",
      source: { identity: "vault:a.webm", fingerprint: `sha256:${"a".repeat(64)}` },
    });
    return await store.markContentReady("transcription", record.operationId, record.revision);
  }

  it("resumes an upload cancelled mid-way without recreating the job or resending acknowledged parts", async () => {
    const files = new Map<string, string>();
    const first = session(files);
    first.jobs.uploadPart.mockImplementationOnce(async (jobId: string, partNumber: number) => {
      first.calls.push(`part:${jobId}:${partNumber}`);
      first.controller.abort();
      return { partNumber, etag: etag(partNumber) };
    });
    await expect(first.run(await admitted(files))).rejects.toMatchObject({ name: "AbortError" });
    expect(first.calls).toEqual(["create:op-upload:6", "part:job-1:1"]);

    const second = session(files);
    const interrupted = await second.store.read("transcription", "op-upload");
    expect(interrupted).toMatchObject({ phase: "part_dispatching", jobId: "job-1", pendingDispatch: { partNumber: 1 } });

    const done = await second.run(interrupted);
    // The unacknowledged part replays with its retained dispatch; the job is never created twice.
    expect(second.calls).toEqual(["part:job-1:1", "part:job-1:2", "complete:job-1:1,2"]);
    expect(done).toMatchObject({ phase: "upload_completed", completedParts: [{ partNumber: 1 }, { partNumber: 2 }] });
    await expect(second.store.read("transcription", "op-upload")).resolves.toMatchObject({ phase: "upload_completed" });
  });

  it("finishes a completion whose response was lost without reloading the source", async () => {
    const files = new Map<string, string>();
    const first = session(files);
    first.jobs.complete.mockRejectedValueOnce(new Error("socket closed"));
    await expect(first.run(await admitted(files))).rejects.toThrow("socket closed");

    const second = session(files);
    const interrupted = await second.store.read("transcription", "op-upload");
    expect(interrupted.phase).toBe("complete_dispatching");
    await expect(second.run(interrupted)).resolves.toMatchObject({ phase: "upload_completed" });
    expect(second.loadSource).not.toHaveBeenCalled();
    expect(second.calls).toEqual(["complete:job-1:1,2"]);
    expect(second.progress).toEqual([{ stage: "complete", resumed: true }]);
  });

  it("replays a create whose response was lost with the recorded request", async () => {
    const files = new Map<string, string>();
    const first = session(files);
    first.jobs.create.mockRejectedValueOnce(new Error("socket closed"));
    await expect(first.run(await admitted(files))).rejects.toThrow("socket closed");

    const second = session(files);
    const interrupted = await second.store.read("transcription", "op-upload");
    expect(interrupted.phase).toBe("create_dispatching");
    await expect(second.run(interrupted)).resolves.toMatchObject({ phase: "upload_completed" });
    expect(second.calls).toEqual(["create:op-upload:6", "part:job-1:1", "part:job-1:2", "complete:job-1:1,2"]);
    expect(second.progress[0]).toEqual({ stage: "create", resumed: true });
    expect(second.progress).toContainEqual({ stage: "part", partNumber: 2, totalParts: 2 });
  });

  it("refuses to resume when the source no longer matches the recorded upload", async () => {
    const files = new Map<string, string>();
    const first = session(files);
    first.jobs.uploadPart.mockRejectedValueOnce(new Error("socket closed"));
    await expect(first.run(await admitted(files))).rejects.toThrow("socket closed");

    const second = session(files);
    second.source.sizeBytes = 5;
    await expect(second.run(await second.store.read("transcription", "op-upload"))).rejects.toThrow("changed");
    expect(second.calls).toEqual([]);
  });
});
