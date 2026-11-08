import { ManagedJobError } from "../ManagedJobClient";
import { uploadManagedParts, uploadManagedRecoveryParts } from "../ManagedMultipartUpload";
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
    const recovery = {
      beginDispatch: jest.fn(),
      acknowledgePart: jest.fn(async () => ({ ...record, revision: 5, phase: "uploading" as const, pendingDispatch: undefined })),
    };
    await expect(uploadManagedRecoveryParts({ ...h.options, record, dispatch: new ManagedJobDispatch(recovery), recovery })).resolves.toMatchObject({ revision: 5 });
    expect(recovery.beginDispatch).not.toHaveBeenCalled();
    expect(recovery.acknowledgePart).toHaveBeenCalledWith("transcription", "op-1", 4, { partNumber: 2, etag: "etag-2" });
    expect(h.options.source.readSlice).toHaveBeenCalledWith(4, 6);
  });
});
