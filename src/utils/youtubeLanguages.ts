import type { AvailableLanguagesResult, CaptionTrack } from "../services/YouTubeTranscriptService";
import { getBaseLanguageCode, normalizeLanguageCode } from "../constants/languages";

const findMatchingTracks = (tracks: CaptionTrack[], target: string): CaptionTrack[] => {
  const normalizedTarget = normalizeLanguageCode(target);
  if (!normalizedTarget) return [];
  const baseTarget = getBaseLanguageCode(normalizedTarget);

  return tracks.filter((track) => {
    const normalizedTrack = normalizeLanguageCode(track.languageCode);
    if (!normalizedTrack) return false;
    if (normalizedTrack === normalizedTarget) return true;
    return getBaseLanguageCode(normalizedTrack) === baseTarget;
  });
};

const pickPreferredTrack = (tracks: CaptionTrack[]): CaptionTrack | null => {
  if (tracks.length === 0) return null;
  return tracks.find((track) => track.kind === "standard") ?? tracks[0];
};

export const selectPreferredYouTubeLanguage = (
  languagesResult: AvailableLanguagesResult | null,
  preferredFallbacks: string[] = []
): string | null => {
  if (!languagesResult || languagesResult.languages.length === 0) return null;

  const tracks = languagesResult.languages;

  for (const preferred of preferredFallbacks) {
    const match = pickPreferredTrack(findMatchingTracks(tracks, preferred));
    if (match) return match.languageCode;
  }

  if (languagesResult.defaultLanguage) {
    const match = pickPreferredTrack(findMatchingTracks(tracks, languagesResult.defaultLanguage));
    if (match) return match.languageCode;
  }

  const standardTrack = tracks.find((track) => track.kind === "standard");
  if (standardTrack) return standardTrack.languageCode;

  return tracks[0].languageCode;
};
