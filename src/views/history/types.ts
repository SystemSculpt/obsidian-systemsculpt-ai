import type { TFile, WorkspaceLeaf } from "obsidian";

export type SystemSculptHistoryEntryKind = "chat" | "studio_session";

export type SystemSculptHistoryEntry = {
  id: string;
  kind: SystemSculptHistoryEntryKind;
  title: string;
  subtitle?: string;
  timestampMs: number;
  /** Lowercased metadata text that filtering matches on every keystroke. */
  searchText: string;
  /**
   * Lowercased full text, read on demand by the debounced full-text search.
   * Entries without it are matched by `searchText` alone.
   */
  loadSearchText?: () => Promise<string>;
  badge?: string;
  metadataPath?: string;
  isFavorite?: boolean;
  toggleFavorite?: () => Promise<boolean>;
  /**
   * Opens the entry. When the history modal was launched from a surface that
   * can host the entry (an open ChatView), that surface's leaf arrives here so
   * the entry resumes in place instead of spawning a new tab.
   */
  openPrimary: (leaf?: WorkspaceLeaf) => Promise<void>;
};

export type StudioSessionRecord = {
  projectFile: TFile;
  projectPath: string;
};

export interface SystemSculptHistoryProvider {
  id: string;
  loadEntries: (signal?: AbortSignal) => Promise<SystemSculptHistoryEntry[]>;
}
