import type { AgentPart, AgentToolPart } from "../../chat/ChatConversation";
import { isActiveAgentToolState } from "./AgentConversationPresentation";
import {
  gatedSystemSculptTurn,
  labelTargetClass,
  presentAgentTool,
  presentToolRowLabel,
  refusedSystemSculptCall,
  type LabelTarget,
} from "./AgentToolPresentation";

/** refused: a SystemSculpt tool did nothing; not a failure, but not done either. gated: it needs a plan or credits. */
/** denied: the person declined an action, so the turn is not marked done with a check. */
export type AgentActivitySummary = Readonly<{ label: string; failedCount: number; refused?: true; gated?: true; denied?: true }>;

/** rows: how many activity rows the group stands for; "N more" counts rows, as the person sees them. */
/** names: the distinct row labels in the group; target: the words its one row's label sets apart. */
type ActivityGroup = { label: string; items: Set<string>; uncounted: number; rows: number; names: Set<string>; target?: LabelTarget };

const groupSize = (group: ActivityGroup): number => group.items.size + group.uncounted;

/** What didn't happen as asked, counted after the clauses ("· 1 denied"), in this order. */
const OUTCOME_WORDS = ["failed", "blocked", "uncertain", "denied", "stopped", "withdrawn"] as const;
type OutcomeWord = typeof OUTCOME_WORDS[number];

/**
 * The words of each summary that name a target (a note, a command, a query), so the label is
 * drawn with them set apart while staying plain text everywhere else. Only summaries on screen
 * matter; the oldest are forgotten first.
 */
const summaryTargets = new Map<string, readonly LabelTarget[]>();
function rememberTargets(label: string, targets: readonly LabelTarget[]): void {
  summaryTargets.delete(label);
  if (!targets.length) return;
  summaryTargets.set(label, targets);
  if (summaryTargets.size > 200) summaryTargets.delete(summaryTargets.keys().next().value!);
}

/** "· 2 failed" never strands its dot at a line end. */
export function unbreakableActivityLabel(label: string): string {
  return label.replace(/ · /gu, " ·\u00a0");
}

/**
 * Writes a summary so that a count and its word ("5 more", "1 blocked") wrap as one unit, a
 * command reads in the code font and a short name never breaks; the text itself is unchanged.
 */
