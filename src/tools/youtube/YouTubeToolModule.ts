import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { FirstPartyToolDefinition } from "../types";
import { YouTubeTranscriptService } from "../../services/YouTubeTranscriptService";

export interface YouTubeTranscriptParams {
  url: string;
  lang?: string;
}

/**
 * Canonical YouTube tool definitions.
 */
const toolDefinitions: FirstPartyToolDefinition[] = [
  {
    name: "youtube_transcript",
    description:
      "Extract the transcript (captions/subtitles) from a YouTube video. Returns the full text of the video's spoken content. Useful for summarizing videos, extracting information, or getting quotes from video content.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The YouTube video URL (e.g., https://youtube.com/watch?v=... or https://youtu.be/...)",
        },
        lang: {
          type: "string",
          description:
            "Preferred language code (ISO 639-1, e.g., 'en', 'es', 'fr'). Optional - defaults to the video's primary language.",
        },
      },
      required: ["url"],
    },
  },
];

/**
 * Direct first-party YouTube tool module.
 */
export class YouTubeToolModule {
  private plugin: SystemSculptPlugin;
  private transcriptService: YouTubeTranscriptService;

  constructor(plugin: SystemSculptPlugin, _app: App) {
    this.plugin = plugin;
    this.transcriptService = YouTubeTranscriptService.getInstance(plugin);
  }

  /**
   * Get available tools
   */
  getTools(): FirstPartyToolDefinition[] {
    return toolDefinitions;
  }

  /**
   * Execute a tool
   */
  async executeTool(toolName: string, args: unknown): Promise<unknown> {
    switch (toolName) {
      case "youtube_transcript":
        return await this.executeYouTubeTranscript(args as YouTubeTranscriptParams);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Execute YouTube transcript extraction
   */
  private async executeYouTubeTranscript(params: YouTubeTranscriptParams): Promise<{
    success: boolean;
    text?: string;
    lang?: string;
    error?: string;
    metadata?: {
      videoId?: string;
      availableLangs?: string[];
    };
  }> {
    if (!params.url) {
      return {
        success: false,
        error: "URL is required",
      };
    }

    try {
      const result = await this.transcriptService.getTranscript(params.url, {
        lang: params.lang,
      });

      return {
        success: true,
        text: result.text,
        lang: result.lang,
        metadata: result.metadata,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[YouTubeToolModule] Transcript extraction failed:", message);

      return {
        success: false,
        error: message,
      };
    }
  }
}
