export type ToolNameParts = {
  serverId: string | null;
  actualName: string;
  canonicalName: string;
};

export function splitToolName(fullName: string): ToolNameParts {
  const name = String(fullName ?? "");
  const firstUnderscoreIndex = name.indexOf("_");
  if (name.startsWith("mcp-") && firstUnderscoreIndex !== -1) {
    const serverId = name.substring(0, firstUnderscoreIndex);
    const actualName = name.substring(firstUnderscoreIndex + 1);
    return { serverId, actualName, canonicalName: actualName.toLowerCase() };
  }

  return { serverId: null, actualName: name, canonicalName: name.toLowerCase() };
}

/**
 * Convert an OpenAI-style MCP function name (e.g. `mcp-filesystem_read`) into
 * the canonical tool key used in settings lists (e.g. `mcp-filesystem:read`).
 */
export function toMcpToolKey(functionName: string): string | null {
  const { serverId, canonicalName } = splitToolName(functionName);
  if (!serverId) return null;
  return `${serverId.toLowerCase()}:${canonicalName}`;
}

export type ToolApprovalDecision = {
  autoApprove: boolean;
  reason: "non-mutating" | "allowlisted" | "mutating-default" | "invalid";
};

/**
 * Heuristic to determine if a tool mutates the vault or performs high-risk actions.
 */
export function isMutatingTool(fullName: string): boolean {
  const base = String(fullName ?? "").replace(/^mcp[-_][^_]+_/, "");
  const canonical = base.toLowerCase();

  const mutating = new Set([
    "write",
    "edit",
    "move",
    "trash",
    "create_folders",
    "delete",
    "rename",
    "append",
    "replace",
    "update",
    "set",
    "create",
    "copy",
    "run",
    "run_command",
    "command",
    "execute",
    "exec",
    "shell",
    "spawn",
    "process",
    "system",
    "powershell",
    "bash",
    "sh",
    "python",
    "node",
    "eval",
    "http_request",
    "request",
    "fetch",
    "curl",
  ]);

  if (mutating.has(canonical)) {
    return true;
  }
  if (/^(write|edit|delete|remove|rename|create|update|set|append|move|trash|copy)/.test(canonical)) {
    return true;
  }
  return /(command|execute|exec|shell|spawn|process|system|powershell|bash|python|node|run_command|http_request|curl)/.test(canonical);
}

export function getToolApprovalDecision(functionName: string, allowlist: string[] = []): ToolApprovalDecision {
  const name = String(functionName ?? "").trim();
  if (!name) {
    return { autoApprove: false, reason: "invalid" };
  }

  if (!isMutatingTool(name)) {
    return { autoApprove: true, reason: "non-mutating" };
  }

  const normalizedAllowlist = new Set(
    (Array.isArray(allowlist) ? allowlist : [])
      .map((entry) => String(entry ?? "").toLowerCase())
      .filter((entry) => entry.length > 0)
  );
  if (normalizedAllowlist.size === 0) {
    return { autoApprove: false, reason: "mutating-default" };
  }

  const lowerName = name.toLowerCase();
  if (normalizedAllowlist.has(lowerName)) {
    return { autoApprove: true, reason: "allowlisted" };
  }

  const { canonicalName } = splitToolName(name);
  if (canonicalName && normalizedAllowlist.has(canonicalName)) {
    return { autoApprove: true, reason: "allowlisted" };
  }

  const mcpKey = toMcpToolKey(name);
  if (mcpKey && normalizedAllowlist.has(mcpKey)) {
    return { autoApprove: true, reason: "allowlisted" };
  }

  return { autoApprove: false, reason: "mutating-default" };
}

export function shouldAutoApproveTool(functionName: string, allowlist: string[] = []): boolean {
  return getToolApprovalDecision(functionName, allowlist).autoApprove;
}

/**
 * Built-in filesystem tools that require user approval before execution.
 * These are the destructive operations that can modify or delete vault content.
 */
const DESTRUCTIVE_FILESYSTEM_TOOLS = new Set(["write", "edit", "move", "trash"]);

/**
 * Internal MCP servers that have special approval rules.
 * - mcp-filesystem: only destructive tools require approval
 * - mcp-youtube: read-only, never requires approval
 */
const INTERNAL_SERVERS = new Set(["mcp-filesystem", "mcp-youtube"]);

/**
 * Determine if a tool requires explicit user approval before execution.
 *
 * - Built-in filesystem: only write, edit, move, trash require approval
 * - YouTube: never requires approval (read-only)
 * - External MCP servers: all tools require approval
 *
 * @param toolName - The full tool name (e.g., "mcp-filesystem_write")
 * @param trustedToolNames - Set of tool names trusted for this session
 * @returns true if the tool requires user approval, false if it can auto-execute
 */
export function requiresUserApproval(
  toolName: string,
  trustedToolNames: Set<string>
): boolean {
  // If trusted for this session, no approval needed
  if (trustedToolNames.has(toolName)) {
    return false;
  }

  const { serverId, canonicalName } = splitToolName(toolName);

  // YouTube: read-only, never needs approval
  if (serverId === "mcp-youtube") {
    return false;
  }

  // Filesystem: only specific destructive tools
  if (serverId === "mcp-filesystem") {
    return DESTRUCTIVE_FILESYSTEM_TOOLS.has(canonicalName);
  }

  // External MCP servers: all tools require approval
  if (serverId && serverId.startsWith("mcp-") && !INTERNAL_SERVERS.has(serverId)) {
    return true;
  }

  return false;
}

/**
 * Extract the primary file path from tool args, if any.
 */
export function extractPrimaryPathArg(toolName: string, args: Record<string, unknown>): string | null {
  const base = String(toolName ?? "").replace(/^mcp[-_][^_]+_/, "");
  if (base === "move") {
    const items = (args as { items?: unknown }).items;
    if (Array.isArray(items) && (items[0] as any)?.destination) return String((items[0] as any).destination);
  }
  const map: Record<string, string> = {
    read: "paths",
    write: "path",
    edit: "path",
    trash: "paths",
  };
  const key = map[base];
  if (!key) return null;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}
