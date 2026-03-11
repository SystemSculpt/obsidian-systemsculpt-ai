import { ChatView } from "./ChatView";
import { ChatRole, MultiPartContent, ChatMessage, MessagePart, UrlCitation } from "../../types";
import { ButtonComponent, Notice } from "obsidian";
import { appendMessageToGroupedContainer, removeGroupIfEmpty } from "./utils/MessageGrouping";
// Tool call rendering is fully status-driven from PI tool events.

export const messageHandling = {
  addMessage: async function(chatView: ChatView, role: ChatRole, content: string | MultiPartContent[] | null, existingMessageId?: string, completeMessage?: ChatMessage, targetContainer?: HTMLElement | DocumentFragment): Promise<void> {
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
          setTimeout(() => chatView.manageDomSize(), 50);
        }
      } else {
        chatView.manageDomSize();
      }
    }

    // Token counter has been removed
  },

  runResendAction: async function(
    chatView: ChatView,
    input: { messageId: string; content: string }
  ): Promise<{ status: "success" | "cancelled" | "error" }> {
    const { messageId, content } = input;
    const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
    if (index === -1) {
      return { status: "error" };
    }

    if (chatView.isLegacyReadOnlyChat()) {
      new Notice("This archived chat is read-only. Start a new chat to continue from here.");
      return { status: "error" };
    }

    if (chatView.getPiSessionFile() || chatView.getPiSessionId()) {
      try {
        const forkResult = await chatView.forkPiSessionFromMessage(messageId);
        if (forkResult.cancelled) {
          new Notice("The SystemSculpt session cancelled the branch request for that message.");
          return { status: "cancelled" };
        }
        if (chatView.inputHandler) {
          const piResendText = String(forkResult.text || "").trim();
          chatView.inputHandler.setValue(piResendText || String(content || "").trim());
          chatView.inputHandler.focus();
        }
        new Notice("Branched chat to that message and restored it to the composer.");
        return { status: "success" };
      } catch (error) {
        new Notice(
          `Unable to branch this chat from that message: ${error instanceof Error ? error.message : String(error)}`
        );
        return { status: "error" };
      }
    }

    chatView.messages.splice(index);
    chatView.clearPiSessionState({ save: false });

    if (chatView.messages.length === 0) {
      chatView.chatId = "";
      chatView.chatVersion = 0;
      chatView.isFullyLoaded = false;
    } else {
      await chatView.saveChat();
    }

    await this.reloadAllMessages(chatView);

    if (chatView.inputHandler) {
      try {
        const { trimOuterBlankLines } = await import('../../utils/textUtils');
        const asString = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        chatView.inputHandler.setValue(trimOuterBlankLines(asString));
      } catch {
        chatView.inputHandler.setValue(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
      }
      chatView.inputHandler.focus();
    }

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
    
    const editHandler = async (e: CustomEvent) => {
      if (chatView.isLegacyReadOnlyChat()) {
        new Notice("Editing archived chats is disabled. Start a new chat instead.");
        return;
      }

      if (chatView.getPiSessionFile() || chatView.getPiSessionId()) {
        new Notice("Editing earlier SystemSculpt-session messages is not supported yet. Branch from that user message instead.");
        return;
      }

      const { messageId, newContent } = e.detail;
      const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
      if (index !== -1) {
        const existingMessage = chatView.messages[index];
        const updatedMessage = {
          ...existingMessage,
          content: newContent,
          messageParts: undefined
        };
        chatView.messages[index] = updatedMessage;
        chatView.clearPiSessionState({ save: false });
        
        await chatView.saveChat();
        
        // Re-render just this message with updated content
        const { contentEl: newContentEl } = await chatView.messageRenderer.renderMessage({
          app: chatView.app,
          messageId,
          role: updatedMessage.role,
          content: updatedMessage.content,
          onResend:
            updatedMessage.role === "user"
              ? async (input) => this.runResendAction(chatView, input)
              : undefined,
        });
        
        // Re-apply assistant message rendering if needed
        if (updatedMessage.role === 'assistant') {
          await this.renderAssistantMessage(chatView, messageEl, updatedMessage);
        }
        
        const oldContentEl = messageEl.querySelector(".systemsculpt-message-content");
        if (oldContentEl && newContentEl) {
          oldContentEl.replaceWith(newContentEl);
        }
        
        const updatedStr = typeof updatedMessage.content === "string" ? updatedMessage.content : JSON.stringify(updatedMessage.content);
        messageEl.dataset.content = updatedStr;
      }
    };
    
    const deleteHandler = async (e: CustomEvent) => {
      if (chatView.isLegacyReadOnlyChat()) {
        new Notice("Deleting turns from archived chats is disabled. Start a new chat instead.");
        return;
      }

      if (chatView.getPiSessionFile() || chatView.getPiSessionId()) {
        new Notice("Deleting individual messages is disabled for SystemSculpt-session chats. Branch from a user message instead.");
        return;
      }

      const { messageId } = e.detail;
      const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
      if (index !== -1) {
        chatView.messages.splice(index, 1);
        chatView.clearPiSessionState({ save: false });
        await chatView.saveChat();

        const parentGroup = messageEl.parentElement as HTMLElement | null;
        messageEl.remove();
        if (parentGroup) {
          removeGroupIfEmpty(parentGroup);
        }
      }
    };
    
    registerHandler(messageEl, "reply", replyHandler as EventListener);
    registerHandler(messageEl, "edit", editHandler as EventListener);
    registerHandler(messageEl, "delete", deleteHandler as EventListener);
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
