import { normalizePath, type App } from "obsidian";
import SystemSculptPlugin from "../main";
import { MCPServer, MCPToolInfo } from "../types/mcp";
import { buildOpenAIToolDefinition, type OpenAITool } from "../utils/tooling";
import type { SystemSculptSettings } from "../types";

// Adapters
import { FilesystemAdapter } from "./adapters/FilesystemAdapter";
import { HTTPAdapter } from "./adapters/HTTPAdapter";
import { YouTubeAdapter } from "./adapters/YouTubeAdapter";

interface MCPConnectionResult {
  success: boolean;
  error?: string;
  tools?: MCPToolInfo[];
  timestamp: number;
}

/**
 * Central MCP service with pluggable server adapters.
 */
export class MCPService {
  private app: App;
  private plugin: SystemSculptPlugin;
  private logger: Console;
  private settingsProvider: () => SystemSculptSettings;
  private filesystemRoot: string | null = null;
  private filesystemRootAliases: string[] = [];

  // Adapter instances keyed by server id
  private adapters: Map<string, FilesystemAdapter | HTTPAdapter | YouTubeAdapter> = new Map();

  // Static caches shared across instances
  private static connectionTestCache: Map<string, { result: MCPConnectionResult; timestamp: number }> = new Map();
  private static connectionTestPromises: Map<string, Promise<MCPConnectionResult>> = new Map();

  private readonly CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
  private requestIdCounter = 0;

  constructor(plugin: SystemSculptPlugin, app: App, settingsProvider?: () => SystemSculptSettings) {
    this.plugin = plugin;
    this.app = app;
    this.logger = console;
    this.settingsProvider = settingsProvider ?? (() => this.plugin.settings);
  }

  private getAdapterForServer(server: MCPServer): FilesystemAdapter | HTTPAdapter | YouTubeAdapter {
    const existing = this.adapters.get(server.id);
    if (existing) return existing;

    let adapter: FilesystemAdapter | HTTPAdapter | YouTubeAdapter;
    if (server.transport === "internal" && server.id === "mcp-filesystem") {
      adapter = new FilesystemAdapter(this.plugin, this.app);
    } else if (server.transport === "internal" && server.id === "mcp-youtube") {
      adapter = new YouTubeAdapter(this.plugin, this.app);
    } else if (server.transport === "http") {
      adapter = new HTTPAdapter(server, this.plugin, this.app, () => ++this.requestIdCounter);
    } else {
      throw new Error("Only HTTP and internal transports are currently supported");
    }

    this.adapters.set(server.id, adapter);
    return adapter;
  }

  public clearCache(): void {
    MCPService.connectionTestCache.clear();
    MCPService.connectionTestPromises.clear();
  }

  async testConnection(server: MCPServer): Promise<MCPConnectionResult> {
    const cached = MCPService.connectionTestCache.get(server.id);
    if (cached && Date.now() - cached.result.timestamp < this.CACHE_DURATION) {
      return cached.result;
    }

    const existingPromise = MCPService.connectionTestPromises.get(server.id);
    if (existingPromise) return existingPromise;

    const testPromise = this.performConnectionTest(server);
    MCPService.connectionTestPromises.set(server.id, testPromise);
    try {
      const result = await testPromise;
      if (result.success) {
        MCPService.connectionTestCache.set(server.id, { result, timestamp: Date.now() });
      }
      return result;
    } finally {
      MCPService.connectionTestPromises.delete(server.id);
    }
  }

  private async performConnectionTest(server: MCPServer): Promise<MCPConnectionResult> {
    try {
      const tools = await this.discoverTools(server);
      return { success: true, tools, timestamp: Date.now() };
    } catch (error) {
      this.logger.error(`MCP connection test failed for ${server.name}:`, error);
      return { success: false, error: this.getErrorMessage(error), timestamp: Date.now() };
    }
  }

  private async discoverTools(server: MCPServer): Promise<MCPToolInfo[]> {
    const adapter = this.getAdapterForServer(server);
    return await adapter.listTools();
  }

