const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

export interface CanonicalYouTubeVideo {
  videoId: string;
  url: string;
}

export function parseYouTubeVideoUrl(input: string): CanonicalYouTubeVideo | null {
  const candidate = input.trim();
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
  ) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.searchParams.has("list")) return null;
  let videoId: string | null = null;

  if (host === "youtu.be") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 1) videoId = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === "/watch") {
      if (parsed.searchParams.getAll("v").length !== 1) return null;
      videoId = parsed.searchParams.get("v");
    } else {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 2 && ["shorts", "live", "embed"].includes(segments[0])) {
        videoId = segments[1];
      }
    }
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return null;
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function requireYouTubeVideoUrl(input: string): CanonicalYouTubeVideo {
  const parsed = parseYouTubeVideoUrl(input);
  if (!parsed) {
    throw new Error("Enter a full YouTube video URL, such as https://www.youtube.com/watch?v=…");
  }
  return parsed;
}
