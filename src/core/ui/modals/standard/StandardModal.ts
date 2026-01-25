import { App, Modal, setIcon } from "obsidian";

export interface Filter {
  id: string;
  label: string;
  icon?: string;
  active?: boolean;
}

/**
 * StandardModal provides a consistent base for all modals in the application.
 * It includes standardized header, content, and footer sections, as well as
 * helper methods for common elements like search bars and filter buttons.
 */
export class StandardModal extends Modal {
  protected headerEl: HTMLElement;
  public contentEl: HTMLElement;
  protected footerEl: HTMLElement;
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];

  constructor(app: App) {
    super(app);
    
    // Add standardized modal classes
    this.modalEl.addClass("ss-modal");
  }

  onOpen() {
    // Create the standard modal structure
    this.createModalStructure();
  }

  onClose() {
    // Clean up event listeners
    this.removeAllListeners();
    // Clean up
    this.modalEl.empty();
  }

  /**
   * Registers a DOM event on the given element and ensures it will be cleaned up when the modal is closed
   */
  protected registerDomEvent(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  /**
   * Removes all registered DOM event listeners
   */
  private removeAllListeners() {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }

  /**
   * Create the standard three-part modal structure:
   * header, content, and footer
   */
  protected createModalStructure() {
    this.modalEl.empty();
    
    // Create header
    this.headerEl = this.modalEl.createDiv("ss-modal__header");
    
    // Create content
    this.contentEl = this.modalEl.createDiv("ss-modal__content");
    
    // Create footer
    this.footerEl = this.modalEl.createDiv("ss-modal__footer");
  }

  /**
   * Set the size variant of the modal
   * @param size small, medium, large, or fullwidth
   */
  setSize(size: "small" | "medium" | "large" | "fullwidth") {
    // Remove any existing size classes
    this.modalEl.removeClass("ss-modal--small", "ss-modal--medium", "ss-modal--large", "ss-modal--fullwidth");
    
    // Add the requested size class
    this.modalEl.addClass(`ss-modal--${size}`);
  }

  /**
   * Add an element to the header section
   * @param el Element to add
   */
  addToHeader(el: HTMLElement) {
    this.headerEl.appendChild(el);
  }

  /**
   * Add an element to the content section
   * @param el Element to add
   */
  addToContent(el: HTMLElement) {
    this.contentEl.appendChild(el);
  }

  /**
   * Add an element to the footer section
   * @param el Element to add
   */
  addToFooter(el: HTMLElement) {
    this.footerEl.appendChild(el);
  }

  /**
   * Add a title to the header
   * @param title Title text
   * @param description Optional description text
   */
  addTitle(title: string, description?: string) {
    const titleContainer = this.headerEl.createDiv({ cls: "ss-modal__title-container" });
    titleContainer.createEl("h2", { text: title, cls: "ss-modal__title" });
    
    // Add close button to the title container
    const closeButton = titleContainer.createDiv({ cls: "ss-modal__close-button" });
    setIcon(closeButton, "x");
    this.registerDomEvent(closeButton, "click", () => this.close());
    
    if (description) {
      this.headerEl.createDiv({ text: description, cls: "ss-modal__description" });
    }
  }

  /**
   * Add an action button to the footer
   * @param text Button text
   * @param callback Click handler
   * @param primary Whether this is a primary button
   * @param icon Optional icon name to show before text
   */
  addActionButton(text: string, callback: () => void, primary: boolean = false, icon?: string) {
    const button = this.footerEl.createEl("button", {
      cls: primary ? "ss-button ss-button--primary" : "ss-button ss-button--secondary",
    });
    
    // Add icon if provided
    if (icon) {
      const iconEl = button.createSpan("ss-button__icon");
      setIcon(iconEl, icon);
    }
    
    // Add text separately to ensure proper spacing
    button.appendChild(document.createTextNode(text));
    
    this.registerDomEvent(button, "click", callback);
    return button;
  }

  /**
   * Add a search bar to the modal
   * @param placeholder Placeholder text
   * @param callback Function called when search input changes
   */
  addSearchBar(placeholder: string, callback: (query: string) => void) {
    const searchContainer = this.contentEl.createDiv("ss-modal__search");
    
    // Add search icon
    const searchIcon = searchContainer.createDiv("ss-modal__search-icon");
    setIcon(searchIcon, "search");
    
    // Add search input
    const searchInput = searchContainer.createEl("input", {
      type: "text",
      placeholder: placeholder,
      cls: "ss-modal__search-input",
    });
    
    // Add clear button
    const clearButton = searchContainer.createDiv("ss-modal__search-clear");
    setIcon(clearButton, "x");
    clearButton.style.display = "none";
    
    // Event listeners
    this.registerDomEvent(searchInput, "input", () => {
      const value = searchInput.value;
      clearButton.style.display = value ? "flex" : "none";
      callback(value);
    });
    
    this.registerDomEvent(clearButton, "click", () => {
      searchInput.value = "";
      clearButton.style.display = "none";
      callback("");
      searchInput.focus();
    });
    
    return searchInput;
  }

  /**
   * Add filter buttons to the modal
   * @param filters Array of filter objects
   * @param callback Function called when a filter is toggled
   */
  addFilterButtons(filters: Filter[], callback: (filterId: string, active: boolean) => void) {
    const filterContainer = this.contentEl.createDiv("ss-modal__filter");
    const filterGroup = filterContainer.createDiv("ss-modal__filter-group");
    
    filters.forEach(filter => {
      const button = filterGroup.createEl("button", {
        cls: `ss-button ss-button--small ${filter.active ? "ss-active" : ""}`,
        attr: {
          "data-filter-id": filter.id,
        },
      });
      
      if (filter.icon) {
        const iconContainer = button.createSpan("ss-button__icon");
        setIcon(iconContainer, filter.icon);
      }
      
      // Add text as a separate node to ensure proper spacing
      button.appendChild(document.createTextNode(filter.label));
      
      this.registerDomEvent(button, "click", () => {
        const isActive = button.classList.toggle("ss-active");
        callback(filter.id, isActive);
      });
    });
    
    return filterContainer;
  }

  /**
   * Create an item component for displaying model/context/search results
   * @param title Item title
   * @param description Optional description
   * @param icon Optional icon name
   * @param badge Optional badge text
   */
  createItem(title: string, description?: string, icon?: string, badge?: string) {
    const item = document.createElement("div");
    item.className = "ss-modal__item";
    
    // Add icon if provided
    if (icon) {
      const iconEl = item.createDiv("ss-modal__item-icon");
      setIcon(iconEl, icon);
    }
    
    // Add content (title and description)
    const content = item.createDiv("ss-modal__item-content");
    content.createDiv({ text: title, cls: "ss-modal__item-title" });
    
    if (description) {
      content.createDiv({ text: description, cls: "ss-modal__item-description" });
    }
    
    // Add badge if provided
    if (badge) {
      const badgeEl = item.createSpan({ text: badge, cls: "ss-modal__item-badge" });
    }
    
    return item;
  }
} 