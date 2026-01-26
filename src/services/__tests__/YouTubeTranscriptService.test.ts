import { requestUrl } from "obsidian";
import { YouTubeTranscriptService } from "../YouTubeTranscriptService";

describe("YouTubeTranscriptService", () => {
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
  });

  it("canonicalizes the URL for available languages requests", async () => {
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      json: {
        videoId: "dQw4w9WgXcQ",
        languages: [],
        defaultLanguage: "en",
      },
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    await service.getAvailableLanguages("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42");

    const calledUrl = (requestUrl as jest.Mock).mock.calls[0][0].url as string;
    expect(calledUrl).toContain(encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    expect(calledUrl).not.toContain("si%3D");
  });

  it("canonicalizes the URL for transcript requests", async () => {
    (requestUrl as jest.Mock).mockResolvedValue({
      status: 200,
      json: {
        text: "hello",
        lang: "en",
      },
    });

    const service = YouTubeTranscriptService.getInstance(buildPluginStub());
    await service.getTranscript("https://youtu.be/dQw4w9WgXcQ?si=abc&t=42");

    const calledBody = (requestUrl as jest.Mock).mock.calls[0][0].body as string;
    const parsed = JSON.parse(calledBody);
    expect(parsed.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

