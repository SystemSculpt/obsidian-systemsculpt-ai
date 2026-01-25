/**
 * Diff utilities for generating git-like diffs
 */

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

/**
 * Generate a simple line-by-line diff between two strings with limited context
 */
export function generateDiff(oldContent: string, newContent: string, contextLines: number = 10): DiffResult {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  
  const result: DiffLine[] = [];
  const stats = { additions: 0, deletions: 0 };
  
  // Simple diff algorithm using longest common subsequence approach
  const matrix = createLCSMatrix(oldLines, newLines);
  const diffSequence = extractDiffSequence(matrix, oldLines, newLines);
  
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
 * Create Longest Common Subsequence matrix for diff calculation
 */
function createLCSMatrix(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const matrix: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
      }
    }
  }
  
  return matrix;
}

/**
 * Extract diff sequence from LCS matrix
 */
function extractDiffSequence(
  matrix: number[][],
  oldLines: string[],
  newLines: string[]
): Array<{ type: 'added' | 'removed' | 'unchanged'; line: string }> {
  const result: Array<{ type: 'added' | 'removed' | 'unchanged'; line: string }> = [];
  let i = oldLines.length;
  let j = newLines.length;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'unchanged', line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
      result.unshift({ type: 'added', line: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: 'removed', line: oldLines[i - 1] });
      i--;
    }
  }
  
  return result;
}

/**
 * Check if a file is currently open in any Obsidian workspace leaf
 */
export function isFileOpen(app: any, filePath: string): boolean {
  // Check all markdown leaves to see if the file is open
  const markdownLeaves = app.workspace.getLeavesOfType('markdown');
  
  for (const leaf of markdownLeaves) {
    const view = leaf.view;
    if (view && view.file && view.file.path === filePath) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get the content of an open file from the editor (if modified) or from vault
 */
export async function getFileContent(app: any, filePath: string): Promise<string> {
  // First try to get from open editor (may have unsaved changes)
  const markdownLeaves = app.workspace.getLeavesOfType('markdown');
  
  for (const leaf of markdownLeaves) {
    const view = leaf.view;
    if (view && view.file && view.file.path === filePath) {
      // Get content from editor if available
      if (view.editor) {
        return view.editor.getValue();
      }
    }
  }
  
  // Fallback to reading from vault
  try {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file.stat) { // Check if it's a TFile
      return await app.vault.read(file);
    }
  } catch (error) {
  }
  
  return '';
} 
