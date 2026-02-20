import { App, setIcon, debounce } from "obsidian";
import { StandardModal } from "./StandardModal";
import { KeyboardNavigationService } from "../../services/KeyboardNavigationService";
import { SystemSculptModel } from "../../../../types/llm";
import { FavoritesService } from "../../../../services/FavoritesService";
import { FavoriteToggle } from "../../../../components/FavoriteToggle";
import { MobileDetection } from "../../../../utils/MobileDetection";

export interface ListItem {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  badge?: string;
  selected?: boolean;
  thumbnail?: string; // URL or path to thumbnail image
  filePath?: string;  // Full file path for retrieval
  fileType?: string;  // File type/extension for identifying images
  _ssModel?: SystemSculptModel;
  metadata?: {
    provider?: string;
    contextLength?: number;
    isFavorite?: boolean;
    isNew?: boolean;
    isBeta?: boolean;
    isDeprecated?: boolean;
    capabilities?: string[];
    [key: string]: any; // Allow additional metadata
  };
}

export interface ListSelectionOptions {
  title: string;
  description?: string;
  emptyText?: string;
  placeholder?: string;
  filters?: {
    id: string;
    label: string;
    icon?: string;
    active?: boolean;
  }[];
  size?: "small" | "medium" | "large" | "fullwidth";
  withSearch?: boolean;
  withFilters?: boolean;
  closeOnSelect?: boolean;
  multiSelect?: boolean;
  customContent?: (containerEl: HTMLElement) => void;
  favoritesService?: FavoritesService;
}

/**
 * ListSelectionModal is a standardized modal for selecting items from a list,
 * such as models, contexts, templates, etc.
 */
export class ListSelectionModal extends StandardModal {
  private items: ListItem[] = [];
  private filteredItems: ListItem[] = [];
  private selectedIds: Set<string> = new Set();
  private searchInput: HTMLInputElement | null = null;
  private listContainer: HTMLElement | null = null;
  private emptyStateEl: HTMLElement | null = null;
  private resolvePromise: ((selectedItems: ListItem[]) => void) | null = null;
  private options: ListSelectionOptions;
  private focusedItemIndex: number = -1;
  private itemElements: HTMLElement[] = [];
  private keyboardNavService: KeyboardNavigationService;
  private customSearchHandler: ((query: string) => Promise<ListItem[]>) | null = null;
  private favoritesService: FavoritesService | null = null;

  constructor(app: App, items: ListItem[], options: ListSelectionOptions) {
    super(app);
    
    this.items = items;
    this.filteredItems = [...items];
    this.options = {
      emptyText: "No items found",
      placeholder: "Search...",
      withSearch: true,
      withFilters: false,
      closeOnSelect: !options.multiSelect,
      multiSelect: false,
      size: "medium",
      ...options
    };
    
    // Store favoritesService if provided
    this.favoritesService = options.favoritesService || null;
    
    // Setup initial selection state
    this.items.forEach(item => {
      if (item.selected) {
        this.selectedIds.add(item.id);
      }
    });
    
    // Set modal size
    if (this.options.size) {
      this.setSize(this.options.size);
    }
  }

