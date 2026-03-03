import type { TFile } from "obsidian";

export type SystemSculptHistoryEntryKind = "chat" | "studio_session";

export type SystemSculptHistoryEntry = {
  id: string;
  kind: SystemSculptHistoryEntryKind;
  title: string;
  subtitle?: string;
  timestampMs: number;
  searchText: string;
  badge: string;
  metadataPath?: string;
  isFavorite?: boolean;
  toggleFavorite?: () => Promise<boolean>;
  openPrimary: () => Promise<void>;
};

export type StudioSessionRecord = {
  projectFile: TFile;
  projectPath: string;
};

export interface SystemSculptHistoryProvider {
  id: string;
  loadEntries: () => Promise<SystemSculptHistoryEntry[]>;
}
