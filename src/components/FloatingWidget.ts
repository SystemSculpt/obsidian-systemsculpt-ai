import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { MobileDetection } from "../utils/MobileDetection";

export interface FloatingWidgetOptions {
  title: string;
  icon?: string;
  className?: string;
  position?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  width?: string;
  draggable?: boolean;
}

/**
 * Base class for floating widgets that can be dragged around the screen
 * Extracted from RecorderService to be reusable for quick-edit and other features
 */
export abstract class FloatingWidget {
  protected app: App;
  protected plugin: SystemSculptPlugin;
  protected mobileDetection: MobileDetection;
  
  // UI elements
  protected widgetEl: HTMLElement | null = null;
  protected titleBarEl: HTMLElement | null = null;
  protected contentEl: HTMLElement | null = null;
  
  // Configuration
  protected options: FloatingWidgetOptions;
  
  constructor(app: App, plugin: SystemSculptPlugin, options: FloatingWidgetOptions) {
    this.app = app;
    this.plugin = plugin;
    this.mobileDetection = new MobileDetection();
    this.options = {
      draggable: true,
      position: { top: "50px", right: "20px" },
      width: "300px",
      ...options
    };
  }

  /**
   * Show the floating widget
   */
  show(): void {
    // Remove any existing widget
    this.hide();

    const isMobile = this.mobileDetection.isMobileDevice();
    
    if (isMobile) {
      // On mobile, use a different approach or fall back to modal
      this.showMobileVersion();
    } else {
      // Use floating widget for desktop
      this.showDesktopWidget();
    }
  }

  /**
   * Hide the floating widget
   */
  hide(): void {
    if (this.widgetEl) {
      // Animate out
      this.widgetEl.classList.remove("visible");
      
      // Remove from DOM after animation
      setTimeout(() => {
        if (this.widgetEl && this.widgetEl.parentNode) {
          this.widgetEl.parentNode.removeChild(this.widgetEl);
        }
        this.widgetEl = null;
        this.titleBarEl = null;
        this.contentEl = null;
      }, 300);
    }
  }

  /**
   * Check if the widget is currently visible
   */
  isVisible(): boolean {
    return this.widgetEl !== null && this.widgetEl.parentNode !== null;
  }

  /**
   * Show desktop floating widget
   */
  private showDesktopWidget(): void {
    // Create widget container
    this.widgetEl = document.createElement("div");
    this.widgetEl.className = `systemsculpt-floating-widget ${this.options.className || ""}`;
    
    // Apply positioning and sizing
    if (this.options.position?.top) this.widgetEl.style.top = this.options.position.top;
    if (this.options.position?.right) this.widgetEl.style.right = this.options.position.right;
    if (this.options.position?.bottom) this.widgetEl.style.bottom = this.options.position.bottom;
    if (this.options.position?.left) this.widgetEl.style.left = this.options.position.left;
    if (this.options.width) this.widgetEl.style.width = this.options.width;

    this.createDesktopUI();

    // Add to DOM
    document.body.appendChild(this.widgetEl);

    // Animate in
    setTimeout(() => {
      if (this.widgetEl) {
        this.widgetEl.classList.add("visible");
      }
    }, 10);
  }

  /**
   * Create desktop UI elements
   */
  private createDesktopUI(): void {
    if (!this.widgetEl) return;

    // Create title bar (draggable handle)
    this.titleBarEl = document.createElement("div");
    this.titleBarEl.className = "systemsculpt-floating-widget-title";
    
    if (this.options.icon) {
      this.titleBarEl.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"
             stroke-linecap="round" stroke-linejoin="round">
          ${this.options.icon}
        </svg>
        ${this.options.title}
      `;
    } else {
      this.titleBarEl.textContent = this.options.title;
    }

    // Make the widget draggable if enabled
    if (this.options.draggable) {
      this.makeDraggable(this.widgetEl, this.titleBarEl);
    }
    
    this.widgetEl.appendChild(this.titleBarEl);

    // Create content area
    this.contentEl = document.createElement("div");
    this.contentEl.className = "systemsculpt-floating-widget-content";
    this.widgetEl.appendChild(this.contentEl);

    // Let subclasses populate the content
    this.createContent(this.contentEl);
  }

  /**
   * Make the widget draggable
   */
  private makeDraggable(element: HTMLElement, handle: HTMLElement): void {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      offsetX = e.clientX - element.offsetLeft;
      offsetY = e.clientY - element.offsetTop;
      
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      
      // Prevent text selection while dragging
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - element.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - element.offsetHeight));

      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    handle.addEventListener("mousedown", onMouseDown);
  }

  /**
   * Show mobile version - subclasses can override this
   */
  protected showMobileVersion(): void {
    // Default implementation - subclasses should override
    console.warn("Mobile version not implemented for this widget");
  }

  /**
   * Abstract method for subclasses to create their content
   */
  protected abstract createContent(container: HTMLElement): void;

  /**
   * Update the widget title
   */
  protected updateTitle(title: string): void {
    if (this.titleBarEl) {
      if (this.options.icon) {
        this.titleBarEl.innerHTML = `
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"
               stroke-linecap="round" stroke-linejoin="round">
            ${this.options.icon}
          </svg>
          ${title}
        `;
      } else {
        this.titleBarEl.textContent = title;
      }
    }
  }

  /**
   * Get the content container for subclasses to use
   */
  protected getContentContainer(): HTMLElement | null {
    return this.contentEl;
  }
}
