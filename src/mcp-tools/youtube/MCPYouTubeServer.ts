import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { MCPToolInfo } from "../../types/mcp";
import { YouTubeTranscriptService } from "../../services/YouTubeTranscriptService";

export interface YouTubeTranscriptParams {
  url: string;
  lang?: string;
}

/**
 * Tool definitions for YouTube MCP Server
 */
const toolDefinitions: MCPToolInfo[] = [
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
 * Display names and descriptions for tool UI
 */
export const YOUTUBE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  youtube_transcript: "YouTube Transcript",
};

export const YOUTUBE_TOOL_DISPLAY_DESCRIPTIONS: Record<string, string> = {
  youtube_transcript: "Extract transcript from a YouTube video",
};

/**
 * Internal MCP YouTube Server
 *
 * Provides YouTube-related tools for AI agents.
 */
export class MCPYouTubeServer {
  private plugin: SystemSculptPlugin;
  private transcriptService: YouTubeTranscriptService;

  constructor(plugin: SystemSculptPlugin, _app: App) {
    this.plugin = plugin;
    this.transcriptService = YouTubeTranscriptService.getInstance(plugin);
  }

  /**
   * Get available tools
   */
  async getTools(): Promise<MCPToolInfo[]> {
    return toolDefinitions;
  }

  /**
   * Get human-friendly display name for a tool
   */
  static getToolDisplayName(toolName: string): string {
    return YOUTUBE_TOOL_DISPLAY_NAMES[toolName] || toolName;
  }

  /**
   * Get human-friendly description for a tool
   */
  static getToolDisplayDescription(toolName: string): string {
    return YOUTUBE_TOOL_DISPLAY_DESCRIPTIONS[toolName] || "No description available";
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
      console.error("[MCPYouTubeServer] Transcript extraction failed:", message);

      return {
        success: false,
        error: message,
      };
    }
  }
}
