/** @jest-environment jsdom */

import type SystemSculptPlugin from "../../../main";
import { AudioProcessorApiError } from "../AudioProcessorApiClient";
import { getAudioProcessorAvailability } from "../AudioProcessorAvailability";
import type { AudioProcessorJob } from "../types";
import { resumeAudioProcessorJobs } from "../AudioProcessorResume";

const mockListActiveJobs = jest.fn();
const mockResume = jest.fn();
const mockAbortInterruptedUpload = jest.fn();
const mockResumeUpload = jest.fn();
const mockHasUploadRecovery = jest.fn();
const mockClearUploadRecovery = jest.fn();
const mockCleanupStaleStaging = jest.fn();
const mockPanelInstances: Array<{
  update: jest.Mock;
  succeed: jest.Mock;
  fail: jest.Mock;
}> = [];

jest.mock("../AudioProcessorAvailability", () => ({
  getAudioProcessorAvailability: jest.fn(),
}));

jest.mock("../AudioProcessorService", () => ({
  AudioProcessorService: jest.fn().mockImplementation(() => ({
    listActiveJobs: mockListActiveJobs,
    abortInterruptedUpload: mockAbortInterruptedUpload,
    hasUploadRecovery: mockHasUploadRecovery,
    clearUploadRecovery: mockClearUploadRecovery,
    cleanupStaleStaging: mockCleanupStaleStaging,
    resume: mockResume,
    resumeUpload: mockResumeUpload,
  })),
}));

jest.mock("../AudioProcessorPanel", () => ({
  AudioProcessorPanel: jest.fn().mockImplementation(() => {
    const panel = { update: jest.fn(), succeed: jest.fn(), fail: jest.fn() };
    mockPanelInstances.push(panel);
    return panel;
  }),
}));

const mockGetAudioProcessorAvailability = getAudioProcessorAvailability as jest.Mock;

const activeJob = (
  id: string,
  status: AudioProcessorJob["status"],
  stage: AudioProcessorJob["stage"],
  updatedAt: string,
): AudioProcessorJob => ({
  id,
  status,
  stage,
  progress: status === "succeeded" ? 1 : 0.5,
  updatedAt,
  error: null,
  quotedCredits: 850,
  chargedCredits: status === "succeeded" ? 850 : 0,
  resumeRequired: status === "awaiting_funds",
  result: status === "succeeded" ? {
    artifactJobId: "audio_job_resume",
    noteUrl: "https://objects.example.com/note",
    summaryUrl: "https://objects.example.com/summary",
    transcriptUrl: "https://objects.example.com/transcript",
    urlExpiresInSeconds: 900,
    filename: `${id}.md`,
    artifactManifest: null,
  } : null,
  transcriptArtifact: null,
});

