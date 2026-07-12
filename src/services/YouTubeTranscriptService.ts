import type SystemSculptPlugin from "../main";
import {
  ManagedProductIntegrationError,
  type ManagedYouTubeTranscriptResponse,
} from "./managed/ManagedProductIntegrationClient";

export interface YouTubeTranscriptResult {
  text: string;
  lang: string;
  metadata?: {
    videoId?: string;
    availableLangs?: string[];
  };
}

export interface YouTubeTranscriptOptions {
  lang?: string;
}

export interface CaptionTrack {
  languageCode: string;
  name: string;
  kind: "asr" | "standard";
  isTranslatable: boolean;
}

export interface YouTubeTranscriptErrorPayload {
  error?: string;
  message?: string;
  details?: string;
}

const TRANSCRIPT_QUOTA_PATTERN =
  /limit[\s_-]?exceeded|usage limit|quota|rate[\s_-]?limit|too many requests|\b429\b/i;

export function describeYouTubeTranscriptError(
  status?: number,
  payload?: YouTubeTranscriptErrorPayload | null,
): string {
  const text = [payload?.error, payload?.message, payload?.details]
    .map((part) => (typeof part === "string" ? part : ""))
    .join(" ");
  if (status === 429 || TRANSCRIPT_QUOTA_PATTERN.test(text)) {
    return "YouTube transcription is temporarily unavailable because the transcript service has reached its usage limit. Please try again in a little while.";
  }
  const specific = (payload?.error || payload?.message || "").trim();
  if (specific) return specific;
  if (typeof status === "number" && status > 0) return `YouTube transcript request failed (HTTP ${status}).`;
  return "YouTube transcript request failed.";
}

export class YouTubeTranscriptService {
  private static instance: YouTubeTranscriptService;
  private readonly MAX_POLL_ATTEMPTS = 60;
  private readonly POLL_INTERVAL_MS = 5000;
  private readonly CANONICAL_WATCH_BASE_URL = "https://www.youtube.com/watch?v=";

  private constructor(private readonly plugin: SystemSculptPlugin) {}

  static getInstance(plugin: SystemSculptPlugin): YouTubeTranscriptService {
    if (!YouTubeTranscriptService.instance) {
      YouTubeTranscriptService.instance = new YouTubeTranscriptService(plugin);
    }
    return YouTubeTranscriptService.instance;
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

  async getTranscript(url: string, options?: YouTubeTranscriptOptions): Promise<YouTubeTranscriptResult> {
    const client = this.plugin.getManagedProductIntegrationClient();
    let response: ManagedYouTubeTranscriptResponse;
    try {
      response = await client.startYouTubeTranscript({
        idempotencyKey: `youtube-transcript:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        prepare: () => {
          const videoId = this.extractVideoId(url);
          if (!videoId) throw new Error("Invalid YouTube URL format");
          return {
            url: `${this.CANONICAL_WATCH_BASE_URL}${videoId}`,
            lang: options?.lang,
          };
        },
      });
    } catch (error) {
      throw this.userFacingError(error);
    }

    if (response.status === "job_started") {
      return this.pollForResult(response.jobId);
    }
    return this.completedResult(response);
  }

  private async pollForResult(jobId: string): Promise<YouTubeTranscriptResult> {
    const client = this.plugin.getManagedProductIntegrationClient();
    for (let attempt = 0; attempt < this.MAX_POLL_ATTEMPTS; attempt += 1) {
      await this.sleep(this.POLL_INTERVAL_MS);
      let response: ManagedYouTubeTranscriptResponse;
      try {
        response = await client.getYouTubeTranscriptStatus({ jobId });
      } catch (error) {
        throw this.userFacingError(error);
      }
      if (response.status === "completed") return this.completedResult(response);
      if (response.status === "failed") throw new Error(describeYouTubeTranscriptError(undefined, { error: response.error }));
      if (response.status !== "pending") {
        throw new Error("YouTube transcript service returned an unexpected job state.");
      }
    }
    throw new Error("Transcript generation timed out after 5 minutes");
  }

  private completedResult(response: ManagedYouTubeTranscriptResponse): YouTubeTranscriptResult {
    if (response.status === "failed") {
      throw new Error(describeYouTubeTranscriptError(undefined, { error: response.error }));
    }
    if (response.status !== "cached" && response.status !== "synchronous" && response.status !== "completed") {
      throw new Error("YouTube transcript service returned an incomplete result.");
    }
    return {
      text: response.text,
      lang: response.lang || "unknown",
      metadata: response.metadata,
    };
  }

  private userFacingError(error: unknown): Error {
    if (error instanceof ManagedProductIntegrationError) {
      if (error.code === "rate_limited") {
        return new Error(describeYouTubeTranscriptError(429, null));
      }
      return new Error(describeYouTubeTranscriptError(error.status, { error: error.message }));
    }
    return error instanceof Error ? error : new Error("YouTube transcript request failed.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
