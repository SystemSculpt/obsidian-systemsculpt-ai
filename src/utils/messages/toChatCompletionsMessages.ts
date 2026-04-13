import type { ChatMessage } from "../../types";
import { deterministicId } from "../id";
import { mapAssistantToolCallsForApi } from "../tooling";

type ChatCompletionsMessageOptions = {
  includeDocumentContext?: boolean;
  includeReasoningDetails?: boolean;
  includeToolNameOnToolMessages?: boolean;
};

export function toChatCompletionsMessages(
  messages: ChatMessage[],
  options: ChatCompletionsMessageOptions = {},
): any[] {
  const {
    includeDocumentContext = true,
    includeReasoningDetails = true,
    includeToolNameOnToolMessages = true,
  } = options;
  const usedApiToolCallIds = new Set<string>();
  const pendingApiToolCallIdsByOriginalId = new Map<string, string[]>();
  const toolNameByApiCallId = new Map<string, string>();

  const enqueuePendingApiToolCallId = (originalId: string | undefined, apiId: string): void => {
    const normalizedOriginalId = typeof originalId === "string" ? originalId.trim() : "";
    if (!normalizedOriginalId) {
      return;
    }
    const queue = pendingApiToolCallIdsByOriginalId.get(normalizedOriginalId) ?? [];
    queue.push(apiId);
    pendingApiToolCallIdsByOriginalId.set(normalizedOriginalId, queue);
  };

  const dequeuePendingApiToolCallId = (originalId: string | undefined): string | undefined => {
    const normalizedOriginalId = typeof originalId === "string" ? originalId.trim() : "";
    if (!normalizedOriginalId) {
      return undefined;
    }
    const queue = pendingApiToolCallIdsByOriginalId.get(normalizedOriginalId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const nextId = queue.shift();
    if (queue.length === 0) {
      pendingApiToolCallIdsByOriginalId.delete(normalizedOriginalId);
    }
    return nextId;
  };

  const allocateApiToolCallId = (options: {
    originalId?: string;
    messageId?: string;
    toolName?: string;
    toolArguments?: string;
    index: number;
  }): string => {
    const normalizedOriginalId =
      typeof options.originalId === "string" ? options.originalId.trim() : "";

    if (
      normalizedOriginalId &&
      /^call_[A-Za-z0-9_-]{8,128}$/.test(normalizedOriginalId) &&
      !usedApiToolCallIds.has(normalizedOriginalId)
    ) {
      usedApiToolCallIds.add(normalizedOriginalId);
      return normalizedOriginalId;
    }

    const seedParts = [
      options.messageId || "message",
      normalizedOriginalId || `tool-${options.index}`,
      options.toolName || "",
      options.toolArguments || "",
    ];
    const seedBase = seedParts.join("::");

    let candidate = deterministicId(seedBase, "call");
    let attempt = 0;
    while (usedApiToolCallIds.has(candidate)) {
      attempt += 1;
      candidate = deterministicId(`${seedBase}::${attempt}`, "call");
    }

    usedApiToolCallIds.add(candidate);
    return candidate;
  };

  const normalizeContent = (content: any): any => {
    if (content == null) return "";
    if (!Array.isArray(content)) return content;

    const parts: any[] = [];
    for (const part of content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part && part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
        parts.push({ type: "image_url", image_url: { url: part.image_url.url } });
      }
    }

    if (parts.length === 0) return "";

    const hasImage = parts.some((p) => p.type === "image_url");
    if (!hasImage) {
      return parts
        .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .filter((s) => s.length > 0)
        .join("\n");
    }

    return parts;
  };

  return (messages || []).map((msg) => {
    const mapped: any = {
      role: msg.role,
    };

    if (msg.name && (msg.role !== "tool" || includeToolNameOnToolMessages)) {
      mapped.name = msg.name;
    }
    if (includeDocumentContext && msg.documentContext) {
      mapped.documentContext = msg.documentContext;
    }

    let toolCallsForApi: any[] | undefined;
    const assistantToolCallIdMap = new Map<string, string>();
    if (Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
      const rawToolCalls = (msg as any).tool_calls as any[];
      const normalizedToolCalls = mapAssistantToolCallsForApi(rawToolCalls);
      toolCallsForApi = normalizedToolCalls.map((tc, index) => {
        const rawToolCall = rawToolCalls[index];
        const originalToolCallId = typeof rawToolCall?.id === "string"
          ? rawToolCall.id
          : typeof rawToolCall?.request?.id === "string"
            ? rawToolCall.request.id
            : typeof tc?.id === "string"
              ? tc.id
              : undefined;
        const apiToolCallId = allocateApiToolCallId({
          originalId: originalToolCallId,
          messageId: msg.message_id || `assistant-${index}`,
          toolName: tc?.function?.name,
          toolArguments: tc?.function?.arguments,
          index,
        });

        if (typeof originalToolCallId === "string" && originalToolCallId.trim().length > 0) {
          assistantToolCallIdMap.set(originalToolCallId, apiToolCallId);
          enqueuePendingApiToolCallId(originalToolCallId, apiToolCallId);
        }
        if (typeof tc?.function?.name === "string" && tc.function.name.trim().length > 0) {
          toolNameByApiCallId.set(apiToolCallId, tc.function.name);
        }

        return {
          ...tc,
          id: apiToolCallId,
        };
      });
      mapped.tool_calls = toolCallsForApi;
    }

    const reasoningDetails = (msg as any).reasoning_details;
    if (includeReasoningDetails && Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
      mapped.reasoning_details = reasoningDetails.map((detail: any) => {
        if (!detail || typeof detail !== "object") {
          return detail;
        }

        const nextDetail: Record<string, unknown> = { ...detail };
        const detailIndex = Number(detail.index);
        if (
          Array.isArray(toolCallsForApi)
          && Number.isFinite(detailIndex)
          && detailIndex >= 0
          && detailIndex < toolCallsForApi.length
          && typeof toolCallsForApi[detailIndex]?.id === "string"
        ) {
          nextDetail.id = toolCallsForApi[detailIndex].id;
        } else if (typeof detail.id === "string" && assistantToolCallIdMap.has(detail.id)) {
          nextDetail.id = assistantToolCallIdMap.get(detail.id);
        }

        return nextDetail;
      });
    }

    if (msg.content !== undefined) {
      if (
        msg.role === "assistant" &&
        toolCallsForApi &&
        toolCallsForApi.length > 0 &&
        typeof msg.content === "string" &&
        msg.content.trim().length === 0
      ) {
        mapped.content = null;
      } else {
        mapped.content = normalizeContent(msg.content);
      }
    }

    const originalToolCallId = typeof msg.tool_call_id === "string"
      ? msg.tool_call_id
      : undefined;
    if (originalToolCallId) {
      const mappedToolCallId = dequeuePendingApiToolCallId(originalToolCallId);
      if (mappedToolCallId) {
        mapped.tool_call_id = mappedToolCallId;
      } else {
        mapped.tool_call_id = allocateApiToolCallId({
          originalId: originalToolCallId,
          messageId: msg.message_id || "tool-message",
          toolName: typeof msg.name === "string" ? msg.name : undefined,
          toolArguments: typeof msg.content === "string" ? msg.content : "",
          index: 0,
        });
      }
    }

    if (msg.role === "tool") {
      if (mapped.content == null) mapped.content = "";
      if (
        includeToolNameOnToolMessages &&
        (!mapped.name || String(mapped.name).trim().length === 0)
        && typeof mapped.tool_call_id === "string"
      ) {
        const toolName = toolNameByApiCallId.get(mapped.tool_call_id);
        if (toolName) mapped.name = toolName;
      }
    }

    return mapped;
  });
}
