import { extractPrimaryPathArg, splitToolName } from "../../utils/toolPolicy";
import type { AgentToolPart } from "./AgentConversation";

export type AgentToolPresentation = Readonly<{
  canonicalName: string;
  label: string;
  displayState: AgentToolPart["state"];
  stateLabel: string;
  icon: string;
  animated: boolean;
  summary: string | null;
  itemCount: number | null;
  queries: readonly (string | null)[];
}>;

export type AgentToolActivityEntry<T> =
  | Readonly<{ kind: "item"; item: T }>
  | Readonly<{ kind: "tools"; items: readonly T[]; tools: readonly AgentToolPart[] }>;

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
  context: "Manage pinned files",
};

const SERVER_TOOL_LABELS: Readonly<Record<string, string>> = {
  web_search: "Search the web",
};

const UNKNOWN_SERVER_TOOL_LABEL = "SystemSculpt action";

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

type CountedTool = Readonly<{
  verb: string;
  singular: string;
  plural: string;
  items: readonly string[];
}>;

const COUNTED_TOOL_COPY: Readonly<Record<string, Omit<CountedTool, "items">>> = {
  read: { verb: "Read", singular: "file", plural: "files" },
  open: { verb: "Open", singular: "file", plural: "files" },
  list_items: { verb: "List", singular: "folder", plural: "folders" },
  find: { verb: "Search", singular: "file pattern", plural: "file patterns" },
  search: { verb: "Search", singular: "text pattern", plural: "text patterns" },
};

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

function firstObjectString(value: unknown, key: string): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = (entry as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function compact(value: string | null | undefined, max = 96): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function objectStrings(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    return strings((entry as Record<string, unknown>)[key]);
  });
}

function countedTool(canonicalName: string, input: Record<string, unknown>): CountedTool | null {
  const copy = COUNTED_TOOL_COPY[canonicalName];
  if (!copy) return null;
  const items = canonicalName === "open"
    ? objectStrings(input.files, "path")
    : canonicalName === "list_items"
      ? [...strings(input.paths), ...strings(input.path)]
      : canonicalName === "read"
        ? [...strings(input.paths), ...strings(input.path)]
        : strings(input.patterns);
  return items.length > 0 ? { ...copy, items } : null;
}

function countedLabel(counted: CountedTool): string {
  const noun = counted.items.length === 1 ? counted.singular : counted.plural;
  return `${counted.verb} ${counted.items.length} ${noun}`;
}

