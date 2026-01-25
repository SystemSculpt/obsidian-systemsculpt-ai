import { App, Component, MarkdownRenderer, setIcon, ButtonComponent, Modal, TextAreaComponent, TFile, normalizePath, Notice, WorkspaceLeaf, TAbstractFile } from "obsidian";
import { showPopup } from "../../core/ui";
import { ChatRole, ImageContent, MultiPartContent, Annotation, UrlCitation, MessagePart, ChatMessage } from "../../types";
import type { ToolCall, SerializedToolCall } from "../../types/toolCalls";
import type { ToolCallManager } from "./ToolCallManager";
import { findLeafByPath, openFileInMainWorkspace } from '../../utils/workspaceUtils';
import { MessagePartNormalizer } from "./utils/MessagePartNormalizer";
import { MessagePartList } from "./utils/MessagePartList";
import { mergeAdjacentReasoningParts } from "./utils/MessagePartCoalescing";
import { formatReasoningForDisplay } from "./utils/reasoningFormat";
import { applyTreeLayout, seedTreeLine, TREE_HEADER_SYMBOL, setBulletSymbol } from "./utils/treeConnectors";
import { MarkdownMessageRenderer } from "./renderers/MarkdownMessageRenderer";
import { attachMessageToolbar } from "./ui/MessageToolbar";
import { ToolCallTreeRenderer } from "./renderers/ToolCallTreeRenderer";
import {
  createInlineBlock,
  getBlockContent,
  setExpanded,
  setStreaming,
  setTitle,
  isUserExpanded,
  type InlineBlockType,
} from "./renderers/InlineCollapsibleBlock";
import { formatToolDisplayName } from "../../utils/toolDisplay";
import { MermaidPreviewModal } from "../../modals/MermaidPreviewModal";
import { LARGE_TEXT_THRESHOLDS, LARGE_TEXT_MESSAGES, LARGE_TEXT_UI, LargeTextHelpers } from "../../constants/largeText";
import { errorLogger } from "../../utils/errorLogger";
import { PlatformContext } from "../../services/PlatformContext";
// REMOVED: DiffViewer, diffUtils, inline-diff imports - logic now in ToolCallTreeRenderer

const REASONING_MEANINGFUL_CHILD_TAGS = new Set([
  "IMG",
  "PICTURE",
  "VIDEO",
  "AUDIO",
  "IFRAME",
  "CANVAS",
  "SVG",
  "PRE",
  "CODE",
  "TABLE",
  "UL",
  "OL",
  "BLOCKQUOTE",
]);

const REASONING_COMPACT_LINE_HEIGHT = '1.35';
const REASONING_COMPACT_MARGIN = '0.35em';

export interface MessageRenderOptions {
  app: App;
  messageId: string;
  role: ChatRole;
  content: string | MultiPartContent[] | null;
  annotations?: Annotation[];
  webSearchEnabled?: boolean;
}

export class MessageRenderer extends Component {
  private app: App;
  private toolCallManager?: ToolCallManager;
  private throttledRenderers = new WeakMap<HTMLElement, { timeoutId: any, content: string }>();
  private readonly RENDER_THROTTLE_MS = 100;

  private markdownRenderer: MarkdownMessageRenderer; // new helper instance
  private toolCallRenderer: ToolCallTreeRenderer;
  // Throttled verbatim renderer for reasoning streaming
  private reasoningThrottledRenderers = new WeakMap<HTMLElement, { timeoutId: any, content: string }>();



  constructor(app: App, toolCallManager?: ToolCallManager) {
    super();
    this.app = app;
    this.toolCallManager = toolCallManager;
    this.markdownRenderer = new MarkdownMessageRenderer(app);
    this.toolCallRenderer = new ToolCallTreeRenderer(this);
    this.addChild(this.toolCallRenderer);

    // No periodic drawer cleanup required now that reasoning uses structured layout
  }

  /** Get the tool call manager for accessing approval state */
  public getToolCallManager(): ToolCallManager | undefined {
    return this.toolCallManager;
  }

  /** Get the app instance for vault access */
  public getApp(): App {
    return this.app;
  }

  public async renderMessage({
    app,
    messageId,
    role,
    content,
    annotations,
    webSearchEnabled,
  }: {
    app: App;
    messageId: string;
    role: ChatRole;
    content: string | MultiPartContent[] | null;
    annotations?: Annotation[];
    webSearchEnabled?: boolean;
  }): Promise<{ messageEl: HTMLElement; contentEl: HTMLElement }> {
    const messageEl = document.createElement("div");
    messageEl.classList.add("systemsculpt-message");
    messageEl.classList.add(`systemsculpt-${role}-message`);
    messageEl.dataset.messageId = messageId;

    const contentEl = messageEl.createEl("div", {
      cls: "systemsculpt-message-content",
    });

    if (typeof content === "string") {
      // Check if this is large text content that should be collapsed
      const isLargeText = LargeTextHelpers.shouldCollapseInHistory(content);

      if (isLargeText) {
        await this.renderCollapsedLargeText(content, contentEl);
      } else {
        // Use our unified markdown renderer for consistency
        await this.renderMarkdownContent(content, contentEl, false);
      }
    } else if (Array.isArray(content)) {
      const parts = content as MultiPartContent[];
      for (const part of parts) {
        if (part.type === "text") {
          // Simple text snippet
          const p = contentEl.createEl("p");
          p.setText(part.text);
        } else if (part.type === "image_url") {
          // Insert the <img>
          const img = contentEl.createEl("img", {
            attr: { src: part.image_url.url },
          });
          img.classList.add("systemsculpt-message-image");
        }
      }
    } else {
      // Fallback rendering, also using our unified renderer
      await this.renderMarkdownContent(String(content), contentEl, false);
    }

    // Add citations if available and this is an assistant message with web search enabled
    if (role === "assistant" && webSearchEnabled && annotations && annotations.length > 0) {
      // Extract URL citations from annotations
      const urlCitations = annotations
        .filter(annotation => annotation.type === "url_citation" && annotation.url_citation)
        .map(annotation => annotation.url_citation)
        .filter((citation): citation is UrlCitation => citation !== undefined);

      if (urlCitations.length > 0) {
        this.renderCitations(contentEl, urlCitations);
      }
    }

    // Attach hover toolbar overlay (unified, horizontal for all roles)
    try {
      attachMessageToolbar({
        app: this.app,
        messageEl,
        role,
        messageId,
      });
    } catch {}

    return { messageEl, contentEl };
  }

  public async renderMarkdownContent(
    content: string,
    containerEl: HTMLElement,
    isStreaming: boolean = false
  ): Promise<void> {
    return this.markdownRenderer.render(content, containerEl, isStreaming);
  }