  onOpen() {
    super.onOpen();
    
    // Add title and close button
    this.addTitle(this.options.title, this.options.description);
    
    // Add custom content if provided
    if (this.options.customContent) {
      const customContentEl = this.contentEl.createDiv("ss-modal__custom-content");
      this.options.customContent(customContentEl);
    }
    
    // Add search if enabled
    if (this.options.withSearch) {
      // Create a debounced version of the search handler
      const debouncedSearchHandler = debounce((query: string) => {
        this.handleSearch(query);
      }, 300, true); // Debounce by 300ms, execute immediately on first call then wait

      this.searchInput = this.addSearchBar(
        this.options.placeholder || "Search...",
        debouncedSearchHandler // Use the debounced handler
      );
    }
    
    // Add filters if enabled
    if (this.options.withFilters && this.options.filters && this.options.filters.length > 0) {
      this.addFilterButtons(
        this.options.filters,
        this.handleFilterToggle.bind(this)
      );
    }
    
    // Create list container
    this.listContainer = this.contentEl.createDiv("ss-modal__list");
    
    // Create empty state element (hidden initially)
    this.emptyStateEl = this.contentEl.createDiv({ 
      cls: "ss-modal__empty-state",
      text: this.options.emptyText 
    });
    this.emptyStateEl.style.display = "none";
    
    // Render initial items
    this.renderItems();
    
    // Add footer buttons for multi-select mode
    if (this.options.multiSelect) {
      this.addActionButton("Cancel", () => this.close(), false);
      this.addActionButton("Select", this.handleConfirmSelection.bind(this), true);
    }
    
    // Focus search input if present
    if (this.searchInput) {
      setTimeout(() => this.searchInput?.focus(), 50);
    }
    
    // Initialize keyboard navigation
    this.keyboardNavService = new KeyboardNavigationService(this.modalEl, {
      multiSelect: this.options.multiSelect,
      closeOnSelect: this.options.closeOnSelect,
      onSelect: (index) => {
        if (index >= 0 && index < this.itemElements.length) {
          // Trigger click on the item
          this.itemElements[index].click();
        }
      },
      onToggle: (index) => {
        if (index >= 0 && index < this.itemElements.length) {
          // For multi-select, clicking already handles toggling
          this.itemElements[index].click();
        }
      },
      onConfirm: () => {
        if (this.options.multiSelect) {
          this.handleConfirmSelection();
        }
      },
      onFocus: (index) => {
        this.focusItem(index);
      }
    });
    
    // Set initial item count
    this.keyboardNavService.setItemCount(this.itemElements.length);
  }

  /**
   * Handle search input changes
   * - If a custom search handler is set, use that
   * - Otherwise, use the default filtering
   */
  private handleSearch(query: string) {
    if (this.customSearchHandler) {
      this.customSearchHandler(query).then(items => {
        // Verify we got valid results back
        if (!items || !Array.isArray(items)) {
          this.filteredItems = [];
        } else {
          this.filteredItems = items;
        }
        
        this.renderItems();
        
        // Update keyboard navigation item count
        this.keyboardNavService.setItemCount(this.itemElements.length);
        
        // Reset focus
        this.keyboardNavService.clearFocus();
      }).catch(error => {
        this.filteredItems = [];
        this.renderItems();
        
        if (this.emptyStateEl) {
          this.emptyStateEl.textContent = "Error searching files. Please try again.";
          this.emptyStateEl.style.display = "flex";
        }
        
        this.keyboardNavService.setItemCount(0);
        this.keyboardNavService.clearFocus();
      });
    } else {
      if (!query) {
        this.filteredItems = [...this.items];
      } else {
        const lowerQuery = query.toLowerCase();
        this.filteredItems = this.items.filter(item => 
          item.title.toLowerCase().includes(lowerQuery) || 
          (item.description && item.description.toLowerCase().includes(lowerQuery))
        );
      }
      
      this.renderItems();
      
      // Update keyboard navigation item count
      this.keyboardNavService.setItemCount(this.itemElements.length);
      
      // Reset focus
      this.keyboardNavService.clearFocus();
    }
  }

  /**
   * Handle filter toggle
   */
  private handleFilterToggle(filterId: string, active: boolean) {
    // This will need to be implemented based on specific filter logic
    // For now, just re-render the items
    this.renderItems();
    
    // Update keyboard navigation
    this.keyboardNavService.setItemCount(this.itemElements.length);
    this.keyboardNavService.clearFocus();
  }

  /**
   * Focus the item at the given index
   */
  private focusItem(index: number) {
    if (index === -1 || index >= this.itemElements.length) return;
    
    const item = this.itemElements[index];
    if (!item) return;
    
    // Remove focus from all items
    this.itemElements.forEach(el => {
      if (el) {
        el.classList.remove("ss-focused");
      }
    });
    
    // Add focus to the target item and scroll it into view
    item.classList.add("ss-focused");
    
    try {
      item.scrollIntoView({ block: "nearest" });
    } catch (e) {
      // Ignore scrolling errors
    }
  }

  /**
   * Handle confirm selection button click (for multi-select mode)
   */
  private handleConfirmSelection() {
    const selectedItems = this.items.filter(item => this.selectedIds.has(item.id));
    if (this.resolvePromise) {
      this.resolvePromise(selectedItems);
    }
    this.close();
  }

