import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { ChatMessage, ChatRole, SystemPromptPreset, MessagePart } from "../../types";
import type { SerializedToolCall, ToolCall, ToolCallResult } from "../../types/toolCalls";
import type { ToolCallManager } from "./ToolCallManager";
import { ChatMarkdownSerializer } from "./storage/ChatMarkdownSerializer";
import { mergeAdjacentReasoningParts } from "./utils/MessagePartCoalescing";

// Helper function to process tool calls in a message
function processMessageToolCalls(message: ChatMessage, toolCallManager?: ToolCallManager): ChatMessage {
  if (message.role === 'tool' && message.content && toolCallManager) {
    try {
      const toolCall = toolCallManager.getToolCall(message.tool_call_id || '');
      if (toolCall) {
        // Safely parse JSON content
        let parsedContent;
        try {
          parsedContent = JSON.parse(message.content as string);
        } catch (parseError) {
          return message; // Return original message if JSON parse fails
        }
        
        const processedContent = toolCallManager.processToolResult(
          parsedContent,
          toolCall.request.function.name
        );
        
        // Safely serialize back to JSON with size checks
        try {
          const serialized = JSON.stringify(processedContent, null, 2);
          
          // Check size before returning
          if (serialized.length > 50000) { // 50KB limit for message content
            return {
              ...message,
              content: JSON.stringify({
                ...processedContent,
                truncation_info: `Content truncated - original size: ${serialized.length} characters`
              }, null, 2)
            };
          }
          
          return { ...message, content: serialized };
        } catch (stringifyError) {
          // Return original message if serialization fails
          return message;
        }
      }
    } catch (error) {
      // Return original message on any error
      return message;
    }
  }
  return message;
}

interface ContextFile {
  path: string;
  type: "source" | "extraction";
}

interface ChatMetadata {
  id: string;
  model: string;
  created: string;
  lastModified: string;
  title: string;
  version?: number;
  tags?: string[];
  context_files?: ContextFile[];
  systemMessage?: {
    type: "general-use" | "concise" | "agent" | "custom";
    path?: string;
  };
  chatFontSize?: "small" | "medium" | "large";
  agentMode?: boolean;
}

export class ChatStorageService {
  private app: App;
  private chatDirectory: string;
  private toolCallManager?: ToolCallManager;

  constructor(app: App, chatDirectory: string, toolCallManager?: ToolCallManager) {
    this.app = app;
    this.chatDirectory = chatDirectory;
    this.toolCallManager = toolCallManager;
  }