  /**
   * Returns internal servers that are always available (filesystem, youtube).
   * These are hardcoded to always provide tools regardless of settings.
   */
  private getInternalServers(): MCPServer[] {
    return [
      {
        id: "mcp-filesystem",
        name: "Filesystem Tools",
        transport: "internal" as const,
        isEnabled: true,
        connectionStatus: "connected",
        availableTools: []
      },
      {
        id: "mcp-youtube",
        name: "YouTube Tools",
        transport: "internal" as const,
        isEnabled: true,
        connectionStatus: "connected",
        availableTools: []
      }
    ];
  }

  async getAvailableTools(): Promise<OpenAITool[]> {
    // Internal servers (filesystem, youtube) are ALWAYS available - no settings checks
    const internalServers = this.getInternalServers();

    // Custom HTTP servers from settings (keep isEnabled check for user-configured servers)
    const settings = this.settingsProvider();
    const customServers = (settings.mcpServers || []).filter(
      (server) => server.transport === "http" && server.isEnabled
    );

    const allServers = [...internalServers, ...customServers];

    const serverToolsArrays = await Promise.all(
      allServers.map(async (server) => {
        try {
          const connectionResult = await this.testConnection(server);
          if (!connectionResult.success || !connectionResult.tools) return [] as OpenAITool[];

          // Convert ALL tools from the server - no per-tool filtering
          const converted: OpenAITool[] = [];
          for (const tool of connectionResult.tools) {
            try {
              converted.push(this.convertToOpenAITool(tool, server));
            } catch (error) {
              this.logger.warn(`[SystemSculpt] Failed to convert tool ${tool.name || 'unnamed'} from server ${server.name}:`, error);
            }
          }

          return converted;
        } catch (error) {
          this.logger.warn(`Failed to get tools from MCP server ${server.name}:`, error);
          return [] as OpenAITool[];
        }
      })
    );

    const allTools: OpenAITool[] = [];
    for (const arr of serverToolsArrays) allTools.push(...arr);
    return allTools;
  }

  private convertToOpenAITool(tool: MCPToolInfo, server: MCPServer): OpenAITool {
    if (!tool || !tool.name || tool.name.trim() === '') {
      this.logger.warn(`[SystemSculpt] Skipping tool with invalid name:`, tool);
      throw new Error(`Tool missing required name property`);
    }
    if (!server || !server.id) {
      this.logger.warn(`[SystemSculpt] Server missing valid ID:`, server);
      throw new Error(`Server missing required id property`);
    }

    const openAITool: OpenAITool = buildOpenAIToolDefinition({
      name: `${server.id}_${tool.name}`,
      description: `[${server.name}] ${tool.description || 'No description provided'}`,
      parameters: tool.inputSchema || {},
    });

    if (!openAITool.function.name || typeof openAITool.function.name !== 'string') {
      this.logger.error(`[SystemSculpt] Generated invalid OpenAI tool:`, openAITool);
      throw new Error(`Failed to generate valid OpenAI tool`);
    }

    return openAITool;
  }

  async executeTool(
    toolName: string,
    args: any,
    chatView?: any,
    options?: { timeoutMs?: number }
  ): Promise<any> {
    const firstUnderscoreIndex = toolName.indexOf('_');
    if (firstUnderscoreIndex === -1) {
      throw new Error(`Invalid tool name format: ${toolName}`);
    }

    const serverId = toolName.substring(0, firstUnderscoreIndex);
    const actualToolName = toolName.substring(firstUnderscoreIndex + 1);

    // Internal servers are always available - no settings lookup needed
    const internalServerIds = ["mcp-filesystem", "mcp-youtube"];
    let server: MCPServer;

    if (internalServerIds.includes(serverId)) {
      // Use hardcoded internal server definition
      server = this.getInternalServers().find(s => s.id === serverId)!;
    } else {
      // Look up custom server from settings
      const settings = this.settingsProvider();
      const customServer = settings.mcpServers.find(s => s.id === serverId);
      if (!customServer) throw new Error(`MCP server not found: ${serverId}`);
      if (!customServer.isEnabled) throw new Error(`MCP server is disabled: ${customServer.name}`);
      server = customServer;
    }

    const adapter = this.getAdapterForServer(server);
    // @ts-ignore - HTTPAdapter ignores chatView param.
    const mappedArgs = serverId === "mcp-filesystem"
      ? this.mapFilesystemArgs(actualToolName, args)
      : args;
    return await adapter.executeTool(actualToolName, mappedArgs, chatView, options);
  }

