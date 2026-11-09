import { extractPrimaryPathArg, splitToolName } from "../../utils/toolPolicy";
import {
  countLocalToolOutcome,
  localToolOutcomeSchema,
} from "../../tools/LocalToolOutcome";
import type { AgentToolPart } from "../../chat/ChatConversation";
import { isActiveAgentToolState } from "./AgentConversationPresentation";
import { editChangeSize, editsImages, studioWorkflowName, imageCountTarget, nativeToolPresentation, noteDisplayName, systemSculptGateNeed, writeChangeSize, type LabelTarget } from "./NativeToolPresentation";
import { decodeSystemSculptToolOutput, systemSculptToolName } from "../../tools/systemsculpt/SystemSculptTools";
import { toolOutputText } from "./ToolCardBlocks";

export type { LabelTarget } from "./NativeToolPresentation";

type AgentToolDisplayState = AgentToolPart["state"] | "partial";

export type AgentToolPresentation = Readonly<{
  canonicalName: string;
  label: string;
  actionIcon: string;
  displayState: AgentToolDisplayState;
  icon: string;
  summary: string | null;
  /** The summary counts outcomes ("1 completed, 2 failed"), so it's always meta. */
  summaryCountsOutcomes?: true;
  meta?: string;
  targetPath?: string;
  groupKind: string;
  groupCount: number;
  /** Distinct notes or folders the group counts, so a repeated path counts once. */
  groupItems?: readonly string[];
  /** The words in the label that name what the call acted on, set apart where the label is drawn. */
  target?: LabelTarget;
  /** A command's non-zero exit status: that command ran, so it never reads "Couldn't run". */
  exitCode?: number;
  /** Stopped at the plan or credits gate: what it would have made and what it needs. */
  gate?: Readonly<{ subject: string; need: string }>;
}>;

/** A target up to this long never breaks across lines ("npm run long-task", “last frost date portland”); a longer one may. */
const WHOLE_TARGET_LENGTH = 32;

/** Classes for a label's target: commands read in the code font; a short target stays on one line. */
export function labelTargetClass(target: LabelTarget): string {
  return ["ss-tool-target", target.command ? "is-command" : "", target.text.length <= WHOLE_TARGET_LENGTH ? "is-whole" : ""].filter(Boolean).join(" ");
}

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
  generate_image: "Generate image",
  generate_video: "Generate video",
  studio_list_workflows: "List Studio workflows",
  studio_create_workflow: "Create Studio workflow",
  studio_open_workflow: "Open Studio workflow",
  studio_edit_workflow: "Edit Studio workflow",
  studio_run_workflow: "Run Studio workflow",
  studio_list_outputs: "List Studio outputs",
};

const UNKNOWN_SERVER_TOOL_LABEL = "SystemSculpt action";

const SERVER_TOOL_LABELS: Readonly<Record<string, string>> = {
  web_search: "Search the web",
};


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
  generate_image: "image",
  generate_video: "film",
  studio_list_workflows: "layout-dashboard",
  studio_create_workflow: "layout-dashboard",
  studio_open_workflow: "layout-dashboard",
  studio_edit_workflow: "layout-dashboard",
  studio_run_workflow: "play",
  studio_list_outputs: "layout-dashboard",
  web_search: "globe-2",
  server_action: "wand-sparkles",
};

const STATE_ICONS: Readonly<Record<AgentToolDisplayState, string>> = {
  "input-streaming": "loader-circle",
  "input-ready": "loader-circle",
  "approval-required": "shield-question",
  approved: "loader-circle",
  running: "loader-circle",
  succeeded: "check",
  // Only a failure is an x. Part done warns; an unknown result asks; a stop is the stop glyph, never a dash.
  partial: "triangle-alert",
  failed: "x",
  denied: "ban",
  cancelled: "circle-stop",
  "outcome-unknown": "circle-help",
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
  find: { verb: "Search for", singular: "pattern", plural: "patterns" },
  search: { verb: "Search for", singular: "pattern", plural: "patterns" },
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
  Run: ["Running", "Ran"],
  Generate: ["Generating", "Generated"],
  Use: ["Using", "Used"],
  Change: ["Changing", "Changed"],
  Delete: ["Deleting", "Deleted"],
  Allow: ["Allowing", "Allowed"],
  Answer: ["Answering", "Answered"],
  Send: ["Sending", "Sent"],
};

