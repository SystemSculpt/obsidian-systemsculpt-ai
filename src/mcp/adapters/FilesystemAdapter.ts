import type { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { MCPToolInfo } from "../../types/mcp";
import { MCPFilesystemServer } from "../../mcp-tools/filesystem/MCPFilesystemServer";

export class FilesystemAdapter {
  private fsServer: MCPFilesystemServer;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.fsServer = new MCPFilesystemServer(plugin, app);
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return await this.fsServer.getTools();
  }

  async executeTool(toolName: string, args: any, chatView?: any, _options?: { timeoutMs?: number }): Promise<any> {
    return await this.fsServer.executeTool(toolName, args, chatView);
  }

  setAllowedPaths(paths: string[]): void {
    this.fsServer.setAllowedPaths(paths);
  }
}