  async testAllServers(): Promise<{ [serverId: string]: MCPConnectionResult }> {
    const results: { [serverId: string]: MCPConnectionResult } = {};

    // Always include internal servers
    const internalServers = this.getInternalServers();

    // Include enabled custom HTTP servers from settings
    const settings = this.settingsProvider();
    const customServers = (settings.mcpServers || []).filter(
      (server) => server.transport === "http" && server.isEnabled
    );

    const allServers = [...internalServers, ...customServers];
    const testResults = await Promise.all(allServers.map(async (server) => {
      const result = await this.testConnection(server);
      return { serverId: server.id, result };
    }));
    for (const { serverId, result } of testResults) results[serverId] = result;
    return results;
  }

  public setFilesystemAllowedPaths(paths: string[]): void {
    const server: MCPServer = {
      id: "mcp-filesystem",
      name: "Filesystem",
      transport: "internal",
      isEnabled: true,
    };
    const adapter = this.getAdapterForServer(server);
    if (typeof (adapter as any)?.setAllowedPaths === "function") {
      (adapter as any).setAllowedPaths(paths);
    }
  }

  public setFilesystemRoot(root: string | null, aliases: string[] = []): void {
    this.filesystemRoot = root ? normalizePath(root) : null;
    this.filesystemRootAliases = (Array.isArray(aliases) ? aliases : [])
      .map((alias) => normalizePath(String(alias ?? "")).replace(/^\/+/, ""))
      .filter((alias) => alias.length > 0);
  }

  private mapFilesystemArgs(toolName: string, args: any): any {
    if (!this.filesystemRoot || !args || typeof args !== "object") {
      return args;
    }

    const mapPath = (path: string): string => this.normalizeFilesystemPath(path);

    switch (toolName) {
      case "read":
      case "create_folders":
      case "list_items":
      case "trash":
      case "context":
        if (Array.isArray((args as any).paths)) {
          return { ...args, paths: (args as any).paths.map((p: any) => mapPath(String(p ?? ""))) };
        }
        return args;
      case "write":
      case "edit":
        if (typeof (args as any).path === "string") {
          return { ...args, path: mapPath((args as any).path) };
        }
        return args;
      case "move":
        if (Array.isArray((args as any).items)) {
          return {
            ...args,
            items: (args as any).items.map((item: any) => ({
              ...item,
              source: mapPath(String(item?.source ?? "")),
              destination: mapPath(String(item?.destination ?? "")),
            })),
          };
        }
        return args;
      case "open":
        if (Array.isArray((args as any).files)) {
          return {
            ...args,
            files: (args as any).files.map((file: any) => ({
              ...file,
              path: mapPath(String(file?.path ?? "")),
            })),
          };
        }
        return args;
      default:
        return args;
    }
  }

  private normalizeFilesystemPath(path: string): string {
    const root = this.filesystemRoot;
    const raw = String(path ?? "").trim();
    if (!root || raw.length === 0) {
      return raw;
    }

    const normalized = normalizePath(raw);
    const withoutLeading = normalized.replace(/^\/+/, "");
    for (const alias of this.filesystemRootAliases) {
      if (withoutLeading === alias || withoutLeading.startsWith(`${alias}/`)) {
        const remainder = withoutLeading === alias ? "" : withoutLeading.slice(alias.length + 1);
        if (!remainder) return root;
        return normalizePath(`${root}/${remainder}`);
      }
    }
    const rootIndex = withoutLeading.indexOf(root);
    if (rootIndex >= 0) {
      const candidate = withoutLeading.slice(rootIndex);
      if (candidate === root || candidate.startsWith(`${root}/`)) {
        return candidate;
      }
    }
    if (withoutLeading === root || withoutLeading.startsWith(`${root}/`)) {
      return withoutLeading;
    }
    if (normalized === "/" || withoutLeading.length === 0) {
      return root;
    }

    const joined = normalizePath(`${root}/${withoutLeading}`);
    if (joined === root || joined.startsWith(`${root}/`)) {
      return joined;
    }

    return withoutLeading;
  }

  private getErrorMessage(error: any): string {
    if (error instanceof Error) {
      if (error.name === "AbortError") return "Connection timed out. Please check your internet connection and try again.";
      return error.message;
    }
    return "An unexpected error occurred. Please try again or contact support if the issue persists.";
  }
}
