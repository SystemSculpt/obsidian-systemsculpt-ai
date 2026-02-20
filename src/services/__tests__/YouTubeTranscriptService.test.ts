import { requestUrl } from "obsidian";
import { YouTubeTranscriptService } from "../YouTubeTranscriptService";
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
});
