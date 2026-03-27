import { TFile, setIcon } from "obsidian";
import { ChatView } from "./ChatView";
import { type SystemSculptSettings } from "../../types";
import { FileContextManager } from "./FileContextManager";
import { ScrollManagerService } from "./ScrollManagerService";
import { InputHandler } from "./InputHandler";
import { ensureCanonicalId, getDisplayName, getImageCompatibilityInfo } from '../../utils/modelUtils';
import { attachOverlapInsetManager } from "../../core/ui/services/OverlapInsetService";
import { renderChatCreditsIndicator } from "./ui/ChatComposerIndicators";

// ────────────────────────────────────────────────────────────────────────────
// Utility helpers for desktop Pi chat UI
// ────────────────────────────────────────────────────────────────────────────
const TOOL_WARNING_BANNER_CLASS = "systemsculpt-tool-warning-banner";
const IMAGE_CONTEXT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "svg"]);

const isImageExtension = (extension?: string | null): boolean => {
  const normalized = String(extension || "").trim().toLowerCase();
  return normalized !== "" && IMAGE_CONTEXT_EXTENSIONS.has(normalized);
};

const resolvesToImageContextFile = (chatView: ChatView, entry: string): boolean => {
  if (!entry || typeof entry !== "string" || entry.startsWith("doc:")) {
    return false;
  }

  const linkText = entry.replace(/^\[\[(.*?)\]\]$/, "$1").trim();
  if (!linkText) {
    return false;
  }

  const directExtension = linkText.split(".").pop();
  if (isImageExtension(directExtension)) {
    return true;
  }

  const resolved =
    chatView.app.metadataCache.getFirstLinkpathDest(linkText, "") ??
    chatView.app.vault.getAbstractFileByPath(linkText);

  if (resolved instanceof TFile) {
    return isImageExtension(resolved.extension);
  }

  if (resolved && typeof resolved === "object" && "extension" in resolved) {
    return isImageExtension((resolved as { extension?: string | null }).extension);
  }

  return false;
};

const hasImageContextInComposer = (chatView: ChatView): boolean => {
  const contextManager = chatView.contextManager as {
    getContextFiles?: () => Set<string>;
    getProcessingEntries?: () => Array<{ file?: TFile | { extension?: string | null } }>;
  } | null | undefined;

  const contextFiles = contextManager?.getContextFiles?.();
  if (contextFiles) {
    for (const entry of contextFiles) {
      if (resolvesToImageContextFile(chatView, entry)) {
        return true;
      }
    }
  }

  const processingEntries = contextManager?.getProcessingEntries?.() ?? [];
  for (const entry of processingEntries) {
    if (isImageExtension(entry?.file?.extension)) {
      return true;
    }
  }

  return false;
};

