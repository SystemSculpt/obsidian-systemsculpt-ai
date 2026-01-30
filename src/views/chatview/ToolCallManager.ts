/**
 * ToolCallManager - Single source of truth for all tool calls
 * 
 * This service manages the entire lifecycle of tool calls from creation to completion.
 * It provides a unified interface for all components to interact with tool calls,
 * ensuring consistency and eliminating duplicate state management.
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
  SerializedToolCall
} from "../../types/toolCalls";
import { MCPService } from "./MCPService";
import { splitToolName, requiresUserApproval } from "../../utils/toolPolicy";
import { buildOpenAIToolDefinition, buildToolCallSignature, TOOL_LOOP_ERROR_CODE } from "../../utils/tooling";
import { errorLogger } from "../../utils/errorLogger";

export class ToolCallManager {
  // Single source of truth - all tool calls by ID
  private toolCalls: Map<string, ToolCall> = new Map();
  
  // Tool registry - all available tools and their executors
  private toolRegistry: Map<string, ToolRegistryEntry> = new Map();
  
  // Event emitter for state changes
  private events: TypedEventEmitter<ToolCallEvents>;
  
  private mcpService: MCPService;
  private chatView?: any; // Reference to chat view for agent mode check
  
  // Context management constants
  private readonly MAX_TOOL_RESULT_SIZE = 10000; // 10KB max per tool result
  private readonly TRUNCATION_INDICATOR = "\n\n[... truncated for brevity ...]";

  // Tool execution scheduler (limits concurrency and applies per-call timeouts)
  private readonly executionQueue: Array<{ toolCallId: string; options?: ToolExecutionOptions }> = [];
  private activeExecutions = 0;

  // Loop guard: prevent repeated failed/denied tool calls within a single assistant turn
  private readonly MAX_FAILED_TOOL_REPEAT_ATTEMPTS = 2;
  private readonly MAX_DENIED_TOOL_REPEAT_ATTEMPTS = 1;

  // Obsidian Bases (.base) YAML validation loop guard
  private readonly MAX_BASE_YAML_RETRY_ATTEMPTS = 3;
  private readonly BASE_YAML_RETRY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private readonly baseYamlValidationFailures: Map<string, { count: number; lastAt: number }> = new Map();

  constructor(mcpService: MCPService, chatView?: any) {
    this.mcpService = mcpService;
    this.chatView = chatView;
    this.events = new TypedEventEmitter();
  }

  private getToolingConcurrencyLimit(): number {
    const raw = Number(this.chatView?.plugin?.settings?.toolingConcurrencyLimit);
    if (!Number.isFinite(raw)) return 3;
    return Math.max(1, Math.min(8, Math.floor(raw)));
  }

  private getToolingToolCallTimeoutMs(): number {
    const raw = Number(this.chatView?.plugin?.settings?.toolingToolCallTimeoutMs);
    if (!Number.isFinite(raw)) return 30000;
    return Math.max(0, Math.min(10 * 60 * 1000, Math.floor(raw)));
  }

  private getRequireDestructiveApproval(): boolean {
    const raw = this.chatView?.plugin?.settings?.toolingRequireApprovalForDestructiveTools;
    return raw !== false;
  }

  private getAutoApproveAllowlist(): string[] {
    return (this.chatView?.plugin?.settings?.mcpAutoAcceptTools || []).slice();
  }

  public getMaxToolResultsInContext(): number {
    const raw = Number(this.chatView?.plugin?.settings?.toolingMaxToolResultsInContext);
    if (!Number.isFinite(raw)) return 15;
    return Math.max(1, Math.min(50, Math.floor(raw)));
  }

  private enqueueExecution(toolCallId: string, options?: ToolExecutionOptions): void {
    this.executionQueue.push({ toolCallId, options });
    this.drainExecutionQueue();
  }

  private drainExecutionQueue(): void {
    const limit = this.getToolingConcurrencyLimit();
    while (this.activeExecutions < limit && this.executionQueue.length > 0) {
      const next = this.executionQueue.shift();
      if (!next) break;

      this.activeExecutions += 1;
      void this.executeToolCall(next.toolCallId, next.options)
        .catch(() => {})
        .finally(() => {
          this.activeExecutions -= 1;
          this.drainExecutionQueue();
        });
    }
  }

  /**
   * Determine if a tool should be auto-approved without user confirmation.
   * Returns false for destructive tools (write, edit, move, trash) and external MCP tools
   * unless trusted for this session, allowlisted, or approvals are disabled in settings.
   */
  public shouldAutoApprove(toolName: string): boolean {
    const trustedToolNames = this.chatView?.trustedToolNames ?? new Set<string>();
    return !requiresUserApproval(toolName, {
      trustedToolNames,
      requireDestructiveApproval: this.getRequireDestructiveApproval(),
      autoApproveAllowlist: this.getAutoApproveAllowlist(),
    });
  }

  /**
   * Provide OpenAI-compatible tools (internal registry + MCP).
   */
  public async getOpenAITools(): Promise<any[]> {
    const results: any[] = [];

    // Internal tools → OpenAI function format
    for (const [name, entry] of this.toolRegistry) {
      const def = entry.definition;
      results.push(buildOpenAIToolDefinition({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        strict: (def as any).strict,
      }));
    }

    // MCP tools are already returned in OpenAI format by MCPService
    const mcpTools = await this.mcpService.getAvailableTools();
    for (const tool of mcpTools) {
      results.push(buildOpenAIToolDefinition({
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters || {},
      }));
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

  /**
   * Create a new tool call from an LLM request
   */
  // Internal servers that are always available without settings checks
  private static readonly INTERNAL_SERVERS = new Set(['mcp-filesystem', 'mcp-youtube']);

  private getToolAvailability(toolName: string): { ok: true; serverId?: string } | { ok: false; serverId?: string; error: { code: string; message: string } } {
    const name = String(toolName ?? "").trim();
    if (name.length === 0) {
      return { ok: false, error: { code: "INVALID_TOOL_NAME", message: "Tool call is missing a function name." } };
    }

    if (name.startsWith("mcp-")) {
      const { serverId, canonicalName } = splitToolName(name);
      if (!serverId) {
        return { ok: false, error: { code: "INVALID_MCP_TOOL_NAME", message: `Invalid MCP tool name: ${name}` } };
      }

      const normalizedServerId = serverId.toLowerCase();

      // Internal servers (filesystem, youtube) are ALWAYS available - no settings checks
      if (ToolCallManager.INTERNAL_SERVERS.has(normalizedServerId)) {
        return { ok: true, serverId: normalizedServerId };
      }

      // For custom/external servers, only check if the server itself is disabled
      // (no global mcpEnabled check, no per-tool mcpEnabledTools filtering)
      const settings = this.chatView?.plugin?.settings ?? {};
      const servers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
      const server = servers.find((s: any) => String(s?.id ?? "").toLowerCase() === normalizedServerId);

      // If server not found in settings, it might be a dynamically registered server - allow it
      if (server && !server.isEnabled) {
        return {
          ok: false,
          serverId: normalizedServerId,
          error: { code: "MCP_SERVER_DISABLED", message: `MCP server is disabled: ${server.name || normalizedServerId}` },
        };
      }

      // All tools from enabled (or unknown) servers are available
      return { ok: true, serverId: normalizedServerId };
    }

    if (!this.toolRegistry.has(name)) {
      return { ok: false, error: { code: "TOOL_NOT_FOUND", message: `Tool not found: ${name}` } };
    }

    return { ok: true };
  }

  private getToolCallSignature(request: ToolCallRequest): string | null {
    const toolName = request?.function?.name ?? "";
    if (!toolName) return null;
    return buildToolCallSignature(toolName, request?.function?.arguments);
  }

  private getToolCallRepeatStats(messageId: string, signature: string): { failed: number; denied: number } {
    let failed = 0;
    let denied = 0;

    for (const call of this.toolCalls.values()) {
      if (call.messageId !== messageId) continue;
      const toolName = call.request?.function?.name ?? "";
      if (!toolName) continue;
      const callSignature = buildToolCallSignature(toolName, call.request?.function?.arguments);
      if (callSignature !== signature) continue;

      if (call.state === "denied" || call.result?.error?.code === "USER_DENIED") {
        denied += 1;
        continue;
      }

      if (call.state === "failed" || (call.state === "completed" && call.result && call.result.success === false)) {
        failed += 1;
      }
    }

    return { failed, denied };
  }

  private getRepeatBlockMessage(stats: { failed: number; denied: number }): string | null {
    if (stats.denied >= this.MAX_DENIED_TOOL_REPEAT_ATTEMPTS) {
      const attempts = stats.denied;
      return `Tool call was denied ${attempts} time${attempts === 1 ? "" : "s"} for this request. Repeating the same tool call is blocked to prevent an agent loop. Update the instructions and try again.`;
    }

    if (stats.failed >= this.MAX_FAILED_TOOL_REPEAT_ATTEMPTS) {
      const attempts = stats.failed;
      return `Tool call failed ${attempts} time${attempts === 1 ? "" : "s"} for this request (retry limit ${this.MAX_FAILED_TOOL_REPEAT_ATTEMPTS}). Repeating the same tool call is blocked to prevent an agent loop. Fix the underlying issue and try again.`;
    }

    return null;
  }

  public createToolCall(
    request: ToolCallRequest,
    messageId: string,
    autoApprove: boolean = false
  ): ToolCall {
    const toolName = request?.function?.name ?? '';
    const availability = this.getToolAvailability(toolName);
    const effectiveAutoApprove = availability.ok ? (autoApprove || (toolName ? this.shouldAutoApprove(toolName) : false)) : false;

    if (availability.ok) {
      const signature = this.getToolCallSignature(request);
      if (signature) {
        const repeatStats = this.getToolCallRepeatStats(messageId, signature);
        const repeatMessage = this.getRepeatBlockMessage(repeatStats);
        if (repeatMessage) {
          const blockedToolCall: ToolCall = {
            id: request.id,
            messageId,
            request,
            state: "failed",
            timestamp: Date.now(),
            autoApproved: false,
            ...(availability.serverId ? { serverId: availability.serverId } : {}),
            result: {
              success: false,
              error: {
                code: TOOL_LOOP_ERROR_CODE,
                message: repeatMessage,
                details: {
                  signature,
                  failedAttempts: repeatStats.failed,
                  deniedAttempts: repeatStats.denied,
                  maxFailedAttempts: this.MAX_FAILED_TOOL_REPEAT_ATTEMPTS,
                  maxDeniedAttempts: this.MAX_DENIED_TOOL_REPEAT_ATTEMPTS,
                },
              },
            },
          };

          this.toolCalls.set(blockedToolCall.id, blockedToolCall);
          this.events.emit('tool-call:created', { toolCall: blockedToolCall });
          try {
            errorLogger.debug("Blocked repeated tool call to prevent loop", {
              source: "ToolCallManager",
              method: "createToolCall",
              metadata: {
                messageId,
                toolCallId: blockedToolCall.id,
                toolName,
                repeatStats,
              },
            });
          } catch {}
          return blockedToolCall;
        }
      }
    }

    const toolCall: ToolCall = {
      id: request.id,
      messageId,
      request,
      state: availability.ok ? 'pending' : 'failed',
      timestamp: Date.now(),
      autoApproved: effectiveAutoApprove,
      ...(availability.serverId ? { serverId: availability.serverId } : {}),
      ...(!availability.ok ? { result: { success: false, error: availability.error } } : {}),
    };

    // Store in our map
    this.toolCalls.set(toolCall.id, toolCall);

    // Emit creation event
    this.events.emit('tool-call:created', { toolCall });

    if (!availability.ok) {
      return toolCall;
    }

    // Auto-approve if configured
    if (effectiveAutoApprove) {
      this.approveToolCall(toolCall.id);
    }

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
    return Array.from(this.toolCalls.values())
      .filter(tc => tc.messageId === messageId);
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

    // Emit state change event
    this.events.emit('tool-call:state-changed', {
      toolCallId,
      previousState,
      newState,
      toolCall
    });
  }

  /**
   * Approve a tool call
   */
  public approveToolCall(toolCallId: string): void {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall || toolCall.state !== 'pending') {
      return;
    }

    toolCall.approvedAt = Date.now();
    this.updateState(toolCallId, 'approved');
    this.events.emit('tool-call:approved', { toolCallId, toolCall });

    this.enqueueExecution(toolCallId);
  }

  /**
   * Deny a tool call
   */
  public denyToolCall(toolCallId: string): void {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall || toolCall.state !== 'pending') {
      return;
    }

    // Add a standard result object for explicit user denial
    toolCall.result = {
      success: false,
      error: {
        code: 'USER_DENIED',
        message: 'The user has explicitly denied this tool call request.',
      },
    };

    this.updateState(toolCallId, 'denied');
    this.events.emit('tool-call:denied', { toolCallId, toolCall });
  }

  /**
   * Cancels a pending tool call with a specific reason.
   * This is used when the user sends a follow-up message instead of approving.
   */
  public cancelToolCall(toolCallId: string, reason: string): void {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall || toolCall.state !== 'pending') {
      return;
    }

    toolCall.result = {
      success: false,
      error: {
        code: 'USER_CANCELED',
        message: reason,
      },
    };

    this.updateState(toolCallId, 'denied');
    this.events.emit('tool-call:denied', { toolCallId, toolCall });
  }

  /**
   * Retrieves all tool calls currently in the 'pending' state.
   */
  public getPendingToolCalls(): ToolCall[] {
    const pending: ToolCall[] = [];
    for (const toolCall of this.toolCalls.values()) {
      if (toolCall.state === 'pending') {
        pending.push(toolCall);
      }
    }
    return pending;
  }

  public getDebugSnapshot(): {
    toolCalls: ToolCall[];
    pendingToolCalls: ToolCall[];
    executionQueueDepth: number;
    executionQueue: Array<{
      toolCallId: string;
      options?: {
        timeout?: number;
        retries?: number;
        sourceFilePath?: string;
      };
    }>;
    activeExecutions: number;
    toolRegistry: ToolDefinition[];
    settings: {
      autoApprovePolicy: {
        requireDestructiveApproval: boolean;
        autoApproveAllowlist: string[];
      };
      concurrencyLimit: number;
      toolCallTimeoutMs: number;
      maxToolResultsInContext: number;
    };
  } {
    const executionQueue = this.executionQueue.map((entry) => ({
      toolCallId: entry.toolCallId,
      options: entry.options
        ? {
            timeout: entry.options.timeout,
            retries: entry.options.retries,
            sourceFilePath: entry.options.sourceFile?.path,
          }
        : undefined,
    }));

    return {
      toolCalls: Array.from(this.toolCalls.values()),
      pendingToolCalls: this.getPendingToolCalls(),
      executionQueueDepth: this.executionQueue.length,
      executionQueue,
      activeExecutions: this.activeExecutions,
      toolRegistry: Array.from(this.toolRegistry.values()).map((entry) => entry.definition),
      settings: {
        autoApprovePolicy: {
          requireDestructiveApproval: this.getRequireDestructiveApproval(),
          autoApproveAllowlist: this.getAutoApproveAllowlist(),
        },
        concurrencyLimit: this.getToolingConcurrencyLimit(),
        toolCallTimeoutMs: this.getToolingToolCallTimeoutMs(),
        maxToolResultsInContext: this.getMaxToolResultsInContext(),
      },
    };
  }

  /**
   * Execute a tool call
   */
  private async executeToolCall(
    toolCallId: string,
    options?: ToolExecutionOptions
  ): Promise<void> {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall || toolCall.state !== 'approved') {
      return;
    }

    try {
      // Update state to executing
      toolCall.executionStartedAt = Date.now();
      this.updateState(toolCallId, 'executing');

      errorLogger.debug('Starting tool call execution', {
        source: 'ToolCallManager',
        method: 'executeToolCall',
        metadata: {
          toolCallId,
          toolName: toolCall.request.function.name,
          messageId: toolCall.messageId,
          autoApproved: toolCall.autoApproved,
        },
      });

      this.events.emit('tool-call:execution-started', { toolCallId, toolCall });

      // Parse arguments (strict JSON; tool schemas enforce validity)
      let args: any;
      try {
        const raw = toolCall.request.function.arguments;
        args = raw && typeof raw === "string" ? JSON.parse(raw) : {};
      } catch (e: any) {
        throw new Error(`Invalid tool arguments JSON: ${e?.message || 'Unknown parse error'}`);
      }

      // Execute the tool, respecting timeouts and concurrency limits
      let result = await this.executeToolWithTimeout(toolCall.request.function.name, args, options);
      result = this.applyBaseYamlRetryGuard(toolCall.request.function.name, args, result);

      // Update with result
      toolCall.executionCompletedAt = Date.now();
      toolCall.result = result;
      this.updateState(toolCallId, result.success ? 'completed' : 'failed');

      if (result.success) {
        errorLogger.debug('Tool call completed successfully', {
          source: 'ToolCallManager',
          method: 'executeToolCall',
          metadata: {
            toolCallId,
            toolName: toolCall.request.function.name,
            messageId: toolCall.messageId,
            executionTime: toolCall.executionCompletedAt - (toolCall.executionStartedAt || 0),
          },
        });

        this.events.emit('tool-call:execution-completed', {
          toolCallId,
          result,
          toolCall
        });
      } else {
        errorLogger.debug('Tool call failed', {
          source: 'ToolCallManager',
          method: 'executeToolCall',
          metadata: {
            toolCallId,
            toolName: toolCall.request.function.name,
            messageId: toolCall.messageId,
            executionTime: toolCall.executionCompletedAt - (toolCall.executionStartedAt || 0),
            error: result.error,
          },
        });

        this.events.emit('tool-call:execution-failed', {
          toolCallId,
          error: result.error,
          toolCall
        });
      }

    } catch (error) {
      // Handle execution errors
      const errorResult: ToolCallResult = {
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error.message || 'Unknown error',
          details: error
        }
      };

      toolCall.executionCompletedAt = Date.now();
      toolCall.result = errorResult;
      this.updateState(toolCallId, 'failed');
      
      this.events.emit('tool-call:execution-failed', { 
        toolCallId, 
        error: errorResult.error,
        toolCall 
      });
    }
  }

  private applyBaseYamlRetryGuard(toolName: string, args: any, result: ToolCallResult): ToolCallResult {
    const name = String(toolName ?? "");
    if (!name.startsWith("mcp-filesystem_")) return result;
    if (!(name.endsWith("_write") || name.endsWith("_edit"))) return result;

    const rawPath = args && typeof args.path === "string" ? args.path : "";
    const path = String(rawPath ?? "").trim();
    if (!path || !path.toLowerCase().endsWith(".base")) return result;

    const key = path.toLowerCase();

    if (result.success) {
      this.baseYamlValidationFailures.delete(key);
      return result;
    }

    if (result.error?.code !== "BASE_YAML_INVALID") {
      return result;
    }

    const now = Date.now();
    const prev = this.baseYamlValidationFailures.get(key);
    const baseCount = prev && now - prev.lastAt <= this.BASE_YAML_RETRY_WINDOW_MS ? prev.count : 0;
    const count = baseCount + 1;
    this.baseYamlValidationFailures.set(key, { count, lastAt: now });

    const error = {
      ...(result.error || {}),
      details: {
        ...(result.error?.details || {}),
        path,
        attempts: count,
        maxAttempts: this.MAX_BASE_YAML_RETRY_ATTEMPTS,
      },
    };

    if (count >= this.MAX_BASE_YAML_RETRY_ATTEMPTS) {
      return {
        success: false,
        error: {
          ...error,
          code: TOOL_LOOP_ERROR_CODE,
          message:
            `Stopped after ${this.MAX_BASE_YAML_RETRY_ATTEMPTS} invalid YAML attempts writing ${path}. ` +
            "Fix the YAML and try again.",
          details: {
            ...(error.details || {}),
            originalCode: "BASE_YAML_INVALID",
          },
        },
      };
    }

    const attemptLine = `\n\nBases YAML validation failed (attempt ${count}/${this.MAX_BASE_YAML_RETRY_ATTEMPTS}). Fix the YAML and retry.`;
    return {
      success: false,
      error: {
        ...error,
        message: `${error.message || "Invalid YAML."}${attemptLine}`,
      },
    };
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
      let resultData: any;
      if (toolName.startsWith("mcp-")) {
        resultData = await this.mcpService.executeTool(
          toolName,
          args,
          this.chatView, // Pass chatView for additional agent mode check
          { timeoutMs: this.getToolingToolCallTimeoutMs() }
        );
      } else {
        const tool = this.toolRegistry.get(toolName);
        if (tool) {
          resultData = await tool.executor(args, options);
        } else {
          throw new Error(`Tool not found: ${toolName}`);
        }
      }

      // Apply size limits and truncation to prevent context bloat
      const processedData = this.processToolResult(resultData, toolName);
      
      return {
        success: true,
        data: processedData
      };
    } catch (error: any) {
      const providedCode = typeof error?.code === "string" ? error.code : null;
      const message = error instanceof Error ? error.message : String(error ?? "Tool execution failed");
      return {
        success: false,
        error: {
          code: providedCode || 'TOOL_EXECUTION_ERROR',
          message: message || 'Tool execution failed',
          details: error
        }
      };
    }
  }

  private async executeToolWithTimeout(
    toolName: string,
    args: any,
    options?: ToolExecutionOptions
  ): Promise<ToolCallResult> {
    const timeoutMs = this.getToolingToolCallTimeoutMs();
    if (!timeoutMs) {
      return await this.executeTool(toolName, args, options);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.executeTool(toolName, args, options),
        new Promise<ToolCallResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              success: false,
              error: {
                code: "TIMEOUT",
                message: `Tool call timed out after ${timeoutMs}ms`,
              },
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
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
    for (const [name, entry] of this.toolRegistry) {
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
          autoApprove: false // MCP tools require approval by default
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
      approvedAt: toolCall.approvedAt,
      executionStartedAt: toolCall.executionStartedAt,
      executionCompletedAt: toolCall.executionCompletedAt,
      result: toolCall.result,
      autoApproved: toolCall.autoApproved
    };
  }

  /**
   * Deserialize and restore tool calls
   */
  public restoreToolCall(serialized: SerializedToolCall, messageId: string): ToolCall {
    const toolCall: ToolCall = {
      ...serialized,
      messageId
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
   * Process and truncate tool results to prevent context bloat
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
    } catch (error) {
      // Return a safe fallback object if JSON serialization fails
      return {
        error: 'Tool result processing failed',
        originalType: typeof data,
        toolName: toolName,
        details: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Intelligently truncate tool results based on tool type and content
   */
 private truncateToolResult(data: any, toolName: string, serialized: string): any {
    // For file reading operations, truncate content but keep metadata
    if (toolName.includes('read') || toolName.includes('file')) {
      return this.truncateFileResult(data);
    }
    
    // For search operations, limit number of results
    if (toolName.includes('search') || toolName.includes('find')) {
      return this.truncateSearchResult(data);
    }
    
    // For list operations, limit items and show count
    if (toolName.includes('list') || toolName.includes('directory')) {
      return this.truncateListResult(data);
    }

    // For common text-heavy tool responses, truncate `text` but preserve structure/metadata.
    if (typeof data === 'object' && data && typeof data.text === 'string') {
      return this.truncateTextResult(data);
    }
    
    // Generic truncation for other JSON data
    const maxLength = this.MAX_TOOL_RESULT_SIZE - this.TRUNCATION_INDICATOR.length;
    
    if (serialized.length > maxLength) {
      let truncated = serialized.substring(0, maxLength);
      
      // Ensure the truncated string is valid JSON
      // Find the last complete JSON structure (object or array)
      let lastValidJson = '';
      const maxAttempts = Math.min(1000, truncated.length); // Limit parsing attempts
      
      for (let i = truncated.length; i > truncated.length - maxAttempts && i > 0; i--) {
        try {
          const candidate = truncated.substring(0, i);
          JSON.parse(candidate);
          lastValidJson = candidate;
          break;
        } catch (e) {
          // Continue - this is expected for most attempts
        }
      }
      
      if (lastValidJson) {
        try {
          const parsed = JSON.parse(lastValidJson);
          if (typeof parsed === 'object' && parsed !== null) {
            // Add truncation indicator to a new field
            parsed.truncation_info = 'Result truncated due to size limit.';
            return parsed;
          }
        } catch (e) {
        }
      }
      
      // Fallback: Return a structured object instead of potentially invalid JSON
      return {
        truncated_content: truncated.substring(0, maxLength - 100),
        truncation_info: 'Result truncated due to size limit. Original format could not be preserved.',
        original_length: serialized.length
      };
    }

    return data;
  }

  /**
   * Truncate file reading results - keep metadata, truncate content
   */
  private truncateFileResult(data: any): any {
    if (typeof data === 'object' && data.content) {
      const maxContentLength = this.MAX_TOOL_RESULT_SIZE - 500; // Reserve space for metadata
      return {
        ...data,
        content: data.content.length > maxContentLength 
          ? data.content.substring(0, maxContentLength) + this.TRUNCATION_INDICATOR
          : data.content,
        truncated: data.content.length > maxContentLength,
        originalLength: data.content.length
      };
    }
    return data;
  }

  /**
   * Truncate text-heavy results while preserving structure (e.g. transcripts, extracted text).
   */
  private truncateTextResult(data: any): any {
    if (typeof data === 'object' && data && typeof data.text === 'string') {
      const maxTextLength = this.MAX_TOOL_RESULT_SIZE - 500; // Reserve space for metadata
      return {
        ...data,
        text: data.text.length > maxTextLength
          ? data.text.substring(0, maxTextLength) + this.TRUNCATION_INDICATOR
          : data.text,
        truncated: data.text.length > maxTextLength,
        originalLength: data.text.length
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
        showingFirst: maxResults
      };
    }
    
    if (typeof data === 'object' && data.results && Array.isArray(data.results)) {
      const maxResults = 10;
      return {
        ...data,
        results: data.results.slice(0, maxResults),
        totalFound: data.results.length,
        truncated: data.results.length > maxResults,
        showingFirst: maxResults
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
        showingFirst: maxItems
      };
    }
    
    if (typeof data === 'object' && data.files && Array.isArray(data.files)) {
      const maxFiles = 20;
      return {
        ...data,
        files: data.files.slice(0, maxFiles),
        totalFiles: data.files.length,
        truncated: data.files.length > maxFiles,
        showingFirst: maxFiles
      };
    }
    
    return data;
  }

  /**
   * Get tool results for context, applying the "last N" strategy
   */
  public getToolResultsForContext(): ToolCall[] {
    const limit = this.getMaxToolResultsInContext();
    const terminalCalls = Array.from(this.toolCalls.values())
      .filter(tc => (tc.state === "completed" || tc.state === "failed" || tc.state === "denied") && !!tc.result)
      .sort((a, b) => {
        const aKey = a.executionCompletedAt || a.approvedAt || a.timestamp;
        const bKey = b.executionCompletedAt || b.approvedAt || b.timestamp;
        return bKey - aKey;
      });

    return terminalCalls.slice(0, limit);
  }

}
