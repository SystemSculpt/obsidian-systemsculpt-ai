import { Notice, Platform, TFile, normalizePath } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type {
  StudioSessionRecord,
  SystemSculptHistoryEntry,
  SystemSculptHistoryProvider,
} from "./types";

function getFavoriteStudioSessions(plugin: SystemSculptPlugin): string[] {
  const raw = (plugin.settings as { favoriteStudioSessions?: unknown }).favoriteStudioSessions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => (typeof entry === "string" ? normalizePath(entry.trim()) : ""))
    .filter((entry) => entry.length > 0);
}

function isFavoriteStudioSession(plugin: SystemSculptPlugin, projectPath: string): boolean {
  const normalizedPath = normalizePath(String(projectPath || "").trim());
  if (!normalizedPath) {
    return false;
  }
  const favorites = new Set(getFavoriteStudioSessions(plugin));
  return favorites.has(normalizedPath);
}

async function toggleFavoriteStudioSession(plugin: SystemSculptPlugin, projectPath: string): Promise<boolean> {
  const normalizedPath = normalizePath(String(projectPath || "").trim());
  if (!normalizedPath) {
    return false;
  }

  const favorites = new Set(getFavoriteStudioSessions(plugin));
  if (favorites.has(normalizedPath)) {
    favorites.delete(normalizedPath);
  } else {
    favorites.add(normalizedPath);
  }

  const next = Array.from(favorites).sort((a, b) => a.localeCompare(b));
  await plugin.getSettingsManager().updateSettings({
    favoriteStudioSessions: next,
  } as any);

  return next.includes(normalizedPath);
}

export async function loadStudioSessionRecords(plugin: SystemSculptPlugin): Promise<StudioSessionRecord[]> {
  if (!Platform.isDesktopApp) {
    return [];
  }

  const projectFiles = plugin.app.vault
    .getFiles()
    .filter((file) => file instanceof TFile && file.extension.toLowerCase() === "systemsculpt");

  return projectFiles.map((projectFile) => ({
    projectFile,
    projectPath: normalizePath(projectFile.path),
  }));
}

export function createStudioSessionHistoryProvider(plugin: SystemSculptPlugin): SystemSculptHistoryProvider {
  return {
    id: "studio-session-history",
    loadEntries: async () => {
      const records = await loadStudioSessionRecords(plugin);
      return records.map((record) => {
        const timestampMs = Number(record.projectFile.stat.mtime) || Date.now();
        const title = record.projectFile.basename;
        const subtitle = record.projectPath;
        const searchText = [
          title,
          subtitle,
          record.projectPath,
        ]
          .join("\n")
          .toLowerCase();

        const entry: SystemSculptHistoryEntry = {
          id: `studio:${record.projectPath}`,
          kind: "studio_session",
          title,
          subtitle,
          timestampMs,
          searchText,
          badge: "Studio Session",
          metadataPath: record.projectPath,
          isFavorite: isFavoriteStudioSession(plugin, record.projectPath),
          toggleFavorite: async () => {
            return toggleFavoriteStudioSession(plugin, record.projectPath);
          },
          openPrimary: async () => {
            try {
              await plugin.getViewManager().activateSystemSculptStudioView(record.projectPath);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`Unable to open Studio project: ${message}`);
            }
          },
        };

        return entry;
      });
    },
  };
}
