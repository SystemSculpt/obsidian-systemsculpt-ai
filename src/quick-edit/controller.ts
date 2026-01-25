import type { TFile } from "obsidian";
import type { ChatMessage } from "../types";
import type SystemSculptPlugin from "../main";
import type { ToolCall, ToolCallRequest } from "../types/toolCalls";
import type { StreamEvent, StreamToolCall } from "../streaming/types";
import { TypedEventEmitter } from "../core/TypedEventEmitter";
import type { QuickEditReadinessResult } from "./capabilities";
import type { QuickEditMessages, QuickEditPromptOptions } from "./prompt-builder";
import { buildQuickEditDiffPreview } from "./preview";
import { createToolCallIdState, sanitizeToolCallId } from "../utils/toolCallId";

export type QuickEditState =
  | "idle"
  | "checking"
  | "streaming"
  | "awaiting-confirmation"
  | "responded"
  | "completed"
  | "failed"
  | "cancelled";

export interface QuickEditExecutionContext {
  file: TFile;
  plugin: SystemSculptPlugin;
  userMessageId?: string;
}

export interface QuickEditCapabilityInput {
  plugin: SystemSculptPlugin;
  file: TFile;
}

export interface QuickEditStreamInput {
  messages: ChatMessage[];
  model: string;
  contextFiles: Set<string>;
  agentMode: boolean;
  systemPromptOverride?: string;
  toolCallManager?: any;
  signal: AbortSignal;
}

export interface QuickEditControllerDeps {
  capabilityChecker: (input: QuickEditCapabilityInput) => Promise<QuickEditReadinessResult>;
  promptBuilder: (input: QuickEditPromptOptions) => Promise<QuickEditMessages>;
  streamFactory: (input: QuickEditStreamInput) => AsyncGenerator<StreamEvent>;
  executeToolCalls: (toolCalls: ToolCallRequest[], context: QuickEditExecutionContext) => Promise<ToolCall[]>;
  abortControllerFactory: () => AbortController;
}

export interface QuickEditStartOptions {
  plugin: SystemSculptPlugin;
  file: TFile;
  prompt: string;
  selection?: QuickEditPromptOptions["selection"];
  toolCallManager?: any;
}

export interface QuickEditMoveOperation {
  source: string;
  destination: string;
}

export type QuickEditActivity =
  | { type: "thinking" }
  | { type: "exploring"; folder?: string }
  | { type: "reading"; file?: string }
  | { type: "deciding" }
  | { type: "proposing" };

export interface QuickEditControllerEvents {
  state: { state: QuickEditState; issues?: QuickEditReadinessResult["issues"]; error?: Error };
  activity: QuickEditActivity;
  preview: { toolCalls: ToolCallRequest[]; pendingMove?: QuickEditMoveOperation };
  response: { content: string };
}

const EDIT_TOOL_NAMES = new Set(["edit", "write", "move"]);
const EXPLORATION_TOOL_NAMES = new Set(["list_items", "read", "exists", "find", "search", "context"]);
const MAX_STREAM_ITERATIONS = 4;
const TOOL_RESULT_CHAR_LIMIT = 4000;

const globalCrypto: { randomUUID?: () => string } | undefined =
  typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;

const generateId = (): string => {
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return `call_${Math.random().toString(36).slice(2, 14)}`;
};

const cloneMessage = (message: ChatMessage): ChatMessage => {
  return JSON.parse(JSON.stringify(message)) as ChatMessage;
};

interface AssistantDraft {
  id: string;
  content: string;
  toolCalls: ToolCallRequest[];
}

export class QuickEditController {
  public readonly events = new TypedEventEmitter<QuickEditControllerEvents>();
  public state: QuickEditState = "idle";
  public issues: QuickEditReadinessResult["issues"] = [];

  private deps: QuickEditControllerDeps;
  private abortController: AbortController | null = null;
  private pendingToolCalls: ToolCallRequest[] = [];
  private pendingMove: QuickEditMoveOperation | null = null;
  private streamInFlight = false;
  private context: QuickEditExecutionContext | null = null;
  private messageHistory: ChatMessage[] = [];
  private currentAssistantMessage: AssistantDraft | null = null;
  private lastAssistantContent: string | null = null;
  private activeModelId = "";
  private systemPromptOverride: string | null = null;
  private streamIterations = 0;

  constructor(deps: QuickEditControllerDeps) {
    this.deps = deps;
  }

