/** @jest-environment node */
const mockGetTranscript = jest.fn();

jest.mock("../../../services/YouTubeTranscriptService", () => ({
  YouTubeTranscriptService: {
    getInstance: jest.fn(() => ({ getTranscript: mockGetTranscript })),
  },
}));

import { YouTubeToolModule } from "../YouTubeToolModule";

describe("YouTubeToolModule", () => {
  beforeEach(() => jest.clearAllMocks());

  it("exposes the canonical transcript definition", () => {
    const module = new YouTubeToolModule({} as any, {} as any);
    expect(module.getTools().map((tool) => tool.name)).toEqual(["youtube_transcript"]);
  });

  it("executes transcript extraction directly", async () => {
    mockGetTranscript.mockResolvedValue({
      text: "Transcript",
      lang: "en",
      metadata: { videoId: "abcdefghijk" },
    });
    const module = new YouTubeToolModule({} as any, {} as any);

    await expect(module.executeTool("youtube_transcript", {
      url: "https://youtu.be/abcdefghijk",
      lang: "en",
    })).resolves.toEqual({
      success: true,
      text: "Transcript",
      lang: "en",
      metadata: { videoId: "abcdefghijk" },
    });
  });

  it("returns a structured failure for a missing URL", async () => {
    const module = new YouTubeToolModule({} as any, {} as any);
    await expect(module.executeTool("youtube_transcript", {})).resolves.toEqual({
      success: false,
      error: "URL is required",
    });
    expect(mockGetTranscript).not.toHaveBeenCalled();
  });
});
