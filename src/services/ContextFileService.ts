import { App, TFile } from "obsidian";
import { ChatMessage } from "../types";
import { ImageProcessor } from "../utils/ImageProcessor";
import { SystemPromptService } from "./SystemPromptService";
import { simpleHash } from "../utils/cryptoUtils";
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
   * Prepare messages with context files and system prompt
   */
  public async prepareMessagesWithContext(
    messages: ChatMessage[],
    contextFiles: Set<string>,
    systemPromptType?: string,
    systemPromptPath?: string,
    includeImages?: boolean,
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
          systemPromptContent = await SystemPromptService.getInstance(this.app, () => ({})).getSystemPromptContent(normalizedType as any, undefined);
        } else {
          systemPromptContent = await SystemPromptService.getInstance(this.app, () => ({})).getSystemPromptContent("general-use", undefined);
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
    let idx = 0;
    while (idx < messages.length) {
      const msg = messages[idx];

      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
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

    return preparedMessages;
  }

}
