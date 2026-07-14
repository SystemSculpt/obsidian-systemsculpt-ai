import { App, Modal } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  createUiSearch,
  type UiActionTone,
  type UiSearchHandle,
} from "../../surface";

export interface ModalAsyncTaskScope {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

/**
 * StandardModal provides a consistent base for all modals in the application.
 * It includes standardized header, content, and footer sections, as well as
 * focused helpers for titles, actions, and search fields.
 */
export class StandardModal extends Modal {
  private static nextTitleId = 0;
  private static readonly fallbackAccessibleName = "SystemSculpt";

  protected headerEl: HTMLElement;
  public contentEl: HTMLElement;
  protected footerEl: HTMLElement;
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];
  private searchHandles: UiSearchHandle[] = [];
  private asyncTaskEpoch = 0;
  private asyncTaskControllers = new Map<string, AbortController>();
  private modalIsOpen = false;

  constructor(app: App) {
    super(app);

    applyPluginSurface(this.modalEl, "modal");
    this.modalEl.addClass("ss-modal");
    this.applyBaseSemantics();
  }

  onOpen() {
    this.invalidateAsyncTasks();
    this.modalIsOpen = true;
    this.applyBaseSemantics();
    // Create the standard modal structure
    this.createModalStructure();
  }

  onClose() {
    this.modalIsOpen = false;
    this.invalidateAsyncTasks();
    // Clean up event listeners
    this.removeAllListeners();
    this.searchHandles.forEach((search) => search.destroy());
    this.searchHandles = [];
    // Clean up
    this.modalEl.empty();
    this.applyBaseSemantics();
  }

  /**
   * Starts the latest async task for a semantic key. Starting the same key,
   * closing, or reopening the modal aborts the previous scope.
   */
  protected beginAsyncTask(key: string): ModalAsyncTaskScope {
    this.asyncTaskControllers.get(key)?.abort();

    const AbortControllerCtor = (this.modalEl.ownerDocument.defaultView as any)?.AbortController
      ?? AbortController;
    const controller = new AbortControllerCtor() as AbortController;
    const epoch = this.asyncTaskEpoch;
    this.asyncTaskControllers.set(key, controller);

    return {
      signal: controller.signal,
      isCurrent: () =>
        this.modalIsOpen &&
        !controller.signal.aborted &&
        this.asyncTaskEpoch === epoch &&
        this.asyncTaskControllers.get(key) === controller,
    };
  }

  private invalidateAsyncTasks(): void {
    this.asyncTaskEpoch += 1;
    this.asyncTaskControllers.forEach((controller) => controller.abort());
    this.asyncTaskControllers.clear();
  }

  private applyBaseSemantics(): void {
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.modalEl.removeAttribute("aria-labelledby");
    this.modalEl.removeAttribute("aria-describedby");
    this.modalEl.setAttr("aria-label", StandardModal.fallbackAccessibleName);
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

    this.modalEl.removeAttribute("aria-label");
    this.modalEl.setAttr("aria-labelledby", titleId);
    
    // Add close button to the title container
    this.addCloseButton(titleContainer);
    
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
  addActionButton(
    text: string,
    callback: () => void,
    primary: boolean = false,
    icon?: string,
    tone?: UiActionTone,
  ) {
    const button = createUiAction(this.footerEl, {
      label: text,
      icon,
      tone: tone ?? (primary ? "primary" : "default"),
    });
    this.registerDomEvent(button, "click", callback);
    return button;
  }

  /**
   * Add a search bar to the modal
   * @param placeholder Placeholder text
   * @param callback Function called when search input changes
   */
  addSearchBar(placeholder: string, callback: (query: string) => void) {
    const search = createUiSearch(this.contentEl, {
      placeholder,
      onQuery: callback,
    });
    search.root.addClass("ss-modal__search");
    this.searchHandles.push(search);
    return search.input;
  }

  protected addCloseButton(
    parent: HTMLElement,
    onClose: () => void = () => this.close(),
  ): HTMLButtonElement {
    const closeButton = createUiAction(parent, {
      label: "Close",
      icon: "x",
      size: "icon",
    });
    closeButton.addClass("ss-modal__close-button");
    this.registerDomEvent(closeButton, "click", onClose);
    return closeButton;
  }
}
