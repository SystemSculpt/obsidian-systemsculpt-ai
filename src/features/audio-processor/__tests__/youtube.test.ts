import { parseYouTubeVideoUrl, requireYouTubeVideoUrl } from "../youtube";

describe("Audio Processor YouTube URL parsing", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=12",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
  ])("accepts a supported video URL and canonicalizes it: %s", (input) => {
    expect(requireYouTubeVideoUrl(input)).toEqual({
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk",
    "https://www.youtube.com/@systemsculpt",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://youtu.be/too-short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ#fragment",
    "dQw4w9WgXcQ",
  ])("rejects ambiguous or unsafe input: %s", (input) => {
    expect(parseYouTubeVideoUrl(input)).toBeNull();
  });
});