  /**
   * Render the filtered items
   */
  private renderItems() {
    if (!this.listContainer) return;
    
    // Clear existing items
    this.listContainer.empty();
    this.itemElements = [];
    
    // Show empty state if no items
    if (this.filteredItems.length === 0) {
      if (this.emptyStateEl) {
        this.emptyStateEl.style.display = "flex";
      }
      return;
    }
    
    // Hide empty state
    if (this.emptyStateEl) {
      this.emptyStateEl.style.display = "none";
    }

    // Remove any existing previews
    this.removePreviewContainer();
    
    // Create item elements
    this.filteredItems.forEach((item, index) => {
      const itemEl = this.createListItem(
        item,
        index
      );
      
      // Add selected state
      if (this.selectedIds.has(item.id)) {
        itemEl.classList.add("ss-active");
      }
      
      // Add data attribute
      itemEl.setAttribute("data-item-id", item.id);
      
      // Make element focusable
      itemEl.setAttribute("tabindex", "0");
      
      // Store item element for keyboard navigation
      this.itemElements.push(itemEl);
      
      // Add click handler for selection (ignore clicks on favorite toggle)
      this.registerDomEvent(itemEl, "click", (ev: MouseEvent) => {
        const target = ev.target as HTMLElement;
        if (target && target.closest && target.closest('.systemsculpt-favorite-toggle')) {
          return; // Let the favorite toggle handle its own click
        }
        if (this.options.multiSelect) {
          // Toggle selection
          if (this.selectedIds.has(item.id)) {
            this.selectedIds.delete(item.id);
            itemEl.classList.remove("ss-active");
          } else {
            this.selectedIds.add(item.id);
            itemEl.classList.add("ss-active");
          }
        } else {
          // Single selection
          this.selectedIds.clear();
          this.selectedIds.add(item.id);
          
          if (this.resolvePromise) {
            this.resolvePromise([item]);
          }
          
          if (this.options.closeOnSelect) {
            this.close();
          } else {
            // Update UI to show only this item as selected
            this.itemElements.forEach(el => {
              if (el) {
                el.classList.remove("ss-active");
              }
            });
            itemEl.classList.add("ss-active");
          }
        }
      });
      
      if (this.listContainer) {
        this.listContainer.appendChild(itemEl);
      }
    });
    
    // Emit a custom event after items are rendered
    if (this.listContainer) {
       this.listContainer.dispatchEvent(new CustomEvent('ss-items-rendered'));
    }
    
    // Update keyboard navigation
    if (this.keyboardNavService) {
      this.keyboardNavService.setItemCount(this.itemElements.length);
    }
  }

  /**
   * Create a list item component specifically for this modal,
   * handling model-specific data and favorite toggles.
   * Renamed from createItem to avoid conflict with base class signature.
   */
  createListItem(
    itemData: ListItem,
    index: number
  ) {
    const itemEl = document.createElement("div");
    itemEl.className = "ss-modal__item";
    
    // Add data attribute for potential styling based on underlying model provider
    if (itemData._ssModel) {
       itemEl.setAttribute('data-provider', itemData._ssModel.provider);
       if (itemData._ssModel.isFavorite) {
          itemEl.classList.add('has-favorite');
       }
    }
    
    // Add additional classes if provided
    if ((itemData as any).additionalClasses) {
       itemEl.classList.add((itemData as any).additionalClasses);
    }
    
    // Use properties from itemData
    const { title, description, icon, badge, thumbnail, fileType } = itemData;

    // Add icon if provided
    if (icon) {
      const iconEl = itemEl.createDiv("ss-modal__item-icon");
      setIcon(iconEl, icon);
    }
    
    // Add content (title and description)
    const content = itemEl.createDiv("ss-modal__item-content");
    content.createDiv({ text: title, cls: "ss-modal__item-title" });
    
    if (description) {
      content.createDiv({ text: description, cls: "ss-modal__item-description" });
    }
    
    // Add badge if provided
    if (badge) {
      const badgeEl = itemEl.createSpan({ text: badge, cls: "ss-modal__item-badge" });
    }

    // Add favorite toggle if applicable
    if (this.favoritesService && itemData._ssModel) {
       const model = itemData._ssModel;
       const buttonContainer = itemEl.createDiv('systemsculpt-favorite-button-container');

       // Create the toggle inside the container
       const favoriteToggle = new FavoriteToggle(
         buttonContainer,
         model,
         this.favoritesService,
         (updatedModel, isFavorite) => {
           // Update the item's class based on favorite status
           if (isFavorite) {
             itemEl.classList.add('has-favorite');
           } else {
             itemEl.classList.remove('has-favorite');
           }
           
           // Emit a custom event from the item element for the parent modal to handle
           itemEl.dispatchEvent(new CustomEvent('ss-list-item-favorite-toggled', {
             bubbles: true, // Allow event to bubble up
             detail: { modelId: updatedModel.id, isFavorite: isFavorite, index: index }
           }));
         }
       );
    }

    // Add thumbnail for image files
    if (thumbnail && fileType && this.isImageType(fileType)) {
      const thumbnailContainer = itemEl.createDiv("ss-modal__item-thumbnail");
      const img = document.createElement("img");
      img.src = thumbnail;
      img.alt = title;
      img.loading = "lazy"; // Lazy load images for better performance
      thumbnailContainer.appendChild(img);
      
      // Handler for showing image preview
      const showPreviewHandler = (e: MouseEvent) => {
        this.showPreview(thumbnail!, title, e);
        e.stopPropagation(); // Prevent triggering item selection
      };
      
      // For desktop: add hover and click preview
      if (!this.isMobileDevice()) {
        this.registerDomEvent(thumbnailContainer, "mouseenter", showPreviewHandler);
        this.registerDomEvent(thumbnailContainer, "mouseleave", () => this.hidePreview());
        this.registerDomEvent(thumbnailContainer, "click", showPreviewHandler);
      } else {
        // For mobile: add tap to expand behavior
        this.registerDomEvent(thumbnailContainer, "click", (e) => {
          e.stopPropagation(); // Prevent item selection
          this.toggleExpandedPreview(itemEl, thumbnail!, title);
        });
      }
    }
    
    return itemEl;
  }

