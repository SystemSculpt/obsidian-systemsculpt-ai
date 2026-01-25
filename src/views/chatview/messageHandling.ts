import { ChatView } from "./ChatView";
import { ChatRole, MultiPartContent, ChatMessage, MessagePart, UrlCitation } from "../../types";
import { ButtonComponent, Notice } from "obsidian";
import { appendMessageToGroupedContainer, removeGroupIfEmpty } from "./utils/MessageGrouping";
// Batch approver UI removed; pending actions now use the tree UI inline

export const messageHandling = {
  addMessage: async function(chatView: ChatView, role: ChatRole, content: string | MultiPartContent[] | null, existingMessageId?: string, completeMessage?: ChatMessage, targetContainer?: HTMLElement | DocumentFragment): Promise<void> {
    const messageId = existingMessageId || chatView.generateMessageId();
    
    const { messageEl, contentEl } = await chatView.messageRenderer.renderMessage({ app: chatView.app, messageId, role, content: content || "" });

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
    appendMessageToGroupedContainer(container, messageEl, role);
    
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

  // Group-related helpers removed; flat list insertion only


  /**
   * Render assistant messages with unified parts and proper tool call registration
   */
  renderAssistantMessage: async function(chatView: ChatView, messageEl: HTMLElement, message: ChatMessage): Promise<void> {
    // CRITICAL FIX: Register tool calls with ToolCallManager when loading from storage
    if (message.tool_calls && message.tool_calls.length > 0 && chatView.toolCallManager) {
      for (const toolCall of message.tool_calls) {
        // Check if the tool call is already registered
        const existingToolCall = chatView.toolCallManager.getToolCall(toolCall.id);
        if (!existingToolCall) {
          // Tool call not in manager, register it
          const serializedToolCall = {
            id: toolCall.id,
            request: toolCall.request,
            state: toolCall.state,
            timestamp: toolCall.timestamp,
            approvedAt: toolCall.approvedAt,
            executionStartedAt: toolCall.executionStartedAt,
            executionCompletedAt: toolCall.executionCompletedAt,
            result: toolCall.result,
            autoApproved: toolCall.autoApproved
          };
          chatView.toolCallManager.restoreToolCall(serializedToolCall, message.message_id);
        }
      }
    }

    // Previously we hid pending lines and showed a batch approver.
    // Now we always show pending lines inline using the tree UI.

    // Always use sequential rendering for consistency
    const partList = chatView.messageRenderer.normalizeMessageToParts(message);
    
    if (partList.parts.length > 0) {
      // Render all parts sequentially
      chatView.messageRenderer.renderUnifiedMessageParts(messageEl, partList.parts);
    }

    // Handle web search citations if present
    if (message.webSearchEnabled && message.annotations) {
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
    
    const resubmitHandler = async (e: CustomEvent) => {
      const { messageId, content } = e.detail;
      const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
      if (index === -1) return;

      // Remove all messages from the resubmitted one onward
      chatView.messages.splice(index);

      if (chatView.messages.length === 0) {
        // We just cleared the entire chat.  Treat this as starting a brand-new
        // conversation rather than trying to "update" an existing file with
        // zero messages (which triggers the empty-save safeguard).

        chatView.chatId = "";           // Force new chat ID on next save
        chatView.chatVersion = 0;
        chatView.isFullyLoaded = false;  // Allow initial save again

        // No need to save now – we'll persist once the user actually sends
        // their freshly-edited message.
      } else {
        // Normal case (resubmit midway through a chat) – save remaining history
        await chatView.saveChat();
      }

      // Re-render visual state to reflect deletion
      await this.reloadAllMessages(chatView);

      // Put the text back in the input box for editing, trimming outer blank lines
      if (chatView.inputHandler) {
        try {
          const { trimOuterBlankLines } = await import('../../utils/textUtils');
          const asString = typeof content === 'string' ? content : JSON.stringify(content ?? '');
          const normalized = trimOuterBlankLines(asString);
          chatView.inputHandler.setValue(normalized);
        } catch {
          // Fallback without normalization if dynamic import fails
          chatView.inputHandler.setValue(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
        }
        chatView.inputHandler.focus();
      }
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
        
        await chatView.saveChat();
        
        // Re-render just this message with updated content
        const { contentEl: newContentEl } = await chatView.messageRenderer.renderMessage({
          app: chatView.app,
          messageId,
          role: updatedMessage.role,
          content: updatedMessage.content,
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
      const { messageId } = e.detail;
      const index = chatView.messages.findIndex((msg) => msg.message_id === messageId);
      if (index !== -1) {
        chatView.messages.splice(index, 1);
        await chatView.saveChat();

        const parentGroup = messageEl.parentElement as HTMLElement | null;
        messageEl.remove();
        if (parentGroup) {
          removeGroupIfEmpty(parentGroup);
        }
      }
    };
    
    registerHandler(messageEl, "resubmit", resubmitHandler as EventListener);
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
