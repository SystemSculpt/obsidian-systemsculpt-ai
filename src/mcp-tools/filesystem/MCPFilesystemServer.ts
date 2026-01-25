import { App } from "obsidian";
import { MCPToolInfo } from "../../types/mcp";
import SystemSculptPlugin from "../../main";
import { TOOL_DISPLAY_DESCRIPTIONS, TOOL_DISPLAY_NAMES } from "./constants";
import { toolDefinitions } from "./toolDefinitions";
import { FileOperations } from "./tools/FileOperations";
import { DirectoryOperations } from "./tools/DirectoryOperations";
import { SearchOperations } from "./tools/SearchOperations";
import { ManagementOperations } from "./tools/ManagementOperations";
import {
  ReadFilesParams,
  WriteFileParams,
  EditFileParams,
  CreateDirectoriesParams,
  ListDirectoriesParams,
  MoveItemsParams,
  TrashFilesParams,
  FindFilesParams,
  GrepVaultParams,
  ManageWorkspaceParams,
  ManageContextParams
} from "./types";

/**
 * Internal MCP Filesystem Server for Obsidian
 * 
 * This server provides filesystem tools that work within the Obsidian vault.
 * It implements the MCP protocol internally without requiring stdio transport.
 * 
 * Resource Limits:
 * - File reading: 25,000 characters per window
 * - Batch operations: 100 files/directories max per request
 * - Search results: 50 files with matches max for grep
 * - Content size: 100,000 characters max for writing
 * - Replacement strings: 10,000 characters max
 */
export class MCPFilesystemServer {
  private app: App;
  private plugin: SystemSculptPlugin;
  private allowedPaths: string[] = [];
  
  // Tool operation classes
  private fileOps: FileOperations;
  private directoryOps: DirectoryOperations;
  private searchOps: SearchOperations;
  private managementOps: ManagementOperations;
  
  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    
    // By default, allow access to the entire vault
    this.allowedPaths = ["/"];
    
    // Initialize operation classes
    this.fileOps = new FileOperations(this.app, this.allowedPaths);
    this.directoryOps = new DirectoryOperations(this.app, this.allowedPaths, this.plugin);
    this.searchOps = new SearchOperations(this.app, this.allowedPaths, this.plugin);
    this.managementOps = new ManagementOperations(this.app, this.plugin, this.allowedPaths);
  }
  
  /**
   * Get available tools
   */
  async getTools(): Promise<MCPToolInfo[]> {
    // Return all tool definitions
    return toolDefinitions;
  }
  
  /**
   * Get human-friendly description for a tool
   */
  static getToolDisplayDescription(toolName: string): string {
    return TOOL_DISPLAY_DESCRIPTIONS[toolName] || "No description available";
  }
  
  /**
   * Get human-friendly display name for a tool
   */
  static getToolDisplayName(toolName: string): string {
    return TOOL_DISPLAY_NAMES[toolName] || toolName;
  }
  
  /**
   * Execute a tool
   */
  async executeTool(toolName: string, args: any, chatView?: any): Promise<any> {
    switch (toolName) {
      case "read":
        return await this.fileOps.readFiles(args as ReadFilesParams);
      case "write":
        return await this.fileOps.writeFile(args as WriteFileParams);
      case "edit":
        const diff = await this.fileOps.editFile(args as EditFileParams);
        return { path: (args as EditFileParams).path, success: true, diff };
      case "create_folders":
        return await this.directoryOps.createDirectories(args as CreateDirectoriesParams);
      case "list_items":
        return await this.directoryOps.listDirectories(args as ListDirectoriesParams);
      case "move":
        return await this.directoryOps.moveItems(args as MoveItemsParams);
      case "trash":
        return await this.directoryOps.trashFiles(args as TrashFilesParams);
      case "find":
        return await this.searchOps.findFiles(args as FindFilesParams);
      case "search":
        return await this.searchOps.grepVault(args as GrepVaultParams);
      case "open":
        return await this.managementOps.manageWorkspace(args as ManageWorkspaceParams);
      case "context":
        return await this.managementOps.manageContext(args as ManageContextParams);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
  
  /**
   * Set allowed paths for security
   */
  setAllowedPaths(paths: string[]): void {
    this.allowedPaths = paths.map(p => p);
    
    // Update all operation classes with new allowed paths
    this.fileOps = new FileOperations(this.app, this.allowedPaths);
    this.directoryOps = new DirectoryOperations(this.app, this.allowedPaths, this.plugin);
    this.searchOps = new SearchOperations(this.app, this.allowedPaths, this.plugin);
    this.managementOps = new ManagementOperations(this.app, this.plugin, this.allowedPaths);
  }
}
