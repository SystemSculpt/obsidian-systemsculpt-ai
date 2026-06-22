import { requestUrl } from "obsidian";
import {
  YouTubeTranscriptService,
  describeYouTubeTranscriptError,
} from "../YouTubeTranscriptService";
import { PlatformContext } from "../PlatformContext";
import { WEBSITE_API_BASE_URL } from "../../constants/api";

describe("YouTubeTranscriptService", () => {
  const originalFetch = globalThis.fetch;
  const testUrl =
    "https://www.youtube.com/watch?v=nDLb8_wgX50&pp=ygUZZHIgaHViZXJtYW4gZGF2aWQgZ29nZ2lucw%3D%3D";
  let platformGetSpy: jest.SpyInstance;
  const buildPluginStub = () =>
    ({
      settings: {
        licenseKey: "license-key",
        licenseValid: true,
      },
    }) as any;

  beforeEach(() => {
    (YouTubeTranscriptService as any).instance = undefined;
    (requestUrl as jest.Mock).mockReset();
    (globalThis as any).fetch = jest.fn();
    platformGetSpy = jest.spyOn(PlatformContext, "get");
    platformGetSpy.mockReturnValue({
      preferredTransport: jest.fn(() => "fetch"),
    } as any);
  });

  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it("canonicalizes the URL for transcript requests", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: "hello",
        lang: "en",
      }),
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    await service.getTranscript(testUrl);

    const calledBody = (globalThis.fetch as jest.Mock).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(service.extractVideoId(testUrl)).toBe("nDLb8_wgX50");
    expect(parsed.url).toBe("https://www.youtube.com/watch?v=nDLb8_wgX50");
  });

  it("calls the SystemSculpt API with license headers via fetch", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: "hello",
        lang: "en",
      }),
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    await service.getTranscript(testUrl);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [endpoint, requestInit] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(endpoint).toBe(`${WEBSITE_API_BASE_URL}/youtube/transcripts`);
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers["x-license-key"]).toBe("license-key");
    expect(requestInit.headers["Content-Type"]).toBe("application/json");
  });

  it("uses requestUrl transport when preferred", async () => {
    platformGetSpy.mockReturnValue({
      preferredTransport: jest.fn(() => "requestUrl"),
    } as any);

    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      json: { text: "hello", lang: "en" },
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    await service.getTranscript(testUrl);

    expect(requestUrl).toHaveBeenCalledTimes(1);
    const requestArgs = (requestUrl as jest.Mock).mock.calls[0][0];
    expect(requestArgs.url).toBe(`${WEBSITE_API_BASE_URL}/youtube/transcripts`);
    expect(requestArgs.method).toBe("POST");
    expect(requestArgs.headers["x-license-key"]).toBe("license-key");
    const parsedBody = JSON.parse(requestArgs.body);
    expect(parsedBody.url).toBe("https://www.youtube.com/watch?v=nDLb8_wgX50");
  });

  it("falls back to requestUrl when fetch transport throws", async () => {
    (globalThis.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      json: { text: "fallback transcript", lang: "en" },
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    const response = await service.getTranscript(testUrl);

    expect(response.text).toBe("fallback transcript");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    const requestArgs = (requestUrl as jest.Mock).mock.calls[0][0];
    expect(requestArgs.headers["Idempotency-Key"]).toMatch(/^youtube-transcript:nDLb8_wgX50:/);
  });

  it("polls async transcript jobs to completion", async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "processing",
          jobId: "job123",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
          text: "done",
          lang: "en",
        }),
      });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    jest.spyOn(service as any, "sleep").mockResolvedValue(undefined);

    const result = await service.getTranscript(testUrl);

    expect(result).toEqual({ text: "done", lang: "en", metadata: undefined });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((globalThis.fetch as jest.Mock).mock.calls[1][0]).toBe(
      `${WEBSITE_API_BASE_URL}/youtube/transcripts/job123`
    );
    expect((globalThis.fetch as jest.Mock).mock.calls[1][1].method).toBe("GET");
  });

  // #152: the transcript runs through the SystemSculpt backend, which calls
  // Supadata. When the shared Supadata plan is over quota the backend relays a
  // 429 `limit-exceeded`. The client used to surface that raw payload; it must
  // instead show actionable guidance and not waste a second transport attempt.
  it("maps a 429 limit-exceeded (fetch) to actionable guidance and does not retry the other transport (#152)", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "limit-exceeded",
        message: "Limit Exceeded",
        details: "Plan usage limit was exceeded.",
      }),
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    const err = (await service.getTranscript(testUrl).catch((e) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/usage limit/i);
    expect(err.message).toMatch(/try again/i);
    expect(err.message).not.toMatch(/[{}]/); // no raw JSON payload
    expect(err.message).not.toMatch(/supadata/i); // no vendor leak
    expect(err.message).not.toMatch(/limit-exceeded/); // no raw error code

    // A definitive HTTP response must not be re-attempted via requestUrl.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("maps a 429 to actionable guidance when requestUrl is the transport (#152)", async () => {
    platformGetSpy.mockReturnValue({
      preferredTransport: jest.fn(() => "requestUrl"),
    } as any);
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 429,
      json: {
        error: "limit-exceeded",
        message: "Limit Exceeded",
        details: "Plan usage limit was exceeded.",
      },
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    const err = (await service.getTranscript(testUrl).catch((e) => e)) as Error;

    expect(err.message).toMatch(/usage limit/i);
    expect(err.message).not.toMatch(/[{}]/);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("maps a failed async job carrying a Supadata limit error to actionable guidance (#152)", async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "processing", jobId: "job429" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "failed",
          error:
            'Supadata transcript failed: 429 - {"error":"limit-exceeded","message":"Limit Exceeded","details":"Plan usage limit was exceeded."}',
        }),
      });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    jest.spyOn(service as any, "sleep").mockResolvedValue(undefined);

    const err = (await service.getTranscript(testUrl).catch((e) => e)) as Error;
    expect(err.message).toMatch(/usage limit/i);
    expect(err.message).not.toMatch(/[{}]/);
    expect(err.message).not.toMatch(/supadata/i);
  });

  it("preserves a non-quota server error message instead of forcing the quota copy (#152)", async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid video id" }),
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    const err = (await service.getTranscript(testUrl).catch((e) => e)) as Error;

    expect(err.message).toBe("Invalid video id");
    // 400 is a definitive client error; do not retry the other transport.
    expect(requestUrl).not.toHaveBeenCalled();
  });
});

