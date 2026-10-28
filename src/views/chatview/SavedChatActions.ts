import { Notice, TFile, normalizePath, type App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { showConfirm } from "../../core/ui/notifications";
import { normalizeChatTitle } from "../../utils/titleUtils";
import { toSafeVaultFileName } from "../../utils/vaultFileName";
import type { ChatHistoryRow } from "../history/chatHistoryRows";
import type { ChatStorageService } from "./ChatStorageService";
import type { AgentTranscriptRepository } from "./AgentTranscriptRepository";
import { nativeChatSessions } from "./NativeChatSessions";

type OpenSavedChat = Readonly<{
  view: {
    readonly chatId: string;
    readonly chatTitle: string;
    setTitle(title: string, save: boolean): Promise<void>;
  };
  transcript: AgentTranscriptRepository;
  reset: () => Promise<void>;
}>;

type SavedChatActionsOptions = Readonly<{
  app: App;
  plugin: SystemSculptPlugin;
  storage: ChatStorageService;
  openChats: (chatId: string) => readonly OpenSavedChat[];
}>;

/** Coordinates durable history changes with every open or retained native chat. */
export class SavedChatActions {
  constructor(private readonly options: SavedChatActionsOptions) {}

  async toggleFavorite(chatId: string): Promise<void> {
    const { plugin } = this.options;
    const favorites = plugin.settings.favoriteChats ?? [];
    await plugin.getSettingsManager().updateSettings({
      favoriteChats: favorites.includes(chatId)
        ? favorites.filter((id) => id !== chatId)
        : [...favorites, chatId],
    });
  }

  /** Rename only the durable title; stale open copies must never rewrite the transcript. */
  async rename(row: Pick<ChatHistoryRow, "chatId" | "chatPath" | "title">, title: string): Promise<void> {
    const { plugin, storage, openChats } = this.options;
    const normalized = normalizeChatTitle(title) || row.title;
    const open = openChats(row.chatId).map(({ view, transcript }) => ({ view, transcript, title: view.chatTitle }));
    const retained = nativeChatSessions(plugin).get(row.chatId)?.transcript;
    const retainedTitle = retained?.snapshot().title;
    try {
      retained?.setTitle(normalized);
      for (const { view } of open) await view.setTitle(normalized, false);
      await retained?.idle();
      // A write already in flight may still carry the previous title.
      await Promise.all(open.map(({ transcript }) => transcript.idle()));
      await storage.renameChat(row.chatPath, row.chatId, normalized);
    } catch {
      if (retainedTitle && retained?.snapshot().title === normalized) retained.setTitle(retainedTitle);
      for (const { view, title: previousTitle } of open) {
        if (view.chatId === row.chatId && view.chatTitle === normalized) await view.setTitle(previousTitle, false);
      }
      new Notice("This chat couldn't be renamed.", 5000);
    }
  }

  async delete(row: ChatHistoryRow): Promise<boolean> {
    const { app, plugin, openChats } = this.options;
    const { confirmed } = await showConfirm(
      app,
      `"${row.title}" will be moved to the trash.`,
      { title: "Delete chat?", primaryButton: "Delete", icon: "trash-2" },
    );
    if (!confirmed) return false;
    try {
      const open = openChats(row.chatId);
      // Explicit deletion cancels even a native run with no view attached and
      // drains its final write before the note is moved to trash.
      await nativeChatSessions(plugin).delete(row.chatId);
      await Promise.all(open.map(({ reset }) => reset()));
      await Promise.all(open.map(({ transcript }) => transcript.idle()));
      const file = app.vault.getAbstractFileByPath(row.chatPath);
      if (!(file instanceof TFile)) return false;
      await app.fileManager.trashFile(file);
    } catch {
      new Notice("This chat couldn't be deleted.", 5000);
      return false;
    }
    if (row.favorite) await this.toggleFavorite(row.chatId).catch(() => undefined);
    return true;
  }

  async exportToNote(title: () => string, exportMarkdown: () => Promise<string>): Promise<void> {
    const { app } = this.options;
    try {
      const markdown = await exportMarkdown();
      const parent = app.fileManager.getNewFileParent("").path;
      const base = toSafeVaultFileName(title(), { fallback: "Chat" });
      let path = normalizePath(`${parent}/${base} (export).md`);
      for (let copy = 2; app.vault.getAbstractFileByPath(path); copy += 1) {
        path = normalizePath(`${parent}/${base} (export ${copy}).md`);
      }
      const file = await app.vault.create(path, markdown);
      await app.workspace.getLeaf("tab").openFile(file);
    } catch {
      new Notice("This chat couldn't be exported.", 5000);
    }
  }
}
