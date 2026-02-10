import { App, TFile } from "obsidian";
import type { ToolCall } from "../types/toolCalls";
import { getFunctionDataFromToolCall } from "./toolDisplay";
import { extractPrimaryPathArg, splitToolName } from "./toolPolicy";
import { generateDiff, DiffResult } from "./diffUtils";

export interface WriteEditPreview {
  path: string;
  oldContent: string;
  newContent: string;
  diff: DiffResult;
}

export function isWriteOrEditTool(toolName: string): boolean {
  const { canonicalName } = splitToolName(toolName);
  return canonicalName === "write" || canonicalName === "edit";
}

export async function prepareWriteEditPreview(app: App, toolCall: ToolCall): Promise<WriteEditPreview | null> {
  const fn = getFunctionDataFromToolCall(toolCall);
  if (!fn) return null;
  if (!isWriteOrEditTool(fn.name)) return null;

  const path = extractPrimaryPathArg(fn.name, fn.arguments);
  if (!path) return null;

  let oldContent = "";
  const file = app.vault.getAbstractFileByPath(path);
  if (file && file instanceof TFile) {
    try {
      oldContent = await app.vault.read(file);
    } catch {}
  }

  let newContent = "";
  const { canonicalName: base } = splitToolName(fn.name);
  if (base === "write") {
    newContent = String((fn.arguments as any).content ?? "");
  } else if (base === "edit") {
    const edits = Array.isArray((fn.arguments as any).edits) ? (fn.arguments as any).edits : [];
    newContent = applyEditsLocally(oldContent, edits);
  }

  const diff = generateDiff(oldContent ?? "", newContent ?? "", 5);
  return { path, oldContent, newContent, diff };
}

export type ToolEditOccurrence = "first" | "last" | "all";
export type ToolEditMode = "exact" | "loose";
export type ToolEditRange = {
  startLine?: number | null;
  endLine?: number | null;
  startIndex?: number | null;
  endIndex?: number | null;
};
export type ToolFileEdit = {
  oldText: string;
  newText: string;
  isRegex?: boolean | null;
  flags?: string | null;
  occurrence?: ToolEditOccurrence | null;
  mode?: ToolEditMode | null;
  range?: ToolEditRange | null;
  preserveIndent?: boolean | null;
};

export function applyEditsLocally(original: string, edits: ToolFileEdit[]): string {
  let result = original.replace(/\r\n/g, "\n");
  for (const edit of edits) {
    try {
      result = applySingleEditPreview(result, edit);
    } catch {
      // Best-effort preview: ignore failures
    }
  }
  return result;
}

function applySingleEditPreview(source: string, edit: ToolFileEdit): string {
  const text = source;
  const mode = edit.mode || "exact";
  const preserveIndent = edit.preserveIndent !== false;
  const { sliceStart, sliceEnd } = computeRange(text, edit.range);
  const head = text.slice(0, sliceStart);
  const target = text.slice(sliceStart, sliceEnd);
  const tail = text.slice(sliceEnd);

  const oldText = String(edit.oldText ?? "").replace(/\r\n/g, "\n");
  const newText = String(edit.newText ?? "").replace(/\r\n/g, "\n");
  const occurrence = (edit.occurrence ?? "first") as ToolEditOccurrence;

  let replaced = target;
  if (edit.isRegex) {
    const flags = edit.flags || "g";
    const regex = new RegExp(oldText, flags.includes("g") ? flags : flags + "g");
    replaced = replaceByOccurrenceRegex(target, regex, newText, occurrence);
  } else if (mode === "exact") {
    replaced = replaceByOccurrenceString(target, oldText, newText, occurrence);
  } else {
    replaced = replaceLoose(target, oldText, newText, preserveIndent, occurrence);
  }

  return head + replaced + tail;
}

function computeRange(text: string, range?: ToolEditRange | null): { sliceStart: number; sliceEnd: number } {
  const totalLength = text.length;
  if (!range) return { sliceStart: 0, sliceEnd: totalLength };
  if (typeof range.startIndex === "number" || typeof range.endIndex === "number") {
    const startIndex = Math.max(0, Math.min(totalLength, range.startIndex ?? 0));
    const endIndex = Math.max(startIndex, Math.min(totalLength, range.endIndex ?? totalLength));
    return { sliceStart: startIndex, sliceEnd: endIndex };
  }
  const lines = text.split("\n");
  const startLine = Math.max(1, range.startLine ?? 1);
  const endLine = Math.max(startLine, range.endLine ?? lines.length);
  let cursor = 0;
  let sliceStart = 0;
  let sliceEnd = totalLength;
  for (let i = 1; i <= lines.length; i++) {
    const line = lines[i - 1];
    const next = cursor + line.length + (i < lines.length ? 1 : 0);
    if (i === startLine) sliceStart = cursor;
    if (i === endLine) { sliceEnd = next; break; }
    cursor = next;
  }
  return { sliceStart, sliceEnd };
}

