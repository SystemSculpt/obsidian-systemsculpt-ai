import { setIcon } from "obsidian";
import { FavoritesService } from "../services/FavoritesService";

/**
 * Component for toggling favorites-only filter
 */
export class FavoritesFilter {
  public element: HTMLElement;
  private favoritesService: FavoritesService;
  private callback?: (showFavoritesOnly: boolean) => void;
  private iconEl: HTMLElement;
  private textEl: HTMLElement;

  /**
   * Create a new favorites filter toggle
   * @param container - Container element to append to
   * @param favoritesService - The favorites service instance
   * @param callback - Optional callback when filter state changes
   */
  constructor(
    container: HTMLElement,
    favoritesService: FavoritesService,
    callback?: (showFavoritesOnly: boolean) => void
  ) {
    this.favoritesService = favoritesService;
    this.callback = callback;

    // Create button element
    this.element = container.createDiv({
      cls: "systemsculpt-favorites-filter",
      attr: {
        "aria-label": "Show favorites only",
        "role": "button",
        "tabindex": "0"
      }
    });

    // Add star icon
    this.iconEl = this.element.createSpan({
      cls: "systemsculpt-favorites-icon"
    });
    setIcon(this.iconEl, "star");

    // Add text
    this.textEl = this.element.createSpan({
      text: "Favorites only",
      cls: "systemsculpt-favorites-label"
    });

    // Set initial state
    this.updateAppearance();

    // Add event listeners
    this.addEventListeners();

    // Add global event listener for favorites changes
    document.addEventListener('systemsculpt:favorites-filter-changed', () => {
      this.updateAppearance();
    });
  }

  /**
   * Update the appearance based on filter state
   */
  private updateAppearance(): void {
    const showFavoritesOnly = this.favoritesService.getShowFavoritesOnly();
    
    // Update class
    if (showFavoritesOnly) {
      this.element.addClass("is-active");
      this.textEl.setText("Favorites only");
    } else {
      this.element.removeClass("is-active");
      this.textEl.setText("Show favorites");
    }
    
    // Update aria attributes
    this.element.setAttribute("aria-pressed", showFavoritesOnly ? "true" : "false");
    this.element.setAttribute("aria-label", showFavoritesOnly ? "Click to show all models" : "Click to show favorites only");
    
    // Update tooltip
    this.element.setAttribute("data-tooltip", showFavoritesOnly ? "Click to show all models" : "Click to show favorites only");
  }

  /**
   * Add event listeners for click and keyboard interaction
   */
  private addEventListeners(): void {
    this.element.addEventListener("click", this.handleClick.bind(this));
    this.element.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.handleClick(e);
      }
    });
    
    // Add focus/blur listeners for accessibility
    this.element.addEventListener("focus", () => {
      this.element.addClass("is-focused");
    });
    
    this.element.addEventListener("blur", () => {
      this.element.removeClass("is-focused");
    });
  }

  /**
   * Handle click/keyboard activation
   */
  private handleClick(e: MouseEvent | KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    
    // Add active state temporarily
    this.element.addClass("is-clicking");
    setTimeout(() => {
      this.element.removeClass("is-clicking");
    }, 200);
    
    // Toggle filter state
    this.favoritesService.toggleShowFavoritesOnly().then((newState: boolean) => {
      // Update appearance
      this.updateAppearance();
      
      // Call callback if provided
      if (this.callback) {
        this.callback(newState);
      }
    }).catch((error: Error) => {
    });
  }

  /**
   * Set the filter state programmatically
   */
  public async setFilterState(showFavoritesOnly: boolean): Promise<void> {
    if (this.favoritesService.getShowFavoritesOnly() !== showFavoritesOnly) {
      await this.favoritesService.toggleShowFavoritesOnly();
      this.updateAppearance();
    }
  }
} 