/** A SystemSculpt call that finished but did nothing (no subscription, no credits). */
export function refusedSystemSculptCall(part: AgentToolPart): boolean {
  return part.state === "succeeded" && Boolean(systemSculptToolName(part.name))
    && decodeSystemSculptToolOutput(part.output?.data)?.ok === false;
}

/** A refused SystemSculpt call that only needs a plan or credits: an expected gate, not a failure. */
function gatedSystemSculptCall(part: AgentToolPart): string | null {
  if (!refusedSystemSculptCall(part)) return null;
  const label = decodeSystemSculptToolOutput(part.output?.data)?.link?.label;
  return systemSculptGateNeed(label);
}

/** Whether a turn's SystemSculpt call stopped at the plan or credits gate. */
export function gatedSystemSculptTurn(part: AgentToolPart): boolean {
  return gatedSystemSculptCall(part) !== null;
}

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
    return state === "active" ? "Running SystemSculpt action" : "Ran SystemSculpt action";
  }
  const verb = label.split(" ", 1)[0] ?? "";
  const forms = TOOL_ACTION_FORMS[verb];
  if (!forms) return label;
  // "Reading Plan", never "Reading Plan…": the spinner says it is running, and a trailing "…" reads as a cut name.
  return `${state === "active" ? forms[0] : forms[1]}${label.slice(verb.length)}`;
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
/** How loud a tool's notice is: a choice or a guard is calm, uncertainty a warning, breakage an error. */
export function agentToolNoticeTone(part: AgentToolPart, displayState: AgentToolDisplayState): "danger" | "warning" | "info" | "gate" {
  // A subscription or credits stop is the calm lock the whole-turn gate uses, never a failure.
  if (gatedSystemSculptCall(part)) return "gate";
  if (part.state === "denied" || part.state === "cancelled") return "info";
  if (/(?:^|_)(?:AUTO_BLOCKED|REVIEW_BLOCKED|BLOCKED_BY_REVIEW)(?:_|$)/u.test(part.error?.code ?? "")) return "info";
  return displayState === "partial" || part.state === "outcome-unknown" ? "warning" : "danger";
}

/**
 * The notice under a failed call's card. Empty when the card already shows what went wrong (a
 * command's own output, each note's own error), so the card never says the same thing twice.
 */
export function presentAgentToolFailure(part: AgentToolPart): string {
  // SystemSculpt tools write their own plain reason; show it, without the link the chat shows already.
  const own = systemSculptToolName(part.name) ? decodeSystemSculptToolOutput(part.output?.data) : null;
  if (own && !own.ok && own.message) return (own.link ? own.message.split(`${own.link.label}:`)[0] : own.message).trim().slice(0, 300);
  // Denied, stopped and blocked are outcomes the person chose or a guard made, not breakage.
  if (part.state === "denied") return "Denied, so it didn't run.";
  if (part.state === "cancelled") return "Stopped before it finished.";
  const native = nativeToolPresentation(part);
  if (native && /(?:^|_)(?:AUTO_BLOCKED|REVIEW_BLOCKED|BLOCKED_BY_REVIEW)(?:_|$)/u.test(part.error?.code ?? "")) {
    return `${native.agentName} blocked this before it ran.`;
  }
  if (native && part.state === "outcome-unknown") return `The result from ${native.agentName} is uncertain. Check the requested action before retrying.`;
  // A command's terminal shows its own error output.
  if (native?.groupKind === "command" && (toolOutputText(part.output?.data) || toolOutputText(record(part.input).aggregatedOutput)).trim()) return "";
  if (native) return `This ${native.agentName} action could not be completed.`;
  const { canonicalName } = splitToolName(part.name);
  const counts = toolOutcomeCounts(part, canonicalName);
  // The card lists each note with its own outcome ("Draft.md · File not found").
  if (counts.failed > 0) return "";
  if (hasPartialOutcome(part, counts)) return "Some of this didn't go through; the rest did.";
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

/** Tools whose group copy counts notes or folders ("Edited 2 notes", "Listed 3 folders"). */
/** A Studio call on one workflow names it ("Edit Poster workflow"), not the generic "Studio workflow". */
const STUDIO_VERBS: Readonly<Record<string, string>> = {
  studio_create_workflow: "Create", studio_open_workflow: "Open", studio_edit_workflow: "Edit", studio_run_workflow: "Run",
  studio_list_outputs: "List outputs of",
};

const PATH_GROUP_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "multi_edit", "trash", "list_items"]);

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
 * The muted text after a tool line (spec 3.4: counts, +a −b, exit code). A
 * summary shows only when it adds something: never a repeat of the label
 * ("Searched “x”  x") or one target of several ("Read 2 notes  A.md").
 */
