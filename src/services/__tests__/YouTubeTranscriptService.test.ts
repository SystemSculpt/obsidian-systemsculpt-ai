import { requestUrl } from "obsidian";
import { YouTubeTranscriptService } from "../YouTubeTranscriptService";

describe("YouTubeTranscriptService", () => {
  const originalFetch = globalThis.fetch;
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
    await service.getTranscript("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42");

    const calledBody = (globalThis.fetch as jest.Mock).mock.calls[0][1].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
