import type { App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { MCPToolInfo } from "../../types/mcp";
import { MCPYouTubeServer } from "../../mcp-tools/youtube/MCPYouTubeServer";

export class YouTubeAdapter {
  private ytServer: MCPYouTubeServer;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.ytServer = new MCPYouTubeServer(plugin, app);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return await this.ytServer.getTools();
  }

  async executeTool(
    toolName: string,
    args: unknown,
    _chatView?: unknown,
    _options?: { timeoutMs?: number }
  ): Promise<unknown> {
    return await this.ytServer.executeTool(toolName, args);
  }
}
