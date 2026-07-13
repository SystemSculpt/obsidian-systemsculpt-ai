import { extractPrimaryPathArg, splitToolName } from "../../utils/toolPolicy";
import type { AgentToolPart } from "./AgentConversation";

export type AgentToolPresentation = Readonly<{
  canonicalName: string;
  label: string;
  stateLabel: string;
  icon: string;
  animated: boolean;
  summary: string | null;
  hasDetails: boolean;
  openByDefault: boolean;
}>;

const TOOL_LABELS: Readonly<Record<string, string>> = {
  read: "Read files",
  write: "Write file",
  edit: "Edit file",
  multi_edit: "Edit files",
  create_folders: "Create folders",
  list_items: "List folder",
  move: "Move items",
  trash: "Move to trash",
  find: "Find files",
  search: "Search vault",
  open: "Open files",
  context: "Update context",
  youtube_transcript: "Read YouTube transcript",
};

const STATE_LABELS: Readonly<Record<AgentToolPart["state"], string>> = {
  "input-streaming": "Preparing",
  "input-ready": "Ready",
  "approval-required": "Needs approval",
  approved: "Approved",
  running: "Working",
  succeeded: "Done",
  failed: "Failed",
  denied: "Denied",
  cancelled: "Stopped",
  "outcome-unknown": "Check required",
};

const STATE_ICONS: Readonly<Record<AgentToolPart["state"], string>> = {
  "input-streaming": "loader-circle",
  "input-ready": "loader-circle",
  "approval-required": "shield-question",
  approved: "loader-circle",
  running: "loader-circle",
  succeeded: "circle-check",
  failed: "circle-x",
  denied: "ban",
  cancelled: "square",
  "outcome-unknown": "triangle-alert",
};

const ANIMATED_STATES = new Set<AgentToolPart["state"]>([
  "input-streaming",
  "input-ready",
  "approved",
  "running",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;
  const match = value.find((entry) => typeof entry === "string" && entry.trim());
  return typeof match === "string" ? match.trim() : null;
}

function compact(value: string | null | undefined, max = 96): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function inputSummary(canonicalName: string, input: Record<string, unknown>): string | null {
  const primaryPath = extractPrimaryPathArg(canonicalName, input);
  if (primaryPath) return compact(primaryPath);

  if (canonicalName === "search" || canonicalName === "find") {
    return compact(firstString(input.query) ?? firstString(input.pattern));
  }
  if (canonicalName === "list_items") {
    return compact(firstString(input.path) ?? firstString(input.paths) ?? "Vault root");
  }
  if (canonicalName === "open" || canonicalName === "context") {
    return compact(firstString(input.paths) ?? firstString(input.path));
  }
  if (canonicalName === "youtube_transcript") {
    return compact(firstString(input.url) ?? firstString(input.videoId));
  }
  return null;
}

export function presentAgentTool(part: AgentToolPart): AgentToolPresentation {
  const { canonicalName } = splitToolName(part.name);
  const input = record(part.input);
  const outputSummary = compact(part.output?.summary ?? part.output?.title);
  const summary = outputSummary ?? inputSummary(canonicalName, input);
  const hasDetails = typeof part.input !== "undefined"
    || Boolean(part.inputText)
    || typeof part.output?.data !== "undefined"
    || Boolean(part.error)
    || (part.output?.artifacts?.length ?? 0) > 0;

  return {
    canonicalName,
    label: TOOL_LABELS[canonicalName] || canonicalName
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool",
    stateLabel: STATE_LABELS[part.state],
    icon: STATE_ICONS[part.state],
    animated: ANIMATED_STATES.has(part.state),
    summary,
    hasDetails,
    openByDefault: part.state === "failed" || part.state === "outcome-unknown",
  };
}