describe("resumeAudioProcessorJobs", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    jest.clearAllMocks();
    mockPanelInstances.length = 0;
    mockGetAudioProcessorAvailability.mockResolvedValue({ canOpen: true, authoritative: true });
    mockHasUploadRecovery.mockResolvedValue(false);
    mockClearUploadRecovery.mockResolvedValue(undefined);
    mockCleanupStaleStaging.mockResolvedValue(undefined);
    mockResumeUpload.mockResolvedValue({
      jobId: "uploading",
      notePath: "SystemSculpt/Audio Notes/uploading.md",
      transcriptPath: "SystemSculpt/Audio Notes/uploading — Transcript.md",
      summaryAvailable: true,
      open: jest.fn(),
      saveArtifact: jest.fn(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does nothing when startup settings do not yet contain a license key", async () => {
    const plugin = {
      register: jest.fn(),
      settings: {},
      getLogger: () => ({ warn: jest.fn() }),
    } as unknown as SystemSculptPlugin;

    await expect(resumeAudioProcessorJobs(plugin)).resolves.toBeUndefined();

    expect(mockListActiveJobs).not.toHaveBeenCalled();
    expect(mockGetAudioProcessorAvailability).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
  });

  it("quietly skips discovery when the server does not advertise Audio Processor", async () => {
    const warn = jest.fn();
    mockGetAudioProcessorAvailability.mockResolvedValueOnce({
      canOpen: false,
      authoritative: true,
    });
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn }),
    } as unknown as SystemSculptPlugin;

    await expect(resumeAudioProcessorJobs(plugin, {
      notifyOnDiscoveryFailure: true,
    })).resolves.toBeUndefined();

    expect(mockGetAudioProcessorAvailability).toHaveBeenCalledWith(
      plugin,
      {},
      expect.any(AbortSignal),
    );
    expect(mockListActiveJobs).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("classifies a missing discovery endpoint as expected unavailability", async () => {
    const warn = jest.fn();
    mockListActiveJobs.mockRejectedValueOnce(new AudioProcessorApiError(
      "Audio Processor is not available on this server.",
      404,
      "route_not_found",
    ));
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn }),
    } as unknown as SystemSculptPlugin;

    await expect(resumeAudioProcessorJobs(plugin)).resolves.toBeUndefined();

    expect(mockListActiveJobs).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("continues warning for genuine active-job discovery failures", async () => {
    const warn = jest.fn();
    mockListActiveJobs.mockRejectedValueOnce(new AudioProcessorApiError(
      "Audio Processor is temporarily unavailable.",
      503,
      "temporarily_unavailable",
    ));
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn }),
    } as unknown as SystemSculptPlugin;

    await expect(resumeAudioProcessorJobs(plugin)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "Active Audio Processor job discovery failed",
      expect.objectContaining({
        source: "AudioProcessorResume",
        metadata: { error: "Audio Processor is temporarily unavailable." },
      }),
    );
  });

  it("single-flights startup and command discovery, then resumes server-owned work", async () => {
    const jobs = [
      activeJob("upload_interrupted", "uploading", "uploading", "2026-07-18T11:20:00.000Z"),
      activeJob("upload_recent", "uploading", "uploading", "2026-07-18T11:50:00.000Z"),
      activeJob("audio_processing", "processing", "transcribing", "2026-07-18T11:59:00.000Z"),
      activeJob("audio_complete", "succeeded", "complete", "2026-07-18T11:58:00.000Z"),
      {
        ...activeJob("audio_partial", "failed", "complete", "2026-07-18T11:57:00.000Z"),
        transcriptArtifact: {
          artifactJobId: "audio_partial",
          transcriptUrl: "https://objects.example.com/partial-transcript",
          urlExpiresInSeconds: 900,
          filename: "Partial — Transcript.md",
          sha256: "a".repeat(64),
        },
      },
    ];
    mockListActiveJobs.mockResolvedValue(jobs);
    mockHasUploadRecovery.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockResume.mockImplementation(async (job: AudioProcessorJob, options: {
      onProgress?: (event: unknown) => void;
    }) => {
      options.onProgress?.({ stage: job.stage, progress: job.progress, message: "Working" });
      return {
        jobId: job.id,
        notePath: `SystemSculpt/Audio Notes/${job.id}.md`,
        open: jest.fn(),
      };
    });
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn: jest.fn() }),
    } as unknown as SystemSculptPlugin;

    const startup = resumeAudioProcessorJobs(plugin);
    const command = resumeAudioProcessorJobs(plugin, { notifyOnDiscoveryFailure: true });
    expect(command).toBe(startup);
    await startup;
    await Promise.resolve();
    await Promise.resolve();

    expect(mockListActiveJobs).toHaveBeenCalledTimes(1);
    expect(mockAbortInterruptedUpload).not.toHaveBeenCalled();
    expect(mockClearUploadRecovery).toHaveBeenCalledWith("audio_processing");
    expect(mockClearUploadRecovery).toHaveBeenCalledWith("audio_complete");
    expect(mockClearUploadRecovery).toHaveBeenCalledWith("audio_partial");
    expect(mockResumeUpload).toHaveBeenCalledTimes(1);
    expect(mockResumeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ id: "upload_interrupted" }),
      expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
    );
    expect(mockResume.mock.calls.map(([job]) => job.id)).toEqual(expect.arrayContaining([
      "audio_processing",
      "audio_complete",
      "audio_partial",
    ]));
    expect(mockPanelInstances).toHaveLength(4);
    expect(mockPanelInstances.every((panel) => panel.succeed.mock.calls.length === 1)).toBe(true);
    expect(mockPanelInstances.every((panel) => panel.fail.mock.calls.length === 0)).toBe(true);
  });

  it("limits resumable audio jobs to two concurrent recoveries", async () => {
    const jobs = [
      activeJob("audio_one", "processing", "transcribing", "2026-07-18T11:59:00.000Z"),
      activeJob("audio_two", "processing", "summarizing", "2026-07-18T11:58:00.000Z"),
      activeJob("audio_three", "processing", "rendering", "2026-07-18T11:57:00.000Z"),
    ];
    mockListActiveJobs.mockResolvedValue(jobs);
    mockHasUploadRecovery.mockResolvedValue(false);
    const deferred = [
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
    ];
    let active = 0;
    let maxActive = 0;
    mockResume.mockImplementation((_job: AudioProcessorJob, options: {
      onProgress?: (event: unknown) => void;
    }) => {
      const deferredJob = deferred[mockResume.mock.calls.length - 1];
      active += 1;
      maxActive = Math.max(maxActive, active);
      options.onProgress?.({ stage: "transcribing", progress: 0.5, message: "Working" });
      return deferredJob.promise.then(() => {
        active -= 1;
        return {
          jobId: "done",
          notePath: "SystemSculpt/Audio Notes/done.md",
          open: jest.fn(),
        };
      });
    });
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn: jest.fn() }),
    } as unknown as SystemSculptPlugin;

    await resumeAudioProcessorJobs(plugin);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockResume).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);

    deferred[0].resolve();
    deferred[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockResume).toHaveBeenCalledTimes(3);
  });

  it("delivers terminal jobs before long-running watchers and returns startup promptly", async () => {
    const jobs = [
      activeJob("audio_terminal", "succeeded", "complete", "2026-07-18T11:59:00.000Z"),
      activeJob("audio_watcher", "processing", "transcribing", "2026-07-18T11:58:00.000Z"),
    ];
    mockListActiveJobs.mockResolvedValue(jobs);
    const watcher = createDeferred<{
      jobId: string;
      notePath: string;
      open: jest.Mock;
    }>();
    mockResume
      .mockResolvedValueOnce({
        jobId: "audio_terminal",
        notePath: "SystemSculpt/Audio Notes/audio_terminal.md",
        open: jest.fn(),
      })
      .mockImplementationOnce(async (_job: AudioProcessorJob, options: {
        onProgress?: (event: unknown) => void;
      }) => {
        options.onProgress?.({ stage: "transcribing", progress: 0.5, message: "Working" });
        return await watcher.promise;
      });
    const plugin = {
      register: jest.fn(),
      settings: { licenseKey: "license" },
      getLogger: () => ({ warn: jest.fn() }),
    } as unknown as SystemSculptPlugin;

    await resumeAudioProcessorJobs(plugin);

    expect(mockResume.mock.calls.map(([job]) => job.id)).toEqual([
      "audio_terminal",
      "audio_watcher",
    ]);
    expect(mockPanelInstances[0].succeed).toHaveBeenCalledTimes(1);
    expect(mockPanelInstances[1].succeed).toHaveBeenCalledTimes(0);

    watcher.resolve({
      jobId: "audio_watcher",
      notePath: "SystemSculpt/Audio Notes/audio_watcher.md",
      open: jest.fn(),
    });
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
