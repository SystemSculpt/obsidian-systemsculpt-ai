import type { ToolCall } from "../types/toolCalls";

/**
 * Parse and normalize function data from a tool call, safely handling JSON args.
 */
export function getFunctionDataFromToolCall(toolCall: ToolCall): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const fn = toolCall.request?.function;
    if (!fn) return null;
    const args = typeof fn.arguments === "string" ? safeParse(fn.arguments) : fn.arguments;
    return {
      name: fn.name,
      arguments: args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {},
    };
  } catch {
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
