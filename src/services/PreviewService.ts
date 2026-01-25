import { App, MarkdownRenderer, TFile, Component, debounce } from 'obsidian';

/**
 * PreviewService provides hover-to-preview functionality for markdown files.
 */
export class PreviewService {
  private static markdownPreview: HTMLElement | null = null;
  /** Provider-isolated cache of rendered preview HTML per file path */
  private static systemSculptPreviewCache: Map<string, string> = new Map();
  private static customProviderPreviewCache: Map<string, string> = new Map();
  /** Provider-isolated cache of file modification times to detect changes */
  private static systemSculptFileModCache: Map<string, number> = new Map();
  private static customProviderFileModCache: Map<string, number> = new Map();
  private static hoverTimer: NodeJS.Timeout | null = null;
  private static safetyTimer: NodeJS.Timeout | null = null;
  private static currentPreviewPath: string | null = null;
  private static isPreviewVisible: boolean = false;
  private static activeElements: Set<HTMLElement> = new Set();
  private static isGlobalListenerActive: boolean = false;
  private static MAX_PREVIEW_DURATION = 10000; // 10 seconds max preview time without interaction
  private static MAX_PREVIEW_CONTENT_LENGTH = 5000; // Maximum characters to render in preview
  private static MAX_PREVIEW_RENDER_TIME = 500; // Maximum time (ms) to spend rendering
  private static MAX_FILE_SIZE_BYTES = 100000; // Maximum file size to attempt to preview (100KB)

  /**
   * Get the appropriate cache for a provider type
   */
  private static getCacheForProvider(providerType: 'systemsculpt' | 'custom' = 'systemsculpt'): {
    previewCache: Map<string, string>;
    fileModCache: Map<string, number>;
  } {
    if (providerType === 'custom') {
      return {
        previewCache: this.customProviderPreviewCache,
        fileModCache: this.customProviderFileModCache
      };
    }
    return {
      previewCache: this.systemSculptPreviewCache,
      fileModCache: this.systemSculptFileModCache
    };
  }

  /**
   * Initialize global event listeners for safety checks
   */
  private static initializeGlobalListeners() {
    if (this.isGlobalListenerActive) return;

    // Add global mousemove listener to detect when mouse is not over any relevant elements
    document.addEventListener('mousemove', this.handleGlobalMouseMove);

    // Add a mouse position tracker to store current mouse position on the document element
    document.addEventListener('mousemove', (e: MouseEvent) => {
      document.documentElement.setAttribute('data-mouse-x', e.clientX.toString());
      document.documentElement.setAttribute('data-mouse-y', e.clientY.toString());
    });

    // Add visibility change listener to hide previews when tab/window loses focus
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    // Add a click listener to hide previews when user clicks elsewhere
    document.addEventListener('click', this.handleGlobalClick);

    this.isGlobalListenerActive = true;
  }

  /**
   * Handle global mouse movement to detect when mouse is not over any relevant elements
   */
  private static handleGlobalMouseMove = debounce((e: MouseEvent) => {
    if (!this.isPreviewVisible) return;

    // Check if mouse is over the preview
    const previewEl = this.markdownPreview;
    if (!previewEl) return;

    // Get the bounding rectangle of the preview element
    const rect = previewEl.getBoundingClientRect();
    const isOverPreview = (
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom
    );

    // Check if mouse is over any of the active elements
    let isOverActiveElement = false;
    this.activeElements.forEach(el => {
      const elRect = el.getBoundingClientRect();
      if (
        e.clientX >= elRect.left && e.clientX <= elRect.right &&
        e.clientY >= elRect.top && e.clientY <= elRect.bottom
      ) {
        isOverActiveElement = true;
      }
    });

    // If mouse is not over preview or any active elements, hide the preview
    if (!isOverPreview && !isOverActiveElement) {
      this.hideAllPreviews();
    }
  }, 16); // Reduce debounce to ~1 frame at 60fps for instant response

  /**
   * Handle visibility change to hide previews when tab/window loses focus
   */
  private static handleVisibilityChange = () => {
    if (document.hidden) {
      this.hideAllPreviews();
    }
  };

  /**
   * Handle global click to hide previews when user clicks elsewhere
   */
  private static handleGlobalClick = (e: MouseEvent) => {
    if (!this.isPreviewVisible) return;

    // Check if click is on the preview
    const previewEl = this.markdownPreview;
    if (!previewEl) return;

    // Get the bounding rectangle of the preview element
    const rect = previewEl.getBoundingClientRect();
    const isOnPreview = (
      e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom
    );

    // Check if click is on any of the active elements
    let isOnActiveElement = false;
    this.activeElements.forEach(el => {
      const elRect = el.getBoundingClientRect();
      if (
        e.clientX >= elRect.left && e.clientX <= elRect.right &&
        e.clientY >= elRect.top && e.clientY <= elRect.bottom
      ) {
        isOnActiveElement = true;
      }
    });

    // If click is not on preview or any active elements, hide the preview
    if (!isOnPreview && !isOnActiveElement) {
      this.hideAllPreviews();
    }
  };

