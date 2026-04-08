import { App, TFile, parseYaml, stringifyYaml } from "obsidian";
import { ChatMessage, MessagePart } from "../../types";
import type { SerializedToolCall, ToolCall, ToolCallResult } from "../../types/toolCalls";
import { getManagedSystemSculptModelId } from "../../services/systemsculpt/ManagedSystemSculptModel";
import { ChatMarkdownSerializer } from "./storage/ChatMarkdownSerializer";
import { mergeAdjacentReasoningParts } from "./utils/MessagePartCoalescing";
import type { ChatBackend, ChatMetadata, ChatResumeDescriptor } from "./storage/ChatPersistenceTypes";
import {
  getLastMessagePiEntryId,
  normalizePiSessionState,
  resolveChatBackend,
} from "./storage/ChatPersistenceTypes";

type LoadedChatRecord = {
  id: string;
  messages: ChatMessage[];
  selectedModelId: string;
  lastModified: number;
  title: string;
  version?: number;
  context_files?: string[];
  chatFontSize?: "small" | "medium" | "large";
  selectedPromptPath?: string;
  agentModeEnabled?: boolean;
  chatPath: string;
  chatBackend: ChatBackend;
  piSessionFile?: string;
  piSessionId?: string;
  piLastEntryId?: string;
  piLastSyncedAt?: string;
};

type SaveChatOptions = {
  selectedModelId?: string;
  contextFiles?: Set<string>;
  title?: string;
  chatFontSize?: "small" | "medium" | "large";
  selectedPromptPath?: string;
  agentModeEnabled?: boolean;
  piSessionFile?: string;
  piSessionId?: string;
  piLastEntryId?: string;
  piLastSyncedAt?: string;
  chatBackend?: ChatBackend;
};

export class ChatStorageService {
  private app: App;
  private chatDirectory: string;

  constructor(app: App, chatDirectory: string) {
    this.app = app;
    this.chatDirectory = chatDirectory;
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
    options: SaveChatOptions = {},
  ): Promise<{ version: number }> {
    try {
      const { version } = await this.saveChatSimple(
        chatId,
        messages,
        options,
      );
      return { version };
    } catch (error) {
      throw new Error(`Failed to save chat to ${chatId}.md`);
    }
  }
  
