import type { App } from "obsidian";
import SystemSculptPlugin from "../../main";
import { MCPToolInfo } from "../../types/mcp";
import { loadDesktopOnly } from "../../platform/desktopOnly";
import type { MCPFilesystemServer } from "../../mcp-tools/filesystem/MCPFilesystemServer";

export class FilesystemAdapter {
  // Null on mobile: the filesystem MCP server needs Node (fs/path), which a
  // phone has not. The tools then degrade rather than crash.
  private readonly fsServer: MCPFilesystemServer | null;

  constructor(plugin: SystemSculptPlugin, app: App) {
    // The filesystem MCP server pulls in node:fs / node:path. Load it through
    // the canonical desktop-only boundary so the chain stays off the mobile
    // bundle-load path and never initialises on a phone (#207).
    const mod = loadDesktopOnly(
      () =>
        require("../../mcp-tools/filesystem/MCPFilesystemServer") as typeof import("../../mcp-tools/filesystem/MCPFilesystemServer"),
    );
    this.fsServer = mod ? new mod.MCPFilesystemServer(plugin, app) : null;
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return this.fsServer ? await this.fsServer.getTools() : [];
  }

  async executeTool(toolName: string, args: any, chatView?: any, _options?: { timeoutMs?: number }): Promise<any> {
    if (!this.fsServer) {
      throw new Error(
        "Filesystem MCP tools require a desktop runtime — they are unavailable on mobile (no Node).",
      );
    }
    return await this.fsServer.executeTool(toolName, args, chatView);
  }

  setAllowedPaths(paths: string[]): void {
    this.fsServer?.setAllowedPaths(paths);
  }
}
