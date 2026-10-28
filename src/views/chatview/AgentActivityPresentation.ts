import type { AgentPart } from "../../chat/ChatConversation";
import { presentAgentTool } from "./AgentToolPresentation";

export type AgentActivitySummary = Readonly<{ label: string; failedCount: number }>;

type ActivityGroup = { label: string; items: Set<string>; uncounted: number };

const groupSize = (group: ActivityGroup): number => group.items.size + group.uncounted;

/** Count adjacent activity by action without repeating payloads or full paths. */
export function summarizeAgentActivity(parts: readonly AgentPart[]): AgentActivitySummary {
  const groups = new Map<string, ActivityGroup>();
  let failedCount = 0;
  const add = (kind: string, label: string, items: readonly string[] = [], count = 1): void => {
    const group = groups.get(kind) ?? { label, items: new Set<string>(), uncounted: 0 };
    group.label = label;
    if (items.length) for (const item of items) group.items.add(item);
    else group.uncounted += count;
    groups.set(kind, group);
  };
  for (const part of parts) {
    if (part.kind === "reasoning") {
      add("reasoning", "Thought");
    } else if (part.kind === "tool") {
      const tool = presentAgentTool(part);
      // Only completed or in-progress work counts toward "Edited 2 notes", and
      // each note once. Denials are decisions, withdrawn requests never ran and
      // failed or uncertain actions aren't completed changes: each keeps its
      // own clause, and a withdrawn request is not a failure.
      if (tool.displayState === "denied") add("denied", `${tool.label} · Denied`);
      else if (tool.displayState === "cancelled" || part.approvalDecision === "withdrawn") add("withdrawn", `${tool.label} · Withdrawn`);
      else if (tool.displayState === "failed" || tool.displayState === "outcome-unknown") add("failed", tool.label);
      else add(tool.groupKind, tool.label.replace(/…$/u, ""), tool.groupItems, tool.groupCount);
      if (part.approvalDecision !== "withdrawn" && ["failed", "partial", "outcome-unknown"].includes(tool.displayState)) failedCount += 1;
    }
  }
  const labels = Array.from(groups, ([kind, group]) => {
    const count = groupSize(group);
    if (kind === "denied") return count === 1 ? group.label : `Denied ${count} actions`;
    if (kind === "withdrawn") return count === 1 ? group.label : `${count} actions withdrawn`;
    if (kind === "failed") return count === 1 ? group.label : `Couldn't complete ${count} actions`;
    // One read names its note (spec 3.2: "Read Plan.md, searched 2 patterns").
    if (kind === "read") return count === 1 ? group.label : `Read ${count} notes`;
    if (kind === "search") return `Searched ${count} pattern${count === 1 ? "" : "s"}`;
    if (kind === "command") return `Ran ${count} command${count === 1 ? "" : "s"}`;
    if (kind === "reasoning") return "Thought";
    if (count > 1 && ["edit", "write", "trash", "list", "web-search"].includes(kind)) {
      const [verb, noun] = kind === "edit" ? ["Edited", "notes"] : kind === "write" ? ["Created", "notes"]
        : kind === "trash" ? ["Trashed", "notes"] : kind === "list" ? ["Listed", "folders"] : ["Searched", "web queries"];
      return `${verb} ${count} ${noun}`;
    }
    return group.label;
  });
  const visible = labels.slice(0, 3).map((label, index) => index ? label.charAt(0).toLowerCase() + label.slice(1) : label).join(", ");
  const more = Array.from(groups.values()).slice(3).reduce((count, group) => count + groupSize(group), 0);
  return {
    label: `${visible || "Activity"}${more ? ` · ${more} more` : ""}${failedCount ? ` · ${failedCount} failed` : ""}`,
    failedCount,
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
