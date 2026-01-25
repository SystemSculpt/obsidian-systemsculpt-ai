import { setIcon } from "obsidian";
import { SystemSculptModel } from "../types/llm";
import { FavoritesService } from "../services/FavoritesService";

/**
 * A reusable component for toggling favorite status
 */
export class FavoriteToggle {
  public element: HTMLElement;
  private model: SystemSculptModel;
  private favoritesService: FavoritesService;
  private callback?: (model: SystemSculptModel, isFavorite: boolean) => void;
  private isAnimating: boolean = false;

  /**
   * Create a new favorite toggle
   * @param container - Container element to append to
   * @param model - The model to toggle favorite status for
   * @param favoritesService - The favorites service instance
   * @param callback - Optional callback when favorite status changes
   */
  constructor(
    container: HTMLElement,
    model: SystemSculptModel,
    favoritesService: FavoritesService,
    callback?: (model: SystemSculptModel, isFavorite: boolean) => void
  ) {
    this.model = model;
    this.favoritesService = favoritesService;
    this.callback = callback;

    // Create button element
    this.element = container.createDiv({
      cls: "systemsculpt-favorite-toggle",
      attr: {
        "aria-label": this.getAriaLabel(),
        "role": "button",
        "tabindex": "0",
        "aria-pressed": this.model.isFavorite === true ? "true" : "false"
      }
    });

    // Set initial state
    this.updateAppearance();

    // Add event listeners
    this.addEventListeners();
  }

  /**
   * Update the appearance based on favorite status
   */
  private updateAppearance(): void {
    this.element.empty();
    
    const isFavorite = this.model.isFavorite === true;
    
    // Update class
    if (isFavorite) {
      this.element.addClass("is-favorite");
      this.element.removeClass("not-favorite");
    } else {
      this.element.addClass("not-favorite");
      this.element.removeClass("is-favorite");
    }
    
    // Create and add icon with wrapper for better animation control
    const iconWrapper = this.element.createDiv({
      cls: "systemsculpt-favorite-icon-wrapper"
    });
    
    const iconEl = iconWrapper.createSpan({
      cls: "systemsculpt-favorite-icon"
    });
    
    // Use different icons for more clear visual distinction
    setIcon(iconEl, "star");
    
    // Update aria attributes
    this.element.setAttribute("aria-label", this.getAriaLabel());
    this.element.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    
    // Add a tooltip
    this.element.setAttribute("data-tooltip", this.getAriaLabel());
    
    // Add visual feedback element for animations
    if (!this.element.querySelector(".systemsculpt-favorite-feedback")) {
      const feedbackEl = this.element.createDiv({
        cls: "systemsculpt-favorite-feedback"
      });
    }
  }

  /**
   * Get appropriate aria label based on current state
   */
  private getAriaLabel(): string {
    return this.model.isFavorite === true 
      ? `Remove ${this.model.name} from favorites`
      : `Add ${this.model.name} to favorites`;
  }

  /**
   * Add event listeners to the button
   */
  private addEventListeners(): void {
    // Click event
    this.element.addEventListener("click", this.handleClick.bind(this));
    
    // Keyboard event (Enter or Space)
    this.element.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.handleClick(e);
      }
    });
    
    // Add focus and hover states for better accessibility
    this.element.addEventListener("focus", () => {
      this.element.addClass("is-focused");
    });
    
    this.element.addEventListener("blur", () => {
      this.element.removeClass("is-focused");
    });
    
    this.element.addEventListener("mouseenter", () => {
      this.element.addClass("is-hovered");
    });
    
    this.element.addEventListener("mouseleave", () => {
      this.element.removeClass("is-hovered");
    });
  }

  /**
   * Play animation when favorite status changes
   */
  private playStatusChangeAnimation(newState: boolean): void {
    if (this.isAnimating) return;
    
    this.isAnimating = true;
    
    const feedbackEl = this.element.querySelector(".systemsculpt-favorite-feedback") as HTMLElement;
    if (!feedbackEl) return;
    
    // Apply different animations based on new state
    if (newState) {
      // Favorited - expand outward animation
      feedbackEl.addClass("animate-favorite");
    } else {
      // Unfavorited - contract inward animation
      feedbackEl.addClass("animate-unfavorite");
    }
    
    // Remove animation classes after animation completes
    setTimeout(() => {
      feedbackEl.removeClass("animate-favorite");
      feedbackEl.removeClass("animate-unfavorite");
      this.isAnimating = false;
    }, 100); // Fast animation for instant feedback
  }

  /**
   * Handle click/keyboard activation
   */
  private handleClick(e: MouseEvent | KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    
    if (this.isAnimating) return;
    
    // Add active state for press feedback
    this.element.addClass("is-active");
    
    // Remove active state after short delay
    setTimeout(() => {
      this.element.removeClass("is-active");
    }, 50);
    
    // Toggle favorite status
    this.favoritesService.toggleFavorite(this.model).then(() => {
      // Update appearance
      this.updateAppearance();
      
      // Play animation
      this.playStatusChangeAnimation(this.model.isFavorite === true);
      
      // Call callback if provided
      if (this.callback) {
        this.callback(this.model, this.model.isFavorite === true);
      }
      // Emit an event for listeners
      this.element.dispatchEvent(new CustomEvent('ss-list-item-favorite-toggled', {
        bubbles: true,
        detail: { modelId: this.model.id, isFavorite: this.model.isFavorite === true }
      }));
    }).catch((error: Error) => {
    });
  }

  /**
   * Update the model reference (useful when the component is reused)
   */
  public updateModel(model: SystemSculptModel): void {
    this.model = model;
    this.updateAppearance();
  }
} 