  private normalizeTag(tag: string): string {
    return tag.trim().replace(/^#+/, "");
  }

  private normalizeTags(raw: unknown): string[] {
    const tags: string[] = [];
    const addTag = (value: string) => {
      const normalized = this.normalizeTag(value);
      if (normalized) tags.push(normalized);
    };

    if (Array.isArray(raw)) {
      raw.forEach((entry) => {
        if (typeof entry === "string") addTag(entry);
      });
      return tags;
    }

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return tags;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            parsed.forEach((entry) => {
              if (typeof entry === "string") addTag(entry);
            });
            return tags;
          }
          if (typeof parsed === "string") {
            addTag(parsed);
            return tags;
          }
        } catch {
          // Fall through to treat as a single tag
        }
      }
      addTag(trimmed);
    }

    return tags;
  }

  private resolveDefaultChatTag(): string {
    const systemSculptPlugin = (this.app as any)?.plugins?.plugins?.["systemsculpt-ai"];
    const rawTag = systemSculptPlugin?.settings?.defaultChatTag;
    if (typeof rawTag !== "string") return "";
    return this.normalizeTag(rawTag);
  }

  private mergeTags(existingTags: string[], defaultTag: string): string[] {
    const merged = [...existingTags];
    if (defaultTag) merged.push(defaultTag);
    return Array.from(new Set(merged));
  }

  // Master save method - always saves in the new, simple format
  async saveChat(
    chatId: string,
    messages: ChatMessage[],
    selectedModelId: string,
    contextFiles?: Set<string>,
    customPromptFilePath?: string,
    systemPromptType?: "general-use" | "concise" | "agent" | "custom",
    systemPromptPath?: string,
    title?: string,
    chatFontSize?: "small" | "medium" | "large",
    agentMode?: boolean
  ): Promise<{ version: number }> {
    try {
      const { version } = await this.saveChatSimple(
        chatId,
        messages,
        selectedModelId,
        contextFiles,
        customPromptFilePath,
        systemPromptType,
        systemPromptPath,
        title,
        chatFontSize,
        agentMode
      );
      return { version };
    } catch (error) {
      throw new Error(`Failed to save chat to ${chatId}.md`);
    }
  }
  
  private async saveChatSimple(
    chatId: string,
    messages: ChatMessage[],
    selectedModelId: string,
    contextFiles?: Set<string>,
    customPromptFilePath?: string,
    systemPromptType?: "general-use" | "concise" | "agent" | "custom",
    systemPromptPath?: string,
    title?: string,
    chatFontSize?: "small" | "medium" | "large",
    agentMode?: boolean
  ): Promise<{ filePath: string; version: number }> {
    let filePath = `[unknown-path]/${chatId}.md`;
    try {
      filePath = `${this.chatDirectory}/${chatId}.md`;
      const now = new Date().toISOString();
      const vault = this.app.vault;
      let fileExists = false;
      let existingMetadata: ChatMetadata | null = null;

      const file = vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        fileExists = true;
        const content = await vault.read(file);
        existingMetadata = this.parseMetadata(content);
      }

      const creationDate = existingMetadata?.created || now;
      const existingTags = existingMetadata?.tags ?? [];
      const defaultChatTag = this.resolveDefaultChatTag();
      const mergedTags = this.mergeTags(existingTags, defaultChatTag);
      // CRITICAL: Only increment version if we're actually changing content
      // If messages are empty and file exists with content, preserve the version
      const currentVersion = Number(existingMetadata?.version) || 0;
      let newVersion = currentVersion + 1;
      
      // Safety check: Don't increment version if we're about to save empty messages over existing content
      if (messages.length === 0 && fileExists && existingMetadata && file instanceof TFile) {
        // Check if the existing file has messages (simple heuristic: check for message markers)
        const existingContent = await vault.read(file);
        if (existingContent.includes('SYSTEMSCULPT-MESSAGE-START')) {
          throw new Error('Cannot save empty messages over existing chat content');
        }
      }

      const metadata: ChatMetadata = {
        id: chatId,
        model: selectedModelId,
        created: creationDate,
        lastModified: now,
        title: title || existingMetadata?.title || "Untitled Chat",
        version: newVersion,
        systemMessage: {
          type: systemPromptType || 'general-use',
          path: (systemPromptType === 'custom' && systemPromptPath) ? systemPromptPath : undefined
        },
        chatFontSize: chatFontSize || "medium",
        agentMode: agentMode !== undefined ? agentMode : true
      };

      if (mergedTags.length > 0) {
        metadata.tags = mergedTags;
      }

      if (contextFiles && contextFiles.size > 0) {
        metadata.context_files = Array.from(contextFiles).map((path) => ({
          path,
          type: path.includes("/Extractions/") ? "extraction" : "source",
        }));
      }

      const processedMessages = messages.map(msg => processMessageToolCalls(msg, this.toolCallManager));
      const messagesContent = ChatMarkdownSerializer.serializeMessages(processedMessages);

      const fullContent = `---\n${stringifyYaml(metadata)}---\n\n${messagesContent}`;

      const SystemSculptPlugin = (this.app as any).plugins.plugins["systemsculpt-ai"];

        if (SystemSculptPlugin && SystemSculptPlugin.directoryManager) {
          await SystemSculptPlugin.directoryManager.ensureDirectoryByPath(this.chatDirectory);
        } else {
            const exists = await this.app.vault.adapter.exists(this.chatDirectory);
            if (!exists) {
              await this.app.vault.createFolder(this.chatDirectory);
            }
      }

      if (fileExists && file instanceof TFile) {
        await vault.modify(file, fullContent);
      } else {
        await vault.create(filePath, fullContent);
      }
      
      return { filePath, version: newVersion };
    } catch (error) {
      throw error;
    }
  }

  async loadChats(): Promise<
    {
      id: string;
      messages: ChatMessage[];
      selectedModelId: string;
      lastModified: number;
      title: string;
      version?: number;
      context_files?: string[];
      customPromptFilePath?: string;
    }[]
  > {
    try {
      const files = await this.app.vault.adapter.list(this.chatDirectory);
      const chatFiles = files.files.filter((f) => f.endsWith(".md"));

      const chats = await Promise.allSettled(
        chatFiles.map(async (filePath) => {
          try {
            // NEW: Try to read file stats first to get a reliable last modified timestamp
            let fileModifiedTime: number | null = null;
            const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
            if (abstractFile instanceof TFile) {
              fileModifiedTime = abstractFile.stat.mtime;
            }

            const content = await this.app.vault.adapter.read(filePath);
            
            // Validate file structure before attempting to parse
            if (!this.isValidChatFile(content)) {
              // Silently skip files that are not valid chat files (e.g., empty files, other markdown notes).
              // A warning will be logged by the parser later if a file appears to be a chat file but is corrupted.
              return null;
            }
            
            // Extract filename without extension for chatId
            const filename = filePath.split('/').pop()?.replace('.md', '') || '';
            const parsed = this.parseMarkdownContent(content, filename);

            if (!parsed) return null;

            // If we managed to read a reliable mtime from the file, prefer that over whatever the parser returned.
            if (fileModifiedTime && !isNaN(fileModifiedTime)) {
              parsed.lastModified = fileModifiedTime;
            }

            return parsed;
          } catch (error) {
            return null;
          }
        })
      );

      // Extract successful results and filter out nulls
      const successfulChats = chats
        .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
        .map(result => result.value)
        .filter((chat): chat is NonNullable<typeof chat> => chat !== null);

      // Log any failures for debugging
      const failedCount = chats.length - successfulChats.length;
      if (failedCount > 0) {
      }

      return successfulChats;
    } catch (error) {
      return [];
    }
  }

  /** @deprecated Streaming writes are now handled by debounced saveChat() */
  async saveStreamingMessage(): Promise<void> {
    return;
  }

  async loadChat(chatId: string): Promise<{
    id: string;
    messages: ChatMessage[];
    selectedModelId: string;
    lastModified: number;
    title: string;
    version?: number;
    context_files?: string[];
    customPromptFilePath?: string;
    systemPromptType: "general-use" | "concise" | "agent" | "custom";
    systemPromptPath?: string;
    chatFontSize?: "small" | "medium" | "large";
    agentMode?: boolean;
  } | null> {
    try {
      const filePath = `${this.chatDirectory}/${chatId}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (!(file instanceof TFile)) {
        return null;
      }

      const content = await this.app.vault.read(file);
      return this.parseMarkdownContent(content, chatId);
    } catch (error) {
      return null;
    }
  }

  private generateMarkdownContent(
    metadata: ChatMetadata,
    messages: ChatMessage[]
  ): string {
    const yamlMetadata = {
      systemsculpt_chat: true,
      ...metadata,
    };

    const metadataSection = [
      "---",
      stringifyYaml(yamlMetadata).trim(),
      "---",
      "",
    ].join("\n");

    const messagesSection = messages
      .map((msg) =>
        [
          `<!-- SYSTEMSCULPT-MESSAGE-START role="${msg.role}" message-id="${msg.message_id}" -->`,
          msg.content,
          "<!-- SYSTEMSCULPT-MESSAGE-END -->",
          "",
        ].join("\n")
      )
      .join("\n");

    return metadataSection + messagesSection;
  }

  private parseMetadata(content: string): ChatMetadata | null {
    try {
      // More strict regex: frontmatter must be at the very beginning of the file
      const metadataMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!metadataMatch) return null;

      const yamlContent = metadataMatch[1];
      
      // Comprehensive validation to ensure this is actually YAML frontmatter
      if (!this.isValidYamlFrontmatter(yamlContent)) {
        return null;
      }

      const parsed = parseYaml(yamlContent);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      // Extract with defaults for essential fields
      const {
        id = '',
        model = '',
        created = new Date().toISOString(),
        lastModified = new Date().toISOString(),
        title = 'Untitled Chat',
        context_files = [],
        version: versionRaw = 0,
      } = parsed;
      const tags = this.normalizeTags((parsed as any).tags);

      if (!id) {
        return null; // ID is the only absolutely required field
      }

      // Process context files (simple approach)
      const processedContextFiles = Array.isArray(context_files) ? context_files.map(
        (file: any): ContextFile => {
          if (typeof file === "string") {
            const isExtraction = file.includes("/Extractions/");
            return { path: file, type: isExtraction ? "extraction" : "source" };
          } else if (file && typeof file === 'object' && file.path) {
            return {
              path: file.path,
              type: file.type || "source"
            };
          } else {
            return { path: '', type: 'source' };
          }
        }
      ).filter((file) => file.path !== '') : [];

      // Process system message (simplified approach)
      let systemMessageType: "general-use" | "concise" | "agent" | "custom" = "general-use";
      let systemMessagePath: string | undefined = undefined;

      // First try to use the systemMessage object if it exists
      if (parsed.systemMessage && typeof parsed.systemMessage === 'object') {
        const type = parsed.systemMessage.type?.toLowerCase();

        // Only accept valid types
        if (type === "general-use" || type === "concise" || type === "agent" || type === "custom") {
          systemMessageType = type;

          // Only set path for custom type
          if (type === "custom" && parsed.systemMessage.path) {
            systemMessagePath = parsed.systemMessage.path.replace(/^\[\[(.*?)\]\]$/, "$1");
          }
        }
      }
      // Fallback for old customPromptFilePath format
      else if (parsed.customPromptFilePath) {
        systemMessageType = "custom";
        systemMessagePath = parsed.customPromptFilePath.replace(/^\[\[(.*?)\]\]$/, "$1");
      }

      return {
        id,
        model,
        created,
        lastModified,
        title: title || id, // Use ID if title is missing
        version: Number(versionRaw) || 0,
        tags: tags.length > 0 ? tags : undefined,
        context_files: processedContextFiles,
        systemMessage: {
          type: systemMessageType,
          path: systemMessagePath
        },
        chatFontSize: parsed.chatFontSize as "small" | "medium" | "large" | undefined
      };
    } catch (error) {
      return null;
    }
  }

  private parseMarkdownContent(content: string, filename?: string): {
    id: string;
    messages: ChatMessage[];
    selectedModelId: string;
    lastModified: number;
    title: string;
    version?: number;
    context_files?: string[];
    systemPromptType: 'general-use' | 'concise' | 'agent' | 'custom';
    systemPromptPath?: string;
    chatFontSize?: "small" | "medium" | "large";
    agentMode?: boolean;
  } | null {
    // Handle very old five-backtick legacy format first
    if (this.isFiveBacktickLegacyFile(content)) {
      return this.parseFiveBacktickLegacyFile(content, filename);
    }

    // NEW: Delegate modern parsing logic to central serializer
    const parsed = ChatMarkdownSerializer.parseMarkdown(content);
    if (parsed) {
      const { metadata, messages } = parsed;
      return this.finalizeParsedData(metadata as any, messages);
    }

    return null;
  }

  // Utility to finalize the parsed data into the expected return format
  private finalizeParsedData(metadata: ChatMetadata, messages: ChatMessage[]): any {
     const normalizedMessages = this.normalizeLegacyToolMessages(messages);
     return {
      id: metadata.id,
      messages: normalizedMessages,
      selectedModelId: metadata.model,
      lastModified: new Date(metadata.lastModified).getTime(),
      title: metadata.title,
      version: metadata.version || 0,
      context_files: metadata.context_files?.map((f) => f.path) || [],
      systemPromptType: metadata.systemMessage?.type || 'general-use',
      systemPromptPath: metadata.systemMessage?.path,
      chatFontSize: metadata.chatFontSize,
      agentMode: metadata.agentMode !== undefined ? metadata.agentMode : true,
    };
  }

  /**
   * Normalize legacy persisted tool messages into tool_calls attached to the
   * preceding assistant message. This removes standalone role: "tool" entries
   * from loaded chats while preserving their results.
   */
  private normalizeLegacyToolMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages;
    }

    const result: ChatMessage[] = [];
    let lastAssistant: ChatMessage | null = null;

    const generateToolCallId = (): string => {
      // Generate OpenAI-compatible call id
      const uuid = this.generateMessageId().replace(/-/g, '').substring(0, 24);
      return `call_${uuid}`;
    };

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        lastAssistant = msg;
        result.push(msg);
        continue;
      }

      if (msg.role === 'tool') {
        // Parse content safely
        let parsed: any = null;
        const rawContent = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? JSON.stringify(msg.content) : '');
        try {
          parsed = rawContent ? JSON.parse(rawContent) : null;
        } catch {
          parsed = rawContent || null;
        }

        // Determine result shape
        let reconstructedResult: ToolCallResult;
        let reconstructedState: 'completed' | 'failed' | 'denied' = 'completed';

        if (parsed && typeof parsed === 'object' && parsed.error) {
          // Error object present
          const errorObj = parsed.error;
          const code = String(errorObj.code || 'EXECUTION_FAILED');
          if (code === 'USER_DENIED') {
            reconstructedState = 'denied';
          } else {
            reconstructedState = 'failed';
          }
          reconstructedResult = {
            success: false,
            error: {
              code,
              message: String(errorObj.message || 'Tool execution failed.'),
              details: errorObj.details,
            },
          };
        } else {
          reconstructedResult = { success: true, data: parsed ?? rawContent };
          reconstructedState = 'completed';
        }

        // Attach to the preceding assistant message when possible
        if (lastAssistant) {
          const toolCalls: any[] = Array.isArray(lastAssistant.tool_calls) ? [...lastAssistant.tool_calls] : [];
          // Use existing id when present, otherwise generate a new one
          const callId = (msg as any).tool_call_id && typeof (msg as any).tool_call_id === 'string'
            ? (msg as any).tool_call_id as string
            : generateToolCallId();

          // Try to find an existing tool call with same id and fill result
          let matched = false;
          for (const tc of toolCalls) {
            if (tc.id === callId) {
              // Ensure standardized structure
              if (!tc.request) {
                tc.request = {
                  id: callId,
                  type: 'function',
                  function: { name: 'legacy.recovered', arguments: '{}' },
                };
              }
              tc.result = reconstructedResult;
              tc.state = reconstructedState;
              matched = true;
              break;
            }
          }

          if (!matched) {
            // Create a new standardized ToolCall
            const newToolCall: any = {
              id: callId,
              messageId: lastAssistant.message_id,
              request: {
                id: callId,
                type: 'function',
                function: { name: 'legacy.recovered', arguments: '{}' },
              },
              state: reconstructedState,
              timestamp: Date.now(),
              result: reconstructedResult,
              autoApproved: false,
            };
            toolCalls.push(newToolCall);
          }

          // Assign normalized tool_calls back
          (lastAssistant as any).tool_calls = toolCalls as any;
          // Skip adding this legacy tool message to the result array
          continue;
        }

        // No preceding assistant message – convert to a lightweight system note
        const summaryPrefix = 'Context Note (legacy tool result): ';
        const summaryContent = typeof reconstructedResult.success === 'boolean' && reconstructedResult.success
          ? (typeof reconstructedResult.data === 'string' ? reconstructedResult.data : JSON.stringify(reconstructedResult.data))
          : JSON.stringify(reconstructedResult.error);
        result.push({
          role: 'system',
          content: `${summaryPrefix}${summaryContent}`,
          message_id: this.generateMessageId(),
        } as any);
        continue;
      }

      // Any other roles pass through untouched
      result.push(msg);
    }

    // Coalesce consecutive assistant messages (tool continuations) into a single
    // assistant message so the UI renders one coherent "assistant turn" container.
    // The underlying markdown stays unchanged; we only reshape the in-memory representation.
    const cloneToolCallForMessage = (toolCall: ToolCall, messageId: string): ToolCall => {
      const cloned = JSON.parse(JSON.stringify(toolCall)) as ToolCall;
      cloned.messageId = messageId;
      return cloned;
    };

    const toContentText = (content: ChatMessage["content"]): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((part: any) => {
            if (part?.type === "text" && typeof part.text === "string") return part.text;
            if (part?.type === "image_url" && part.image_url?.url) return `![Image Context](${part.image_url.url})`;
            return "";
          })
          .join("\n");
      }
      return content == null ? "" : String(content);
    };

    const toParts = (msg: ChatMessage): MessagePart[] => {
      if (Array.isArray(msg.messageParts) && msg.messageParts.length > 0) {
        return msg.messageParts.map((p) => ({ ...p })).sort((a, b) => a.timestamp - b.timestamp);
      }

      const parts: MessagePart[] = [];
      let idx = 0;

      if (typeof msg.reasoning === "string" && msg.reasoning.length > 0) {
        parts.push({
          id: `reasoning-${msg.message_id}-${idx}`,
          type: "reasoning",
          timestamp: idx++,
          data: msg.reasoning,
        });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          parts.push({
            id: `tool_call_part-${tc.id}`,
            type: "tool_call",
            timestamp: idx++,
            data: tc,
          });
        }
      }

      const contentText = toContentText(msg.content);
      if (contentText.trim().length > 0 || (Array.isArray(msg.content) && msg.content.length > 0)) {
        parts.push({
          id: `content-${msg.message_id}-${idx}`,
          type: "content",
          timestamp: idx++,
          data: msg.content ?? "",
        });
      }

      return parts;
    };

    const extractContentFromParts = (parts: MessagePart[]): string => {
      let text = "";
      for (const part of parts) {
        if (part.type !== "content") continue;
        text += toContentText(part.data as any);
      }
      return text;
    };

    const extractReasoningFromParts = (parts: MessagePart[]): string => {
      let text = "";
      for (const part of parts) {
        if (part.type !== "reasoning") continue;
        if (typeof part.data === "string") text += part.data;
      }
      return text;
    };

    const coalesced: ChatMessage[] = [];
    let activeAssistant: ChatMessage | null = null;
    let mergedPartCounter = 0;

    const mergeAssistantIntoActive = (incoming: ChatMessage): void => {
      if (!activeAssistant) return;

      const targetId = activeAssistant.message_id;

      // Merge tool calls and keep messageId stable on the group root.
      const mergedToolCallMap = new Map<string, ToolCall>();
      for (const call of Array.isArray(activeAssistant.tool_calls) ? activeAssistant.tool_calls : []) {
        mergedToolCallMap.set(call.id, cloneToolCallForMessage(call, targetId));
      }
      for (const call of Array.isArray(incoming.tool_calls) ? incoming.tool_calls : []) {
        const existing = mergedToolCallMap.get(call.id);
        const reassigned = cloneToolCallForMessage(call, targetId);
        if (existing?.result && !reassigned.result) {
          reassigned.result = existing.result;
        }
        mergedToolCallMap.set(call.id, reassigned);
      }
      const mergedToolCalls = Array.from(mergedToolCallMap.values());
      activeAssistant.tool_calls = mergedToolCalls.length > 0 ? mergedToolCalls : undefined;

      // Merge parts in message order and assign stable increasing timestamps so the
      // unified renderer keeps them grouped correctly.
      const existingParts = toParts(activeAssistant);
      const incomingParts = toParts(incoming);

      const combined: MessagePart[] = [];
      const pushPart = (part: MessagePart, sourceMessageId: string) => {
        const id = part.id
          ? part.id
          : `ss-part-${sourceMessageId}-${mergedPartCounter}`;
        mergedPartCounter += 1;

        if (part.type === "tool_call") {
          const original = part.data as any as ToolCall | undefined;
          const replacement = original ? mergedToolCallMap.get(original.id) : undefined;
          combined.push({
            id,
            type: "tool_call",
            timestamp: mergedPartCounter,
            data: replacement ?? part.data,
          });
          return;
        }

        if (part.type === "reasoning") {
          combined.push({
            id,
            type: "reasoning",
            timestamp: mergedPartCounter,
            data: typeof part.data === "string" ? part.data : String(part.data ?? ""),
          });
          return;
        }

        // content
        combined.push({
          id,
          type: "content",
          timestamp: mergedPartCounter,
          data: part.data as string | any[],
        });
      };

      existingParts.forEach((p) => pushPart(p, targetId));
      incomingParts.forEach((p) => pushPart(p, incoming.message_id));

      const normalizedParts = mergeAdjacentReasoningParts(combined);
      activeAssistant.messageParts = normalizedParts;

      const mergedContent = extractContentFromParts(normalizedParts);
      activeAssistant.content = mergedContent;
      const mergedReasoning = extractReasoningFromParts(normalizedParts);
      activeAssistant.reasoning = mergedReasoning || undefined;

      if (incoming.annotations && incoming.annotations.length > 0) {
        activeAssistant.annotations = incoming.annotations;
      }
      if (typeof incoming.webSearchEnabled === "boolean") {
        activeAssistant.webSearchEnabled = incoming.webSearchEnabled;
      }
    };

    for (const msg of result) {
      if (msg.role !== "assistant") {
        activeAssistant = null;
        coalesced.push(msg);
        continue;
      }

      if (!activeAssistant) {
        // Ensure tool call objects reference the message id they belong to.
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          msg.tool_calls = msg.tool_calls.map((call) => cloneToolCallForMessage(call, msg.message_id));
        }
        coalesced.push(msg);
        activeAssistant = msg;
        continue;
      }

      mergeAssistantIntoActive(msg);
    }

    return coalesced;
  }

  /**
   * Validate and fix tool call IDs to ensure they follow OpenAI format
   * Also creates a mapping for tool result messages that reference the old IDs
   */
  private validateAndFixToolCallIds(toolCalls: any[], idMapping?: Map<string, string>): any[] {
    const generateUUID = () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };

    return toolCalls.map(toolCall => {
      if (!toolCall.id) {
        // Generate OpenAI-compatible ID if missing
        const newId = `call_${generateUUID().replace(/-/g, '').substring(0, 24)}`;
        // Generated missing tool call ID for compatibility
        return { ...toolCall, id: newId };
      }

      // Check if the ID is in an unexpected format and needs fixing
      if (toolCall.id.startsWith('tool_') && toolCall.id.includes('_mcp-')) {
        // Convert MCP-style ID to OpenAI format
        const newId = `call_${generateUUID().replace(/-/g, '').substring(0, 24)}`;
        // Tool call ID converted to OpenAI format for compatibility
        
        // Store the mapping for tool result messages
        if (idMapping) {
          idMapping.set(toolCall.id, newId);
        }
        
        return { ...toolCall, id: newId };
      }

      // ID looks valid, keep as-is
      return toolCall;
    });
  }

  /**
   * Validates that a file has the expected chat file structure
   */
  private isValidChatFile(content: string): boolean {
    // Check for modern format with frontmatter
    const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(content);
    
    // Check for SystemSculpt message markers (current format)
    const hasMessageMarkers = content.includes('SYSTEMSCULPT-MESSAGE-START') && 
                              content.includes('SYSTEMSCULPT-MESSAGE-END');
    
    // Check for legacy format patterns
    const hasLegacyFormat = this.isFiveBacktickLegacyFile(content);
    
    return hasFrontmatter || hasMessageMarkers || hasLegacyFormat;
  }

  /**
   * Detects if this is a legacy chat file format
   */
  private isFiveBacktickLegacyFile(content: string): boolean {
    // Legacy format has specific headers and code block patterns
    const hasContextFilesHeader = content.includes('# Context Files');
    const hasChatHistoryHeader = content.includes('# AI Chat History');
    const hasUserBlocks = /`{4,5}user/.test(content);
    const hasAiBlocks = /`{4,5}ai/.test(content);
    
    // Must have the header structure AND message blocks
    return (hasContextFilesHeader || hasChatHistoryHeader) && (hasUserBlocks || hasAiBlocks);
  }

  /**
   * Validates if content is actually YAML frontmatter and not markdown content
   */
  private isValidYamlFrontmatter(content: string): boolean {
    // Check for obvious markdown patterns that shouldn't be in YAML
    const markdownPatterns = [
      /^\s*#\s+/, // Headers
      /\|\s*\w+\s*\|.*\|/, // Tables (like "| Database | Storage Model |")
      /^\s*\d+\.\s+\*\*/, // Numbered lists with bold (like "1. **Plan Your Will Early**")
      /^\s*[-*+]\s+/, // Unordered lists
      /```/, // Code blocks
      /\[.*\]\(.*\)/, // Markdown links
      /!\[.*\]\(.*\)/, // Images
    ];

    // If any markdown patterns are found, it's likely not YAML
    for (const pattern of markdownPatterns) {
      if (pattern.test(content)) {
        return false;
      }
    }

    // Check for basic YAML structure indicators
    const yamlIndicators = [
      /^\s*\w+\s*:/, // Key-value pairs
      /^\s*-\s*\w+\s*:/, // Array of objects
      /^\s*\w+\s*:\s*\[/, // Arrays
      /^\s*\w+\s*:\s*['"]/, // Quoted strings
    ];

    // Content should have at least one YAML indicator
    const hasYamlStructure = yamlIndicators.some(pattern => pattern.test(content));
    
    // Additional checks for our specific chat metadata structure
    const hasExpectedFields = /\bid\s*:/.test(content) || /\bmodel\s*:/.test(content) || /\btitle\s*:/.test(content);
    
    return hasYamlStructure || hasExpectedFields;
  }

  /**
   * Format tool arguments for display
   */
  private formatToolArguments(args: string): string {
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args; // Return as-is if not valid JSON
    }
  }

  /**
   * Reconstruct message parts from chronological content blocks for consistency
   */
  private reconstructMessagePartsFromContent(content: string, reasoning: string, toolCalls: any[]): MessagePart[] {
    const parts: MessagePart[] = [];
    let timestamp = Date.now();
    let toolCallIndex = 0;
    
    // Parse chronological blocks in order they appear in content
    // Look for REASONING-BLOCK, TOOL-CALL-DATA, and CONTENT-PART
    const blockPattern = /<!-- REASONING-BLOCK -->\n([\s\S]*?)\n<!-- \/REASONING-BLOCK -->|<!-- TOOL-CALL-DATA\n([\s\S]*?)\n-->|<!-- CONTENT-PART -->\n([\s\S]*?)\n<!-- \/CONTENT-PART -->/g;
    let match;
    
    while ((match = blockPattern.exec(content)) !== null) {
      if (match[1]) {
        // Reasoning block
        const reasoningTimestamp = timestamp++;
        parts.push({
          id: `reasoning-${reasoningTimestamp}`,
          type: 'reasoning',
          timestamp: reasoningTimestamp,
          data: match[1].trimEnd() // Only trim trailing whitespace, preserve internal formatting
        });
      } else if (match[2]) {
        // Tool call data
        try {
          const toolCallData = JSON.parse(match[2]);
          const toolCallTimestamp = timestamp++;
          parts.push({
            id: `tool_call-${toolCallTimestamp}`,
            type: 'tool_call',
            timestamp: toolCallTimestamp,
            data: toolCallData
          });
        } catch (error) {
        }
      } else if (match[3]) {
        // Content part
        const contentTimestamp = timestamp++;
        parts.push({
          id: `content-${contentTimestamp}`,
          type: 'content',
          timestamp: contentTimestamp,
          data: match[3].trim()
        });
      }
    }
    
    // CRITICAL: Always add passed-in tool calls if they weren't found in blocks
    // This handles cases where tool calls were extracted but not matched by the regex
    const foundToolCallIds = new Set(
      parts.filter(p => p.type === 'tool_call')
        .map(p => (p.data as any).id)
    );
    
    if (toolCalls && toolCalls.length > 0) {
      toolCalls.forEach(toolCall => {
        if (!foundToolCallIds.has(toolCall.id)) {
          const toolCallTimestamp = timestamp++;
          parts.push({
            id: `tool_call-${toolCallTimestamp}`,
            type: 'tool_call',
            timestamp: toolCallTimestamp,
            data: toolCall
          });
        }
      });
    }
    
    // If no chronological blocks found, fall back to simple reconstruction
    if (parts.length === 0) {
      if (reasoning) {
        const reasoningTimestamp = timestamp++;
        parts.push({
          id: `reasoning-${reasoningTimestamp}`,
          type: 'reasoning',
          timestamp: reasoningTimestamp,
          data: reasoning
        });
      }
      
      // Add content as final part
      const cleanContent = this.extractNonChronologicalContent(content);
      if (cleanContent.trim()) {
        const contentTimestamp = timestamp++;
        parts.push({
          id: `content-${contentTimestamp}`,
          type: 'content',
          timestamp: contentTimestamp,
          data: cleanContent
        });
      }
    }
    
    // Always add clean content at the end if we have parts
    if (parts.length > 0) {
      const cleanContent = this.extractNonChronologicalContent(content);
      if (cleanContent.trim()) {
        // Check if we already have a content part
        const hasContentPart = parts.some(p => p.type === 'content');
        if (!hasContentPart) {
          const contentTimestamp = timestamp++;
          parts.push({
            id: `content-${contentTimestamp}`,
            type: 'content',
            timestamp: contentTimestamp,
            data: cleanContent
          });
        }
      }
    }
    
    return parts;
  }

  /**
   * Extract only the non-chronological content (regular text) from storage content
   */
  private extractNonChronologicalContent(content: string): string {
    // Remove all chronological blocks
    let cleaned = content
      .replace(/<!-- REASONING-BLOCK -->\n[\s\S]*?\n<!-- \/REASONING-BLOCK -->/g, '')
      .replace(/<!-- TOOL-CALL-DATA\n[\s\S]*?\n-->/g, '')
      .replace(/<!-- CONTENT-PART -->\n[\s\S]*?\n<!-- \/CONTENT-PART -->/g, '');
    
    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n\n\n+/g, '\n\n').trim();
    
    return cleaned;
  }

  /**
   * Check if content contains chronological blocks from storage
   */
  private containsChronologicalBlocks(content: string): boolean {
    return content.includes('<!-- REASONING-BLOCK -->') ||
           content.includes('<!-- TOOL-CALL-DATA') ||
           content.includes('<!-- CONTENT-PART -->');
  }

  /**
   * Parse legacy chat file format (old ````user/````ai format)
   */
  private parseFiveBacktickLegacyFile(content: string, filename?: string): {
    id: string;
    messages: ChatMessage[];
    selectedModelId: string;
    lastModified: number;
    title: string;
    version?: number;
    context_files?: string[];
    systemPromptType: "general-use" | "concise" | "agent" | "custom";
    systemPromptPath?: string;
    agentMode?: boolean;
  } | null {
    try {
      // Silently parse legacy chat file - backwards compatibility working as expected
      
      const messages: ChatMessage[] = [];
      const timestamp = Date.now();
      // Use filename as chatId for legacy files, fallback to random ID
      const chatId = filename || this.generateMessageId();
      
      // Extract context files from the legacy format
      const contextFiles: string[] = [];
      const contextSection = content.match(/# Context Files\n([\s\S]*?)(?=# AI Chat History|$)/);
      if (contextSection && contextSection[1]) {
        const links = contextSection[1].match(/\[\[(.*?)\]\]/g);
        if (links) {
          contextFiles.push(...links.map(link => link.replace(/\[\[(.*?)\]\]/, '$1')));
          // Found context files - silent discovery
        }
      }
      
      // Parse messages from code blocks
      // Match patterns like `````user or ````ai-gpt-4o
      const messageRegex = /`{4,5}(user|ai(?:-[\w-]+)?)\n([\s\S]*?)\n`{4,5}/g;
      
      let match;
      while ((match = messageRegex.exec(content)) !== null) {
        const rolePrefix = match[1];
        const messageContent = match[2].trim();
        
        // Legacy message found and parsed successfully
        
        // Determine role
        let role: ChatRole;
        if (rolePrefix === 'user') {
          role = 'user';
        } else if (rolePrefix.startsWith('ai')) {
          role = 'assistant';
        } else {
          continue; // Skip unknown roles
        }
        
        // Generate message ID
        const messageId = this.generateMessageId();
        
        messages.push({
          role,
          content: messageContent,
          message_id: messageId,
        });
      }
      
      // Legacy parser extracted messages - silent success
      
      // Extract title from content or use fallback
      let title = "Legacy Chat";
      const firstUserMessage = messages.find(m => m.role === 'user');
      if (firstUserMessage && typeof firstUserMessage.content === 'string') {
        // Use first 50 characters of first user message as title
        title = firstUserMessage.content.substring(0, 50).replace(/\n/g, ' ').trim();
        if (title.length >= 50) title += '...';
      }
      
      const result = {
        id: chatId,
        messages,
        selectedModelId: "gpt-4o", // Default model for legacy files
        lastModified: timestamp,
        title,
        version: 0,
        context_files: contextFiles.length > 0 ? contextFiles : undefined,
        systemPromptType: "general-use" as const,
        agentMode: true
      };

      // Legacy parser completed - silent success
      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * Fallback parsing for files that might be corrupted or in old format
   */
  private tryFallbackParsing(content: string): {
    id: string;
    messages: ChatMessage[];
    selectedModelId: string;
    lastModified: number;
    title: string;
    version?: number;
    context_files?: string[];
    systemPromptType: "general-use" | "concise" | "agent" | "custom";
    systemPromptPath?: string;
    agentMode?: boolean;
  } | null {
    try {
      // Generate fallback metadata
      const timestamp = Date.now();
      const fallbackId = this.generateMessageId();
      
      // Try to extract messages even without proper metadata
      const messages: ChatMessage[] = [];
      
      // Look for SystemSculpt message markers - only match at line boundaries
      const messageRegex = /(?:^|\n)\s*<!--\s*SYSTEMSCULPT-MESSAGE-START\s*role=[\'\"]?(user|assistant)[\'\"]?\s*message-id=[\'\"]?([^\'\"\\s>]+)[\'\"]?\s*-->\s*([\s\S]*?)\s*<!--\s*SYSTEMSCULPT-MESSAGE-END\s*-->(?=\s*(?:\n|$))/gm;
      
      let msgMatch;
      while ((msgMatch = messageRegex.exec(content)) !== null) {
        const role = msgMatch[1];
        const messageId = msgMatch[2];
        const messageContent = msgMatch[3];
        
        messages.push({
          role: role as ChatRole,
          content: messageContent.trim(),
          message_id: messageId,
        });
      }
      
      // Only return fallback result if we found at least one message
      if (messages.length > 0) {
        return {
          id: fallbackId,
          messages,
          selectedModelId: "gpt-3.5-turbo", // Default fallback model
          lastModified: timestamp,
          title: "Recovered Chat",
          version: 0,
          systemPromptType: "general-use",
          agentMode: true
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  async getMetadata(chatId: string): Promise<ChatMetadata | null> {
    try {
      const filePath = `${this.chatDirectory}/${chatId}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (!(file instanceof TFile)) {
        return null;
      }

      const content = await this.app.vault.read(file);
      return this.parseMetadata(content);
    } catch (error) {
      return null;
    }
  }

  private generateMessageId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private standardizeToolCalls(
    toolCalls: any[],
    messageId: string
  ): ToolCall[] {
    if (!toolCalls) return [];
    return toolCalls.map((tc) => {
      // It's already in the new format if it has a `request` object.
      if (tc.request?.function) {
        // Ensure result is properly structured, guarding against older data.
        if (tc.result && tc.result.success === undefined) {
          tc.result = { success: true, data: tc.result };
        }
        return tc as ToolCall;
      }

      // It's in the old, flat format. Convert it.
      if (tc.function) {
        const result = tc.result;
        let standardizedResult: ToolCallResult | undefined = undefined;
        if (result) {
          if (result.success !== undefined) {
            standardizedResult = result as ToolCallResult;
          } else {
            standardizedResult = { success: true, data: result };
          }
        }

        return {
          id: tc.id,
          messageId: messageId,
          request: {
            id: tc.id,
            type: tc.type,
            function: tc.function,
          },
          state: tc.state || "completed",
          timestamp: tc.timestamp || Date.now(),
          autoApproved: tc.autoApproved || false,
          result: standardizedResult,
        } as ToolCall;
      }

      // Return as-is if the format is unrecognized
      return tc;
    });
  }
}
