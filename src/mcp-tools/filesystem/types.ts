/**
 * Type definitions for MCP Filesystem tools
 */

/**
 * Metadata for file read operations with windowing
 */
export interface FileReadMetadata {
  fileSize: number;
  created: string;
  modified: string;
  windowStart: number;
  windowEnd: number;
  hasMore: boolean;
}

/**
 * File information for list_items results
 */
export interface FileInfo {
  name: string;
  size: number;
  created: string;
  modified: string;
  extension: string;
  preview?: string;
}

/**
 * Directory information for list_items results
 */
export interface DirectoryInfo {
  name: string;
  itemCount: number;
  modified?: string;
}

/**
 * Tool operation result types
 */
export interface ToolResult {
  success: boolean;
  error?: string;
}

export interface FileOperationResult extends ToolResult {
  path: string;
}

export interface MoveOperationResult extends ToolResult {
  source: string;
  destination: string;
}

export interface ContextManagementResult {
  action: string;
  processed: number;
  results: Array<{ path: string; success: boolean; reason?: string }>;
  summary: string;
}

export interface WorkspaceManagementResult {
  opened: string[];
  errors: string[];
}

export interface DuplicateSearchResult {
  duplicate_sets: string[][];
}

/**
 * Tool execution parameters
 */
export interface ReadFilesParams {
  paths: string[];
  offset?: number | null;
  length?: number | null;
}

export interface WriteFileParams {
  path: string;
  content: string;
  createDirs?: boolean | null;
  ifExists?: "overwrite" | "skip" | "error" | "append" | null;
  appendNewline?: boolean | null;
}

export interface FileEditRange {
  startLine?: number | null;
  endLine?: number | null;
  startIndex?: number | null;
  endIndex?: number | null;
}

export interface FileEdit {
  oldText: string;
  newText: string;
  isRegex?: boolean | null;
  flags?: string | null;
  occurrence?: "first" | "last" | "all" | null;
  mode?: "exact" | "loose" | null;
  range?: FileEditRange | null;
  preserveIndent?: boolean | null;
}

export interface EditFileParams {
  path: string;
  edits: FileEdit[];
  strict?: boolean | null;
}

export interface CreateDirectoriesParams {
  paths: string[];
}

export interface ListDirectoriesParams {
  paths: string[];
  filter?: "all" | "files" | "directories" | null | { semantic: string };
  sort?: "modified" | "size" | "name" | "created" | null;
  recursive?: boolean | null;
  intelligentGrouping?: boolean;
  includeSuggestions?: boolean;
  anomalyDetection?: boolean;
}

export interface MoveItemsParams {
  items: Array<{ source: string; destination: string }>;
}

export interface TrashFilesParams {
  paths: string[];
}

export interface FindFilesParams {
  patterns: string[];
  mode?: "keyword" | "semantic" | "hybrid" | "graph" | "smart";
  includeRelated?: boolean;
  maxResults?: number;
  sessionId?: string;
}

export interface GrepVaultParams {
  patterns: string[];
  mode?: "keyword" | "semantic" | "hybrid" | "graph" | "smart";
  contextSize?: "small" | "medium" | "large";
  includeRelated?: boolean;
  highlightStyle?: "inline" | "separate";
  sessionId?: string;
  searchIn?: "content" | "frontmatter" | "both" | null;
  pageTokens?: number | null;
}

export interface ManageWorkspaceParams {
  files: Array<{ path: string; intent?: string }>;
}

export interface ManageContextParams {
  action: "add" | "remove";
  paths: string[];
}
