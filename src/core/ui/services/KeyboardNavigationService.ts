import { Component } from "obsidian";

/**
 * Options for configuring keyboard navigation behavior
 */
export interface KeyboardNavigationOptions {
  // Whether multiple items can be selected at once
  multiSelect?: boolean;
  
  // Whether to close the container on selection
  closeOnSelect?: boolean;
  
  // Callback for when Enter (selection) is triggered
  onSelect?: (index: number) => void;
  
  // Callback for when Toggle is triggered
  onToggle?: (index: number) => void;
  
  // Callback for when Confirm (Cmd/Ctrl+Enter) is triggered
  onConfirm?: () => void;
  
  // Callback to focus an item at the given index
  onFocus?: (index: number) => void;
  
  // Whether Space key can be used to toggle selection
  allowSpaceToggle?: boolean;
}

/**
 * KeyboardNavigationService provides standardized keyboard navigation
 * handling for lists of selectable items.
 * 
 * This service isolates keyboard handling logic from UI components,
 * ensuring consistent behavior across different components.
 */
export class KeyboardNavigationService extends Component {
  private focusedIndex: number = -1;
  private itemCount: number = 0;
  private options: KeyboardNavigationOptions;

  /**
   * Create a new KeyboardNavigationService
   * 
   * @param {HTMLElement} container - The element to attach key listeners to
   * @param {KeyboardNavigationOptions} options - Configuration options
   */
  constructor(
    private container: HTMLElement,
    options: KeyboardNavigationOptions = {}
  ) {
    super();
    
    this.options = {
      multiSelect: false,
      closeOnSelect: true,
      allowSpaceToggle: false,
      ...options
    };
    
    // Set up event handlers
    this.registerDomEvent(this.container, 'keydown', this.handleKeyDown.bind(this));
  }
  
  /**
   * Update the number of available items
   */
  public setItemCount(count: number): void {
    this.itemCount = count;
    
    // Reset focus if we no longer have that many items
    if (this.focusedIndex >= count) {
      this.focusedIndex = count > 0 ? count - 1 : -1;
    }
  }
  
  /**
   * Get the currently focused item index
   */
  public getFocusedIndex(): number {
    return this.focusedIndex;
  }
  
  /**
   * Set the focused item index
   */
  public setFocusedIndex(index: number): void {
    if (index >= -1 && index < this.itemCount) {
      this.focusedIndex = index;
      
      if (this.options.onFocus && index >= 0) {
        this.options.onFocus(index);
      }
    }
  }
  
  /**
   * Clear the current focus
   */
  public clearFocus(): void {
    this.focusedIndex = -1;
  }
  
  /**
   * Handle keyboard events
   */
  private handleKeyDown(event: KeyboardEvent): void {
    // Only process if we have items
    if (this.itemCount === 0) return;
    
    // Handle arrow navigation
    if (event.key === "ArrowDown") {
      event.preventDefault();
      
      // Move focus down
      const newIndex = this.focusedIndex < 0 
        ? 0 
        : Math.min(this.focusedIndex + 1, this.itemCount - 1);
        
      this.setFocusedIndex(newIndex);
    } 
    else if (event.key === "ArrowUp") {
      event.preventDefault();
      
      // Move focus up
      const newIndex = this.focusedIndex < 0 
        ? 0 
        : Math.max(this.focusedIndex - 1, 0);
        
      this.setFocusedIndex(newIndex);
    } 
    // Handle selection with Enter
    else if (event.key === "Enter" && this.focusedIndex !== -1) {
      event.preventDefault();
      
      if ((event.metaKey || event.ctrlKey) && this.options.multiSelect) {
        // Command+Enter or Ctrl+Enter confirms the current selection(s)
        if (this.options.onConfirm) {
          this.options.onConfirm();
        }
      } else {
        // Regular Enter triggers selection or toggle
        if (this.options.onSelect) {
          this.options.onSelect(this.focusedIndex);
        }
        
        if (this.options.multiSelect && this.options.onToggle) {
          this.options.onToggle(this.focusedIndex);
        }
      }
    }
    // Handle toggle with Space
    else if (event.code === "Space" && this.focusedIndex !== -1 && this.options.allowSpaceToggle) {
      event.preventDefault();
      
      if (this.options.onToggle) {
        this.options.onToggle(this.focusedIndex);
      }
    }
    // Handle Tab navigation
    else if (event.key === "Tab") {
      // Note: We don't prevent default for Tab - this allows
      // normal tab navigation between focusable elements
      
      if (this.itemCount > 0) {
        if (event.shiftKey) {
          // Focus previous
          const newIndex = this.focusedIndex <= 0 
            ? this.itemCount - 1 
            : this.focusedIndex - 1;
            
          this.setFocusedIndex(newIndex);
        } else {
          // Focus next
          const newIndex = this.focusedIndex >= this.itemCount - 1 
            ? 0 
            : this.focusedIndex + 1;
            
          this.setFocusedIndex(newIndex);
        }
      }
    }
  }
} 