import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { UrlCitation } from "../../../types";
import { setIcon } from "obsidian";
import { MermaidPreviewModal } from "../../../modals/MermaidPreviewModal";

/**
 * MarkdownMessageRenderer – isolated helper responsible solely for
 * transforming markdown+HTML strings into rendered DOM nodes (including
 * incremental throttled streaming support) and for drawing the small
 * citation footer block used by assistant web-search answers.
 */
export class MarkdownMessageRenderer extends Component {
  private app: App;
  // Per-container throttling state used to coalesce frequent streaming updates
  private throttledRenderers: WeakMap<HTMLElement, { timeoutId: any; content: string; lastRenderedContent?: string }> = new WeakMap();
  private RENDER_THROTTLE_MS = 100;

  constructor(app: App) {
    super();
    this.app = app;
  }

  /**
   * Render markdown into the given element.  When `isStreaming` is true we
   * debounce the expensive Obsidian markdown renderer so that bursts of very
   * small updates (token streaming) don't flood the DOM.
   */
  public async render(content: string, containerEl: HTMLElement, isStreaming = false): Promise<void> {
    // Pre-process Mermaid diagrams **before** Obsidian's core Mermaid plugin parses them – this
    // prevents the initial parseError spam and means we only need to render once.
    content = this.preprocessMermaid(content);

    const state = this.throttledRenderers.get(containerEl);
    if (state && state.lastRenderedContent === content) {
      return; // Skip if content is identical to what's already on-screen
    }

    if (isStreaming) {
      // Adaptive throttle: increase throttle when page is hidden or container is offscreen
      const isHidden = document.hidden;
      const isOffscreen = !containerEl.isConnected || !this.isElementVisible(containerEl);
      this.RENDER_THROTTLE_MS = (isHidden || isOffscreen) ? 250 : 100;

      // If the chat view is not anchored at the bottom (user is reading history),
      // do not perform streaming re-renders to avoid jank; stash latest content only.
      try {
        const messagesContainer = containerEl.closest('.systemsculpt-messages-container') as HTMLElement | null;
        // dataset reflects IO or scroll-based detection. If absent, treat as anchored to keep streaming.
        const ds = messagesContainer?.dataset?.autoscroll;
        const isAnchored = ds === undefined ? true : ds !== 'false';
        if (messagesContainer && isAnchored === false) {
          let state: { timeoutId: any; content: string; lastRenderedContent?: string } | undefined = this.throttledRenderers.get(containerEl);
          if (!state) {
            const newState: { timeoutId: any; content: string } = { timeoutId: null, content: "" };
            this.throttledRenderers.set(containerEl, newState);
            state = newState;
          }
          state.content = content;
          return;
        }
      } catch {}

      this.throttledRender(containerEl, content);
      return;
    }

    // If this is a final render ensure any queued update is flushed first
    if (state?.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }

    await this.performRender(containerEl, content);
  }

