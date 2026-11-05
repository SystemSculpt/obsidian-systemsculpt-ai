import { ManagedImageGenerationAdapter, type ManagedImageGenerationDependencies } from "../ManagedImageGenerationAdapter";
import { ManagedMediaJobError } from "../../managed/ManagedMediaJobClient";
import type { ManagedJobRecoveryRecord } from "../../managed/ManagedTypes";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const START = Date.parse("2026-11-04T00:00:00Z");
const METADATA = { index: 0, mime_type: "image/png" as const, size_bytes: 2, sha256: "a".repeat(64), width: 1, height: 1 };
type Status = Awaited<ReturnType<ManagedImageGenerationDependencies["jobs"]["status"]>>;

function snapshot(status = "processing", hints: Partial<Status> = {}): Status {
  return {
    job: { id: JOB_ID, model: "test/image", status, created_at: new Date(START).toISOString(), processing_started_at: new Date(START).toISOString() },
    outputs: status === "succeeded" ? [METADATA] : [],
    usage: { raw_usd: 0, cost_source: "not_billed", estimated: false },
    ...hints,
  };
}

function harness() {
  let now = START;
  let current: ManagedJobRecoveryRecord = {
    schemaVersion: 1, revision: 1, capability: "image_generation", operationId: "image-poll-test",
    source: { identity: "studio:test", fingerprint: `sha256:${"c".repeat(64)}` },
    phase: "processing", jobId: JOB_ID, createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
  };
  const recovery = {
    createAdmitted: jest.fn(async () => current),
    read: jest.fn(async () => current),
    markContentReady: jest.fn(async () => current),
    beginDispatch: jest.fn(async () => current),
    acknowledgePrepared: jest.fn(async () => current),
    acknowledgeImageCreated: jest.fn(async () => current),
    applyReconciliation: jest.fn(async () => (current = { ...current, phase: "result_ready", revision: current.revision + 1 })),
    recordMediaDownload: jest.fn(async (_capability, _operationId, _revision, mediaDelivery) => (current = { ...current, mediaDelivery })),
    recordMediaDisplayed: jest.fn(async () => current),
    recordMediaVaultWrite: jest.fn(async () => current),
    markLocalCommitPending: jest.fn(async () => current),
    completeLocalCommit: jest.fn(async () => current),
  };
  const jobs = {
    create: jest.fn(async (_body: Parameters<ManagedImageGenerationDependencies["jobs"]["create"]>[0], _operationId: string) => ({ job: { id: JOB_ID } })),
    status: jest.fn<Promise<Status>, []>(async () => snapshot("succeeded")),
    downloadOutput: jest.fn(async () => ({ metadata: METADATA, bytes: new Uint8Array([1, 2]).buffer, delivery: { download_started_at: new Date(now).toISOString(), download_completed_offset_ms: 1 } })),
    acknowledgeDelivery: jest.fn(async () => ({ acknowledged: true as const, acknowledged_at: new Date(now).toISOString() })),
  };
  const wait = jest.fn(async (ms: number, _signal: AbortSignal) => { now += ms; });
  const adapter = new ManagedImageGenerationAdapter({
    admission: async () => ({ outcome: "allowed" }), jobs, recovery, prepareInputs: jest.fn(),
    nowMs: () => now, elapsedNow: () => now - START, wait,
  });
  const generate = (signal?: AbortSignal) => adapter.generate({
    operationId: "image-poll-test", sourceIdentity: "studio:test", buildPayload: () => ({ prompt: "test", count: 1 }), signal,
  });
  return { jobs, wait, generate, recovery, elapsed: () => now - START };
}

describe("ManagedImageGenerationAdapter status polling", () => {
  it.each([[undefined, 14], [108_000, 12]] as const)("observes a 108-second job with ETA %s in %s reads, not 55", async (eta, reads) => {
    const h = harness();
    h.jobs.status.mockImplementation(async () => snapshot(h.elapsed() >= 108_000 ? "succeeded" : "processing", {
      poll_after_ms: 2_000, ...(eta === undefined ? {} : { typical_duration_ms: eta }),
    }));
    const result = await h.generate();
    expect(h.jobs.status).toHaveBeenCalledTimes(reads);
    expect(h.jobs.status.mock.calls.length).toBeLessThan(15);
    expect(h.jobs.create).toHaveBeenCalledTimes(1);
    expect(h.jobs.create.mock.calls[0][0]).toMatchObject({ options: { count: 1 } });
    expect(h.jobs.downloadOutput).toHaveBeenCalledTimes(1);
    expect(result.jobId).toBe(JOB_ID);
    expect(h.wait.mock.calls.map(([ms]) => ms).slice(0, 4)).toEqual(eta === undefined ? [2_000, 4_000, 8_000, 10_000] : [10_000, 10_000, 10_000, 10_000]);
    expect(h.wait.mock.calls.length).toBe(reads - 1);
  });

  it("does not reset backoff when a queued job starts processing or exceeds its ETA", async () => {
    const h = harness();
    h.jobs.status
      .mockResolvedValueOnce(snapshot("queued", { poll_after_ms: 0 }))
      .mockResolvedValueOnce(snapshot("processing", { typical_duration_ms: 1 }))
      .mockResolvedValueOnce(snapshot("processing", { typical_duration_ms: 1 }))
      .mockResolvedValueOnce(snapshot("processing"))
      .mockResolvedValueOnce(snapshot("succeeded"));
    await h.generate();
    expect(h.wait.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 8_000, 10_000]);
  });

  it("uses remaining ETA rather than the full duration for an older job", async () => {
    const h = harness();
    h.jobs.status.mockResolvedValueOnce(snapshot("processing", {
      job: { ...snapshot().job, processing_started_at: new Date(START - 100_000).toISOString() }, typical_duration_ms: 120_000,
    })).mockResolvedValueOnce(snapshot("succeeded"));
    await h.generate();
    expect(h.wait.mock.calls.map(([ms]) => ms)).toEqual([2_000]);
  });

  it("respects a status wait longer than its 10-second backoff", async () => {
    const h = harness();
    h.jobs.status.mockResolvedValueOnce(snapshot("processing", { poll_after_ms: 30_000 })).mockResolvedValueOnce(snapshot("succeeded"));
    await h.generate();
    expect(h.wait.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
  });

  it("honors 429 Retry-After without creating another image job", async () => {
    const h = harness();
    h.jobs.status.mockRejectedValueOnce(new ManagedMediaJobError("rate_limited", "Busy", 429, null, true, null, 30_000))
      .mockResolvedValueOnce(snapshot("succeeded"));
    await h.generate();
    expect(h.wait.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
    expect(h.jobs.status).toHaveBeenCalledTimes(2);
    expect(h.jobs.create).toHaveBeenCalledTimes(1);
  });

  it.each(["image_generation_failed", "job_expired"])("stops on terminal %s without another status read", async code => {
    const h = harness();
    h.jobs.status.mockRejectedValueOnce(new ManagedMediaJobError(code, "Final", 200));
    await expect(h.generate()).rejects.toThrow("Final");
    expect(h.jobs.status).toHaveBeenCalledTimes(1);
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.jobs.downloadOutput).not.toHaveBeenCalled();
  });

  it("cancels during a backoff before another read", async () => {
    const h = harness();
    const controller = new AbortController();
    h.jobs.status.mockResolvedValue(snapshot());
    h.wait.mockImplementationOnce(async () => { controller.abort(); });
    await expect(h.generate(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.jobs.status).toHaveBeenCalledTimes(1);
  });
});
