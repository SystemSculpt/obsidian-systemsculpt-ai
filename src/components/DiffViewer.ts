/**
 * DiffViewer component - shows only changed sections with minimal context
 */

import { DiffResult, DiffLine } from '../utils/diffUtils';
import { createUiAction } from '../core/ui/surface';

let diffContentSequence = 0;

/**
 * Why a diff is empty. An empty diff has more than one cause and they are not
 * equivalent: "identical" is safe to approve, the rest are edits that will not
 * apply. Rendering them all as "No changes" hides a failure behind a non-event.
 */
export type DiffEmptyReason = 'identical' | 'unmatched' | 'missing';

export interface DiffViewerOptions {
  container: HTMLElement;
  diffResult: DiffResult;
  fileName: string;
  maxContextLines?: number; // Context lines around changes (default 2)
  showLineNumbers?: boolean; // Show line numbers (default false for compactness)
  emptyReason?: DiffEmptyReason; // Why there is nothing to show (default 'identical')
  emptyDetail?: string; // Extra context for the empty state, e.g. unmatched edit count
  hideHeader?: boolean; // A single-file card already names the file and change size
  maxVisibleLines?: number; // Disclose the complete diff instead of silently clipping it
}

export class DiffViewer {
  private container: HTMLElement;
  private diffResult: DiffResult;
  private fileName: string;
  private maxContextLines: number;
  private showLineNumbers: boolean;
  private emptyReason: DiffEmptyReason;
  private emptyDetail: string | null;
  private hideHeader: boolean;
  private maxVisibleLines: number | undefined;

  constructor(options: DiffViewerOptions) {
    this.container = options.container;
    this.diffResult = options.diffResult;
    this.fileName = options.fileName;
    this.maxContextLines = options.maxContextLines ?? 2;
    this.showLineNumbers = options.showLineNumbers ?? false;
    this.emptyReason = options.emptyReason ?? 'identical';
    this.emptyDetail = options.emptyDetail ?? null;
    this.hideHeader = options.hideHeader ?? false;
    this.maxVisibleLines = options.maxVisibleLines;
  }

  public render(): void {
    this.container.empty();
    this.container.classList.add('systemsculpt-diff-viewer');
    this.container.classList.toggle('is-blocked', this.emptyReason !== 'identical');

    // A single-file approval already names the file above its preview.
    if (!this.hideHeader) this.createHeader();

    // Create diff content with change hunks
    this.createChangeHunks();
  }