  /**
   * Check if file type is an image type
   */
  private isImageType(fileType: string): boolean {
    const imageTypes = ['png', 'jpg', 'jpeg', 'svg', 'webp'];
    return imageTypes.includes(fileType.toLowerCase());
  }

  /**
   * Detect if the device is mobile
   */
  private isMobileDevice(): boolean {
    // Use the comprehensive mobile detection utility
    return MobileDetection.getInstance().isMobileDevice();
  }

  /**
   * Show preview on hover (for desktop)
   */
  private showPreview(imageUrl: string, title: string, event: MouseEvent): void {
    this.removePreviewContainer(); // Remove any existing previews
    
    const previewContainer = document.createElement("div");
    previewContainer.className = "ss-preview-container";
    
    // Add image title
    const titleEl = document.createElement("div");
    titleEl.className = "ss-preview-title";
    titleEl.textContent = title;
    previewContainer.appendChild(titleEl);
    
    // Add image
    const previewImg = document.createElement("img");
    previewImg.src = imageUrl;
    previewImg.alt = title;
    previewImg.onload = () => {
      // Adjust container size based on image aspect ratio
      const aspectRatio = previewImg.naturalWidth / previewImg.naturalHeight;
      if (aspectRatio > 1.5) {
        // Wide image - maximize width
        previewContainer.style.width = "350px";
        previewContainer.style.height = "auto";
      } else if (aspectRatio < 0.7) {
        // Tall image - maximize height
        previewContainer.style.width = "auto";
        previewContainer.style.height = "350px";
      } else {
        // Balanced image - square-ish
        previewContainer.style.width = "300px";
        previewContainer.style.height = "300px";
      }
    };
    
    previewContainer.appendChild(previewImg);
    document.body.appendChild(previewContainer);
    
    // Position the preview near the cursor but not directly under it
    const offset = 20;
    
    // Calculate the preview size for positioning
    // Use default values initially, will be updated on image load
    const containerWidth = 300;
    const containerHeight = 300;
    
    // Calculate position to ensure preview stays on screen
    let left = event.clientX + offset;
    let top = event.clientY + offset;
    
    // Adjust if would go off-screen right
    if (left + containerWidth > window.innerWidth) {
      left = Math.max(0, window.innerWidth - containerWidth - offset);
    }
    
    // Adjust if would go off-screen bottom
    if (top + containerHeight > window.innerHeight) {
      top = Math.max(0, window.innerHeight - containerHeight - offset);
    }
    
    previewContainer.style.left = `${left}px`;
    previewContainer.style.top = `${top}px`;
  }

