import { TFile, setIcon } from "obsidian";
import { ChatView } from "./ChatView";
import { type SystemSculptSettings } from "../../types";
import { FileContextManager } from "./FileContextManager";
import { ScrollManagerService } from "./ScrollManagerService";
import { InputHandler } from "./InputHandler";
import { attachOverlapInsetManager } from "../../core/ui/services/OverlapInsetService";
import { renderChatCreditsIndicator } from "./ui/ChatComposerIndicators";
import { openExternalUrl } from "../../utils/externalUrl";

// ────────────────────────────────────────────────────────────────────────────
// Utility helpers for the managed desktop chat UI.
// ────────────────────────────────────────────────────────────────────────────
const LICENSE_BANNER_CLASS = "systemsculpt-license-banner";

const ensureLicenseBanner = (container: HTMLElement): HTMLElement | null => {
  let banner = container.querySelector(`.${LICENSE_BANNER_CLASS}`) as HTMLElement | null;
  if (!banner) {
    const composer = container.querySelector(".systemsculpt-chat-composer");
    if (!composer) return null;
    banner = document.createElement("div");
    banner.className = LICENSE_BANNER_CLASS;
    composer.parentNode?.insertBefore(banner, composer);
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
    chatView.registerEvent(
      chatView.app.workspace.on("systemsculpt:settings-updated", (oldSettings, newSettings) => {
        applyReducedMotionClass(newSettings);
        const licenseChanged =
          oldSettings?.licenseValid !== newSettings?.licenseValid ||
          oldSettings?.licenseKey !== newSettings?.licenseKey;
        const messageVisibilityChanged =
          oldSettings?.hideSystemMessagesInChat !== newSettings?.hideSystemMessagesInChat;
        if (licenseChanged) {
          void chatView.refreshCreditsBalance();
        } else {
          void chatView.updateCreditsIndicator();
        }

        if (messageVisibilityChanged) {
          // A chat with no per-chat preference follows the global default, so a
          // global flip must refresh its messages and the composer toggle (#213).
          chatView.inputHandler?.syncHideSystemMessagesButton?.();
          if (chatView.messages.length === 0) {
            chatView.displayChatStatus();
          } else {
            void chatView.renderMessagesInChunks();
          }
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
      getMessages: () => [...chatView.getMessages()],
      isChatReady: () => !chatView.chatId || chatView.isFullyLoaded,
      chatContainer: chatView.chatContainer,
      scrollManager: chatView.scrollManager,
      messageRenderer: chatView.messageRenderer,
      managedChatAdmission: chatView.getManagedChatAdmission(),
      onMessageSubmit: (message) => chatView.persistSubmittedUserMessage(message),
      commitAcceptedUserMessage: (input) => chatView.commitAcceptedUserMessage(input),
      claimAcceptedUserCommit: (result) => chatView.claimAcceptedUserCommit(result),
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
      chatView: chatView,
    });

    if (chatView.messages.length === 0) chatView.displayChatStatus();

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
   * Show a persistent, dismissible license/subscription banner above the
   * composer with a Renew action (#249). Idempotent — reuses an existing banner.
   */
  showLicenseBanner: function(chatView: ChatView, options: { expired: boolean; renewUrl: string }): void {
    const container = chatView.containerEl.children[1] as HTMLElement | undefined;
    if (!container) return;
    const banner = ensureLicenseBanner(container);
    if (!banner) return;

    banner.empty();

    const iconSpan = document.createElement("span");
    iconSpan.className = "systemsculpt-license-banner-icon";
    setIcon(iconSpan, "key-round");
    banner.appendChild(iconSpan);

    const textSpan = document.createElement("span");
    textSpan.className = "systemsculpt-license-banner-text";
    textSpan.textContent = options.expired
      ? "Your SystemSculpt subscription has expired. Renew to keep using the managed AI."
      : "Your SystemSculpt license is invalid. Renew or update your key in Account.";
    banner.appendChild(textSpan);

    const renewBtn = document.createElement("button");
    renewBtn.className = "systemsculpt-license-banner-renew";
    renewBtn.textContent = "Renew";
    renewBtn.addEventListener("click", () => {
      void openExternalUrl(options.renewUrl);
    });
    banner.appendChild(renewBtn);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "systemsculpt-license-banner-dismiss";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    setIcon(dismissBtn, "x");
    dismissBtn.addEventListener("click", () => {
      banner.style.display = "none";
    });
    banner.appendChild(dismissBtn);

    banner.style.display = "flex";
  },

  /** Hide the license banner (e.g. once a credits refresh succeeds). */
  hideLicenseBanner: function(chatView: ChatView): void {
    const container = chatView.containerEl.children[1] as HTMLElement | undefined;
    const banner = container?.querySelector(`.${LICENSE_BANNER_CLASS}`) as HTMLElement | null;
    if (banner) banner.style.display = "none";
  },
};