export function presentToolLineMeta(presentation: AgentToolPresentation): string | undefined {
  if (presentation.meta) return presentation.meta;
  const summary = presentation.summary;
  if (!summary) return undefined;
  // "Moved 1 of 2 notes" and "Couldn't read A.md" already say the outcome; the tally would repeat it.
  if (presentation.summaryCountsOutcomes) return /\d+ of \d+|^Couldn't /u.test(presentation.label) ? undefined : summary;
  // The label names a note as Obsidian does and the card shows its path: a summary that only says the
  // same ("Read Plan.md", "Projects/Plan.md") adds nothing.
  const plain = (text: string): string => text.toLowerCase().replace(/\.md\b/gu, "");
  let said = plain(summary);
  for (const path of [presentation.targetPath, ...(presentation.groupItems ?? [])]) {
    if (path) said = said.replace(plain(path), plain(path.split(/[\\/]/u).pop() ?? path));
  }
  if (presentation.groupCount > 1 || plain(presentation.label).includes(said)) return undefined;
  return summary;
}

/**
 * A row's line as drawn: its label, plus the outcome a plain success or failure doesn't say
 * ("Create Secret · Denied", "Edit Garden · Uncertain"). A fold of one call reads the same words.
 */
export function presentToolRowLabel(
  part: AgentToolPart,
  presentation: AgentToolPresentation = presentAgentTool(part),
  approvalRequired = part.state === "approval-required",
): string {
  const decision = part.approvalDecision ?? (part.approvalId && !approvalRequired
    ? part.state === "denied" ? "denied"
      : part.state === "cancelled" || part.state === "outcome-unknown" ? "withdrawn"
        : part.state === "approved" || part.state === "running" || part.state === "succeeded" ? "approved" : undefined
    : undefined);
  if (part.name === "ExitPlanMode" && decision) {
    return decision === "denied" ? "Kept planning" : decision === "withdrawn" ? "Plan withdrawn" : "Plan started";
  }
  const question = part.name === "AskUserQuestion" || part.native?.requestMethod?.endsWith("/requestUserInput");
  if (question && decision) return decision === "denied" ? "Skipped" : "Answered question";
  const { label } = presentation;
  if (decision === "withdrawn") return `${label} · Withdrawn`;
  if (decision === "denied" || part.state === "denied") return `${label} · Denied`;
  // Stopped while running, as the card's notice says.
  if (part.state === "cancelled") return `${label} · Stopped`;
  // It may or may not have happened: the row says so.
  if (part.state === "outcome-unknown") return `${label} · Uncertain`;
  if (decision === "approved") return `${label} · ${part.approvalScope === "session" ? "Approved for this chat" : "Approved"}`;
  return label;
}

/** A change a row counts went ahead or is going ahead; a failed, declined, stopped or uncertain one counts nothing. */
const COUNTED_CHANGE_STATES: ReadonlySet<AgentToolDisplayState> = new Set<AgentToolDisplayState>(["succeeded", "partial", "input-ready", "approved", "running"]);