  private createHeader(): void {
    const header = this.container.createDiv({
      cls: 'systemsculpt-diff-header'
    });

    // File name and stats in one line
    const fileInfo = header.createDiv({
      cls: 'systemsculpt-diff-file-info'
    });

    fileInfo.createSpan({
      cls: 'systemsculpt-diff-filename',
      text: this.fileName
    });

    // Stats
    const stats = fileInfo.createSpan({
      cls: 'systemsculpt-diff-stats'
    });

    const totalChanges = this.diffResult.stats.additions + this.diffResult.stats.deletions;

    if (totalChanges === 0) {
      stats.textContent = this.emptyHeadline();
      stats.addClass('systemsculpt-diff-no-changes');
      if (this.emptyReason !== 'identical') {
        stats.addClass('systemsculpt-diff-blocked');
        this.container.addClass('is-blocked');
      }
    } else {
      // Create separate spans for additions and deletions to style them independently
      if (this.diffResult.stats.additions > 0) {
        stats.createSpan({
          cls: 'systemsculpt-diff-additions',
          text: `+${this.diffResult.stats.additions}`
        });
      }
      if (this.diffResult.stats.deletions > 0) {
        // Add space between additions and deletions if both exist
        if (this.diffResult.stats.additions > 0) {
          stats.createSpan({ text: ' ' });
        }
        stats.createSpan({
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

      stats.createSpan({
        cls: 'systemsculpt-diff-total',
        text: ` · ${totalChanges} ${totalChanges === 1 ? 'line' : 'lines'} changed`,
      });
    }
  }

  private emptyHeadline(): string {
    switch (this.emptyReason) {
      case 'missing':
        return 'File not found';
      case 'unmatched':
        return "Can't apply";
      default:
        return 'No changes';
    }
  }

  private emptyExplanation(): string {
    const detail = this.emptyDetail ? ` ${this.emptyDetail}` : '';
    switch (this.emptyReason) {
      case 'missing':
        return `This file does not exist in your vault, so the change cannot be applied.${detail}`;
      case 'unmatched':
        return `This change could not be matched in the file, so nothing would be replaced.${detail}`;
      default:
        return 'This file already matches the proposed content — approving changes nothing.';
    }
  }

  private createChangeHunks(): void {
    const content = this.container.createDiv({
      cls: 'systemsculpt-diff-content',
      attr: { tabindex: '0', 'aria-label': 'File changes' },
    });
    content.classList.toggle('is-disclosed', this.maxVisibleLines !== undefined);

    // Group lines into change hunks (continuous groups of changes with context)
    const hunks = this.diffResult.hunks
      ? this.diffResult.hunks.flatMap((hunk) => this.groupIntoHunks(hunk))
      : this.groupIntoHunks(this.diffResult.lines);

    if (hunks.length === 0) {
      const notice = content.createDiv({
        cls: 'systemsculpt-diff-no-changes-notice',
      });
      // Without the header row, the notice carries the headline itself.
      if (this.hideHeader) {
        notice.createEl('strong', { cls: 'systemsculpt-diff-no-changes-headline', text: this.emptyHeadline() });
        notice.appendText(' ');
      }
      notice.appendText(this.emptyExplanation());
      if (this.emptyReason !== 'identical') {
        notice.addClass('systemsculpt-diff-no-changes-notice-blocked');
      }
      return;
    }

    const totalLines = hunks.reduce((count, hunk) => count + hunk.length, 0);
    const visibleLines = this.maxVisibleLines ?? totalLines;
    const renderHunks = (expanded: boolean): void => {
      content.empty();
      let remaining = expanded ? totalLines : visibleLines;
      for (const [index, hunk] of hunks.entries()) {
        if (remaining <= 0) break;
        this.createHunk(content, hunk.slice(0, remaining), index);
        remaining -= hunk.length;
      }
      if (this.diffResult.isTruncated) {
        content.createDiv({
          cls: 'systemsculpt-diff-truncated',
          text: 'Preview shortened — open the file to review the full change.',
        });
      }
    };
    renderHunks(false);
    if (totalLines > visibleLines) {
      content.id = `ss-diff-content-${++diffContentSequence}`;
      const showAll = createUiAction(this.container, {
        label: `Show full diff (${totalLines} lines)`,
        testId: 'chat.diff.show-all',
        size: 'small',
      });
      showAll.addClass('systemsculpt-diff-show-all');
      showAll.setAttrs({ 'aria-expanded': 'false', 'aria-controls': content.id });
      showAll.addEventListener('click', () => {
        const expanded = showAll.getAttribute('aria-expanded') !== 'true';
        renderHunks(expanded);
        showAll.setAttribute('aria-expanded', String(expanded));
        const label = showAll.querySelector('.ss-button__label');
        if (label) label.textContent = expanded ? 'Show less' : `Show full diff (${totalLines} lines)`;
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
    const hunkEl = container.createDiv({
      cls: 'systemsculpt-diff-hunk'
    });

    // Add separator for multiple hunks
    if (index > 0) {
      hunkEl.addClass('systemsculpt-diff-hunk-separated');
    }

    // Hunk header with location summary
    const hunkSummary = this.computeHunkSummary(hunk);
    if (hunkSummary) {
      hunkEl.createDiv({
        cls: 'systemsculpt-diff-hunk-header',
        text: `@@ ${hunkSummary} @@`,
      });
    }

    // Create lines container
    const linesContainer = hunkEl.createDiv({
      cls: 'systemsculpt-diff-lines'
    });

    // Render each line in the hunk
    hunk.forEach(line => {
      this.createCompactLine(linesContainer, line);
    });
  }

  private createCompactLine(container: HTMLElement, line: DiffLine): void {
    const lineEl = container.createDiv({
      cls: `systemsculpt-diff-line systemsculpt-diff-line-${line.type}`
    });

    // Optional line numbers (only if enabled and space allows)
    if (this.showLineNumbers) {
      lineEl.createSpan({
        cls: 'systemsculpt-diff-line-number systemsculpt-diff-line-number-old',
        text: line.oldLineNumber ? `${line.oldLineNumber}` : '',
      });

      lineEl.createSpan({
        cls: 'systemsculpt-diff-line-number systemsculpt-diff-line-number-new',
        text: line.newLineNumber ? `${line.newLineNumber}` : '',
      });
    }

    // Line prefix (compact)
    const prefix = lineEl.createSpan({
      cls: 'systemsculpt-diff-prefix'
    });

    switch (line.type) {
      case 'added':
        prefix.textContent = '+';
        break;
      case 'removed':
        prefix.textContent = '−';
        break;
      case 'unchanged':
        prefix.textContent = '';
        break;
    }

    // Line content
    const content = lineEl.createSpan({
      cls: 'systemsculpt-diff-line-content',
      text: line.content || ''
    });

    // Handle empty lines
    if (!line.content && line.content !== '') {
      content.textContent = '\u00a0';
    }
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
