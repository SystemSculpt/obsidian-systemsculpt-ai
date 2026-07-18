import {
  PlatformRequestClient,
  type PlatformRequestInput,
} from "../../../services/PlatformRequestClient";
import {
  AudioProcessorApiClient,
  AudioProcessorApiError,
} from "../AudioProcessorApiClient";

class QueueClient extends PlatformRequestClient {
  readonly inputs: PlatformRequestInput[] = [];
  readonly responses: Response[] = [];

  override async request(input: PlatformRequestInput): Promise<Response> {
    this.inputs.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing queued response.");
    return response;
  }
}

const pendingJob = {
  id: "audio_job_123",
  status: "uploading",
  stage: "uploading",
  progress: 0,
  updated_at: "2026-07-18T11:00:00.000Z",
  error: null,
  quoted_credits: null,
  charged_credits: 0,
  resume_required: false,
};

const succeededJob = {
  id: "audio_job_123",
  status: "succeeded",
  stage: "complete",
  progress: 1,
  updated_at: "2026-07-18T11:45:00.000Z",
  error: null,
  quoted_credits: 850,
  charged_credits: 850,
  resume_required: false,
};

const succeededResult = {
  artifact_job_id: "audio_job_123",
  note_url: "https://objects.example.com/note?signature=one",
  summary_url: "https://objects.example.com/summary?signature=two",
  transcript_url: "https://objects.example.com/transcript?signature=three",
  url_expires_in_seconds: 900,
  filename: "Weekly planning.md",
};

