/**
 * ToolCallManager - Single source of truth for all tool calls.
 *
 * Under PI-native orchestration we execute tool calls immediately after they are
 * emitted by the stream, without local approval or continuation choreography.
 */

import { TypedEventEmitter } from "../../core/TypedEventEmitter";
import {
  ToolCall,
  ToolCallState,
  ToolCallRequest,
  ToolCallResult,
  ToolCallEvents,
  ToolDefinition,
  ToolExecutor,
  ToolRegistryEntry,
  ToolExecutionOptions,
  SerializedToolCall,
} from "../../types/toolCalls";
import { MCPService } from "./MCPService";
import {
  splitToolName,
  resolveCanonicalToolAlias,
  getCanonicalAliasForMcpTool,
} from "../../utils/toolPolicy";
import { buildOpenAIToolDefinition } from "../../utils/tooling";
import { errorLogger } from "../../utils/errorLogger";

export class ToolCallManager {
  // Single source of truth - all tool calls by ID
  private toolCalls: Map<string, ToolCall> = new Map();

  // Tool registry - all available tools and their executors
  private toolRegistry: Map<string, ToolRegistryEntry> = new Map();

  // Event emitter for state changes
  private events: TypedEventEmitter<ToolCallEvents>;

  private mcpService: MCPService;
  private chatView?: any; // Reference to chat view for MCP runtime context

  // Context management constants
  private readonly MAX_TOOL_RESULT_SIZE = 10000; // 10KB max per tool result
  private readonly TRUNCATION_INDICATOR = "\n\n[... truncated for brevity ...]";

  private static readonly MCP_ALIAS_OVERRIDES: Record<string, string> = {
    "mcp-filesystem_search": "grep",
    "mcp-filesystem_list_items": "ls",
  };

  // Internal servers that are always available without settings checks
  private static readonly INTERNAL_SERVERS = new Set(["mcp-filesystem", "mcp-youtube"]);

  constructor(mcpService: MCPService, chatView?: any) {
    this.mcpService = mcpService;
    this.chatView = chatView;
    this.events = new TypedEventEmitter();
  }

  private resolveExecutableToolName(toolName: string): string {
    const name = String(toolName ?? "").trim();
    if (!name) return "";
    return resolveCanonicalToolAlias(name);
  }

  private getCanonicalAliasNameForMcpTool(toolName: string): string | null {
    const normalized = String(toolName ?? "").trim().toLowerCase();
    if (!normalized) return null;
    if (ToolCallManager.MCP_ALIAS_OVERRIDES[normalized]) {
      return ToolCallManager.MCP_ALIAS_OVERRIDES[normalized];
    }
    return getCanonicalAliasForMcpTool(normalized);
  }

  private normalizeToolArgs(toolName: string, rawArgs: any): any {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return rawArgs;
    }

    const normalizedName = String(toolName ?? "").trim().toLowerCase();
    if (!normalizedName.startsWith("mcp-filesystem_")) {
      return rawArgs;
    }

