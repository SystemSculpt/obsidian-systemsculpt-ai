import { Platform } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { createChatHistoryProvider } from "./chatHistoryProvider";
import { createStudioSessionHistoryProvider } from "./studioSessionHistoryProvider";
import type { SystemSculptHistoryEntry, SystemSculptHistoryProvider } from "./types";

export function createSystemSculptHistoryProviders(
  plugin: SystemSculptPlugin,
  includeStudioSessions: boolean = Platform.isDesktopApp
): SystemSculptHistoryProvider[] {
  const providers: SystemSculptHistoryProvider[] = [createChatHistoryProvider(plugin)];
  if (includeStudioSessions) {
    providers.push(createStudioSessionHistoryProvider(plugin));
  }
  return providers;
}

export function sortHistoryEntriesNewestFirst(entries: SystemSculptHistoryEntry[]): SystemSculptHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (b.timestampMs !== a.timestampMs) {
      return b.timestampMs - a.timestampMs;
    }
    return a.title.localeCompare(b.title);
  });
}

export async function loadSystemSculptHistoryEntries(plugin: SystemSculptPlugin): Promise<SystemSculptHistoryEntry[]> {
  const providers = createSystemSculptHistoryProviders(plugin);
  const groups = await Promise.all(
    providers.map(async (provider) => {
      try {
        return await provider.loadEntries();
      } catch {
        return [] as SystemSculptHistoryEntry[];
      }
    })
  );

  return sortHistoryEntriesNewestFirst(groups.flat());
}
