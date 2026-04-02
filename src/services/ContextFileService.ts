import { App, TFile } from "obsidian";
import { ChatMessage, MessagePart, MultiPartContent } from "../types";
import { ImageProcessor } from "../utils/ImageProcessor";
import { simpleHash } from "../utils/cryptoUtils";
import { mentionsObsidianBases } from "../utils/obsidianBases";
import { OBSIDIAN_BASES_SYNTAX_GUIDE } from "../constants/prompts/obsidianBasesSyntaxGuide";
import {
  buildToolResultMessagesFromToolCalls,
  pruneToolMessagesNotFollowingToolCalls,
} from "../utils/tooling";
import type { ToolCall } from "../types/toolCalls";

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

  private expandCompactAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
    const expanded: ChatMessage[] = [];

    messages.forEach((message, index) => {
      expanded.push(...this.expandCompactAssistantMessage(message, messages, index));
    });

    return expanded;
  }

  private expandCompactAssistantMessage(
    message: ChatMessage,
    messages: ChatMessage[],
    messageIndex: number
  ): ChatMessage[] {
    if (message?.role !== "assistant") {
      return [message];
    }

    const messageParts = Array.isArray(message.messageParts) ? [...message.messageParts] : [];
    if (messageParts.length === 0 || !messageParts.some((part) => part?.type === "tool_call")) {
      return [message];
    }

    if (this.hasFollowingExplicitToolMessages(messages, messageIndex)) {
      return [message];
    }

    const sortedParts = messageParts
      .map((part) => this.cloneMessagePart(part))
      .sort((left, right) => left.timestamp - right.timestamp);

    const rounds: ChatMessage[] = [];
    let bufferedParts: MessagePart[] = [];
    let toolClusterCount = 0;
    let roundIndex = 0;

    for (let idx = 0; idx < sortedParts.length; idx += 1) {
      const part = sortedParts[idx];
      if (part.type !== "tool_call") {
        bufferedParts.push(part);
        continue;
      }

      const toolCluster: MessagePart[] = [];
      while (idx < sortedParts.length && sortedParts[idx]?.type === "tool_call") {
        toolCluster.push(sortedParts[idx]);
        idx += 1;
      }
      idx -= 1;

      const clusterToolCalls = toolCluster.map((entry) => entry.data as ToolCall);
      if (!clusterToolCalls.every((toolCall) => this.isResolvedToolCallForTransport(toolCall))) {
        return [message];
      }

      toolClusterCount += 1;
      const roundMessage = this.buildTransportAssistantRoundMessage({
        sourceMessage: message,
        roundIndex,
        parts: [...bufferedParts, ...toolCluster],
      });
      if (roundMessage) {
        rounds.push(roundMessage);
        roundIndex += 1;
      }
      bufferedParts = [];
    }

    const finalRound = this.buildTransportAssistantRoundMessage({
      sourceMessage: message,
      roundIndex,
      parts: bufferedParts,
      annotations: message.annotations,
    });
    if (finalRound) {
      rounds.push(finalRound);
    }

    return rounds.length > 1 || toolClusterCount > 1 ? rounds : [message];
  }

  private hasFollowingExplicitToolMessages(messages: ChatMessage[], messageIndex: number): boolean {
    for (let idx = messageIndex + 1; idx < messages.length; idx += 1) {
      const nextMessage = messages[idx];
      if (nextMessage?.role === "tool") {
        return true;
      }
      break;
    }
    return false;
  }

  private buildTransportAssistantRoundMessage(params: {
    sourceMessage: ChatMessage;
    roundIndex: number;
    parts: MessagePart[];
    annotations?: ChatMessage["annotations"];
  }): ChatMessage | null {
    const { sourceMessage, roundIndex, annotations } = params;
    const parts = Array.isArray(params.parts) ? params.parts : [];
    const roundMessageId = this.deterministicId(
      `${sourceMessage.message_id || "assistant"}:transport:${roundIndex}`,
      "assistant"
    );

    const normalizedParts = parts.map((part) => {
      if (part.type !== "tool_call") {
        return part;
      }

      const toolCall = this.cloneToolCallForTransport(part.data as ToolCall, roundMessageId);
      return {
        ...part,
        data: toolCall,
      } as MessagePart;
    });

    const toolCalls = normalizedParts
      .filter((part): part is MessagePart & { type: "tool_call"; data: ToolCall } => part.type === "tool_call")
      .map((part) => part.data);
    const content = this.extractContentFromParts(normalizedParts);

    if (toolCalls.length === 0 && !this.hasRenderableContent(content)) {
      return null;
    }

    const message: ChatMessage = {
      role: "assistant",
      content: toolCalls.length > 0 && !this.hasRenderableContent(content) ? "" : content,
      message_id: roundMessageId,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    if (annotations && annotations.length > 0) {
      message.annotations = annotations;
    }

    return message;
  }

  private isResolvedToolCallForTransport(toolCall: ToolCall | undefined): boolean {
    if (!toolCall || typeof toolCall !== "object") {
      return false;
    }

    if (toolCall.state === "failed") {
      return true;
    }

    return toolCall.state === "completed" && toolCall.result !== undefined;
  }

  private cloneMessagePart(part: MessagePart): MessagePart {
    if (part.type === "tool_call") {
      return {
        ...part,
        data: this.cloneToolCallForTransport(part.data as ToolCall),
      };
    }

    if (part.type === "content" && Array.isArray(part.data)) {
      return {
        ...part,
        data: part.data.map((chunk) => ({ ...chunk })) as MultiPartContent[],
      };
    }

    return { ...part };
  }

  private cloneToolCallForTransport(toolCall: ToolCall, messageId?: string): ToolCall {
    const result = toolCall.result;
    const clonedResult = result
      ? {
          success: result.success,
          ...(result.data !== undefined
            ? {
                data:
                  result.data && typeof result.data === "object"
                    ? { ...(result.data as Record<string, unknown>) }
                    : result.data,
              }
            : {}),
          ...(result.error
            ? {
                error: {
                  code: result.error.code,
                  message: result.error.message,
                  ...(result.error.details !== undefined ? { details: result.error.details } : {}),
                },
              }
            : {}),
        }
      : undefined;

    return {
      ...toolCall,
      ...(messageId ? { messageId } : {}),
      request: {
        ...toolCall.request,
        function: {
          ...(toolCall.request?.function ?? {}),
        },
      },
      ...(clonedResult !== undefined ? { result: clonedResult } : {}),
    };
  }

  private extractContentFromParts(parts: MessagePart[]): string | MultiPartContent[] | null {
    let textContent = "";
    let multipartContent: MultiPartContent[] | null = null;

    const appendText = (text: string): void => {
      if (!text) return;
      if (multipartContent) {
        multipartContent.push({ type: "text", text });
      } else {
        textContent += text;
      }
    };

    const ensureMultipartContent = (): MultiPartContent[] => {
      if (!multipartContent) {
        multipartContent = [];
        if (textContent.length > 0) {
          multipartContent.push({ type: "text", text: textContent });
          textContent = "";
        }
      }
      return multipartContent;
    };

    for (const part of parts) {
      if (part.type !== "content") continue;

      const data = part.data;
      if (typeof data === "string") {
        appendText(data);
        continue;
      }

      if (Array.isArray(data)) {
        const target = ensureMultipartContent();
        target.push(...data.map((chunk) => ({ ...chunk })) as MultiPartContent[]);
        continue;
      }

      if (data != null) {
        appendText(String(data));
      }
    }

    if (multipartContent) {
      return multipartContent;
    }

    return textContent;
  }

  private hasRenderableContent(content: string | MultiPartContent[] | null): boolean {
    if (typeof content === "string") {
      return content.length > 0;
    }
    return Array.isArray(content) && content.length > 0;
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
        if (resolvedFile.extension.match(/^(jpg|jpeg|png|webp)$/i)) {
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
          if (matchingFile.extension.match(/^(jpg|jpeg|png|webp)$/i)) {
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
      if (ext && ["jpg", "jpeg", "png", "webp"].includes(ext)) {
        return null;
      }

      const resolved =
        this.app.metadataCache.getFirstLinkpathDest(cleanPath, "") ??
        this.app.vault.getAbstractFileByPath(cleanPath);
      if (
        resolved instanceof TFile &&
        ["jpg", "jpeg", "png", "webp"].includes((resolved.extension || "").toLowerCase())
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
   * Prepare messages with context files and an optional server-managed
   * instruction override.
   */
  public async prepareMessagesWithContext(
    messages: ChatMessage[],
    contextFiles: Set<string>,
    includeImages?: boolean,
    finalSystemPrompt?: string
  ): Promise<ChatMessage[]> {
    const expandedMessages = this.expandCompactAssistantMessages(messages || []);
    const { messages: sanitizedMessages } = pruneToolMessagesNotFollowingToolCalls(expandedMessages);
    const shouldIncludeImages = includeImages !== false;
    const preparedMessages: ChatMessage[] = [];

    let systemPromptContent =
      typeof finalSystemPrompt === "string" && finalSystemPrompt.trim().length > 0
        ? finalSystemPrompt.trim()
        : undefined;

    // Only augment explicit server-supplied prompt content; the thin client
    // no longer invents its own prompt when none is provided.
    if (systemPromptContent && this.shouldInjectObsidianBasesGuide(sanitizedMessages, contextFiles)) {
      systemPromptContent = `${systemPromptContent}\n\n${OBSIDIAN_BASES_SYNTAX_GUIDE}`;
    }

    // Add system message if we have content
    if (systemPromptContent) {
      preparedMessages.push({
        role: "system",
        content: systemPromptContent,
        message_id: this.deterministicId(systemPromptContent, "sys")
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
    for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
      if (sanitizedMessages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    const latestUserDocumentContext =
      documentIds.length > 0 && lastUserIndex !== -1 ? { documentIds } : undefined;

    // Add the actual chat messages, injecting context right before the latest user message.
    const explicitToolResultIds = new Set(
      sanitizedMessages
        .filter((msg) => msg?.role === "tool" && typeof msg.tool_call_id === "string" && msg.tool_call_id.length > 0)
        .map((msg) => String(msg.tool_call_id))
    );

    let idx = 0;
    while (idx < sanitizedMessages.length) {
      const msg = sanitizedMessages[idx];

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
        documentContext:
          idx === lastUserIndex && latestUserDocumentContext
            ? latestUserDocumentContext
            : msg.documentContext,
        ...(typeof msg.tool_call_id === "string" && { tool_call_id: msg.tool_call_id }),
        ...(typeof msg.name === "string" && msg.name.length > 0 && { name: msg.name }),
        ...((msg as any).reasoning_details && { reasoning_details: (msg as any).reasoning_details }),
      };

      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const synthesizedToolMessages = buildToolResultMessagesFromToolCalls(msg.tool_calls);
        const satisfiedToolCallIds = new Set<string>();
        for (const toolCall of msg.tool_calls) {
          const toolCallId = typeof toolCall?.id === "string" ? toolCall.id : "";
          if (!toolCallId) continue;
          if (explicitToolResultIds.has(toolCallId)) {
            satisfiedToolCallIds.add(toolCallId);
            continue;
          }
          if (synthesizedToolMessages.some((toolMessage) => toolMessage.tool_call_id === toolCallId)) {
            satisfiedToolCallIds.add(toolCallId);
          }
        }

        const preservedToolCalls = msg.tool_calls.filter(
          (toolCall) => typeof toolCall?.id === "string" && satisfiedToolCallIds.has(toolCall.id)
        );
        if (preservedToolCalls.length > 0) {
          (messageToPush as any).tool_calls = preservedToolCalls;
        }
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        (messageToPush as any).tool_calls = msg.tool_calls;
      }

      if (msg.content !== undefined) {
        messageToPush.content = msg.content;
      }
      preparedMessages.push(messageToPush as ChatMessage);

      if (msg.role === "assistant" && Array.isArray((messageToPush as any).tool_calls)) {
        const syntheticToolMessages = buildToolResultMessagesFromToolCalls((messageToPush as any).tool_calls).filter(
          (toolMessage) =>
            typeof toolMessage.tool_call_id === "string"
            && !explicitToolResultIds.has(toolMessage.tool_call_id)
        );
        for (const toolMessage of syntheticToolMessages) {
          preparedMessages.push(toolMessage);
        }
      }

      idx += 1;
    }

    return preparedMessages;
  }
}
