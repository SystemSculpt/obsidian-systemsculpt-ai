import { requestUrl } from "obsidian";

export interface YouTubeMetadata {
  title: string;
  author_name: string;
  author_url: string;
  thumbnail_url: string;
  videoId: string;
}

/**
 * Service for fetching YouTube video metadata via oEmbed (no API key required)
 */
export class YouTubeMetadataService {
  private static instance: YouTubeMetadataService;

  private constructor() {}

  static getInstance(): YouTubeMetadataService {
    if (!YouTubeMetadataService.instance) {
      YouTubeMetadataService.instance = new YouTubeMetadataService();
    }
    return YouTubeMetadataService.instance;
  }

  /**
   * Extract video ID from various YouTube URL formats
   */
  extractVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Validate if a string is a valid YouTube URL
   */
  isValidYouTubeUrl(url: string): boolean {
    return this.extractVideoId(url) !== null;
  }

  /**
   * Fetch video metadata via YouTube oEmbed API
   */
  async getMetadata(url: string): Promise<YouTubeMetadata> {
    const videoId = this.extractVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL");
    }

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;

    const response = await requestUrl({
      url: oembedUrl,
      method: "GET",
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch video metadata: ${response.status}`);
    }

    const data = response.json;

    return {
      title: data.title || "Untitled Video",
      author_name: data.author_name || "Unknown Channel",
      author_url: data.author_url || "",
      thumbnail_url: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
    };
  }

  /**
   * Get high-quality thumbnail URL for a video
   */
  getThumbnailUrl(videoId: string, quality: "default" | "hq" | "mq" | "sd" | "maxres" = "hq"): string {
    const qualityMap = {
      default: "default",
      mq: "mqdefault",
      hq: "hqdefault",
      sd: "sddefault",
      maxres: "maxresdefault",
    };
    return `https://img.youtube.com/vi/${videoId}/${qualityMap[quality]}.jpg`;
  }
}
