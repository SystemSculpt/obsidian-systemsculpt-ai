/**
 * DiffViewer component - shows only changed sections with minimal context
 */

import { Component } from 'obsidian';
import { DiffResult, DiffLine } from '../utils/diffUtils';

export interface DiffViewerOptions {
  container: HTMLElement;
  diffResult: DiffResult;
  fileName: string;
  maxContextLines?: number; // Context lines around changes (default 2)
  showLineNumbers?: boolean; // Show line numbers (default false for compactness)
}

export class DiffViewer extends Component {
  private container: HTMLElement;
  private diffResult: DiffResult;
  private fileName: string;
  private maxContextLines: number;
  private showLineNumbers: boolean;

  constructor(options: DiffViewerOptions) {
    super();
    this.container = options.container;
    this.diffResult = options.diffResult;
    this.fileName = options.fileName;
    this.maxContextLines = options.maxContextLines ?? 2;
    this.showLineNumbers = options.showLineNumbers ?? false;
  }

  public render(): void {
    this.container.empty();
    this.container.classList.add('systemsculpt-diff-viewer');

    // Create header with file info and stats
    this.createHeader();

    // Create diff content with change hunks
    this.createChangeHunks();
  }

  private createHeader(): void {
    const header = this.container.createEl('div', {
      cls: 'systemsculpt-diff-header'
    });

    // File name and stats in one line
    const fileInfo = header.createEl('div', {
      cls: 'systemsculpt-diff-file-info'
    });

    const fileName = fileInfo.createEl('span', {
      cls: 'systemsculpt-diff-filename',
      text: this.fileName
    });

    // Stats
    const stats = fileInfo.createEl('span', {
      cls: 'systemsculpt-diff-stats'
    });

    const totalChanges = this.diffResult.stats.additions + this.diffResult.stats.deletions;

    if (totalChanges === 0) {
      stats.textContent = 'No changes';
      stats.addClass('systemsculpt-diff-no-changes');
    } else {
      // Create separate spans for additions and deletions to style them independently
      if (this.diffResult.stats.additions > 0) {
        const additionsSpan = stats.createEl('span', {
          cls: 'systemsculpt-diff-additions',
          text: `+${this.diffResult.stats.additions}`
        });
      }
      if (this.diffResult.stats.deletions > 0) {
        // Add space between additions and deletions if both exist
        if (this.diffResult.stats.additions > 0) {
          stats.createEl('span', { text: ' ' });
        }
        const deletionsSpan = stats.createEl('span', {
          cls: 'systemsculpt-diff-deletions',
          text: `-${this.diffResult.stats.deletions}`
        });
      }
      
      if (this.diffResult.stats.additions > 0) {
        stats.addClass('systemsculpt-diff-has-additions');
      }
      if (this.diffResult.stats.deletions > 0) {
        stats.addClass('systemsculpt-diff-has-deletions');
      }

      const totalSpan = stats.createEl('span', {
        cls: 'systemsculpt-diff-total',
        text: ` · ${totalChanges} ${totalChanges === 1 ? 'line' : 'lines'} changed`,
      });
    }
  }

  private createChangeHunks(): void {
    const content = this.container.createEl('div', {
      cls: 'systemsculpt-diff-content'
    });

    // Group lines into change hunks (continuous groups of changes with context)
    const hunks = this.groupIntoHunks(this.diffResult.lines);

    if (hunks.length === 0) {
      const noChanges = content.createEl('div', {
        cls: 'systemsculpt-diff-no-changes-notice',
        text: 'No changes to display'
      });
      return;
    }

    hunks.forEach((hunk, index) => {
      this.createHunk(content, hunk, index);
    });

    if (this.diffResult.isTruncated) {
      content.createEl('div', {
        cls: 'systemsculpt-diff-truncated',
        text: 'Preview shortened — open the file to review the full change.',
      });
    }
  }

