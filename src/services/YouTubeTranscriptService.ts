import { requestUrl } from "obsidian";
import { PlatformContext } from "./PlatformContext";
import type SystemSculptPlugin from "../main";
import { WEBSITE_API_BASE_URL, SYSTEMSCULPT_API_HEADERS } from "../constants/api";

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
  kind: "asr" | "standard"; // asr = auto-generated, standard = manual
  isTranslatable: boolean;
}

export interface AvailableLanguagesResult {
  videoId: string;
  languages: CaptionTrack[];
  defaultLanguage?: string;
}

interface TranscriptResponse {
  text?: string;
  lang?: string;
  status?: "processing" | "queued" | "active" | "completed" | "failed";
  jobId?: string;
  checkUrl?: string;
  error?: string;
  metadata?: {
    videoId?: string;
    availableLangs?: string[];
  };
}

/**
 * Service for extracting transcripts from YouTube videos via the SystemSculpt API
 */
export class YouTubeTranscriptService {
  private static instance: YouTubeTranscriptService;
  private plugin: SystemSculptPlugin;
  private platform: PlatformContext;
  private readonly MAX_POLL_ATTEMPTS = 60; // 5 minutes max at 5s intervals
  private readonly POLL_INTERVAL_MS = 5000;
  private readonly CANONICAL_WATCH_BASE_URL = "https://www.youtube.com/watch?v=";

  private constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.platform = PlatformContext.get();
  }

  static getInstance(plugin: SystemSculptPlugin): YouTubeTranscriptService {
    if (!YouTubeTranscriptService.instance) {
      YouTubeTranscriptService.instance = new YouTubeTranscriptService(plugin);
    }
    return YouTubeTranscriptService.instance;
  }

  /**
   * Extract video ID from various YouTube URL formats
   */
  extractVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/, // Direct video ID
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Get transcript from a YouTube video
   */
  async getTranscript(
    url: string,
    options?: YouTubeTranscriptOptions
  ): Promise<YouTubeTranscriptResult> {
    const videoId = this.extractVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL format");
    }
    const canonicalUrl = `${this.CANONICAL_WATCH_BASE_URL}${videoId}`;

    const licenseKey = this.plugin.settings.licenseKey;
    if (!licenseKey || !this.plugin.settings.licenseValid) {
      throw new Error(
        "A valid SystemSculpt license is required to use the YouTube transcript feature"
      );
    }

    const endpoint = `${WEBSITE_API_BASE_URL}/youtube/transcripts`;
    const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);

    const body = JSON.stringify({
      url: canonicalUrl,
      lang: options?.lang,
    });

    console.log("[YouTubeTranscriptService] Requesting transcript:", { videoId, lang: options?.lang });

    const response = await this.makeRequest(endpoint, headers, body);

    // Handle async job case
    if (response.status === "processing" && response.jobId) {
      console.log("[YouTubeTranscriptService] Async job started:", { jobId: response.jobId });
      return this.pollForResult(response.jobId, licenseKey);
    }

    // Immediate result
    if (!response.text) {
      throw new Error(response.error || "No transcript returned");
    }

    console.log("[YouTubeTranscriptService] Transcript received:", {
      videoId,
      lang: response.lang,
      length: response.text.length,
    });

    return {
      text: response.text,
      lang: response.lang || "unknown",
      metadata: response.metadata,
    };
  }

  /**
   * Poll for async job result
   */
  private async pollForResult(
    jobId: string,
    licenseKey: string
  ): Promise<YouTubeTranscriptResult> {
    const endpoint = `${WEBSITE_API_BASE_URL}/youtube/transcripts/${jobId}`;
    const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);

    for (let attempt = 0; attempt < this.MAX_POLL_ATTEMPTS; attempt++) {
      await this.sleep(this.POLL_INTERVAL_MS);

      const response = await this.makeRequest(endpoint, headers, undefined, "GET");

      if (response.status === "completed" && response.text) {
        console.log("[YouTubeTranscriptService] Async job completed:", { jobId });
        return {
          text: response.text,
          lang: response.lang || "unknown",
          metadata: response.metadata,
        };
      }

      if (response.status === "failed") {
        throw new Error(response.error || "Transcript generation failed");
      }

      console.log("[YouTubeTranscriptService] Job still processing:", {
        jobId,
        status: response.status,
        attempt: attempt + 1,
      });
    }

    throw new Error("Transcript generation timed out after 5 minutes");
  }

  /**
   * Make HTTP request using platform-appropriate transport
   */
  private async makeRequest(
    endpoint: string,
    headers: Record<string, string>,
    body?: string,
    method: "GET" | "POST" = "POST"
  ): Promise<TranscriptResponse> {
    const transportOptions = { endpoint };
    const preferredTransport = this.platform.preferredTransport(transportOptions);

    console.log("[YouTubeTranscriptService] Making request:", { endpoint, method, transport: preferredTransport });

    try {
      if (preferredTransport === "requestUrl") {
        const response = await requestUrl({
          url: endpoint,
          method,
          headers,
          body: method === "POST" ? body : undefined,
          throw: false,
        });

        console.log("[YouTubeTranscriptService] Response status:", response.status);

        if (response.status >= 400) {
          const errorData = response.json || {};
          console.error("[YouTubeTranscriptService] Error response:", errorData);
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        return response.json as TranscriptResponse;
      } else {
        const response = await fetch(endpoint, {
          method,
          headers,
          body: method === "POST" ? body : undefined,
        });

        console.log("[YouTubeTranscriptService] Response status:", response.status);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error("[YouTubeTranscriptService] Error response:", errorData);
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        return (await response.json()) as TranscriptResponse;
      }
    } catch (error) {
      console.error("[YouTubeTranscriptService] Request failed:", error);
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get available caption languages for a YouTube video (lightweight, no transcript fetch)
   */
  async getAvailableLanguages(url: string): Promise<AvailableLanguagesResult> {
    const videoId = this.extractVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL format");
    }
    const canonicalUrl = `${this.CANONICAL_WATCH_BASE_URL}${videoId}`;

    const licenseKey = this.plugin.settings.licenseKey;
    if (!licenseKey || !this.plugin.settings.licenseValid) {
      throw new Error(
        "A valid SystemSculpt license is required to use the YouTube transcript feature"
      );
    }

    const endpoint = `${WEBSITE_API_BASE_URL}/youtube/languages?url=${encodeURIComponent(canonicalUrl)}`;
    const headers = SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey);

    console.log("[YouTubeTranscriptService] Fetching available languages:", { videoId });

    const transportOptions = { endpoint };
    const preferredTransport = this.platform.preferredTransport(transportOptions);

    try {
      let data: AvailableLanguagesResult;

      if (preferredTransport === "requestUrl") {
        const response = await requestUrl({
          url: endpoint,
          method: "GET",
          headers,
          throw: false,
        });

        if (response.status >= 400) {
          const errorData = response.json || {};
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        data = response.json as AvailableLanguagesResult;
      } else {
        const response = await fetch(endpoint, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        data = (await response.json()) as AvailableLanguagesResult;
      }

      console.log("[YouTubeTranscriptService] Available languages:", {
        videoId,
        count: data.languages.length,
        default: data.defaultLanguage,
      });

      return data;
    } catch (error) {
      console.error("[YouTubeTranscriptService] Failed to fetch available languages:", error);
      throw error;
    }
  }
}
