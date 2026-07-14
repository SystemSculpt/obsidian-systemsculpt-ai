import {
  isFirstPartyToolName,
  normalizeFirstPartyToolName,
  type FirstPartyToolName,
} from "../tools/toolNames";

export type ToolNameParts = {
  actualName: string;
  canonicalName: string;
};

export function splitToolName(fullName: string): ToolNameParts {
  const actualName = String(fullName ?? "").trim();
  return {
    actualName,
    canonicalName: normalizeFirstPartyToolName(actualName),
  };
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

const MUTATING_TOOLS = new Set<FirstPartyToolName>([
  "write",
  "edit",
  "multi_edit",
  "create_folders",
  "move",
  "trash",
]);

function normalizePolicyName(value: unknown): string {
  return normalizeFirstPartyToolName(value);
}

function normalizedNames(values: Iterable<string> | undefined): Set<string> {
  const result = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizePolicyName(value);
    if (normalized) result.add(normalized);
  }
  return result;
}

export function isToolAllowlisted(functionName: string, allowlist: string[] = []): boolean {
  const canonicalName = normalizePolicyName(functionName);
  if (!canonicalName) return false;
  const normalizedAllowlist = normalizedNames(Array.isArray(allowlist) ? allowlist : []);
  return normalizedAllowlist.has("*") || normalizedAllowlist.has(canonicalName);
}

export function isMutatingTool(fullName: string): boolean {
  const canonicalName = normalizeFirstPartyToolName(fullName);
  return isFirstPartyToolName(canonicalName) && MUTATING_TOOLS.has(canonicalName);
}

export function getToolApprovalDecision(
  functionName: string,
  allowlist: string[] = [],
): ToolApprovalDecision {
  const canonicalName = normalizeFirstPartyToolName(functionName);
  if (!isFirstPartyToolName(canonicalName)) {
    return { autoApprove: false, reason: "invalid" };
  }
  if (!MUTATING_TOOLS.has(canonicalName)) {
    return { autoApprove: true, reason: "non-mutating" };
  }
  if (canonicalName === "trash") {
    return { autoApprove: false, reason: "mutating-default" };
  }
  if (isToolAllowlisted(canonicalName, allowlist)) {
    return { autoApprove: true, reason: "allowlisted" };
  }
  return { autoApprove: false, reason: "mutating-default" };
}

export function requiresUserApproval(
  toolName: string,
  policy: ToolApprovalPolicy = {},
): boolean {
  const canonicalName = normalizeFirstPartyToolName(toolName);
  if (!isFirstPartyToolName(canonicalName)) return true;
  if (!MUTATING_TOOLS.has(canonicalName)) return false;
  if (policy.requireDestructiveApproval === false) return false;
  if (canonicalName === "trash") return true;

  const trusted = normalizedNames(policy.trustedToolNames);
  if (trusted.has(canonicalName)) return false;
  return !isToolAllowlisted(canonicalName, policy.autoApproveAllowlist ?? []);
}

/** Extract the primary vault path from canonical first-party tool arguments. */
export function extractPrimaryPathArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const canonicalName = normalizeFirstPartyToolName(toolName);
  if (canonicalName === "move") {
    const items = (args as { items?: unknown }).items;
    if (Array.isArray(items) && (items[0] as any)?.destination) {
      return String((items[0] as any).destination);
    }
  }
  if (canonicalName === "multi_edit") {
    const files = (args as { files?: unknown }).files;
    if (Array.isArray(files) && typeof (files[0] as any)?.path === "string") {
      return String((files[0] as any).path);
    }
  }
  const argumentNames: Partial<Record<FirstPartyToolName, string>> = {
    read: "paths",
    write: "path",
    edit: "path",
    create_folders: "paths",
    trash: "paths",
  };
  const argumentName = isFirstPartyToolName(canonicalName)
    ? argumentNames[canonicalName]
    : undefined;
  if (!argumentName) return null;
  const value = args[argumentName];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}