export function setActivityLabelText(element: HTMLElement, label: string): void {
  if (element.textContent === label && element.dataset.activityLabel === label) return;
  element.replaceChildren();
  element.dataset.activityLabel = label;
  const appendCounts = (text: string): void => {
    let last = 0;
    for (const match of text.matchAll(/\d+(?: of \d+)? \p{L}+/gu)) {
      const at = match.index ?? 0;
      if (at > last) element.appendText(text.slice(last, at));
      element.createSpan({ cls: "ss-activity-count", text: match[0] });
      last = at + match[0].length;
    }
    if (last < text.length) element.appendText(text.slice(last));
  };
  let cursor = 0;
  for (const target of summaryTargets.get(label.replace(/ ·\u00a0/gu, " · ")) ?? []) {
    const at = label.indexOf(target.text, cursor);
    if (at < 0) continue;
    appendCounts(label.slice(cursor, at));
    element.createSpan({ cls: labelTargetClass(target), text: target.text });
    cursor = at + target.text.length;
  }
  appendCounts(label.slice(cursor));
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** One clause per group: its one row's label, or a count ("Ran 3 commands", "Used 3 tools"). */
function clause(kind: string, group: ActivityGroup): string {
  const count = groupSize(group);
  if (kind.startsWith("gated:")) {
    if (count === 1) return group.label;
    // "2 images need credits" when every one is the same kind of thing, else "2 actions need credits".
    const need = kind.slice("gated:".length), only = group.names.size === 1 ? [...group.names][0] : "";
    const subject = only.endsWith(` needs ${need}`) ? only.slice(0, -` needs ${need}`.length) : "";
    return `${count} ${/^\p{L}+$/u.test(subject) ? `${subject.toLowerCase()}s` : "actions"} need ${need}`;
  }
  if (kind.startsWith("failed:")) return count === 1 ? group.label : `Couldn't complete ${count} actions`;
  if (kind === "partial") return count === 1 ? group.label : `${count} actions partly done`;
  if (kind === "command") return count === 1 ? group.label : `Ran ${count} commands`;
  if (kind === "reasoning") return "Thought";
  // The same tool twice is one tool used twice; different tools count as tools.
  if (kind === "tool") {
    if (group.rows === 1) return group.label;
    return group.names.size === 1 ? `${group.label} ${group.rows === 2 ? "twice" : `${group.rows} times`}` : `Used ${group.names.size} tools`;
  }
  if (count === 1) return group.label;
  const counts: Record<string, string> = {
    read: `Read ${count} notes`, edit: `Edited ${count} notes`, write: `Created ${count} notes`,
    trash: `Moved ${count} notes to trash`, list: `Listed ${count} folders`,
    search: `Searched for ${count} patterns`, find: `Found files matching ${count} patterns`,
    "web-search": `Searched the web ${count} times`, web: `Read ${count} web pages`,
  };
  return counts[kind] ?? group.label;
}

/** Count adjacent activity by action without repeating payloads or full paths. */
export function summarizeAgentActivity(parts: readonly AgentPart[]): AgentActivitySummary {
  const groups = new Map<string, ActivityGroup>();
  let failedCount = 0, refused = false, gated = false, denied = false, thought = false;
  const outcomes: OutcomeWord[] = [];
  const tools: AgentToolPart[] = [];
  const add = (kind: string, label: string, options: { items?: readonly string[]; count?: number; target?: LabelTarget } = {}): void => {
    const group = groups.get(kind) ?? { label, items: new Set<string>(), uncounted: 0, rows: 0, names: new Set<string>() };
    group.label = label;
    group.rows += 1;
    group.names.add(label);
    group.target = options.target;
    if (options.items?.length) for (const item of options.items) group.items.add(item);
    else group.uncounted += options.count ?? 1;
    groups.set(kind, group);
  };
  for (const part of parts) {
    if (part.kind === "reasoning") {
      thought = true;
      add("reasoning", "Thought");
    } else if (part.kind === "tool") {
      tools.push(part);
      const tool = presentAgentTool(part);
      const state = tool.displayState;
      const refusal = refusedSystemSculptCall(part) && !gatedSystemSculptTurn(part);
      if (refusedSystemSculptCall(part)) refused = true;
      if (gatedSystemSculptTurn(part)) gated = true;
      // Only completed or in-progress work counts toward "Edited 2 notes", and each note once.
      // What didn't happen as asked (a denial, a withdrawn request that never ran, a stop, a
      // guard's block, an unknown result) is counted after the clauses in its own word.
      if (state === "denied") { denied = true; outcomes.push("denied"); }
      else if (part.approvalDecision === "withdrawn" || state === "cancelled" && part.approvalId && !part.approvalDecision) outcomes.push("withdrawn");
      else if (state === "cancelled") outcomes.push("stopped");
      else if (tool.icon === "shield-x") outcomes.push("blocked");
      else if (state === "outcome-unknown") outcomes.push("uncertain");
      // A gate names what it stopped and what that needs: "Image needs a subscription".
      else if (tool.gate) {
        const { subject, need } = tool.gate;
        add(`gated:${need}`, `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${/^(?!1 )\d+ /u.test(subject) ? "need" : "needs"} ${need}`);
      }
      // A command that exited non-zero ran; it counts with the others ("Ran 3 commands · 1 failed").
      else if (state === "failed" && tool.exitCode !== undefined) {
        add(tool.groupKind, tool.label, { count: tool.groupCount, target: tool.target });
        outcomes.push("failed");
      }
      else if (state === "failed" || refusal) add(`failed:${tool.groupKind}`, tool.label, { target: tool.target });
      // A partly done batch says how far it got ("Moved 1 of 2 notes to trash"), never the whole request.
      else if (state === "partial") add("partial", tool.label, { target: tool.target });
      // Any other tool (a server's, an unknown one) counts as a tool: "Used 2 tools", "Used weather forecast twice".
      // A running call's "…" doesn't belong mid-sentence; a long command's own "…" stays.
      else add(/^(?:mcp|unknown):|^server_action$/u.test(tool.groupKind) ? "tool" : tool.groupKind,
        isActiveAgentToolState(part.state) ? tool.label.replace(/…$/u, "") : tool.label,
        { items: tool.groupItems, count: tool.groupCount, target: tool.target });
      if (part.approvalDecision !== "withdrawn" && (refusal || ["failed", "partial", "outcome-unknown"].includes(state))) failedCount += 1;
    }
  }
  const kinds = Array.from(groups.keys());
  const labels = kinds.map(kind => clause(kind, groups.get(kind)!));
  // Two groups that read the same are one clause.
  const shown = labels.filter((label, index) => labels.indexOf(label) === index).slice(0, 3);
  const visible = kinds.filter((_, index) => shown.includes(labels[index]));
  const hidden = kinds.filter(kind => !visible.includes(kind));
  // A failure its own clause names ("Couldn't read Missing") isn't counted again; one folded into "N more" is.
  for (const kind of hidden) if (kind.startsWith("failed:") || kind === "partial") outcomes.push(...Array<OutcomeWord>(groups.get(kind)!.rows).fill("failed"));
  const more = hidden.reduce((count, kind) => count + groups.get(kind)!.rows, 0);
  const tallies = OUTCOME_WORDS.map(word => [outcomes.filter(outcome => outcome === word).length, word] as const)
    .filter(([count]) => count).map(([count, word]) => `${count} ${word}`);
  let label: string;
  let targets: LabelTarget[] = [];
  if (tools.length === 1 && !thought) {
    // A fold of one call is that call's row: the same words, outcome included.
    const tool = presentAgentTool(tools[0]);
    label = presentToolRowLabel(tools[0], tool);
    if (tool.target) targets = [tool.target];
  } else if (!shown.length) {
    // Nothing went ahead: one kind of outcome is the sentence ("Denied 2 actions"), several are counted.
    const words = OUTCOME_WORDS.filter(word => outcomes.includes(word));
    const actions = `${outcomes.length} action${outcomes.length === 1 ? "" : "s"}`;
    label = !words.length ? "Activity"
      : words.length > 1 ? [actions, ...tallies].join(" · ")
        : words[0] === "denied" ? `Denied ${actions}` : words[0] === "stopped" ? `Stopped ${actions}` : `${actions} ${words[0]}`;
  } else {
    label = [shown.map((text, index) => index ? lowerFirst(text) : text).join(", "), ...(more ? [`${more} more`] : []), ...tallies].join(" · ");
    targets = visible.flatMap(kind => {
      const group = groups.get(kind)!;
      return group.target && clause(kind, group) === group.label ? [group.target] : [];
    });
  }
  rememberTargets(label, targets);
  return {
    label,
    failedCount,
    ...(refused ? { refused: true as const } : {}),
    ...(gated ? { gated: true as const } : {}),
    ...(denied ? { denied: true as const } : {}),
  };
}

type AgentActivitySequence<T> = Readonly<{
  kind: "activity";
  items: readonly T[];
}>;

export type AgentActivityTimelineEntry<T> =
  | Readonly<{ kind: "item"; item: T }>
  | AgentActivitySequence<T>;

/**
 * Groups only adjacent reasoning and tool rows. Text and errors remain in
 * exact chronology and split the inner overflow group.
 */
export function groupAdjacentAgentActivity<T>(
  items: readonly T[],
  isActivity: (item: T) => boolean,
): readonly AgentActivityTimelineEntry<T>[] {
  const timeline: AgentActivityTimelineEntry<T>[] = [];
  let activeItems: T[] | null = null;
  for (const item of items) {
    if (!isActivity(item)) {
      activeItems = null;
      timeline.push({ kind: "item", item });
      continue;
    }
    if (activeItems) {
      activeItems.push(item);
      continue;
    }
    activeItems = [item];
    timeline.push({ kind: "activity", items: activeItems });
  }
  return timeline;
}

/** Keeps the newest activity row visible and places older rows in one fold. */
export function splitPreviousAgentActivity<T>(
  items: readonly T[],
): Readonly<{ previous: readonly T[]; latest: T | null }> {
  return {
    previous: items.slice(0, -1),
    latest: items[items.length - 1] ?? null,
  };
}

export function isAgentActivityPart(part: AgentPart): boolean {
  return part.kind === "reasoning" || part.kind === "tool";
}

export type AgentTurnEnvelopePart = Readonly<{
  id: string;
  messageId: string;
  kind: "activity" | "content" | "sources";
  visible: boolean;
}>;

/**
 * Keeps the terminal answer run and explicit Sources outside the work fold.
 * Trailing activity cannot pull the final answer back into Worked, while an
 * earlier content run still stops at its following activity or message edge.
 */
export function finalAgentAnswerPartIds(
  parts: readonly AgentTurnEnvelopePart[],
): ReadonlySet<string> {
  const visibleParts = parts.filter((part) => part.visible);
  const selected = new Set(visibleParts
    .filter((part) => part.kind === "sources")
    .map((part) => part.id));
  let terminalMessageId: string | null = null;
  for (let index = visibleParts.length - 1; index >= 0; index -= 1) {
    const part = visibleParts[index];
    if (part.kind === "sources") continue;
    if (terminalMessageId === null) {
      if (part.kind === "activity") continue;
      terminalMessageId = part.messageId;
      selected.add(part.id);
      continue;
    }
    if (part.kind !== "content" || part.messageId !== terminalMessageId) break;
    selected.add(part.id);
  }
  return new Set(visibleParts.filter((part) => selected.has(part.id)).map((part) => part.id));
}

export function formatAgentActivityDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

/** Live T3 timer: whole elapsed seconds, with compact minute and hour forms. */
export function formatAgentWorkingDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const elapsedSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