function resultEntries(part: AgentToolPart, canonicalName: string): readonly Record<string, unknown>[] {
  if (!["read", "open", "list_items"].includes(canonicalName)) return [];
  const data = record(part.output?.data);
  const value = canonicalName === "read" ? data.files : data.results;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function failedResultEntry(entry: Record<string, unknown>): boolean {
  return entry.success === false
    || (typeof entry.error === "string" && entry.error.trim().length > 0)
    || (Boolean(entry.error) && typeof entry.error === "object");
}

function partialOutcomeSummary(part: AgentToolPart, canonicalName: string): string | null {
  const entries = resultEntries(part, canonicalName);
  if (entries.length === 0) return null;
  const failed = entries.filter(failedResultEntry).length;
  if (failed === 0) return null;
  const completed = entries.length - failed;
  return `${completed} completed, ${failed} failed`;
}

function toolScope(part: AgentToolPart): CountedTool | null {
  const { canonicalName } = splitToolName(part.name);
  return countedTool(canonicalName, record(part.input));
}

function isWebSearchTool(part: AgentToolPart): boolean {
  return part.location === "server"
    && splitToolName(part.name).canonicalName === "web_search";
}

function webSearchQuery(part: AgentToolPart): string | null {
  if (!isWebSearchTool(part)) return null;
  const publicResultQuery = firstString(record(part.output?.data).query);
  if (publicResultQuery) return publicResultQuery;
  return part.state === "succeeded"
    ? firstString(record(part.input).query)
    : null;
}

function displayedToolState(part: AgentToolPart): AgentToolPart["state"] {
  return part.location === "server" && (
    part.state === "input-ready"
    || part.state === "approval-required"
    || part.state === "approved"
  )
    ? "running"
    : part.state;
}

function webSearchGroupState(
  parts: readonly AgentToolPart[],
): AgentToolPart["state"] {
  const states = parts.map(displayedToolState);
  if (states.some((state) => ANIMATED_STATES.has(state))) return "running";
  for (const state of [
    "failed",
    "outcome-unknown",
    "denied",
    "cancelled",
  ] as const) {
    if (states.includes(state)) return state;
  }
  return states.every((state) => state === "succeeded")
    ? "succeeded"
    : states[states.length - 1] ?? "running";
}

function canAppendWebSearch(
  group: readonly AgentToolPart[],
  candidate: AgentToolPart,
): boolean {
  return isWebSearchTool(candidate) && group.every(isWebSearchTool);
}

function normalizedScopeItem(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLocaleLowerCase();
}

function canAppendTool(
  group: readonly AgentToolPart[],
  candidate: AgentToolPart,
): boolean {
  const previous = group[group.length - 1];
  if (!previous || previous.state !== "succeeded" || candidate.state !== "succeeded") return false;
  if (previous.location !== candidate.location) return false;
  const previousName = splitToolName(previous.name).canonicalName;
  const candidateName = splitToolName(candidate.name).canonicalName;
  if (previousName !== candidateName) return false;

  const existingScopes = group.map(toolScope);
  const candidateScope = toolScope(candidate);
  if (existingScopes.some((scope) => !scope) || !candidateScope) return false;
  if (group.some((part) => resultEntries(part, previousName).some(failedResultEntry))) return false;
  if (resultEntries(candidate, candidateName).some(failedResultEntry)) return false;

  const seen = new Set(existingScopes.flatMap((scope) =>
    scope!.items.map(normalizedScopeItem)));
  return candidateScope.items.every((item) => !seen.has(normalizedScopeItem(item)));
}

function compactScope(items: readonly string[]): string | null {
  if (items.length === 0) return null;
  const visible = items.slice(0, 2);
  const remaining = items.length - visible.length;
  return compact(`${visible.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}`);
}

function inputSummary(canonicalName: string, input: Record<string, unknown>): string | null {
  const primaryPath = extractPrimaryPathArg(canonicalName, input);
  if (primaryPath) return compact(primaryPath);

  if (canonicalName === "search" || canonicalName === "find") {
    return compact(firstString(input.patterns));
  }
  if (canonicalName === "list_items") {
    return compact(firstString(input.path) ?? firstString(input.paths) ?? "Vault root");
  }
  if (canonicalName === "open") {
    return compact(firstObjectString(input.files, "path"));
  }
  if (canonicalName === "context") {
    return compact(firstString(input.paths));
  }
  return null;
}

function contextToolLabel(input: Record<string, unknown>): string {
  const action = firstString(input.action)?.toLowerCase();
  if (action === "add") return "Pin files";
  if (action === "remove") return "Unpin files";
  return TOOL_LABELS.context;
}

export function presentAgentTool(part: AgentToolPart): AgentToolPresentation {
  const { canonicalName } = splitToolName(part.name);
  const input = record(part.input);
  const serverLabel = part.location === "server"
    ? SERVER_TOOL_LABELS[canonicalName]
    : undefined;
  const unknownServerTool = part.location === "server" && !serverLabel;
  const serverTool = part.location === "server";
  const displayState = displayedToolState(part);
  const counted = part.location === "vault"
    ? countedTool(canonicalName, input)
    : null;
  const partialSummary = serverTool
    ? null
    : partialOutcomeSummary(part, canonicalName);
  const outputSummary = serverTool
    ? null
    : compact(part.output?.summary ?? part.output?.title);
  const summary = serverTool
    ? null
    : partialSummary ?? outputSummary ?? inputSummary(canonicalName, input);
  const query = webSearchQuery(part);
  return {
    canonicalName: unknownServerTool ? "server_action" : canonicalName,
    label: part.location === "server"
      ? serverLabel ?? UNKNOWN_SERVER_TOOL_LABEL
      : counted
        ? countedLabel(counted)
        : canonicalName === "context"
          ? contextToolLabel(input)
          : TOOL_LABELS[canonicalName] || canonicalName
          .replace(/[_-]+/g, " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool",
    displayState,
    stateLabel: STATE_LABELS[displayState],
    icon: STATE_ICONS[displayState],
    animated: ANIMATED_STATES.has(displayState),
    summary,
    itemCount: counted?.items.length ?? null,
    queries: canonicalName === "web_search" && serverTool ? [query] : [],
  };
}

export function presentAgentToolGroup(
  parts: readonly AgentToolPart[],
): AgentToolPresentation {
  const first = parts[0];
  if (!first) {
    throw new Error("A tool presentation group must contain at least one tool.");
  }
  const base = presentAgentTool(first);
  if (parts.length === 1) return base;
  if (base.canonicalName === "web_search") {
    const displayState = webSearchGroupState(parts);
    return {
      ...base,
      label: `Search the web (${parts.length})`,
      displayState,
      stateLabel: STATE_LABELS[displayState],
      icon: STATE_ICONS[displayState],
      animated: ANIMATED_STATES.has(displayState),
      summary: null,
      itemCount: parts.length,
      queries: parts.map(webSearchQuery),
    };
  }
  if (first.location === "server") return base;
  const scopes = parts.map(toolScope);
  if (scopes.some((scope) => !scope)) return base;
  const items = scopes.flatMap((scope) => scope!.items);
  const counted = { ...scopes[0]!, items };
  return {
    ...base,
    label: countedLabel(counted),
    summary: compactScope(items),
    itemCount: items.length,
  };
}

/**
 * Groups adjacent web searches from one uninterrupted batch. It also groups
 * terminal read-only vault activity with explicit, non-overlapping scope.
 * Any non-tool item remains a chronology boundary.
 */
export function groupConsecutiveToolActivity<T>(
  items: readonly T[],
  toolFor: (item: T) => AgentToolPart | null,
  enabled = true,
): readonly AgentToolActivityEntry<T>[] {
  const result: AgentToolActivityEntry<T>[] = [];
  for (const item of items) {
    const tool = toolFor(item);
    if (!tool) {
      result.push({ kind: "item", item });
      continue;
    }
    const previous = result[result.length - 1];
    if (
      previous?.kind === "tools"
      && (
        canAppendWebSearch(previous.tools, tool)
        || (enabled && canAppendTool(previous.tools, tool))
      )
    ) {
      result[result.length - 1] = {
        kind: "tools",
        items: [...previous.items, item],
        tools: [...previous.tools, tool],
      };
      continue;
    }
    result.push({ kind: "tools", items: [item], tools: [tool] });
  }
  return result;
}
