/**
 * Configuration constants for first-party vault tools.
 */

export const FILESYSTEM_LIMITS = {
  MAX_FILE_READ_LENGTH: 25000, // Characters per read window
  MAX_LINE_LENGTH: 2000,
  MAX_OPERATIONS: 100, // Max operations for batch tools
  MAX_MULTI_EDIT_FILES: 20,
  MAX_READ_FILES: 10,
  DEFAULT_LIST_PAGE_SIZE: 25,
  MAX_LIST_PAGE_SIZE: 50,
  MAX_SEARCH_RESULTS: 25, // Global results cap for search-type tools (grep/find/etc.)
  MAX_FILE_SIZE: 200000, // 200KB max file size for processing
  MAX_CONTENT_SIZE: 250000, // 250KB max content size for writing
  HARD_LIMIT: 25000, // Same as MAX_FILE_READ_LENGTH – absolute per-window cap
  MAX_RESPONSE_CHARS: 25000, // Hard cap for the size (in characters) of any single tool response
  CONTEXT_CHARS: 200, // Characters to show before and after match in grep
  BATCH_SIZE: 15, // Process files in batches to prevent UI freeze
  MAX_PROCESSING_TIME: 8000, // 8 seconds max processing time
  MAX_MATCHES_PER_FILE: 20, // Stop processing file after this many matches
  MAX_TOTAL_FILES_PROCESSED: 1000, // Hard limit on files processed
  MAX_FILES_PER_REQUEST: 10, // Max files for context management
  CONCURRENCY_LIMIT: 10, // Parallel operations limit
  // Token-capped tool result policy
  MAX_TOOL_RESULT_TOKENS: 2048, // Per tool-call result budget
  GREP_BODY_TOKENS: 1900, // Body slice target
  GREP_FOOTER_TOKENS: 148 // Reserved for footer/meta
} as const;
