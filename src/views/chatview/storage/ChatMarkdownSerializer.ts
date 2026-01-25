import { ChatMessage, MessagePart, ChatRole } from "../../../types";
import * as obsidianApi from "obsidian";
// Dynamically extract to support stub in tests
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { parseYaml } = obsidianApi as any;
import { MessagePartList } from "../utils/MessagePartList";

/**
 * ChatMarkdownSerializer – central place for converting between in-memory
 * ChatMessage[] objects and the markdown representation used on disk.
 *
 * 2025-06-11: initial extraction from ChatStorageService.  Only implements
 * `serializeMessages()` for now; parsing will be added in a later PR.
 */
export class ChatMarkdownSerializer {
  /**
   * Convert an array of chat messages into the markdown body that lives below
   * the YAML front-matter.  (Front-matter itself is *not* produced here.)
   */
  public static serializeMessages(messages: ChatMessage[]): string {
    return messages
      .filter((msg) => msg.role !== "tool") // We keep tool messages in memory but do not persist them
      .map((msg) => this.messageToMarkdown(msg))
      .join("\n\n");
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  READ-SIDE – parseMarkdown()
  // ────────────────────────────────────────────────────────────────────────────

  /** Parse markdown of a chat file and return metadata + messages. */
  public static parseMarkdown(content: string): { metadata: ChatMetadata; messages: ChatMessage[] } | null {
    const metadata = this.parseMetadata(content);
    if (!metadata) return null;

    // Prefer modern sequential format
    const sequential = this.parseSequentialFormat(content);
    if (sequential.success) return { metadata, messages: sequential.messages };

    // Fallback to aggregated format
    const aggregated = this.parseAggregatedFormat(content);
    if (aggregated.success) return { metadata, messages: aggregated.messages };

    return null;
  }

  // ───────────────────────── Internal parsing helpers ─────────────────────────

  private static parseSequentialFormat(content: string): { success: boolean; messages: ChatMessage[] } {
    const messages: ChatMessage[] = [];
    const messageRegex = /<!-- SYSTEMSCULPT-MESSAGE-START (.*?) -->([\s\S]*?)<!-- SYSTEMSCULPT-MESSAGE-END -->/g;
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(content)) !== null) {
      const attrs = match[1];
      const body = match[2];

      const roleMatch = attrs.match(/role="(.*?)"/);
      const idMatch = attrs.match(/message-id="(.*?)"/);
      if (!roleMatch || !idMatch) continue;

      const role = roleMatch[1] as ChatRole;
      const message_id = idMatch[1];

      const parts: MessagePart[] = [];
      let ts = Date.now();

      // New robust parsing approach:
      // 1. Extract all special blocks first
      // 2. Process remaining content
      
      let workingBody = body;
      const extractedBlocks: { type: 'reasoning' | 'tool_call' | 'content'; data: any; position: number }[] = [];
      
      // Extract all REASONING blocks
      const reasoningRegex = /<!-- REASONING\n([\s\S]*?)\n-->/g;
      let reasoningMatch: RegExpExecArray | null;
      while ((reasoningMatch = reasoningRegex.exec(body)) !== null) {
        // IMPORTANT: Do not trim() reasoning text to preserve formatting
        const reasoningText = reasoningMatch[1];
        if (reasoningText) {
          extractedBlocks.push({
            type: 'reasoning',
            data: reasoningText,
            position: reasoningMatch.index
          });
          // Mark this section for removal
          workingBody = workingBody.replace(reasoningMatch[0], `\n<!-- EXTRACTED-${extractedBlocks.length - 1} -->\n`);
        }
      }
      
      // Extract all TOOL-CALLS blocks
      const toolCallRegex = /<!-- TOOL-CALLS\n([\s\S]*?)\n-->/g;
      let toolCallMatch: RegExpExecArray | null;
      while ((toolCallMatch = toolCallRegex.exec(body)) !== null) {
        const toolCallJson = toolCallMatch[1]?.trim();
        if (toolCallJson) {
          try {
            const toolCallsArray = JSON.parse(toolCallJson);
            if (Array.isArray(toolCallsArray)) {
              // Handle each tool call separately
              for (const toolCall of toolCallsArray) {
                extractedBlocks.push({
                  type: 'tool_call',
                  data: toolCall,
                  position: toolCallMatch.index
                });
              }
            }
          } catch { /* ignore JSON errors */ }
          // Mark this section for removal
          workingBody = workingBody.replace(toolCallMatch[0], `\n<!-- EXTRACTED-TC -->\n`);
        }
      }
      
      // Clean up the working body to get pure content
      const contentText = workingBody
        .replace(/<!-- EXTRACTED-[\w-]+ -->/g, '');
      
      // Sort blocks by their original position to maintain chronological order
      extractedBlocks.sort((a, b) => a.position - b.position);
      
      // Build parts array in chronological order
      let lastPosition = 0;
      for (const block of extractedBlocks) {
        // Check if there's content before this block
        const beforeContent = body.substring(lastPosition, block.position)
          .replace(/<!-- REASONING\n[\s\S]*?\n-->/g, '')
          .replace(/<!-- TOOL-CALLS\n[\s\S]*?\n-->/g, '');
        
        if (beforeContent && beforeContent.trim().length > 0) {
          parts.push({ id: `content-${ts}`, type: "content", data: beforeContent, timestamp: ts++ });
        }
        
        // Add the block itself
        if (block.type === 'reasoning') {
          parts.push({ id: `reasoning-${ts}`, type: "reasoning", data: block.data, timestamp: ts++ });
        } else if (block.type === 'tool_call') {
          // Prefer a stable ID based on the tool call's id when available
          const toolId = (block.data && typeof block.data.id === 'string') ? block.data.id : String(ts);
          const partId = toolId ? `tool_call_part-${toolId}` : `tool_call-${ts}`;
          parts.push({ id: partId, type: "tool_call", data: block.data, timestamp: ts++ });
        }
        
        // Update position for next iteration
        lastPosition = block.position + 
          (block.type === 'reasoning' ? body.substring(block.position).match(/<!-- REASONING\n[\s\S]*?\n-->/)?.[0].length || 0 :
           block.type === 'tool_call' ? body.substring(block.position).match(/<!-- TOOL-CALLS\n[\s\S]*?\n-->/)?.[0].length || 0 : 0);
      }
      
      // Check for any trailing content
      const trailingContent = body.substring(lastPosition)
        .replace(/<!-- REASONING\n[\s\S]*?\n-->/g, '')
        .replace(/<!-- TOOL-CALLS\n[\s\S]*?\n-->/g, '');
      
      if (trailingContent && trailingContent.trim().length > 0) {
        parts.push({ id: `content-${ts}`, type: "content", data: trailingContent, timestamp: ts++ });
      }

      // If we didn't extract any special blocks but have content, add it
      if (parts.length === 0 && contentText && contentText.trim().length > 0) {
        parts.push({ id: `content-${ts}`, type: "content", data: contentText, timestamp: ts++ });
      }

      if (parts.length > 0) {
        messages.push(this.reconstructMessageFromParts(role, message_id, parts));
      }
    }