function replaceByOccurrenceString(target: string, find: string, replacement: string, occurrence: ToolEditOccurrence): string {
  if (occurrence === "all") return target.split(find).join(replacement);
  if (occurrence === "first") {
    const idx = target.indexOf(find);
    if (idx === -1) return target;
    return target.slice(0, idx) + replacement + target.slice(idx + find.length);
  }
  if (occurrence === "last") {
    const idx = target.lastIndexOf(find);
    if (idx === -1) return target;
    return target.slice(0, idx) + replacement + target.slice(idx + find.length);
  }
  return target;
}

function replaceByOccurrenceRegex(target: string, pattern: RegExp, replacement: string, occurrence: ToolEditOccurrence): string {
  if (occurrence === "all") return target.replace(pattern, replacement);
  const matches = Array.from(
    target.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))
  );
  if (matches.length === 0) return target;
  let which = 0;
  if (occurrence === "first") which = 0;
  else if (occurrence === "last") which = matches.length - 1;
  const m = matches[which];
  const start = m.index as number;
  const end = start + m[0].length;
  return (
    target.slice(0, start) +
    m[0].replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement) +
    target.slice(end)
  );
}

function replaceLoose(target: string, oldText: string, newText: string, preserveIndent: boolean, occurrence: ToolEditOccurrence): string {
  const oldLines = oldText.split("\n");
  const tgtLines = target.split("\n");
  const found: number[] = [];
  for (let i = 0; i <= tgtLines.length - oldLines.length; i++) {
    const window = tgtLines.slice(i, i + oldLines.length);
    const match = oldLines.every((line, idx) => line.trim() === (window[idx] ?? "").trim());
    if (match) found.push(i);
  }
  if (found.length === 0) return target;
  const doReplaceAt = (pos: number) => {
    const originalIndent = tgtLines[pos].match(/^\s*/)?.[0] || "";
    const newLines = newText.split("\n").map((line, j) => {
      if (!preserveIndent) return line;
      if (j === 0) return originalIndent + line.trimStart();
      return originalIndent + line.trimStart();
    });
    tgtLines.splice(pos, oldLines.length, ...newLines);
  };
  if (occurrence === "all") {
    for (let k = found.length - 1; k >= 0; k--) doReplaceAt(found[k]);
  } else {
    let indexToUse = 0;
    if (occurrence === "last") indexToUse = found.length - 1;
    doReplaceAt(found[indexToUse]);
  }
  return tgtLines.join("\n");
}


/**
 * Render a unified inline diff block under a host element for write/edit tool calls.
 * Returns the created diff container or null if not applicable.
 */
export async function renderWriteEditInlineDiff(app: App, hostElement: HTMLElement, toolCall: ToolCall): Promise<HTMLElement | null> {
  const preview = await prepareWriteEditPreview(app, toolCall);
  if (!preview) return null;

  // Remove any existing inline diff to avoid duplicates
  const existing = hostElement.querySelector(".systemsculpt-inline-diff");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.className = "systemsculpt-inline-diff";
  hostElement.appendChild(container);

  // Diff content only (no header/actions to keep UI clean)
  const body = container.createDiv({ cls: "systemsculpt-inline-diff__body" });
  // Lazy import DiffViewer to avoid any circular dependencies
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DiffViewer } = require("../components/DiffViewer");
  const viewer = new DiffViewer({
    container: body,
    diffResult: preview.diff,
    fileName: preview.path,
    maxContextLines: 3,
    showLineNumbers: true,
  });
  viewer.render();

  return container;
}


// -----------------------------
// Operations (move/trash/create_folders) preview
// -----------------------------

export type OperationsPreview =
  | { type: "move"; items: Array<{ source: string; destination: string }> }
  | { type: "trash"; items: Array<{ path: string }> }
  | { type: "create_folders"; items: Array<{ path: string }> };

export function isMoveTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "move";
}

export function isTrashTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "trash";
}

export function isCreateFoldersTool(toolName: string): boolean {
  return splitToolName(toolName).canonicalName === "create_folders";
}

