/** @jest-environment node */

import { readFileSync } from "node:fs";
import path from "node:path";
import { YouTubeMetadataService } from "../YouTubeMetadataService";

describe("YouTubeMetadataService", () => {
  const service = YouTubeMetadataService.getInstance();

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "dQw4w9WgXcQ",
  ])("extracts the video ID locally from %s", (value) => {
    expect(service.extractVideoId(value)).toBe("dQw4w9WgXcQ");
    expect(service.isValidYouTubeUrl(value)).toBe(true);
  });

  it("rejects invalid URLs without attempting metadata lookup", async () => {
    expect(service.extractVideoId("https://example.com/video")).toBeNull();
    await expect(service.getMetadata("https://example.com/video")).rejects.toThrow("Invalid YouTube URL");
  });

  it("builds bounded local preview metadata", async () => {
    await expect(service.getMetadata("https://youtu.be/dQw4w9WgXcQ")).resolves.toEqual({
      title: "YouTube video",
      author_name: "Video ID dQw4w9WgXcQ",
      author_url: "",
      thumbnailDataUrl: null,
      videoId: "dQw4w9WgXcQ",
    });
  });

  it("contains no oEmbed, requestUrl, or automatic thumbnail path", () => {
    const serviceSource = readFileSync(
      path.resolve(process.cwd(), "src/services/YouTubeMetadataService.ts"),
      "utf8",
    );
    const modalSource = readFileSync(
      path.resolve(process.cwd(), "src/modals/YouTubeCanvasModal.ts"),
      "utf8",
    );

    expect(serviceSource).not.toMatch(/requestUrl|oembed|img\.youtube\.com|getThumbnailUrl/);
    expect(modalSource).not.toMatch(/img\.youtube\.com|getThumbnailUrl/);
    expect(modalSource).toContain("thumbnailDataUrl");
    expect(modalSource).toContain("thumbnail-placeholder");
  });
});
