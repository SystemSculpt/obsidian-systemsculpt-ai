import { selectPreferredYouTubeLanguage } from "../youtubeLanguages";
import type { AvailableLanguagesResult, CaptionTrack } from "../../services/YouTubeTranscriptService";

const buildTrack = (languageCode: string, kind: "asr" | "standard" = "standard"): CaptionTrack => ({
  languageCode,
  name: languageCode.toUpperCase(),
  kind,
  isTranslatable: true,
});

describe("selectPreferredYouTubeLanguage", () => {
  it("prefers preferred fallbacks over the API default", () => {
    const result = selectPreferredYouTubeLanguage(
      {
        videoId: "video-1",
        defaultLanguage: "ar",
        languages: [buildTrack("ar", "standard"), buildTrack("en", "standard")],
      },
      ["en"]
    );

    expect(result).toBe("en");
  });

  it("matches preferred fallbacks by base language", () => {
    const result = selectPreferredYouTubeLanguage(
      {
        videoId: "video-2",
        defaultLanguage: "es",
        languages: [buildTrack("en-GB", "standard"), buildTrack("es", "standard")],
      },
      ["en-US"]
    );

    expect(result).toBe("en-GB");
  });

  it("falls back to the API default when preferred languages are unavailable", () => {
    const result = selectPreferredYouTubeLanguage(
      {
        videoId: "video-3",
        defaultLanguage: "es",
        languages: [buildTrack("fr", "standard"), buildTrack("es", "standard")],
      },
      ["de"]
    );

    expect(result).toBe("es");
  });

  it("prefers standard captions when no preferred or default match exists", () => {
    const result = selectPreferredYouTubeLanguage(
      {
        videoId: "video-4",
        defaultLanguage: "xx",
        languages: [buildTrack("fr", "asr"), buildTrack("de", "standard")],
      },
      []
    );

    expect(result).toBe("de");
  });

  it("falls back to the first track when only ASR captions are present", () => {
    const result = selectPreferredYouTubeLanguage(
      {
        videoId: "video-5",
        languages: [buildTrack("ja", "asr"), buildTrack("ko", "asr")],
      } as AvailableLanguagesResult,
      []
    );

    expect(result).toBe("ja");
  });
});
