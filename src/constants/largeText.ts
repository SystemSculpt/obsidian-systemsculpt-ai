/**
 * Constants for large text handling across the application
 */

export const LARGE_TEXT_THRESHOLDS = {
  // Size thresholds in KB
  SOFT_WARNING_KB: 100,     // Show warning but continue processing
  HARD_WARNING_KB: 512,     // Show confirmation dialog
  MAX_SIZE_KB: 1024,        // Hard limit - reject with error
  
  // Line count thresholds
  MAX_LINES_PREVIEW: 5,     // Lines to show in preview
  COLLAPSE_THRESHOLD_LINES: 300, // Collapse if more than this many lines
  
  // Processing constants
  CHUNK_SIZE_CHARS: 1000,   // Character chunk size for processing
  BYTES_PER_KB: 1024,       // Conversion constant
} as const;

export const LARGE_TEXT_MESSAGES = {
  SIZE_ERROR: "❌ Text too large (>1MB). Please use file upload or split into smaller sections.",
  SIZE_WARNING_PREFIX: "⚠️ Large text detected",
  PROCESSING: "Processing large text...",
  COMPLETED: "Large text paste completed",
  CONFIRMATION_PREFIX: "Large text processed",
  TRUNCATION_INDICATOR: "... (content truncated)",
} as const;

export const LARGE_TEXT_UI = {
  PLACEHOLDER_PREFIX: "[PASTED TEXT - ",
  PLACEHOLDER_SUFFIX: " LINES OF TEXT]",
  STATS_PREFIX: "📄 Large text content: ",
  MODAL_TITLE_SUFFIX: " lines)",
} as const;

/**
 * Helper functions for large text operations
 */
export const LargeTextHelpers = {
  /**
   * Calculate text size in KB
   */
  getTextSizeKB: (text: string): number => {
    return new Blob([text]).size / LARGE_TEXT_THRESHOLDS.BYTES_PER_KB;
  },
  
  /**
   * Get line count
   */
  getLineCount: (text: string): number => {
    return text.split('\n').length;
  },
  
  /**
   * Check if text should be collapsed in chat history
   */
  shouldCollapseInHistory: (text: string): boolean => {
    const sizeKB = LargeTextHelpers.getTextSizeKB(text);
    const lines = LargeTextHelpers.getLineCount(text);
    
    return sizeKB > LARGE_TEXT_THRESHOLDS.SOFT_WARNING_KB || 
           lines > LARGE_TEXT_THRESHOLDS.COLLAPSE_THRESHOLD_LINES;
  },
  
  /**
   * Check if text requires warning during paste
   */
  getTextWarningLevel: (text: string): 'none' | 'soft' | 'hard' | 'error' => {
    const sizeKB = LargeTextHelpers.getTextSizeKB(text);
    
    if (sizeKB > LARGE_TEXT_THRESHOLDS.MAX_SIZE_KB) return 'error';
    if (sizeKB > LARGE_TEXT_THRESHOLDS.HARD_WARNING_KB) return 'hard';
    if (sizeKB > LARGE_TEXT_THRESHOLDS.SOFT_WARNING_KB) return 'soft';
    return 'none';
  },
  
  /**
   * Create placeholder text for input field
   */
  createPlaceholder: (lineCount: number): string => {
    return `${LARGE_TEXT_UI.PLACEHOLDER_PREFIX}${lineCount}${LARGE_TEXT_UI.PLACEHOLDER_SUFFIX}`;
  },
  
  /**
   * Check if text contains a large text placeholder
   */
  containsPlaceholder: (text: string): boolean => {
    return text.includes(LARGE_TEXT_UI.PLACEHOLDER_PREFIX) && 
           text.includes(LARGE_TEXT_UI.PLACEHOLDER_SUFFIX);
  },
  
  /**
   * Get preview content (first N lines)
   */
  getPreviewContent: (text: string): string => {
    const lines = text.split('\n');
    return lines.slice(0, LARGE_TEXT_THRESHOLDS.MAX_LINES_PREVIEW).join('\n');
  },
  
  /**
   * Format size display
   */
  formatSize: (sizeKB: number): string => {
    return `${Math.round(sizeKB)}KB`;
  }
};