describe("describeYouTubeTranscriptError (#152)", () => {
  it("maps an HTTP 429 to actionable, payload-free guidance", () => {
    const msg = describeYouTubeTranscriptError(429, null);
    expect(msg).toMatch(/usage limit/i);
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toMatch(/[{}]/);
  });

  it("detects quota exhaustion from the relayed Supadata error text regardless of status", () => {
    const msg = describeYouTubeTranscriptError(undefined, {
      error: 'Supadata transcript failed: 429 - {"error":"limit-exceeded"}',
    });
    expect(msg).toMatch(/usage limit/i);
    expect(msg).not.toMatch(/supadata/i);
    expect(msg).not.toMatch(/[{}]/);
  });

  it("matches a 'Plan usage limit was exceeded' details string", () => {
    const msg = describeYouTubeTranscriptError(undefined, {
      details: "Plan usage limit was exceeded.",
    });
    expect(msg).toMatch(/usage limit/i);
  });

  it("preserves a specific non-quota server message", () => {
    expect(describeYouTubeTranscriptError(400, { error: "Invalid video id" })).toBe(
      "Invalid video id"
    );
  });

  it("falls back to a generic message when nothing useful is provided", () => {
    expect(describeYouTubeTranscriptError(500, {})).toMatch(/failed/i);
    expect(describeYouTubeTranscriptError(undefined, null)).toMatch(/failed/i);
  });
});
