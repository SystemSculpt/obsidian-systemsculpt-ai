import { setIcon } from "obsidian";
import { ChatFavoritesService } from "./ChatFavoritesService";

/**
 * Toggle button for chat favorites
 */
export class ChatFavoriteToggle {
  public element: HTMLElement;
  private chatId: string;
  private service: ChatFavoritesService;
  private callback?: (chatId: string, isFavorite: boolean) => void;

  constructor(
    container: HTMLElement,
    chatId: string,
    service: ChatFavoritesService,
    callback?: (chatId: string, isFavorite: boolean) => void
  ) {
    this.chatId = chatId;
    this.service = service;
    this.callback = callback;

    this.element = container.createDiv({
      cls: "systemsculpt-favorite-toggle",
      attr: { role: "button", tabindex: "0" }
    });

    this.updateAppearance();
    this.addEventListeners();
  }

  private updateAppearance(): void {
    this.element.empty();
    const isFav = this.service.isFavorite(this.chatId);
    const icon = this.element.createSpan();
    setIcon(icon, "star");
    if (isFav) this.element.addClass("is-favorite");
    else this.element.removeClass("is-favorite");
    this.element.setAttribute("aria-pressed", isFav ? "true" : "false");
  }

  private addEventListeners(): void {
    this.element.addEventListener("click", this.handleClick.bind(this));
    this.element.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.handleClick(e);
      }
    });
  }

  private handleClick(e: MouseEvent | KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.service.toggleFavorite(this.chatId).then(() => {
      const isFav = this.service.isFavorite(this.chatId);
      this.updateAppearance();
      if (this.callback) this.callback(this.chatId, isFav);
    });
  }
}
