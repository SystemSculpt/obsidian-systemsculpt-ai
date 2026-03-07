import type { ChatMessage, MessagePart, MultiPartContent } from "../../types";
import type { ToolCall, ToolCallResult, ToolCallState } from "../../types/toolCalls";
import { deterministicId } from "../../utils/id";
import type { PiSdkSessionEntry } from "./PiSdk";

type AssistantTurnState = {
  messageId: string;
  piEntryId: string;
  entryIds: string[];
  messageParts: MessagePart[];
  toolCalls: ToolCall[];
  toolCallsById: Map<string, ToolCall>;
  contentSegments: string[];
  reasoningSegments: string[];
  timestampCursor: number;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function createStableId(prefix: string, payload: unknown): string {
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
    return normalizeText(content);
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
        return normalizeText((block as any).text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function serializeImageBlock(block: Record<string, unknown>): string {
  return JSON.stringify({
    type: block.type,
    data: block.data,
    mimeType: block.mimeType,
  });
}

function computeIncrementalUserContent(
  content: unknown,
  previousCumulativeText: string,
  previousImageKeys: string[],
): {
  content: string | MultiPartContent[] | null;
  cumulativeText: string;
  cumulativeImageKeys: string[];
} {
  if (!Array.isArray(content)) {
    if (typeof content === "string") {
      const normalized = normalizeText(content);
      const delta = extractIncrementalText(normalized, previousCumulativeText);
      return {
        content: delta || null,
        cumulativeText: normalized,
        cumulativeImageKeys: [],
      };
    }

    return {
      content: null,
      cumulativeText: previousCumulativeText,
      cumulativeImageKeys: previousImageKeys,
    };
  }

  const textBlocks = content.filter(
    (block) => block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string",
  ) as Array<{ text: string }>;
  const imageBlocks = content.filter(
    (block) =>
      block &&
      typeof block === "object" &&
      (block as any).type === "image" &&
      typeof (block as any).data === "string" &&
      typeof (block as any).mimeType === "string",
  ) as Array<{ data: string; mimeType: string }>;

  const cumulativeText = normalizeText(textBlocks.map((block) => block.text).join("\n\n"));
  const deltaText = extractIncrementalText(cumulativeText, previousCumulativeText);
  const cumulativeImageKeys = imageBlocks.map((block) => serializeImageBlock(block));
  const previousKeySet = new Set(previousImageKeys);
  const newImageParts: MultiPartContent[] = imageBlocks
    .filter((block) => !previousKeySet.has(serializeImageBlock(block)))
    .map((block) => ({
      type: "image_url",
      image_url: {
        url: toDataUrl(block.data, block.mimeType),
      },
    }));

  if (newImageParts.length === 0) {
    return {
      content: deltaText || null,
      cumulativeText,
      cumulativeImageKeys,
    };
  }

  const multiPartContent: MultiPartContent[] = [];
  if (deltaText) {
    multiPartContent.push({
      type: "text",
      text: deltaText,
    });
  }
  multiPartContent.push(...newImageParts);

  return {
    content: multiPartContent,
    cumulativeText,
    cumulativeImageKeys,
  };
}

function extractIncrementalText(current: string, previous: string): string {
  const normalizedCurrent = normalizeText(current);
  const normalizedPrevious = normalizeText(previous);
  if (!normalizedPrevious) {
    return normalizedCurrent;
  }

  if (normalizedCurrent === normalizedPrevious) {
    return "";
  }

  if (normalizedCurrent.startsWith(normalizedPrevious)) {
    return normalizedCurrent.slice(normalizedPrevious.length).replace(/^\n+/, "").trimStart();
  }

  const separatedPrevious = `${normalizedPrevious}\n\n`;
  if (normalizedCurrent.startsWith(separatedPrevious)) {
    return normalizedCurrent.slice(separatedPrevious.length).trimStart();
  }

  return normalizedCurrent;
}

function parseTimestamp(entry: PiSdkSessionEntry, fallback: number): number {
  const parsed = Date.parse(String(entry.timestamp || "").trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  const rawMessageTimestamp = Number((entry.message as any)?.timestamp);
  if (Number.isFinite(rawMessageTimestamp) && rawMessageTimestamp > 0) {
    return rawMessageTimestamp;
  }

  return fallback;
}

function createAssistantTurn(entry: PiSdkSessionEntry, fallbackTimestamp: number): AssistantTurnState {
  const baseTimestamp = parseTimestamp(entry, fallbackTimestamp);
  return {
    messageId: createStableId("pi_asst", {
      firstEntryId: entry.id,
      timestamp: baseTimestamp,
    }),
    piEntryId: entry.id,
    entryIds: [entry.id],
    messageParts: [],
    toolCalls: [],
    toolCallsById: new Map(),
    contentSegments: [],
    reasoningSegments: [],
    timestampCursor: baseTimestamp,
  };
}

function nextPartTimestamp(turn: AssistantTurnState, entry: PiSdkSessionEntry, fallbackTimestamp: number): number {
  turn.timestampCursor = Math.max(turn.timestampCursor, parseTimestamp(entry, fallbackTimestamp));
  turn.timestampCursor += 1;
  return turn.timestampCursor;
}

function appendAssistantEntry(
  turn: AssistantTurnState,
  entry: PiSdkSessionEntry,
  fallbackTimestamp: number,
): void {
  if (!turn.entryIds.includes(entry.id)) {
    turn.entryIds.push(entry.id);
  }
  turn.piEntryId = entry.id;

  const message = entry.message as Record<string, any>;
  const rawContent = Array.isArray(message?.content) ? message.content : [];
  for (const [contentIndex, block] of rawContent.entries()) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if ((block as any).type === "thinking") {
      const thought = normalizeText(String((block as any).thinking || (block as any).text || ""));
      if (!thought.trim()) {
        continue;
      }
      turn.reasoningSegments.push(thought);
      turn.messageParts.push({
        id: `${turn.messageId}-reasoning-${turn.messageParts.length}`,
        type: "reasoning",
        timestamp: nextPartTimestamp(turn, entry, fallbackTimestamp),
        data: thought,
      });
      continue;
    }

    if ((block as any).type === "text") {
      const text = normalizeText(String((block as any).text || ""));
      if (!text) {
        continue;
      }
      turn.contentSegments.push(text);
      turn.messageParts.push({
        id: `${turn.messageId}-content-${turn.messageParts.length}`,
        type: "content",
        timestamp: nextPartTimestamp(turn, entry, fallbackTimestamp),
        data: text,
      });
      continue;
    }

    if ((block as any).type === "toolCall") {
      const toolCallId = String((block as any).id || `${turn.messageId}-tool-${contentIndex}`);
      let serializedArguments = "{}";
      try {
        serializedArguments = JSON.stringify((block as any).arguments || {});
      } catch {
        serializedArguments = "{}";
      }

      const toolCall: ToolCall = {
        id: toolCallId,
        messageId: turn.messageId,
        request: {
          id: toolCallId,
          type: "function",
          function: {
            name: String((block as any).name || "tool"),
            arguments: serializedArguments,
          },
        },
        state: "executing",
        timestamp: nextPartTimestamp(turn, entry, fallbackTimestamp),
        executionStartedAt: parseTimestamp(entry, fallbackTimestamp),
      };

      turn.toolCalls.push(toolCall);
      turn.toolCallsById.set(toolCallId, toolCall);
      turn.messageParts.push({
        id: `${turn.messageId}-tool-${turn.messageParts.length}`,
        type: "tool_call",
        timestamp: toolCall.timestamp,
        data: toolCall,
      });
    }
  }
}

function parseToolResult(entry: PiSdkSessionEntry): { state: ToolCallState; result: ToolCallResult } {
  const text = textBlocksToString((entry.message as any)?.content);
  if (!text) {
    return {
      state: "completed",
      result: { success: true, data: "" },
    };
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errorValue = (parsed as any).error;
      return {
        state: "failed",
        result: {
          success: false,
          error: {
            code: String(errorValue?.code || "EXECUTION_FAILED"),
            message: String(errorValue?.message || "Tool execution failed."),
            details: errorValue?.details,
          },
        },
      };
    }

    return {
      state: "completed",
      result: { success: true, data: parsed },
    };
  } catch {
    return {
      state: "completed",
      result: { success: true, data: text },
    };
  }
}

function attachToolResult(turn: AssistantTurnState, entry: PiSdkSessionEntry, fallbackTimestamp: number): void {
  const message = entry.message as Record<string, any>;
  const toolCallId = String(message?.toolCallId || "").trim();
  if (!toolCallId) {
    return;
  }

  let toolCall = turn.toolCallsById.get(toolCallId);
  if (!toolCall) {
    toolCall = {
      id: toolCallId,
      messageId: turn.messageId,
      request: {
        id: toolCallId,
        type: "function",
        function: {
          name: String(message?.toolName || "tool"),
          arguments: "{}",
        },
      },
      state: "executing",
      timestamp: nextPartTimestamp(turn, entry, fallbackTimestamp),
    };
    turn.toolCalls.push(toolCall);
    turn.toolCallsById.set(toolCallId, toolCall);
    turn.messageParts.push({
      id: `${turn.messageId}-tool-${turn.messageParts.length}`,
      type: "tool_call",
      timestamp: toolCall.timestamp,
      data: toolCall,
    });
  }

  const toolResult = parseToolResult(entry);
  toolCall.state = toolResult.state;
  toolCall.result = toolResult.result;
  toolCall.executionCompletedAt = parseTimestamp(entry, fallbackTimestamp);
  if (!toolCall.executionStartedAt) {
    toolCall.executionStartedAt = toolCall.executionCompletedAt;
  }
}

function finalizeAssistantTurn(turn: AssistantTurnState | null): ChatMessage | null {
  if (!turn) {
    return null;
  }

  for (const toolCall of turn.toolCalls) {
    if (toolCall.state === "executing") {
      toolCall.state = "completed";
      toolCall.executionCompletedAt = toolCall.executionCompletedAt || toolCall.executionStartedAt || toolCall.timestamp;
    }
  }

  if (turn.entryIds.length > 1) {
    turn.messageId = createStableId("pi_asst", {
      entryIds: turn.entryIds,
    });
    for (const toolCall of turn.toolCalls) {
      toolCall.messageId = turn.messageId;
    }
  }

  const content = turn.contentSegments.join("\n\n");
  const reasoning = turn.reasoningSegments.join("\n\n");
  if (!content && !reasoning && turn.toolCalls.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content,
    message_id: turn.messageId,
    pi_entry_id: turn.piEntryId,
    reasoning: reasoning || undefined,
    messageParts: turn.messageParts.length > 0 ? turn.messageParts : undefined,
    tool_calls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
  };
}

export function buildPiSessionTranscript(entries: PiSdkSessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingAssistantTurn: AssistantTurnState | null = null;
  let previousUserCumulativeText = "";
  let previousUserImageKeys: string[] = [];

  const flushAssistantTurn = () => {
    const assistantMessage = finalizeAssistantTurn(pendingAssistantTurn);
    if (assistantMessage) {
      messages.push(assistantMessage);
    }
    pendingAssistantTurn = null;
  };

  entries.forEach((entry, index) => {
    if (entry.type !== "message" || !entry.message) {
      return;
    }

    const message = entry.message as Record<string, any>;
    const role = String(message.role || "").trim().toLowerCase();
    const fallbackTimestamp = Date.now() + index;

    if (role === "user") {
      flushAssistantTurn();

      const nextUser = computeIncrementalUserContent(
        message.content,
        previousUserCumulativeText,
        previousUserImageKeys,
      );

      previousUserCumulativeText = nextUser.cumulativeText;
      previousUserImageKeys = nextUser.cumulativeImageKeys;

      const hasContent =
        typeof nextUser.content === "string"
          ? nextUser.content.trim().length > 0
          : Array.isArray(nextUser.content) && nextUser.content.length > 0;

      if (!hasContent) {
        return;
      }

      messages.push({
        role: "user",
        content: nextUser.content,
        message_id: createStableId("pi_user", {
          entryId: entry.id,
          content: nextUser.content,
        }),
        pi_entry_id: entry.id,
      });
      return;
    }

    if (role === "assistant") {
      pendingAssistantTurn ??= createAssistantTurn(entry, fallbackTimestamp);
      appendAssistantEntry(pendingAssistantTurn, entry, fallbackTimestamp);
      return;
    }

    if (role === "toolresult") {
      pendingAssistantTurn ??= createAssistantTurn(entry, fallbackTimestamp);
      attachToolResult(pendingAssistantTurn, entry, fallbackTimestamp);
    }
  });

  flushAssistantTurn();
  return messages;
}
