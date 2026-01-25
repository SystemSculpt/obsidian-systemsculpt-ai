/**
 * Readwise API Types
 * Based on https://readwise.io/api_deets
 */

// ============================================================================
// API Response Types
// ============================================================================

export interface ReadwiseTag {
  id: number;
  name: string;
}

export interface ReadwiseHighlight {
  id: number;
  text: string;
  note: string;
  location: number;
  location_type: string;
  highlighted_at: string | null;
  created_at?: string;
  updated: string;
  url: string | null;
  color: string;
  book_id: number;
  tags: ReadwiseTag[];
}

export interface ReadwiseBook {
  user_book_id: number;
  title: string;
  author: string | null;
  readable_title: string;
  source: string;
  cover_image_url: string | null;
  unique_url: string | null;
  book_tags: ReadwiseTag[];
  category: "books" | "articles" | "tweets" | "supplementals" | "podcasts";
  document_note: string | null;
  readwise_url: string;
  source_url: string | null;
  asin: string | null;
  highlights: ReadwiseHighlight[];
}

export interface ReadwiseExportResponse {
  count: number;
  nextPageCursor: string | null;
  results: ReadwiseBook[];
}

// ============================================================================
// Service Types
// ============================================================================

/** Per-source tracking for incremental sync */
export interface SourceSyncState {
  /** Hash of last written file content */
  contentHash: string;
  /** Number of highlights at last sync */
  highlightCount: number;
  /** ISO timestamp of last sync for this source */
  lastSyncedAt: string;
}

export interface ReadwiseSyncState {
  lastSyncTimestamp: number;
  cursor: string;
  totalImported: number;
  lastError: string | null;
  version: number;
  /** Per-source tracking, keyed by user_book_id */
  sources?: Record<string, SourceSyncState>;
  /** Hash of import-affecting settings to detect changes */
  settingsHash?: string;
}

export interface ReadwiseSyncResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

/** Action taken for a source during sync */
export type SyncAction =
  | { action: "created" }
  | { action: "updated" }
  | { action: "skipped"; reason: "unchanged" };

export interface ReadwiseServiceEvents {
  "sync:started": { timestamp: number };
  "sync:progress": { current: number; total: number; currentItem?: string };
  "sync:completed": ReadwiseSyncResult;
  "sync:error": { error: Error; retryAt?: number };
  "auth:validated": { valid: boolean };
}

// ============================================================================
// Settings Types
// ============================================================================

export type ReadwiseOrganization = "by-category" | "flat" | "by-source";
export type ReadwiseSyncMode = "manual" | "on-load" | "interval";
export type ReadwiseTweetOrganization = "grouped" | "standalone";

/** Sync interval options in minutes */
export type ReadwiseSyncInterval = 5 | 10 | 30 | 60 | 120 | 1440;

export const READWISE_SYNC_INTERVAL_OPTIONS: { value: ReadwiseSyncInterval; label: string }[] = [
  { value: 5, label: "5 minutes" },
  { value: 10, label: "10 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 1440, label: "24 hours" },
];

export interface ReadwiseImportOptions {
  highlights: boolean;
  bookNotes: boolean;
  tags: boolean;
  includeHighlightNotes: boolean;
  fullDocument: boolean;
  includeSavedDate: boolean;
}

export const DEFAULT_READWISE_IMPORT_OPTIONS: ReadwiseImportOptions = {
  highlights: true,
  bookNotes: true,
  tags: true,
  includeHighlightNotes: true,
  fullDocument: false,
  includeSavedDate: true,
};

// ============================================================================
// Constants
// ============================================================================

export const READWISE_API_BASE = "https://readwise.io/api/v2";
export const READWISE_AUTH_ENDPOINT = `${READWISE_API_BASE}/auth/`;
export const READWISE_EXPORT_ENDPOINT = `${READWISE_API_BASE}/export/`;

// Rate limiting: 20 requests per minute for export endpoint
export const READWISE_RATE_LIMIT_PER_MINUTE = 18; // Conservative limit

// Category folder names
export const CATEGORY_FOLDERS: Record<ReadwiseBook["category"], string> = {
  books: "Books",
  articles: "Articles",
  tweets: "Tweets",
  supplementals: "Supplementals",
  podcasts: "Podcasts",
};