  private throttledRender(containerEl: HTMLElement, content: string) {
    let state = this.throttledRenderers.get(containerEl);
    if (!state) {
      state = { timeoutId: null, content: '' };
      this.throttledRenderers.set(containerEl, state);
    }

    state.content = content; // Always update to the latest content

    if (state.timeoutId) {
      return; // A render is already scheduled
    }

    state.timeoutId = setTimeout(async () => {
      const currentState = this.throttledRenderers.get(containerEl);
      if (currentState) {
        currentState.timeoutId = null; // A render is happening, clear the timeoutId

        // Check if element is still connected to DOM (prevent rendering to destroyed elements)
        if (!containerEl.isConnected) {
          this.throttledRenderers.delete(containerEl);
          return;
        }

        // Use the most recent content that was stored
        containerEl.empty();
        await MarkdownRenderer.render(
          this.app,
          currentState.content,
          containerEl,
          'systemsculpt-chat.md',
          this
        );
        this.processRenderedContent(containerEl);

        // Notify for scroll management or other UI updates
        this.app.workspace.trigger('systemsculpt:content-rendered');
      }
    }, this.RENDER_THROTTLE_MS);
  }

  // Post-process Mermaid diagrams: auto-quote labels and render
  private postProcessMermaid(containerEl: HTMLElement): void {
    const mermaidDivs = containerEl.querySelectorAll<HTMLElement>('.mermaid');
    mermaidDivs.forEach(div => {
      const raw = div.textContent || '';
      // Normalise multi-line labels inside brackets for robustness
      let processed = raw.replace(/\[([\s\S]*?)\]/g, (m, p1) => `[${p1.replace(/\n+/g,' ')}]`);
      // Replace Node([Label])
      processed = processed.replace(/([\w-]+)\(\[([\s\S]*?)\]\)/g, '$1["$2"]');
      // Replace Node[Label]
      processed = processed.replace(/([\w-]+)\[([^\]]+?)\]/g, '$1["$2"]');

      // Ensure nodes are on separate lines
      processed = processed.replace(/\]\)([ \t]+)([\w-]+[\[\(])/g, '])\n  $2');

      if (processed !== raw) {
        div.textContent = processed;
      }

      // Re-initialize Mermaid on this div, but guard against parse errors to avoid log spam
      const m = (globalThis as any).mermaid;
      if (m && typeof m.init === 'function') {
        try {
          m.init(undefined, div);
        } catch (err) {
          // Silently swallow Mermaid render error
        }
      }
      // Add expand button (once per diagram)
      if (!div.dataset.ssExpand) {
        div.dataset.ssExpand = 'true';
        // Use Obsidian icon button
        const btn = div.createDiv({ cls: 'systemsculpt-mermaid-expand-btn' });
        setIcon(btn, 'maximize-2');
        btn.setAttribute('aria-label', 'Expand diagram');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          new MermaidPreviewModal(this.app, processed).open();
        });
      }
    });
  }

  // Toolbar visibility is now handled by CSS hover states
  // This method is kept for backward compatibility but does nothing
  private setToolbarVisibility(
    toolbar: HTMLElement,
    visible: boolean,
    expanded: boolean = false
  ): void {
    // CSS now handles all visibility states automatically
    // No JavaScript manipulation needed
  }

  // Removed toggleToolbarState - using container-based approach instead


  public addMessageButtonToolbar(
    messageEl: HTMLElement,
    content: string,
    role: ChatRole,
    messageId: string
  ): void {
    try {
      attachMessageToolbar({
        app: this.app,
        messageEl,
        role,
        messageId,
      });
    } catch {}
  }

  // Legacy reasoning methods removed - now using unified rendering approach

  /**
   * Renders web search citations at the bottom of a message
   */
  public renderCitations(contentEl: HTMLElement, citations: UrlCitation[]): void {
    this.markdownRenderer.renderCitations(contentEl, citations);
  }

  /**
   * Unified rendering for message parts using diff-based updates.
   * All parts (reasoning, content, tool_calls) are rendered in chronological
   * order as inline collapsible blocks. Reasoning and tool call blocks are
   * expanded during streaming and auto-collapsed when streaming completes.
   */
  public renderUnifiedMessageParts(messageEl: HTMLElement, parts: MessagePart[], isActivelyStreaming: boolean = false): void {
    if (!parts || parts.length === 0) {
      const legacyContent = messageEl.querySelector('.systemsculpt-message-content:not(.systemsculpt-unified-part)');
      if (legacyContent) {
        (legacyContent as HTMLElement).style.display = '';
      }
      return;
    }

    // Hide legacy content when we have unified parts
    const legacyContent = messageEl.querySelector('.systemsculpt-message-content:not(.systemsculpt-unified-part)');
    if (legacyContent) {
      (legacyContent as HTMLElement).style.display = 'none';
    }

    const sortedParts = [...parts].sort((a, b) => a.timestamp - b.timestamp);
    const normalizedParts = mergeAdjacentReasoningParts(sortedParts);

    // Track existing parts for efficient DOM updates
    const existingParts = new Map<string, HTMLElement>();
    messageEl.querySelectorAll('.systemsculpt-unified-part[data-part-id]').forEach((el: HTMLElement) => {
      const partId = el.dataset.partId;
      if (partId) existingParts.set(partId, el);
    });

    const processedPartIds = new Set<string>();
    let insertAfterElement: HTMLElement | null = null;
    let toolCallIndex = 0;

    // Render ALL parts in chronological order (reasoning, content, and tool_calls interleaved)
    for (const part of normalizedParts) {
      if (!part.id) continue;
      processedPartIds.add(part.id);

      const existingElement = existingParts.get(part.id);

      if (existingElement) {
        // Update existing element
        const needsUpdate = this.partNeedsUpdate(part, isActivelyStreaming, existingElement);
        if (needsUpdate) {
          this.updateExistingPart(existingElement, part, isActivelyStreaming);
        }
        // Track anchor for insertion - for tool calls, use the anchor from the renderer
        if (part.type === 'tool_call') {
          const anchor = this.toolCallRenderer.getAnchorElement(existingElement);
          insertAfterElement = anchor ?? existingElement;
        } else {
          insertAfterElement = existingElement;
        }
      } else {
        // Create new element based on type
        let newElement: HTMLElement | null = null;

        switch (part.type) {
          case 'reasoning':
            newElement = this.renderInlineReasoning(messageEl, part.data, insertAfterElement, isActivelyStreaming, part.id);
            break;
          case 'content':
            newElement = this.renderUnifiedContent(messageEl, part.data, insertAfterElement, part.id, isActivelyStreaming, part);
            break;
          case 'tool_call':
            newElement = this.renderInlineToolCall(messageEl, part.data as ToolCall, toolCallIndex, insertAfterElement, part.id, isActivelyStreaming);
            break;
        }

        if (newElement) {
          // For tool calls, use the anchor from the renderer
          if (part.type === 'tool_call') {
            const anchor = this.toolCallRenderer.getAnchorElement(newElement);
            insertAfterElement = anchor ?? newElement;
          } else {
            insertAfterElement = newElement;
          }
        }
      }

      if (part.type === 'tool_call') {
        toolCallIndex++;
      }
    }

    // Remove orphaned parts
    existingParts.forEach((element, partId) => {
      if (!processedPartIds.has(partId)) {
        if (element.classList.contains('systemsculpt-chat-structured-line')) {
          this.toolCallRenderer.removeToolCallElement(element);
        } else {
          element.remove();
        }
      }
    });

    this.refreshStructuredBlocks(messageEl);
    this.ensureToolbarAnchored(messageEl);
  }

  /**
   * Move the floating toolbar under the last visible content container so that
   * it overlays correctly even when messages are grouped (where the outer
   * message uses display: contents).
   */
  private ensureToolbarAnchored(messageEl: HTMLElement): void {
    const toolbar = messageEl.querySelector('.systemsculpt-message-toolbar') as HTMLElement | null;
    if (!toolbar) return;

    // Prefer the last content part if present
    const contentParts = messageEl.querySelectorAll<HTMLElement>('.systemsculpt-content-part');
    const anchor = contentParts.length
      ? contentParts[contentParts.length - 1]
      : (messageEl.querySelector('.systemsculpt-message-content') as HTMLElement | null);

    if (!anchor) return;

    if (toolbar.parentElement !== anchor) {
      anchor.appendChild(toolbar);
    }
  }

  /**
   * Check if a part needs to be updated
   */
  private partNeedsUpdate(part: MessagePart, isActivelyStreaming: boolean, existingElement?: HTMLElement): boolean {
    if (part.type === 'reasoning') {
      const currentStreamingState = existingElement?.dataset?.reasoningStreaming === 'true';
      if (isActivelyStreaming !== currentStreamingState) {
        return true;
      }
      // During streaming, we always assume an update is needed
      // The throttled renderer will handle performance
      return isActivelyStreaming || existingElement?.textContent !== part.data;
    } else if (part.type === 'content') {
      // During streaming, we always assume an update is needed
      return isActivelyStreaming || existingElement?.textContent !== part.data;
    } else if (part.type === 'tool_call') {
      // Tool calls update when state changes
      return true; // Let updateExistingPart handle the specifics
    }
    return false;
  }

  /**
   * Update an existing rendered part with new data
   */
  public updateExistingPart(element: HTMLElement, part: MessagePart, isActivelyStreaming: boolean): void {
    if (part.type === 'reasoning') {
      // Handle both inline collapsible blocks and legacy reasoning wrappers
      const isInlineBlock = element.classList.contains('systemsculpt-inline-collapsible');

      if (isInlineBlock) {
        // Update inline collapsible reasoning block
        setStreaming(element, isActivelyStreaming);
        const contentEl = element.querySelector('.systemsculpt-inline-reasoning-text') as HTMLElement;
        if (contentEl && typeof part.data === 'string') {
          if (isActivelyStreaming) {
            this.appendReasoningStream(contentEl, part.data);
          } else {
            this.finalizeReasoningStream(contentEl, part.data);
            // Auto-collapse when streaming ends (unless user expanded)
            if (!isUserExpanded(element)) {
              setExpanded(element, false);
            }
          }
        }
      } else {
        // Legacy reasoning wrapper
        this.applyReasoningStreamingState(element, isActivelyStreaming);
        const contentEl = element.querySelector('.systemsculpt-reasoning-text') as HTMLElement;
        if (contentEl && typeof part.data === 'string') {
          if (isActivelyStreaming) {
            this.appendReasoningStream(contentEl, part.data);
          } else {
            this.finalizeReasoningStream(contentEl, part.data);
          }
        }
      }
    } else if (part.type === 'content') {
      // For content parts, use incremental renderer for streaming markdown
      if (element && typeof part.data === 'string') {
        this.renderMarkdownContent(part.data, element, isActivelyStreaming);
      }
    } else if (part.type === 'tool_call') {
      const toolCall = part.data as any;
      const isInlineBlock = element.classList.contains('systemsculpt-inline-collapsible');

      if (isInlineBlock) {
        // Update inline collapsible tool call block
        setStreaming(element, isActivelyStreaming);

        // Update title if tool name changed
        const functionData = toolCall.request?.function;
        if (functionData?.name) {
          setTitle(element, formatToolDisplayName(functionData.name));
        }

        // Re-render content
        const contentContainer = getBlockContent(element);
        if (contentContainer) {
          contentContainer.empty();
          this.toolCallRenderer.renderToolCallInline(contentContainer, toolCall, 0);
        }

        // Auto-collapse completed tool calls when streaming ends
        if (!isActivelyStreaming && toolCall.state === 'completed' && !isUserExpanded(element)) {
          setExpanded(element, false);
        }
      } else {
        // Legacy tree-based tool call
        this.toolCallRenderer.updateInlineDisplay(element, toolCall);
      }
    }

    const messageEl = element.closest('.systemsculpt-message') as HTMLElement | null;
    if (messageEl) {
      this.refreshStructuredBlocks(messageEl);
    }
  }

  /**
   * Finalize all inline collapsible blocks after streaming completes.
   * Auto-collapses blocks unless user manually expanded them.
   */
  public finalizeInlineBlocks(messageEl: HTMLElement): void {
    const inlineBlocks = messageEl.querySelectorAll('.systemsculpt-inline-collapsible.is-streaming');
    inlineBlocks.forEach((block: Element) => {
      const el = block as HTMLElement;
      setStreaming(el, false);

      // Auto-collapse unless user manually expanded
      if (!isUserExpanded(el)) {
        setExpanded(el, false);
      }
    });
  }

  /**
   * Render reasoning as an inline collapsible block in chronological order.
   * This replaces the old drawer-based rendering for chronological display.
   */
  private renderInlineReasoning(messageEl: HTMLElement, reasoning: string, insertAfterElement?: HTMLElement | null, isStreaming: boolean = false, partId?: string): HTMLElement {
    const block = createInlineBlock({
      type: 'reasoning',
      partId: partId ?? `reasoning-${Date.now()}`,
      isStreaming,
      title: 'Reasoning',
      icon: 'brain',
    });

    block.classList.add('systemsculpt-unified-part');

    if (messageEl && messageEl.classList) {
      messageEl.classList.add('has-reasoning');
    }

    // Create the reasoning text container inside the collapsible content
    const contentContainer = getBlockContent(block);
    if (contentContainer) {
      const textEl = contentContainer.createDiv({ cls: 'systemsculpt-inline-reasoning-text markdown-rendered' });

      if (isStreaming) {
        this.appendReasoningStream(textEl, reasoning);
      } else {
        this.finalizeReasoningStream(textEl, reasoning);
        // Auto-collapse when not streaming
        setExpanded(block, false);
      }
    }

    this.insertElementInOrder(messageEl, block, insertAfterElement);

    return block;
  }

  /**
   * Render a tool call as an inline collapsible block in chronological order.
   * This replaces the old drawer-based rendering for chronological display.
   */
  private renderInlineToolCall(messageEl: HTMLElement, toolCall: ToolCall, index: number, insertAfterElement?: HTMLElement | null, partId?: string, isStreaming: boolean = false): HTMLElement {
    const functionData = this.getFunctionData(toolCall);
    const toolName = functionData?.name ?? 'Tool';
    const displayName = formatToolDisplayName(toolName);

    const block = createInlineBlock({
      type: 'tool_call',
      partId: partId ?? toolCall.id,
      isStreaming,
      title: displayName,
      icon: 'wrench',
    });

    block.classList.add('systemsculpt-unified-part');

    // Render tool call content inside the collapsible
    const contentContainer = getBlockContent(block);
    if (contentContainer) {
      // Use existing tool call renderer for the content
      this.toolCallRenderer.renderToolCallInline(contentContainer, toolCall, index);
    }

    // Auto-collapse completed tool calls when not streaming
    if (!isStreaming && toolCall.state === 'completed') {
      setExpanded(block, false);
    }

    this.insertElementInOrder(messageEl, block, insertAfterElement);

    return block;
  }

  /**
   * Render reasoning as part of unified display (legacy - kept for backward compatibility)
   * @deprecated Use renderInlineReasoning for chronological inline display
   */
  private renderUnifiedReasoning(messageEl: HTMLElement, reasoning: string, insertAfterElement?: HTMLElement | null, isStreaming: boolean = false, partId?: string): HTMLElement {
    const { wrapper, contentEl } = this.createReasoningStructure(isStreaming);

    if (partId) {
      wrapper.dataset.partId = partId;
    }

    if (messageEl && messageEl.classList) {
      messageEl.classList.add('has-reasoning');
    }

    this.insertElementInOrder(messageEl, wrapper, insertAfterElement);
    this.applyReasoningStreamingState(wrapper, isStreaming);

    if (isStreaming) {
      this.appendReasoningStream(contentEl, reasoning);
    } else {
      this.finalizeReasoningStream(contentEl, reasoning);
    }

    this.refreshStructuredBlocks(messageEl);

    return wrapper;
  }

  private createReasoningStructure(isStreaming: boolean): { wrapper: HTMLElement; contentEl: HTMLElement } {
    const wrapper = document.createElement('div');
    wrapper.className = 'systemsculpt-reasoning-wrapper systemsculpt-unified-part';

    const block = wrapper.createDiv({ cls: 'systemsculpt-reasoning-block systemsculpt-chat-structured-block systemsculpt-chat-tree' });
    block.classList.remove('systemsculpt-chat-tree--empty');
    block.dataset.treeConnector = 'group';
    const header = block.createDiv({ cls: 'systemsculpt-chat-structured-header' });
    header.dataset.treeConnector = 'header';
    header.createSpan({ cls: 'systemsculpt-chat-structured-bullet' });
    header.createSpan({ cls: 'systemsculpt-chat-structured-title', text: 'Reasoning' });

    const lines = block.createDiv({ cls: 'systemsculpt-chat-structured-lines' });
    const line = lines.createDiv({ cls: 'systemsculpt-chat-structured-line' });
    line.dataset.treeConnector = 'end';
    line.createSpan({ cls: 'systemsculpt-chat-structured-line-prefix' });
    const textContainer = line.createDiv({ cls: 'systemsculpt-chat-structured-line-text' });
    const scrollContainer = textContainer.createDiv({ cls: 'systemsculpt-reasoning-scroll-container' });
    const contentEl = scrollContainer.createDiv({ cls: 'systemsculpt-reasoning-text markdown-rendered' });

    seedTreeLine(line, 1, true);
    wrapper.dataset.reasoningStreaming = isStreaming ? 'true' : 'false';
    const prefixEl = wrapper.querySelector<HTMLElement>('.systemsculpt-chat-structured-line-prefix');
    if (prefixEl) {
      prefixEl.dataset.role = 'reasoning-connector';
    }

    return { wrapper, contentEl };
  }

  private applyReasoningStreamingState(wrapper: HTMLElement, isStreaming: boolean): void {
    if (!wrapper) return;
    wrapper.dataset.reasoningStreaming = isStreaming ? 'true' : 'false';
    const bullet = wrapper.querySelector<HTMLElement>('.systemsculpt-chat-structured-bullet');
    if (bullet) {
      if (isStreaming) {
        bullet.classList.add('is-active');
        setBulletSymbol(bullet, '');
      } else {
        bullet.classList.remove('is-active');
        setBulletSymbol(bullet, TREE_HEADER_SYMBOL);
      }
    }

    const title = wrapper.querySelector<HTMLElement>('.systemsculpt-chat-structured-title');
    if (title) {
      title.textContent = 'Reasoning';
    }
  }

  private updateReasoningConnectors(messageEl: HTMLElement): void {
    if (!messageEl) return;
    const wrappers = Array.from(messageEl.querySelectorAll<HTMLElement>('.systemsculpt-reasoning-wrapper'));
    const nodes = wrappers.reduce<Array<{ lineEl: HTMLElement; prefixEl?: HTMLElement | null; depth?: number }>>(
      (acc, wrapper) => {
        const line = wrapper.querySelector<HTMLElement>('.systemsculpt-chat-structured-line');
        if (!line) {
          return acc;
        }
        const prefix = line.querySelector<HTMLElement>('.systemsculpt-chat-structured-line-prefix');
        const depth = Number.parseInt(line.dataset.treeDepth ?? '1', 10);
        acc.push({ lineEl: line, prefixEl: prefix ?? undefined, depth });
        return acc;
      },
      []
    );

    applyTreeLayout(nodes, { forceEnd: true });
    try {
      errorLogger.debug('Updated reasoning tree connectors', {
        source: 'MessageRenderer',
        method: 'updateReasoningConnectors',
        metadata: {
          messageId: messageEl.dataset.messageId,
          segments: nodes.length,
        },
      });
    } catch (_) {
      // ignore logging errors to avoid cascading failures during rendering
    }
  }

  public refreshStructuredBlocks(messageEl: HTMLElement): void {
    if (!messageEl) return;
    this.updateReasoningConnectors(messageEl);
    this.updateStructuredBlockFontSizes(messageEl);
  }

  private updateStructuredBlockFontSizes(messageEl: HTMLElement): void {
    const blocks = Array.from(messageEl.querySelectorAll<HTMLElement>('.systemsculpt-chat-structured-block'));
    if (blocks.length === 0) {
      delete messageEl.dataset.structuredBlockFontSize;
      return;
    }

    delete messageEl.dataset.structuredBlockFontSize;

    blocks.forEach((block) => {
      block.style.removeProperty('font-size');
    });
  }

  /**
   * Append delta reasoning text into a lightweight streaming container to avoid
   * expensive markdown re-renders while tokens arrive.
   */
  private appendReasoningStream(contentEl: HTMLElement, fullText: string): void {
    // Throttle verbatim markdown rendering to preserve formatting during streaming
    let state = this.reasoningThrottledRenderers.get(contentEl);
    if (!state) {
      state = { timeoutId: null, content: '' };
      this.reasoningThrottledRenderers.set(contentEl, state);
    }
    state.content = fullText;
    if (state.timeoutId) return;
    // If chat view is detached from bottom, defer rendering to avoid jank while user scrolls history
    try {
      const messagesContainer = contentEl.closest('.systemsculpt-messages-container') as HTMLElement | null;
      const ds = messagesContainer?.dataset?.autoscroll;
      const isAnchored = ds === undefined ? true : ds !== 'false';
      if (messagesContainer && isAnchored === false) {
        return;
      }
    } catch {}
    state.timeoutId = setTimeout(async () => {
      const current = this.reasoningThrottledRenderers.get(contentEl);
      if (!current) return;
      current.timeoutId = null;
      if (!contentEl.isConnected) {
        this.reasoningThrottledRenderers.delete(contentEl);
        return;
      }
      await this.renderReasoningVerbatim(current.content, contentEl);
    }, this.RENDER_THROTTLE_MS);
  }

  /**
   * Replace the streaming placeholder with a final markdown render.
   */
  private async finalizeReasoningStream(contentEl: HTMLElement, markdown: string): Promise<void> {
    const state = this.reasoningThrottledRenderers.get(contentEl);
    if (state?.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = null;
    }
    // Always render reasoning verbatim on finalize to preserve original formatting
    await this.renderReasoningVerbatim(markdown, contentEl);
  }

  /**
   * Render reasoning content verbatim without any preprocessing
   * This preserves the original markdown formatting exactly as authored
   */
  private async renderReasoningVerbatim(markdown: string, containerEl: HTMLElement): Promise<void> {
    // Diagnostic logging (dev mode only)
    const plugin = (this.app as any).plugins?.plugins?.['systemsculpt-plugin'];
    const debugMode = plugin?.settingsManager?.settings?.debugMode ?? false;

    if (debugMode) {
      console.log('[Reasoning Verbatim] Input length:', markdown.length);
      console.log('[Reasoning Verbatim] First 60 chars:', markdown.substring(0, 60));
      console.log('[Reasoning Verbatim] Contains bold markers:', markdown.includes('**'));
    }

    const formattedMarkdown = formatReasoningForDisplay(markdown);

    // Clear container
    containerEl.empty();

    // Render markdown directly using Obsidian's renderer without any preprocessing
    // This preserves bold markers, paragraph spacing, and all other formatting
    await MarkdownRenderer.render(
      this.app, 
      formattedMarkdown, 
      containerEl, 
      'systemsculpt-reasoning.md', 
      this
    );
    
    // Only apply minimal post-processing for safety (HTML sanitization)
    // Do not apply any markdown transformations
    this.postProcessReasoningContent(containerEl, debugMode);
    this.scrollReasoningContainerToBottom(containerEl);
    
    if (debugMode) {
      console.log('[Reasoning Verbatim] Rendered HTML length:', containerEl.innerHTML.length);
      console.log('[Reasoning Verbatim] Contains <strong> tags:', containerEl.innerHTML.includes('<strong>'));
    }
    
    // Emit DOM change event for scroll management
    try {
      containerEl.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
    } catch {}
  }

  private scrollReasoningContainerToBottom(contentEl: HTMLElement): void {
    const scrollContainer = contentEl.closest('.systemsculpt-reasoning-scroll-container') as HTMLElement | null;
    if (!scrollContainer) {
      return;
    }

    if (!scrollContainer.isConnected) {
      return;
    }

    try {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    } catch {}
  }

  private removeBlankReasoningParagraphs(container: HTMLElement): number {
    let removed = 0;
    const sanitize = (value: string | null | undefined): string => {
      if (!value) {
        return "";
      }
      return value.replace(/\u00a0/g, " ").trim();
    };

    const paragraphs = Array.from(container.querySelectorAll<HTMLElement>("p"));
    paragraphs.forEach((paragraph) => {
      if (sanitize(paragraph.textContent).length > 0) {
        return;
      }

      const hasMeaningfulChild = Array.from(paragraph.children).some((child) => {
        const tagName = child.tagName?.toUpperCase?.() ?? "";
        if (tagName === "BR") {
          return false;
        }

        if (REASONING_MEANINGFUL_CHILD_TAGS.has(tagName)) {
          return true;
        }

        return sanitize(child.textContent).length > 0;
      });

      if (hasMeaningfulChild) {
        return;
      }

      paragraph.remove();
      removed += 1;
    });

    return removed;
  }

  /**
   * Minimal post-processing for reasoning content - only for safety
   */
  private postProcessReasoningContent(container: HTMLElement, debugMode: boolean): void {
    const removedParagraphs = this.removeBlankReasoningParagraphs(container);
    if (debugMode && removedParagraphs > 0) {
      console.debug(
        `[Reasoning Verbatim] Removed ${removedParagraphs} empty paragraph${removedParagraphs === 1 ? '' : 's'}.`
      );
    }

    if (container) {
      container.style.lineHeight = REASONING_COMPACT_LINE_HEIGHT;

      const blockChildren = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      blockChildren.forEach((child, index) => {
        const isFirst = index === 0;
        const isLast = index === blockChildren.length - 1;
        child.style.marginTop = isFirst ? '0' : REASONING_COMPACT_MARGIN;
        child.style.marginBottom = isLast ? '0' : REASONING_COMPACT_MARGIN;
      });
    }

    // Add basic styling classes but do not modify content
    container.querySelectorAll("pre").forEach((pre) => {
      pre.classList.add("systemsculpt-code-block");
    });
    
    // Handle images for click-to-open behavior (preserve existing functionality)
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
    });
    
    // Handle wiki-links for navigation
    container.querySelectorAll("a.internal-link").forEach((link: HTMLAnchorElement) => {
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute("href") || link.getAttribute("data-href");
        if (href) {
          this.app.workspace.openLinkText(href, "", true);
        }
      });
    });
    
    // Note: We explicitly DO NOT process Mermaid diagrams here
    // to avoid any transformation of the reasoning content
  }

  /**
   * Render content as part of unified display
   */
  private renderUnifiedContent(messageEl: HTMLElement, content: any, insertAfterElement?: HTMLElement | null, partId?: string, isStreaming: boolean = false, messagePart?: MessagePart): HTMLElement | null {
    // Avoid creating empty content containers that introduce stray spacing
    if (typeof content === "string") {
      if (this.containsChronologicalBlocks(content)) {
        const preview = this.extractNonChronologicalContent(content).trim();
        if (preview.length === 0) {
          return null;
        }
      } else if (content.trim().length === 0) {
        return null;
      }
    } else if (Array.isArray(content)) {
      const partsArray = content as MultiPartContent[];
      const hasRenderable = partsArray.some(p =>
        (p.type === 'text' && typeof (p as any).text === 'string' && (p as any).text.trim().length > 0) ||
        (p.type === 'image_url' && (p as any).image_url && (p as any).image_url.url)
      );
      if (!hasRenderable) return null;
    } else if (content == null) {
      return null;
    }

    const container = document.createElement("div");
    container.className = "systemsculpt-unified-part systemsculpt-content-part";

    // Add part ID for tracking
    if (partId) {
      container.dataset.partId = partId;
    }

    this.insertElementInOrder(messageEl, container, insertAfterElement);

    // CRITICAL FIX: Check if content contains chronological blocks from storage
    if (typeof content === "string" && this.containsChronologicalBlocks(content)) {
      // Don't render chronological blocks as content - they should be handled by messageParts
      const cleanedContent = this.extractNonChronologicalContent(content);
      if (cleanedContent.trim()) {
        // Use incremental renderer for all markdown content
        this.renderMarkdownContent(cleanedContent, container, isStreaming);
      }
    } else if (typeof content === "string") {
      // Use incremental renderer for all markdown content
      this.renderMarkdownContent(content, container, isStreaming);
    } else if (Array.isArray(content)) {
      const parts = content as MultiPartContent[];
      for (const part of parts) {
        if (part.type === "text") {
          const p = container.createEl("p");
          p.setText(part.text);
        } else if (part.type === "image_url") {
          const img = container.createEl("img", {
            attr: { src: part.image_url.url },
          });
          img.classList.add("systemsculpt-message-image");
        }
      }
    } else {
      // Fallback - use incremental renderer
      this.renderMarkdownContent(String(content), container, isStreaming);
    }

    // Image and mermaid handling is now done by the incremental renderer
    // No need for separate setupImageHandlers and postProcessMermaid calls

    return container;
  }

  /**
   * Process rendered markdown content for code blocks, images, etc.
   */
  private processRenderedContent(container: HTMLElement): void {
    // Ensure each code block gets a consistent class and attach a copy button
    container.querySelectorAll("pre").forEach((preEl) => {
      preEl.classList.add("systemsculpt-code-block");

      if (!preEl.querySelector('.copy-code-button')) {
        const btn = document.createElement('button');
        btn.className = 'copy-code-button';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copy code');
        btn.textContent = 'Copy';
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const codeEl = preEl.querySelector('code');
            const text = codeEl ? (codeEl as HTMLElement).innerText : preEl.innerText;
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied';
            setTimeout(() => (btn.textContent = 'Copy'), 1200);
            new Notice('Code copied to clipboard', 1500);
          } catch {
            new Notice('Failed to copy code', 2000);
          }
        });
        preEl.appendChild(btn);
      }
    });

    // Preserve the existing interactive behaviour for images rendered inside
    // assistant messages.
    container.querySelectorAll("img").forEach((img) => {
      img.style.cursor = "pointer";
      img.classList.add("systemsculpt-message-image");

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

      // Ensure scroll updates when images load and change layout
      try {
        img.addEventListener('load', () => {
          try {
            img.dispatchEvent(new CustomEvent('systemsculpt-dom-content-changed', { bubbles: true }));
          } catch {}
        }, { once: true });
      } catch {}
    });
  }

  /**
   * Check if content contains chronological blocks from storage
   */
  private containsChronologicalBlocks(content: string): boolean {
    return content.includes('<!-- REASONING-BLOCK -->') ||
           content.includes('<!-- TOOL-CALL-BLOCK -->') ||
           content.includes('<!-- TOOL-RESPONSE-BLOCK -->');
  }

  /**
   * Extract only the non-chronological content (regular text) from storage content
   */
  private extractNonChronologicalContent(content: string): string {
    // Remove all chronological blocks
    let cleaned = content
      .replace(/<!-- REASONING-BLOCK -->\n[\s\S]*?\n<!-- \/REASONING-BLOCK -->/g, '')
      .replace(/<!-- TOOL-CALL-BLOCK -->\n[\s\S]*?\n<!-- \/TOOL-CALL-BLOCK -->/g, '')
      .replace(/<!-- TOOL-RESPONSE-BLOCK -->\n[\s\S]*?\n<!-- \/TOOL-RESPONSE-BLOCK -->/g, '');

    // Clean up extra whitespace
    cleaned = cleaned.replace(/\n\n\n+/g, '\n\n').trim();

    return cleaned;
  }

  // REMOVED: renderToolCallAsContent - now handled by ToolCallTreeRenderer

  // REMOVED: shouldCollapseByDefault, createStatusIndicator, updateStatusIndicator - now in ToolCallTreeRenderer

  // REMOVED: renderToolCallContent - now in ToolCallTreeRenderer

  // REMOVED: renderToolCallArguments, renderArgument - now in ToolCallTreeRenderer

  // REMOVED: renderApprovalButtons, renderExecutingState, renderToolCallResult,
  // renderLazyResultPlaceholder, renderLazyErrorPlaceholder, createResultPreview
  // - all now in ToolCallTreeRenderer

  // Removed legacy tool-call rendering helpers (migrated to ToolCallTreeRenderer)

  /**
   * Get function data from tool call (handles different formats)
   */
  private getFunctionData(toolCall: ToolCall): any {
    // New structure has function data inside 'request'
    if (toolCall.request && toolCall.request.function) {
      const rawArgs = toolCall.request.function.arguments;
      let args: any = {};

      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs);
        } catch (error) {
          errorLogger.warn("MessageRenderer: failed to parse tool call arguments", error);
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs;
      }

      if (!args || typeof args !== "object" || Array.isArray(args)) {
        args = {};
      }

      return {
        name: toolCall.request.function.name,
        arguments: args,
      };
    }
    return null; // Return null if structure is not as expected
  }

  /**
   * Insert element in correct chronological order
   */
  private insertElementInOrder(messageEl: HTMLElement, newElement: HTMLElement, insertAfterElement?: HTMLElement | null): void {
    if (insertAfterElement) {
      insertAfterElement.insertAdjacentElement('afterend', newElement);
    } else {
      // First element - insert before main message content
      const contentEl = messageEl.querySelector('.systemsculpt-message-content');
      if (contentEl) {
        messageEl.insertBefore(newElement, contentEl);
      } else {
        messageEl.appendChild(newElement);
      }
    }
  }

  public renderMessageParts(messageEl: HTMLElement, message: any, isActivelyStreaming: boolean = false): void {
    const partList = message.messageParts ? new MessagePartList(message.messageParts) : new MessagePartList(MessagePartNormalizer.toParts(message));
    this.renderUnifiedMessageParts(messageEl, partList.parts, isActivelyStreaming);
  }

  // Removed collapseAllDrawers – rolling window + lazy rendering manage expand/collapse

  // REMOVED: shouldShowFileDiff, _getNewFileContent, renderFileDiffPreview, handleToolCallStateChange
  // - all now in ToolCallTreeRenderer

  /**
   * Handle "View in File" button click - opens file and applies diff overlay
   */
  private async handleViewInFile(toolCall: ToolCall): Promise<void> {
    try {
      const functionData = this.getFunctionData(toolCall);
      if (!functionData) return;

      const args = functionData.arguments;
      const toolName = functionData.name;

      // Get file path
      const filePath = args.path || args.target_file || args.file_path;
      if (!filePath || typeof filePath !== 'string') return;

      // Get current chat view leaf to maintain focus later
      const currentLeaf = this.app.workspace.activeLeaf;

      // We always want to open in a specific location for the side-by-side workflow
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        new Notice('File not found or is not a valid file.');
        return;
      }

      // First check if file is already open anywhere
      const allLeaves = this.app.workspace.getLeavesOfType('markdown');
      let existingFileLeaf = null;

      // Normalize the path for comparison
      const normalizedPath = normalizePath(filePath);

      for (const leaf of allLeaves) {
        const view = leaf.view as any;
        if (view.file && normalizePath(view.file.path) === normalizedPath) {
          existingFileLeaf = leaf;
          break;
        }
      }

      if (existingFileLeaf) {
        // File is already open, just switch to it
            try { (window as any).FreezeMonitor?.mark?.('message-renderer:setActiveLeaf:existing'); } catch {}
            this.app.workspace.setActiveLeaf(existingFileLeaf, { focus: false });
        // Apply diff overlay after switching
      } else {
        // File not open, create a new leaf for it.
        let targetLeaf: WorkspaceLeaf | null = null;

        const platform = PlatformContext.get();
        const isMobileVariant = platform.uiVariant() === 'mobile';
        if (isMobileVariant) {
          targetLeaf = this.app.workspace.getLeaf('tab');
        } else {
          // --- DESKTOP LOGIC ---
          // This logic ensures the new file opens in the main workspace, not a sidebar.

          // 1. Try to find an existing pane in the main work area to add a tab to.
          let suitablePane: WorkspaceLeaf | null = null;
          this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.getRoot() === this.app.workspace.rootSplit && leaf !== currentLeaf) {
              if (!suitablePane) suitablePane = leaf;
            }
          });

          if (suitablePane) {
            // We found a pane in the main area. Activate it and create a new tab.
            try { (window as any).FreezeMonitor?.mark?.('message-renderer:setActiveLeaf:suitable'); } catch {}
            this.app.workspace.setActiveLeaf(suitablePane, { focus: false });
            targetLeaf = this.app.workspace.getLeaf('tab');
          } else {
            // The main area is empty (or only contains the chat view). Create a new split.
            if (currentLeaf && currentLeaf.getRoot() === this.app.workspace.rootSplit) {
              // If chat view is in the main area, split from it.
              targetLeaf = this.app.workspace.createLeafBySplit(currentLeaf, 'vertical', true);
            } else {
              // Chat is in sidebar or there's no leaf. `getLeaf(true)` creates a new leaf with a split in the main area.
              targetLeaf = this.app.workspace.getLeaf(true);
            }
          }
        }

        if (targetLeaf) {
            await targetLeaf.openFile(file);
        }
      }

      // Keep focus on the chat view
      if (currentLeaf) {
        try { (window as any).FreezeMonitor?.mark?.('message-renderer:restoreFocus'); } catch {}
        this.app.workspace.setActiveLeaf(currentLeaf, { focus: true });
      }

    } catch (error) {
    }
  }

  // Add unload method
  public unload(): void {
    // WeakMap will be garbage collected naturally, but clear the reference for immediate cleanup
    this.throttledRenderers = new WeakMap();
    
    super.unload();
  }

  private formatToolName(name: string): string {
    return formatToolDisplayName(name);
  }

  /**
   * Generate a simple tool name for the header (no arguments)
   */
  private generateToolSummary(toolName: string, args: any): string {
    // Remove mcp- prefix for cleaner display
    const actualToolName = toolName.replace(/^mcp[_-]/i, '');

    // Handle filesystem prefix - convert _ to : for namespace
    if (actualToolName.startsWith('filesystem_')) {
      const parts = actualToolName.split('_');
      const namespace = parts[0];
      const functionName = parts.slice(1).join('_');

      // Format as "Filesystem: read_file" (preserve underscores in function names)
      return namespace.charAt(0).toUpperCase() + namespace.slice(1) + ': ' + functionName;
    }

    // For non-namespaced tools, just capitalize first letter
    return actualToolName.charAt(0).toUpperCase() + actualToolName.slice(1);
  }

  /**
   * Check if an argument value is meaningful (not empty, null, undefined, or whitespace-only)
   */
  private isArgumentValueMeaningful(value: any): boolean {
    // Handle null and undefined
    if (value === null || value === undefined) {
      return false;
    }

    // Handle strings - check for empty or whitespace-only
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    // Handle numbers, booleans, objects, arrays - these are meaningful even if 0 or false
    return true;
  }

  /**
   * Filter arguments to only include meaningful values
   */
  private filterMeaningfulArguments(args: Record<string, any>): Record<string, any> {
    const meaningful: Record<string, any> = {};

    for (const [key, value] of Object.entries(args)) {
      if (this.isArgumentValueMeaningful(value)) {
        meaningful[key] = value;
      }
    }

    return meaningful;
  }

  /**
   * Normalize any message format into sequential MessageParts for unified rendering
   */
  public normalizeMessageToParts(message: ChatMessage): MessagePartList {
    const parts = MessagePartNormalizer.toParts(message);
    return new MessagePartList(parts);
  }

  /**
   * Helper method to properly animate drawer collapse/expand states
   * Respects animation timing to ensure smooth transitions
   */
  private setDrawerCollapsedState(drawerEl: HTMLElement, shouldCollapse: boolean): void {
    // Check if drawer is already in the desired state
    const isCurrentlyCollapsed = drawerEl.classList.contains('systemsculpt-collapsed');
    if (isCurrentlyCollapsed === shouldCollapse) {
      return;
    }

    // Use requestAnimationFrame to ensure smooth animation
    requestAnimationFrame(() => {
      if (shouldCollapse) {
        drawerEl.classList.add('systemsculpt-collapsed');
      } else {
        drawerEl.classList.remove('systemsculpt-collapsed');
      }
    });
  }

  /**
   * Render an "Open File" button for single-file tools when completed
   */
  private renderOpenFileButton(headerEl: HTMLElement, toolCall: ToolCall): void {
    // Only show button for completed tool calls
    if (toolCall.state !== 'completed') {
      return;
    }

    const functionData = this.getFunctionData(toolCall);
    if (!functionData) {
      return;
    }

    // Define single-file tools and their path arguments
    const singleFileTools: Record<string, string> = {
      'write': 'path',
      'edit': 'path'
    };

    // Extract the base tool name (remove mcp-filesystem_ prefix if present)
    const baseName = functionData.name.replace(/^mcp-filesystem_/, '');

    let filePath: string | null = null;

    if (baseName === 'move') {
      if (functionData.arguments.items && Array.isArray(functionData.arguments.items) && functionData.arguments.items.length > 0) {
        filePath = functionData.arguments.items[0].destination;
      }
    } else {
      const pathArgument = singleFileTools[baseName];
      if (pathArgument) {
        const pathValue = functionData.arguments[pathArgument];
        if (typeof pathValue === 'string') {
          filePath = pathValue;
        }
      }
    }

    if (!filePath) {
      return;
    }

    // Create the "Open File" button
    const openFileBtn = new ButtonComponent(headerEl)
      .setButtonText("Open File")
      .setClass("systemsculpt-tool-call-open-file-btn")
      .setClass("mod-small")
      .setTooltip(`Open ${filePath}`)
      .onClick(async (event) => {
        // Prevent the click from bubbling up to the header (which would toggle collapse)
        event.stopPropagation();
        if (filePath) {
          await this.openFileInWorkspace(filePath);
        }
      });
  }

  /**
   * Open a file using workspace management logic similar to open
   */
  private async openFileInWorkspace(filePath: string): Promise<void> {
    try {
      const currentLeaf = this.app.workspace.activeLeaf;
      const { action } = await openFileInMainWorkspace(this.app, filePath);

      // Only restore focus if we didn't just switch to a tab in the same pane
      if (action !== 'switched_in_pane' && currentLeaf) {
        this.app.workspace.setActiveLeaf(currentLeaf, { focus: true });
      }
    } catch (error) {
      new Notice('Error opening file. See console for details.');
    }
  }

  // Removed collapseReasoningDrawers – not used in compact flow

  private getFilePathFromToolCall(toolCall: ToolCall): string | null {
    const functionData = this.getFunctionData(toolCall);
    if (!functionData) return null;

    const toolName = functionData.name;
    const args = functionData.arguments || {};

    // Special handling for move which has a nested structure
    if (toolName === 'move' && args.items && Array.isArray(args.items) && args.items.length > 0) {
      // Return the destination of the first item in the list
      return args.items[0].destination || null;
    }

    // Map tool names to the argument that contains the primary file path
    const pathArgMap: Record<string, string> = {
      'read': 'paths',
      'write': 'path',
      'edit': 'path',
      'trash': 'paths'
    };

    const argName = pathArgMap[toolName];
    if (!argName) return null;

    const pathValue = args[argName];

    // Handle both string and array types
    if (typeof pathValue === 'string') {
      return pathValue;
    } else if (Array.isArray(pathValue) && typeof pathValue[0] === 'string') {
      return pathValue[0];
    }

    return null;
  }


  /**
   * Render large text content in a collapsed format with external access options
   */
  private async renderCollapsedLargeText(content: string, contentEl: HTMLElement): Promise<void> {
    const lineCount = LargeTextHelpers.getLineCount(content);
    const sizeKB = Math.round(LargeTextHelpers.getTextSizeKB(content));

    // Create container for collapsed content
    const collapsedContainer = contentEl.createEl("div", {
      cls: "systemsculpt-large-text-container"
    });

    // Show preview of first few lines
    const previewContent = LargeTextHelpers.getPreviewContent(content);

    const previewEl = collapsedContainer.createEl("div", {
      cls: "systemsculpt-large-text-preview"
    });

    // Render preview as markdown
    await this.renderMarkdownContent(previewContent, previewEl, false);

    // Add truncation indicator
    if (lineCount > LARGE_TEXT_THRESHOLDS.MAX_LINES_PREVIEW) {
      const truncationEl = previewEl.createEl("div", {
        cls: "systemsculpt-text-truncation",
        text: LARGE_TEXT_MESSAGES.TRUNCATION_INDICATOR
      });
    }

    // Add collapse indicator with external access options
    const collapseIndicator = collapsedContainer.createEl("div", {
      cls: "systemsculpt-large-text-indicator"
    });

    collapseIndicator.innerHTML = `
      <span class="systemsculpt-large-text-stats">
        ${LARGE_TEXT_UI.STATS_PREFIX}${lineCount} lines (${LargeTextHelpers.formatSize(sizeKB)})
      </span>
      <div class="systemsculpt-large-text-actions">
        <button class="systemsculpt-view-button">
          📄 View in Modal
        </button>
        <button class="systemsculpt-save-button">
          💾 Save to File
        </button>
        <button class="systemsculpt-copy-button">
          📋 Copy to Clipboard
        </button>
      </div>
    `;

    // Add click handlers for external access
    const viewButton = collapseIndicator.querySelector('.systemsculpt-view-button') as HTMLElement;
    const saveButton = collapseIndicator.querySelector('.systemsculpt-save-button') as HTMLElement;
    const copyButton = collapseIndicator.querySelector('.systemsculpt-copy-button') as HTMLElement;

    viewButton.addEventListener('click', () => {
      this.showLargeTextModal(content, `Large Text Content (${lineCount}${LARGE_TEXT_UI.MODAL_TITLE_SUFFIX}`);
    });

    saveButton.addEventListener('click', () => {
      this.saveLargeTextToFile(content, sizeKB);
    });

    copyButton.addEventListener('click', () => {
      navigator.clipboard.writeText(content);
      // Show temporary feedback
      copyButton.textContent = '✓ Copied';
      setTimeout(() => {
        copyButton.innerHTML = '📋 Copy to Clipboard';
      }, 1000);
    });
  }

  /**
   * Show large text content in a proper Obsidian modal
   */
  private showLargeTextModal(content: string, title: string): void {
    new LargeTextModal(this.app, content, title).open();
  }

  /**
   * Save large text content to a file
   */
  private async saveLargeTextToFile(content: string, sizeKB: number): Promise<void> {
    try {
      // Create a blob with the content
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      // Create download link
      const a = document.createElement('a');
      a.href = url;
      a.download = `large-text-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Clean up
      URL.revokeObjectURL(url);

      // Show success message
      const notice = document.createElement('div');
      notice.className = 'systemsculpt-notice';
      notice.textContent = `✓ Large text saved to file (${LargeTextHelpers.formatSize(sizeKB)})`;
      document.body.appendChild(notice);

      setTimeout(() => {
        notice.remove();
      }, 3000);
    } catch (error) {
    }
  }
}

/**
 * Obsidian Modal for displaying large text content
 */
class LargeTextModal extends Modal {
  private content: string;
  private title: string;

  constructor(app: App, content: string, title: string) {
    super(app);
    this.content = content;
    this.title = title;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Set modal title
    this.titleEl.setText(this.title);

    // Create container with proper Obsidian styling
    const container = contentEl.createEl("div", {
      cls: "large-text-modal-container"
    });

    // Create textarea for content display
    const textarea = container.createEl("textarea", {
      cls: "large-text-viewer",
      attr: {
        readonly: "true",
        spellcheck: "false"
      }
    });

    // Set content and configure textarea
    textarea.value = this.content;
    textarea.style.width = "100%";
    textarea.style.height = "60vh";
    textarea.style.minHeight = "400px";
    textarea.style.fontFamily = "var(--font-monospace)";
    textarea.style.fontSize = "13px";
    textarea.style.lineHeight = "1.4";
    textarea.style.resize = "vertical";
    textarea.style.border = "1px solid var(--border-color)";
    textarea.style.borderRadius = "4px";
    textarea.style.padding = "12px";
    textarea.style.backgroundColor = "var(--background-primary)";
    textarea.style.color = "var(--text-normal)";

    // Add copy button
    const buttonContainer = container.createEl("div", {
      cls: "large-text-modal-buttons"
    });
    buttonContainer.style.marginTop = "12px";
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.justifyContent = "flex-end";

    const copyButton = buttonContainer.createEl("button", {
      text: "Copy to Clipboard",
      cls: "mod-cta"
    });

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.content);
        copyButton.setText("✓ Copied!");
        setTimeout(() => {
          copyButton.setText("Copy to Clipboard");
        }, 1500);
      } catch (error) {
        copyButton.setText("Copy failed");
        setTimeout(() => {
          copyButton.setText("Copy to Clipboard");
        }, 1500);
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
