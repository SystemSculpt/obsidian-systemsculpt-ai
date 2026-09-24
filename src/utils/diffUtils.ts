/**
 * Diff utilities for generating git-like diffs
 */

import { App, MarkdownView, TFile } from "obsidian";

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNumber?: number;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  stats: {
    additions: number;
    deletions: number;
  };
  isTruncated: boolean;
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

type DiffOperation = { type: 'added' | 'removed' | 'unchanged'; line: string };

/**
 * Largest LCS table, in cells, for the exact diff of the changed middle.
 * One million Uint32 cells is 4 MB; a typical agent edit uses a few hundred.
 */
const MAX_LCS_CELLS = 1_000_000;
/** Myers stops after this many line edits... */
const MAX_EDIT_DISTANCE = 1_000;
/** ...or once edits times compared lines would exceed this much work. */
const MAX_MYERS_WORK = 20_000_000;

/**
 * Generate a simple line-by-line diff between two strings with limited context
 */
export function generateDiff(oldContent: string, newContent: string, contextLines: number = 10): DiffResult {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  
  const stats = { additions: 0, deletions: 0 };
  
  const diffSequence = diffLineOperations(oldLines, newLines);
  
  let oldLineNum = 1;
  let newLineNum = 1;
  
  // First pass: generate full diff
  const fullDiff: DiffLine[] = [];
  for (const operation of diffSequence) {
    if (operation.type === 'unchanged') {
      fullDiff.push({
        type: 'unchanged',
        content: operation.line,
        oldLineNumber: oldLineNum,
        newLineNumber: newLineNum
      });
      oldLineNum++;
      newLineNum++;
    } else if (operation.type === 'removed') {
      fullDiff.push({
        type: 'removed',
        content: operation.line,
        oldLineNumber: oldLineNum,
      });
      oldLineNum++;
      stats.deletions++;
    } else if (operation.type === 'added') {
      fullDiff.push({
        type: 'added',
        content: operation.line,
        newLineNumber: newLineNum,
      });
      newLineNum++;
      stats.additions++;
    }
  }
  
  // Second pass: trim to contextLines around changes
  const { trimmedLines, wasTruncated } = trimDiffToContext(fullDiff, contextLines);
  
  return { lines: trimmedLines, stats, isTruncated: wasTruncated };
}

/**
 * Trim diff to show only contextLines before the first change and after the last change
 */
function trimDiffToContext(diffLines: DiffLine[], contextLines: number): { trimmedLines: DiffLine[], wasTruncated: boolean } {
  if (diffLines.length === 0) return { trimmedLines: diffLines, wasTruncated: false };
  
  // Find first and last change indices
  let firstChangeIndex = -1;
  let lastChangeIndex = -1;
  
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== 'unchanged') {
      if (firstChangeIndex === -1) {
        firstChangeIndex = i;
      }
      lastChangeIndex = i;
    }
  }
  
  // If no changes found, return original
  if (firstChangeIndex === -1) {
    return { trimmedLines: diffLines, wasTruncated: false };
  }
  
  // Calculate start and end indices with context
  const startIndex = Math.max(0, firstChangeIndex - contextLines);
  const endIndex = Math.min(diffLines.length - 1, lastChangeIndex + contextLines);
  
  // Check if content was truncated at the end
  const wasTruncated = endIndex < diffLines.length - 1;
  
  return { 
    trimmedLines: diffLines.slice(startIndex, endIndex + 1),
    wasTruncated 
  };
}

/**
 * Line operations turning `oldLines` into `newLines`.
 *
 * Trims the common suffix and prefix first, so a typical edit costs O(n).
 * The changed middle then gets an exact LCS table when it fits the cell
 * budget. That walk reproduces the full-matrix LCS diff line for line: the
 * table value for any cell that reaches into the common prefix is simply
 * min(i, j). A larger middle uses Myers' O(ND) diff, and a middle that is
 * too different even for that is shown as one replaced block.
 */
function diffLineOperations(oldLines: string[], newLines: string[]): DiffOperation[] {
  let suffix = 0;
  while (
    suffix < oldLines.length
    && suffix < newLines.length
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  let prefix = 0;
  while (prefix < oldEnd && prefix < newEnd && oldLines[prefix] === newLines[prefix]) prefix++;

  const cells = (oldEnd - prefix + 1) * (newEnd - prefix + 1);
  const operations = cells <= MAX_LCS_CELLS
    ? lcsOperations(oldLines, newLines, prefix, oldEnd, newEnd)
    : [
        ...oldLines.slice(0, prefix).map((line): DiffOperation => ({ type: 'unchanged', line })),
        ...(myersOperations(oldLines, newLines, prefix, oldEnd, newEnd)
          ?? replacedBlock(oldLines, newLines, prefix, oldEnd, newEnd)),
      ];
  for (let index = oldEnd; index < oldLines.length; index++) {
    operations.push({ type: 'unchanged', line: oldLines[index] });
  }
  return operations;
}

/**
 * Backtracks the LCS of oldLines[0, oldEnd) and newLines[0, newEnd), which
 * share their first `prefix` lines, from the end. Only the middle needs a
 * table: when i or j is at most `prefix` the LCS length is min(i, j).
 */
function lcsOperations(
  oldLines: string[],
  newLines: string[],
  prefix: number,
  oldEnd: number,
  newEnd: number,
): DiffOperation[] {
  const rows = oldEnd - prefix;
  const columns = newEnd - prefix;
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = 1; i <= rows; i++) {
    const oldLine = oldLines[prefix + i - 1];
    for (let j = 1; j <= columns; j++) {
      table[i * width + j] = oldLine === newLines[prefix + j - 1]
        ? table[(i - 1) * width + j - 1] + 1
        : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
    }
  }
  const lcsLength = (i: number, j: number): number =>
    i <= prefix || j <= prefix
      ? Math.min(i, j)
      : prefix + table[(i - prefix) * width + (j - prefix)];

  const result: DiffOperation[] = [];
  let i = oldEnd;
  let j = newEnd;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'unchanged', line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcsLength(i, j - 1) >= lcsLength(i - 1, j))) {
      result.push({ type: 'added', line: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'removed', line: oldLines[i - 1] });
      i--;
    }
  }
  return result.reverse();
}

