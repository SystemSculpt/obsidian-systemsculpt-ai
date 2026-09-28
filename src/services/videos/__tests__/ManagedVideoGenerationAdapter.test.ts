import { ManagedVideoGenerationAdapter } from "../ManagedVideoGenerationAdapter";
import type { ManagedJobRecoveryRecord } from "../../managed/ManagedTypes";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const METADATA = { index: 0, mime_type: "video/mp4" as const, size_bytes: 2, sha256: HASH_A, width: 1920, height: 1080, duration_seconds: 8 };
const DOWNLOAD_STARTED_AT = "2026-07-12T00:00:10.000Z";
const delivered = (metadata = METADATA) => ({
  metadata,
  bytes: new Uint8Array([1, 2]).buffer,
  delivery: { download_started_at: DOWNLOAD_STARTED_AT, download_completed_offset_ms: 100 },
});

function record(phase: ManagedJobRecoveryRecord["phase"], revision: number, jobId?: string): ManagedJobRecoveryRecord {
  return {
    schemaVersion: 1,
    revision,
    capability: "video_generation",
    operationId: "studio-video-run-node",
    source: { identity: "studio:project:run:node", fingerprint: `sha256:${"c".repeat(64)}` },
    phase,
    ...(jobId ? { jobId } : {}),
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

function recoveryHarness() {
  let current = record("admitted", 1);
  return {
    createAdmitted: jest.fn(async () => current),
    read: jest.fn(async () => current),
    markContentReady: jest.fn(async () => (current = record("content_ready", 2))),
    beginDispatch: jest.fn(async (_capability, _id, _revision, pending) => (current = record(`${pending.operation}_dispatching` as ManagedJobRecoveryRecord["phase"], current.revision + 1))),
    acknowledgeVideoPrepared: jest.fn(async () => (current = record("prepared", current.revision + 1))),
    acknowledgeVideoCreated: jest.fn(async () => (current = record("processing", current.revision + 1, JOB_ID))),
    applyReconciliation: jest.fn(async () => (current = record("result_ready", current.revision + 1, JOB_ID))),
    recordMediaDownload: jest.fn(async (_capability, _id, _revision, mediaDelivery) => (current = {
      ...record("result_ready", current.revision + 1, JOB_ID),
      mediaDelivery,
    })),
    recordMediaDisplayed: jest.fn(async (_capability, _id, _revision, displayedOffsetMs) => (current = {
      ...current,
      revision: current.revision + 1,
      mediaDelivery: { ...current.mediaDelivery!, displayedOffsetMs },
    })),
    recordMediaVaultWrite: jest.fn(async (_capability, _id, _revision, vaultWriteCompletedOffsetMs) => (current = {
      ...current,
      revision: current.revision + 1,
      mediaDelivery: { ...current.mediaDelivery!, vaultWriteCompletedOffsetMs },
    })),
    recordVideoOutputMeasurements: jest.fn(async (_id, _revision, outputs) => (current = {
      ...current,
      revision: current.revision + 1,
      mediaDelivery: { ...current.mediaDelivery!, outputs },
    })),
    markLocalCommitPending: jest.fn(async () => (current = {
      ...current,
      revision: current.revision + 1,
      phase: "local_commit_pending",
    })),
    completeLocalCommit: jest.fn(async () => (current = {
      ...current,
      revision: current.revision + 1,
      phase: "completed",
    })),
  };
}

const allowedDeps = () => ({
  availability: jest.fn(async () => ({ canOpen: true, authoritative: true })),
  admission: jest.fn(async () => ({ outcome: "allowed" })),
});

describe("ManagedVideoGenerationAdapter", () => {
  it("rejects invalid operation IDs before probing availability", async () => {
    const availability = jest.fn();
    const adapter = new ManagedVideoGenerationAdapter({
      availability,
      admission: jest.fn(),
      jobs: {} as never,
      prepareFrames: jest.fn(),
      recovery: {} as never,
    });
    await expect(adapter.generate({
      operationId: "x".repeat(122),
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ model: "acme/motion-1", prompt: "Animate" }),
    })).rejects.toThrow("operation ID is invalid");
    expect(availability).not.toHaveBeenCalled();
  });

  it.each([
    ["missing model", { prompt: "Animate" }],
    ["url model", { model: "https://evil/model", prompt: "Animate" }],
    ["duration", { model: "acme/motion-1", prompt: "Animate", durationSeconds: 61 }],
    ["resolution", { model: "acme/motion-1", prompt: "Animate", resolution: "1080p?" }],
    ["aspect", { model: "acme/motion-1", prompt: "Animate", aspectRatio: "wide" }],
    ["duplicate roles", { model: "acme/motion-1", prompt: "Animate", frameImages: [
      { role: "first_frame", mimeType: "image/png", sizeBytes: 1, sha256: HASH_A, load: async () => new ArrayBuffer(1) },
      { role: "first_frame", mimeType: "image/png", sizeBytes: 1, sha256: HASH_B, load: async () => new ArrayBuffer(1) },
    ] }],
  ] as const)("rejects invalid payloads before any recovery record exists: %s", async (_name, payload) => {
    const createAdmitted = jest.fn();
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      jobs: {} as never,
      prepareFrames: jest.fn(),
      recovery: { createAdmitted } as never,
    });
    await expect(adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => payload as never,
    })).rejects.toThrow(/Managed video generation/);
    expect(createAdmitted).not.toHaveBeenCalled();
  });

  it("stops waiting on admission when cancelled and reports its own cancellation", async () => {
    const controller = new AbortController();
    const admission = jest.fn((signal?: AbortSignal) => new Promise<{ outcome: string }>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const buildPayload = jest.fn();
    const adapter = new ManagedVideoGenerationAdapter({
      availability: jest.fn(async () => ({ canOpen: true, authoritative: true })),
      admission,
      jobs: {} as never,
      prepareFrames: jest.fn(),
      recovery: {} as never,
    });

    const running = adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload,
      signal: controller.signal,
    });
    for (let turn = 0; turn < 20 && admission.mock.calls.length === 0; turn += 1) await Promise.resolve();
    expect(admission).toHaveBeenCalledWith(controller.signal);
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError", message: "Video generation was cancelled locally." });
    expect(buildPayload).not.toHaveBeenCalled();
  });

  it("blocks when hosted videos is not served or admission is denied", async () => {
    const adapter = new ManagedVideoGenerationAdapter({
      availability: jest.fn(async () => ({ canOpen: false, authoritative: true })),
      admission: jest.fn(),
      jobs: {} as never,
      prepareFrames: jest.fn(),
      recovery: {} as never,
    });
    await expect(adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ model: "acme/motion-1", prompt: "Animate" }),
    })).rejects.toThrow("not available on this server");

    const denied = new ManagedVideoGenerationAdapter({
      availability: jest.fn(async () => ({ canOpen: true, authoritative: false })),
      admission: jest.fn(async () => ({ outcome: "license_required" })),
      jobs: {} as never,
      prepareFrames: jest.fn(),
      recovery: {} as never,
    });
    await expect(denied.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ model: "acme/motion-1", prompt: "Animate" }),
    })).rejects.toThrow("unavailable (license_required)");
  });

  it("uploads frames with preserved roles, creates with the model, reports progress, and downloads verified outputs", async () => {
    const recovery = recoveryHarness();
    const prepareFrames = jest.fn(async (inputs: Array<{ mime_type: string }>, load: (index: number) => Promise<ArrayBuffer>) => {
      expect(inputs.map(input => input.mime_type)).toEqual(["image/png", "image/webp"]);
      expect([...new Uint8Array(await load(0))]).toEqual([1]);
      expect([...new Uint8Array(await load(1))]).toEqual([2]);
      return {
        uploadId: "upload-1",
        inputs: [
          { type: "uploaded" as const, key: "key-first", mime_type: "image/png" as const, size_bytes: 1, sha256: HASH_A },
          { type: "uploaded" as const, key: "key-last", mime_type: "image/webp" as const, size_bytes: 1, sha256: HASH_B },
        ],
      };
    });
    const create = jest.fn(async body => {
      expect(body).toEqual({
        model: "acme/motion-1",
        prompt: "Animate the vault graph",
        frame_images: [
          { type: "uploaded", key: "key-first", mime_type: "image/png", size_bytes: 1, sha256: HASH_A, role: "first_frame" },
          { type: "uploaded", key: "key-last", mime_type: "image/webp", size_bytes: 1, sha256: HASH_B, role: "last_frame" },
        ],
        options: { duration_seconds: 8, resolution: "1080p", aspect_ratio: "16:9", generate_audio: true },
      });
      return { job: { id: JOB_ID, status: "queued" } };
    });
    const status = jest.fn()
      .mockResolvedValueOnce({ job: { id: JOB_ID, status: "processing" }, outputs: [], poll_after_ms: 0, typical_duration_ms: 90_000 })
      .mockResolvedValueOnce({ job: { id: JOB_ID, status: "succeeded" }, outputs: [METADATA] });
    const progress: unknown[] = [];
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery,
      jobs: {
        create,
        status,
        downloadOutput: jest.fn(async () => delivered()),
        acknowledgeDelivery: jest.fn(),
      },
      prepareFrames,
      createRequestId: () => "request-1",
      wait: async () => undefined,
    });

    const result = await adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      onProgress: value => progress.push(value),
      buildPayload: () => ({
        model: "acme/motion-1",
        prompt: "Animate the vault graph",
        durationSeconds: 8,
        resolution: "1080p",
        aspectRatio: "16:9",
        generateAudio: true,
        frameImages: [
          { role: "first_frame", mimeType: "image/png", sizeBytes: 1, sha256: HASH_A, load: async () => new Uint8Array([1]).buffer },
          { role: "last_frame", mimeType: "image/webp", sizeBytes: 1, sha256: HASH_B, load: async () => new Uint8Array([2]).buffer },
        ],
      }),
    });

    expect(result).toMatchObject({ operationId: "studio-video-run-node", jobId: JOB_ID });
    expect(result.outputs).toHaveLength(1);
    expect(recovery.acknowledgeVideoPrepared).toHaveBeenCalledTimes(1);
    expect(recovery.acknowledgeVideoCreated).toHaveBeenCalledWith("studio-video-run-node", expect.any(Number), JOB_ID);
    expect(recovery.applyReconciliation).toHaveBeenCalledWith("video_generation", "studio-video-run-node", expect.any(Number), "succeeded");
    expect(recovery.recordMediaDownload).toHaveBeenCalledWith(
      "video_generation",
      "studio-video-run-node",
      expect.any(Number),
      {
        downloadStartedAt: DOWNLOAD_STARTED_AT,
        downloadCompletedOffsetMs: 100,
        outputs: [{ index: 0, width: 1920, height: 1080, durationSeconds: 8 }],
      },
    );
    expect(progress).toEqual([
      { status: "processing", typicalDurationMs: 90_000 },
      { status: "succeeded" },
    ]);
    expect(create).toHaveBeenCalledWith(expect.anything(), "studio-video-run-node", expect.any(AbortSignal));
  });

  it("reconciles terminal failures using the media error taxonomy and rethrows", async () => {
    const recovery = recoveryHarness();
    const terminal = Object.assign(new Error("The provider timed out before finishing this job."), {
      name: "ManagedMediaJobError", code: "video_generation_failed", retryable: false,
    });
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery,
      jobs: {
        create: jest.fn(async () => ({ job: { id: JOB_ID, status: "queued" } })),
        status: jest.fn().mockRejectedValue(terminal),
        downloadOutput: jest.fn(),
      },
      prepareFrames: jest.fn(),
      createRequestId: () => "request-1",
      wait: async () => undefined,
    });

    await expect(adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ model: "acme/motion-1", prompt: "Animate" }),
    })).rejects.toMatchObject({ code: "video_generation_failed" });
    expect(recovery.applyReconciliation).toHaveBeenCalledWith("video_generation", "studio-video-run-node", expect.any(Number), "failed");
  });

  it("fingerprints model, frames, and options so distinct requests never share recovery identity", async () => {
    const fingerprints: string[] = [];
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery: {
        createAdmitted: jest.fn(async input => {
          fingerprints.push(input.source.fingerprint);
          throw new Error("fingerprint captured");
        }),
      } as never,
      jobs: {} as never,
      prepareFrames: jest.fn(),
    });
    const generate = (payload: Record<string, unknown>, operationId: string) => adapter.generate({
      operationId,
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => payload as never,
    });

    await expect(generate({ model: "acme/motion-1", prompt: "Animate" }, "fp-one")).rejects.toThrow("fingerprint captured");
    await expect(generate({ model: "acme/motion-2", prompt: "Animate" }, "fp-two")).rejects.toThrow("fingerprint captured");
    await expect(generate({ model: "acme/motion-1", prompt: "Animate", durationSeconds: 8 }, "fp-three")).rejects.toThrow("fingerprint captured");
    expect(fingerprints.every(fingerprint => /^sha256:[a-f0-9]{64}$/.test(fingerprint))).toBe(true);
    expect(new Set(fingerprints).size).toBe(3);
  });

  it("probes missing video metadata without delaying delivery or inflating the vault-write time", async () => {
    const recovery = recoveryHarness();
    const metadata = { ...METADATA, width: null, height: null, duration_seconds: null };
    let resolveProbe!: (value: { index: number; width: number; height: number; durationSeconds: number }) => void;
    const probeOutputMetadata = jest.fn(() => new Promise<{
      index: number;
      width: number;
      height: number;
      durationSeconds: number;
    }>((resolve) => {
      resolveProbe = resolve;
    }));
    let nowMs = 1_000;
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery,
      jobs: {
        create: jest.fn(async () => ({ job: { id: JOB_ID, status: "queued" } })),
        status: jest.fn(async () => ({ job: { id: JOB_ID, status: "succeeded" }, outputs: [metadata] })),
        downloadOutput: jest.fn(async () => delivered(metadata)),
        acknowledgeDelivery: jest.fn(),
      },
      prepareFrames: jest.fn(),
      probeOutputMetadata,
      nowMs: () => nowMs,
      elapsedNow: () => nowMs,
      wait: async () => undefined,
    });

    const result = await adapter.generate({
      operationId: "studio-video-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ model: "acme/motion-1", prompt: "Animate" }),
    });

    expect(probeOutputMetadata).toHaveBeenCalledTimes(1);
    expect(result.outputs[0]?.metadata).toMatchObject({ width: null, height: null, duration_seconds: null });
    expect(recovery.recordMediaDownload).toHaveBeenCalledWith(
      "video_generation",
      "studio-video-run-node",
      expect.any(Number),
      expect.objectContaining({ outputs: [{ index: 0, width: null, height: null, durationSeconds: null }] }),
    );
    expect(recovery.recordVideoOutputMeasurements).not.toHaveBeenCalled();

    nowMs = 1_020;
    await adapter.markDisplayed("studio-video-run-node");
    await adapter.beginLocalCommit("studio-video-run-node");
    nowMs = 1_050;
    await adapter.markVaultWriteCompleted("studio-video-run-node");
    nowMs = 4_000;
    expect(recovery.recordMediaVaultWrite).toHaveBeenCalledWith(
      "video_generation",
      "studio-video-run-node",
      expect.any(Number),
      150,
    );
    expect(recovery.recordVideoOutputMeasurements).not.toHaveBeenCalled();

    const completion = adapter.completeLocalCommit("studio-video-run-node");
    await Promise.resolve();
    resolveProbe({ index: 0, width: 1280, height: 720, durationSeconds: 6 });
    await completion;

    expect(recovery.recordVideoOutputMeasurements).toHaveBeenCalledWith(
      "studio-video-run-node",
      expect.any(Number),
      [{ index: 0, width: 1280, height: 720, durationSeconds: 6 }],
    );
  });

  it("sends measured output metadata before completing local recovery", async () => {
    let current: ManagedJobRecoveryRecord = {
      ...record("local_commit_pending", 7, JOB_ID),
      mediaDelivery: {
        downloadStartedAt: DOWNLOAD_STARTED_AT,
        downloadCompletedOffsetMs: 100,
        displayedOffsetMs: 120,
        vaultWriteCompletedOffsetMs: 150,
        outputs: [{ index: 0, width: 1280, height: 720, durationSeconds: 6 }],
      },
    };
    const acknowledgeDelivery = jest.fn(async () => ({ acknowledged: true as const, acknowledged_at: "2026-07-12T00:00:11Z" }));
    const completeLocalCommit = jest.fn(async () => (current = { ...current, revision: 8, phase: "completed" }));
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery: { read: jest.fn(async () => current), completeLocalCommit } as never,
      jobs: { acknowledgeDelivery } as never,
      prepareFrames: jest.fn(),
      wait: async () => undefined,
    });

    await adapter.completeLocalCommit("studio-video-run-node");

    expect(acknowledgeDelivery).toHaveBeenCalledWith(JOB_ID, {
      download_completed_offset_ms: 100,
      displayed_offset_ms: 120,
      vault_write_completed_offset_ms: 150,
      outputs: [{ index: 0, width: 1280, height: 720, duration_seconds: 6 }],
    }, expect.any(AbortSignal));
    expect(acknowledgeDelivery.mock.invocationCallOrder[0]).toBeLessThan(completeLocalCommit.mock.invocationCallOrder[0]);
  });
});

