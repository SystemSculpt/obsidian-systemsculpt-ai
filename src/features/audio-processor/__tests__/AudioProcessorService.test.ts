/** @jest-environment jsdom */

import { App, TFile } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import type {
  AudioProcessorApiClient,
  AudioProcessorSignedPart,
} from "../AudioProcessorApiClient";
import { AudioProcessorService } from "../AudioProcessorService";
import { sha256HexFromBytesPortable } from "../../../studio/hash";
import type {
  AudioProcessorAudioSource,
  AudioProcessorJob,
  AudioProcessorProgressEvent,
  AudioProcessorResult,
} from "../types";

const result: AudioProcessorResult = {
  artifactJobId: "audio_job_123",
  noteUrl: "https://objects.example.com/note",
  summaryUrl: "https://objects.example.com/summary",
  transcriptUrl: "https://objects.example.com/transcript",
  urlExpiresInSeconds: 900,
  filename: "Product sync.md",
  artifactManifest: null,
};

const sha256 = (value: string): string => sha256HexFromBytesPortable(new TextEncoder().encode(value));

const fullNoteMarkdown = (artifactJobId = "audio_job_123"): string =>
  `---\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: full\n---\n\n# Product sync\n\n## Summary\n\nA useful summary.\n\n## Transcript\n\n**00:00** Speaker 1: Hello.`;

const summaryMarkdown = (artifactJobId = "audio_job_123"): string =>
  `---\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: summary\n---\n\n# Product sync — Summary\n\n## Summary\n\nA useful summary.`;

const transcriptMarkdown = (artifactJobId = "audio_job_123"): string =>
  `---\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n## Transcript\n\n**00:00** Speaker 1: Hello.`;

const job = (
  status: AudioProcessorJob["status"],
  stage: AudioProcessorJob["stage"],
  progress: number,
): AudioProcessorJob => ({
  id: "audio_job_123",
  status,
  stage,
  progress,
  updatedAt: "2026-07-18T11:45:00.000Z",
  error: null,
  quotedCredits: 850,
  chargedCredits: status === "succeeded" ? 850 : 0,
  resumeRequired: status === "awaiting_funds",
  result: status === "succeeded" ? result : null,
  transcriptArtifact: null,
});

function createPlugin() {
  const app = new App();
  const created = new (TFile as any)({
    path: "SystemSculpt/Audio Notes/Product sync.md",
    name: "Product sync.md",
    extension: "md",
    stat: { size: 120, ctime: 1, mtime: 1 },
  }) as TFile;
  const transcriptCreated = new (TFile as any)({
    path: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
    name: "Product sync — Transcript.md",
    extension: "md",
    stat: { size: 180, ctime: 1, mtime: 1 },
  }) as TFile;
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
    (path: string) => files.get(path) ?? null,
  );
  (app.vault.getMarkdownFiles as jest.Mock).mockImplementation(
    () => [...files.values()],
  );
  (app.vault.read as jest.Mock).mockImplementation(
    async (file: TFile) => contents.get(file.path) ?? "",
  );
  (app.vault.modify as jest.Mock).mockImplementation(async (file: TFile, markdown: string) => {
    contents.set(file.path, markdown);
  });
  (app.vault.create as jest.Mock).mockImplementation(async (path: string, markdown: string) => {
    if (files.has(path)) throw new Error("File already exists");
    const file = path === created.path
      ? created
      : path === transcriptCreated.path
        ? transcriptCreated
        : new (TFile as any)({
          path,
          name: path.split("/").pop(),
          extension: "md",
          stat: { size: markdown.length, ctime: 1, mtime: 1 },
        }) as TFile;
    files.set(path, file);
    contents.set(path, markdown);
    return file;
  });
  const leaf = { openFile: jest.fn().mockResolvedValue(undefined) };
  (app.workspace as any).getLeaf = jest.fn().mockReturnValue(leaf);
  (app.workspace as any).setActiveLeaf = jest.fn();
  const ensureDirectoryByPath = jest.fn().mockResolvedValue(undefined);
  const warn = jest.fn();
  const settings = {
    licenseKey: "license",
    pendingAudioProcessorUploads: [] as Array<Record<string, unknown>>,
  };
  const updateSettings = jest.fn(async (update: Record<string, unknown>) => {
    if (Object.prototype.hasOwnProperty.call(update, "pendingAudioProcessorUploads")) {
      settings.pendingAudioProcessorUploads = [
        ...((update.pendingAudioProcessorUploads as Array<Record<string, unknown>> | undefined) ?? []),
      ];
    }
  });
  const plugin = {
    app,
    manifest: { version: "6.1.0" },
    settings,
    directoryManager: { ensureDirectoryByPath },
    getLogger: () => ({ warn }),
    getSettingsManager: () => ({ updateSettings }),
  } as unknown as SystemSculptPlugin;
  return {
    app,
    plugin,
    created,
    transcriptCreated,
    files,
    contents,
    leaf,
    ensureDirectoryByPath,
    warn,
    settings,
    updateSettings,
  };
}

function createAudioSource(
  bytes: Uint8Array,
  options: Readonly<{ resumable?: boolean }> = {},
): AudioProcessorAudioSource {
  return {
    filename: "product-sync.m4a",
    contentType: "audio/mp4",
    sizeBytes: bytes.byteLength,
    readSlice: jest.fn(async (start, end) => bytes.slice(start, end).buffer),
    release: jest.fn(),
    ...(options.resumable === false
      ? {}
      : { resumeDescriptor: { kind: "vault" as const, filePath: "Meetings/product-sync.m4a", modifiedAt: 1 } }),
  };
}