  public async start(options: QuickEditStartOptions): Promise<void> {
    this.reset();
    this.updateState("checking");

    const capability = await this.deps.capabilityChecker({
      plugin: options.plugin,
      file: options.file,
    });

    if (!capability.ok) {
      this.issues = capability.issues;
      this.updateState("failed", { issues: capability.issues });
      return;
    }

    const messages = await this.deps.promptBuilder({
      app: options.plugin.app,
      plugin: options.plugin,
      file: options.file,
      prompt: options.prompt,
      selection: options.selection,
    });

    this.context = {
      file: options.file,
      plugin: options.plugin,
      userMessageId: (messages.user as any)?.message_id,
    };

    const userMessage = cloneMessage(messages.user);
    this.messageHistory = [userMessage];

    const { PromptBuilder } = await import("../services/PromptBuilder");
    const baseSystemPrompt = await PromptBuilder.buildSystemPrompt(
      options.plugin.app,
      () => options.plugin.settings,
      { type: "agent", path: undefined, agentMode: true, hasTools: true }
    );
    const combinedPrompt = [baseSystemPrompt, messages.systemPrompt].filter(Boolean).join("\n\n");
    this.systemPromptOverride = combinedPrompt || baseSystemPrompt || null;

    this.activeModelId = options.plugin.settings?.selectedModelId ?? "";
    this.streamIterations = 0;

    let shouldContinue = true;
    while (shouldContinue) {
      if (this.state === "cancelled" || this.state === "failed") {
        return;
      }
      if (this.streamIterations >= MAX_STREAM_ITERATIONS) {
        this.fail(new Error("Quick Edit exceeded the maximum number of tool iterations."));
        return;
      }
      shouldContinue = await this.runStreamIteration(options);
    }
  }

  public get currentPendingMove(): QuickEditMoveOperation | null {
    return this.pendingMove;
  }

  public complete(): void {
    if (this.state === "completed" || this.state === "failed") return;
    this.pendingToolCalls = [];
    this.pendingMove = null;
    this.updateState("completed");
  }

  public cancel(): void {
    if (this.state === "completed" || this.state === "failed" || this.state === "cancelled") {
      return;
    }

    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
    }

