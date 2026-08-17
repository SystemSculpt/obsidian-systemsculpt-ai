/**
 * The single implementation of `edit`/`multi_edit` text application.
 *
 * Both the executor (FileOperations) and the approval preview run this exact
 * code, so what the approval card shows is what approving actually does. A
 * preview that re-implements these rules drifts, and the drift is invisible:
 * it renders as an empty diff rather than as an error.
 */

import { FileEdit, FileEditRange, SkippedEdit } from "./types";
import { normalizeLineEndings } from "./utils";

export interface AppliedFileEdits {
  modifiedContent: string;
  appliedCount: number;
  skipped: SkippedEdit[];
}

/**
 * Apply every edit in order. Under `strict` a non-matching edit throws;
 * otherwise it is collected in `skipped` with its reason and the remaining
 * edits still run.
 */
export function applyFileEdits(
  content: string,
  edits: readonly FileEdit[],
  strict: boolean,
): AppliedFileEdits {
  let modifiedContent = normalizeLineEndings(content);
  let appliedCount = 0;
  const skipped: SkippedEdit[] = [];

  edits.forEach((edit, index) => {
    try {
      modifiedContent = applySingleFileEdit(modifiedContent, edit);
      appliedCount++;
    } catch (e) {
      if (strict) throw e;
      skipped.push({
        index,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return { modifiedContent, appliedCount, skipped };
}

/** Apply one edit. Throws when the edit matches nothing. */
export function applySingleFileEdit(source: string, edit: FileEdit): string {
  const text = normalizeLineEndings(source);
  const oldText = normalizeLineEndings(edit.oldText ?? "");
  const newText = normalizeLineEndings(edit.newText ?? "");
  const mode = edit.mode || "exact";
  const preserveIndent = edit.preserveIndent !== false;
  const occurrence = edit.occurrence ?? "first";

  const { sliceStart, sliceEnd } = computeRange(text, edit.range);
  const head = text.slice(0, sliceStart);
  const target = text.slice(sliceStart, sliceEnd);
  const tail = text.slice(sliceEnd);

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

  if (replaced === target) {
    throw new Error("Edit produced no changes");
  }

  return head + replaced + tail;
}

export function computeRange(
  text: string,
  range?: FileEditRange | null,
): { sliceStart: number; sliceEnd: number } {
  const totalLength = text.length;
  if (!range) return { sliceStart: 0, sliceEnd: totalLength };

  const hasIndexRange = typeof range.startIndex === "number" || typeof range.endIndex === "number";
  const hasLineRange = typeof range.startLine === "number" || typeof range.endLine === "number";

  // A non-empty character range is the most precise constraint. Some models
  // populate every optional range field and emit startIndex/endIndex as 0
  // alongside a valid line range; treat that degenerate pair as absent so it
  // cannot mask the useful line constraint.
  if (hasIndexRange) {
    const startIndex = Math.max(0, Math.min(totalLength, range.startIndex ?? 0));
    const endIndex = Math.max(startIndex, Math.min(totalLength, range.endIndex ?? totalLength));
    if (endIndex > startIndex || !hasLineRange) {
      return { sliceStart: startIndex, sliceEnd: endIndex };
    }
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
    if (i === endLine) {
      sliceEnd = next;
      break;
    }
    cursor = next;
  }
  return { sliceStart, sliceEnd };
}

type Occurrence = "first" | "last" | "all";

function replaceByOccurrenceString(
  target: string,
  find: string,
  replacement: string,
  occurrence: Occurrence,
): string {
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

function replaceByOccurrenceRegex(
  target: string,
  pattern: RegExp,
  replacement: string,
  occurrence: Occurrence,
): string {
  if (occurrence === "all") return target.replace(pattern, replacement);
  const matches = Array.from(
    target.matchAll(
      new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"),
    ),
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

function replaceLoose(
  target: string,
  oldText: string,
  newText: string,
  preserveIndent: boolean,
  occurrence: Occurrence,
): string {
  const oldLines = oldText.split("\n");
  const tgtLines = target.split("\n");
  const windows: number[] = [];
  for (let i = 0; i <= tgtLines.length - oldLines.length; i++) {
    const window = tgtLines.slice(i, i + oldLines.length);
    const match = oldLines.every((l, idx) => l.trim() === (window[idx] ?? "").trim());
    if (match) windows.push(i);
  }
  if (windows.length === 0) return target;
  const replaceAt = (pos: number) => {
    const originalIndent = tgtLines[pos].match(/^\s*/)?.[0] || "";
    const newLines = newText.split("\n").map((line, j) => {
      if (!preserveIndent) return line;
      if (j === 0) return originalIndent + line.trimStart();
      return originalIndent + line.trimStart();
    });
    tgtLines.splice(pos, oldLines.length, ...newLines);
  };
  if (occurrence === "all") {
    // Apply from last to first to keep indices stable
    for (let k = windows.length - 1; k >= 0; k--) replaceAt(windows[k]);
  } else {
    let indexToUse = 0;
    if (occurrence === "last") indexToUse = windows.length - 1;
    replaceAt(windows[indexToUse]);
  }
  return tgtLines.join("\n");
}
