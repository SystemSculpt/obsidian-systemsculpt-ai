import type { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { MCPToolInfo } from "../../types/mcp";
import type { MCPFilesystemServer } from "../../mcp-tools/filesystem/MCPFilesystemServer";

export class FilesystemAdapter {
  private readonly fsServer: MCPFilesystemServer;

  constructor(plugin: SystemSculptPlugin, app: App) {
    // Since #142 the filesystem MCP server and its whole tool graph are pure
    // Obsidian-API code (no Node builtins), so the agent file tools run on
    // mobile too — no desktop-only gate. The module is still reached through a
    // lazy `require` rather than a static import so its graph stays off the
    // eager bundle-eval path and only evaluates when the adapter is actually
    // constructed (the #207 belt-and-suspenders against any future Node import).
    const mod = require("../../mcp-tools/filesystem/MCPFilesystemServer") as typeof import("../../mcp-tools/filesystem/MCPFilesystemServer");
    this.fsServer = new mod.MCPFilesystemServer(plugin, app);
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