describe("resuming a managed video job after a restart", () => {
  function resumeHarness(stored: ManagedJobRecoveryRecord | null) {
    const create = jest.fn();
    const downloadOutput = jest.fn(async () => delivered());
    // The real store rejects a second reconciliation outright, so the mock does
    // too: a resume that reaches this on an already-reconciled record is the
    // defect, not a harmless extra call.
    const applyReconciliation = jest.fn(async () => {
      if (stored && stored.phase !== "processing") throw new Error("Record is not reconcilable.");
      return record("result_ready", 9, JOB_ID);
    });
    const adapter = new ManagedVideoGenerationAdapter({
      ...allowedDeps(),
      recovery: {
        read: jest.fn(async () => {
          if (!stored) throw new Error("Managed job recovery record not found.");
          return stored;
        }),
        applyReconciliation,
        recordMediaDownload: jest.fn(async (_capability, _id, revision, mediaDelivery) => ({
          ...(stored ?? record("result_ready", revision, JOB_ID)),
          revision: revision + 1,
          phase: "result_ready" as const,
          mediaDelivery,
        })),
      } as never,
      jobs: {
        create,
        status: jest.fn(async () => ({ job: { id: JOB_ID, status: "succeeded" as const }, outputs: [METADATA] })),
        downloadOutput,
      } as never,
      prepareFrames: jest.fn(),
      createRequestId: () => "request-1",
      wait: async () => undefined,
    });
    return { adapter, create, downloadOutput, applyReconciliation };
  }

  it("downloads the job the record already created instead of paying for a second one", async () => {
    const { adapter, create, downloadOutput } = resumeHarness(record("processing", 4, JOB_ID));

    const result = await adapter.resume("studio-video-run-node");

    expect(result).toMatchObject({ jobId: JOB_ID, operationId: "studio-video-run-node" });
    expect(result?.outputs).toHaveLength(1);
    expect(downloadOutput).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("retries a dropped video transfer using the same completed output", async () => {
    const { adapter, create, downloadOutput } = resumeHarness(record("processing", 4, JOB_ID));
    downloadOutput.mockRejectedValueOnce(new TypeError("connection reset"));

    await expect(adapter.resume("studio-video-run-node")).resolves.toMatchObject({ jobId: JOB_ID });

    expect(downloadOutput).toHaveBeenCalledTimes(2);
    expect(downloadOutput.mock.calls[0]).toEqual(downloadOutput.mock.calls[1]);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not retry corrupt video bytes", async () => {
    const { adapter, downloadOutput } = resumeHarness(record("processing", 4, JOB_ID));
    downloadOutput.mockRejectedValueOnce(Object.assign(new Error("Integrity mismatch"), {
      code: "malformed_response", retryable: false,
    }));

    await expect(adapter.resume("studio-video-run-node")).rejects.toMatchObject({ code: "malformed_response" });
    expect(downloadOutput).toHaveBeenCalledTimes(1);
  });

  it("stops retrieval when cancellation arrives during a dropped video transfer", async () => {
    const { adapter, downloadOutput } = resumeHarness(record("processing", 4, JOB_ID));
    const controller = new AbortController();
    downloadOutput.mockImplementationOnce(async () => {
      controller.abort();
      throw new TypeError("connection aborted");
    });

    await expect(adapter.resume("studio-video-run-node", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(downloadOutput).toHaveBeenCalledTimes(1);
  });

  it.each(["created", "result_ready", "local_commit_pending"] as const)(
    "rejoins a %s job whose outputs the vault closed before saving",
    async (phase) => {
      // The server already finished and the record already carries its terminal
      // status; only the local save is missing. Reconciling again is illegal, so
      // this used to throw on every reload and strand the Studio placeholder.
      const { adapter, downloadOutput, applyReconciliation } = resumeHarness(record(phase, 6, JOB_ID));

      const result = await adapter.resume("studio-video-run-node");

      expect(result).toMatchObject({ jobId: JOB_ID, operationId: "studio-video-run-node" });
      expect(downloadOutput).toHaveBeenCalledTimes(1);
      expect(applyReconciliation).not.toHaveBeenCalled();
    },
  );

  it("declines an operation with no record, no job, or no work left on the server", async () => {
    await expect(resumeHarness(null).adapter.resume("studio-video-run-node")).resolves.toBeNull();
    await expect(resumeHarness(record("admitted", 1)).adapter.resume("studio-video-run-node")).resolves.toBeNull();
    await expect(resumeHarness(record("completed", 8, JOB_ID)).adapter.resume("studio-video-run-node")).resolves.toBeNull();
    await expect(resumeHarness(record("abandoned", 8, JOB_ID)).adapter.resume("studio-video-run-node")).resolves.toBeNull();
  });
});
