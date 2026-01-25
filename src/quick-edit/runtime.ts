import { App } from "obsidian";
import type SystemSculptPlugin from "../main";
import { MCPService } from "../mcp/MCPService";
import type { ToolCall, ToolCallRequest } from "../types/toolCalls";
import { errorLogger } from "../utils/errorLogger";
import { ToolCallManager } from "../views/chatview/ToolCallManager";
import {
  QuickEditController,
  type QuickEditControllerDeps,
  type QuickEditExecutionContext,
  type QuickEditStreamInput,
} from "./controller";
import { evaluateQuickEditReadiness } from "./capabilities";
import { buildQuickEditMessages } from "./prompt-builder";

const globalCrypto: { randomUUID?: () => string } | undefined =
  typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;

const generateId = (): string => {
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  return `id_${Math.random().toString(36).slice(2, 14)}`;
};

export interface QuickEditRuntime {
  controller: QuickEditController;
  toolCallManager: ToolCallManager;
}

export function createQuickEditRuntime(app: App, plugin: SystemSculptPlugin): QuickEditRuntime {
  const mcpService = new MCPService(plugin, app);
  const fakeChatContext = { agentMode: true, plugin } as any;
  const toolCallManager = new ToolCallManager(mcpService, fakeChatContext);

  const streamFactory = (input: QuickEditStreamInput) => {
    return plugin.aiService.streamMessage({
      messages: input.messages,
      model: input.model,
      contextFiles: input.contextFiles,
      systemPromptType: "agent",
      systemPromptOverride: input.systemPromptOverride,
      agentMode: input.agentMode,
      toolCallManager: input.toolCallManager ?? toolCallManager,
      signal: input.signal,
    });
  };

  const executeToolCalls = async (
    toolCalls: ToolCallRequest[],
    context: QuickEditExecutionContext
  ): Promise<ToolCall[]> => {
    const manager = toolCallManager;
    const messageId = context.userMessageId ?? generateId();

    const executeOne = (call: ToolCallRequest) =>
      new Promise<ToolCall>((resolve, reject) => {
        const toolCall = manager.createToolCall(call, messageId, true);
        if (!toolCall) {
          reject(new Error("Unable to create tool call"));
          return;
        }

        const cleanup = (handlers: Array<() => void>) => {
          for (const off of handlers) {
            try {
              off();
            } catch {}
          }
        };

        const handleCompleted = ({ toolCall: executed }: { toolCall: ToolCall }) => {
          if (executed.id !== toolCall.id) return;
          cleanup([offCompleted, offFailed, offDenied]);
          resolve(executed);
        };

        const handleFailed = ({
          toolCall: failed,
          error,
        }: {
          toolCall: ToolCall;
          error?: { message?: string };
        }) => {
          if (failed.id !== toolCall.id) return;
          cleanup([offCompleted, offFailed, offDenied]);
          reject(new Error(error?.message || "Tool execution failed"));
        };

        const handleDenied = ({ toolCallId }: { toolCallId: string }) => {
          if (toolCallId !== toolCall.id) return;
          cleanup([offCompleted, offFailed, offDenied]);
          reject(new Error("Tool call denied"));
        };

        const offCompleted = manager.on("tool-call:execution-completed", handleCompleted);
        const offFailed = manager.on("tool-call:execution-failed", handleFailed);
        const offDenied = manager.on("tool-call:denied", handleDenied);
      });

    const results: ToolCall[] = [];
    for (const call of toolCalls) {
      try {
        results.push(await executeOne(call));
      } catch (error) {
        errorLogger.error("Quick Edit tool call failed", error, {
          source: "QuickEditRuntime",
          method: "executeToolCalls",
          metadata: { toolCallId: call.id, toolName: call.function?.name },
        });
        throw error;
      }
    }

    return results;
  };

  const deps: QuickEditControllerDeps = {
    capabilityChecker: (input) => evaluateQuickEditReadiness(input),
    promptBuilder: (opts) => buildQuickEditMessages(opts),
    streamFactory,
    executeToolCalls,
    abortControllerFactory: () => new AbortController(),
  };

  const controller = new QuickEditController(deps);
  return { controller, toolCallManager };
}
