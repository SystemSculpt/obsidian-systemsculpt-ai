import type SystemSculptPlugin from "../../main";
import type { ChatMessage, MessagePart, MultiPartContent } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import { deterministicId } from "../../utils/id";
import { loadPiSdkModule, type PiSdkSessionEntry } from "./PiSdk";

export type PiSessionMirrorSnapshot = {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  actualModelId?: string;
  messages: ChatMessage[];
};

function createPiMessageId(prefix: string, payload: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(payload);
  } catch {
    serialized = String(payload ?? "");
  }
  return deterministicId(serialized, prefix);
}

function toDataUrl(data: string, mimeType: string): string {
  return `data:${mimeType};base64,${data}`;
}

function textBlocksToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if ((block as any).type === "text" && typeof (block as any).text === "string") {
        return (block as any).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function mapUserContent(content: unknown): string | MultiPartContent[] | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const blocks: MultiPartContent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if ((block as any).type === "text" && typeof (block as any).text === "string") {
      blocks.push({
        type: "text",
        text: (block as any).text,
      });
      continue;
    }

    if (
      (block as any).type === "image" &&
      typeof (block as any).data === "string" &&
      typeof (block as any).mimeType === "string"
    ) {
      blocks.push({
        type: "image_url",
        image_url: {
          url: toDataUrl((block as any).data, (block as any).mimeType),
        },
      });
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block as any).text).join("\n\n");
  }

  return blocks;
}

function mapAssistantEntry(entry: PiSdkSessionEntry, index: number): ChatMessage {
  const message = entry.message as Record<string, any>;
  const messageId = createPiMessageId("pi_asst", {
    entryId: entry.id,
    index,
    timestamp: message?.timestamp,
    provider: message?.provider,
    model: message?.model,
    content: message?.content,
  });

  const parts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let textContent = "";
  let reasoning = "";
  let partTimestamp = Math.max(1, Number(message?.timestamp) || Date.now());

  const nextTimestamp = () => {
    partTimestamp += 1;
    return partTimestamp;
  };

  const rawContent = Array.isArray(message?.content) ? message.content : [];
  for (const [contentIndex, block] of rawContent.entries()) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if ((block as any).type === "text" && typeof (block as any).text === "string") {
      const text = (block as any).text;
      textContent += text;
      parts.push({
        id: `${messageId}-content-${contentIndex}`,
        type: "content",
        timestamp: nextTimestamp(),
        data: text,
      });
      continue;
    }

    if ((block as any).type === "thinking") {
      const thought = String((block as any).thinking || (block as any).text || "");
      if (!thought) {
        continue;
      }
      reasoning += thought;
      parts.push({
        id: `${messageId}-reasoning-${contentIndex}`,
        type: "reasoning",
        timestamp: nextTimestamp(),
        data: thought,
      });
      continue;
    }

    if ((block as any).type === "toolCall") {
      const toolCallId = String((block as any).id || `${messageId}-tool-${contentIndex}`);
      let serializedArguments = "{}";
      try {
        serializedArguments = JSON.stringify((block as any).arguments || {});
      } catch {
        serializedArguments = "{}";
      }

      const toolCall: ToolCall = {
        id: toolCallId,
        messageId,
        request: {
          id: toolCallId,
          type: "function",
          function: {
            name: String((block as any).name || "tool"),
            arguments: serializedArguments,
          },
        },
        state: "completed",
        timestamp: nextTimestamp(),
      };
      toolCalls.push(toolCall);
      parts.push({
        id: `${messageId}-toolcall-${contentIndex}`,
        type: "tool_call",
        timestamp: toolCall.timestamp,
        data: toolCall,
      });
    }
  }

  const chatMessage: ChatMessage = {
    role: "assistant",
    content: textContent,
    message_id: messageId,
    pi_entry_id: entry.id,
  };

  if (reasoning.trim()) {
    chatMessage.reasoning = reasoning;
  }
  if (parts.length > 0) {
    chatMessage.messageParts = parts;
  }
  if (toolCalls.length > 0) {
    chatMessage.tool_calls = toolCalls;
  }

  return chatMessage;
}

function mapPiEntryToChatMessage(entry: PiSdkSessionEntry, index: number): ChatMessage | null {
  if (entry.type !== "message" || !entry.message) {
    return null;
  }

  const message = entry.message as Record<string, any>;
  const role = String(message.role || "").trim().toLowerCase();
  if (role === "user") {
    return {
      role: "user",
      content: mapUserContent(message.content),
      message_id: createPiMessageId("pi_user", {
        entryId: entry.id,
        index,
        timestamp: message.timestamp,
        content: message.content,
      }),
      pi_entry_id: entry.id,
    };
  }

  if (role === "assistant") {
    return mapAssistantEntry(entry, index);
  }

  if (role === "toolresult") {
    return {
      role: "tool",
      content: textBlocksToString(message.content),
      message_id: createPiMessageId("pi_tool", {
        entryId: entry.id,
        index,
        timestamp: message.timestamp,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      }),
      pi_entry_id: entry.id,
      tool_call_id: String(message.toolCallId || "").trim(),
      name: String(message.toolName || "tool").trim() || "tool",
    };
  }

  return null;
}

export async function loadPiSessionMirror(options: {
  plugin: SystemSculptPlugin;
  sessionFile: string;
}): Promise<PiSessionMirrorSnapshot> {
  void options.plugin;
  const sdk = await loadPiSdkModule();
  const sessionManager = sdk.SessionManager.open(options.sessionFile);
  const entries = sessionManager.getBranch();
  const messages = entries
    .map((entry, index) => mapPiEntryToChatMessage(entry, index))
    .filter((message): message is ChatMessage => !!message);

  const model = sessionManager.buildSessionContext().model;
  const provider = String(model?.provider || "").trim();
  const modelId = String(model?.modelId || "").trim();

  return {
    sessionFile:
      typeof sessionManager.getSessionFile() === "string" && sessionManager.getSessionFile()?.trim()
        ? sessionManager.getSessionFile()?.trim()
        : options.sessionFile,
    sessionId: String(sessionManager.getSessionId() || "").trim(),
    sessionName: String(sessionManager.getSessionName() || "").trim() || undefined,
    actualModelId: provider && modelId ? `${provider}/${modelId}` : undefined,
    messages,
  };
}
