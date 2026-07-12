export interface YouTubeMetadata {
  title: string;
  author_name: string;
  author_url: string;
  thumbnailDataUrl: string | null;
  videoId: string;
}

/**
 * Pure URL parsing and local preview metadata for YouTube videos.
 * Transcript content is fetched separately through the managed product client.
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

  isValidYouTubeUrl(url: string): boolean {
    return this.extractVideoId(url) !== null;
  }

  async getMetadata(url: string): Promise<YouTubeMetadata> {
    const videoId = this.extractVideoId(url);
    if (!videoId) throw new Error("Invalid YouTube URL");

    return {
      title: "YouTube video",
      author_name: `Video ID ${videoId}`,
      author_url: "",
      thumbnailDataUrl: null,
      videoId,
    };
  }
}
