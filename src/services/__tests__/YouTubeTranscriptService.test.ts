import {
  YouTubeTranscriptService,
  describeYouTubeTranscriptError,
} from "../YouTubeTranscriptService";
import { ManagedProductIntegrationError } from "../managed/ManagedProductIntegrationClient";

describe("YouTubeTranscriptService", () => {
  const testUrl = "https://www.youtube.com/watch?v=nDLb8_wgX50&feature=share";

  function harness() {
    const startYouTubeTranscript = jest.fn();
    const getYouTubeTranscriptStatus = jest.fn();
    const plugin = {
      getManagedProductIntegrationClient: () => ({
        startYouTubeTranscript,
        getYouTubeTranscriptStatus,
      }),
    } as any;
    const service = YouTubeTranscriptService.getInstance(plugin);
    return { service, startYouTubeTranscript, getYouTubeTranscriptStatus };
  }

  beforeEach(() => {
    (YouTubeTranscriptService as any).instance = undefined;
  });

  it("defers URL canonicalization to the managed client's post-admission preparation callback", async () => {
    const { service, startYouTubeTranscript } = harness();
    startYouTubeTranscript.mockImplementation(async ({ prepare }: { prepare: () => unknown }) => {
      expect(prepare()).toEqual({
        url: "https://www.youtube.com/watch?v=nDLb8_wgX50",
        lang: "en",
      });
      return {
        status: "synchronous",
        text: "hello",
        lang: "en",
        metadata: { videoId: "nDLb8_wgX50", availableLangs: ["en"] },
      };
    });

    const result = await service.getTranscript(testUrl, { lang: "en" });

    expect(result).toEqual({
      text: "hello",
      lang: "en",
      metadata: { videoId: "nDLb8_wgX50", availableLangs: ["en"] },
    });
    expect(startYouTubeTranscript.mock.calls[0][0].idempotencyKey).toMatch(/^youtube-transcript:[0-9]+:[a-z0-9]+$/);
  });

  it("polls a first-party job ID to completion without storing durable job state", async () => {
    const { service, startYouTubeTranscript, getYouTubeTranscriptStatus } = harness();
    startYouTubeTranscript.mockResolvedValue({
      status: "job_started",
      jobId: "job123",
      checkUrl: "/api/plugin/youtube/transcripts/job123",
    });
    getYouTubeTranscriptStatus
      .mockResolvedValueOnce({ status: "pending", jobId: "job123" })
      .mockResolvedValueOnce({
        status: "completed",
        text: "done",
        lang: "en",
        metadata: { availableLangs: ["en"] },
      });
    jest.spyOn(service as any, "sleep").mockResolvedValue(undefined);

    const result = await service.getTranscript(testUrl);

    expect(result).toEqual({ text: "done", lang: "en", metadata: { availableLangs: ["en"] } });
    expect(getYouTubeTranscriptStatus).toHaveBeenCalledTimes(2);
    expect(getYouTubeTranscriptStatus).toHaveBeenCalledWith({ jobId: "job123" });
  });

  it("maps a closed failed job response to existing user-facing error behavior", async () => {
    const { service, startYouTubeTranscript } = harness();
    startYouTubeTranscript.mockResolvedValue({ status: "failed", error: "Transcript generation failed." });

    await expect(service.getTranscript(testUrl)).rejects.toThrow("Transcript generation failed.");
  });

  it("maps a typed first-party rate-limit error to actionable quota guidance", async () => {
    const { service, startYouTubeTranscript } = harness();
    startYouTubeTranscript.mockRejectedValue(
      new ManagedProductIntegrationError("rate_limited", "Please retry later.", 429, "request-1"),
    );

    const error = await service.getTranscript(testUrl).catch((caught) => caught as Error);
    expect(error.message).toMatch(/usage limit/i);
    expect(error.message).toMatch(/try again/i);
    expect(error.message).not.toMatch(/provider|supadata/i);
  });

  it("rejects malformed URLs only when the admitted client's lazy preparation is evaluated", async () => {
    const { service, startYouTubeTranscript } = harness();
    startYouTubeTranscript.mockImplementation(async ({ prepare }: { prepare: () => unknown }) => prepare());

    await expect(service.getTranscript("not a youtube URL")).rejects.toThrow("Invalid YouTube URL format");
    expect(startYouTubeTranscript).toHaveBeenCalledTimes(1);
  });
});

describe("describeYouTubeTranscriptError", () => {
  it("maps an HTTP 429 to actionable, payload-free guidance", () => {
    const message = describeYouTubeTranscriptError(429, null);
    expect(message).toMatch(/usage limit/i);
    expect(message).toMatch(/try again/i);
    expect(message).not.toMatch(/[{}]/);
  });

  it("detects old relayed quota text without exposing its provider", () => {
    const message = describeYouTubeTranscriptError(undefined, {
      error: 'Supadata transcript failed: 429 - {"error":"limit-exceeded"}',
    });
    expect(message).toMatch(/usage limit/i);
    expect(message).not.toMatch(/supadata|[{}]/i);
  });

  it("preserves a specific non-quota error", () => {
    expect(describeYouTubeTranscriptError(400, { error: "Invalid video id" })).toBe("Invalid video id");
  });
});
