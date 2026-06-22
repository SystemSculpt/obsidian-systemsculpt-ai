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
 * Shape of an error payload relayed by the SystemSculpt YouTube transcript
 * endpoint. Quota exhaustion arrives either as `{ error: "limit-exceeded", ... }`
 * or, for async jobs, as a failed job whose `error` text embeds the upstream
 * "429 - limit-exceeded" message (#152).
 */
export interface YouTubeTranscriptErrorPayload {
  error?: string;
  message?: string;
  details?: string;
}

// The ways the backend signals an exhausted transcript quota, whether it relays
// a raw provider code, an HTTP 429, or a human-readable details line.
const TRANSCRIPT_QUOTA_PATTERN =
  /limit[\s_-]?exceeded|usage limit|quota|rate[\s_-]?limit|too many requests|\b429\b/i;

/**
 * Turn a failed YouTube-transcript response into a clear, user-facing message.
 *
 * The transcript runs through the SystemSculpt backend, which calls the upstream
 * transcript provider; when the shared plan is over quota the backend relays a
 * 429 `limit-exceeded`. Surfacing that raw payload to the user is noise (#152),
 * so quota exhaustion becomes actionable guidance. Any other failure keeps the
 * server's own message (usually already specific, e.g. "Invalid video id").
 */
export function describeYouTubeTranscriptError(
  status?: number,
  payload?: YouTubeTranscriptErrorPayload | null
): string {
  const text = [payload?.error, payload?.message, payload?.details]
    .map((part) => (typeof part === "string" ? part : ""))
    .join(" ");

  if (status === 429 || TRANSCRIPT_QUOTA_PATTERN.test(text)) {
    return "YouTube transcription is temporarily unavailable because the transcript service has reached its usage limit. Please try again in a little while.";
  }

  const specific = (payload?.error || payload?.message || "").trim();
  if (specific) return specific;
  if (typeof status === "number" && status > 0) {
    return `YouTube transcript request failed (HTTP ${status}).`;
  }
  return "YouTube transcript request failed.";
}

/**
 * A definitive HTTP error *response* from the transcript endpoint (as opposed to
 * a transport failure). Carrying the typed status lets `makeRequest` avoid
 * pointlessly re-attempting a server-answered request on the other transport,
 * and its message is already the user-facing form from
 * `describeYouTubeTranscriptError`. (#152)
 */
export class YouTubeTranscriptHttpError extends Error {
  readonly status: number;

  constructor(status: number, payload?: YouTubeTranscriptErrorPayload | null) {
    super(describeYouTubeTranscriptError(status, payload));
    this.name = "YouTubeTranscriptHttpError";
    this.status = status;
  }
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
    const headers = {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey),
      ...(this.plugin.manifest?.version ? { "x-plugin-version": this.plugin.manifest.version } : {}),
    };
    const idempotencyKey = `youtube-transcript:${videoId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const body = JSON.stringify({
      url: canonicalUrl,
      lang: options?.lang,
    });

    console.log("[YouTubeTranscriptService] Requesting transcript:", { videoId, lang: options?.lang });

    const response = await this.makeRequest(endpoint, headers, body, "POST", idempotencyKey);

    // Handle async job case
    if (response.status === "processing" && response.jobId) {
      console.log("[YouTubeTranscriptService] Async job started:", { jobId: response.jobId });
      return this.pollForResult(response.jobId, licenseKey);
    }

    // Immediate result
    if (!response.text) {
      throw new Error(
        describeYouTubeTranscriptError(undefined, {
          error: response.error || "No transcript returned",
        })
      );
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
    const headers = {
      ...SYSTEMSCULPT_API_HEADERS.WITH_LICENSE(licenseKey),
      ...(this.plugin.manifest?.version ? { "x-plugin-version": this.plugin.manifest.version } : {}),
    };

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
        // The job failed upstream; the cause (often a relayed 429 quota error)
        // lives in `response.error`. Map it to actionable guidance (#152).
        throw new Error(
          describeYouTubeTranscriptError(undefined, {
            error: response.error || "Transcript generation failed",
          })
        );
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
    method: "GET" | "POST" = "POST",
    idempotencyKey?: string
  ): Promise<TranscriptResponse> {
    const requestHeaders = {
      ...headers,
      ...(method === "POST" && idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
    const transportOptions = { endpoint };
    const preferredTransport = this.platform.preferredTransport(transportOptions);

    console.log("[YouTubeTranscriptService] Making request:", { endpoint, method, transport: preferredTransport });

    try {
      const requestViaRequestUrl = async (): Promise<TranscriptResponse> => {
        const response = await requestUrl({
          url: endpoint,
          method,
          headers: requestHeaders,
          body: method === "POST" ? body : undefined,
          throw: false,
        });

        console.log("[YouTubeTranscriptService] Response status:", response.status);

        if (response.status >= 400) {
          const errorData = (response.json || {}) as YouTubeTranscriptErrorPayload;
          console.error("[YouTubeTranscriptService] Error response:", errorData);
          throw new YouTubeTranscriptHttpError(response.status, errorData);
        }

        return response.json as TranscriptResponse;
      };

      if (preferredTransport === "requestUrl") {
        return await requestViaRequestUrl();
      }

      try {
        const response = await fetch(endpoint, {
          method,
          headers: requestHeaders,
          body: method === "POST" ? body : undefined,
        });

        console.log("[YouTubeTranscriptService] Response status:", response.status);

        if (!response.ok) {
          const errorData = (await response
            .json()
            .catch(() => ({}))) as YouTubeTranscriptErrorPayload;
          console.error("[YouTubeTranscriptService] Error response:", errorData);
          throw new YouTubeTranscriptHttpError(response.status, errorData);
        }

        return (await response.json()) as TranscriptResponse;
      } catch (fetchError) {
        // A definitive HTTP error response is the server's answer, not a
        // transport failure — don't burn a second request on the other
        // transport (which would just re-surface the same status) (#152).
        if (fetchError instanceof YouTubeTranscriptHttpError) {
          throw fetchError;
        }
        console.warn("[YouTubeTranscriptService] Fetch request failed; retrying via requestUrl", {
          endpoint,
          message: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });
        return await requestViaRequestUrl();
      }
    } catch (error) {
      console.error("[YouTubeTranscriptService] Request failed:", error);
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
