import { normalizePath, type App } from "obsidian";
import SystemSculptPlugin from "../main";
import { MCPToolInfo } from "../types/mcp";
import { buildManagedToolDefinition, type ManagedToolDefinition } from "../utils/tooling";
import { resolveCanonicalToolAlias } from "../utils/toolPolicy";

// Adapters
import { FilesystemAdapter } from "./adapters/FilesystemAdapter";
import { YouTubeAdapter } from "./adapters/YouTubeAdapter";

export interface MCPExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class MCPToolExecutionError extends Error {
  constructor(
    public readonly code:
      | 'TOOL_CANCELLED_BEFORE_START'
      | 'TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MCPToolExecutionError';
  }
}

interface InternalMCPServer {
  id: "mcp-filesystem" | "mcp-youtube";
  name: string;
}

/**
 * Built-in filesystem and YouTube tool service.
 */
export class MCPService {
  private app: App;
  private plugin: SystemSculptPlugin;
  private logger: Console;
  private filesystemRoot: string | null = null;
  private filesystemRootAliases: string[] = [];

  // Adapter instances keyed by server id
  private adapters: Map<string, FilesystemAdapter | YouTubeAdapter> = new Map();

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.logger = console;
  }

  private getAdapterForServer(server: InternalMCPServer): FilesystemAdapter | YouTubeAdapter {
    const existing = this.adapters.get(server.id);
    if (existing) return existing;

    let adapter: FilesystemAdapter | YouTubeAdapter;
    if (server.id === "mcp-filesystem") {
      adapter = new FilesystemAdapter(this.plugin, this.app);
    } else if (server.id === "mcp-youtube") {
      adapter = new YouTubeAdapter(this.plugin, this.app);
    } else {
      throw new Error("Only built-in internal MCP servers are supported");
    }

    this.adapters.set(server.id, adapter);
    return adapter;
  }

  /**
   * Returns internal servers that are always available (filesystem, youtube).
   * These are hardcoded to always provide tools regardless of settings.
   */
  private getInternalServers(): InternalMCPServer[] {
    return [
      {
        id: "mcp-filesystem",
        name: "Filesystem Tools",
      },
      {
        id: "mcp-youtube",
        name: "YouTube Tools",
      }
    ];
  }

  async getAvailableTools(): Promise<ManagedToolDefinition[]> {
    // Internal servers (filesystem, youtube) are ALWAYS available - no settings checks
    const internalServers = this.getInternalServers();

    const serverToolsArrays = await Promise.all(
      internalServers.map(async (server) => {
        try {
          const tools = await this.getAdapterForServer(server).listTools();

          // Convert ALL tools from the server - no per-tool filtering
          const converted: ManagedToolDefinition[] = [];
          for (const tool of tools) {
            try {
              converted.push(this.convertToManagedTool(tool, server));
            } catch (error) {
              this.logger.warn(`[SystemSculpt] Failed to convert tool ${tool.name || 'unnamed'} from server ${server.name}:`, error);
            }
          }

          return converted;
        } catch (error) {
          this.logger.warn(`Failed to get tools from MCP server ${server.name}:`, error);
          return [] as ManagedToolDefinition[];
        }
      })
    );

    const allTools: ManagedToolDefinition[] = [];
    for (const arr of serverToolsArrays) allTools.push(...arr);
    return allTools;
  }

  private convertToManagedTool(tool: MCPToolInfo, server: InternalMCPServer): ManagedToolDefinition {
    if (!tool || !tool.name || tool.name.trim() === '') {
      this.logger.warn(`[SystemSculpt] Skipping tool with invalid name:`, tool);
      throw new Error(`Tool missing required name property`);
    }
    if (!server || !server.id) {
      this.logger.warn(`[SystemSculpt] Server missing valid ID:`, server);
      throw new Error(`Server missing required id property`);
    }

    const managedTool: ManagedToolDefinition = buildManagedToolDefinition({
      name: `${server.id}_${tool.name}`,
      description: `[${server.name}] ${tool.description || 'No description provided'}`,
      parameters: tool.inputSchema || {},
    });

    if (!managedTool.function.name || typeof managedTool.function.name !== 'string') {
      this.logger.error(`[SystemSculpt] Generated invalid managed tool:`, managedTool);
      throw new Error(`Failed to generate valid managed tool`);
    }

    return managedTool;
  }

  async executeTool(
    toolName: string,
    args: any,
    chatView?: any,
    options?: MCPExecutionOptions
  ): Promise<any> {
    if (options?.signal?.aborted) {
      throw new MCPToolExecutionError(
        'TOOL_CANCELLED_BEFORE_START',
        'Tool execution was cancelled before it started.',
      );
    }

    const resolvedToolName = resolveCanonicalToolAlias(toolName);
    const firstUnderscoreIndex = resolvedToolName.indexOf('_');
    if (firstUnderscoreIndex === -1) {
      throw new Error(`Invalid tool name format: ${toolName}`);
    }

    const serverId = resolvedToolName.substring(0, firstUnderscoreIndex);
    const actualToolName = resolvedToolName.substring(firstUnderscoreIndex + 1);

    // Internal servers are always available - no settings lookup needed
    const internalServerIds = ["mcp-filesystem", "mcp-youtube"];
    if (!internalServerIds.includes(serverId)) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    const server = this.getInternalServers().find(s => s.id === serverId)!;

    const adapter = this.getAdapterForServer(server);
    const mappedArgs = serverId === "mcp-filesystem"
      ? this.mapFilesystemArgs(actualToolName, args)
      : args;
    return await adapter.executeTool(actualToolName, mappedArgs, chatView, options);
  }

  public setFilesystemAllowedPaths(paths: string[]): void {
    const server: InternalMCPServer = {
      id: "mcp-filesystem",
      name: "Filesystem",
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
    const ensureStringArray = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value.map((entry) => String(entry ?? ""));
      }
      if (typeof value === "string") {
        return [value];
      }
      return [];
    };

    switch (toolName) {
      case "read":
      case "create_folders":
      case "list_items":
      case "trash":
      case "context":
        {
          const inputPaths = ensureStringArray((args as any).paths ?? (args as any).path);
          if (inputPaths.length > 0) {
            return { ...args, paths: inputPaths.map((p: string) => mapPath(p)) };
          }
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
        if (typeof (args as any).path === "string") {
          return {
            ...args,
            files: [{ path: mapPath(String((args as any).path)) }],
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

}
