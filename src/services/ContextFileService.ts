import { App, TFile } from "obsidian";
import { ChatMessage } from "../types";
import { ImageProcessor } from "../utils/ImageProcessor";
import { SystemPromptService } from "./SystemPromptService";
import { errorLogger } from "../utils/errorLogger";
import { simpleHash } from "../utils/cryptoUtils";
import { mapAssistantToolCallsForApi, buildToolResultMessagesFromToolCalls, pruneToolMessagesNotFollowingToolCalls } from "../utils/tooling";
import { ToolCall } from "../types/toolCalls";
import { mentionsObsidianBases } from "../utils/obsidianBases";
import { OBSIDIAN_BASES_SYNTAX_GUIDE } from "../constants/prompts/obsidianBasesSyntaxGuide";

/**
 * Service responsible for handling context files and message preparation
 */
export class ContextFileService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Generate deterministic ID for context content
   */
  private deterministicId(input: string, prefix: string): string {
    // Derive a stable hash so identical inputs always yield identical IDs
    const hash = simpleHash(input);
    // Pad with more hashing if needed to get 24 chars
    const extendedHash = simpleHash(hash + input) + simpleHash(input + hash);
    return `${prefix}_${extendedHash.slice(0, 24)}`;
  }

  private hydrateToolCalls(
    toolCalls: ToolCall[] | undefined,
    toolCallManager?: { getToolCall?: (id: string) => ToolCall | undefined }
  ): ToolCall[] {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return [];
    }

    return toolCalls.map((call) => {
      if (!toolCallManager?.getToolCall || !call?.id) {
        return call;
      }

      const managerCall = toolCallManager.getToolCall(call.id);
      if (!managerCall) {
        return call;
      }

      const merged: ToolCall = {
        ...managerCall,
        request: managerCall.request || call.request,
        messageId: managerCall.messageId || call.messageId,
        timestamp: managerCall.timestamp ?? call.timestamp,
        autoApproved: managerCall.autoApproved ?? call.autoApproved,
      } as ToolCall;

      if (!merged.result && call.result) {
        merged.result = call.result;
      }

      if (!merged.state && call.state) {
        merged.state = call.state;
      }

      if (!merged.executionCompletedAt && (call as any).executionCompletedAt) {
        (merged as any).executionCompletedAt = (call as any).executionCompletedAt;
      }

      if (!merged.executionStartedAt && (call as any).executionStartedAt) {
        (merged as any).executionStartedAt = (call as any).executionStartedAt;
      }

      try {
        errorLogger.debug('Hydrated tool call from manager', {
          source: 'ContextFileService',
          method: 'hydrateToolCalls',
          metadata: {
            toolCallId: merged.id,
            hasResult: !!merged.result,
            state: merged.state,
          }
        });
      } catch {}

      return merged;
    });
  }

  private shouldInjectObsidianBasesGuide(messages: ChatMessage[], contextFiles: Set<string>): boolean {
    // Trigger if the latest user message mentions Bases, or if any context/tool call references a `.base`.
    const lastUserMessage = [...messages].reverse().find((m) => m?.role === "user");
    if (typeof lastUserMessage?.content === "string" && mentionsObsidianBases(lastUserMessage.content)) {
      return true;
    }

    for (const entry of contextFiles) {
      if (!entry || typeof entry !== "string") continue;
      if (entry.toLowerCase().includes(".base")) return true;
    }

    for (const msg of messages) {
      if (msg?.role !== "assistant") continue;
      const toolCalls = (msg as any)?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;

      for (const tc of toolCalls) {
        const rawArgs = tc?.request?.function?.arguments;
        if (typeof rawArgs !== "string") continue;
        try {
          const parsed = JSON.parse(rawArgs);
          const p = parsed?.path;
          if (typeof p === "string" && p.toLowerCase().endsWith(".base")) {
            return true;
          }
        } catch {
          if (rawArgs.toLowerCase().includes(".base")) return true;
        }
      }
    }

    return false;
  }

  /**
   * Get contents of a context file
   */
  public async getContextFileContents(
    filePath: string
  ): Promise<string | null | { type: "image"; base64: string }> {
    try {
      // Clean the wiki-link format: [[path]] -> path
      const linkText = filePath.replace(/^\[\[(.*?)\]\]$/, "$1");

      // Remove any math display markers if present
      const cleanPath = linkText.replace(
        /\$begin:math:display\$\[(.*?)\$end:math:display\$]/g,
        "$1"
      );

      // Try to resolve the file using the cleaned path
      const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(
        cleanPath,
        ""
      );

      if (resolvedFile instanceof TFile) {
        if (resolvedFile.extension.match(/^(jpg|jpeg|png|gif|webp)$/i)) {
          const base64 = await ImageProcessor.processImage(
            resolvedFile,
            this.app
          );
          return { type: "image", base64 };
        }
        const content = await this.app.vault.read(resolvedFile);
        return content;
      }

      // If file not found, try resolving without the folder structure
      const fileName = cleanPath.split("/").pop();
      if (fileName) {
        const allFiles = this.app.vault.getFiles();
        const matchingFile = allFiles.find((f) => f.name === fileName);
        if (matchingFile) {
          if (matchingFile.extension.match(/^(jpg|jpeg|png|gif|webp)$/i)) {
            const base64 = await ImageProcessor.processImage(
              matchingFile,
              this.app
            );
            return { type: "image", base64 };
          }
          const content = await this.app.vault.read(matchingFile);
          return content;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Build a chat message from a context file
   */
  public async buildContextMessageFromFile(
    filePath: string,
    includeImages: boolean
  ): Promise<ChatMessage | null> {
    if (!includeImages) {
      const linkText = filePath.replace(/^\[\[(.*?)\]\]$/, "$1");
      const cleanPath = linkText.replace(/\$begin:math:display\$\[(.*?)\$end:math:display\$]/g, "$1");
      const ext = (cleanPath.split(".").pop() || "").toLowerCase();
      if (ext && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
        return null;
      }

      const resolved =
        this.app.metadataCache.getFirstLinkpathDest(cleanPath, "") ??
        this.app.vault.getAbstractFileByPath(cleanPath);
      if (
        resolved instanceof TFile &&
        ["jpg", "jpeg", "png", "gif", "webp"].includes((resolved.extension || "").toLowerCase())
      ) {
        return null;
      }
    }

    const content = await this.getContextFileContents(filePath);
    const displayName = filePath.replace(
      /\$begin:math:display\$\[(.*?)\$end:math:display\$]/g,
      "$1"
    );

    if (content) {
      if (typeof content === "string") {
        return {
          role: "user",
          content: `Context from ${displayName}:\n\n${content}`,
          message_id: this.deterministicId(filePath, "ctx"),
        };
      } else if (content.type === "image") {
        // Construct a "type:image_url" array entry:
        return {
          role: "user",
          content: [
            {
              type: "text",
              text: `Context from ${displayName}:\n\n`,
            },
            {
              type: "image_url",
              image_url: {
                // Prefer preserving original data URL header if present
                url: (content.base64.startsWith('data:')
                  ? content.base64
                  : (function() {
                      // Attempt to infer media type from file extension; default to png
                      const lower = displayName.toLowerCase();
                      const ext = lower.includes('.') ? lower.split('.').pop() || '' : '';
                      const media = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                                   : ext === 'gif' ? 'image/gif'
                                   : ext === 'webp' ? 'image/webp'
                                   : 'image/png';
                      return `data:${media};base64,${content.base64}`;
                    })()
                ),
              },
            },
          ],
          message_id: this.deterministicId(filePath, "ctx"),
        };
      }
    }
    return null;
  }

  /**
   * Prepare messages with context files and system prompt
   */
  public async prepareMessagesWithContext(
    messages: ChatMessage[],
    contextFiles: Set<string>,
    systemPromptType?: string,
    systemPromptPath?: string,
    agentMode?: boolean,
    includeImages?: boolean,
    toolCallManager?: any,
    finalSystemPrompt?: string
  ): Promise<ChatMessage[]> {
    const shouldIncludeImages = includeImages !== false;
    const preparedMessages: ChatMessage[] = [];

    // Add system message first
    let systemPromptContent: string | undefined = finalSystemPrompt;

    // If not provided, resolve based on configured type
    const normalizedType = systemPromptType?.toLowerCase();
    if (!systemPromptContent) {
      try {
        if (normalizedType === "custom" && systemPromptPath) {
          systemPromptContent = await SystemPromptService.getInstance(this.app, () => ({})).getSystemPromptContent("custom", systemPromptPath);
        } else if (normalizedType === "general-use" || normalizedType === "concise" || normalizedType === "agent") {
          systemPromptContent = await SystemPromptService.getInstance(this.app, () => ({})).getSystemPromptContent(normalizedType as any, undefined, agentMode);
        } else {
          systemPromptContent = await SystemPromptService.getInstance(this.app, () => ({})).getSystemPromptContent("general-use", undefined, agentMode);
        }
      } catch (_) {}
      // As a final fallback
      if (!systemPromptContent) {
        systemPromptContent = "You are a helpful AI assistant. Provide clear, accurate, and relevant information.";
      }
    }

    // Conditionally augment the system prompt with Bases syntax help when relevant.
    if (systemPromptContent && this.shouldInjectObsidianBasesGuide(messages, contextFiles)) {
      systemPromptContent = `${systemPromptContent}\n\n${OBSIDIAN_BASES_SYNTAX_GUIDE}`;
    }

    // Add system message if we have content
    if (systemPromptContent) {
      preparedMessages.push({
        role: "system",
        content: systemPromptContent,
        message_id: this.deterministicId(systemPromptContent, "sys")
      });
    } else {
      // Add a minimal default system prompt if all else fails
      const fallbackPrompt = "You are a helpful AI assistant. Provide clear, accurate, and relevant information.";
      preparedMessages.push({
        role: "system",
        content: fallbackPrompt,
        message_id: this.deterministicId(fallbackPrompt, "sys")
      });
    }
    
    // Process context files and collect document IDs for the server
    const documentIds: string[] = [];
    const contextMessages: ChatMessage[] = [];
    
    for (const filePath of contextFiles) {
      // Check if this is a document reference (starts with "doc:")
      if (filePath.startsWith("doc:")) {
        const documentId = filePath.substring(4);
        documentIds.push(documentId);
      } else {
        // Build regular file contexts but defer insertion until right before the latest user message
        const contextMessage = await this.buildContextMessageFromFile(filePath, shouldIncludeImages);
        if (contextMessage) {
          contextMessages.push(contextMessage);
        }
      }
    }

    // Identify the latest user message index
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    // If we have document IDs, attach them to the latest user message (not the first)
    if (documentIds.length > 0 && lastUserIndex !== -1) {
      const targetUserMessage = messages[lastUserIndex];
      if (targetUserMessage) {
        targetUserMessage.documentContext = { documentIds };
      }
    }

    // Add the actual chat messages, injecting context right before the latest user message.
    // NOTE: For strict providers (e.g., MiniMax), tool result messages must immediately follow
    // the assistant message that declared the corresponding tool_calls.
    let idx = 0;
    while (idx < messages.length) {
      const msg = messages[idx];

      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        if (agentMode) {
          // Hydrate tool calls with results/state from the ToolCallManager when available.
          const enrichedToolCalls = this.hydrateToolCalls(msg.tool_calls as any, toolCallManager);
          (msg as any).tool_calls = enrichedToolCalls;

          const toolCallsForApi = mapAssistantToolCallsForApi(enrichedToolCalls as any);
          const declaredToolCallIds = new Set(
            toolCallsForApi
              .map((tc: any) => tc?.id)
              .filter((id: any): id is string => typeof id === "string" && id.length > 0)
          );

          // Capture any explicit tool messages that immediately follow this assistant message
          // in the provided history. These can be used if ToolCallManager hydration isn't available.
          const followingToolMessages: ChatMessage[] = [];
          let lookahead = idx + 1;
          while (lookahead < messages.length && messages[lookahead]?.role === "tool") {
            followingToolMessages.push(messages[lookahead]);
            lookahead += 1;
          }

          const toolMessagesFromInput = followingToolMessages
            .filter((m) => {
              const toolCallId = (m as any)?.tool_call_id;
              return typeof toolCallId === "string" && declaredToolCallIds.has(toolCallId);
            })
            .map((m) => {
              const toolCallId = (m as any).tool_call_id as string;
              const rawContent: any = (m as any).content;
              const content =
                typeof rawContent === "string"
                  ? rawContent
                  : rawContent == null
                    ? ""
                    : (() => {
                        try {
                          return JSON.stringify(rawContent);
                        } catch {
                          return String(rawContent);
                        }
                      })();

              return {
                role: "tool",
                tool_call_id: toolCallId,
                content,
                message_id: m.message_id ?? this.deterministicId(`${toolCallId}:${content}`, "tool"),
              } as ChatMessage;
            });

          const toolMessagesFromManager = buildToolResultMessagesFromToolCalls(enrichedToolCalls as any);

          const byIdFromManager = new Map<string, ChatMessage>();
          for (const toolMessage of toolMessagesFromManager) {
            const toolCallId = (toolMessage as any)?.tool_call_id;
            if (typeof toolCallId === "string" && declaredToolCallIds.has(toolCallId)) {
              byIdFromManager.set(toolCallId, toolMessage);
            }
          }

          const byIdFromInput = new Map<string, ChatMessage>();
          for (const toolMessage of toolMessagesFromInput) {
            const toolCallId = (toolMessage as any)?.tool_call_id;
            if (typeof toolCallId === "string") {
              byIdFromInput.set(toolCallId, toolMessage);
            }
          }

          const idsWithResults = new Set<string>([
            ...byIdFromManager.keys(),
            ...byIdFromInput.keys(),
          ]);

          const filteredToolCallsForApi = toolCallsForApi.filter((tc: any) => idsWithResults.has(tc?.id));

          // Add the assistant message with a tool_calls array only if we can also include the corresponding tool results.
          const assistantApiMessage: Partial<ChatMessage> = {
            role: "assistant",
            message_id: msg.message_id,
            content: msg.content || "",
          };
          if (filteredToolCallsForApi.length > 0) {
            assistantApiMessage.tool_calls = filteredToolCallsForApi as any;
          }

          // OpenRouter Gemini: reasoning_details entries must correspond to the tool_calls ids being preserved.
          // If we send mismatched reasoning_details, Google can reject with "Corrupted thought signature."
          const rawReasoningDetails = Array.isArray((msg as any).reasoning_details)
            ? ((msg as any).reasoning_details as any[])
            : null;
          if (rawReasoningDetails && filteredToolCallsForApi.length > 0) {
            const allowed = new Set(
              filteredToolCallsForApi
                .map((tc: any) => tc?.id)
                .filter((id: any): id is string => typeof id === "string" && id.length > 0)
            );
            const filteredReasoningDetails = rawReasoningDetails.filter((detail) => {
              const id = detail?.id;
              return typeof id === "string" && allowed.has(id);
            });
            if (filteredReasoningDetails.length > 0) {
              (assistantApiMessage as any).reasoning_details = filteredReasoningDetails;
            } else {
              try {
                errorLogger.warn("Dropped reasoning_details that did not match tool_calls ids", {
                  source: "ContextFileService",
                  method: "prepareMessagesWithContext",
                  metadata: {
                    messageId: msg.message_id,
                    allowedToolCallIds: Array.from(allowed),
                    reasoningDetailIds: rawReasoningDetails
                      .map((d) => d?.id)
                      .filter((id) => typeof id === "string"),
                  },
                });
              } catch {}
            }
          }
          preparedMessages.push(assistantApiMessage as ChatMessage);

          // Add tool results in the same order as tool_calls for providers that validate adjacency/order.
          for (const tc of filteredToolCallsForApi) {
            const toolCallId = tc.id;
            const toolMessage = byIdFromManager.get(toolCallId) ?? byIdFromInput.get(toolCallId);
            if (toolMessage) {
              preparedMessages.push(toolMessage);
            }
          }

          // Skip tool role messages from the input history; they've been consumed or intentionally dropped.
          idx = lookahead;
          continue;
        }

        // Agent mode OFF: strip tool calls and skip any following tool messages.
        const assistantMessageWithoutTools: Partial<ChatMessage> = {
          role: "assistant",
          message_id: msg.message_id,
          content: msg.content || "",
        };
        preparedMessages.push(assistantMessageWithoutTools as ChatMessage);

        let lookahead = idx + 1;
        while (lookahead < messages.length && messages[lookahead]?.role === "tool") {
          lookahead += 1;
        }
        idx = lookahead;
        continue;
      }

      if (msg.role === "tool") {
        // Tool messages are handled as part of the assistant tool_calls branch above.
        idx += 1;
        continue;
      }

      // Insert deferred context messages immediately before the latest user message
      if (idx === lastUserIndex && contextMessages.length > 0) {
        for (const cm of contextMessages) {
          preparedMessages.push(cm);
        }
      }

      // For any other message (user, system), pass it through as-is.
      const messageToPush: Partial<ChatMessage> = {
        role: msg.role,
        message_id: msg.message_id,
        documentContext: msg.documentContext,
        systemPromptType: msg.systemPromptType,
        systemPromptPath: msg.systemPromptPath,
        ...((msg as any).reasoning_details && { reasoning_details: (msg as any).reasoning_details }),
        ...(msg.tool_calls && msg.tool_calls.length > 0 && { tool_calls: msg.tool_calls }),
      };
      if (msg.content) {
        messageToPush.content = msg.content;
      }
      preparedMessages.push(messageToPush as ChatMessage);

      idx += 1;
    }

    // Apply context management for tool results if we have a ToolCallManager
    if (toolCallManager && agentMode) {
      this.optimizeToolResultsContext(preparedMessages, toolCallManager);
    }

    // Defensive: ensure tool result messages always directly follow their declaring assistant tool_calls message.
    // Some providers (e.g., MiniMax) hard-fail invalid sequences with HTTP 400.
    if (agentMode) {
      const { messages: sanitized, dropped } = pruneToolMessagesNotFollowingToolCalls(preparedMessages);
      if (dropped > 0) {
        try {
          errorLogger.warn("Dropped tool messages that did not follow tool_calls", {
            source: "ContextFileService",
            method: "prepareMessagesWithContext",
            metadata: { dropped },
          });
        } catch {}
        preparedMessages.length = 0;
        preparedMessages.push(...sanitized);
      }
    }

    return preparedMessages;
  }

  /**
   * Optimize tool results context using industry best practices
   */
  public optimizeToolResultsContext(preparedMessages: ChatMessage[], toolCallManager: any): void {
    const maxToolResults = typeof toolCallManager.getMaxToolResultsInContext === "function"
      ? toolCallManager.getMaxToolResultsInContext()
      : 15;

    // Get recent tool results for context
    const recentToolResults = toolCallManager.getToolResultsForContext();

    // Count tool messages in current prepared messages
    const toolMessageCount = preparedMessages.filter(msg => msg.role === 'tool').length;

    // If we have too many tool messages, apply context management
    if (toolMessageCount > maxToolResults) {
      // Keep only the most recent tool results (by id)
      const recentToolCallIds = new Set(recentToolResults.map((tc: any) => tc.id));

      // First pass: filter tool messages to only keep those whose tool_call_id is recent
      // and concurrently prune assistant tool_calls to only keep recent ids.
      const filtered: ChatMessage[] = [];

      for (const msg of preparedMessages) {
        if (msg.role === 'tool') {
          // Keep only tool messages for recent tool calls
          const keep = !!(msg as any).tool_call_id && recentToolCallIds.has((msg as any).tool_call_id);
          if (keep) filtered.push(msg);
          continue;
        }

        if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
          // Prune tool_calls inside assistant messages to match the kept tool results
          const originalToolCalls = (msg as any).tool_calls as any[];
          const prunedToolCalls = originalToolCalls.filter(tc => recentToolCallIds.has(tc.id));

          if (prunedToolCalls.length > 0) {
            // Preserve message but with pruned tool_calls
            const updatedMsg: ChatMessage = {
              ...msg,
              tool_calls: prunedToolCalls as any,
            } as any;
            filtered.push(updatedMsg);
          } else {
            // No recent tool calls left on this assistant message
            // If it has substantive content, keep it; otherwise drop it to avoid dangling tool_calls without outputs
            const hasContent = typeof msg.content === 'string' ? msg.content.trim().length > 0 : Array.isArray(msg.content) && (msg.content as any[]).length > 0;
            if (hasContent) {
              const updatedMsg: ChatMessage = {
                ...msg,
                tool_calls: undefined,
              } as any;
              filtered.push(updatedMsg);
            }
          }
          continue;
        }

        // All other messages are kept as-is
        filtered.push(msg);
      }

      // Replace the array contents
      preparedMessages.length = 0;
      preparedMessages.push(...filtered);
    }
  }
}