  /**
   * Internal helper to execute the actual markdown render and post-processing.
   */
  private async performRender(containerEl: HTMLElement, content: string): Promise<void> {
    const startTime = performance.now();
    
    containerEl.empty();
    await MarkdownRenderer.render(this.app, content, containerEl, "systemsculpt-chat.md", this);
    this.postProcess(containerEl);
    
    // Update tracking state
    let state = this.throttledRenderers.get(containerEl);
    if (!state) {
      state = { timeoutId: null, content: content };
      this.throttledRenderers.set(containerEl, state);
    }
    state.lastRenderedContent = content;

    const endTime = performance.now();
    const duration = endTime - startTime;
    
    // Only log significant render times or in debug mode
    if (duration > 50) {
      const plugin = (this.app as any).plugins?.plugins?.['systemsculpt-plugin'];
      const debugMode = plugin?.settingsManager?.settings?.debugMode ?? false;
      if (debugMode) {
        console.debug(`[MarkdownMessageRenderer] Render took ${duration.toFixed(2)}ms for ${content.length} chars`);
      }
    }

    // Emit a lightweight DOM event so scroll managers can react
    try {
      containerEl.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
    } catch {}
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Citations
  // ────────────────────────────────────────────────────────────────────────────
  public renderCitations(contentEl: HTMLElement, citations: UrlCitation[]): void {
    if (citations.length === 0) return;

    const citationsContainer = contentEl.createEl("div", {
      cls: "systemsculpt-citations-container",
    });

    // Visual separator between answer and footnotes
    citationsContainer.createEl("hr", { cls: "systemsculpt-citations-divider" });

    citationsContainer.createEl("div", {
      cls: "systemsculpt-citations-header",
      text: "Sources",
    });

    const citationsList = citationsContainer.createEl("ol", {
      cls: "systemsculpt-citations-list",
    });

    citations.forEach((citation, index) => {
      const li = citationsList.createEl("li", { cls: "systemsculpt-citation-item" });

      // Display the title (or domain if missing)
      const displayTitle = citation.title || new URL(citation.url).hostname;

      // Clickable title
      li.createEl("a", {
        cls: "systemsculpt-citation-title",
        text: displayTitle,
        attr: {
          href: citation.url,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      });

      // Small muted URL underneath
      li.createEl("div", {
        cls: "systemsculpt-citation-url",
        text: citation.url,
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Internal helpers
  // ────────────────────────────────────────────────────────────────────────────
  private throttledRender(containerEl: HTMLElement, content: string) {
    let state = this.throttledRenderers.get(containerEl);
    if (!state) {
      state = { timeoutId: null, content: "" };
      this.throttledRenderers.set(containerEl, state);
    }

    state.content = content; // Always keep latest

    if (state.timeoutId) return; // Already scheduled

    state.timeoutId = setTimeout(async () => {
      const current = this.throttledRenderers.get(containerEl);
      if (!current) return;
      current.timeoutId = null;

      // Skip if element was detached meanwhile
      if (!containerEl.isConnected) {
        this.throttledRenderers.delete(containerEl);
        return;
      }

      await this.performRender(containerEl, current.content);
      this.app.workspace.trigger("systemsculpt:content-rendered");
    }, this.RENDER_THROTTLE_MS);
  }

  private isElementVisible(el: HTMLElement): boolean {
    try {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
    } catch {
      return true;
    }
  }

  /**
   * Post-processing that needs to run after every markdown render (final or
   * throttled) – currently adds code-block styling and click handlers for
   * app:// links on images.
   */
  private postProcess(container: HTMLElement): void {
    // Uniform styling for all <pre> blocks and attach a copy button
    container.querySelectorAll("pre").forEach((pre) => {
      pre.classList.add("systemsculpt-code-block");

      // Avoid duplicating copy buttons on re-renders
      if (!pre.querySelector('.copy-code-button')) {
        const btn = document.createElement('button');
        btn.className = 'copy-code-button';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copy code');
        btn.textContent = 'Copy';
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const codeEl = pre.querySelector('code');
            const text = codeEl ? (codeEl as HTMLElement).innerText : pre.innerText;
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied';
            setTimeout(() => (btn.textContent = 'Copy'), 1200);
            new Notice('Code copied to clipboard', 1500);
          } catch {
            new Notice('Failed to copy code', 2000);
          }
        });
        pre.appendChild(btn);
      }
    });

    // Provide click-to-open behaviour for images that encode vault paths via
    // Obsidian's proprietary app:// URL scheme.
    container.querySelectorAll("img").forEach((img) => {
      img.addClass("systemsculpt-message-image");
      img.style.cursor = "pointer";

      img.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = img.getAttribute("src");
        if (!src) return;
        if (src.startsWith("app://")) {
          const path = src.replace("app://local/", "");
          this.app.workspace.openLinkText(path, "", true);
        }
      });

      // If an image finishes loading and alters layout, notify scroll manager
      try {
        img.addEventListener('load', () => {
          try {
            img.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
          } catch {}
        }, { once: true });
      } catch {}
    });

    // Handle wiki-links that Obsidian may have rendered as plain <a> tags
    container.querySelectorAll("a.internal-link").forEach((link: HTMLAnchorElement) => {
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Get the file path from the href or data-href attribute
        const href = link.getAttribute("href") || link.getAttribute("data-href");
        if (href) {
          // Open the file in Obsidian
          this.app.workspace.openLinkText(href, "", true);
        }
      });
    });

    // Mermaid post-processing – ensure labels are quoted so Obsidian's bundled
    // Mermaid doesn't choke on spaces / punctuation.
    this.postProcessMermaid(container);
  }

