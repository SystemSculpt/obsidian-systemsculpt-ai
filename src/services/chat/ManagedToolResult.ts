import type { ChatMessage } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import { collectSuccessfulToolArtifactPaths, collectToolArtifactPaths } from "../../utils/toolArtifacts";

export const MAX_MANAGED_TOOL_RESULT_BYTES = 96 * 1024;

function parseToolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function safeManagedResultData(value: unknown): unknown {
  if (typeof value === "undefined") return { status: "completed" };
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return { status: "completed", summary: "Tool completed with a non-serializable result." };
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Keeps every tool-result row below the negotiated per-block/turn budget. */
export function serializeManagedToolResult(toolCall: ToolCall): string {
  const result = toolCall.result?.success
    ? safeManagedResultData(toolCall.result.data)
    : {
        error: toolCall.result?.error || {
          code: "TOOL_EXECUTION_FAILED",
          message: "The tool failed without an error message.",
        },
        ...(typeof toolCall.result?.data !== "undefined"
          ? { data: safeManagedResultData(toolCall.result.data) }
          : {}),
      };
  const serialized = JSON.stringify(result);
  const originalBytes = utf8Length(serialized);
  if (originalBytes <= MAX_MANAGED_TOOL_RESULT_BYTES) return serialized;

  const name = toolCall.request.function.name;
  const input = parseToolInput(toolCall.request.function.arguments);
  const artifactPaths = (toolCall.result?.success
    ? collectToolArtifactPaths(name, input, toolCall.result.data)
    : collectSuccessfulToolArtifactPaths(name, toolCall.result?.data))
    .slice(0, 32)
    .map((path) => path.slice(0, 512));
  const bytes = new TextEncoder().encode(serialized);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const envelope = (preview: string) => JSON.stringify({
    systemsculpt_truncated: true,
    original_utf8_bytes: originalBytes,
    message: "Tool output was shortened to fit the managed continuation limit.",
    ...(artifactPaths.length ? { artifact_paths: artifactPaths } : {}),
    preview,
  });
  let low = 0;
  let high = bytes.byteLength;
  let best = envelope("");
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = envelope(decoder.decode(bytes.slice(0, midpoint)));
    if (utf8Length(candidate) <= MAX_MANAGED_TOOL_RESULT_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function managedToolResultMessage(
  toolCall: ToolCall,
  assistantMessageId: string,
): ChatMessage {
  return {
    role: "tool",
    content: serializeManagedToolResult(toolCall),
    tool_call_id: toolCall.id,
    name: toolCall.request.function.name,
    message_id: `${assistantMessageId}:tool-result:${toolCall.id}`,
  };
}
