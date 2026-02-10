import type { ToolCall, ToolCallState } from "../types/toolCalls";
import { formatToolDisplayName, getFunctionDataFromToolCall } from "./toolDisplay";
import { extractPrimaryPathArg, isMutatingTool, splitToolName } from "./toolPolicy";

export type ToolCallRiskLevel = "read" | "destructive";

export interface ToolCallSummaryRow {
  label: string;
  detail: string;
  allowAggregation: boolean;
}

export interface ToolCallChangeDetail {
  kind: "operations" | "diff" | "generic";
  title: string;
  lines?: string[];
}

export interface ToolCallNarrative {
  summary: ToolCallSummaryRow;
  statusText: string;
  riskLevel: ToolCallRiskLevel;
  changeDetails?: ToolCallChangeDetail[];
}

export function getToolCallStatusText(state: ToolCallState | undefined): string {
  switch (state) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "executing":
      return "Running";
    default:
      return "";
  }
}

export function buildToolCallNarrative(toolCall: ToolCall): ToolCallNarrative {
  const fn = getFunctionDataFromToolCall(toolCall);
  const statusText = getToolCallStatusText(toolCall.state);

  if (!fn) {
    return {
      summary: {
        label: "Tool",
        detail: "call",
        allowAggregation: false,
      },
      statusText,
      riskLevel: "read",
    };
  }

  const { canonicalName } = splitToolName(fn.name);
  const args = (fn.arguments ?? {}) as Record<string, unknown>;
  const riskLevel: ToolCallRiskLevel = isMutatingTool(fn.name) ? "destructive" : "read";

  if (canonicalName === "list_items") {
    const detail = describeBrowseDetail(args);
    return {
      summary: { label: "Browsed", detail, allowAggregation: true },
      statusText,
      riskLevel,
    };
  }

  if (/(^|_)(search|find)/.test(canonicalName)) {
    const detail = describeSearchDetail(args);
    return {
      summary: { label: "Searched", detail, allowAggregation: true },
      statusText,
      riskLevel,
    };
  }

  if (/^read/.test(canonicalName)) {
    const detail = describeReadDetail(args);
    return {
      summary: { label: "Read", detail, allowAggregation: true },
      statusText,
      riskLevel,
    };
  }

  if (canonicalName === "write") {
    const ifExists = String(args.ifExists ?? "").toLowerCase();
    const label = ifExists === "append" ? "Appending to file" : "Writing file";
    const detail = hybridPath(String(args.path ?? "file"));
    return {
      summary: { label, detail, allowAggregation: false },
      statusText,
      riskLevel,
    };
  }

  if (canonicalName === "edit") {
    const path = hybridPath(String(args.path ?? "file"));
    const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
    const detail = editCount > 0
      ? `${path} (${editCount} change block${editCount === 1 ? "" : "s"})`
      : path;
    return {
      summary: { label: "Editing file", detail, allowAggregation: false },
      statusText,
      riskLevel,
    };
  }

  if (canonicalName === "move") {
    const detail = describeMoveDetail(args);
    return {
      summary: { label: "Moving", detail, allowAggregation: false },
      statusText,
      riskLevel,
    };
  }

  if (canonicalName === "trash" || canonicalName === "delete") {
    const detail = describeTrashDetail(args);
    return {
      summary: { label: "Moving to trash", detail, allowAggregation: false },
      statusText,
      riskLevel,
    };
  }

  if (canonicalName === "rename") {
    const detail = describeRenameDetail(args);
    return {
      summary: { label: "Renaming", detail, allowAggregation: false },
      statusText,
      riskLevel,
    };
  }

  const primaryPath = extractPrimaryPathArg(fn.name, args);
  const fallbackDetail = primaryPath ? hybridPath(primaryPath) : describeGenericArguments(args);
  return {
    summary: {
      label: normalizeSingleLine(formatToolDisplayName(fn.name)),
      detail: fallbackDetail,
      allowAggregation: !isMutatingTool(fn.name),
    },
    statusText,
    riskLevel,
  };
}

function describeBrowseDetail(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : null;
  if (path) {
    return hybridPath(path);
  }
  const paths = normalizeStringArray(args.paths);
  if (paths.length > 0) {
    return paths.map((p) => hybridPath(p)).join(", ");
  }
  return "folder";
}

function describeSearchDetail(args: Record<string, unknown>): string {
  const terms = extractSearchTerms(args);
  const summary = terms.length > 0 ? terms.join(", ") : "query";
  const location = extractSearchLocation(args);
  if (location) {
    return `${limitText(summary, 160)} in ${location}`;
  }
  return limitText(summary, 160);
}

function describeReadDetail(args: Record<string, unknown>): string {
  const paths = normalizeStringArray(args.paths);
  if (typeof args.path === "string" && !paths.includes(args.path)) {
    paths.push(args.path);
  }
  if (paths.length === 0) {
    return "file";
  }
  return paths.map((path) => hybridPath(path)).join(", ");
}