/**
 * A vault edit's or write's lines, counted from the diff its card draws ("+1 −1", "+4"). An edit that
 * didn't apply (skipped, or in a note that failed) counts nothing; a regular expression's text isn't
 * the change it makes, so a request with one has no count.
 */
export function hostedChangeSize(canonicalName: string, input: Record<string, unknown>, output: Record<string, unknown>): string | undefined {
  // A write told to keep an existing note ("skip") may have written nothing.
  if (canonicalName === "write") return input.ifExists === "skip" ? undefined : writeChangeSize(input.content);
  if (canonicalName !== "edit" && canonicalName !== "multi_edit") return undefined;
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
  const edits = (canonicalName === "multi_edit" ? list(input.files) : [input]).flatMap((file) => {
    const result = canonicalName === "edit" ? output : list(output.results).find((entry) => entry.path === file.path) ?? {};
    if (result.success === false) return [];
    const skipped = new Set(list(result.skipped).map((entry) => entry.index));
    return list(file.edits).filter((_, index) => !skipped.has(index));
  });
  return edits.some((edit) => edit.isRegex === true) ? undefined : editChangeSize(edits, "oldText", "newText");
}

/** A command's exit status: Codex reports it; Claude Code states "Exit code N" first or last in a failed result. */
function commandExitCode(part: AgentToolPart): number | undefined {
  const reported = record(part.output?.data).exitCode ?? record(part.input).exitCode;
  if (typeof reported === "number") return reported;
  // Only a failed result states it; a successful one's text is the command's own output.
  if (part.state !== "failed") return undefined;
  const output = toolOutputText(part.output?.data).trim();
  const stated = /^(?:Error: )?Exit code (\d+)\b/u.exec(output) ?? /\n(?:Error: )?Exit code (\d+)$/u.exec(output);
  return stated ? Number(stated[1]) : undefined;
}

/**
 * Returns only known, useful tool details. It never exposes raw JSON, file
 * contents, edit text, unknown server input, or provider-owned output data.
 */