  private groupIntoHunks(lines: DiffLine[]): DiffLine[][] {
    const hunks: DiffLine[][] = [];
    let currentHunk: DiffLine[] = [];
    let contextBuffer: DiffLine[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.type === 'unchanged') {
        contextBuffer.push(line);
        
        // If we've collected too much context, start a new hunk
        if (contextBuffer.length > this.maxContextLines * 2) {
          // Close current hunk with context if it has changes
          if (currentHunk.length > 0) {
            currentHunk.push(...contextBuffer.slice(0, this.maxContextLines));
            hunks.push([...currentHunk]);
            currentHunk = [];
          }
          
          // Reset context buffer, keeping only recent context
          contextBuffer = contextBuffer.slice(-this.maxContextLines);
        }
      } else {
        // This is a change line
        if (currentHunk.length === 0) {
          // Starting new hunk - add preceding context
          currentHunk.push(...contextBuffer.slice(-this.maxContextLines));
        } else {
          // Continuing hunk - add all buffered context
          currentHunk.push(...contextBuffer);
        }
        
        currentHunk.push(line);
        contextBuffer = [];
      }
    }
    
    // Close final hunk if it has changes
    if (currentHunk.length > 0) {
      currentHunk.push(...contextBuffer.slice(0, this.maxContextLines));
      hunks.push(currentHunk);
    }
    
    return hunks;
  }

  private createHunk(container: HTMLElement, hunk: DiffLine[], index: number): void {
    const hunkEl = container.createEl('div', {
      cls: 'systemsculpt-diff-hunk'
    });

    // Add separator for multiple hunks
    if (index > 0) {
      hunkEl.addClass('systemsculpt-diff-hunk-separated');
    }

    // Hunk header with location summary
    const hunkSummary = this.computeHunkSummary(hunk);
    if (hunkSummary) {
      hunkEl.createEl('div', {
        cls: 'systemsculpt-diff-hunk-header',
        text: `@@ ${hunkSummary} @@`,
      });
    }

    // Create lines container
    const linesContainer = hunkEl.createEl('div', {
      cls: 'systemsculpt-diff-lines'
    });

    // Render each line in the hunk
    hunk.forEach(line => {
      this.createCompactLine(linesContainer, line);
    });
  }

  private createCompactLine(container: HTMLElement, line: DiffLine): void {
    const lineEl = container.createEl('div', {
      cls: `systemsculpt-diff-line systemsculpt-diff-line-${line.type}`
    });

    // Optional line numbers (only if enabled and space allows)
    if (this.showLineNumbers) {
      const oldNumber = lineEl.createEl('span', {
        cls: 'systemsculpt-diff-line-number systemsculpt-diff-line-number-old',
        text: line.oldLineNumber ? `${line.oldLineNumber}` : '',
      });

      const newNumber = lineEl.createEl('span', {
        cls: 'systemsculpt-diff-line-number systemsculpt-diff-line-number-new',
        text: line.newLineNumber ? `${line.newLineNumber}` : '',
      });
    }

    // Line prefix (compact)
    const prefix = lineEl.createEl('span', {
      cls: 'systemsculpt-diff-prefix'
    });

    switch (line.type) {
      case 'added':
        prefix.textContent = '+';
        break;
      case 'removed':
        prefix.textContent = '-';
        break;
      case 'unchanged':
        prefix.textContent = '';
        break;
    }

    // Line content
    const content = lineEl.createEl('span', {
      cls: 'systemsculpt-diff-line-content',
      text: line.content || ''
    });

    // Handle empty lines
    if (!line.content && line.content !== '') {
      content.innerHTML = '&nbsp;';
    }
  }

  public updateDiff(diffResult: DiffResult): void {
    this.diffResult = diffResult;
    this.render();
  }

  public destroy(): void {
    this.container.empty();
    this.unload();
  }

  private computeHunkSummary(hunk: DiffLine[]): string | null {
    const firstOld = hunk.find((line) => typeof line.oldLineNumber === 'number');
    const firstNew = hunk.find((line) => typeof line.newLineNumber === 'number');
    const changeCount = hunk.filter((line) => line.type !== 'unchanged').length;

    if (!firstOld && !firstNew) {
      return null;
    }

    const summaryParts: string[] = [];
    if (firstOld?.oldLineNumber) {
      summaryParts.push(`-${firstOld.oldLineNumber}`);
    }
    if (firstNew?.newLineNumber) {
      summaryParts.push(`+${firstNew.newLineNumber}`);
    }
    if (changeCount > 0) {
      summaryParts.push(`${changeCount} ${changeCount === 1 ? 'line' : 'lines'}`);
    }

    return summaryParts.join(' ');
  }
}
