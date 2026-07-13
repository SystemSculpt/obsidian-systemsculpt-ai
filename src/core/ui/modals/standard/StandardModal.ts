import { App, Modal, setIcon } from "obsidian";

/**
 * StandardModal provides a consistent base for all modals in the application.
 * It includes standardized header, content, and footer sections, as well as
 * focused helpers for titles, actions, and search fields.
 */
export class StandardModal extends Modal {
  private static nextTitleId = 0;

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
    const titleId = `ss-modal-title-${++StandardModal.nextTitleId}`;
    titleContainer.createEl("h2", {
      text: title,
      cls: "ss-modal__title",
      attr: { id: titleId },
    });

    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.setAttr("aria-labelledby", titleId);
    
    // Add close button to the title container
    const closeButton = titleContainer.createEl("button", {
      cls: "ss-modal__close-button",
      attr: {
        type: "button",
        "aria-label": "Close",
      },
    });
    setIcon(closeButton, "x");
    this.registerDomEvent(closeButton, "click", () => this.close());
    
    if (description) {
      const descriptionId = `${titleId}-description`;
      this.headerEl.createDiv({
        text: description,
        cls: "ss-modal__description",
        attr: { id: descriptionId },
      });
      this.modalEl.setAttr("aria-describedby", descriptionId);
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
    const clearButton = searchContainer.createEl("button", {
      cls: "ss-modal__search-clear",
      attr: {
        type: "button",
        "aria-label": "Clear search",
        title: "Clear search",
      },
    });
    setIcon(clearButton, "x");
    clearButton.setCssStyles({ display: "none" });
    
    // Event listeners
    this.registerDomEvent(searchInput, "input", () => {
      const value = searchInput.value;
      clearButton.style.display = value ? "flex" : "none";
      callback(value);
    });
    
    this.registerDomEvent(clearButton, "click", () => {
      searchInput.value = "";
      clearButton.setCssStyles({ display: "none" });
      callback("");
      searchInput.focus();
    });
    
    return searchInput;
  }

}
