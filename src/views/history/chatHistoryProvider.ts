import type SystemSculptPlugin from "../../main";
import { openChatResumeDescriptor } from "../chatview/ChatResumeUtils";
import { chatHistoryIndex } from "./chatHistoryIndex";
import type { SystemSculptHistoryEntry, SystemSculptHistoryProvider } from "./types";

function isFavoriteChat(plugin: SystemSculptPlugin, chatId: string): boolean {
  return plugin.settings.favoriteChats.includes(chatId);
}

async function toggleFavoriteChat(plugin: SystemSculptPlugin, chatId: string): Promise<void> {
  const favorites = plugin.settings.favoriteChats;
  const updated = favorites.includes(chatId)
    ? favorites.filter((id) => id !== chatId)
    : [...favorites, chatId];
  await plugin.getSettingsManager().updateSettings({ favoriteChats: updated });
}

function asTimestamp(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric;
}

/**
 * Chat history entries come from cached frontmatter and file stats. Each
 * entry keeps only identifiers; message text is read on demand by full-text
 * search.
 */
export function createChatHistoryProvider(plugin: SystemSculptPlugin): SystemSculptHistoryProvider {
  return {
    id: "chat-history",
    loadEntries: async () => {
      const index = chatHistoryIndex(plugin);
      return index.list().map((record): SystemSculptHistoryEntry => {
        const { chatId, title, chatPath, messageCount } = record;
        const timestampMs = asTimestamp(record.lastModified);
        return {
          id: `chat:${chatId}`,
          kind: "chat",
          title,
          subtitle: messageCount === null
            ? ""
            : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
          timestampMs,
          searchText: `${title}\n${chatId}`.toLowerCase(),
          loadSearchText: () => index.searchText(chatPath),
          metadataPath: chatPath,
          isFavorite: isFavoriteChat(plugin, chatId),
          toggleFavorite: async () => {
            await toggleFavoriteChat(plugin, chatId);
            return isFavoriteChat(plugin, chatId);
          },
          openPrimary: async (leaf) => {
            await openChatResumeDescriptor(plugin, {
              chatId,
              title,
              chatPath,
              lastModified: timestampMs,
              messageCount: messageCount ?? 0,
            }, leaf);
          },
        };
      });
    },
  };
}