export function prepareOperationsPreview(toolCall: ToolCall): OperationsPreview | null {
  const fn = getFunctionDataFromToolCall(toolCall);
  if (!fn) return null;
  const base = splitToolName(fn.name).canonicalName;
  const args = (fn.arguments ?? {}) as Record<string, any>;

  if (base === "move") {
    const destinationFallback =
      typeof args.destination === "string"
        ? args.destination
        : typeof args.target === "string"
          ? args.target
          : typeof args.to === "string"
            ? args.to
            : typeof args.targetPath === "string"
              ? args.targetPath
              : "";

    const rawItems = Array.isArray(args.items) ? args.items : [];
    // De-duplicate identical move pairs (source,destination)
    const seen = new Set<string>();
    const items = rawItems
      .map((it: any) => ({
        source: String(it?.source ?? it?.path ?? it?.from ?? ""),
        destination: String(it?.destination ?? destinationFallback ?? ""),
      }))
      .filter((it: any) => it.source && it.destination)
      .filter((it: any) => {
        const key = `${it.source}\u0000${it.destination}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (items.length === 0 && Array.isArray(args.paths) && destinationFallback) {
      for (const path of args.paths) {
        const source = String(path ?? "");
        if (!source) continue;
        const key = `${source}\u0000${destinationFallback}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ source, destination: destinationFallback });
      }
    }

    if (items.length === 0) return null;
    return { type: "move", items };
  }

  if (base === "trash") {
    const raw = Array.isArray(args.paths) ? args.paths : [];
    const seen = new Set<string>();
    const items = raw
      .map((p: any) => ({ path: String(p) }))
      .filter((it: any) => !!it.path)
      .filter((it: any) => {
        if (seen.has(it.path)) return false;
        seen.add(it.path);
        return true;
      });
    if (items.length === 0) return null;
    return { type: "trash", items };
  }

  if (base === "create_folders") {
    const raw = Array.isArray(args.paths) ? args.paths : [];
    const seen = new Set<string>();
    const items = raw
      .map((p: any) => ({ path: String(p) }))
      .filter((it: any) => !!it.path)
      .filter((it: any) => {
        if (seen.has(it.path)) return false;
        seen.add(it.path);
        return true;
      });
    if (items.length === 0) return null;
    return { type: "create_folders", items };
  }

  return null;
}

export async function renderOperationsInlinePreview(hostElement: HTMLElement, toolCall: ToolCall): Promise<HTMLElement | null> {
  const preview = prepareOperationsPreview(toolCall);
  if (!preview) return null;

  // Remove any existing inline ops preview to avoid duplicates
  const existing = hostElement.querySelector(".systemsculpt-inline-ops");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.className = "systemsculpt-inline-ops";
  hostElement.appendChild(container);

  const body = container.createDiv({ cls: "systemsculpt-inline-ops__body" });

  const list = body.createEl("ul");
  if (preview.type === "move") {
    // Render as a single compact line with FULL paths: "Move: path/src → path/dst, ..."
    const li = list.createEl("li");
    li.createSpan({ text: "Move: " });
    preview.items.forEach((it, idx) => {
      const src = li.createEl("code", { cls: "ss-modal__inline-code" });
      src.textContent = it.source;
      src.setAttribute("title", it.source);
      li.createSpan({ text: " → " });
      const dst = li.createEl("code", { cls: "ss-modal__inline-code" });
      dst.textContent = it.destination;
      dst.setAttribute("title", it.destination);
      if (idx < preview.items.length - 1) li.appendChild(document.createTextNode(", "));
    });
  } else if (preview.type === "trash") {
    // Render as a single compact line: "Trash: a.md, b.md, c.md"
    const li = list.createEl("li");
    li.createSpan({ text: "Trash: " });
    preview.items.forEach((it, idx) => {
      const code = li.createEl("code", { cls: "ss-modal__inline-code" });
      code.textContent = it.path;
      if (idx < preview.items.length - 1) li.appendChild(document.createTextNode(", "));
    });
  } else if (preview.type === "create_folders") {
    // Render as a single compact line: "Create folders: personal, business, knowledge"
    const li = list.createEl("li");
    li.createSpan({ text: "Create folders: " });
    // Show base folder names for readability, but keep full path in title
    const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    preview.items.forEach((it, idx) => {
      const code = li.createEl("code", { cls: "ss-modal__inline-code" });
      code.textContent = baseName(it.path);
      code.setAttribute("title", it.path);
      if (idx < preview.items.length - 1) li.appendChild(document.createTextNode(", "));
    });
  }

  return container;
}