function describeMoveDetail(args: Record<string, unknown>): string {
  const pairs = extractMovePairs(args);
  if (pairs.length === 0) {
    const destination = String(args.destination ?? args.target ?? args.to ?? "destination");
    return `to ${hybridPath(destination)}`;
  }

  if (pairs.length === 1) {
    return `${hybridPath(pairs[0].source)} -> ${hybridPath(pairs[0].destination)}`;
  }

  return `${hybridPath(pairs[0].source)} -> ${hybridPath(pairs[0].destination)} (+${pairs.length - 1} more)`;
}

function describeTrashDetail(args: Record<string, unknown>): string {
  const paths = dedupe(normalizeStringArray(args.paths).map((path) => hybridPath(path)));
  if (paths.length === 0) {
    return "item";
  }
  if (paths.length <= 2) {
    return paths.join(", ");
  }
  return `${paths.slice(0, 2).join(", ")} (+${paths.length - 2} more)`;
}

function describeRenameDetail(args: Record<string, unknown>): string {
  const source = hybridPath(String(args.from ?? args.source ?? "item"));
  const target = hybridPath(String(args.to ?? args.target ?? "target"));
  return `${source} -> ${target}`;
}

function extractMovePairs(args: Record<string, unknown>): Array<{ source: string; destination: string }> {
  const destinationFallback = typeof args.destination === "string"
    ? args.destination
    : typeof args.target === "string"
      ? args.target
      : typeof args.to === "string"
        ? args.to
        : typeof args.targetPath === "string"
          ? args.targetPath
          : "";

  const pairs: Array<{ source: string; destination: string }> = [];
  const rawItems = Array.isArray(args.items) ? args.items : [];
  for (const raw of rawItems) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const source = typeof item.source === "string"
      ? item.source
      : typeof item.path === "string"
        ? item.path
        : typeof item.from === "string"
          ? item.from
          : "";
    const destination = typeof item.destination === "string"
      ? item.destination
      : destinationFallback;
    if (!source || !destination) continue;
    pairs.push({ source, destination });
  }

  if (pairs.length === 0 && Array.isArray(args.paths) && destinationFallback) {
    for (const path of normalizeStringArray(args.paths)) {
      pairs.push({ source: path, destination: destinationFallback });
    }
  }

  const seen = new Set<string>();
  return pairs.filter((pair) => {
    const key = `${pair.source}\u0000${pair.destination}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeGenericArguments(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") {
    return "";
  }

  const entries: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entries.push(`${key}: ${limitText(String(value), 50)}`);
    } else if (Array.isArray(value) && value.length > 0) {
      const printable = value
        .slice(0, 3)
        .map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : "…"))
        .join(", ");
      entries.push(`${key}: ${limitText(printable, 50)}`);
    }
    if (entries.length >= 2) break;
  }

  return normalizeSingleLine(entries.join(" | "));
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(value);
  }
  return results;
}

function extractSearchTerms(args: Record<string, unknown>): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const addTerm = (value: string) => {
    const normalized = normalizeSingleLine(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(limitText(normalized, 80));
  };

  const addMany = (source: unknown) => {
    for (const entry of normalizeStringArray(source)) {
      addTerm(entry);
    }
  };

  addMany(args.patterns);
  addMany(args.queries);
  addMany(args.terms);
  addMany(args.keywords);
  addMany(args.searchTerms);

  if (typeof args.query === "string") {
    parseSearchString(args.query, addTerm);
  }
  if (typeof args.text === "string") {
    parseSearchString(args.text, addTerm);
  }
  if (typeof args.term === "string") {
    parseSearchString(args.term, addTerm);
  }

  return terms;
}

function parseSearchString(raw: string, addTerm: (term: string) => void): void {
  const trimmed = normalizeSingleLine(raw);
  if (!trimmed) return;

  const colonSplit = trimmed
    .split(/:+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (colonSplit.length > 1) {
    for (const segment of colonSplit) {
      addTerm(segment);
    }
    return;
  }

  const commaSplit = trimmed
    .split(/[\n\r,;]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (commaSplit.length > 1) {
    for (const segment of commaSplit) {
      addTerm(segment);
    }
    return;
  }

  addTerm(trimmed);
}

function extractSearchLocation(args: Record<string, unknown>): string | null {
  const candidateKeys = [
    "path",
    "paths",
    "root",
    "roots",
    "directory",
    "directories",
    "folder",
    "folders",
    "within",
    "scope",
    "scopes",
    "searchRoot",
    "searchRoots",
    "searchPath",
    "searchPaths",
    "location",
    "locations",
    "target",
    "targets",
  ];

  const seen = new Set<string>();
  const values: string[] = [];

  const addCandidate = (value: unknown): void => {
    if (!value) return;

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      values.push(hybridPath(trimmed));
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        addCandidate(entry);
      }
      return;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.path === "string") {
        addCandidate(obj.path);
      }
      if (Array.isArray(obj.paths)) {
        addCandidate(obj.paths);
      }
    }
  };

  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      addCandidate((args as Record<string, unknown>)[key]);
    }
  }

  if (values.length === 0) {
    return null;
  }

  const display = values.length > 3
    ? `${values.slice(0, 3).join(", ")}…`
    : values.join(", ");
  return limitText(display, 120);
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function limitText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function hybridPath(path: string): string {
  const normalized = String(path ?? "").replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 2) {
    return segments.join("/") || normalized;
  }
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}