    const args = { ...(rawArgs as Record<string, any>) };
    const toString = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };
    const toStringArray = (value: unknown): string[] | null => {
      if (typeof value === "string") {
        const single = toString(value);
        return single ? [single] : null;
      }
      if (Array.isArray(value)) {
        const items = value
          .map((item) => toString(item))
          .filter((item): item is string => !!item);
        return items.length > 0 ? items : null;
      }
      return null;
    };

    switch (normalizedName) {
      case "mcp-filesystem_read":
      case "mcp-filesystem_list_items":
      case "mcp-filesystem_create_folders":
      case "mcp-filesystem_trash":
      case "mcp-filesystem_context": {
        if (!Array.isArray(args.paths)) {
          const paths = toStringArray(args.path ?? args.paths ?? args.file);
          if (paths) args.paths = paths;
        }
        break;
      }
      case "mcp-filesystem_find":
      case "mcp-filesystem_search": {
        if (!Array.isArray(args.patterns)) {
          const patterns = toStringArray(args.patterns ?? args.pattern ?? args.query ?? args.term);
          if (patterns) args.patterns = patterns;
        }
        break;
      }
      case "mcp-filesystem_move": {
        if (!Array.isArray(args.items)) {
          const source = toString(args.source ?? args.from ?? args.path);
          const destination = toString(args.destination ?? args.to ?? args.newPath ?? args.target);
          if (source && destination) {
            args.items = [{ source, destination }];
          }
        }
        break;
      }
      case "mcp-filesystem_open": {
        if (!Array.isArray(args.files)) {
          const paths = toStringArray(args.path ?? args.paths ?? args.file);
          if (paths) {
            args.files = paths.map((path) => ({ path }));
          }
        }
        break;
      }
      case "mcp-filesystem_edit": {
        if (!Array.isArray(args.edits)) {
          const oldText = toString(args.oldText ?? args.search);
          const newText = toString(args.newText ?? args.replace ?? "");
          if (oldText !== null && newText !== null) {
            const edit: Record<string, unknown> = { oldText, newText };
            if (typeof args.isRegex === "boolean") edit.isRegex = args.isRegex;
            if (typeof args.flags === "string") edit.flags = args.flags;
            if (typeof args.occurrence === "string") edit.occurrence = args.occurrence;
            if (typeof args.mode === "string") edit.mode = args.mode;
            if (typeof args.preserveIndent === "boolean") edit.preserveIndent = args.preserveIndent;
            if (args.range && typeof args.range === "object") edit.range = args.range;
            args.edits = [edit];
          }
        }
        break;
      }
      default:
        break;
    }

    return args;
  }

  /**
   * Provide OpenAI-compatible tools (internal registry + MCP).
   */
  public async getOpenAITools(): Promise<any[]> {
    const results: any[] = [];
    const seen = new Set<string>();
    const pushTool = (name: string, description: string, parameters: any, strict?: boolean): void => {
      const normalizedName = String(name ?? "").trim();
      if (!normalizedName || seen.has(normalizedName)) return;
      results.push(buildOpenAIToolDefinition({
        name: normalizedName,
        description,
        parameters,
        ...(typeof strict === "boolean" ? { strict } : {}),
      }));
      seen.add(normalizedName);
    };

    // Internal tools -> OpenAI function format
    for (const [, entry] of this.toolRegistry) {
      const def = entry.definition;
      pushTool(def.name, def.description, def.parameters, (def as any).strict);
    }

    // MCP tools are already returned in OpenAI format by MCPService
    const mcpTools = await this.mcpService.getAvailableTools();
    for (const tool of mcpTools) {
      const name = String(tool?.function?.name ?? "");
      const description = String(tool?.function?.description ?? "");
      const parameters = tool?.function?.parameters || {};

      pushTool(name, description, parameters);

      const alias = this.getCanonicalAliasNameForMcpTool(name);
      if (alias) {
        pushTool(alias, `${description} (PI canonical alias for ${name})`, parameters);
      }
    }

    return results;
  }

  /**
   * Subscribe to tool call events
   */
  public on<K extends keyof ToolCallEvents>(
    event: K,
    handler: (params: ToolCallEvents[K]) => void
  ): () => void {
    return this.events.on(event, handler);
  }

  private getToolAvailability(
    toolName: string
  ): { ok: true; serverId?: string } | { ok: false; serverId?: string; error: { code: string; message: string } } {
    const name = this.resolveExecutableToolName(toolName);
    if (name.length === 0) {
      return { ok: false, error: { code: "INVALID_TOOL_NAME", message: "Tool call is missing a function name." } };
    }

    if (name.startsWith("mcp-")) {
      const { serverId } = splitToolName(name);
      if (!serverId) {
        return { ok: false, error: { code: "INVALID_MCP_TOOL_NAME", message: `Invalid MCP tool name: ${name}` } };
      }

      const normalizedServerId = serverId.toLowerCase();

      // Internal servers (filesystem, youtube) are always available.
      if (ToolCallManager.INTERNAL_SERVERS.has(normalizedServerId)) {
        return { ok: true, serverId: normalizedServerId };
      }

      // For custom/external servers, only check if the server itself is disabled.
      const settings = this.chatView?.plugin?.settings ?? {};
      const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
      const server = servers.find((s: any) => String(s?.id ?? "").toLowerCase() === normalizedServerId);

      if (server && !server.isEnabled) {
        return {
          ok: false,
          serverId: normalizedServerId,
          error: { code: "MCP_SERVER_DISABLED", message: `MCP server is disabled: ${server.name || normalizedServerId}` },
        };
      }

      return { ok: true, serverId: normalizedServerId };
    }

    if (!this.toolRegistry.has(name)) {
      return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `Tool not found: ${name}` } };
    }

    return { ok: true };
  }

  /**
   * Create a new tool call from an LLM request and execute immediately.
   */
  public createToolCall(request: ToolCallRequest, messageId: string): ToolCall {
    const toolName = request?.function?.name ?? "";
    const executableToolName = this.resolveExecutableToolName(toolName);
    const availability = this.getToolAvailability(executableToolName);
    const now = Date.now();

    const toolCall: ToolCall = {
      id: request.id,
      messageId,
      request,
      state: availability.ok ? "executing" : "failed",
      timestamp: now,
      ...(availability.ok ? { executionStartedAt: now } : {}),
      ...(availability.serverId ? { serverId: availability.serverId } : {}),
      ...(!availability.ok ? { result: { success: false, error: availability.error } } : {}),
    };

    this.toolCalls.set(toolCall.id, toolCall);
    this.events.emit("tool-call:created", { toolCall });

    if (!availability.ok) {
      this.events.emit("tool-call:execution-failed", {
        toolCallId: toolCall.id,
        error: toolCall.result?.error,
        toolCall,
      });
      return toolCall;
    }

    this.events.emit("tool-call:execution-started", {
      toolCallId: toolCall.id,
      toolCall,
    });

    void this.executeToolCall(toolCall.id).catch((error) => {
      try {
        errorLogger.error("Unhandled tool execution error", error as Error, {
          source: "ToolCallManager",
          method: "createToolCall",
          metadata: { toolCallId: toolCall.id, toolName: executableToolName },
        });
      } catch {}
    });

    return toolCall;
  }

  /**
   * Get a tool call by ID
   */
  public getToolCall(id: string): ToolCall | undefined {
    return this.toolCalls.get(id);
  }

  /**
   * Get all tool calls for a message
   */
  public getToolCallsForMessage(messageId: string): ToolCall[] {
    return Array.from(this.toolCalls.values()).filter((tc) => tc.messageId === messageId);
  }

  /**
   * Update tool call state
   */
  private updateState(toolCallId: string, newState: ToolCallState): void {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      return;
    }

    const previousState = toolCall.state;
    toolCall.state = newState;

    this.events.emit("tool-call:state-changed", {
      toolCallId,
      previousState,
      newState,
      toolCall,
    });
  }

  public getDebugSnapshot(): {
    toolCalls: ToolCall[];
    toolRegistry: ToolDefinition[];
  } {
    return {
      toolCalls: Array.from(this.toolCalls.values()),
      toolRegistry: Array.from(this.toolRegistry.values()).map((entry) => entry.definition),
    };
  }

  /**
   * Execute a tool call
   */
  private async executeToolCall(toolCallId: string, options?: ToolExecutionOptions): Promise<void> {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall || toolCall.state !== "executing") {
      return;
    }

    try {
      const requestedToolName = toolCall.request.function.name;
      const executableToolName = this.resolveExecutableToolName(requestedToolName);

      errorLogger.debug("Starting tool call execution", {
        source: "ToolCallManager",
        method: "executeToolCall",
        metadata: {
          toolCallId,
          toolName: requestedToolName,
          executableToolName,
          messageId: toolCall.messageId,
        },
      });

      // Parse arguments (strict JSON; tool schemas enforce validity)
      let args: any;
      try {
        const raw = toolCall.request.function.arguments;
        args = raw && typeof raw === "string" ? JSON.parse(raw) : {};
      } catch (e: any) {
        throw new Error(`Invalid tool arguments JSON: ${e?.message || "Unknown parse error"}`);
      }
      const normalizedArgs = this.normalizeToolArgs(executableToolName, args);

      const result = await this.executeTool(executableToolName, normalizedArgs, options);

      toolCall.executionCompletedAt = Date.now();
      toolCall.result = result;
      this.updateState(toolCallId, result.success ? "completed" : "failed");

      if (result.success) {
        errorLogger.debug("Tool call completed successfully", {
          source: "ToolCallManager",
          method: "executeToolCall",
          metadata: {
            toolCallId,
            toolName: requestedToolName,
            executableToolName,
            messageId: toolCall.messageId,
            executionTime: toolCall.executionCompletedAt - (toolCall.executionStartedAt || 0),
          },
        });

        this.events.emit("tool-call:execution-completed", {
          toolCallId,
          result,
          toolCall,
        });
      } else {
        errorLogger.debug("Tool call failed", {
          source: "ToolCallManager",
          method: "executeToolCall",
          metadata: {
            toolCallId,
            toolName: requestedToolName,
            executableToolName,
            messageId: toolCall.messageId,
            executionTime: toolCall.executionCompletedAt - (toolCall.executionStartedAt || 0),
            error: result.error,
          },
        });

        this.events.emit("tool-call:execution-failed", {
          toolCallId,
          error: result.error,
          toolCall,
        });
      }
    } catch (error: any) {
      const errorResult: ToolCallResult = {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message: error?.message || "Unknown error",
          details: error,
        },
      };

      toolCall.executionCompletedAt = Date.now();
      toolCall.result = errorResult;
      this.updateState(toolCallId, "failed");

      this.events.emit("tool-call:execution-failed", {
        toolCallId,
        error: errorResult.error,
        toolCall,
      });
    }
  }

  /**
   * Execute a tool by name
   */
  private async executeTool(
    toolName: string,
    args: any,
    options?: ToolExecutionOptions
  ): Promise<ToolCallResult> {
    try {
      const executableToolName = this.resolveExecutableToolName(toolName);
      const normalizedArgs = this.normalizeToolArgs(executableToolName, args);
      let resultData: any;
      if (executableToolName.startsWith("mcp-")) {
        resultData = await this.mcpService.executeTool(
          executableToolName,
          normalizedArgs,
          this.chatView,
          { timeoutMs: 0 }
        );
      } else {
        const tool = this.toolRegistry.get(executableToolName);
        if (tool) {
          resultData = await tool.executor(normalizedArgs, options);
        } else {
          throw new Error(`Tool not found: ${executableToolName}`);
        }
      }

      const processedData = this.processToolResult(resultData, executableToolName);

      return {
        success: true,
        data: processedData,
      };
    } catch (error: any) {
      const providedCode = typeof error?.code === "string" ? error.code : null;
      const message = error instanceof Error ? error.message : String(error ?? "Tool execution failed");
      return {
        success: false,
        error: {
          code: providedCode || "TOOL_EXECUTION_ERROR",
          message: message || "Tool execution failed",
          details: error,
        },
      };
    }
  }

  /**
   * Register a tool
   */
  public registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
    this.toolRegistry.set(definition.name, { definition, executor });
  }

  /**
   * Get all available tools (internal + MCP)
   */
  public async getAvailableTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];

    // Add internal tools
    for (const [, entry] of this.toolRegistry) {
      tools.push(entry.definition);
    }

    // Add MCP tools
    if (this.mcpService) {
      const mcpTools = await this.mcpService.getAvailableTools();
      for (const tool of mcpTools) {
        // OpenAI tools already have the full prefixed name
        tools.push({
          name: tool.function.name,
          description: tool.function.description || "",
          parameters: (tool.function.parameters as any) || { type: "object", properties: {} },
        });
      }
    }

    return tools;
  }

  /**
   * Serialize tool calls for persistence
   */
  public serializeToolCall(toolCallId: string): SerializedToolCall | undefined {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      return undefined;
    }

    return {
      id: toolCall.id,
      request: toolCall.request,
      state: toolCall.state,
      timestamp: toolCall.timestamp,
      executionStartedAt: toolCall.executionStartedAt,
      executionCompletedAt: toolCall.executionCompletedAt,
      result: toolCall.result,
    };
  }

  /**
   * Deserialize and restore tool calls
   */
  public restoreToolCall(serialized: SerializedToolCall, messageId: string): ToolCall {
    const toolCall: ToolCall = {
      ...serialized,
      messageId,
    };

    this.toolCalls.set(toolCall.id, toolCall);
    return toolCall;
  }

  /**
   * Clear all tool calls (useful for cleanup)
   */
  public clear(): void {
    this.toolCalls.clear();
    this.events.clear();
  }

  /**
   * Process and truncate tool results to prevent context bloat.
   */
  public processToolResult(data: any, toolName: string): any {
    if (!data) return data;

    try {
      const serialized = JSON.stringify(data);

      // If result is under size limit, return as-is
      if (serialized.length <= this.MAX_TOOL_RESULT_SIZE) {
        return data;
      }

      // Apply intelligent truncation based on tool type
      return this.truncateToolResult(data, toolName, serialized);
    } catch (error: any) {
      // Return a safe fallback object if JSON serialization fails
      return {
        error: "Tool result processing failed",
        originalType: typeof data,
        toolName,
        details: error?.message || "Unknown error",
      };
    }
  }

  /**
   * Intelligently truncate tool results based on tool type and content
   */
  private truncateToolResult(data: any, toolName: string, serialized: string): any {
    // For file reading operations, truncate content but keep metadata
    if (toolName.includes("read") || toolName.includes("file")) {
      return this.truncateFileResult(data);
    }

    // For search operations, limit number of results
    if (toolName.includes("search") || toolName.includes("find")) {
      return this.truncateSearchResult(data);
    }

    // For list operations, limit items and show count
    if (toolName.includes("list") || toolName.includes("directory")) {
      return this.truncateListResult(data);
    }

    // For common text-heavy tool responses, truncate `text` but preserve structure/metadata.
    if (typeof data === "object" && data && typeof data.text === "string") {
      return this.truncateTextResult(data);
    }

    // Generic truncation for other JSON data
    const maxLength = this.MAX_TOOL_RESULT_SIZE - this.TRUNCATION_INDICATOR.length;

    if (serialized.length > maxLength) {
      let truncated = serialized.substring(0, maxLength);

      // Ensure the truncated string is valid JSON
      // Find the last complete JSON structure (object or array)
      let lastValidJson = "";
      const maxAttempts = Math.min(1000, truncated.length); // Limit parsing attempts

      for (let i = truncated.length; i > truncated.length - maxAttempts && i > 0; i--) {
        try {
          const candidate = truncated.substring(0, i);
          JSON.parse(candidate);
          lastValidJson = candidate;
          break;
        } catch {
          // Continue - this is expected for most attempts
        }
      }

      if (lastValidJson) {
        try {
          const parsed = JSON.parse(lastValidJson);
          if (typeof parsed === "object" && parsed !== null) {
            // Add truncation indicator to a new field
            (parsed as any).truncation_info = "Result truncated due to size limit.";
            return parsed;
          }
        } catch {
          // fall through to structured fallback
        }
      }

      // Fallback: Return a structured object instead of potentially invalid JSON
      return {
        truncated_content: truncated.substring(0, maxLength - 100),
        truncation_info: "Result truncated due to size limit. Original format could not be preserved.",
        original_length: serialized.length,
      };
    }

    return data;
  }

  /**
   * Truncate file reading results - keep metadata, truncate content
   */
  private truncateFileResult(data: any): any {
    if (typeof data === "object" && data.content) {
      const maxContentLength = this.MAX_TOOL_RESULT_SIZE - 500; // Reserve space for metadata
      return {
        ...data,
        content:
          data.content.length > maxContentLength
            ? data.content.substring(0, maxContentLength) + this.TRUNCATION_INDICATOR
            : data.content,
        truncated: data.content.length > maxContentLength,
        originalLength: data.content.length,
      };
    }
    return data;
  }

  /**
   * Truncate text-heavy results while preserving structure (e.g. transcripts, extracted text).
   */
  private truncateTextResult(data: any): any {
    if (typeof data === "object" && data && typeof data.text === "string") {
      const maxTextLength = this.MAX_TOOL_RESULT_SIZE - 500; // Reserve space for metadata
      return {
        ...data,
        text:
          data.text.length > maxTextLength
            ? data.text.substring(0, maxTextLength) + this.TRUNCATION_INDICATOR
            : data.text,
        truncated: data.text.length > maxTextLength,
        originalLength: data.text.length,
      };
    }
    return data;
  }

  /**
   * Truncate search results - limit number of matches
   */
  private truncateSearchResult(data: any): any {
    if (Array.isArray(data)) {
      const maxResults = 10;
      return {
        results: data.slice(0, maxResults),
        totalFound: data.length,
        truncated: data.length > maxResults,
        showingFirst: maxResults,
      };
    }

    if (typeof data === "object" && data.results && Array.isArray(data.results)) {
      const maxResults = 10;
      return {
        ...data,
        results: data.results.slice(0, maxResults),
        totalFound: data.results.length,
        truncated: data.results.length > maxResults,
        showingFirst: maxResults,
      };
    }

    return data;
  }

  /**
   * Truncate list results - limit items and show summary
   */
  private truncateListResult(data: any): any {
    if (Array.isArray(data)) {
      const maxItems = 20;
      return {
        items: data.slice(0, maxItems),
        totalCount: data.length,
        truncated: data.length > maxItems,
        showingFirst: maxItems,
      };
    }

    if (typeof data === "object" && data.files && Array.isArray(data.files)) {
      const maxFiles = 20;
      return {
        ...data,
        files: data.files.slice(0, maxFiles),
        totalFiles: data.files.length,
        truncated: data.files.length > maxFiles,
        showingFirst: maxFiles,
      };
    }

    return data;
  }

  /**
   * Get all terminal tool results for context (no local hard cap).
   */
  public getToolResultsForContext(): ToolCall[] {
    return Array.from(this.toolCalls.values())
      .filter((tc) => (tc.state === "completed" || tc.state === "failed") && !!tc.result)
      .sort((a, b) => {
        const aKey = a.executionCompletedAt || a.executionStartedAt || a.timestamp;
        const bKey = b.executionCompletedAt || b.executionStartedAt || b.timestamp;
        return bKey - aKey;
      });
  }
}