  /**
   * Hide preview on mouse leave
   */
  private hidePreview(): void {
    this.removePreviewContainer();
  }

  /**
   * Toggle expanded preview (for mobile)
   */
  private toggleExpandedPreview(itemEl: HTMLElement, imageUrl: string, title: string): void {
    // Check if already expanded
    if (itemEl.classList.contains("expanded")) {
      // Remove expanded class and preview
      itemEl.classList.remove("expanded");
      const previewEl = itemEl.querySelector(".ss-modal__item-preview");
      if (previewEl) {
        previewEl.remove();
      }
    } else {
      // Expand and add preview
      itemEl.classList.add("expanded");
      
      // Create and add preview element
      const previewContainer = document.createElement("div");
      previewContainer.className = "ss-modal__item-preview";
      
      const previewImg = document.createElement("img");
      previewImg.src = imageUrl;
      previewImg.alt = title;
      
      previewContainer.appendChild(previewImg);
      itemEl.appendChild(previewContainer);
    }
  }

  /**
   * Remove any existing preview container
   */
  private removePreviewContainer(): void {
    const existingPreview = document.querySelector(".ss-preview-container");
    if (existingPreview) {
      existingPreview.remove();
    }
  }

  onClose() {
    // Remove any previews when closing
    this.removePreviewContainer();
    
    // Clean up keyboard navigation service
    if (this.keyboardNavService) {
      this.keyboardNavService.unload();
    }
    
    // If closed without selection in multi-select mode, return empty array
    if (this.options.multiSelect && this.resolvePromise) {
      const selectedItems = this.items.filter(item => this.selectedIds.has(item.id));
      this.resolvePromise(selectedItems);
    }
    
    super.onClose();
  }

  /**
   * Set a custom search handler function
   */
  public setCustomSearchHandler(handler: (query: string) => Promise<ListItem[]>) {
    this.customSearchHandler = handler;
  }

  /**
   * Update the list items and refresh the view
   * @param items New list items to display
   */
  public setItems(items: ListItem[]): void {
    // Validate items input
    if (!items || !Array.isArray(items)) {
      return;
    }
    
    // Update the full list of items
    this.items = items;
    
    // If there's an active search query and search input exists, reapply the filter
    if (this.searchInput && this.searchInput.value) {
      if (this.customSearchHandler) {
        // If there's a custom search handler, use it
        this.customSearchHandler(this.searchInput.value).then(filteredItems => {
          // Verify we got valid results back
          if (!filteredItems || !Array.isArray(filteredItems)) {
            this.filteredItems = [];
          } else {
            this.filteredItems = filteredItems;
          }
          
          this.renderItems();
          
          // Update keyboard navigation item count
          if (this.keyboardNavService) {
            this.keyboardNavService.setItemCount(this.itemElements.length);
            this.keyboardNavService.clearFocus();
          }
        }).catch(error => {
          // Fall back to default filtering on error
          const query = this.searchInput?.value.toLowerCase() || "";
          this.filteredItems = this.items.filter(item => 
            item.title.toLowerCase().includes(query) || 
            (item.description && item.description.toLowerCase().includes(query))
          );
          this.renderItems();
          
          if (this.keyboardNavService) {
            this.keyboardNavService.setItemCount(this.itemElements.length);
            this.keyboardNavService.clearFocus();
          }
        });
      } else {
        // Otherwise use the default filtering
        const query = this.searchInput.value.toLowerCase();
        this.filteredItems = this.items.filter(item => 
          item.title.toLowerCase().includes(query) || 
          (item.description && item.description.toLowerCase().includes(query))
        );
        this.renderItems();
        
        // Update keyboard navigation
        if (this.keyboardNavService) {
          this.keyboardNavService.setItemCount(this.itemElements.length);
          this.keyboardNavService.clearFocus();
        }
      }
    } else {
      // No active search, show all items
      this.filteredItems = [...this.items];
      this.renderItems();
      
      // Update keyboard navigation
      if (this.keyboardNavService) {
        this.keyboardNavService.setItemCount(this.itemElements.length);
        this.keyboardNavService.clearFocus();
      }
    }
  }

  /**
   * Open the modal and return a promise that resolves with the selected items
   */
  public openAndGetSelection(): Promise<ListItem[]> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
} 
