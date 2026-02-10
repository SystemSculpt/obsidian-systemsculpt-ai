import { App, ItemView, Notice, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import { ChatView } from "./ChatView";
import { ChatMessage, ToolCall, type SystemSculptSettings } from "../../types";
import { StandardModelSelectionModal, ModelSelectionResult, ModelSelectionOptions } from "../../modals/StandardModelSelectionModal";
import { showPopup } from "../../core/ui/";
import { FileContextManager } from "./FileContextManager";
import { ScrollManagerService } from "./ScrollManagerService";
import { InputHandler } from "./InputHandler";
import { ensureCanonicalId, getCanonicalId, getModelLabelWithProvider, getDisplayName, getToolCompatibilityInfo, getImageCompatibilityInfo } from '../../utils/modelUtils';
import { attachOverlapInsetManager } from "../../core/ui/services/OverlapInsetService";

// ────────────────────────────────────────────────────────────────────────────
// Utility: Build the label for the Agent Tooling indicator with counts
// ────────────────────────────────────────────────────────────────────────────
import type SystemSculptPlugin from '../../main';

export const uiSetup = {
  onOpen: async function(chatView: ChatView): Promise<void> {
    // Ensure core Mermaid plugin is enabled for diagram rendering
    try {
      // Access the core plugin manager (may not be typed in App interface)
      // @ts-ignore
      const plugins = (chatView.app as any).plugins;
      if (plugins && !plugins.enabledPlugins.has("mermaid")) {
        // @ts-ignore
        void plugins.enablePlugin("mermaid");
      }
    } catch (e) {
    }
    const container = chatView.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("systemsculpt-chat-container");
    attachOverlapInsetManager(chatView, {
      app: chatView.app,
      container,
      cssVariable: "--systemsculpt-status-bar-offset",
      applyPaddingBottom: true,
      getAnchor: () => document.body.querySelector(".status-bar") as HTMLElement | null,
    });

    const applyReducedMotionClass = (settings: SystemSculptSettings) => {
      if (settings.respectReducedMotion) {
        container.addClass("systemsculpt-reduced-motion");
      } else {
        container.removeClass("systemsculpt-reduced-motion");
      }
    };

    applyReducedMotionClass(chatView.plugin.settings);
    const hasCompatibilityChange = (oldSettings?: SystemSculptSettings, newSettings?: SystemSculptSettings): boolean => {
      const oldTools = Object.keys(oldSettings?.runtimeToolIncompatibleModels || {});
      const newTools = Object.keys(newSettings?.runtimeToolIncompatibleModels || {});
      if (oldTools.length !== newTools.length) return true;
      const newToolSet = new Set(newTools);
      for (const key of oldTools) {
        if (!newToolSet.has(key)) return true;
      }

      const oldImages = Object.keys(oldSettings?.runtimeImageIncompatibleModels || {});
      const newImages = Object.keys(newSettings?.runtimeImageIncompatibleModels || {});
      if (oldImages.length !== newImages.length) return true;
      const newImageSet = new Set(newImages);
      for (const key of oldImages) {
        if (!newImageSet.has(key)) return true;
      }

      return false;
    };
    chatView.registerEvent(
      chatView.app.workspace.on("systemsculpt:settings-updated", (oldSettings, newSettings) => {
        applyReducedMotionClass(newSettings);
        if (hasCompatibilityChange(oldSettings, newSettings)) {
          void uiSetup.updateToolCompatibilityWarning(chatView);
        }
      })
    );

    // Enable drag and drop in the main view container
    chatView.setupDragAndDrop(container);

    // Initialize the chat context manager (no top drawer UI)
    chatView.contextManager = new FileContextManager({
      app: chatView.app,
      onContextChange: async () => {
        // Only save if chat is fully loaded or it's a new chat
        // This prevents wiping existing chats during initialization
        if (chatView.isFullyLoaded || !chatView.chatId) {
          await chatView.saveChat();
        }
        // Keep empty-chat status synced with context state
        if (chatView.messages.length === 0) {
          chatView.displayChatStatus();
        }
      },
      plugin: chatView.plugin,
    });

    // Messages container
    chatView.chatContainer = container.createEl("div", { cls: "systemsculpt-messages-container" });

    // Apply initial chat font size class without saving
    chatView.chatContainer.classList.add(`systemsculpt-chat-${chatView.chatFontSize}`);

    // Remove the MutationObserver that was creating spam logs
    // If we need DOM mutation tracking in the future, we can add it back
    // with more selective and less verbose logging

    // Define the event listener function
    const handleMessageEdited = async (event: Event) => {
      // Cast to CustomEvent to access detail
      const customEvent = event as CustomEvent;
      const { messageId, newContent } = customEvent.detail;
      const messageIndex = chatView.messages.findIndex(msg => msg.message_id === messageId);
      if (messageIndex !== -1) {
        // Ensure content type matches (simple string for now)
        if (typeof chatView.messages[messageIndex].content === 'string') {
           chatView.messages[messageIndex].content = newContent;
           await chatView.saveChat();
        } else {
             // Handle potential MultiPartContent edits if needed in the future
             // For now, let's assume it's text part if it's an array
             if (Array.isArray(chatView.messages[messageIndex].content)) {
                 const textPart = (chatView.messages[messageIndex].content as any[]).find(p => p.type === 'text');
                 if (textPart) {
                     textPart.text = newContent;
                     await chatView.saveChat();
                 } else {
                 }
             }
        }
      } else {
      }
    };

    // Add the event listener using standard addEventListener
    chatView.chatContainer.addEventListener('message-edited', handleMessageEdited);

    // Register cleanup to remove the listener on unload
    chatView.register(() => {
      chatView.chatContainer.removeEventListener('message-edited', handleMessageEdited);
    });

    // Create scroll-to-bottom button
    const scrollToBottomButton = document.createElement('button');
    scrollToBottomButton.className = 'systemsculpt-scroll-to-bottom';
    scrollToBottomButton.setAttribute('aria-label', 'Scroll to bottom');
    scrollToBottomButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3v10m0 0l-4-4m4 4l4-4"/>
      </svg>
    `;
    scrollToBottomButton.style.display = 'none';
    container.appendChild(scrollToBottomButton);

    chatView.scrollManager = new ScrollManagerService({
      container: chatView.chatContainer,
      onAutoScrollChange: (isAutoScroll) => {
        // Show/hide jump button
        scrollToBottomButton.style.display = isAutoScroll ? 'none' : 'flex';
      }
    });

    // Handle button click
    scrollToBottomButton.addEventListener('click', () => {
      chatView.scrollManager.forceScrollToBottom();
    });

    chatView.inputHandler = new InputHandler({
      app: chatView.app,
      container,
      aiService: chatView.aiService,
      getMessages: () => chatView.getMessages(),
      getSelectedModelId: () => chatView.selectedModelId,
      getContextFiles: () => chatView.contextManager.getContextFiles(),
      getSystemPrompt: () => ({ type: chatView.systemPromptType, path: chatView.systemPromptPath }),
      isChatReady: () => !chatView.chatId || chatView.isFullyLoaded,
      chatContainer: chatView.chatContainer,
      scrollManager: chatView.scrollManager,
      messageRenderer: chatView.messageRenderer,
      onMessageSubmit: async (message) => {
        chatView.messages.push(message);
        await chatView.saveChat();
        await chatView.addMessage(message.role, message.content, message.message_id);
      },
      onAssistantResponse: async (message) => {
        const existingMessageIndex = chatView.messages.findIndex(m => m.message_id === message.message_id);
        if (existingMessageIndex !== -1) {
          const existingMessage = chatView.messages[existingMessageIndex];
          
          // Explicitly merge tool calls to preserve results
          let mergedToolCalls: ToolCall[] | undefined = undefined;
          if (existingMessage.tool_calls || message.tool_calls) {
            const existingMap = new Map((existingMessage.tool_calls || []).map(tc => [tc.id, tc]));
            const newMap = new Map((message.tool_calls || []).map(tc => [tc.id, tc]));
            
            const mergedMap = new Map([...existingMap, ...newMap]);
            
            // Ensure results from existing tool calls are not lost
            for (const [id, existingTc] of existingMap) {
              if (existingTc.result && mergedMap.has(id)) {
                const mergedTc = mergedMap.get(id)!;
                if (!mergedTc.result) {
                  mergedTc.result = existingTc.result;
                }
              }
            }
            
            mergedToolCalls = Array.from(mergedMap.values());
          }

          const mergedMessage: ChatMessage = {
            ...existingMessage,
            ...message,
            content: message.content || existingMessage.content,
            reasoning: message.reasoning || existingMessage.reasoning,
            tool_calls: mergedToolCalls,
            messageParts: message.messageParts || existingMessage.messageParts,
          };
          chatView.messages[existingMessageIndex] = mergedMessage;
        } else {
          chatView.messages.push(message);
        }
        await chatView.saveChat();
      },
      onContextFileAdd: async (wikilink) => {
        const files = chatView.contextManager.getContextFiles();
        files.add(wikilink);
        chatView.contextManager.setContextFiles(Array.from(files));
        await chatView.saveChat();
        if (chatView.messages.length === 0) {
          chatView.displayChatStatus();
        }
        // Token counter update removed
      },
      onError: (error) => chatView.handleError(error),
      onAddContextFile: () => {
        chatView.contextManager.addContextFile();
      },
      onEditSystemPrompt: () => chatView.handleSystemPromptEdit(),
      plugin: chatView.plugin,
      getChatMarkdown: () => chatView.exportChatAsMarkdown(),
      getChatTitle: () => chatView.getChatTitle(),
      addFileToContext: (file: TFile) => chatView.addFileToContext(file),
      chatStorage: chatView.chatStorage,
      getChatId: () => chatView.chatId,
      toolCallManager: chatView.toolCallManager,
      addMessageToHistory: chatView.addMessageToHistory.bind(chatView),
      chatView: chatView,
    });

    chatView.inputHandler.onModelChange();

    // Wire up lightweight sync so the empty-chat status reflects runtime toggles
    // without forcing a full re-render elsewhere.
    const originalOnModelChange = chatView.inputHandler.onModelChange.bind(chatView.inputHandler);
    chatView.inputHandler.onModelChange = () => {
      originalOnModelChange();
      if (chatView.messages.length === 0) {
        chatView.displayChatStatus();
      }
    };

    chatView.registerEvent(
      chatView.app.workspace.on("active-leaf-change", (leaf) => {
        try { (window as any).FreezeMonitor?.mark?.('chatview:active-leaf-change'); } catch {}
        if (leaf === chatView.leaf && chatView.inputHandler) {
          chatView.inputHandler.focus();
        }
      })
    );

    chatView.inputHandler.focus();

    // Initialize model indicator without forcing model fetch. The indicator
    // will render a lightweight state and fetch only when user opens modal
    // or when generation begins.
    void chatView.updateModelIndicator();
    
    // Initialize system prompt indicator
    void chatView.updateSystemPromptIndicator();
    void chatView.updateAgentModeIndicator();

    // Check if we need to prompt for initial model selection
    if (!chatView.plugin.settings.selectedModelId && !chatView.plugin.hasPromptedForDefaultModel) {
      // Mark that we've prompted to prevent duplicates
      chatView.plugin.hasPromptedForDefaultModel = true;
      
      // Use setTimeout to allow the view to fully render first
      setTimeout(async () => {
        const result = await showPopup(
          chatView.app,
          "Welcome to SystemSculpt! To get started, please select a default AI model for your chats.",
          { title: "Select Default Model", icon: "bot", primaryButton: "Choose Model", secondaryButton: "Skip for Now" }
        );

        if (result?.confirmed) {
          try {
            // Open the modal immediately; it will lazy-load models and update progressively
            const modal = new StandardModelSelectionModal({
              app: chatView.app,
              plugin: chatView.plugin,
              currentModelId: "",
              onSelect: async (result: ModelSelectionResult) => {
                // Since this is the initial selection, always set as default
                await chatView.plugin.getSettingsManager().updateSettings({ selectedModelId: result.modelId });
                chatView.selectedModelId = result.modelId;
                await chatView.updateModelIndicator();
                new Notice("Default model set! You can change this anytime in settings.", 3000);
              }
            });
            modal.open();
          } catch (error) {
            new Notice("Failed to open model selector. Please try again from settings.", 5000);
          }
        }
      }, 500); // Small delay to ensure view is ready
    } else if (chatView.plugin.settings.selectedModelId) {
      // If we have a default model and this chat doesn't have one set, use the default
      if (!chatView.selectedModelId) {
        const useLatestEverywhere = chatView.plugin.settings.useLatestModelEverywhere ?? true;
        const isStandardMode = chatView.plugin.settings.settingsMode !== 'advanced';
        if (useLatestEverywhere || isStandardMode) {
          chatView.selectedModelId = chatView.plugin.settings.selectedModelId;
        }
      }
    }

    chatView.toolCallManager.on('tool-call:state-changed', async ({ toolCall }) => {
      // Find the message this tool call belongs to
      const message = chatView.messages.find(m => m.message_id === toolCall.messageId);
      if (!message) return;

      // Find the specific tool call in the message's array
      const toolCallInMessage = message.tool_calls?.find(tc => tc.id === toolCall.id);
      if (!toolCallInMessage) return;

      // Update the state and result
      toolCallInMessage.state = toolCall.state;
      toolCallInMessage.result = toolCall.result;

      // Keep messageParts in sync with tool_calls – update matching part.data by id
      if (Array.isArray(message.messageParts)) {
        for (const part of message.messageParts) {
          if (part.type === 'tool_call' && (part.data as any)?.id === toolCall.id) {
            (part as any).data = toolCallInMessage;
          }
        }
      }
      
      // Persist the change (but only after the chat has completed loading)
      if (chatView.isFullyLoaded) {
        await chatView.saveChat();
      }
      
      // Find the message element and re-render its parts
      const messageEl = chatView.chatContainer.querySelector(`.systemsculpt-message[data-message-id="${message.message_id}"]`) as HTMLElement;
      if (messageEl) {
      // Tool call lines are always rendered inline in the tree.

        // Targeted re-render with non-streaming flag
        const partList = chatView.messageRenderer.normalizeMessageToParts(message);
        chatView.messageRenderer.renderUnifiedMessageParts(messageEl, partList.parts, false);
      }
    });

    // After ensuring Mermaid is enabled, configure theme variables once
    try {
      const m = (globalThis as any).mermaid;
      if (m && !m.__ssConfigured) {
        const rootStyle = getComputedStyle(document.body);
        const accent = rootStyle.getPropertyValue('--interactive-accent').trim() || '#666';
        const bgPrimary = rootStyle.getPropertyValue('--background-primary').trim() || '#fff';
        const bgSecondary = rootStyle.getPropertyValue('--background-secondary').trim() || '#f4f4f4';
        const textNorm = rootStyle.getPropertyValue('--text-normal').trim() || '#333';
        m.initialize({
          startOnLoad: false,
          theme: 'base',
          themeVariables: {
            primaryColor: bgSecondary,
            primaryBorderColor: accent,
            primaryTextColor: textNorm,
            lineColor: accent,
            textColor: textNorm,
            tertiaryColor: bgPrimary
          }
        });
        m.__ssConfigured = true;
      }
    } catch (e) {
    }

    // Token counter update removed
    
    // Now that UI is set up, render messages or status
    if (chatView.messages.length === 0) {
      // For empty chats, display the status
      chatView.displayChatStatus();
    } else {
      // For existing chats, render the messages
      void chatView.renderMessagesInChunks();
    }
  },

  /**
   * Ensures buttons are always in the correct order:
   * 1. Model button
   * 2. System Prompt button
   * 3. Agent Mode button
   */
  ensureButtonOrder: function(chatView: ChatView): void {
    const container = chatView.containerEl.children[1] as HTMLElement;
    const modelSection = container?.querySelector(".systemsculpt-model-indicator-section") as HTMLElement | null;
    if (!modelSection) return;

    // Clear the section and re-add buttons in correct order
    const buttons: HTMLElement[] = [];
    
    // 1. Model button (always first)
    if (chatView.modelIndicator) {
      buttons.push(chatView.modelIndicator);
    }
    
    // 2. System Prompt button (always second)
    if (chatView.systemPromptIndicator) {
      buttons.push(chatView.systemPromptIndicator);
    }

    // 3. Agent Mode button (always third)
    if (chatView.agentModeIndicator) {
      buttons.push(chatView.agentModeIndicator);
    }
    
    // Remove all buttons from the section
    modelSection.empty();
    
    // Add them back in the correct order
    buttons.forEach(button => {
      modelSection.appendChild(button);
    });
  },

  updateModelIndicator: async function(chatView: ChatView): Promise<void> {
    // The actual container is containerEl.children[1], not containerEl itself
    const container = chatView.containerEl.children[1] as HTMLElement;
    const modelSection = container?.querySelector(".systemsculpt-model-indicator-section") as HTMLElement | null;
    if (!modelSection) return;

    if (!chatView.modelIndicator) {
      // (modelSection already acquired above)
      
      chatView.modelIndicator = modelSection.createEl("div", {
        cls: "systemsculpt-model-indicator systemsculpt-chip",
      }) as HTMLElement;

      // Register event handlers only once when creating the indicator
      chatView.registerDomEvent(chatView.modelIndicator, "click", async () => {
        const modal = new StandardModelSelectionModal({
            app: chatView.app,
            plugin: chatView.plugin,
            currentModelId: chatView.selectedModelId || "",
            onSelect: async (result: ModelSelectionResult) => {
              await chatView.setSelectedModelId(result.modelId);
              new Notice("Model updated for this chat.", 3000);
          }
        });
        modal.open();
      });

      chatView.registerDomEvent(chatView.modelIndicator, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          (event.target as HTMLElement)?.click();
        }
      });
    } else {
      chatView.modelIndicator.empty();
    }

    // Always allow model changes
    chatView.modelIndicator.setAttrs({
      role: "button",
      tabindex: 0,
      'aria-label': 'Change chat model'
    });

    if (!chatView.selectedModelId || chatView.selectedModelId.trim() === "" || chatView.selectedModelId === "unknown" || chatView.selectedModelId.includes("unknown")) {
      if (chatView.modelIndicator) {
        // Add bot icon
        const iconSpan = chatView.modelIndicator.createSpan({ cls: "systemsculpt-model-indicator-icon" });
        setIcon(iconSpan, "bot");
        
        chatView.modelIndicator.createSpan({ text: "No model selected" });
        chatView.modelIndicator.addClass("systemsculpt-no-model");
        chatView.modelIndicator.setAttr('aria-label', 'No model selected, click to choose one');
      }
      return;
    }

    try {
      // Build display purely from the stored ID to avoid network fetches
      const canonicalId = ensureCanonicalId(chatView.selectedModelId);
      chatView.currentModelName = getDisplayName(canonicalId);
      if (chatView.modelIndicator) {
        chatView.modelIndicator.removeClass("systemsculpt-no-model");
      }

      // Always show current model and allow changing it
      const iconSpan = chatView.modelIndicator.createSpan({ cls: "systemsculpt-model-indicator-icon" });
      setIcon(iconSpan, "bot");
      const labelText = getModelLabelWithProvider(canonicalId);
      chatView.modelIndicator.createSpan({ text: labelText });
      const arrowSpan = chatView.modelIndicator.createSpan({ cls: "systemsculpt-model-indicator-arrow" });
      setIcon(arrowSpan, "chevron-down");
      chatView.modelIndicator.setAttr('aria-label', `Current model: ${labelText}. Click to change.`);
      chatView.modelIndicator.setAttr('title', `Current model: ${labelText}`);
      chatView.modelIndicator.removeClass('systemsculpt-model-locked');
    } catch (error) {
      chatView.currentModelName = chatView.selectedModelId || 'Error';
      if (chatView.modelIndicator) {
        chatView.modelIndicator.removeClass("systemsculpt-no-model");
        const errorText = `Error loading model (${chatView.currentModelName})`;
        chatView.modelIndicator.createSpan({ text: errorText });
        chatView.modelIndicator.setAttr('aria-label', `${errorText}. Click to try changing.`);
        chatView.modelIndicator.setAttr('title', `${errorText}`);
      }
    }

    // Ensure the model indicator is visible
    if (chatView.modelIndicator) {
      chatView.modelIndicator.style.display = "";
    }

    // Ensure correct button order
    this.ensureButtonOrder(chatView);

    // Update tool compatibility warning after model change
    await this.updateToolCompatibilityWarning(chatView);

    // Token counter update removed
  },

  updateSystemPromptIndicator: async function(chatView: ChatView): Promise<void> {
    // The actual container is containerEl.children[1], not containerEl itself
    const container = chatView.containerEl.children[1] as HTMLElement;
    const modelSection = container?.querySelector(".systemsculpt-model-indicator-section") as HTMLElement | null;
    if (!modelSection) {
      return;
    }

    // Ensure the system prompt indicator exists and is visible
    if (chatView.systemPromptIndicator) {
      chatView.systemPromptIndicator.style.display = "";
    }

    if (!chatView.systemPromptIndicator) {
      // modelSection already acquired
      
      chatView.systemPromptIndicator = modelSection.createEl("div", {
        cls: "systemsculpt-model-indicator systemsculpt-chip",
      }) as HTMLElement;

      // Register event handlers only once when creating the indicator
      chatView.registerDomEvent(chatView.systemPromptIndicator, "click", async () => {
        const { StandardSystemPromptSelectionModal } = await import("../../modals/StandardSystemPromptSelectionModal");
        const modal = new StandardSystemPromptSelectionModal({
          app: chatView.app,
          plugin: chatView.plugin,
          currentType: chatView.systemPromptType || "general-use",
          currentPath: chatView.systemPromptPath,
          onSelect: async (result) => {
            // Update the chat view's system prompt
            chatView.systemPromptType = result.type;
            if (result.type === "custom") {
              chatView.systemPromptPath = result.path;
            } else {
              chatView.systemPromptPath = undefined;
            }
            
            // Update current prompt
            chatView.currentPrompt = result.prompt;
            
            // If policy is enabled or in Standard mode, promote this selection as the default for new chats
            try {
              const useLatestPrompt = chatView.plugin.settings.useLatestSystemPromptForNewChats ?? true;
              const isStandardMode = chatView.plugin.settings.settingsMode !== 'advanced';
              if (useLatestPrompt || isStandardMode) {
                await chatView.plugin.getSettingsManager().updateSettings({
                  systemPromptType: result.type,
                  systemPromptPath: result.type === 'custom' ? (result.path || "") : ""
                });
                chatView.plugin.emitter?.emit?.('systemPromptSettingsChanged');
              }
            } catch {}

            // Save chat with new system prompt
            await chatView.saveChat();
            
            // Update the indicator
            await chatView.updateSystemPromptIndicator();
            
            new Notice("System prompt updated for this chat.", 3000);
            // Keep the empty-chat status panel in sync
            if (chatView.messages.length === 0) {
              chatView.displayChatStatus();
            }
          }
        });
        modal.open();
      });

      // Add keyboard support
      chatView.registerDomEvent(chatView.systemPromptIndicator, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          (event.target as HTMLElement)?.click();
        }
      });
    } else {
      chatView.systemPromptIndicator.empty();
    }

    // Set interactive attributes
    chatView.systemPromptIndicator.setAttrs({
      role: "button",
      tabindex: 0,
      'aria-label': 'Change system prompt'
    });

    // Show the actual prompt type and allow changes
    let promptLabel = "System Prompt";
    
    switch (chatView.systemPromptType) {
        case "general-use":
          promptLabel = "General Use";
          break;
        case "concise":
          promptLabel = "Concise";
          break;
        case "agent":
          promptLabel = "Agent Prompt";
          break;
        case "custom":
          if (chatView.systemPromptPath) {
            const filename = chatView.systemPromptPath.split('/').pop() || 'Custom';
            const baseName = filename.replace('.md', '');
            promptLabel = baseName;
          } else {
            promptLabel = "Custom";
          }
          break;
      }

      // Add appropriate icon based on prompt type
      const iconSpan = chatView.systemPromptIndicator.createSpan({ cls: "systemsculpt-model-indicator-icon" });
      setIcon(iconSpan, chatView.systemPromptType === "agent" ? "folder-open" : "sparkles");
      
      chatView.systemPromptIndicator.createSpan({ text: promptLabel });
      
      // Show dropdown arrow to indicate it can be changed
      const arrowSpan = chatView.systemPromptIndicator.createSpan({ cls: "systemsculpt-model-indicator-arrow" });
      setIcon(arrowSpan, "chevron-down");
      
    const agentModeNote = (chatView.systemPromptType === "agent" && !chatView.agentMode)
      ? " Agent Mode is off; enable it to use tools."
      : "";
    const promptTitle = `Current system prompt: ${promptLabel}. Click to change.${agentModeNote}`;
    chatView.systemPromptIndicator.setAttr('aria-label', promptTitle);
    chatView.systemPromptIndicator.setAttr('title', promptTitle);
    if (chatView.systemPromptIndicator) {
      chatView.systemPromptIndicator.removeClass('systemsculpt-system-prompt-locked');
    }

    // Ensure correct button order
    this.ensureButtonOrder(chatView);

    // Token counter update removed
  },

  updateAgentModeIndicator: async function(chatView: ChatView): Promise<void> {
    const container = chatView.containerEl.children[1] as HTMLElement;
    const modelSection = container?.querySelector(".systemsculpt-model-indicator-section") as HTMLElement | null;
    if (!modelSection) return;

    if (!chatView.agentModeIndicator) {
      chatView.agentModeIndicator = modelSection.createEl("div", {
        cls: "systemsculpt-model-indicator systemsculpt-chip systemsculpt-agent-mode-indicator",
      }) as HTMLElement;

      chatView.registerDomEvent(chatView.agentModeIndicator, "click", async () => {
        await chatView.setAgentMode(!chatView.agentMode);
      });

      chatView.registerDomEvent(chatView.agentModeIndicator, "keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          (event.target as HTMLElement)?.click();
        }
      });
    } else {
      chatView.agentModeIndicator.empty();
    }

    const isOn = !!chatView.agentMode;
    chatView.agentModeIndicator.toggleClass("is-on", isOn);
    chatView.agentModeIndicator.toggleClass("is-off", !isOn);

    chatView.agentModeIndicator.setAttrs({
      role: "button",
      tabindex: 0,
      "aria-label": isOn
        ? "Agent Mode enabled. Click to disable."
        : "Agent Mode disabled. Click to enable.",
      title: isOn
        ? "Agent Mode enabled (click to disable)"
        : "Agent Mode disabled (click to enable)",
    });

    const iconSpan = chatView.agentModeIndicator.createSpan({ cls: "systemsculpt-model-indicator-icon" });
    setIcon(iconSpan, "wrench");
    chatView.agentModeIndicator.createSpan({ text: `Agent ${isOn ? "On" : "Off"}` });

    this.ensureButtonOrder(chatView);
  },

  /**
   * Updates the tool compatibility warning banner.
   * Shows a warning when the current model doesn't support tools or images.
   * Tool warnings are suppressed when Agent Mode is disabled.
   */
  updateToolCompatibilityWarning: async function(chatView: ChatView): Promise<void> {
    const container = chatView.containerEl.children[1] as HTMLElement;
    if (!container) return;

    // Find or create the warning banner
    const BANNER_CLASS = "systemsculpt-tool-warning-banner";
    let banner = container.querySelector(`.${BANNER_CLASS}`) as HTMLElement | null;

    // If no model selected, hide warning
    if (!chatView.selectedModelId || chatView.selectedModelId.trim() === "") {
      if (banner) banner.style.display = "none";
      return;
    }

    try {
      // Get model info to check compatibility
      const models = await chatView.plugin.modelService.getModels();
      const canonicalId = ensureCanonicalId(chatView.selectedModelId);
      const model = models.find(m => ensureCanonicalId(m.id) === canonicalId);

      if (!model) {
        // Model not found in list, hide warning (assume compatible)
        if (banner) banner.style.display = "none";
        return;
      }

      const toolCompat = getToolCompatibilityInfo(model);
      const imageCompat = getImageCompatibilityInfo(model);

      // Check for HIGH confidence incompatibilities (includes runtime-discovered)
      const toolIncompat = !toolCompat.isCompatible && toolCompat.confidence === "high";
      const imageIncompat = !imageCompat.isCompatible && imageCompat.confidence === "high";

      const shouldWarnTools = chatView.agentMode && toolIncompat;
      const shouldWarnImages = imageIncompat;

      if (shouldWarnTools || shouldWarnImages) {
        // Create banner if it doesn't exist
        if (!banner) {
          const composer = container.querySelector(".systemsculpt-chat-composer");
          if (!composer) return;

          banner = document.createElement("div");
          banner.className = BANNER_CLASS;

          // Create icon span using safe DOM methods
          const iconSpan = document.createElement("span");
          iconSpan.className = "systemsculpt-tool-warning-icon";
          setIcon(iconSpan, "alert-triangle");
          banner.appendChild(iconSpan);

          // Create text span
          const textSpan = document.createElement("span");
          textSpan.className = "systemsculpt-tool-warning-text";
          banner.appendChild(textSpan);

          // Insert banner before the composer
          composer.parentNode?.insertBefore(banner, composer);
        }

        // Build warning message based on incompatibilities
        const textEl = banner.querySelector(".systemsculpt-tool-warning-text");
        if (textEl) {
          const modelName = getDisplayName(canonicalId);
          if (shouldWarnTools && shouldWarnImages) {
            textEl.textContent = `${modelName} doesn't support agent tools or images.`;
          } else if (shouldWarnTools) {
            textEl.textContent = `${modelName} doesn't support agent tools. Switch to Claude, GPT-4, etc.`;
          } else {
            textEl.textContent = `${modelName} doesn't support images. Image context will be skipped.`;
          }
        }
        banner.style.display = "flex";
      } else {
        // Model is compatible, hide warning
        if (banner) banner.style.display = "none";
      }
    } catch (error) {
      // On error, hide warning
      if (banner) banner.style.display = "none";
    }
  },
};
