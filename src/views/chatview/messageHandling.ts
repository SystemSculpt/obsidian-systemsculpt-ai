import { ChatView } from "./ChatView";
import { ChatRole, MultiPartContent, ChatMessage, MessagePart, UrlCitation } from "../../types";
import { ButtonComponent, Notice } from "obsidian";
import { appendMessageToGroupedContainer } from "./utils/MessageGrouping";
// Tool call rendering is fully status-driven from managed tool events.

export const messageHandling = {
  addMessage: async function(chatView: ChatView, role: ChatRole, content: string | MultiPartContent[] | null, existingMessageId?: string, completeMessage?: ChatMessage, targetContainer?: HTMLElement | DocumentFragment): Promise<void> {
    if (!chatView.shouldRenderMessageRole(role)) {
      return;
    }

    const messageId = existingMessageId || chatView.generateMessageId();
    
    const { messageEl, contentEl } = await chatView.messageRenderer.renderMessage({
      app: chatView.app,
      messageId,
      role,
      content: content || "",
      onResend:
        role === "user"
          ? async (input) => this.runResendAction(chatView, input)
          : undefined,
    });

    // Track role on element for grouping metadata and debugging
    messageEl.dataset.role = role;

    const contentStr = typeof content === "string" ? content : content ? JSON.stringify(content) : "";
    messageEl.dataset.content = contentStr;

    // Handle assistant messages with consistent unified rendering
    if (completeMessage && completeMessage.role === 'assistant') {
      await this.renderAssistantMessage(chatView, messageEl, completeMessage);
    }

    // Register custom event handlers with cleanup
    this.registerMessageEventHandlers(chatView, messageEl);

    // Insert message into provided target container or the chat container with grouping support
    const container = (targetContainer as (HTMLElement | DocumentFragment) | undefined) || chatView.chatContainer;
    appendMessageToGroupedContainer(container, messageEl, role, { breakGroup: true });
    
    // Toolbars removed entirely (no message or group toolbars)

    // After inserting a new message into the live container, ask the view to trim the DOM if needed.
    // If we're building into a DocumentFragment (batched), skip and let caller handle after append.
    const appendedIntoLiveContainer = container === chatView.chatContainer;
    if (appendedIntoLiveContainer) {
      // During generation, defer DOM management to reduce conflicts with scrolling
      if (chatView.isGenerating) {
        if (window.requestIdleCallback) {
          window.requestIdleCallback(() => chatView.manageDomSize(), { timeout: 1000 });
        } else {
          window.setTimeout(() => chatView.manageDomSize(), 50);
        }
      } else {
        chatView.manageDomSize();
      }
    }

    // Token counter has been removed
  },

  restoreResendInput: async function(chatView: ChatView, content: string): Promise<void> {
    if (!chatView.inputHandler) return;
    try {
      const { trimOuterBlankLines } = await import('../../utils/textUtils');
      chatView.inputHandler.setValue(trimOuterBlankLines(content));
    } catch {
      chatView.inputHandler.setValue(content);
    }
    chatView.inputHandler.focus();
  },

  runResendAction: async function(
    chatView: ChatView,
    input: { messageId: string; content: string }
  ): Promise<{ status: "success" | "cancelled" | "error" }> {
    const { messageId, content } = input;
    const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
    if (index === -1) return { status: "error" };

    if (chatView.isLegacyReadOnlyChat()) {
      new Notice("This archived chat is read-only. Start a new chat to continue from here.");
      return { status: "error" };
    }

    const identity = chatView.getPendingResendIdentity(messageId);
    if (!identity || !chatView.inputHandler) return { status: "error" };
    chatView.inputHandler.setPendingResendIntent(identity);
    await this.restoreResendInput(chatView, content);

    return { status: "success" };
  },

  // Group-related helpers removed; flat list insertion only


  /**
   * Render assistant messages with unified parts and proper tool call registration
   */
  renderAssistantMessage: async function(chatView: ChatView, messageEl: HTMLElement, message: ChatMessage): Promise<void> {
    // Tool call lines are always rendered inline in the tree UI.

    // Always use sequential rendering for consistency
    const partList = chatView.messageRenderer.normalizeMessageToParts(message);
    
    if (partList.parts.length > 0) {
      // Render all parts sequentially
      chatView.messageRenderer.renderUnifiedMessageParts(messageEl, partList.parts);
    }

    // Render URL citations if present.
    if (message.annotations) {
      const urlCitations = message.annotations
        .filter(annotation => annotation.type === "url_citation" && annotation.url_citation)
        .map(annotation => annotation.url_citation)
        .filter((citation): citation is UrlCitation => citation !== undefined);

      if (urlCitations.length > 0) {
        const contentEl = messageEl.querySelector('.systemsculpt-message-content');
        if (contentEl) {
          chatView.messageRenderer.renderCitations(contentEl as HTMLElement, urlCitations);
        }
      }
    }
  },

  /**
   * Register event handlers for message interactions with proper cleanup
   */
  registerMessageEventHandlers: function(chatView: ChatView, messageEl: HTMLElement): void {
    const registerHandler = (element: HTMLElement, eventName: string, handler: EventListener) => {
      element.addEventListener(eventName, handler);
      chatView.register(() => element.removeEventListener(eventName, handler));
    };
    
    const replyHandler = async (e: CustomEvent) => {
      const { content } = e.detail || {};
      const text = typeof content === 'string' ? content : (messageEl.querySelector('.systemsculpt-message-content, .systemsculpt-content-part')?.textContent || '').trim();
      if (!chatView.inputHandler) return;
      // Quote the replied content for context
      const quoted = text
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      const replyTemplate = quoted ? `${quoted}\n\n` : '';
      chatView.inputHandler.setValue(replyTemplate);
      chatView.inputHandler.focus();
    };
    
    registerHandler(messageEl, "reply", replyHandler as EventListener);
  },


  /**
   * Reload all messages with consistent rendering and visual grouping
   */
  reloadAllMessages: async function(chatView: ChatView): Promise<void> {
    // Defer to the ChatView's virtualized rendering implementation.  This keeps
    // reload operations fast even for very large histories.
    await chatView.renderMessagesInChunks();
    return;
  },

  /**
   * DEPRECATED: Remove consolidation logic - we now handle tool messages consistently
   */
  consolidateConsecutiveAssistantMessages: function(messages: ChatMessage[]): ChatMessage[] {
    // Return messages as-is since we now handle tool call integration consistently
    // This prevents the loss of messageParts and maintains the user's intended conversation flow
    return messages;
  },

  loadMessages: async function(chatView: ChatView): Promise<void> {
    if (!chatView.chatContainer) return;
    await this.reloadAllMessages(chatView);
  },
};
