export type ToolNameParts = {
  serverId: string | null;
  actualName: string;
  canonicalName: string;
};

/**
 * PI-style canonical tool aliases mapped onto our filesystem MCP tool surface.
 * This lets the model call canonical names (e.g. `read`, `ls`, `grep`) while
 * still executing through the stable `mcp-filesystem_*` implementation.
 */
const PI_FILESYSTEM_TOOL_ALIASES: Record<string, string> = Object.freeze({
  read: "mcp-filesystem_read",
  write: "mcp-filesystem_write",
  edit: "mcp-filesystem_edit",
  move: "mcp-filesystem_move",
  trash: "mcp-filesystem_trash",
  find: "mcp-filesystem_find",
  grep: "mcp-filesystem_search",
  ls: "mcp-filesystem_list_items",
  mkdir: "mcp-filesystem_create_folders",
  open: "mcp-filesystem_open",
  context: "mcp-filesystem_context",
});

const MCP_TO_PI_ALIAS: Map<string, string> = new Map();
for (const [alias, mapped] of Object.entries(PI_FILESYSTEM_TOOL_ALIASES)) {
  if (!MCP_TO_PI_ALIAS.has(mapped)) {
    MCP_TO_PI_ALIAS.set(mapped, alias);
  }
}

export function resolveCanonicalToolAlias(fullName: string): string {
  const raw = String(fullName ?? "").trim();
  if (!raw) return "";
  const mapped = PI_FILESYSTEM_TOOL_ALIASES[raw.toLowerCase()];
  return mapped || raw;
}

export function getCanonicalAliasForMcpTool(fullName: string): string | null {
  const mapped = resolveCanonicalToolAlias(fullName).toLowerCase();
  return MCP_TO_PI_ALIAS.get(mapped) || null;
}

export function splitToolName(fullName: string): ToolNameParts {
  const name = resolveCanonicalToolAlias(fullName);
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
  const { serverId, canonicalName } = splitToolName(resolveCanonicalToolAlias(functionName));
  if (!serverId) return null;
  return `${serverId.toLowerCase()}:${canonicalName}`;
}

export type ToolApprovalDecision = {
  autoApprove: boolean;
  reason: "non-mutating" | "allowlisted" | "mutating-default" | "invalid";
};

export type ToolApprovalPolicy = {
  trustedToolNames?: Set<string>;
  requireDestructiveApproval?: boolean;
  autoApproveAllowlist?: string[];
};

function normalizeToolAllowlist(allowlist: string[] = []): Set<string> {
  return new Set(
    (Array.isArray(allowlist) ? allowlist : [])
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
}

export function isToolAllowlisted(functionName: string, allowlist: string[] = []): boolean {
  const originalName = String(functionName ?? "").trim();
  if (!originalName) return false;
  const name = originalName.toLowerCase();
  const resolved = resolveCanonicalToolAlias(originalName);
  const resolvedLower = resolved.toLowerCase();

  const normalizedAllowlist = normalizeToolAllowlist(allowlist);
  if (normalizedAllowlist.size === 0) return false;

  if (normalizedAllowlist.has(name) || normalizedAllowlist.has(resolvedLower)) {
    return true;
  }

  const { canonicalName } = splitToolName(resolved);
  if (canonicalName && normalizedAllowlist.has(canonicalName)) {
    return true;
  }

  const mcpKey = toMcpToolKey(resolved);
  if (mcpKey && normalizedAllowlist.has(mcpKey)) {
    return true;
  }

  return false;
}

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

  if (isToolAllowlisted(name, allowlist)) {
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
 * - Allowlisted mutating tools can auto-approve
 * - Settings can disable destructive tool confirmations
 * - YouTube: never requires approval (read-only)
 * - External MCP servers: all tools require approval
 *
 * @param toolName - The full tool name (e.g., "mcp-filesystem_write")
 * @param policy - Policy inputs including trusted tool names and allowlist
 * @returns true if the tool requires user approval, false if it can auto-execute
 */
export function requiresUserApproval(
  toolName: string,
  policy: ToolApprovalPolicy = {}
): boolean {
  const rawToolName = String(toolName ?? "").trim();
  if (!rawToolName) return false;
  const resolvedToolName = resolveCanonicalToolAlias(rawToolName);

  // If trusted for this session, no approval needed
  if (policy.trustedToolNames?.has(rawToolName) || policy.trustedToolNames?.has(resolvedToolName)) {
    return false;
  }

  const { serverId, canonicalName } = splitToolName(resolvedToolName);
  if (!serverId) {
    return false;
  }

  // YouTube: read-only, never needs approval
  if (serverId === "mcp-youtube") {
    return false;
  }

  const requireDestructiveApproval = policy.requireDestructiveApproval !== false;
  const allowlisted = isToolAllowlisted(resolvedToolName, policy.autoApproveAllowlist || []);

  // Filesystem: only specific destructive tools
  if (serverId === "mcp-filesystem") {
    if (!DESTRUCTIVE_FILESYSTEM_TOOLS.has(canonicalName)) {
      return false;
    }
    if (!requireDestructiveApproval) {
      return false;
    }
    return !allowlisted;
  }

  // External MCP servers: all tools require approval
  if (serverId && serverId.startsWith("mcp-") && !INTERNAL_SERVERS.has(serverId)) {
    if (allowlisted) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Extract the primary file path from tool args, if any.
 */
export function extractPrimaryPathArg(toolName: string, args: Record<string, unknown>): string | null {
  const base = resolveCanonicalToolAlias(String(toolName ?? "")).replace(/^mcp[-_][^_]+_/, "");
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