  /**
   * Start safety timer to automatically hide preview after a certain time
   */
  private static startSafetyTimer() {
    // Clear any existing safety timer
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
    }

    // Set a new safety timer
    this.safetyTimer = setTimeout(() => {
      // If preview is still visible after MAX_PREVIEW_DURATION, hide it
      if (this.isPreviewVisible) {
        this.hideAllPreviews();
      }
    }, this.MAX_PREVIEW_DURATION);
  }

  /**
   * Hide all previews and clean up
   */
  public static hideAllPreviews() {
    // Clear timers
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }

    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }

    // Hide preview
    if (this.markdownPreview) {
      this.markdownPreview.classList.remove('systemsculpt-visible');
      this.isPreviewVisible = false;
      this.currentPreviewPath = null;


    }
  }

  /**
   * Attach hover preview to an element for the given file path.
   */
  static attachHoverPreview(app: App, el: HTMLElement, filePath: string, providerType: 'systemsculpt' | 'custom' = 'systemsculpt') {
    // Initialize global listeners if not already done
    this.initializeGlobalListeners();

    if (!this.markdownPreview) {
      this.markdownPreview = document.body.createDiv({ cls: 'systemsculpt-preview systemsculpt-markdown-preview' });
      // Make sure the preview can receive mouse events
      this.markdownPreview.style.pointerEvents = 'auto';
    }

    // Add this element to the set of active elements
    this.activeElements.add(el);

    let isElementPreviewVisible = false;
    let lastEvent: MouseEvent;

    const showPreview = async (e: MouseEvent) => {
      // Get the appropriate cache for this provider type
      const { previewCache, fileModCache } = this.getCacheForProvider(providerType);
      // Track latest event for accurate initial positioning
      lastEvent = e;
      // Clear any existing timer
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
      }

      // Mouse entered element, preparing to show preview

      // Show preview immediately - no delay for instant response
      this.hoverTimer = setTimeout(async () => {
        // Don't re-render if we're already showing this preview
        if (isElementPreviewVisible && this.currentPreviewPath === filePath) {
          positionPreview(lastEvent);
          return;
        }

        const file = app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) return;

        // Check file size before attempting to read
        if (file.stat.size > this.MAX_FILE_SIZE_BYTES) {
          this.markdownPreview!.empty();
          this.markdownPreview!.createDiv({ cls: 'systemsculpt-preview-header', text: file.name });
          this.markdownPreview!.createDiv({
            cls: 'systemsculpt-preview-error',
            text: `This file is too large to preview (${Math.round(file.stat.size / 1024)}KB).
Open the file to view its contents.`
          });

          // Still show the preview with the error message
          this.currentPreviewPath = filePath;
          positionPreview(lastEvent);
          this.markdownPreview!.classList.add('systemsculpt-visible');
          isElementPreviewVisible = true;
          this.isPreviewVisible = true;

          // Cache this error message and modification time to avoid repeated attempts
          previewCache.set(filePath, this.markdownPreview!.innerHTML);
          fileModCache.set(filePath, file.stat.mtime);

          // Start safety timer
          this.startSafetyTimer();
          return;
        }

        // Check if we have a cached version and if the file has been modified
        const cachedModTime = fileModCache.get(filePath);
        const currentModTime = file.stat.mtime;
        const hasChanged = cachedModTime !== currentModTime;

        // Use cached HTML if available and file hasn't changed
        if (previewCache.has(filePath) && !hasChanged) {
          this.markdownPreview!.innerHTML = previewCache.get(filePath)!
        } else {
          // Render and cache
          this.markdownPreview!.empty();
          this.markdownPreview!.createDiv({ cls: 'systemsculpt-preview-header', text: file.name });
          try {
            // Read file content
            const content = await app.vault.read(file);

            // Check file size and truncate if necessary
            let displayContent = content;
            let isTruncated = false;

            if (content.length > this.MAX_PREVIEW_CONTENT_LENGTH) {
              // Truncate content to avoid performance issues
              displayContent = content.substring(0, this.MAX_PREVIEW_CONTENT_LENGTH);
              isTruncated = true;
            }

            // Set a timeout to prevent rendering from taking too long
            const renderPromise = MarkdownRenderer.renderMarkdown(
              displayContent,
              this.markdownPreview!,
              file.path,
              new Component()
            );

            // Use Promise.race to limit render time
            await Promise.race([
              renderPromise,
              new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Preview render timeout')), this.MAX_PREVIEW_RENDER_TIME);
              })
            ]);

            // Add truncation notice if needed
            if (isTruncated) {
              const truncationNotice = this.markdownPreview!.createDiv({
                cls: 'systemsculpt-preview-truncation-notice',
                text: `This preview is truncated. The file is too large to preview completely.`
              });
            }
          } catch (err) {
            // Show error message in preview
            this.markdownPreview!.createDiv({
              cls: 'systemsculpt-preview-error',
              text: `Error loading preview: ${err.message || 'Unknown error'}`
            });
          }
          // Cache the generated HTML and modification time for future hovers
          previewCache.set(filePath, this.markdownPreview!.innerHTML);
          fileModCache.set(filePath, file.stat.mtime);
        }

        this.currentPreviewPath = filePath;
        positionPreview(lastEvent);
        this.markdownPreview!.classList.add('systemsculpt-visible');
        isElementPreviewVisible = true;
        this.isPreviewVisible = true;



        // Start safety timer
        this.startSafetyTimer();
      }, 0); // Instant hover - no delay
    };

    const hidePreview = () => {
      // Clear hover timer
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      }

      // Immediate hiding check - no delay
      setTimeout(() => {
        // Get current mouse position directly from the document
        const mousePos = {
          x: document.documentElement.getAttribute('data-mouse-x') ?
             parseInt(document.documentElement.getAttribute('data-mouse-x')!) : 0,
          y: document.documentElement.getAttribute('data-mouse-y') ?
             parseInt(document.documentElement.getAttribute('data-mouse-y')!) : 0
        };



        // Instant position check - no wait
        setTimeout(() => {
          if (this.markdownPreview && isElementPreviewVisible) {
            // Check if mouse is over the preview
            const rect = this.markdownPreview.getBoundingClientRect();
            const isOverPreview = (
              mousePos.x >= rect.left && mousePos.x <= rect.right &&
              mousePos.y >= rect.top && mousePos.y <= rect.bottom
            );

            // Check if mouse is over the source element
            const elRect = el.getBoundingClientRect();
            const isOverElement = (
              mousePos.x >= elRect.left && mousePos.x <= elRect.right &&
              mousePos.y >= elRect.top && mousePos.y <= elRect.bottom
            );

            // Only hide if not over preview or source element
            if (!isOverPreview && !isOverElement) {
              this.markdownPreview.classList.remove('systemsculpt-visible');
              isElementPreviewVisible = false;
              this.isPreviewVisible = false;
              this.currentPreviewPath = null;


            }
          }
        }, 0);
      }, 0);
    };

    const positionPreview = (e: MouseEvent) => {
      if (!this.markdownPreview) return;
      const { clientX: x, clientY: y } = e;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const previewEl = this.markdownPreview!;
      // Temporarily make it visible off-screen for accurate measurement
      const prevDisplay = previewEl.style.display;
      const prevVisibility = previewEl.style.visibility;
      previewEl.style.visibility = 'hidden';
      previewEl.style.display = 'block';
      previewEl.style.left = '-9999px';
      previewEl.style.top = '-9999px';

      const { width: previewWidth, height: previewHeight } = previewEl.getBoundingClientRect();

      // Restore original display and visibility
      previewEl.style.display = prevDisplay;
      previewEl.style.visibility = prevVisibility;

      const offset = 16;
      let posX = x + offset;
      let posY = y + offset;

      // Decide side based on available space
      if (posX + previewWidth > viewportWidth) {
        posX = Math.max(0, x - previewWidth - offset);
      }
      if (posY + previewHeight > viewportHeight) {
        posY = Math.max(0, y - previewHeight - offset);
      }

      // Apply calculated position
      previewEl.style.left = `${posX}px`;
      previewEl.style.top = `${posY}px`;
    };

    el.addEventListener('mouseenter', showPreview);
    el.addEventListener('mousemove', (e: MouseEvent) => {
      // Update lastEvent and reposition if already visible
      lastEvent = e;
      if (isElementPreviewVisible) {
        positionPreview(lastEvent);
      }
    });
    el.addEventListener('mouseleave', hidePreview);
    this.markdownPreview.addEventListener('mouseleave', hidePreview);

    // Return a cleanup function to remove this element from active elements
    return () => {
      this.activeElements.delete(el);
    };
  }

  /**
   * Clean up all event listeners and resources
   */
  public static cleanup() {
    // Remove global event listeners
    document.removeEventListener('mousemove', this.handleGlobalMouseMove);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.removeEventListener('click', this.handleGlobalClick);

    // Clear timers
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }

    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }

    // Remove preview element
    if (this.markdownPreview) {
      this.markdownPreview.remove();
      this.markdownPreview = null;
    }

    // Reset state
    this.isPreviewVisible = false;
    this.currentPreviewPath = null;
    this.activeElements.clear();
    this.isGlobalListenerActive = false;
    
    // Clear all provider-specific caches
    this.systemSculptPreviewCache.clear();
    this.customProviderPreviewCache.clear();
    this.systemSculptFileModCache.clear();
    this.customProviderFileModCache.clear();

    // Clean up mouse position attributes
    document.documentElement.removeAttribute('data-mouse-x');
    document.documentElement.removeAttribute('data-mouse-y');
  }
}