const ensureToolWarningBanner = (container: HTMLElement): HTMLElement | null => {
  let banner = container.querySelector(`.${TOOL_WARNING_BANNER_CLASS}`) as HTMLElement | null;
  if (!banner) {
    const composer = container.querySelector(".systemsculpt-chat-composer");
    if (!composer) return null;

    banner = document.createElement("div");
    banner.className = TOOL_WARNING_BANNER_CLASS;
    composer.parentNode?.insertBefore(banner, composer);
  }

  const hasIcon = !!banner.querySelector(".systemsculpt-tool-warning-icon");
  const hasText = !!banner.querySelector(".systemsculpt-tool-warning-text");
  if (!hasIcon || !hasText) {
    banner.empty();

    const iconSpan = document.createElement("span");
    iconSpan.className = "systemsculpt-tool-warning-icon";
    setIcon(iconSpan, "alert-triangle");
    banner.appendChild(iconSpan);

    const textSpan = document.createElement("span");
    textSpan.className = "systemsculpt-tool-warning-text";
    banner.appendChild(textSpan);
  }

  return banner;
};

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
        const licenseChanged =
          oldSettings?.licenseValid !== newSettings?.licenseValid ||
          oldSettings?.licenseKey !== newSettings?.licenseKey;
        if (licenseChanged) {
          void chatView.refreshCreditsBalance();
        } else {
          void chatView.updateCreditsIndicator();
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
        void uiSetup.updateToolCompatibilityWarning(chatView);
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
      isChatReady: () => !chatView.chatId || chatView.isFullyLoaded,
      chatContainer: chatView.chatContainer,
      scrollManager: chatView.scrollManager,
      messageRenderer: chatView.messageRenderer,
      onMessageSubmit: (message) => chatView.persistSubmittedUserMessage(message),
      onAssistantResponse: async (message) => {
        await chatView.persistAssistantMessage(message);
      },
      onError: (error) => chatView.handleError(error),
      onAddContextFile: () => {
        chatView.contextManager.addContextFile();
      },
      onOpenChatSettings: () => chatView.handleOpenChatSettings(),
      plugin: chatView.plugin,
      getChatMarkdown: () => chatView.exportChatAsMarkdown(),
      getChatTitle: () => chatView.getChatTitle(),
      addFileToContext: (file: TFile) => chatView.addFileToContext(file),
      getChatId: () => chatView.chatId,
      onModelChange: () => {
        if (chatView.messages.length === 0) {
          chatView.displayChatStatus();
        }
      },
      chatView: chatView,
    });

    chatView.inputHandler.onModelChange();

    chatView.registerEvent(
      chatView.app.workspace.on("active-leaf-change", (leaf) => {
        try { (window as any).FreezeMonitor?.mark?.('chatview:active-leaf-change'); } catch {}
        if (leaf === chatView.leaf && chatView.inputHandler) {
          chatView.inputHandler.focus();
        }
      })
    );

    chatView.inputHandler.focus();

    void chatView.updateCreditsIndicator();

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

  updateSystemPromptIndicator: async function(chatView: ChatView): Promise<void> {
    if (chatView.systemPromptIndicator) {
      chatView.systemPromptIndicator.remove();
      chatView.systemPromptIndicator = null as any;
    }
  },

  updateCreditsIndicator: async function(chatView: ChatView): Promise<void> {
    const container = chatView.containerEl.children[1] as HTMLElement;
    const toolbarRightGroup = container?.querySelector(".systemsculpt-chat-composer-toolbar-group.mod-right") as HTMLElement | null;
    const targetSection = toolbarRightGroup;
    if (!targetSection) return;

    const isProActive =
      chatView.plugin.settings.licenseValid === true &&
      !!chatView.plugin.settings.licenseKey?.trim();

    if (!isProActive) {
      if (chatView.creditsIndicator) {
        chatView.creditsIndicator.style.display = "none";
      }
      return;
    }

    if (!chatView.creditsIndicator) {
      chatView.creditsIndicator = targetSection.createEl("button", {
        cls: "clickable-icon systemsculpt-chat-composer-button systemsculpt-credits-indicator",
        attr: {
          type: "button",
        },
      }) as HTMLElement;

      chatView.registerDomEvent(chatView.creditsIndicator, "click", () => {
        void chatView.openCreditsBalanceModal();
      });
    } else {
      chatView.creditsIndicator.empty();
      if (chatView.creditsIndicator.parentElement !== targetSection) {
        targetSection.appendChild(chatView.creditsIndicator);
      }
    }

    const settingsButton = targetSection.querySelector(".systemsculpt-chat-settings-button");
    if (settingsButton?.parentElement === targetSection) {
      targetSection.insertBefore(chatView.creditsIndicator, settingsButton);
    }

    chatView.creditsIndicator.style.display = "";
    chatView.creditsIndicator.classList.toggle("is-loading", !chatView.creditsBalance);

    const rendered = renderChatCreditsIndicator(chatView.creditsIndicator, {
      balance: chatView.creditsBalance,
    });

    chatView.creditsIndicator.setAttrs({
      "aria-label": rendered.title,
      title: rendered.title,
    });
    chatView.creditsIndicator.classList.toggle("is-loading", rendered.isLoading);
    chatView.creditsIndicator.classList.toggle("is-low", rendered.isLow);
  },

  /**
   * Updates the compatibility warning banner.
   * Desktop Pi chat only warns about unsupported image inputs.
   */
  updateToolCompatibilityWarning: async function(chatView: ChatView): Promise<void> {
    const container = chatView.containerEl.children[1] as HTMLElement;
    if (!container) return;

    // Find or create the warning banner
    let banner = container.querySelector(`.${TOOL_WARNING_BANNER_CLASS}`) as HTMLElement | null;

    const selectedModelId =
      typeof (chatView as any).getSelectedModelId === "function"
        ? String((chatView as any).getSelectedModelId() || "").trim()
        : String(chatView.selectedModelId || chatView.plugin.settings.selectedModelId || "").trim();

    // If no model selected, hide warning
    if (!selectedModelId) {
      if (banner) banner.style.display = "none";
      return;
    }

    try {
      // Get model info to check compatibility
      const models = await chatView.plugin.modelService.getModels();
      const canonicalId = ensureCanonicalId(selectedModelId);
      const model = models.find(m => ensureCanonicalId(m.id) === canonicalId);

      if (!model) {
        // Model not found in list, hide warning (assume compatible)
        if (banner) banner.style.display = "none";
        return;
      }

      const imageCompat = getImageCompatibilityInfo(model);

      const imageIncompat = !imageCompat.isCompatible && imageCompat.confidence === "high";
      const shouldWarnImages = imageIncompat && hasImageContextInComposer(chatView);

      if (shouldWarnImages) {
        banner = ensureToolWarningBanner(container);
        if (!banner) return;

        // Build warning message based on incompatibilities
        const textEl = banner.querySelector(".systemsculpt-tool-warning-text");
        if (textEl) {
          const modelName = getDisplayName(canonicalId);
          textEl.textContent = `${modelName} doesn't support images. Image context will be skipped.`;
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
