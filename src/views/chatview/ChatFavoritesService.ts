import SystemSculptPlugin from "../../main";

/**
 * Service for managing favorite chats
 */
export class ChatFavoritesService {
  private static instance: ChatFavoritesService;
  private constructor(private plugin: SystemSculptPlugin) {}

  /**
   * Get the ChatFavoritesService instance
   */
  public static getInstance(plugin: SystemSculptPlugin): ChatFavoritesService {
    if (!ChatFavoritesService.instance) {
      ChatFavoritesService.instance = new ChatFavoritesService(plugin);
    }
    return ChatFavoritesService.instance;
  }

  /** Add a chat to favorites */
  public async addFavorite(chatId: string): Promise<void> {
    if (this.plugin.settings.favoriteChats.includes(chatId)) return;

    const updated = [...this.plugin.settings.favoriteChats, chatId];
    await this.plugin.getSettingsManager().updateSettings({ favoriteChats: updated });
    this.emitFavoritesChanged();
  }

  /** Remove a chat from favorites */
  public async removeFavorite(chatId: string): Promise<void> {
    const updated = this.plugin.settings.favoriteChats.filter(id => id !== chatId);
    await this.plugin.getSettingsManager().updateSettings({ favoriteChats: updated });
    this.emitFavoritesChanged();
  }

  /** Toggle favorite status */
  public async toggleFavorite(chatId: string): Promise<void> {
    if (this.isFavorite(chatId)) {
      await this.removeFavorite(chatId);
    } else {
      await this.addFavorite(chatId);
    }
  }

  /** Check if a chat is a favorite */
  public isFavorite(chatId: string): boolean {
    return this.plugin.settings.favoriteChats.includes(chatId);
  }

  /** Get all favorite chat IDs */
  public getFavorites(): string[] {
    return [...this.plugin.settings.favoriteChats];
  }

  /** Emit an event when favorites change */
  private emitFavoritesChanged(): void {
    document.dispatchEvent(
      new CustomEvent('systemsculpt:chat-favorites-changed', {
        detail: { favorites: this.plugin.settings.favoriteChats }
      })
    );
  }
}