  private async saveChatSimple(
    chatId: string,
    messages: ChatMessage[],
    options: SaveChatOptions = {},
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
      const piState = normalizePiSessionState({
        sessionFile: options.piSessionFile,
        sessionId: options.piSessionId,
        lastEntryId: options.piLastEntryId,
        lastSyncedAt: options.piLastSyncedAt,
      });
      const resolvedBackend = resolveChatBackend({
        explicitBackend: options.chatBackend ?? existingMetadata?.chatBackend,
        piSessionFile: piState.sessionFile,
        piSessionId: piState.sessionId,
      });
      const allowsEmptyVisibleTranscript =
        resolvedBackend === "systemsculpt" && (!!piState.sessionFile || !!piState.sessionId);
      // CRITICAL: Only increment version if we're actually changing content
      // If messages are empty and file exists with content, preserve the version
      const currentVersion = Number(existingMetadata?.version) || 0;
      let newVersion = currentVersion + 1;
      
      // Safety check: Don't overwrite an existing local chat with an empty transcript.
      // Pi first-turn forks are a legitimate exception because the new branch can be
      // empty on-screen until the next assistant turn is written.
      if (messages.length === 0 && fileExists && existingMetadata && file instanceof TFile) {
        // Check if the existing file has messages (simple heuristic: check for message markers)
        const existingContent = await vault.read(file);
        if (existingContent.includes('SYSTEMSCULPT-MESSAGE-START') && !allowsEmptyVisibleTranscript) {
          throw new Error('Cannot save empty messages over existing chat content');
        }
      }

      const metadata: ChatMetadata = {
        id: chatId,
        created: creationDate,
        lastModified: now,
        title: options.title || existingMetadata?.title || "Untitled Chat",
        version: newVersion,
        chatFontSize: options.chatFontSize || "medium",
        selectedPromptPath: options.selectedPromptPath || existingMetadata?.selectedPromptPath || undefined,
        agentModeEnabled: typeof options.agentModeEnabled === "boolean" ? options.agentModeEnabled : existingMetadata?.agentModeEnabled,
        piSessionFile: piState.sessionFile,
        piSessionId: piState.sessionId,
        piLastEntryId: piState.lastEntryId || getLastMessagePiEntryId(messages),
        piLastSyncedAt: piState.lastSyncedAt,
      };
      const selectedModelId = String(options.selectedModelId ?? existingMetadata?.model ?? "").trim();

      if (selectedModelId) {
        metadata.model = selectedModelId;
      }

      if (resolvedBackend === "legacy") {
        metadata.chatBackend = "legacy";
      }

      if (mergedTags.length > 0) {
        metadata.tags = mergedTags;
      }

      if (options.contextFiles && options.contextFiles.size > 0) {
        metadata.context_files = Array.from(options.contextFiles).map((path) => ({
          path,
          type: path.includes("/Extractions/") ? "extraction" : "source",
        }));
      }

      const messagesContent = ChatMarkdownSerializer.serializeMessages(messages);

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

  async loadChats(): Promise<LoadedChatRecord[]> {
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
            
            const parsed = this.parseMarkdownContent(content, filePath);

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

  async loadChat(chatId: string): Promise<LoadedChatRecord | null> {
    try {
      const filePath = `${this.chatDirectory}/${chatId}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (!(file instanceof TFile)) {
        return null;
      }

      const content = await this.app.vault.read(file);
      return this.parseMarkdownContent(content, filePath);
    } catch (error) {
      return null;
    }
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
        (file: any): NonNullable<ChatMetadata["context_files"]>[number] => {
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
      let legacySystemMessage: ChatMetadata["systemMessage"] | undefined;

      // First try to use the systemMessage object if it exists
      if (parsed.systemMessage && typeof parsed.systemMessage === 'object') {
        const type = parsed.systemMessage.type?.toLowerCase();

        // Only accept valid types
        if (type === "general-use" || type === "concise" || type === "agent" || type === "custom") {
          legacySystemMessage = { type };

          // Only set path for custom type
          if (type === "custom" && parsed.systemMessage.path) {
            legacySystemMessage.path = parsed.systemMessage.path.replace(/^\[\[(.*?)\]\]$/, "$1");
          }
        }
      }
      // Fallback for old customPromptFilePath format
      else if (parsed.customPromptFilePath) {
        legacySystemMessage = {
          type: "custom",
          path: parsed.customPromptFilePath.replace(/^\[\[(.*?)\]\]$/, "$1"),
        };
      }

      const piState = normalizePiSessionState({
        sessionFile: (parsed as any).piSessionFile,
        sessionId: (parsed as any).piSessionId,
        lastEntryId: (parsed as any).piLastEntryId,
        lastSyncedAt: (parsed as any).piLastSyncedAt,
      });
      return {
        id,
        model,
        created,
        lastModified,
        title: title || id, // Use ID if title is missing
        version: Number(versionRaw) || 0,
        tags: tags.length > 0 ? tags : undefined,
        context_files: processedContextFiles,
        systemMessage: legacySystemMessage,
        chatFontSize: parsed.chatFontSize as "small" | "medium" | "large" | undefined,
        selectedPromptPath: typeof (parsed as any).selectedPromptPath === "string" && (parsed as any).selectedPromptPath.trim()
          ? (parsed as any).selectedPromptPath.trim()
          : undefined,
        chatBackend: resolveChatBackend({
          explicitBackend: (parsed as any).chatBackend,
          piSessionFile: piState.sessionFile,
          piSessionId: piState.sessionId,
          defaultBackend: legacySystemMessage ? "legacy" : "systemsculpt",
        }),
        piSessionFile: piState.sessionFile,
        piSessionId: piState.sessionId,
        piLastEntryId: piState.lastEntryId,
        piLastSyncedAt: piState.lastSyncedAt,
      };
    } catch (error) {
      return null;
    }
  }

  private parseMarkdownContent(content: string, filePath?: string): LoadedChatRecord | null {
    // NEW: Delegate modern parsing logic to central serializer
    const parsed = ChatMarkdownSerializer.parseMarkdown(content);
    if (parsed) {
      const { metadata, messages } = parsed;
      return this.finalizeParsedData(metadata, messages, filePath);
    }

    return null;
  }

  // Utility to finalize the parsed data into the expected return format
  private finalizeParsedData(metadata: ChatMetadata, messages: ChatMessage[], filePath?: string): LoadedChatRecord {
    const hasStandaloneLegacyToolMessages = messages.some((message) => message.role === "tool");
    const piState = normalizePiSessionState({
      sessionFile: metadata.piSessionFile,
      sessionId: metadata.piSessionId,
      lastEntryId: metadata.piLastEntryId,
      lastSyncedAt: metadata.piLastSyncedAt,
    });
    const chatBackend = resolveChatBackend({
      explicitBackend: metadata.chatBackend,
      piSessionFile: piState.sessionFile,
      piSessionId: piState.sessionId,
      defaultBackend: metadata.systemMessage || hasStandaloneLegacyToolMessages ? "legacy" : "systemsculpt",
    });
    const normalizedMessages =
      chatBackend === "legacy" || hasStandaloneLegacyToolMessages
        ? this.normalizeLegacyToolMessages(messages)
        : messages;
    return {
      id: metadata.id,
      messages: normalizedMessages,
      selectedModelId: metadata.model || getManagedSystemSculptModelId(),
      lastModified: new Date(metadata.lastModified).getTime(),
      title: metadata.title,
      version: metadata.version || 0,
      context_files: metadata.context_files?.map((f) => f.path) || [],
      chatFontSize: metadata.chatFontSize,
      selectedPromptPath: metadata.selectedPromptPath,
      agentModeEnabled: metadata.agentModeEnabled,
      chatPath: filePath || `${this.chatDirectory}/${metadata.id}.md`,
      chatBackend,
      piSessionFile: piState.sessionFile,
      piSessionId: piState.sessionId,
      piLastEntryId: piState.lastEntryId || getLastMessagePiEntryId(normalizedMessages),
      piLastSyncedAt: piState.lastSyncedAt,
    };
  }

  public async getChatResumeDescriptor(chatId: string): Promise<ChatResumeDescriptor | null> {
    const record = await this.loadChat(chatId);
    if (!record) {
      return null;
    }

    return {
      chatId: record.id,
      title: record.title,
      chatPath: record.chatPath,
      lastModified: record.lastModified,
      messageCount: record.messages.length,
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
        let reconstructedState: 'completed' | 'failed' = 'completed';

        if (parsed && typeof parsed === 'object' && parsed.error) {
          // Error object present
          const errorObj = parsed.error;
          const code = String(errorObj.code || 'EXECUTION_FAILED');
          reconstructedState = 'failed';
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
   * Validates that a file has the expected chat file structure
   */
  private isValidChatFile(content: string): boolean {
    // Check for modern format with frontmatter
    const hasFrontmatter = /^---\n[\s\S]*?\n---/.test(content);
    
    // Check for SystemSculpt message markers (current format)
    const hasMessageMarkers = content.includes('SYSTEMSCULPT-MESSAGE-START') && 
                              content.includes('SYSTEMSCULPT-MESSAGE-END');

    return hasFrontmatter || hasMessageMarkers;
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
    const normalizeToolState = (state: unknown): ToolCall["state"] => {
      if (state === "executing" || state === "completed" || state === "failed") {
        return state;
      }
      return "completed";
    };

    return toolCalls.map((tc) => {
      // It's already in the new format if it has a `request` object.
      if (tc.request?.function) {
        // Ensure result is properly structured, guarding against older data.
        if (tc.result && tc.result.success === undefined) {
          tc.result = { success: true, data: tc.result };
        }
        tc.state = normalizeToolState(tc.state);
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
          state: normalizeToolState(tc.state),
          timestamp: tc.timestamp || Date.now(),
          result: standardizedResult,
        } as ToolCall;
      }

      // Return as-is if the format is unrecognized
      return tc;
    });
  }
}
