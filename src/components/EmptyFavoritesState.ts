import { setIcon } from "obsidian";

/**
 * Component for displaying an empty state when no favorites are available
 */
export class EmptyFavoritesState {
  public element: HTMLElement;

  /**
   * Create a new empty favorites state component
   * @param container - Container element to append to
   * @param showingFavoritesOnly - Whether we're currently showing favorites only
   */
  constructor(
    container: HTMLElement,
    showingFavoritesOnly: boolean = false
  ) {
    // Create main container
    this.element = container.createDiv({
      cls: "systemsculpt-favorites-empty-state"
    });

    // Add icon
    const iconEl = this.element.createSpan();
    setIcon(iconEl, "star");

    // Add heading
    const heading = this.element.createEl("h4");
    
    // Add message
    const message = this.element.createEl("p");
    
    if (showingFavoritesOnly) {
      heading.setText("No favorite models");
      message.setText("You haven't favorited any models yet. Try turning off the favorites filter and mark some models as favorites.");
    } else {
      heading.setText("Mark models as favorites");
      message.setText("Click the star icon next to any model to add it to your favorites. Favorite models will appear at the top of the list.");
    }
  }

  /**
   * Update the empty state based on filter status
   */
  public updateForFilterState(showingFavoritesOnly: boolean): void {
    const heading = this.element.querySelector("h4");
    const message = this.element.querySelector("p");
    
    if (!heading || !message) return;
    
    if (showingFavoritesOnly) {
      heading.setText("No favorite models");
      message.setText("You haven't favorited any models yet. Try turning off the favorites filter and mark some models as favorites.");
    } else {
      heading.setText("Mark models as favorites");
      message.setText("Click the star icon next to any model to add it to your favorites. Favorite models will appear at the top of the list.");
    }
  }
} 