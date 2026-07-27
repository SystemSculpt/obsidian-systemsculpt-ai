import { ManagedImageGenerationAdapter } from "../ManagedImageGenerationAdapter";
import type { ManagedJobRecoveryRecord } from "../../managed/ManagedTypes";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function record(phase: ManagedJobRecoveryRecord["phase"], revision: number, jobId?: string): ManagedJobRecoveryRecord {
  return {
    schemaVersion: 1,
    revision,
    capability: "image_generation",
    operationId: "studio-image-run-node",
    source: { identity: "studio:project:run:node", fingerprint: `sha256:${"c".repeat(64)}` },
    phase,
    ...(jobId ? { jobId } : {}),
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("ManagedImageGenerationAdapter", () => {
  it("rejects operation IDs that cannot form the required bounded idempotency key", async () => {
    const acquireLease = jest.fn();
    const adapter = new ManagedImageGenerationAdapter({
      admission: { acquireLease } as never,
      jobs: {} as never,
      recovery: {} as never,
    });

    await expect(adapter.generate({
      operationId: "x".repeat(122),
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ prompt: "Draw" }),
    })).rejects.toThrow("operation ID is invalid");
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("admits before lazy payload work, preserves uploaded keys, and downloads named verified outputs", async () => {
    const events: string[] = [];
    let current = record("admitted", 1);
    const recovery = {
      createAdmitted: jest.fn(async () => {
        events.push("recovery:admitted");
        return current;
      }),
      read: jest.fn(async () => current),
      markContentReady: jest.fn(async () => (current = record("content_ready", 2))),
      beginDispatch: jest.fn(async (_capability, _id, _revision, pending) => {
        current = record(`${pending.operation}_dispatching`, current.revision + 1);
        return current;
      }),
      acknowledgePrepared: jest.fn(async () => (current = record("prepared", current.revision + 1))),
      acknowledgeImageCreated: jest.fn(async () => (current = record("processing", current.revision + 1, "123e4567-e89b-42d3-a456-426614174000"))),
      applyReconciliation: jest.fn(async () => (current = record("result_ready", current.revision + 1, "123e4567-e89b-42d3-a456-426614174000"))),
      markLocalCommitPending: jest.fn(async () => (current = record("local_commit_pending", current.revision + 1, current.jobId))),
      completeLocalCommit: jest.fn(async () => (current = record("completed", current.revision + 1, current.jobId))),
    };
    const prepareInputs = jest.fn(async (_inputs, load) => {
      events.push("jobs:prepare");
      expect([...new Uint8Array(await load(1))]).toEqual([2]);
      expect([...new Uint8Array(await load(0))]).toEqual([1]);
      return {
        uploadId: "upload-1",
        inputs: [
          { type: "uploaded" as const, key: "key-a", mime_type: "image/png" as const, size_bytes: 1, sha256: HASH_A },
          { type: "uploaded" as const, key: "key-b", mime_type: "image/webp" as const, size_bytes: 1, sha256: HASH_B },
        ],
      };
    });
    const create = jest.fn(async body => {
      events.push("jobs:create");
      expect(body.input_images?.map(input => input.key)).toEqual(["key-a", "key-b"]);
      expect(body.options).toEqual({ count: 2, aspect_ratio: "16:9" });
      return { job: { id: "123e4567-e89b-42d3-a456-426614174000", status: "queued" as const } };
    });
    const metadata = {
      index: 0,
      mime_type: "image/png" as const,
      size_bytes: 2,
      sha256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222",
      width: 2,
      height: 1,
    };
    const adapter = new ManagedImageGenerationAdapter({
      admission: {
        acquireLease: jest.fn(async () => {
          events.push("admission");
          return { outcome: "allowed" };
        }),
      } as never,
      recovery,
      jobs: {
        prepareInputs,
        create,
        status: jest.fn(async () => ({
          job: { id: "123e4567-e89b-42d3-a456-426614174000", status: "succeeded" as const },
          outputs: [metadata],
        })),
        downloadOutput: jest.fn(async () => ({ metadata, bytes: new Uint8Array([1, 2]).buffer })),
      },
      createRequestId: () => "request-1",
      wait: async () => undefined,
    });

    const result = await adapter.generate({
      operationId: "studio-image-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: async () => {
        events.push("payload");
        return {
          prompt: "Draw a vault graph",
          count: 2,
          aspectRatio: "16:9",
          inputImages: [
            { mimeType: "image/png", sizeBytes: 1, sha256: HASH_A, load: async () => new Uint8Array([1]).buffer },
            { mimeType: "image/webp", sizeBytes: 1, sha256: HASH_B, load: async () => new Uint8Array([2]).buffer },
          ],
        };
      },
    });

    expect(events.slice(0, 3)).toEqual(["admission", "payload", "recovery:admitted"]);
    expect(result.operationId).toBe("studio-image-run-node");
    expect(result.outputs).toHaveLength(1);
    expect(prepareInputs).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Draw a vault graph" }),
      "studio-image-run-node",
      expect.any(AbortSignal),
    );
  });

  it("fingerprints accepted payload content instead of only operation identity", async () => {
    const fingerprints: string[] = [];
    const load = jest.fn(async () => new Uint8Array([1]).buffer);
    const adapter = new ManagedImageGenerationAdapter({
      admission: { acquireLease: jest.fn(async () => ({ outcome: "allowed" })) } as never,
      recovery: {
        createAdmitted: jest.fn(async input => {
          fingerprints.push(input.source.fingerprint);
          throw new Error("fingerprint captured");
        }),
      } as never,
      jobs: {} as never,
    });

    await expect(adapter.generate({
      operationId: "image-content-one",
      sourceIdentity: "studio:same-project:unique-run-node",
      buildPayload: () => ({
        prompt: "Draw the first accepted payload",
        inputImages: [{ mimeType: "image/png", sizeBytes: 1, sha256: HASH_A, load }],
      }),
    })).rejects.toThrow("fingerprint captured");
    await expect(adapter.generate({
      operationId: "image-content-two",
      sourceIdentity: "studio:same-project:unique-run-node",
      buildPayload: () => ({
        prompt: "Draw the second accepted payload",
        inputImages: [{ mimeType: "image/png", sizeBytes: 1, sha256: HASH_B, load }],
      }),
    })).rejects.toThrow("fingerprint captured");

    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprints[1]).not.toBe(fingerprints[0]);
    expect(load).not.toHaveBeenCalled();
  });

  it("removes each polling abort listener after a normal timer resolution", async () => {
    const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      queueMicrotask(() => {
        if (typeof handler === "function") handler();
      });
      return 1;
    }) as typeof globalThis.setTimeout);
    try {
      let current = record("admitted", 1);
      const recovery = {
        createAdmitted: jest.fn(async () => current),
        read: jest.fn(async () => current),
        markContentReady: jest.fn(async () => (current = record("content_ready", 2))),
        beginDispatch: jest.fn(async (_capability, _id, _revision, pending) => (current = record(`${pending.operation}_dispatching`, current.revision + 1))),
        acknowledgePrepared: jest.fn(),
        acknowledgeImageCreated: jest.fn(async () => (current = record("processing", current.revision + 1, "123e4567-e89b-42d3-a456-426614174000"))),
        applyReconciliation: jest.fn(async () => (current = record("result_ready", current.revision + 1, current.jobId))),
        markLocalCommitPending: jest.fn(),
        completeLocalCommit: jest.fn(),
      };
      const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 1, sha256: HASH_A, width: 1, height: 1 };
      const status = jest.fn()
        .mockResolvedValueOnce({ job: { id: "123e4567-e89b-42d3-a456-426614174000", status: "processing" }, outputs: [] })
        .mockResolvedValueOnce({ job: { id: "123e4567-e89b-42d3-a456-426614174000", status: "succeeded" }, outputs: [metadata] });
      const adapter = new ManagedImageGenerationAdapter({
        admission: { acquireLease: jest.fn(async () => ({ outcome: "allowed" })) } as never,
        recovery,
        jobs: {
          prepareInputs: jest.fn(),
          create: jest.fn(async () => ({ job: { id: "123e4567-e89b-42d3-a456-426614174000", status: "queued" } })),
          status,
          downloadOutput: jest.fn(async () => ({ metadata, bytes: new Uint8Array([1]).buffer })),
        } as never,
        createRequestId: () => "request-1",
        maxPolls: 2,
      });
      const controller = new AbortController();
      const add = jest.spyOn(controller.signal, "addEventListener");
      const remove = jest.spyOn(controller.signal, "removeEventListener");
      const running = adapter.generate({
        operationId: "studio-image-run-node",
        sourceIdentity: "studio:project:run:node",
        signal: controller.signal,
        buildPayload: () => ({ prompt: "Draw" }),
      });

      await expect(running).resolves.toMatchObject({ operationId: "studio-image-run-node" });
      expect(status).toHaveBeenCalledTimes(2);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
    }
  });

  function pollHarness(status: jest.Mock) {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    let current = record("admitted", 1);
    const recovery = {
      createAdmitted: jest.fn(async () => current),
      read: jest.fn(async () => current),
      markContentReady: jest.fn(async () => (current = record("content_ready", 2))),
      beginDispatch: jest.fn(async (_capability, _id, _revision, pending) => (current = record(`${pending.operation}_dispatching`, current.revision + 1))),
      acknowledgePrepared: jest.fn(),
      acknowledgeImageCreated: jest.fn(async () => (current = record("processing", current.revision + 1, jobId))),
      applyReconciliation: jest.fn(async () => (current = record("result_ready", current.revision + 1, jobId))),
      markLocalCommitPending: jest.fn(),
      completeLocalCommit: jest.fn(),
    };
    const metadata = { index: 0, mime_type: "image/png" as const, size_bytes: 1, sha256: HASH_A, width: 1, height: 1 };
    const waits: number[] = [];
    const adapter = new ManagedImageGenerationAdapter({
      admission: { acquireLease: jest.fn(async () => ({ outcome: "allowed" })) } as never,
      recovery,
      jobs: {
        prepareInputs: jest.fn(),
        create: jest.fn(async () => ({ job: { id: jobId, status: "queued" } })),
        status,
        downloadOutput: jest.fn(async () => ({ metadata, bytes: new Uint8Array([1]).buffer })),
      } as never,
      createRequestId: () => "request-1",
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
    });
    const generate = () => adapter.generate({
      operationId: "studio-image-run-node",
      sourceIdentity: "studio:project:run:node",
      buildPayload: () => ({ prompt: "Draw" }),
    });
    return { generate, waits, metadata, jobId };
  }

  it("retries transient status failures with backoff instead of failing the run", async () => {
    const jobId = "123e4567-e89b-42d3-a456-426614174000";
    const retryable503 = Object.assign(new Error("SystemSculpt processing is temporarily unavailable."), {
      name: "ManagedJobError", code: "temporarily_unavailable", retryable: true,
    });
    const transportBlip = new TypeError("connection reset");
    const status = jest.fn()
      .mockRejectedValueOnce(retryable503)
      .mockRejectedValueOnce(transportBlip)
      .mockResolvedValueOnce({ job: { id: jobId, status: "processing" }, outputs: [], poll_after_ms: 0 })
      .mockRejectedValueOnce(retryable503)
      .mockImplementation(async () => ({
        job: { id: jobId, status: "succeeded" },
        outputs: [{ index: 0, mime_type: "image/png", size_bytes: 1, sha256: HASH_A, width: 1, height: 1 }],
      }));
    const harness = pollHarness(status);

    await expect(harness.generate()).resolves.toMatchObject({ jobId });
    expect(status).toHaveBeenCalledTimes(5);
    // Backoff doubles per consecutive failure and resets after a good poll.
    expect(harness.waits).toEqual([2_000, 4_000, 0, 2_000]);
  });

  it("does not retry protocol violations and gives up after consecutive transient failures", async () => {
    const malformed = Object.assign(new Error("Malformed managed job response."), {
      name: "ManagedJobError", code: "malformed_response", retryable: false,
    });
    const malformedHarness = pollHarness(jest.fn().mockRejectedValue(malformed));
    await expect(malformedHarness.generate()).rejects.toMatchObject({ code: "malformed_response" });
    expect(malformedHarness.waits).toEqual([]);

    const retryable503 = Object.assign(new Error("SystemSculpt processing is temporarily unavailable."), {
      name: "ManagedJobError", code: "temporarily_unavailable", retryable: true,
    });
    const exhausted = jest.fn().mockRejectedValue(retryable503);
    const exhaustedHarness = pollHarness(exhausted);
    await expect(exhaustedHarness.generate()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(exhausted).toHaveBeenCalledTimes(6);
    expect(exhaustedHarness.waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });
});