  private postProcessMermaid(containerEl: HTMLElement): void {
    const mermaidDivs = containerEl.querySelectorAll<HTMLElement>(".mermaid");
    mermaidDivs.forEach((div) => {
      const raw = div.textContent ?? "";
      // Enhanced corrections similar to MessageRenderer.postProcessMermaid
      let fixed = raw;
      // 0. Normalise multi-line labels – collapse line breaks inside [ ... ] so regex fixes work.
      fixed = fixed.replace(/\[([\s\S]*?)\]/g, (m, p1) => `[${p1.replace(/\n+/g, ' ')}]`);

      // 1a. Replace Node([Label]) → Node["Label"] (allowing multi-line) – broader capture
      fixed = fixed.replace(/([\w-]+)\(\[([\s\S]*?)\]\)/g, '$1["$2"]');

      // 2a. Replace Node[Label] → Node["Label"] (multiline safe)
      fixed = fixed.replace(/([\w-]+)\[([^\]]+?)\]/g, '$1["$2"]');

      if (fixed !== raw) {
        div.textContent = fixed;
      }

      const m = (globalThis as any).mermaid;
      if (m && typeof m.init === "function") {
        try {
          m.init(undefined, div);
        } catch (err) {
        }
      }

      // Add expand button (avoid duplicates)
      if (!div.dataset.ssExpand) {
        div.dataset.ssExpand = 'true';
        const btn = div.createDiv({ cls: 'systemsculpt-mermaid-expand-btn' });
        setIcon(btn, 'maximize-2');
        btn.setAttribute('aria-label', 'Expand diagram');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          new MermaidPreviewModal(this.app, fixed).open();
        });
      }
    });
  }

  /**
   * Light-weight regex fixes applied directly to the raw markdown string so core Mermaid never
   * sees the bad syntax that causes the NODE_DSTART errors.
   */
  private preprocessMermaid(markdown: string): string {
    // Only operate inside fenced mermaid code blocks to avoid corrupting general markdown
    // like wiki links ([[...]]), lists, or bold markers (**...**).
    const fenceRegex = /```mermaid[ \t]*\n([\s\S]*?)\n```/g;

    return markdown.replace(fenceRegex, (_full, code) => {
      let fixed = code as string;

      // 0. Normalise multi-line labels – collapse line breaks inside [ ... ] so regex fixes work.
      fixed = fixed.replace(/\[([\s\S]*?)\]/g, (m, p1) => `[${p1.replace(/\n+/g, ' ')}]`);

      // 1a. Replace Node([Label]) → Node["Label"] (allowing multi-line) – broader capture
      fixed = fixed.replace(/([\w-]+)\(\[([\s\S]*?)\]\)/g, '$1["$2"]');

      // 2a. Replace Node[Label] → Node["Label"] (multiline safe)
      fixed = fixed.replace(/([\w-]+)\[([^\]]+?)\]/g, '$1["$2"]');

      // 3. Ensure a newline exists between consecutive nodes – if we find a closing ]) followed only
      //    by spaces/tabs before the next node token, inject a real \n so the mind-map grammar sees
      //    separate lines.
      fixed = fixed.replace(/\]\)([ \t]+)([\w-]+[\[\(])/g, '])\n  $2');

      return `\u0060\u0060\u0060mermaid\n${fixed}\n\u0060\u0060\u0060`;
    });
  }
} 
