/**
 * ReadwiseSyncWidget
 * A floating notification widget that shows Readwise sync progress
 */

import type SystemSculptPlugin from "../main";
import type { ReadwiseSyncResult } from "../types/readwise";

export class ReadwiseSyncWidget {
  private containerEl: HTMLElement | null = null;
  private plugin: SystemSculptPlugin;
  private unsubscribers: Array<() => void> = [];
  private autoDismissTimeout: ReturnType<typeof setTimeout> | null = null;

  // Element references for updates
  private titleEl: HTMLElement | null = null;
  private itemEl: HTMLElement | null = null;
  private progressBarEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
  }

  /**
   * Show the widget and start listening to sync events
   */
  show(): void {
    if (this.containerEl) {
      // Already showing, just ensure visible
      this.containerEl.classList.add("visible");
      return;
    }

    this.render();
    this.subscribeToEvents();

    // Trigger animation after render
    requestAnimationFrame(() => {
      this.containerEl?.classList.add("visible");
    });
  }

  /**
   * Hide and remove the widget
   */
  hide(): void {
    if (!this.containerEl) return;

    // Clear any pending auto-dismiss
    if (this.autoDismissTimeout) {
      clearTimeout(this.autoDismissTimeout);
      this.autoDismissTimeout = null;
    }

    // Animate out
    this.containerEl.classList.remove("visible");

    // Remove after animation
    setTimeout(() => {
      this.containerEl?.remove();
      this.containerEl = null;
      this.titleEl = null;
      this.itemEl = null;
      this.progressBarEl = null;
      this.statsEl = null;
    }, 200);
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    this.unsubscribeAll();
    if (this.autoDismissTimeout) {
      clearTimeout(this.autoDismissTimeout);
    }
    this.containerEl?.remove();
    this.containerEl = null;
  }

  private render(): void {
    // Create container
    this.containerEl = document.createElement("div");
    this.containerEl.className = "readwise-sync-widget";

    // Header
    const headerEl = document.createElement("div");
    headerEl.className = "readwise-sync-widget-header";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "readwise-sync-widget-title";
    this.titleEl.textContent = "Syncing Readwise...";

    const closeBtn = document.createElement("button");
    closeBtn.className = "readwise-sync-widget-close";
    closeBtn.setAttribute("aria-label", "Dismiss");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.hide());

    headerEl.appendChild(this.titleEl);
    headerEl.appendChild(closeBtn);

    // Content
    const contentEl = document.createElement("div");
    contentEl.className = "readwise-sync-widget-content";

    this.itemEl = document.createElement("div");
    this.itemEl.className = "readwise-sync-widget-item";
    this.itemEl.textContent = "Starting...";

    const progressContainer = document.createElement("div");
    progressContainer.className = "readwise-sync-widget-progress";

    this.progressBarEl = document.createElement("div");
    this.progressBarEl.className = "readwise-sync-widget-progress-bar";
    this.progressBarEl.style.width = "0%";

    progressContainer.appendChild(this.progressBarEl);

    this.statsEl = document.createElement("div");
    this.statsEl.className = "readwise-sync-widget-stats";
    this.statsEl.textContent = "";

    contentEl.appendChild(this.itemEl);
    contentEl.appendChild(progressContainer);
    contentEl.appendChild(this.statsEl);

    // Assemble
    this.containerEl.appendChild(headerEl);
    this.containerEl.appendChild(contentEl);

    // Add to document
    document.body.appendChild(this.containerEl);
  }

  private subscribeToEvents(): void {
    const service = this.plugin.getReadwiseService();

    // Progress updates
    const unsubProgress = service.on("sync:progress", ({ current, total, currentItem }) => {
      this.updateProgress(current, total, currentItem);
    });
    this.unsubscribers.push(unsubProgress);

    // Completion
    const unsubComplete = service.on("sync:completed", (result) => {
      this.showComplete(result);
    });
    this.unsubscribers.push(unsubComplete);

    // Error
    const unsubError = service.on("sync:error", ({ error }) => {
      this.showError(error);
    });
    this.unsubscribers.push(unsubError);
  }

  private unsubscribeAll(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  private updateProgress(current: number, total: number, currentItem?: string): void {
    if (!this.containerEl) return;

    // Update item text
    if (this.itemEl && currentItem) {
      this.itemEl.textContent = currentItem;
    }

    // Update progress bar
    if (this.progressBarEl && total > 0) {
      const percentage = Math.round((current / total) * 100);
      this.progressBarEl.style.width = `${percentage}%`;
    }

    // Update stats
    if (this.statsEl) {
      this.statsEl.textContent = `${current} of ${total}`;
    }
  }

  private showComplete(result: ReadwiseSyncResult): void {
    if (!this.containerEl) return;

    this.unsubscribeAll();
    this.containerEl.classList.add("mod-success");

    if (this.titleEl) {
      this.titleEl.textContent = "Sync Complete";
    }

    if (this.itemEl) {
      const parts: string[] = [];
      if (result.imported > 0) {
        parts.push(`${result.imported} new`);
      }
      if (result.updated > 0) {
        parts.push(`${result.updated} updated`);
      }
      this.itemEl.textContent = parts.join(", ");
    }

    if (this.progressBarEl) {
      this.progressBarEl.style.width = "100%";
    }

    if (this.statsEl) {
      this.statsEl.textContent = "";
    }

    // Auto-dismiss after 3 seconds
    this.autoDismissTimeout = setTimeout(() => {
      this.hide();
    }, 3000);
  }

  private showError(error: Error): void {
    if (!this.containerEl) return;

    this.unsubscribeAll();

    // Update UI
    this.containerEl.classList.add("mod-error");

    if (this.titleEl) {
      this.titleEl.textContent = "Sync Failed";
    }

    if (this.itemEl) {
      this.itemEl.textContent = error.message || "An error occurred";
    }

    if (this.statsEl) {
      this.statsEl.textContent = "";
    }

    // Auto-dismiss after 5 seconds for errors
    this.autoDismissTimeout = setTimeout(() => {
      this.hide();
    }, 5000);
  }
}