    this.pendingToolCalls = [];
    this.pendingMove = null;
    this.updateState("cancelled");
  }

  private async runStreamIteration(options: QuickEditStartOptions): Promise<boolean> {
    this.streamIterations += 1;
    this.pendingToolCalls = [];
    this.currentAssistantMessage = null;
    this.lastAssistantContent = null;

    const abortController = this.deps.abortControllerFactory();
    this.abortController = abortController;
    this.streamInFlight = true;
    this.updateState("streaming");

    try {
      const stream = this.deps.streamFactory({
        messages: (await import("../utils/messages/toApiMessages"))
          .toApiBaseMessages(this.messageHistory.map((msg) => cloneMessage(msg))),
        model: this.activeModelId,
        contextFiles: new Set([options.file.path]),
        agentMode: true,
        toolCallManager: options.toolCallManager,
        systemPromptOverride: this.systemPromptOverride ?? undefined,
        signal: abortController.signal,
      });

      const shouldResume = await this.consumeStream(stream, options);
      return shouldResume;
    } catch (error) {
      if (this.state === "cancelled") {
        return false;
      }
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      this.streamInFlight = false;
    }
  }

  private async consumeStream(stream: AsyncGenerator<StreamEvent>, options: QuickEditStartOptions): Promise<boolean> {
    const pending = new Map<string, StreamToolCall>();
    const toolCallIdState = createToolCallIdState();
    let resumeRequested = false;
    let loggedContentStart = false;

    for await (const event of stream) {
      if (this.state === "cancelled") {
        await this.closeStream(stream);
        return false;
      }

      if (event.type === "content") {
        this.appendAssistantContent(event.text ?? "");
        if (!loggedContentStart) {
          const preview = (event.text ?? "").trim().slice(0, 120);
          if (preview.length > 0) {
            loggedContentStart = true;
            this.events.emit("activity", { type: "thinking" });
          }
        }
      } else if (event.type === "reasoning") {
        // Keep reasoning out of console by default to avoid log spam during streaming.
      } else if (event.type === "tool-call") {
        const callIndex = typeof event.call.index === "number" ? event.call.index : 0;
        const sanitizedId = sanitizeToolCallId(event.call.id, callIndex, toolCallIdState);
        if (event.phase === "delta") {
          const existing = pending.get(sanitizedId);
          const merged: StreamToolCall = {
            ...(existing ?? {}),
            ...event.call,
            id: sanitizedId,
            function: {
              name: event.call.function.name || existing?.function.name || "",
              arguments: event.call.function.arguments || existing?.function.arguments || "",
            },
          } as StreamToolCall;
          pending.set(sanitizedId, merged);
        } else {
          const aggregated = pending.get(sanitizedId);
          pending.delete(sanitizedId);

          const functionName = event.call.function.name || aggregated?.function.name;
          if (!functionName) continue;

          let args = event.call.function.arguments || aggregated?.function.arguments || "";

          const toolCall: ToolCallRequest = {
            id: sanitizedId,
            type: "function",
            function: {
              name: functionName,
              arguments: args,
            },
          };

          this.recordAssistantToolCall(toolCall);

          const baseName = functionName.replace(/^mcp[-_][^_]+_/, "");
          const isExplorationTool = EXPLORATION_TOOL_NAMES.has(baseName);
          const isEditTool = EDIT_TOOL_NAMES.has(baseName);

          if (isExplorationTool) {
            if (!this.context) {
              this.fail(new Error(`Quick Edit cannot execute tool calls without context (tool: ${functionName}).`));
              await this.closeStream(stream);
              return false;
            }

            const activityForTool = this.getActivityForExplorationTool(baseName, toolCall);
            this.events.emit("activity", activityForTool);

            // Important: tool result messages must follow the assistant tool call message.
            // Commit the assistant message (with tool_calls) before appending any tool outputs.
            this.commitAssistantMessage(true);

            try {
              const executions = await this.deps.executeToolCalls([toolCall], this.context);
              if (Array.isArray(executions) && executions.length > 0) {
                for (const executed of executions) {
                  this.appendToolMessage(executed);
                }
              }
            } catch (error) {
              this.fail(error instanceof Error ? error : new Error(String(error)));
              await this.closeStream(stream);
              return false;
            }

            this.events.emit("activity", { type: "deciding" });
            resumeRequested = true;
            break;
          }

          if (isEditTool) {
            this.pendingToolCalls.push(toolCall);
            this.events.emit("activity", { type: "proposing" });
          } else {
            // Ignore unknown tools; only filesystem write/move are valid in this flow.
          }
        }
      }
    }

    if (resumeRequested) {
      await this.closeStream(stream);
      return true;
    }

    this.commitAssistantMessage();
    return await this.afterStream(options);
  }

  private canRetryAfterStream(): boolean {
    return this.state !== "cancelled" && this.state !== "failed" && this.streamIterations < MAX_STREAM_ITERATIONS;
  }

  private pushRetryMessage(message: string): void {
    this.messageHistory.push({
      role: "user",
      content: message,
      message_id: generateId(),
    });
  }

  private async afterStream(options: QuickEditStartOptions): Promise<boolean> {
    if (this.state === "cancelled") return false;
    if (!this.context) return false;

    if (this.pendingToolCalls.length === 0) {
      const responseContent = (this.lastAssistantContent ?? "").trim();
      if (responseContent.length > 0) {
        this.events.emit("response", { content: responseContent });
        this.updateState("responded");
        return false;
      }

      if (this.canRetryAfterStream()) {
        this.pushRetryMessage(
          [
            "You did not produce any filesystem tool calls or a response.",
            "Quick Edit requires either:",
            "- `mcp-filesystem_write` to modify file content",
            "- `mcp-filesystem_move` to rename or relocate the file",
            "- Or both, in sequence",
            "",
            "If no file changes are needed, reply with a concise answer instead.",
            `Current file path: ${options.file.path}`,
            "",
            "Try again now with appropriate tool calls.",
          ].join("\n")
        );
        return true;
      }

      this.fail(new Error("Quick Edit did not receive any proposed file changes or response."));
      return false;
    }

    const filteredToolCalls: ToolCallRequest[] = [];
    let writeCall: ToolCallRequest | null = null;
    let moveCall: ToolCallRequest | null = null;
    this.pendingMove = null;

    for (const call of this.pendingToolCalls) {
      const base = call.function?.name?.replace(/^mcp[-_][^_]+_/, "") ?? "";
      if (!EDIT_TOOL_NAMES.has(base)) continue;

      try {
        const argsRaw = String(call.function?.arguments ?? "");
        const parsedArgs: any = JSON.parse(argsRaw);

        if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
          throw new Error("Tool call arguments must be a JSON object");
        }

        if (base === "move") {
          if (moveCall) {
            throw new Error("Quick Edit allows at most one move operation.");
          }
          const items = parsedArgs.items;
          if (!Array.isArray(items) || items.length === 0) {
            throw new Error("Move tool call requires 'items' array with at least one item.");
          }
          if (items.length > 1) {
            throw new Error("Quick Edit only supports moving one file at a time.");
          }
          const item = items[0];
          const source = item?.source;
          const destination = item?.destination;
          if (typeof source !== "string" || typeof destination !== "string") {
            throw new Error("Move item must have 'source' and 'destination' strings.");
          }
          if (source !== options.file.path) {
            throw new Error(
              `Move source '${source}' does not match the target file '${options.file.path}'.`
            );
          }
          if (source === destination) {
            continue;
          }
          this.pendingMove = { source, destination };
          moveCall = call;
          filteredToolCalls.push(call);
        } else if (base === "write") {
          if (writeCall) {
            throw new Error("Quick Edit allows at most one write operation.");
          }
          const path = parsedArgs.path;
          if (typeof path !== "string" || path.length === 0) {
            throw new Error("Write tool call is missing required 'path'.");
          }
          const expectedPath = this.pendingMove?.destination ?? options.file.path;
          if (path !== expectedPath) {
            throw new Error(
              `Write path '${path}' does not match expected path '${expectedPath}'.`
            );
          }
          if (typeof parsedArgs.content !== "string") {
            throw new Error("Write tool call is missing required 'content' string.");
          }
          writeCall = call;
          filteredToolCalls.push(call);
        } else if (base === "edit") {
          throw new Error("Quick Edit requires `mcp-filesystem_write` for content changes, not `mcp-filesystem_edit`.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (this.canRetryAfterStream()) {
          this.pushRetryMessage(
            [
              `Your tool call was invalid: ${message}`,
              `Current file path: ${options.file.path}`,
              "",
              "Try again with valid tool calls:",
              "- Use `mcp-filesystem_move` with { items: [{ source, destination }] } to rename/relocate.",
              "- Use `mcp-filesystem_write` with { path, content, createDirs:true, ifExists:\"overwrite\" } to modify content.",
              "- If both moving and editing, call move first, then write to the new path.",
            ].join("\n")
          );
          return true;
        }

        this.fail(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    }

    this.pendingToolCalls = filteredToolCalls;

    if (this.pendingToolCalls.length === 0) {
      if (this.canRetryAfterStream()) {
        this.pushRetryMessage(
          [
            "No valid file operations were detected.",
            `Current file path: ${options.file.path}`,
            "Return `mcp-filesystem_write` and/or `mcp-filesystem_move` tool calls.",
          ].join("\n")
        );
        return true;
      }

      this.fail(new Error("Quick Edit did not receive any proposed file changes."));
      return false;
    }

    const hasContentChange = writeCall !== null;
    const hasMoveOnly = moveCall !== null && !hasContentChange;

    if (hasContentChange) {
      try {
        const preview = await buildQuickEditDiffPreview(
          options.plugin.app,
          options.file,
          [writeCall!]
        );
        const totalChanges = (preview.diff?.stats?.additions ?? 0) + (preview.diff?.stats?.deletions ?? 0);
        if (totalChanges === 0 && !hasMoveOnly) {
          const normalizedCurrent = String(preview.oldContent ?? "").replace(/\r\n/g, "\n");
          const normalizedProposed = String(preview.newContent ?? "").replace(/\r\n/g, "\n");
          if (normalizedCurrent === normalizedProposed && !this.pendingMove) {
            this.pendingToolCalls = [];
            this.pendingMove = null;
            this.updateState("completed");
            return false;
          }
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    }

    this.events.emit("preview", {
      toolCalls: this.pendingToolCalls.slice(),
      pendingMove: this.pendingMove ?? undefined,
    });
    this.updateState("awaiting-confirmation");
    return false;
  }

  private appendAssistantContent(text: string): void {
    if (!text) return;
    if (!this.currentAssistantMessage) {
      this.currentAssistantMessage = {
        id: generateId(),
        content: "",
        toolCalls: [],
      };
    }
    this.currentAssistantMessage.content += text;
  }

  private formatToolResult(toolCall: ToolCall): string {
    const result = toolCall.result;
    if (!result) return "";
    if (result.success) {
      const data = result.data;
      if (typeof data === "string") {
        return data.slice(0, TOOL_RESULT_CHAR_LIMIT);
      }
      try {
        return JSON.stringify(data).slice(0, TOOL_RESULT_CHAR_LIMIT);
      } catch {
        return "[tool result unavailable]";
      }
    }
    try {
      return JSON.stringify(result.error ?? { message: "Tool execution failed" }).slice(0, TOOL_RESULT_CHAR_LIMIT);
    } catch {
      return String(result.error?.message ?? "Tool execution failed");
    }
  }

  private appendToolMessage(toolCall: ToolCall): void {
    const content = this.formatToolResult(toolCall);
    const toolMessage: ChatMessage = {
      role: "tool",
      content,
      tool_call_id: toolCall.id,
      message_id: generateId(),
    };
    this.messageHistory.push(toolMessage);
  }

  private recordAssistantToolCall(call: ToolCallRequest): void {
    if (!this.currentAssistantMessage) {
      this.currentAssistantMessage = {
        id: generateId(),
        content: "",
        toolCalls: [],
      };
    }
    this.currentAssistantMessage.toolCalls.push({
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    });
  }

  private commitAssistantMessage(force = false): void {
    if (!this.currentAssistantMessage) return;
    const { id, content, toolCalls } = this.currentAssistantMessage;
    const hasContent = content && content.trim().length > 0;
    const hasTools = toolCalls.length > 0;
    if (!force && !hasContent && !hasTools) {
      this.currentAssistantMessage = null;
      return;
    }

    const message: ChatMessage = {
      role: "assistant",
      content: hasContent ? content : "",
      message_id: id,
    };
    if (hasTools) {
      message.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: call.type,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      })) as any;
    }
    this.messageHistory.push(message);
    if (hasContent) {
      this.lastAssistantContent = content;
    }
    this.currentAssistantMessage = null;
  }

  private async closeStream(stream: AsyncGenerator<StreamEvent>): Promise<void> {
    if (typeof stream.return === "function") {
      try {
        await stream.return(undefined);
      } catch {}
    }
  }

  private reset(): void {
    this.pendingToolCalls = [];
    this.pendingMove = null;
    this.abortController = null;
    this.issues = [];
    this.streamInFlight = false;
    this.context = null;
    this.messageHistory = [];
    this.currentAssistantMessage = null;
    this.lastAssistantContent = null;
    this.activeModelId = "";
    this.systemPromptOverride = null;
    this.streamIterations = 0;
  }

  private updateState(
    state: QuickEditState,
    extras: { issues?: QuickEditReadinessResult["issues"]; error?: Error } = {}
  ): void {
    this.state = state;
    this.events.emit("state", { state, ...extras });
  }

  private fail(error: Error): void {
    const friendlyError = this.getFriendlyError(error);
    this.updateState("failed", { error: friendlyError });
    this.pendingToolCalls = [];
  }

  private getFriendlyError(error: Error): Error {
    const message = error.message || String(error);

    if (message.includes("over capacity") || message.includes("overloaded")) {
      return new Error("The AI model is currently overloaded. Please try again in a moment.");
    }
    if (message.includes("rate limit") || message.includes("Rate limit")) {
      return new Error("Rate limit reached. Please wait a moment and try again.");
    }
    if (message.includes("503") || message.includes("Service Unavailable")) {
      return new Error("The AI service is temporarily unavailable. Please try again.");
    }
    if (message.includes("timeout") || message.includes("Timeout")) {
      return new Error("Request timed out. Please try again.");
    }
    if (message.includes("network") || message.includes("Network")) {
      return new Error("Network error. Please check your connection and try again.");
    }
    if (message.includes("401") || message.includes("Unauthorized")) {
      return new Error("Authentication failed. Please check your API key in settings.");
    }
    if (message.includes("Invalid API") || message.includes("invalid_api_key")) {
      return new Error("Invalid API key. Please check your API key in settings.");
    }

    return error;
  }

  private getActivityForExplorationTool(baseName: string, toolCall: ToolCallRequest): QuickEditActivity {
    try {
      const args = JSON.parse(String(toolCall.function?.arguments ?? "{}"));
      if (baseName === "list_items") {
        const paths = args.paths;
        const folder = Array.isArray(paths) && paths.length > 0 ? String(paths[0]) : undefined;
        return { type: "exploring", folder: folder || "/" };
      }
      if (baseName === "read") {
        const paths = args.paths;
        const file = Array.isArray(paths) && paths.length > 0 ? String(paths[0]) : undefined;
        return { type: "reading", file };
      }
    } catch {}
    return { type: "exploring" };
  }
}
