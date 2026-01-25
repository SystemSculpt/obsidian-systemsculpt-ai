import type { ToolCall } from "../types/toolCalls";

/**
 * Utilities for consistent tool display, naming, and argument handling.
 */

export function formatToolDisplayName(fullName: string): string {
  try {
    const baseName = fullName.replace(/^mcp[_-]/i, "");
    if (baseName.startsWith("filesystem_")) {
      const functionName = baseName.replace(/^filesystem_/, "");
      try {
        // Lazy import to avoid circular dependencies in some build paths
        const { MCPFilesystemServer } = require("../mcp-tools/filesystem/MCPFilesystemServer");
        const friendly = MCPFilesystemServer.getToolDisplayName(functionName);
        if (friendly) return `Filesystem: ${friendly}`;
      } catch {}
      return `Filesystem: ${toTitleCase(functionName.replace(/[_-]/g, " "))}`;
    }
    if (baseName.startsWith("youtube_")) {
      const functionName = baseName.replace(/^youtube_/, "");
      try {
        const { MCPYouTubeServer } = require("../mcp-tools/youtube/MCPYouTubeServer");
        const friendly = MCPYouTubeServer.getToolDisplayName(functionName);
        if (friendly) return `YouTube: ${friendly}`;
      } catch {}
      return `YouTube: ${toTitleCase(functionName.replace(/[_-]/g, " "))}`;
    }
    return toTitleCase(baseName.replace(/[_-]/g, " "));
  } catch {
    return fullName;
  }
}

export function toTitleCase(text: string): string {
  return text.replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Parse and normalize function data from a tool call, safely handling JSON args.
 */
export function getFunctionDataFromToolCall(toolCall: ToolCall): { name: string; arguments: Record<string, any> } | null {
  try {
    const fn = toolCall.request?.function;
    if (!fn) return null;
    const args = typeof fn.arguments === "string" ? safeParse(fn.arguments) : fn.arguments;
    return { name: fn.name, arguments: args ?? {} };
  } catch {
    return null;
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Friendly label mapping for common arguments.
 */
export function getFriendlyArgLabel(key: string): string {
  const map: Record<string, string> = {
    path: "File path",
    paths: "File paths",
    content: "File content",
    edits: "Edits",
    items: "Items",
    files: "Files",
    action: "Action",
    patterns: "Search terms",
    searchIn: "Where to search",
    properties: "Properties",
    maxResults: "Max results",
    offset: "Start at",
    length: "Read length",
    minSize: "Minimum size (bytes)",
    extensions: "File types",
    groupBy: "Group by",
    sortBy: "Sort by",
    limit: "Limit",
    includeDetails: "Include details",
    url: "Video URL",
    lang: "Language",
  };
  return map[key] || toTitleCase(key.replace(/[_-]/g, " "));
}
