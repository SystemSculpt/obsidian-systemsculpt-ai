import type SystemSculptPlugin from "../../main";
import { ChatFavoritesService } from "../chatview/ChatFavoritesService";
import { openChatResumeDescriptor } from "../chatview/ChatResumeUtils";
import { ChatStorageService } from "../chatview/ChatStorageService";
import type { SystemSculptHistoryEntry, SystemSculptHistoryProvider } from "./types";

function joinMessageContent(messages: unknown[]): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return "";
      }
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function asTimestamp(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric;
}

export function createChatHistoryProvider(plugin: SystemSculptPlugin): SystemSculptHistoryProvider {
  return {
    id: "chat-history",
    loadEntries: async () => {
      const chatStorage = new ChatStorageService(plugin.app, plugin.settings.chatsDirectory || "SystemSculpt/Chats");
      const chatFavorites = ChatFavoritesService.getInstance(plugin);

      const summaries = await chatStorage.loadChats();
      const entries: SystemSculptHistoryEntry[] = summaries.map((summary) => {
        const timestampMs = asTimestamp(summary.lastModified);
        const title = String(summary.title || "Untitled Chat").trim() || "Untitled Chat";
        const isFavorite = chatFavorites.isFavorite(summary.id);
        const messageCount = Array.isArray(summary.messages) ? summary.messages.length : 0;
        const subtitle = `${messageCount} messages`;
        const searchText = [
          title,
          summary.id,
          joinMessageContent(summary.messages || []),
        ]
          .filter((segment) => segment.length > 0)
          .join("\n")
          .toLowerCase();

        return {
          id: `chat:${summary.id}`,
          kind: "chat",
          title,
          subtitle,
          timestampMs,
          searchText,
          badge: "Managed",
          metadataPath: summary.chatPath,
          isFavorite,
          toggleFavorite: async () => {
            await chatFavorites.toggleFavorite(summary.id);
            return chatFavorites.isFavorite(summary.id);
          },
          openPrimary: async () => {
            await openChatResumeDescriptor(plugin, {
              chatId: summary.id,
              title,
              chatPath: summary.chatPath,
              lastModified: timestampMs,
              messageCount,
            });
          },
        };
      });

      return entries;
    },
  };
}
