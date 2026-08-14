import { extractPrimaryPathArg, splitToolName } from "../../utils/toolPolicy";
import {
  countLocalToolOutcome,
  localToolOutcomeSchema,
} from "../../tools/LocalToolOutcome";
import type { AgentToolPart } from "./AgentConversation";
import { isActiveAgentToolState } from "./AgentConversationPresentation";

type AgentToolDisplayState = AgentToolPart["state"] | "partial";

export type AgentToolPresentation = Readonly<{
  canonicalName: string;
  label: string;
  actionIcon: string;
  displayState: AgentToolDisplayState;
  icon: string;
  summary: string | null;
}>;

export type AgentToolDetail = Readonly<{
  label: string;
  value: string;
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
  context: "Manage pinned files",
};

const SERVER_TOOL_LABELS: Readonly<Record<string, string>> = {
  web_search: "Search the web",
};

const UNKNOWN_SERVER_TOOL_LABEL = "SystemSculpt action";

const TOOL_ACTION_ICONS: Readonly<Record<string, string>> = {
  read: "file-text",
  write: "file-plus-2",
  edit: "file-pen-line",
  multi_edit: "files",
  create_folders: "folder-plus",
  list_items: "list-tree",
  move: "arrow-right-left",
  trash: "trash-2",
  find: "file-search",
  search: "search",
  open: "folder-open",
  context: "pin",
  web_search: "globe-2",
  server_action: "wand-sparkles",
};

const STATE_ICONS: Readonly<Record<AgentToolDisplayState, string>> = {
  "input-streaming": "minus",
  "input-ready": "minus",
  "approval-required": "minus",
  approved: "minus",
  running: "minus",
  succeeded: "check",
  partial: "x",
  failed: "x",
  denied: "x",
  cancelled: "x",
  "outcome-unknown": "x",
};

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
  find: { verb: "Search", singular: "pattern", plural: "patterns" },
  search: { verb: "Search", singular: "pattern", plural: "patterns" },
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

type ToolActionState = "base" | "active" | "complete";

const TOOL_ACTION_FORMS: Readonly<Record<string, readonly [active: string, complete: string]>> = {
  Read: ["Reading", "Read"],
  Write: ["Writing", "Wrote"],
  Edit: ["Editing", "Edited"],
  Create: ["Creating", "Created"],
  List: ["Listing", "Listed"],
  Move: ["Moving", "Moved"],
  Find: ["Finding", "Found"],
  Search: ["Searching", "Searched"],
  Open: ["Opening", "Opened"],
  Manage: ["Managing", "Managed"],
  Pin: ["Pinning", "Pinned"],
  Unpin: ["Unpinning", "Unpinned"],
};

function actionState(displayState: AgentToolDisplayState): ToolActionState {
  if (displayState !== "partial" && isActiveAgentToolState(displayState)) {
    return "active";
  }
  return displayState === "succeeded" || displayState === "partial"
    ? "complete"
    : "base";
}

function actionLabel(label: string, state: ToolActionState): string {
  if (state === "base") return label;
  if (label === UNKNOWN_SERVER_TOOL_LABEL) {
    return state === "active" ? "Running SystemSculpt action..." : "Ran SystemSculpt action";
  }
  const verb = label.split(" ", 1)[0] ?? "";
  const forms = TOOL_ACTION_FORMS[verb];
  if (!forms) return label;
  const tense = state === "active" ? forms[0] : forms[1];
  const result = `${tense}${label.slice(verb.length)}`;
  return state === "active" ? `${result}...` : result;
}

function countedLabel(counted: CountedTool, state: ToolActionState): string {
  const noun = counted.items.length === 1 ? counted.singular : counted.plural;
  return actionLabel(`${counted.verb} ${counted.items.length} ${noun}`, state);
}

type ToolOutcomeCounts = Readonly<{ completed: number; failed: number }>;

function toolOutcomeCounts(part: AgentToolPart, canonicalName: string): ToolOutcomeCounts {
  return countLocalToolOutcome(
    part.output?.data,
    localToolOutcomeSchema(canonicalName),
  );
}

