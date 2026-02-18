import { App } from "obsidian";
import SystemSculptPlugin from "../main";
import { MobileDetection } from "../utils/MobileDetection";
import { createHoverShell, type HoverShellHandle } from "./HoverShell";

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
  positionKey?: string;
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
  protected hoverShell: HoverShellHandle | null = null;
  
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
    if (this.hoverShell) {
      this.hoverShell.destroy();
      this.hoverShell = null;
      this.widgetEl = null;
      this.titleBarEl = null;
      this.contentEl = null;
    }
  }

  /**
   * Check if the widget is currently visible
   */
  isVisible(): boolean {
    return this.hoverShell !== null && this.hoverShell.root.parentNode !== null;
  }

  /**
   * Show desktop floating widget
   */
  private showDesktopWidget(): void {
    const positionKey =
      this.options.positionKey ??
      `floating:${(this.options.className || this.options.title).toLowerCase().replace(/\s+/g, "-")}`;

    this.hoverShell = createHoverShell({
      title: this.options.title,
      icon: this.options.icon,
      className: this.options.className,
      width: this.options.width,
      layout: "desktop",
      draggable: this.options.draggable !== false,
      defaultPosition: this.options.position,
      positionKey,
      useFloatingLegacyClass: true,
      showStatusRow: false,
    });

    this.widgetEl = this.hoverShell.root;
    this.titleBarEl = this.hoverShell.dragHandleEl;
    this.contentEl = this.hoverShell.contentEl;
    this.titleBarEl.classList.add("systemsculpt-floating-widget-title");
    this.contentEl.classList.add("systemsculpt-floating-widget-content");
    this.createContent(this.contentEl);
    this.hoverShell.show();
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
    if (this.hoverShell) {
      this.hoverShell.setTitle(title);
    }
  }

  /**
   * Get the content container for subclasses to use
   */
  protected getContentContainer(): HTMLElement | null {
    return this.contentEl;
  }
}