const artifactManifest = {
  version: "audio_processor_artifacts.v1",
  note: {
    url: succeededResult.note_url,
    filename: succeededResult.filename,
    sha256: "1".repeat(64),
  },
  summary: {
    url: succeededResult.summary_url,
    filename: "Weekly planning — Summary.md",
    sha256: "2".repeat(64),
  },
  transcript: {
    url: succeededResult.transcript_url,
    filename: "Weekly planning — Transcript.md",
    sha256: "3".repeat(64),
  },
};

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("AudioProcessorApiClient", () => {
  const setup = () => {
    const requestClient = new QueueClient();
    const client = new AudioProcessorApiClient({
      baseUrl: "https://systemsculpt.test/api/plugin/",
      pluginVersion: "6.1.0",
      licenseKey: () => "license-123",
      requestClient,
    });
    return { client, requestClient };
  };

  it("creates an audio job with the exact source contract and upload plan", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      job: pendingJob,
      upload: { part_size_bytes: 8_388_608, total_parts: 3 },
    }));

    await expect(client.createAudioJob({
      filename: "all-hands.m4a",
      contentType: "audio/mp4",
      sizeBytes: 20_000_000,
    }, "audio-op:create")).resolves.toEqual({
      job: expect.objectContaining({ id: "audio_job_123", status: "uploading" }),
      upload: { partSizeBytes: 8_388_608, totalParts: 3 },
    });

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs",
      method: "POST",
      licenseKey: "license-123",
      allowTransportFallback: false,
      headers: expect.objectContaining({
        "x-license-key": "license-123",
        "x-plugin-version": "6.1.0",
        "Idempotency-Key": "audio-op:create",
      }),
      body: {
        source: {
          type: "audio",
          filename: "all-hands.m4a",
          content_type: "audio/mp4",
          size_bytes: 20_000_000,
        },
      },
    }));
  });

  it("uses raw requestUrl transport for signed multipart uploads and preserves the ETag", async () => {
    const { client, requestClient } = setup();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    requestClient.responses.push(new Response("", {
      status: 200,
      headers: { ETag: "\"part-etag\"" },
    }));

    await expect(client.uploadPart({
      partNumber: 2,
      url: "https://objects.example.com/upload?signature=exact",
      headers: { "x-amz-checksum-sha256": "checksum" },
      expiresInSeconds: 900,
    }, bytes)).resolves.toEqual({ part_number: 2, etag: "\"part-etag\"" });

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      method: "PUT",
      body: bytes,
      bodyEncoding: "raw",
      transport: "requestUrl",
      preserveResponseHeaders: true,
      allowTransportFallback: false,
      headers: { "x-amz-checksum-sha256": "checksum" },
    }));
    expect(requestClient.inputs[0].licenseKey).toBeUndefined();
  });

  it("parses the terminal note contract and downloads only from a public HTTPS URL", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({ job: succeededJob, result: succeededResult }));
    requestClient.responses.push(new Response("# Weekly planning\n\n## Summary\nDone.\n\n## Transcript\nHello."));

    const job = await client.getJob("audio_job_123");
    expect(job.result).toEqual({
      artifactJobId: "audio_job_123",
      noteUrl: "https://objects.example.com/note?signature=one",
      summaryUrl: "https://objects.example.com/summary?signature=two",
      transcriptUrl: "https://objects.example.com/transcript?signature=three",
      urlExpiresInSeconds: 900,
      filename: "Weekly planning.md",
      artifactManifest: null,
    });
    await expect(client.downloadNote(job.result!.noteUrl)).resolves.toContain("## Transcript");
    expect(requestClient.inputs[1]).toEqual(expect.objectContaining({
      url: succeededResult.note_url,
      method: "GET",
      bodyEncoding: "raw",
      transport: "requestUrl",
    }));
  });

  it("rejects malformed plans and private signed URLs before upload", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      part_number: 1,
      url: "https://localhost/private-upload",
      headers: {},
      expires_in_seconds: 900,
    }));

    await expect(client.getPartUrl("audio_job_123", 1)).rejects.toEqual(
      expect.objectContaining<Partial<AudioProcessorApiError>>({
        code: "malformed_response",
      }),
    );
    expect(requestClient.inputs).toHaveLength(1);
  });

  it("surfaces server error codes without losing the user-facing message", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      error: { code: "insufficient_credits", message: "Add credits to process this recording." },
    }, 402));

    await expect(client.createYouTubeJob(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "audio-op:create",
    )).rejects.toEqual(expect.objectContaining({
      status: 402,
      code: "insufficient_credits",
      message: "Add credits to process this recording.",
    }));
  });

  it("surfaces the website's flat error-string response shape", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      error: "Choose a public YouTube video.",
      code: "invalid_source",
    }, 400));

    await expect(client.createYouTubeJob(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "audio-op:create",
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: "invalid_source",
      message: "Choose a public YouTube video.",
    }));
  });

  it("lists resumable jobs and acknowledges a durable note through the documented routes", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      jobs: [
        { job: pendingJob, result: null },
        { job: succeededJob, result: succeededResult },
      ],
    }));
    requestClient.responses.push(json({ acknowledged: true }));

    await expect(client.getActiveJobs()).resolves.toEqual([
      expect.objectContaining({ id: "audio_job_123", status: "uploading", result: null }),
      expect.objectContaining({ id: "audio_job_123", status: "succeeded", result: expect.any(Object) }),
    ]);
    await client.acknowledgeJob("audio_job_123", "audio-op:acknowledge");

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs?active=true",
      method: "GET",
    }));
    expect(requestClient.inputs[1]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs/audio_job_123/acknowledge",
      method: "POST",
      body: {},
      headers: expect.objectContaining({
        "Idempotency-Key": "audio-op:acknowledge",
      }),
    }));
  });

  it("reads authoritative multipart state from the documented upload-parts route", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      object_completed: true,
      part_size_bytes: 8_388_608,
      total_parts: 3,
      parts: [
        { part_number: 2, etag: "\"etag-2\"", size_bytes: 8_388_608 },
        { part_number: 1, etag: "\"etag-1\"", size_bytes: 8_388_608 },
        { part_number: 3, etag: "\"etag-3\"", size_bytes: 1_024 },
      ],
    }));

    await expect(client.getUploadParts("audio_job_123")).resolves.toEqual({
      objectCompleted: true,
      partSizeBytes: 8_388_608,
      totalParts: 3,
      parts: [
        { part_number: 1, etag: "\"etag-1\"", size_bytes: 8_388_608 },
        { part_number: 2, etag: "\"etag-2\"", size_bytes: 8_388_608 },
        { part_number: 3, etag: "\"etag-3\"", size_bytes: 1_024 },
      ],
    });

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs/audio_job_123/upload/parts",
      method: "GET",
    }));
  });

  it("parses an awaiting-funds quote and resumes it through the idempotent resume route", async () => {
    const { client, requestClient } = setup();
    const awaitingFunds = {
      ...pendingJob,
      status: "awaiting_funds",
      stage: "awaiting_funds",
      progress: 0.4,
      quoted_credits: 3_850,
      charged_credits: 1_100,
      resume_required: true,
      error: { code: "insufficient_credits", message: "Add credits to continue." },
    };
    requestClient.responses.push(json({ job: awaitingFunds, result: null }));
    requestClient.responses.push(json({
      job: { ...pendingJob, status: "queued", stage: "queued", progress: 0.4 },
      result: null,
    }, 202));

    await expect(client.getJob("audio_job_123")).resolves.toEqual(
      expect.objectContaining({
        status: "awaiting_funds",
        stage: "awaiting_funds",
        quotedCredits: 3_850,
        chargedCredits: 1_100,
        resumeRequired: true,
      }),
    );
    await expect(client.resumeJob("audio_job_123", "audio-op:resume")).resolves.toEqual(
      expect.objectContaining({ status: "queued", resumeRequired: false }),
    );

    expect(requestClient.inputs[1]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs/audio_job_123/resume",
      method: "POST",
      body: {},
      headers: expect.objectContaining({ "Idempotency-Key": "audio-op:resume" }),
    }));
  });

  it("accepts a durable recovery transcript on a charged failed summary job", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      job: {
        ...succeededJob,
        status: "failed",
        error: { code: "processing_failed", message: "The summary could not be produced." },
        charged_credits: 1_100,
      },
      result: null,
      transcript_artifact: {
        artifact_job_id: "audio_job_owner",
        transcript_url: "https://objects.example.com/transcript?signature=recovery",
        url_expires_in_seconds: 900,
        filename: "Product sync — Transcript.md",
        sha256: "a".repeat(64),
      },
    }));

    await expect(client.getJob("audio_job_123")).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        result: null,
        transcriptArtifact: {
          artifactJobId: "audio_job_owner",
          transcriptUrl: "https://objects.example.com/transcript?signature=recovery",
          urlExpiresInSeconds: 900,
          filename: "Product sync — Transcript.md",
          sha256: "a".repeat(64),
        },
      }),
    );
  });

  it("accepts a charged transcript while summary processing continues", async () => {
    const { client, requestClient } = setup();
    const transcriptArtifact = {
      delivery_job_id: "audio_job_123",
      artifact_job_id: "audio_job_owner",
      transcript_url: "https://objects.example.com/transcript?signature=active",
      url_expires_in_seconds: 900,
      filename: "Product sync — Transcript.md",
      sha256: "a".repeat(64),
    };
    requestClient.responses.push(json({
      job: {
        ...pendingJob,
        status: "processing",
        stage: "summarizing",
        progress: 0.82,
        quoted_credits: 2_500,
        charged_credits: 1_100,
      },
      result: null,
      transcript_artifact: transcriptArtifact,
    }));
    requestClient.responses.push(json({
      job: {
        ...pendingJob,
        status: "queued",
        stage: "queued",
        progress: 0.82,
        quoted_credits: 2_500,
        charged_credits: 1_100,
      },
      result: null,
      transcript_artifact: transcriptArtifact,
    }));

    await expect(client.getJob("audio_job_123")).resolves.toEqual(
      expect.objectContaining({
        status: "processing",
        stage: "summarizing",
        transcriptArtifact: expect.objectContaining({
          artifactJobId: "audio_job_owner",
          sha256: "a".repeat(64),
        }),
      }),
    );
    await expect(client.getJob("audio_job_123")).resolves.toEqual(
      expect.objectContaining({
        status: "queued",
        stage: "queued",
        transcriptArtifact: expect.objectContaining({ artifactJobId: "audio_job_owner" }),
      }),
    );
  });

  it("rejects a transcript artifact when the job has not settled any charge", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      job: {
        ...pendingJob,
        status: "awaiting_funds",
        stage: "awaiting_funds",
        progress: 0.4,
        quoted_credits: 2_500,
        resume_required: true,
      },
      result: null,
      transcript_artifact: {
        artifact_job_id: "audio_job_owner",
        transcript_url: "https://objects.example.com/transcript?signature=unpaid",
        url_expires_in_seconds: 900,
        filename: "Product sync — Transcript.md",
        sha256: "a".repeat(64),
      },
    }));

    await expect(client.getJob("audio_job_123")).rejects.toEqual(
      expect.objectContaining({ code: "malformed_response" }),
    );
  });

  it("parses the versioned artifact manifest and rejects flat-contract drift", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      job: succeededJob,
      result: {
        ...succeededResult,
        sha256: artifactManifest.note.sha256,
        artifact_manifest: artifactManifest,
      },
    }));
    requestClient.responses.push(json({
      job: succeededJob,
      result: {
        ...succeededResult,
        artifact_manifest: {
          ...artifactManifest,
          transcript: {
            ...artifactManifest.transcript,
            url: "https://objects.example.com/a-different-transcript",
          },
        },
      },
    }));
    requestClient.responses.push(json({
      job: succeededJob,
      result: { ...succeededResult, artifact_manifest: null },
    }));

    await expect(client.getJob("audio_job_123")).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          artifactManifest: {
            version: "audio_processor_artifacts.v1",
            note: expect.objectContaining({ sha256: "1".repeat(64) }),
            summary: expect.objectContaining({ sha256: "2".repeat(64) }),
            transcript: expect.objectContaining({ sha256: "3".repeat(64) }),
          },
        }),
      }),
    );
    await expect(client.getJob("audio_job_123")).rejects.toEqual(
      expect.objectContaining({ code: "malformed_response" }),
    );
    await expect(client.getJob("audio_job_123")).rejects.toEqual(
      expect.objectContaining({ code: "malformed_response" }),
    );
  });

  it("sends conditional abort state when cleaning up an interrupted upload", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({ job: pendingJob }));

    await client.abortUpload("audio_job_123", "audio-op:abort", {
      ifUnchangedSince: pendingJob.updated_at,
    });

    expect(requestClient.inputs[0]).toEqual(expect.objectContaining({
      url: "https://systemsculpt.test/api/plugin/audio-processor/jobs/audio_job_123/upload/abort",
      method: "POST",
      body: { if_unchanged_since: pendingJob.updated_at },
    }));
  });

  it("accepts a completed audio cache hit without an upload plan", async () => {
    const { client, requestClient } = setup();
    requestClient.responses.push(json({
      job: succeededJob,
      result: succeededResult,
      upload: null,
    }));

    await expect(client.createAudioJob({
      filename: "cached.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 100,
    }, "audio-cache:create")).resolves.toEqual(expect.objectContaining({
      job: expect.objectContaining({ status: "succeeded" }),
      upload: null,
    }));
  });
});