function partialOutcomeSummary(counts: ToolOutcomeCounts): string | null {
  const total = counts.completed + counts.failed;
  if (total === 0 || counts.failed === 0) return null;
  const { completed, failed } = counts;
  return `${completed} completed, ${failed} failed`;
}

function hasPartialOutcome(part: AgentToolPart, counts: ToolOutcomeCounts): boolean {
  const total = counts.completed + counts.failed;
  // Structured item outcomes are more authoritative than a top-level error
  // code. In particular, an all-failed batch must remain Failed even if an
  // older producer mislabeled it as partial; only a genuinely mixed batch is
  // Partial. Fall back to the code for tools without item-level results.
  if (total > 0) return counts.completed > 0 && counts.failed > 0;
  return /(?:^|_)PARTIAL(?:_|$)/u.test(part.error?.code ?? "");
}

/**
 * Tool failures are local timeline events, not whole-response failures. Keep
 * provider and vault details private while making it clear that later agent
 * work may still continue and that successful partial results were retained.
 */
export function presentAgentToolFailure(part: AgentToolPart): string {
  const { canonicalName } = splitToolName(part.name);
  if (hasPartialOutcome(part, toolOutcomeCounts(part, canonicalName))) {
    return "Some requested items failed; successful items were kept.";
  }
  if (part.state === "outcome-unknown") {
    return "The result is uncertain. Check the vault before retrying.";
  }
  if (part.location === "vault") {
    return "This vault action could not be completed.";
  }
  return canonicalName === "web_search"
    ? "Web search could not be completed."
    : "This SystemSculpt action could not be completed.";
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

const MAX_TOOL_DETAIL_ROWS = 8;
const MAX_TOOL_DETAIL_VALUE_LENGTH = 240;
const VAULT_TOOLS_WITH_SAFE_DETAILS: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "multi_edit",
  "create_folders",
  "list_items",
  "move",
  "trash",
  "find",
  "search",
  "open",
  "context",
]);

function detailValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= MAX_TOOL_DETAIL_VALUE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TOOL_DETAIL_VALUE_LENGTH - 1).trimEnd()}…`;
}

function addDetail(
  details: AgentToolDetail[],
  label: string,
  value: unknown,
): void {
  const visibleValue = detailValue(value);
  if (visibleValue) details.push({ label, value: visibleValue });
}

function addDetails(
  details: AgentToolDetail[],
  label: string,
  values: readonly string[],
): void {
  for (const value of values) addDetail(details, label, value);
}

function limitToolDetails(details: readonly AgentToolDetail[]): readonly AgentToolDetail[] {
  if (details.length <= MAX_TOOL_DETAIL_ROWS) return details;
  const result = details[details.length - 1]?.label === "Result"
    ? details[details.length - 1]
    : null;
  const visibleCount = result ? MAX_TOOL_DETAIL_ROWS - 2 : MAX_TOOL_DETAIL_ROWS - 1;
  const omittedCount = details.length - visibleCount - (result ? 1 : 0);
  return [
    ...details.slice(0, visibleCount),
    { label: "More", value: `${omittedCount} more item${omittedCount === 1 ? "" : "s"}` },
    ...(result ? [result] : []),
  ];
}

/**
 * Returns only known, useful tool details. It never exposes raw JSON, file
 * contents, edit text, unknown server input, or provider-owned output data.
 */
export function presentAgentToolDetails(
  part: AgentToolPart,
): readonly AgentToolDetail[] {
  const { canonicalName } = splitToolName(part.name);
  if (part.location === "server") {
    if (canonicalName !== "web_search") return [];
    const query = webSearchQuery(part);
    return query ? [{ label: "Query", value: detailValue(query)! }] : [];
  }
  if (!VAULT_TOOLS_WITH_SAFE_DETAILS.has(canonicalName)) return [];

  const input = record(part.input);
  const details: AgentToolDetail[] = [];
  const paths = (): string[] => [...strings(input.paths), ...strings(input.path)];
  const outcomeCounts = toolOutcomeCounts(part, canonicalName);
  const useSuccessfulArtifacts = outcomeCounts.failed > 0 || [
    "failed",
    "denied",
    "cancelled",
    "outcome-unknown",
  ].includes(part.state);
  if (useSuccessfulArtifacts) {
    addDetails(
      details,
      "Path",
      part.output?.artifacts?.flatMap((artifact) => strings(artifact.path)) ?? [],
    );
  } else {
    switch (canonicalName) {
      case "read":
      case "create_folders":
      case "list_items":
      case "trash":
        addDetails(details, "Path", paths());
        break;
      case "write":
      case "edit":
        addDetails(details, "Path", strings(input.path));
        break;
      case "multi_edit":
        addDetails(details, "Path", objectStrings(input.files, "path"));
        break;
      case "open":
        addDetails(details, "Path", [
          ...objectStrings(input.files, "path"),
          ...strings(input.path),
        ]);
        break;
      case "context": {
        const action = firstString(input.action)?.toLowerCase();
        if (action === "add") addDetail(details, "Action", "Pin files");
        if (action === "remove") addDetail(details, "Action", "Unpin files");
        addDetails(details, "Path", paths());
        break;
      }
      case "find":
        addDetails(details, "Pattern", [
          ...strings(input.patterns),
          ...strings(input.pattern),
        ]);
        addDetails(details, "Scope", paths());
        break;
      case "search":
        addDetails(details, "Query", [
          ...strings(input.patterns),
          ...strings(input.query),
          ...strings(input.pattern),
        ]);
        addDetails(details, "Scope", paths());
        break;
      case "move": {
        addDetails(details, "Source", [
          ...objectStrings(input.items, "source"),
          ...strings(input.sources),
        ]);
        addDetails(details, "Destination", [
          ...objectStrings(input.items, "destination"),
          ...strings(input.destination),
        ]);
        break;
      }
      default:
        return [];
    }
  }

  const result = useSuccessfulArtifacts
    ? null
    : detailValue(part.output?.summary ?? part.output?.title);
  const visibleSummary = detailValue(presentAgentTool(part).summary);
  if (
    result
    && result !== visibleSummary
    && !details.some((detail) => detail.value === result)
  ) {
    details.push({ label: "Result", value: result });
  }
  return limitToolDetails(details);
}

export function presentAgentTool(part: AgentToolPart): AgentToolPresentation {
  const { canonicalName } = splitToolName(part.name);
  const outcomeCounts = toolOutcomeCounts(part, canonicalName);
  const input = record(part.input);
  const serverLabel = part.location === "server"
    ? SERVER_TOOL_LABELS[canonicalName]
    : undefined;
  const unknownServerTool = part.location === "server" && !serverLabel;
  const serverTool = part.location === "server";
  const counted = part.location === "vault"
    ? countedTool(canonicalName, input)
    : null;
  const partialSummary = serverTool
    ? null
    : partialOutcomeSummary(outcomeCounts);
  const displayState: AgentToolDisplayState = !serverTool
    && hasPartialOutcome(part, outcomeCounts)
    ? "partial"
    : displayedToolState(part);
  const outputSummary = serverTool
    ? null
    : compact(part.output?.summary ?? part.output?.title);
  const summary = serverTool
    ? null
    : partialSummary ?? outputSummary ?? inputSummary(canonicalName, input);
  const presentedName = unknownServerTool ? "server_action" : canonicalName;
  const labelState = actionState(displayState);
  return {
    canonicalName: presentedName,
    label: part.location === "server"
      ? actionLabel(serverLabel ?? UNKNOWN_SERVER_TOOL_LABEL, labelState)
      : counted
        ? countedLabel(counted, labelState)
        : canonicalName === "context"
          ? actionLabel(contextToolLabel(input), labelState)
          : TOOL_LABELS[canonicalName]
            ? actionLabel(TOOL_LABELS[canonicalName], labelState)
            : canonicalName
              .replace(/[_-]+/g, " ")
              .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool",
    actionIcon: TOOL_ACTION_ICONS[presentedName] ?? "wrench",
    displayState,
    icon: STATE_ICONS[displayState],
    summary,
  };
}