function createApi() {
  const signedPart = (partNumber: number): AudioProcessorSignedPart => ({
    partNumber,
    url: `https://objects.example.com/part-${partNumber}`,
    headers: {},
    expiresInSeconds: 900,
  });
  return {
    createAudioJob: jest.fn().mockResolvedValue({
      job: job("uploading", "uploading", 0),
      upload: { partSizeBytes: 4, totalParts: 3 },
    }),
    createYouTubeJob: jest.fn(),
    getPartUrl: jest.fn(async (_jobId: string, partNumber: number) => signedPart(partNumber)),
    uploadPart: jest.fn(async (part: AudioProcessorSignedPart) => ({
      part_number: part.partNumber,
      etag: `etag-${part.partNumber}`,
    })),
    getUploadParts: jest.fn().mockResolvedValue({
      objectCompleted: false,
      partSizeBytes: 4,
      totalParts: 3,
      parts: [],
    }),
    completeUpload: jest.fn().mockResolvedValue(job("queued", "queued", 0.36)),
    abortUpload: jest.fn().mockResolvedValue(undefined),
    acknowledgeJob: jest.fn().mockResolvedValue(undefined),
    getActiveJobs: jest.fn().mockResolvedValue([]),
    resumeJob: jest.fn(),
    getJob: jest.fn()
      .mockResolvedValueOnce(job("processing", "transcribing", 0.62))
      .mockResolvedValueOnce(job("succeeded", "complete", 1)),
    downloadNote: jest.fn(async (url: string) => url.includes("transcript")
      ? transcriptMarkdown()
      : url.includes("summary")
        ? summaryMarkdown()
        : fullNoteMarkdown()),
  };
}