/**
 * Myers' greedy shortest edit script for oldLines[start, oldEnd) against
 * newLines[start, newEnd). Returns null past the edit budget.
 */
function myersOperations(
  oldLines: string[],
  newLines: string[],
  start: number,
  oldEnd: number,
  newEnd: number,
): DiffOperation[] | null {
  const n = oldEnd - start;
  const m = newEnd - start;
  const maxEdits = Math.min(
    n + m,
    MAX_EDIT_DISTANCE,
    Math.max(1, Math.floor(MAX_MYERS_WORK / (n + m))),
  );
  const offset = maxEdits + 1;
  // Furthest x reached on each diagonal k = x - y, or -1 when unreached.
  // Diagonal 1 starts at the virtual point (0, -1) so round 0 begins at (0, 0).
  const furthest = new Int32Array(2 * maxEdits + 3).fill(-1);
  furthest[offset + 1] = 0;
  // trace[d] holds diagonals -d-1..d+1 as they were before round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxEdits; d++) {
    trace.push(furthest.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const previous = myersPredecessor((diagonal) => furthest[offset + diagonal], k, n, m);
      if (previous === null) {
        furthest[offset + k] = -1;
        continue;
      }
      let x = previous === k + 1
        ? furthest[offset + k + 1]
        : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[start + x] === newLines[start + y]) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x === n && y === m) return myersBacktrack(trace, d, oldLines, newLines, start, n, m);
    }
  }
  return null;
}

/**
 * The diagonal a path on diagonal k extends: k + 1 by an insertion or
 * k - 1 by a deletion, whichever reached further and stays inside the grid.
 */
function myersPredecessor(
  furthestX: (diagonal: number) => number,
  k: number,
  n: number,
  m: number,
): number | null {
  const insertionFrom = furthestX(k + 1);
  const deletionFrom = furthestX(k - 1);
  const canInsert = insertionFrom >= 0 && insertionFrom - (k + 1) < m;
  const canDelete = deletionFrom >= 0 && deletionFrom < n;
  if (canInsert && (!canDelete || deletionFrom < insertionFrom)) return k + 1;
  return canDelete ? k - 1 : null;
}

function myersBacktrack(
  trace: readonly Int32Array[],
  edits: number,
  oldLines: string[],
  newLines: string[],
  start: number,
  n: number,
  m: number,
): DiffOperation[] {
  const reversed: DiffOperation[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const before = trace[d];
    const furthestX = (diagonal: number) => before[diagonal + d + 1];
    const previous = myersPredecessor(furthestX, x - y, n, m) as number;
    const previousX = furthestX(previous);
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      reversed.push({ type: 'unchanged', line: oldLines[start + x - 1] });
      x--;
      y--;
    }
    if (x === previousX) {
      reversed.push({ type: 'added', line: newLines[start + y - 1] });
    } else {
      reversed.push({ type: 'removed', line: oldLines[start + x - 1] });
    }
    x = previousX;
    y = previousY;
  }
  // Round 0 is the snake from (0, 0).
  while (x > 0 && y > 0) {
    reversed.push({ type: 'unchanged', line: oldLines[start + x - 1] });
    x--;
    y--;
  }
  return removalsFirst(reversed.reverse());
}

/** Within each changed run, list removals before additions, as the LCS walk does. */
function removalsFirst(operations: DiffOperation[]): DiffOperation[] {
  const result: DiffOperation[] = [];
  let added: DiffOperation[] = [];
  for (const operation of operations) {
    if (operation.type === 'added') {
      added.push(operation);
      continue;
    }
    if (operation.type === 'unchanged' && added.length > 0) {
      result.push(...added);
      added = [];
    }
    result.push(operation);
  }
  result.push(...added);
  return result;
}

function replacedBlock(
  oldLines: string[],
  newLines: string[],
  start: number,
  oldEnd: number,
  newEnd: number,
): DiffOperation[] {
  return [
    ...oldLines.slice(start, oldEnd).map((line): DiffOperation => ({ type: 'removed', line })),
    ...newLines.slice(start, newEnd).map((line): DiffOperation => ({ type: 'added', line })),
  ];
}

/**
 * Check if a file is currently open in any Obsidian workspace leaf
 */
export function isFileOpen(app: App, filePath: string): boolean {
  // Check all markdown leaves to see if the file is open
  const markdownLeaves = app.workspace.getLeavesOfType('markdown');
  
  for (const leaf of markdownLeaves) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === filePath) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get the content of an open file from the editor (if modified) or from vault
 */
export async function getFileContent(app: App, filePath: string): Promise<string> {
  // First try to get from open editor (may have unsaved changes)
  const markdownLeaves = app.workspace.getLeavesOfType('markdown');
  
  for (const leaf of markdownLeaves) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === filePath) {
      // Get content from editor if available
      if (view.editor && typeof view.editor.getValue === "function") {
        return view.editor.getValue();
      }
    }
  }
  
  // Fallback to reading from vault
  try {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      return await app.vault.read(file);
    }
  } catch {
    // Fall back to an empty comparison when the vault read fails.
  }
  
  return '';
} 