export function presentAgentToolDetails(
  part: AgentToolPart,
): readonly AgentToolDetail[] {
  // Native previews own their readable fields; do not apply hosted truncation
  // or interpret provider output as a local vault-tool result.
  if (part.native) return [];
  const { canonicalName } = splitToolName(part.name);
  if (part.location === "server") {
    if (canonicalName !== "web_search") return [];
    const query = webSearchQuery(part);
    // The query is the one thing the row may cut. Its result count is never shown: the public result
    // lists no results (its sources reach the answer's Sources), and a row counts only what its card lists.
    return [
      ...(query ? [{ label: "Query", value: detailValue(query)! }] : []),
    ];
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
  const native = nativeToolPresentation(part);
  if (native) {
    const active = isActiveAgentToolState(part.state) && part.state !== "approval-required";
    const exitCode = native.groupKind === "command" ? commandExitCode(part) : undefined;
    // One meta per kind: a command's exit status when it failed, a plan's progress, an edit's size,
    // a web search's result count. The agent's description of a call is never meta.
    const meta = exitCode ? `exit ${exitCode}` : native.groupKind === "plan" ? native.meta
      : native.resultCount ?? (COUNTED_CHANGE_STATES.has(part.state) ? native.changeSize : undefined);
    const blocked = /(?:^|_)(?:AUTO_BLOCKED|REVIEW_BLOCKED|BLOCKED_BY_REVIEW)(?:_|$)/u.test(part.error?.code ?? "");
    // A command that exited non-zero did run: it says what ran, and its exit status how it ended.
    const ran = part.state === "failed" && Boolean(exitCode);
    const base = part.state === "succeeded" || ran ? native.completedTitle : active ? native.runningTitle : native.title;
    const label = blocked ? `${native.title} · Blocked by ${part.native?.agent === "claude" ? "Claude Code" : "Codex review"}`
      : part.state === "failed" && !ran ? `Couldn't ${native.title.charAt(0).toLowerCase()}${native.title.slice(1)}` : base;
    return {
      canonicalName: part.name, label,
      actionIcon: native.icon,
      displayState: part.state,
      icon: blocked ? "shield-x" : gatedSystemSculptCall(part) ? "lock" : refusedSystemSculptCall(part) ? "x" : STATE_ICONS[part.state],
      summary: null,
      meta, targetPath: native.targetPath,
      groupKind: native.groupKind, groupCount: native.groupCount,
      ...(native.groupItems ? { groupItems: native.groupItems } : {}),
      ...(native.target ? { target: native.target } : {}),
      ...(exitCode ? { exitCode } : {}),
      ...(native.gate ? { gate: native.gate } : {}),
    };
  }
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
  // The input repeats what the label names (a note, a pattern), so it's never meta; pinning names no note.
  const summary = serverTool
    ? null
    : partialSummary ?? outputSummary ?? (canonicalName === "context" ? inputSummary(canonicalName, input) : null);
  const presentedName = unknownServerTool ? "server_action" : canonicalName;
  const labelState = actionState(displayState);
  const paths = canonicalName === "multi_edit" || canonicalName === "open" ? objectStrings(input.files, "path")
    : [...strings(input.paths), ...strings(input.path)];
  const targetPath = !serverTool && VAULT_TOOLS_WITH_SAFE_DETAILS.has(canonicalName) && paths.length === 1 ? paths[0] : undefined;
  // A note is named as Obsidian names it ("Garden"); an approval keeps the file name its card links.
  const named = (path: string): string => part.state === "approval-required" ? path : noteDisplayName(path);
  const fileName = targetPath?.split(/[\\/]/u).filter(Boolean).pop();
  const target = fileName ? named(fileName) : undefined;
  const folder = canonicalName === "list_items" && targetPath && !/^[\\/.]*$/u.test(targetPath) ? targetPath : undefined;
  const sources = objectStrings(input.items, "source"), destinations = objectStrings(input.items, "destination");
  const moved = canonicalName === "move" && sources.length === 1 && destinations.length === 1 ? named(sources[0].split(/[\\/]/u).pop()!) : undefined;
  const pattern = firstString(input.patterns) ?? firstString(input.query) ?? firstString(input.pattern);
  const workflow = STUDIO_VERBS[canonicalName] && firstString(input.path) ? studioWorkflowName(firstString(input.path)!) : undefined;
  // A partly finished batch says how many of its notes it reached, never the whole request.
  const noteCount = displayState === "partial" && paths.length > 1 ? `${outcomeCounts.completed} of ${paths.length}` : `${paths.length}`;
  const baseLabel = canonicalName === "context" ? contextToolLabel(input)
    : canonicalName === "read" ? (target ? `Read ${target}` : `Read ${paths.length ? noteCount : ""} notes`.replace("  ", " "))
      : canonicalName === "write" ? `Create ${target ?? "file"}`
        : canonicalName === "edit" ? `Edit ${target ?? "file"}`
          : canonicalName === "multi_edit" ? `Edit ${target ?? `${noteCount} notes`}`
            // "Listed the Notes folder": a folder named beside a note count ("read 2 notes") still reads as a folder.
            : canonicalName === "list_items" ? `List ${folder ? `the ${folder} folder` : counted && counted.items.length > 1 ? `${counted.items.length} folders` : "the vault"}`
              : canonicalName === "create_folders" ? `Create ${targetPath ?? `${noteCount} folders`}`
                : canonicalName === "trash" ? `Move ${target ?? `${noteCount} notes`} to trash`
                  : canonicalName === "move" ? (() => {
                    if (!moved) return `Move ${sources.length || ""} notes`.replace("  ", " ");
                    // Same name, new folder: name the folder, so the title never breaks a path in two.
                    const name = sources[0].split(/[\\/]/u).pop()!, slash = destinations[0].search(/[\\/][^\\/]*$/u);
                    if (destinations[0].slice(slash + 1) !== name) return `Move ${moved} → ${named(destinations[0])}`;
                    return `Move ${moved} to ${slash > 0 ? destinations[0].slice(0, slash) : "the vault root"}`;
                  })()
                  : canonicalName === "find" || canonicalName === "search"
                    ? counted && counted.items.length > 1 ? countedLabel(counted, "base") : `Search “${pattern ?? "your vault"}”`
                    : canonicalName === "generate_image" ? `${editsImages(input) ? "Edit" : "Generate"} ${imageCountTarget(part, input)}`
                    : workflow ? `${STUDIO_VERBS[canonicalName]} ${workflow} workflow`
                    : counted ? countedLabel(counted, "base") : TOOL_LABELS[canonicalName] ?? `Use ${canonicalName || "tool"}`;
  const query = webSearchQuery(part);
  const gateNeed = gatedSystemSculptCall(part);
  // A server tool's own name can be internal (a provider's, a protocol's), so one without a label of
  // its own is never named from it: it stays a SystemSculpt action.
  const label = serverTool ? actionLabel(query ? `Search the web for “${query}”` : serverLabel ?? UNKNOWN_SERVER_TOOL_LABEL, labelState)
    : gateNeed ? `${baseLabel} · ${gateNeed}`
    : displayState === "failed" || refusedSystemSculptCall(part) ? `Couldn't ${baseLabel.charAt(0).toLowerCase()}${baseLabel.slice(1)}` : actionLabel(baseLabel, labelState);
  const targetText = serverTool ? (query ? `“${query}”` : undefined)
    : canonicalName === "list_items" ? folder
      : canonicalName === "create_folders" ? targetPath
        : canonicalName === "move" ? moved
          : canonicalName === "find" || canonicalName === "search" ? (counted && counted.items.length > 1 || !pattern ? undefined : `“${pattern}”`)
            : workflow ?? target;
  const output = record(part.output?.data);
  // A search counts only results its card lists: a vault search's matches. A SystemSculpt web search's
  // public result lists none, so it shows no count.
  const resultCount = serverTool ? undefined
    : typeof output.totalMatches === "number" ? output.totalMatches
      : Array.isArray(output.matches) ? output.matches.length : undefined;
  // An edit or write row counts the lines its card draws, as Claude Code's and Codex's rows do.
  const changeSize = !serverTool && COUNTED_CHANGE_STATES.has(displayState) ? hostedChangeSize(canonicalName, input, output) : undefined;
  return {
    canonicalName: presentedName, label,
    actionIcon: TOOL_ACTION_ICONS[presentedName] ?? "wrench",
    displayState,
    // A gate (subscription, credits) is a lock, a refusal an x: never a check beside "Couldn't".
    icon: gateNeed ? "lock" : refusedSystemSculptCall(part) ? "x" : STATE_ICONS[displayState],
    summary,
    ...(partialSummary && summary === partialSummary ? { summaryCountsOutcomes: true as const } : {}),
    ...(resultCount !== undefined ? { meta: `${resultCount} result${resultCount === 1 ? "" : "s"}` } : changeSize ? { meta: changeSize } : {}),
    // A Studio row names its workflow, and that name opens it as a note's does.
    ...(targetPath ?? (workflow ? firstString(input.path) : undefined) ? { targetPath: targetPath ?? firstString(input.path)! } : {}),
    groupKind: canonicalName === "multi_edit" ? "edit" : canonicalName === "find" ? "search" : canonicalName === "list_items" ? "list"
      : canonicalName === "web_search" ? "web-search" : presentedName,
    groupCount: serverTool ? 1 : counted?.items.length ?? Math.max(paths.length, 1),
    ...(!serverTool && PATH_GROUP_TOOLS.has(canonicalName) && paths.length ? { groupItems: paths } : {}),
    ...(targetText ? { target: { text: targetText } } : {}),
    ...(gateNeed ? { gate: { subject: baseLabel.slice(baseLabel.indexOf(" ") + 1), need: gateNeed.replace(/^Needs /u, "") } } : {}),
  };
}