describe("AudioProcessorService", () => {
  it("saves a paid transcript during summary work without acknowledging and repairs its link on completion", async () => {
    const { plugin, contents } = createPlugin();
    const api = createApi();
    const artifactJobId = "audio_job_owner";
    const transcriptMarkdown =
      `---\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.`;
    const noteMarkdown = fullNoteMarkdown(artifactJobId);
    const processing: AudioProcessorJob = {
      ...job("processing", "summarizing", 0.82),
      chargedCredits: 1_100,
      transcriptArtifact: {
        artifactJobId,
        transcriptUrl: "https://objects.example.com/active-transcript",
        urlExpiresInSeconds: 900,
        filename: "Product sync — Transcript.md",
        sha256: sha256(transcriptMarkdown),
      },
    };
    api.createYouTubeJob.mockResolvedValue({ job: processing, upload: null });
    api.downloadNote.mockResolvedValue(transcriptMarkdown);
    const controller = new AbortController();
    const sleep = jest.fn(async (_milliseconds: number, signal: AbortSignal) => await new Promise<void>(
      (_resolve, reject) => signal.addEventListener(
        "abort",
        () => reject(new DOMException("Stopped", "AbortError")),
        { once: true },
      ),
    ));
    let availableTranscript: AudioProcessorProgressEvent["availableTranscript"];
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      sleep,
    });

    const processingPromise = service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, {
      signal: controller.signal,
      onProgress: (event) => {
        availableTranscript = event.availableTranscript ?? availableTranscript;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(availableTranscript).toBeDefined();

    const saved = await availableTranscript!.save();
    expect(saved.notePath).toBe("SystemSculpt/Audio Notes/Product sync — Transcript.md");
    expect(api.acknowledgeJob).not.toHaveBeenCalled();
    expect(contents.get(saved.notePath)).not.toContain("Back to the audio note");

    controller.abort();
    await expect(processingPromise).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));

    api.downloadNote.mockImplementation(async (url: string) => url.includes("transcript")
      ? transcriptMarkdown
      : noteMarkdown);
    await service.resume({
      ...job("succeeded", "complete", 1),
      result: { ...result, artifactJobId },
      transcriptArtifact: null,
    }, { signal: new AbortController().signal });

    expect(contents.get(saved.notePath)).toContain("Back to the audio note");
    expect(api.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it("rejects a manifest digest mismatch before any Vault write or acknowledgement", async () => {
    const { app, plugin } = createPlugin();
    const api = createApi();
    const summaryMarkdown = await api.downloadNote(result.summaryUrl);
    const transcriptMarkdown = await api.downloadNote(result.transcriptUrl);
    api.downloadNote.mockClear();
    api.createYouTubeJob.mockResolvedValue({
      job: {
        ...job("succeeded", "complete", 1),
        result: {
          ...result,
          artifactManifest: {
            version: "audio_processor_artifacts.v1",
            note: {
              url: result.noteUrl,
              filename: result.filename,
              sha256: "1".repeat(64),
            },
            summary: {
              url: result.summaryUrl,
              filename: "Product sync — Summary.md",
              sha256: sha256(summaryMarkdown),
            },
            transcript: {
              url: result.transcriptUrl,
              filename: "Product sync — Transcript.md",
              sha256: sha256(`${transcriptMarkdown} corrupted`),
            },
          },
        },
      },
      upload: null,
    });
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await expect(service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal })).rejects.toEqual(
      expect.objectContaining({ code: "artifact_integrity_failed" }),
    );

    expect(app.vault.create).not.toHaveBeenCalled();
    expect(api.acknowledgeJob).not.toHaveBeenCalled();
  });

  it("uploads audio in bounded parts, polls, writes linked note and transcript files, and opens the note", async () => {
    const { app, plugin, created, transcriptCreated, leaf, ensureDirectoryByPath } = createPlugin();
    const api = createApi();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const audio = createAudioSource(bytes);
    const progress: string[] = [];
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    const completed = await service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event.stage),
    });

    expect(api.createAudioJob).toHaveBeenCalledWith(expect.objectContaining({
      filename: "product-sync.m4a",
      contentType: "audio/mp4",
      sizeBytes: 10,
    }), expect.stringMatching(/^audio-.+:create$/), expect.any(AbortSignal));
    expect(audio.readSlice).toHaveBeenCalledWith(0, 4);
    expect(audio.readSlice).toHaveBeenCalledWith(4, 8);
    expect(audio.readSlice).toHaveBeenCalledWith(8, 10);
    expect(api.uploadPart.mock.calls.map((call) => (call[1] as ArrayBuffer).byteLength))
      .toEqual([4, 4, 2]);
    expect(api.completeUpload).toHaveBeenCalledWith(
      "audio_job_123",
      [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
        { part_number: 3, etag: "etag-3" },
      ],
      expect.stringMatching(/^audio-.+:complete$/),
      expect.any(AbortSignal),
    );
    expect(ensureDirectoryByPath).toHaveBeenCalledWith("SystemSculpt/Audio Notes");
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      expect.stringContaining("[[SystemSculpt/Audio Notes/Product sync|Back to the audio note]]"),
    );
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync.md",
      expect.stringMatching(
        /systemsculpt-audio-artifact: full[\s\S]*\[\[SystemSculpt\/Audio Notes\/Product sync — Transcript\|Open the full timestamped transcript\]\][\s\S]*## Transcript/,
      ),
    );
    expect(api.downloadNote).toHaveBeenCalledWith(result.noteUrl, expect.any(AbortSignal));
    expect(api.downloadNote).not.toHaveBeenCalledWith(
      result.summaryUrl,
      expect.any(AbortSignal),
    );
    expect(app.vault.create).toHaveBeenCalledTimes(2);
    expect(app.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect((app.vault.create as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((app.vault.create as jest.Mock).mock.invocationCallOrder[1]);
    expect(leaf.openFile).toHaveBeenCalledWith(created);
    expect(leaf.openFile).not.toHaveBeenCalledWith(transcriptCreated);
    expect((app.workspace as any).setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    expect(completed.notePath).toBe("SystemSculpt/Audio Notes/Product sync.md");
    expect(completed.transcriptPath).toBe(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
    );
    expect(progress).toEqual(expect.arrayContaining([
      "preparing", "uploading", "queued", "transcribing", "saving",
    ]));
    expect(audio.release).toHaveBeenCalledTimes(1);
    expect(audio.release.mock.invocationCallOrder[0])
      .toBeLessThan(api.getJob.mock.invocationCallOrder[0]);
    expect(api.abortUpload).not.toHaveBeenCalled();
    expect(api.acknowledgeJob).toHaveBeenCalledWith(
      "audio_job_123",
      expect.stringMatching(/^audio-.+:acknowledge$/),
      expect.any(AbortSignal),
    );
    expect(api.acknowledgeJob.mock.invocationCallOrder[0])
      .toBeGreaterThan((app.vault.create as jest.Mock).mock.invocationCallOrder[1]);
  });

  it("retrieves a separate transcript from durable note provenance after restart", async () => {
    const { app, plugin, leaf, created, files, contents } = createPlugin();
    files.set(created.path, created);
    contents.set(created.path, fullNoteMarkdown());
    (app.metadataCache.getFileCache as jest.Mock).mockImplementation((file: TFile) => ({
      frontmatter: file === created
        ? {
            "systemsculpt-audio-job-id": "audio_job_123",
            "systemsculpt-audio-artifact": "full",
          }
        : undefined,
    }));
    const transcriptFile = new (TFile as any)({
      path: "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      name: "Product sync — Transcript.md",
      extension: "md",
      stat: { size: 120, ctime: 1, mtime: 1 },
    }) as TFile;
    (app.vault.create as jest.Mock).mockResolvedValue(transcriptFile);
    const api = createApi();
    api.getJob.mockReset().mockResolvedValue(job("succeeded", "complete", 1));
    api.downloadNote.mockResolvedValue(
      "---\nsystemsculpt-audio-job-id: audio_job_123\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n## Transcript\n\n**00:00** Hello.",
    );
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    const saved = await service.saveArtifactForJob(
      "audio_job_123",
      "audio_job_123",
      "transcript",
    );

    expect(api.getJob).toHaveBeenCalledWith("audio_job_123", expect.any(AbortSignal));
    expect(api.downloadNote).toHaveBeenCalledWith(
      result.transcriptUrl,
      expect.any(AbortSignal),
    );
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      expect.stringContaining("Back to the audio note"),
    );
    expect(saved.notePath).toBe(transcriptFile.path);

    await saved.open();
    expect(leaf.openFile).toHaveBeenCalledWith(transcriptFile);
  });

  it("aborts the multipart session and releases the source when an upload fails", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.uploadPart.mockRejectedValue(new Error("storage unavailable"));
    const audio = createAudioSource(new Uint8Array(10));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    })).rejects.toThrow("storage unavailable");

    expect(api.abortUpload).toHaveBeenCalledWith(
      "audio_job_123",
      expect.stringMatching(/^audio-.+:abort$/),
    );
    expect(audio.release).toHaveBeenCalledTimes(1);
  });

  it("stages a device source durably before upload and removes staging after server handoff", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const deviceAudio = createAudioSource(bytes, { resumable: false });
    const stagedAudio: AudioProcessorAudioSource = {
      ...createAudioSource(bytes, { resumable: false }),
      resumeDescriptor: {
        kind: "staged",
        stagingId: "a".repeat(64),
        manifestSha256: "b".repeat(64),
      },
    };
    const deviceStaging = {
      stage: jest.fn().mockResolvedValue(stagedAudio),
      open: jest.fn(),
      openForJob: jest.fn(),
      hasReadyForJob: jest.fn().mockResolvedValue(false),
      cleanupForJob: jest.fn().mockResolvedValue(undefined),
      cleanupDescriptor: jest.fn().mockResolvedValue(undefined),
      cleanupStale: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      deviceStaging,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio: deviceAudio }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(deviceStaging.stage).toHaveBeenCalledWith(
      "audio_job_123",
      deviceAudio,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(api.uploadPart).toHaveBeenCalledTimes(3);
    expect(deviceStaging.cleanupDescriptor).toHaveBeenCalledWith(
      stagedAudio.resumeDescriptor,
    );
    expect(deviceAudio.release).toHaveBeenCalledTimes(1);
    expect(stagedAudio.release).toHaveBeenCalledTimes(1);
  });

  it("removes partial device staging when preparation fails", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    const deviceAudio = createAudioSource(new Uint8Array(10), { resumable: false });
    const deviceStaging = {
      stage: jest.fn().mockRejectedValue(new Error("device storage unavailable")),
      open: jest.fn(),
      openForJob: jest.fn(),
      hasReadyForJob: jest.fn().mockResolvedValue(false),
      cleanupForJob: jest.fn().mockResolvedValue(undefined),
      cleanupDescriptor: jest.fn().mockResolvedValue(undefined),
      cleanupStale: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      deviceStaging,
    });

    await expect(service.process({ type: "audio", audio: deviceAudio }, {
      signal: new AbortController().signal,
    })).rejects.toThrow("device storage unavailable");

    expect(api.abortUpload).toHaveBeenCalledWith(
      "audio_job_123",
      expect.stringMatching(/^audio-.+:abort$/),
    );
    expect(deviceStaging.cleanupForJob).toHaveBeenCalledWith("audio_job_123");
    expect(deviceAudio.release).toHaveBeenCalledTimes(1);
  });

  it("refreshes a signed part URL and retries a transient multipart failure", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.uploadPart.mockRejectedValueOnce(new Error("temporary object-store failure"));
    const audio = createAudioSource(new Uint8Array(10));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(api.getPartUrl).toHaveBeenCalledTimes(4);
    expect(api.getPartUrl).toHaveBeenNthCalledWith(
      2,
      "audio_job_123",
      1,
      expect.any(AbortSignal),
    );
    expect(api.uploadPart).toHaveBeenCalledTimes(4);
    expect(api.abortUpload).not.toHaveBeenCalled();
  });

  it("resumes a persisted vault multipart upload from the first missing authoritative server part", async () => {
    const { plugin, settings, updateSettings } = createPlugin();
    settings.pendingAudioProcessorUploads = [{
      jobId: "audio_job_123",
      filename: "product-sync.m4a",
      contentType: "audio/mp4",
      sizeBytes: 10,
      source: { kind: "vault", filePath: "Meetings/product-sync.m4a", modifiedAt: 1 },
      partSizeBytes: 4,
      totalParts: 3,
      uploadedParts: [{ partNumber: 1, etag: "etag-1" }],
      updatedAt: 1,
    }];
    const api = createApi();
    api.getUploadParts.mockResolvedValue({
      objectCompleted: false,
      partSizeBytes: 4,
      totalParts: 3,
      parts: [
        { part_number: 1, etag: "etag-1", size_bytes: 4 },
        { part_number: 2, etag: "etag-2", size_bytes: 4 },
      ],
    });
    api.getJob.mockReset()
      .mockResolvedValueOnce(job("processing", "transcribing", 0.62))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    const recoveredSource = createAudioSource(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    jest.spyOn(service as any, "restoreUploadSource").mockReturnValue(recoveredSource);

    await expect(service.resumeUpload({ id: "audio_job_123" }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(api.getUploadParts).toHaveBeenCalledWith("audio_job_123", expect.any(AbortSignal));
    expect(recoveredSource.readSlice).toHaveBeenCalledTimes(1);
    expect(recoveredSource.readSlice).toHaveBeenCalledWith(8, 10);
    expect(api.completeUpload).toHaveBeenCalledWith(
      "audio_job_123",
      [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
        { part_number: 3, etag: "etag-3" },
      ],
      expect.stringMatching(/^audio-.+:complete$/),
      expect.any(AbortSignal),
    );
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      pendingAudioProcessorUploads: [],
    }));
    expect(recoveredSource.release).toHaveBeenCalledTimes(1);
  });

  it("falls back to the local upload checkpoint when server part reconciliation is unavailable", async () => {
    const { plugin, settings } = createPlugin();
    settings.pendingAudioProcessorUploads = [{
      jobId: "audio_job_123",
      filename: "product-sync.m4a",
      contentType: "audio/mp4",
      sizeBytes: 10,
      source: { kind: "vault", filePath: "Meetings/product-sync.m4a", modifiedAt: 1 },
      partSizeBytes: 4,
      totalParts: 3,
      uploadedParts: [{ partNumber: 1, etag: "etag-1" }],
      updatedAt: 1,
    }];
    const api = createApi();
    api.getUploadParts.mockRejectedValue(new Error("reconciliation unavailable"));
    api.getJob.mockReset()
      .mockResolvedValueOnce(job("processing", "transcribing", 0.62))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    const recoveredSource = createAudioSource(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    jest.spyOn(service as any, "restoreUploadSource").mockReturnValue(recoveredSource);

    await expect(service.resumeUpload({ id: "audio_job_123" }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(recoveredSource.readSlice).toHaveBeenCalledTimes(2);
    expect(recoveredSource.readSlice).toHaveBeenNthCalledWith(1, 4, 8);
    expect(recoveredSource.readSlice).toHaveBeenNthCalledWith(2, 8, 10);
    expect(api.completeUpload).toHaveBeenCalledWith(
      "audio_job_123",
      [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
        { part_number: 3, etag: "etag-3" },
      ],
      expect.stringMatching(/^audio-.+:complete$/),
      expect.any(AbortSignal),
    );
  });

  it("finalizes an authoritative completed upload without reopening the local source", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.getUploadParts.mockResolvedValue({
      objectCompleted: true,
      partSizeBytes: 4,
      totalParts: 3,
      parts: [
        { part_number: 1, etag: "etag-1", size_bytes: 4 },
        { part_number: 2, etag: "etag-2", size_bytes: 4 },
        { part_number: 3, etag: "etag-3", size_bytes: 2 },
      ],
    });
    api.getJob.mockReset()
      .mockResolvedValueOnce(job("processing", "transcribing", 0.62))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const restoreSpy = jest.spyOn(service as any, "restoreUploadSource");

    await expect(service.resumeUpload({ id: "audio_job_123" }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(api.getPartUrl).not.toHaveBeenCalled();
    expect(api.uploadPart).not.toHaveBeenCalled();
    expect(api.completeUpload).toHaveBeenCalledWith(
      "audio_job_123",
      [
        { part_number: 1, etag: "etag-1" },
        { part_number: 2, etag: "etag-2" },
        { part_number: 3, etag: "etag-3" },
      ],
      expect.stringMatching(/^audio-.+:complete$/),
      expect.any(AbortSignal),
    );
  });

  it("recovers server state when the upload-completion response is lost", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.completeUpload.mockRejectedValueOnce(new Error("connection lost after request"));
    api.getJob.mockReset()
      .mockResolvedValueOnce(job("processing", "transcribing", 0.62))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    const audio = createAudioSource(new Uint8Array(10));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(api.completeUpload).toHaveBeenCalledTimes(1);
    expect(api.getJob).toHaveBeenCalledTimes(2);
    expect(api.abortUpload).not.toHaveBeenCalled();
    expect(audio.release).toHaveBeenCalledTimes(1);
  });

  it("replays upload completion with the same idempotency key only while the job is still uploading", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.completeUpload
      .mockRejectedValueOnce(new Error("temporary completion failure"))
      .mockResolvedValueOnce(job("queued", "queued", 0.36));
    api.getJob.mockReset()
      .mockResolvedValueOnce(job("uploading", "uploading", 0.35))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    const audio = createAudioSource(new Uint8Array(10));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(api.completeUpload).toHaveBeenCalledTimes(2);
    expect(api.completeUpload.mock.calls[0][2]).toBe(api.completeUpload.mock.calls[1][2]);
    expect(api.abortUpload).not.toHaveBeenCalled();
    expect(audio.release).toHaveBeenCalledTimes(1);
  });

  it("exposes interrupted-upload cleanup for startup recovery", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    const deviceStaging = {
      stage: jest.fn(),
      open: jest.fn(),
      openForJob: jest.fn(),
      hasReadyForJob: jest.fn().mockResolvedValue(true),
      cleanupForJob: jest.fn().mockResolvedValue(undefined),
      cleanupDescriptor: jest.fn().mockResolvedValue(undefined),
      cleanupStale: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      deviceStaging,
    });
    const signal = new AbortController().signal;

    await service.abortInterruptedUpload({
      id: "audio_job_uploading",
      updatedAt: "2026-07-18T11:15:00.000Z",
    }, signal);

    expect(api.abortUpload).toHaveBeenCalledWith(
      "audio_job_uploading",
      expect.stringMatching(/^audio-.+:abort$/),
      {
        signal,
        ifUnchangedSince: "2026-07-18T11:15:00.000Z",
      },
    );
    expect(deviceStaging.cleanupForJob).toHaveBeenCalledWith("audio_job_uploading");
  });

  it("canonicalizes YouTube input before creating the server job", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.createYouTubeJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ?si=share",
    }, { signal: new AbortController().signal });

    expect(api.createYouTubeJob).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      expect.stringMatching(/^audio-.+:create$/),
      expect.any(AbortSignal),
    );
    expect(api.getPartUrl).not.toHaveBeenCalled();
  });

  it("resumes a completed job without downloading or duplicating an already-delivered pair", async () => {
    const { app, plugin, created, transcriptCreated, files, contents } = createPlugin();
    const api = createApi();
    files.set(created.path, created);
    files.set(transcriptCreated.path, transcriptCreated);
    contents.set(created.path,
      fullNoteMarkdown());
    contents.set(transcriptCreated.path,
      "---\nsystemsculpt-audio-job-id: audio_job_123\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.");
    (app.metadataCache.getFileCache as jest.Mock).mockImplementation((file: TFile) => ({
      frontmatter: {
        "systemsculpt-audio-job-id": "audio_job_123",
        "systemsculpt-audio-artifact": file === created ? "full" : "transcript",
      },
    }));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    const completed = await service.resume(job("succeeded", "complete", 1), {
      signal: new AbortController().signal,
    });

    expect(completed.notePath).toBe(created.path);
    expect(completed.transcriptPath).toBe(transcriptCreated.path);
    expect(api.downloadNote).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(api.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it("refreshes only the delivery alias marker when the delivered pair already exists", async () => {
    const { app, plugin, created, transcriptCreated, files, contents } = createPlugin();
    const api = createApi();
    files.set(created.path, created);
    files.set(transcriptCreated.path, transcriptCreated);
    contents.set(created.path,
      "---\nsystemsculpt-audio-delivery-job-id: audio_job_old\nsystemsculpt-audio-job-id: audio_job_123\nsystemsculpt-audio-artifact: full\n---\n\n# Product sync\n\n## Summary\nDone.\n\n## Transcript\n\n**00:00** Speaker 1: Hello.");
    contents.set(transcriptCreated.path,
      "---\nsystemsculpt-audio-delivery-job-id: audio_job_old\nsystemsculpt-audio-job-id: audio_job_123\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.");
    (app.metadataCache.getFileCache as jest.Mock).mockImplementation((file: TFile) => ({
      frontmatter: {
        "systemsculpt-audio-job-id": "audio_job_123",
        "systemsculpt-audio-artifact": file === created ? "full" : "transcript",
      },
    }));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await service.resume(job("succeeded", "complete", 1), {
      signal: new AbortController().signal,
    });

    expect(api.downloadNote).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.modify).toHaveBeenCalledTimes(2);
    expect(contents.get(created.path)).toContain(
      "systemsculpt-audio-delivery-job-id: audio_job_123",
    );
    expect(contents.get(transcriptCreated.path)).toContain(
      "systemsculpt-audio-delivery-job-id: audio_job_123",
    );
  });

  it("recognizes a delivered pair after the user moves it elsewhere in the vault", async () => {
    const { app, plugin } = createPlugin();
    const moved = new (TFile as any)({
      path: "Clients/Acme/Product sync.md",
      name: "Product sync.md",
      extension: "md",
      stat: { size: 120, ctime: 1, mtime: 1 },
    }) as TFile;
    const movedTranscript = new (TFile as any)({
      path: "Clients/Acme/Product sync — Transcript.md",
      name: "Product sync — Transcript.md",
      extension: "md",
      stat: { size: 200, ctime: 1, mtime: 1 },
    }) as TFile;
    (app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([moved, movedTranscript]);
    (app.metadataCache as any).getFileCache = jest.fn().mockImplementation((file: TFile) => ({
      frontmatter: {
        "systemsculpt-audio-job-id": "audio_job_123",
        "systemsculpt-audio-artifact": file === moved ? "full" : "transcript",
      },
    }));
    const api = createApi();
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await expect(service.resume(job("succeeded", "complete", 1), {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ notePath: moved.path }));

    expect(app.vault.read).toHaveBeenCalledTimes(2);
    expect(api.downloadNote).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("redownloads only the missing paired file and advances the surviving alias on cache delivery", async () => {
    const { app, plugin, transcriptCreated, files, contents } = createPlugin();
    const api = createApi();
    const deliveryJobId = "audio_job_cached_delivery";
    const artifactJobId = "audio_job_cached_owner";
    const transcriptPath = "SystemSculpt/Audio Notes/Product sync — Transcript.md";
    files.set(transcriptPath, transcriptCreated);
    contents.set(transcriptPath,
      `---\nsystemsculpt-audio-delivery-job-id: audio_job_old\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.`);
    (app.metadataCache.getFileCache as jest.Mock).mockImplementation((file: TFile) => ({
      frontmatter: {
        "systemsculpt-audio-job-id": artifactJobId,
        "systemsculpt-audio-artifact": file.path.endsWith("Transcript.md") ? "transcript" : "full",
      },
    }));
    api.downloadNote.mockImplementation(async (url: string) => url.includes("transcript")
      ? transcriptMarkdown(artifactJobId)
      : fullNoteMarkdown(artifactJobId));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await expect(service.resume({
      ...job("succeeded", "complete", 1),
      id: deliveryJobId,
      result: { ...result, artifactJobId },
    }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({
      notePath: "SystemSculpt/Audio Notes/Product sync.md",
      transcriptPath,
    }));

    expect(api.downloadNote).toHaveBeenCalledTimes(1);
    expect(api.downloadNote).toHaveBeenCalledWith(
      result.noteUrl,
      expect.any(AbortSignal),
    );
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect(contents.get(transcriptPath)).toContain(
      `systemsculpt-audio-delivery-job-id: ${deliveryJobId}`,
    );
  });

  it("finishes an audio cache hit without requesting upload parts", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    api.createAudioJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    const audio = createAudioSource(new Uint8Array([1, 2, 3]));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    });

    expect(api.getPartUrl).not.toHaveBeenCalled();
    expect(api.completeUpload).not.toHaveBeenCalled();
    expect(api.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it("accepts an audio cache alias while validating the original artifact marker", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    const originalArtifactJobId = "audio_job_original";
    api.completeUpload.mockResolvedValue({
      ...job("succeeded", "complete", 1),
      result: { ...result, artifactJobId: originalArtifactJobId },
    });
    api.downloadNote.mockImplementation(async (url: string) => url.includes("transcript")
      ? transcriptMarkdown(originalArtifactJobId)
      : fullNoteMarkdown(originalArtifactJobId));
    const audio = createAudioSource(new Uint8Array(10));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      sleep: async () => undefined,
    });

    await expect(service.process({ type: "audio", audio }, {
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({ jobId: "audio_job_123" }));

    expect(api.getJob).not.toHaveBeenCalled();
    expect(api.acknowledgeJob).toHaveBeenCalledWith(
      "audio_job_123",
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("keeps the durable note successful when acknowledgement must retry on startup", async () => {
    const { plugin, warn } = createPlugin();
    const api = createApi();
    api.createYouTubeJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    api.acknowledgeJob.mockRejectedValueOnce(new Error("network unavailable"));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await expect(service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal })).resolves.toEqual(
      expect.objectContaining({ notePath: "SystemSculpt/Audio Notes/Product sync.md" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Audio job acknowledgement deferred",
      expect.objectContaining({ source: "AudioProcessorService" }),
    );
  });

  it("does not acknowledge a partial local delivery and repairs only the missing note on resume", async () => {
    const { app, plugin, files } = createPlugin();
    const create = app.vault.create as jest.Mock;
    const createArtifact = create.getMockImplementation()!;
    let failPrimaryCreate = true;
    create.mockImplementation(async (path: string, markdown: string) => {
      if (path.endsWith("/Product sync.md") && failPrimaryCreate) {
        failPrimaryCreate = false;
        throw new Error("vault write interrupted");
      }
      return await createArtifact(path, markdown);
    });
    const api = createApi();
    api.createYouTubeJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await expect(service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal })).rejects.toThrow("vault write interrupted");

    const transcriptPath = "SystemSculpt/Audio Notes/Product sync — Transcript.md";
    expect(files.has(transcriptPath)).toBe(true);
    expect(files.has("SystemSculpt/Audio Notes/Product sync.md")).toBe(false);
    expect(api.acknowledgeJob).not.toHaveBeenCalled();

    const completed = await service.resume(job("succeeded", "complete", 1), {
      signal: new AbortController().signal,
    });

    expect(completed.notePath).toBe("SystemSculpt/Audio Notes/Product sync.md");
    expect(completed.transcriptPath).toBe(transcriptPath);
    expect(api.downloadNote.mock.calls.filter(([url]) => String(url).includes("transcript")))
      .toHaveLength(1);
    expect(create.mock.calls.filter(([path]) => path === transcriptPath)).toHaveLength(1);
    expect(api.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it("persists an hours-scale transcript as one server-rendered artifact without transforming it", async () => {
    const { app, plugin } = createPlugin();
    const api = createApi();
    api.createYouTubeJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    const longTail = "word ".repeat(260_000);
    const transcript = [
      "---",
      "systemsculpt-audio-job-id: audio_job_123",
      "systemsculpt-audio-artifact: transcript",
      "---",
      "",
      "# Product sync — Transcript",
      "",
      `**7:59:59 · Speaker 1**  ${longTail}`,
    ].join("\n");
    api.downloadNote.mockImplementation(async (url: string) => url.includes("transcript")
      ? transcript
      : fullNoteMarkdown());
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal });

    const transcriptCreate = (app.vault.create as jest.Mock).mock.calls.find(
      ([path]) => String(path).endsWith(" — Transcript.md"),
    );
    expect(transcriptCreate).toBeDefined();
    expect((transcriptCreate?.[1] as string).length).toBeGreaterThan(1_250_000);
    expect(transcriptCreate?.[1]).toContain(longTail.slice(-2_000));
    expect(api.acknowledgeJob).toHaveBeenCalledTimes(1);
  });

  it("persists the combined note and transcript automatically, then caches a separate summary", async () => {
    const { app, plugin, transcriptCreated } = createPlugin();
    const api = createApi();
    api.createYouTubeJob.mockResolvedValue({
      job: job("succeeded", "complete", 1),
      upload: null,
    });
    api.getJob.mockReset().mockResolvedValue(job("succeeded", "complete", 1));
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    const completed = await service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal });
    expect(app.vault.create).toHaveBeenCalledTimes(2);

    await expect(completed.saveArtifact("summary")).resolves.toEqual(expect.objectContaining({
      notePath: "SystemSculpt/Audio Notes/Product sync — Summary.md",
    }));
    await expect(completed.saveArtifact("transcript")).resolves.toEqual(
      expect.objectContaining({ notePath: transcriptCreated.path }),
    );
    await expect(completed.saveArtifact("summary")).resolves.toEqual(expect.objectContaining({
      notePath: "SystemSculpt/Audio Notes/Product sync — Summary.md",
    }));

    expect(api.getJob).toHaveBeenCalledTimes(1);
    expect(api.downloadNote).toHaveBeenCalledTimes(3);
    expect(api.downloadNote).toHaveBeenCalledWith(result.noteUrl, expect.any(AbortSignal));
    expect(api.downloadNote).toHaveBeenCalledWith(result.summaryUrl, expect.any(AbortSignal));
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync — Summary.md",
      expect.stringMatching(
        /systemsculpt-audio-artifact: summary[\s\S]*\[\[SystemSculpt\/Audio Notes\/Product sync — Transcript\|Open the full timestamped transcript\]\]/,
      ),
    );
    expect(app.vault.create).toHaveBeenCalledTimes(3);
  });

  it("polls an awaiting-funds job read-only with exponential backoff until the server requeues it", async () => {
    const { plugin } = createPlugin();
    const api = createApi();
    const awaitingFunds: AudioProcessorJob = {
      ...job("awaiting_funds", "awaiting_funds", 0.4),
      quotedCredits: 3_850,
      chargedCredits: 1_100,
      resumeRequired: true,
      error: "Add credits to continue.",
    };
    api.createYouTubeJob.mockResolvedValue({ job: awaitingFunds, upload: null });
    api.getJob.mockReset()
      .mockResolvedValueOnce(awaitingFunds)
      .mockResolvedValueOnce(awaitingFunds)
      .mockResolvedValueOnce(job("queued", "queued", 0.4))
      .mockResolvedValueOnce(job("succeeded", "complete", 1));
    let now = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = jest.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const progress: AudioProcessorJob["stage"][] = [];
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
      pollIntervalMs: 2_000,
      resumeAttemptIntervalMs: 5_000,
      sleep,
    });

    await expect(service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, {
      signal: new AbortController().signal,
      onProgress: (event) => {
        if (event.stage !== "preparing" && event.stage !== "saving") progress.push(event.stage);
      },
    })).resolves.toEqual(expect.objectContaining({ summaryAvailable: true }));

    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      5_000, 10_000, 20_000, 2_000,
    ]);
    expect(api.resumeJob).not.toHaveBeenCalled();
    expect(progress).toContain("awaiting_funds");
    nowSpy.mockRestore();
  });

  it("saves and acknowledges a failed job's durable transcript without creating a fake summary", async () => {
    const { app, plugin, leaf } = createPlugin();
    const api = createApi();
    const recoveryTranscript =
      "---\nsystemsculpt-audio-job-id: audio_job_owner\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.";
    const failedWithTranscript: AudioProcessorJob = {
      ...job("failed", "complete", 1),
      chargedCredits: 1_100,
      error: "The summary could not be produced.",
      transcriptArtifact: {
        artifactJobId: "audio_job_owner",
        transcriptUrl: "https://objects.example.com/recovery-transcript",
        urlExpiresInSeconds: 900,
        filename: "Product sync — Transcript.md",
        sha256: sha256(recoveryTranscript),
      },
    };
    api.createYouTubeJob.mockResolvedValue({ job: failedWithTranscript, upload: null });
    api.downloadNote.mockResolvedValue(recoveryTranscript);
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    const completed = await service.process({
      type: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    }, { signal: new AbortController().signal });

    expect(completed.summaryAvailable).toBe(false);
    expect(completed.notePath).toBe(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
    );
    expect(completed.transcriptPath).toBe(completed.notePath);
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      expect.stringContaining("systemsculpt-audio-delivery-job-id: audio_job_123"),
    );
    expect((app.vault.create as jest.Mock).mock.calls[0][1]).not.toContain(
      "Back to the audio note",
    );
    expect(api.acknowledgeJob).toHaveBeenCalledWith(
      "audio_job_123",
      expect.stringMatching(/^audio-.+:acknowledge$/),
      expect.any(AbortSignal),
    );
    expect(leaf.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: completed.transcriptPath }),
    );
    await expect(completed.saveArtifact("summary")).rejects.toEqual(
      expect.objectContaining({ code: "summary_unavailable" }),
    );
  });

  it("refreshes a cached artifact through its authenticated delivery alias", async () => {
    const { app, plugin } = createPlugin();
    const api = createApi();
    const deliveryJobId = "audio_job_authenticated_alias";
    const artifactJobId = "audio_job_physical_owner";
    api.getJob.mockReset().mockResolvedValue({
      ...job("succeeded", "complete", 1),
      id: deliveryJobId,
      result: { ...result, artifactJobId },
    });
    api.downloadNote.mockResolvedValue(
      `---\nsystemsculpt-audio-job-id: ${artifactJobId}\nsystemsculpt-audio-artifact: transcript\n---\n\n# Product sync — Transcript\n\n**00:00** Speaker 1: Hello.`,
    );
    const service = new AudioProcessorService(plugin, {
      apiClient: api as unknown as AudioProcessorApiClient,
    });

    await service.saveArtifactForJob(deliveryJobId, artifactJobId, "transcript");

    expect(api.getJob).toHaveBeenCalledWith(deliveryJobId, expect.any(AbortSignal));
    expect(api.getJob).not.toHaveBeenCalledWith(artifactJobId, expect.anything());
    expect(app.vault.create).toHaveBeenCalledWith(
      "SystemSculpt/Audio Notes/Product sync — Transcript.md",
      expect.stringContaining(`systemsculpt-audio-delivery-job-id: ${deliveryJobId}`),
    );
  });
});