    return { success: true, messages };
  }

  private static parseAggregatedFormat(content: string): { success: boolean; messages: ChatMessage[] } {
    const messages: ChatMessage[] = [];
    const messageRegex = /<!-- SYSTEMSCULPT-MESSAGE-START (.*?) -->([\s\S]*?)<!-- SYSTEMSCULPT-MESSAGE-END -->/g;
    let match: RegExpExecArray | null;

    while ((match = messageRegex.exec(content)) !== null) {
      const attrs = match[1];
      const body = match[2];

      const roleMatch = attrs.match(/role="(.*?)"/);
      const idMatch = attrs.match(/message-id="(.*?)"/);
      if (!roleMatch || !idMatch) continue;

      const role = roleMatch[1] as ChatRole;
      const message_id = idMatch[1];

      const parts: MessagePart[] = [];
      let ts = Date.now();

      // Use the same robust extraction approach as sequential format
      let workingBody = body;
      
      // Extract all REASONING blocks
      const reasoningRegex = /<!-- REASONING\n([\s\S]*?)\n-->/g;
      let reasoningMatch: RegExpExecArray | null;
      const reasoningBlocks: string[] = [];
      while ((reasoningMatch = reasoningRegex.exec(body)) !== null) {
        // IMPORTANT: Do not trim() reasoning text to preserve formatting
        const reasoningText = reasoningMatch[1];
        if (reasoningText) {
          reasoningBlocks.push(reasoningText);
          // Remove from working body
          workingBody = workingBody.replace(reasoningMatch[0], '');
        }
      }
      
      // Extract all TOOL-CALLS blocks
      const toolCallRegex = /<!-- TOOL-CALLS\n([\s\S]*?)\n-->/g;
      let toolCallMatch: RegExpExecArray | null;
      const toolCallBlocks: any[] = [];
      while ((toolCallMatch = toolCallRegex.exec(body)) !== null) {
        const toolCallJson = toolCallMatch[1]?.trim();
        if (toolCallJson) {
          try {
            const toolCallsArray = JSON.parse(toolCallJson);
            if (Array.isArray(toolCallsArray)) {
              toolCallBlocks.push(...toolCallsArray);
            }
          } catch { /* ignore JSON errors */ }
          // Remove from working body
          workingBody = workingBody.replace(toolCallMatch[0], '');
        }
      }
      
      // Clean up the working body to get pure content
      const contentOnly = workingBody;

      // Add parts in order: content first, then reasoning, then tool calls
      if (contentOnly) {
        parts.push({ id: `content-${ts}`, type: "content", data: contentOnly, timestamp: ts++ });
      }

      // Add all reasoning blocks
      for (const reasoning of reasoningBlocks) {
        parts.push({ id: `reasoning-${ts}`, type: "reasoning", data: reasoning, timestamp: ts++ });
      }

      // Add all tool calls using stable IDs when possible
      for (const toolCall of toolCallBlocks) {
        const toolId = (toolCall && typeof toolCall.id === 'string') ? toolCall.id : String(ts);
        const partId = toolId ? `tool_call_part-${toolId}` : `tool_call-${ts}`;
        parts.push({ id: partId, type: "tool_call", data: toolCall, timestamp: ts++ });
      }

      if (parts.length > 0) {
        messages.push(this.reconstructMessageFromParts(role, message_id, parts));
      }
    }

    return { success: true, messages };
  }

  private static reconstructMessageFromParts(role: ChatRole, message_id: string, messageParts: MessagePart[]): ChatMessage {
    const list = new MessagePartList(messageParts);
    return {
      role,
      message_id,
      content: list.contentMarkdown(),
      reasoning: list.reasoningMarkdown(),
      tool_calls: list.toolCalls,
      messageParts,
    };
  }

  // ───────────────────────── Front-matter helpers ─────────────────────────

  private static parseMetadata(content: string): ChatMetadata | null {
    const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontMatterMatch) return null;

    const yamlContent = frontMatterMatch[1];
    if (!this.isValidYamlFrontmatter(yamlContent)) return null;

    const parsed: any = parseYaml(yamlContent);
    if (!parsed || typeof parsed !== "object") return null;

    const {
      id = "",
      model = "",
      created = new Date().toISOString(),
      lastModified = new Date().toISOString(),
      title = "Untitled Chat",
      context_files = [],
      version: versionRaw = 0,
    } = parsed;

    if (!id) return null;

    const processedContextFiles = Array.isArray(context_files)
      ? context_files.map((file: any): ContextFile => {
          if (typeof file === "string") {
            const isExtraction = file.includes("/Extractions/");
            return { path: file, type: isExtraction ? "extraction" : "source" };
          } else if (file && typeof file === "object" && file.path) {
            return {
              path: file.path,
              type: file.type || "source",
            };
          } else {
            return { path: "", type: "source" };
          }
        })
      : [];

    let systemMessageType: "general-use" | "concise" | "agent" | "custom" = "general-use";
    let systemMessagePath: string | undefined = undefined;

    if (parsed.systemMessage && typeof parsed.systemMessage === "object") {
      const type = parsed.systemMessage.type?.toLowerCase();
      if (type === "general-use" || type === "concise" || type === "agent" || type === "custom") {
        systemMessageType = type;
        if (type === "custom" && parsed.systemMessage.path) {
          systemMessagePath = parsed.systemMessage.path.replace(/^\[\[(.*?)\]\]$/, "$1");
        }
      }
    } else if (parsed.customPromptFilePath) {
      systemMessageType = "custom";
      systemMessagePath = parsed.customPromptFilePath.replace(/^\[\[(.*?)\]\]$/, "$1");
    }

    return {
      id,
      model,
      created,
      lastModified,
      title,
      version: Number(versionRaw) || 0,
      context_files: processedContextFiles,
      systemMessage: {
        type: systemMessageType,
        path: systemMessagePath,
      },
      chatFontSize: parsed.chatFontSize as "small" | "medium" | "large" | undefined,
    };
  }

  private static isValidYamlFrontmatter(content: string): boolean {
    return /\bid\s*:/i.test(content) || /\bmodel\s*:/i.test(content);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private static messageToMarkdown(msg: ChatMessage): string {
    let messageBody = "";

    if (msg.messageParts && msg.messageParts.length > 0) {
      // New format – iterate through parts in order.
      msg.messageParts.forEach((part: MessagePart) => {
        switch (part.type) {
          case "content":
            messageBody += part.data as string;
            break;
          case "reasoning":
            if (typeof part.data === "string") {
              // Preserve reasoning verbatim without trimming or normalization
              messageBody += `\n<!-- REASONING\n${part.data as string}\n-->\n`;
            }
            break;
          case "tool_call":
            const toolCallArray = [part.data];
            messageBody += `\n<!-- TOOL-CALLS\n${JSON.stringify(toolCallArray, null, 2)}\n-->\n`;
            break;
        }
      });
    } else {
      // Legacy single-blob format.
      let contentString = "";
      if (typeof msg.content === "string") {
        contentString = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentString = msg.content
          .map((part: any) => {
            if (part.type === "text") return part.text;
            if (part.type === "image_url")
              return `![Image Context](${part.image_url.url})`;
            return "";
          })
          .join("\n");
      }
      messageBody = contentString;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messageBody += `\n<!-- TOOL-CALLS\n${JSON.stringify(msg.tool_calls, null, 2)}\n-->`;
      }
      if (msg.reasoning) {
        // Preserve legacy reasoning verbatim as well
        messageBody += `\n<!-- REASONING\n${msg.reasoning}\n-->`;
      }
    }

    const hasToolCalls =
      (msg.tool_calls && msg.tool_calls.length > 0) ||
      (msg.messageParts && msg.messageParts.some((p: MessagePart) => p.type === "tool_call"));
    const hasReasoning =
      !!msg.reasoning ||
      (msg.messageParts && msg.messageParts.some((p: MessagePart) => p.type === "reasoning"));
    const isStreaming = !!msg.streaming;

    let attributes = `role="${msg.role}" message-id="${msg.message_id}"`;
    if (hasToolCalls) attributes += " has-tool-calls=\"true\"";
    if (hasReasoning) attributes += " has-reasoning=\"true\"";
    if (isStreaming) attributes += " streaming=\"true\"";

    const messageStart = `<!-- SYSTEMSCULPT-MESSAGE-START ${attributes} -->`;

    return `${messageStart}\n${messageBody}\n<!-- SYSTEMSCULPT-MESSAGE-END -->`;
  }
}

// ───────────────────────── Local interfaces ─────────────────────────

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
  context_files?: ContextFile[];
  systemMessage?: {
    type: "general-use" | "concise" | "agent" | "custom";
    path?: string;
  };
  chatFontSize?: "small" | "medium" | "large";
}
