import { ItemView, WorkspaceLeaf, TFile, Notice, App, MarkdownRenderer, setIcon, Component } from "obsidian";
import { SystemSculptService } from "../../services/SystemSculptService";
import { ChatMessage, ChatRole, MultiPartContent, LICENSE_URL, SystemSculptSettings } from "../../types";
import { ChatStorageService } from "./ChatStorageService";
import { ScrollManagerService } from "./ScrollManagerService";
import type SystemSculptPlugin from "../../main";
import { showPopup, showAlert } from "../../core/ui/";
import { SystemSculptError } from "../../utils/errors";
import { MessageRenderer } from "./MessageRenderer";
import { InputHandler } from "./InputHandler";
import { FileContextManager } from "./FileContextManager";
import { SystemPromptService } from "../../services/SystemPromptService";
import { LoadChatModal } from "./LoadChatModal";
import { generateDefaultChatTitle, sanitizeChatTitle } from "../../utils/titleUtils";
import { StandardModelSelectionModal } from "../../modals/StandardModelSelectionModal";

import { ensureCanonicalId, getDisplayName } from "../../utils/modelUtils";
import { errorLogger } from "../../utils/errorLogger";
import { GENERAL_USE_PRESET } from "../../constants/prompts";
import { ToolCallManager } from "./ToolCallManager";
import { MCPService } from "./MCPService";
import { ChatExportService } from "./export/ChatExportService";
import type { ChatExportOptions } from "../../types/chatExport";
import type { ChatExportResult } from "./export/ChatExportTypes";
import { removeGroupIfEmpty } from "./utils/MessageGrouping";
import { tryCopyToClipboard } from "../../utils/clipboard";
import type { DocumentProcessingProgressEvent } from "../../types/documentProcessing";
import { ChatDebugLogService } from "./ChatDebugLogService";
// import { AGENT_CONFIG } from "../../constants/agent"; // no longer force agent model

import { uiSetup } from "./uiSetup";
import { messageHandling } from "./messageHandling";
import { eventHandling } from "./eventHandling";
import { systemPromptHandling } from "./systemPromptHandling";

export const CHAT_VIEW_TYPE = "systemsculpt-chat-view";

export class ChatView extends ItemView {
  public messages: ChatMessage[] = [];
  public aiService: SystemSculptService;
  public chatStorage: ChatStorageService;
  public chatContainer: HTMLElement;
  public inputHandler: InputHandler;
  public plugin: SystemSculptPlugin;
  public chatId: string;
  public toolCallManager: ToolCallManager;
  public selectedModelId: string;
  public modelIndicator: HTMLElement;
  public systemPromptIndicator: HTMLElement;
  public currentModelName: string = "";
  public currentModelSupportsWebSearch: boolean | null = null;
  public currentModelSupportedParameters: string[] = [];
  public isGenerating = false;
  public contextManager: FileContextManager;
  public scrollManager: ScrollManagerService;
  public layoutChangeHandler: () => void;
  public isFullyLoaded = false; // Track when chat is fully loaded
  public messageRenderer: MessageRenderer;
  public systemPromptType: "general-use" | "concise" | "agent" | "custom";
  public systemPromptPath?: string;
  public chatTitle: string;
  public chatVersion: number = 0;
  public currentPrompt?: string;
  public webSearchEnabled: boolean = false;
  public agentMode: boolean = true;
  /** Tools trusted for this chat session (cleared on chat reload/close) */
  public trustedToolNames: Set<string> = new Set();
  private dragDropCleanup: (() => void) | null = null;
  public chatFontSize: "small" | "medium" | "large";
  private systemPromptService: SystemPromptService;
  private settings: SystemSculptSettings;
  private chatExportService: ChatExportService | null = null;
  private debugLogService: ChatDebugLogService | null = null;
  /**
   * Virtualized chat rendering state
   * --------------------------------
   * To prevent the DOM from bloating when a chat grows very long we only keep
   * a window of the most recent messages in the document.  Older messages can
   * be incrementally loaded via a _Load earlier messages_ placeholder that
   * sits at the top of the list.
   */
  private virtualStartIndex: number = 0;          // Index of the first message currently rendered
  private readonly VIRTUAL_BATCH_SIZE: number = 40; // How many messages to load at a time
  private hasAdjustedInitialWindow: boolean = false;

  // Explicitly re-declare core ItemView fields for clarity / type checking
  declare app: App;
  declare leaf: WorkspaceLeaf;
  declare register: Component["register"];
  declare registerDomEvent: Component["registerDomEvent"];

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.settings = plugin.settings;
    this.app = plugin.app;
    
    // Use singleton instance instead of creating new one
    this.aiService = SystemSculptService.getInstance(plugin);

    // Get the initial state from the leaf if it exists
    const state = this.leaf.getViewState();
    const initialState = (state?.state as {
        chatId?: string;
        chatTitle?: string;
        selectedModelId?: string;
        systemPromptType?: "general-use" | "concise" | "agent" | "custom";
        systemPromptPath?: string;
        version?: number;
        chatFontSize?: "small" | "medium" | "large";
        agentMode?: boolean;
    }) || {};

    this.messages = [];
    this.chatId = initialState.chatId || "";

    // Initialize the chat title
    this.initializeChatTitle(initialState.chatTitle);

    this.selectedModelId = initialState.selectedModelId || plugin.settings.selectedModelId;
    this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
    this.isGenerating = false;
    this.isFullyLoaded = false; // Start as not loaded

    this.systemPromptPath = initialState.systemPromptPath;
    // Use -1 as uninitialized state to distinguish from actual version 0
    this.chatVersion = initialState.version !== undefined ? initialState.version : -1;

    this.ensureCoreServicesReady();

    // Initialize chat font size from saved state or plugin settings
    this.chatFontSize = initialState.chatFontSize || (plugin.settings as any).chatFontSize || "medium";

    this.systemPromptType = initialState.systemPromptType
        || plugin.settings.systemPromptType
        || "general-use";

    if (this.systemPromptType === "custom" && !this.systemPromptPath) {
      this.systemPromptPath = plugin.settings.systemPromptPath;
    }

    // Initialize agentMode from state or default to true
    this.agentMode = initialState.agentMode !== undefined ? initialState.agentMode : true;

    this.layoutChangeHandler = this.onLayoutChange.bind(this);
  }

  private ensureCoreServicesReady(): void {
    if (!this.aiService) {
      this.aiService = SystemSculptService.getInstance(this.plugin);
    }

    if (!this.toolCallManager) {
      this.toolCallManager = new ToolCallManager(new MCPService(this.plugin, this.app), this);
    }

    if (!this.chatStorage) {
      this.chatStorage = new ChatStorageService(this.app, this.plugin.settings.chatsDirectory);
    }

    if (!this.messageRenderer) {
      this.messageRenderer = new MessageRenderer(this.app, this.toolCallManager);
    }

    if (!this.systemPromptService) {
      this.systemPromptService = SystemPromptService.getInstance(this.app, () => this.plugin.settings);
    }

    if (!this.debugLogService) {
      this.debugLogService = new ChatDebugLogService(this.plugin, this);
    }
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.chatTitle || "Loading...";
  }

  // Delegated methods
  async onOpen(): Promise<void> {
    this.ensureCoreServicesReady();
    await uiSetup.onOpen(this);
    await this.refreshModelMetadata();
  }
  updateModelIndicator = () => uiSetup.updateModelIndicator(this);
  updateSystemPromptIndicator = () => uiSetup.updateSystemPromptIndicator(this);
  addMessage = (role: ChatRole, content: string | MultiPartContent[] | null, existingMessageId?: string, completeMessage?: ChatMessage) =>
    messageHandling.addMessage(this, role, content, existingMessageId, completeMessage);
  loadMessages = () => messageHandling.loadMessages(this);
  setupDragAndDrop = (container: HTMLElement): void => {
    const cleanup = eventHandling.setupDragAndDrop(this, container);
    if (typeof cleanup === 'function') {
      this.dragDropCleanup = cleanup;
    }
  };
  handleSystemPromptEdit = () => systemPromptHandling.handleSystemPromptEdit(this);


  public async saveChat(): Promise<void> {
    this.ensureCoreServicesReady();
    // Guard: if we are still loading an existing chat (messages not yet
    // hydrated) suppress any automatic save that could wipe history.
    if (!this.isFullyLoaded && this.chatId) {
      return;
    }
    
    // Check if we have actual content to save
    const hasMessages = this.messages.length > 0;
    const hasContextFiles = this.contextManager?.getContextFiles().size > 0;
    const hasContent = hasMessages || hasContextFiles;
    
    // If this is a new chat with no content, only update view state
    if (!this.chatId && !hasContent) {
      // Update view state to persist settings in workspace
      this.updateViewState();
      return;
    }
    
    if (!this.chatId) {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const hour = String(now.getHours()).padStart(2, "0");
      const minute = String(now.getMinutes()).padStart(2, "0");
      const second = String(now.getSeconds()).padStart(2, "0");
      this.chatId = `${year}-${month}-${day} ${hour}-${minute}-${second}`;

      if (!this.chatTitle) {
        this.initializeChatTitle();
      }
      this.updateViewState();
    }

    try {
      const savedChat = await this.chatStorage.saveChat(
        this.chatId,
        this.messages,
        this.selectedModelId,
        this.contextManager?.getContextFiles() || new Set(),
        undefined,
        this.systemPromptType,
        this.systemPromptPath,
        this.chatTitle,
        this.chatFontSize,
        this.agentMode
      );
      this.chatVersion = savedChat.version || this.chatVersion;

      // If this was the first successful save of a brand-new chat, mark it as fully loaded so
      // subsequent saveChat() calls are no longer skipped by the early-exit guard.
      const wasNewChat = !this.isFullyLoaded;
      if (wasNewChat && !this.isFullyLoaded) {
        this.isFullyLoaded = true;
      }

      this.updateViewState();
    } catch (error) {
      this.handleError("Failed to save chat");
    }
  }

  public async addMessageToHistory(message: ChatMessage): Promise<void> {
    // Check for duplicates using message_id
    if (!this.messages.find(m => m.message_id === message.message_id)) {
        this.messages.push(message);
        // Trigger event for embeddings view to refresh
        (this.app.workspace as any).trigger('systemsculpt:chat-message-added', this.chatId);
    }
    await this.saveChat();
  }

  public async handleError(error: string | SystemSculptError): Promise<void> {
    let errorMessage = typeof error === "string" ? error : error.message;
    
    // Log the error with full details
    const errorContext = {
      source: 'ChatView',
      method: 'handleError',
      modelId: this.selectedModelId,
      metadata: {
        chatId: this.chatId,
        messageCount: this.messages.length,
        isGenerating: this.isGenerating,
      }
    };
    
    if (error instanceof SystemSculptError) {
      errorLogger.error(errorMessage, error, { ...errorContext, metadata: { ...errorContext.metadata, ...error.metadata } });
    } else {
      errorLogger.error(errorMessage, undefined, errorContext);
    }
    
    if (
      error instanceof SystemSculptError &&
      (error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_REQUEST_ERROR" || error.code === "QUOTA_EXCEEDED")
    ) {
      // Handle model unavailability by automatically switching models
      if (error.code === "MODEL_UNAVAILABLE") {
        try {
          // Determine the ID of the model that failed. Prefer the metadata sent
          // from the service layer, otherwise fall back to the chat's current
          // model selection.
          const unavailableModelId: string = error.metadata?.model || this.selectedModelId;

          if (!this.hasConfiguredProvider()) {
            await this.promptProviderSetup(
              "Connect SystemSculpt AI or add your own provider in Settings → Overview & Setup before starting a chat."
            );
            await this.resetFailedAssistantTurn();
            return;
          }

          // Always look for an alternative when we get a MODEL_UNAVAILABLE error –
          // even if the model still appears in the cached list. This avoids the
          // situation where the provider lists a model (e.g. gpt-4o) but denies
          // access when we try to use it.
          const models = await this.plugin.modelService.getModels();

          if (!models || models.length === 0) {
            await this.promptProviderSetup(
              "No AI providers are ready yet. Connect a provider or activate your license to continue."
            );
            await this.resetFailedAssistantTurn();
            return;
          }
          const alternativeModel = this.plugin.modelService.findBestAlternativeModel(unavailableModelId, models);

          if (alternativeModel) {
            const oldModelId = this.selectedModelId;

            // Switch to the alternative model using the standard setter for proper sync
            await this.setSelectedModelId(alternativeModel.id);

            // Notify the user and offer a chance to pick a different model
            new Notice(`Model "${oldModelId}" is unavailable. Switched to "${alternativeModel.name}"`, 10000);

            setTimeout(async () => {
              await showPopup(
                this.app,
                `The model "${oldModelId}" you were using is unavailable. This can happen when models are updated or removed by providers. I've automatically switched you to "${alternativeModel.name}" so you can continue chatting. Click below if you'd like to choose a different model.`,
                {
                  title: "Model Automatically Changed",
                  icon: "alert-triangle",
                  primaryButton: "Choose Different Model",
                  secondaryButton: "Continue With New Model"
                }
              ).then(result => {
                if (result?.confirmed) {
                  this.modelIndicator?.click();
                }
              });
            }, 500);
            await this.resetFailedAssistantTurn();
            return;
          }
        } catch (altError) {
        }
      }

      // Fall back to manual model selection if automatic switching failed
      // Error already logged and Notice shown by errorLogger
      const modal = new StandardModelSelectionModal({
        app: this.app,
        plugin: this.plugin,
        currentModelId: this.selectedModelId,
        onSelect: async (result) => {
          await this.setSelectedModelId(result.modelId);
        }
      });
      modal.open();
      await this.resetFailedAssistantTurn();
    } else {
      // Handle other types of errors
      // Error already logged and Notice shown by errorLogger
    }
  }

  public hasConfiguredProvider(): boolean {
    const settings = this.plugin.settings;
    const hasSystemSculpt = !!(settings.enableSystemSculptProvider && settings.licenseKey?.trim() && settings.licenseValid === true);
    const hasCustomProvider = Array.isArray(settings.customProviders) && settings.customProviders.some((provider) => provider?.isEnabled);
    return hasSystemSculpt || hasCustomProvider;
  }

  public openSetupTab(targetTab: string = "overview"): void {
    try {
      // @ts-ignore – Obsidian typings omit the settings API
      this.app.setting.open();
      // @ts-ignore
      this.app.setting.openTabById(this.plugin.manifest.id);
      window.setTimeout(() => {
        this.app.workspace.trigger("systemsculpt:settings-focus-tab", targetTab);
      }, 100);
    } catch (error) {
      new Notice("Open Settings → SystemSculpt AI to configure providers.", 6000);
    }
  }

  public async promptProviderSetup(customMessage?: string): Promise<void> {
    const message = customMessage ??
      "Connect SystemSculpt AI or bring your own API provider to start chatting.";
    const result = await showPopup(this.app, message, {
      title: "Connect An AI Provider",
      icon: "plug-zap",
      primaryButton: "Open Setup",
      secondaryButton: "Not Now",
    });
    if (result?.confirmed) {
      this.openSetupTab();
    }
  }

  private removeLastAssistantMessageFromDom(): void {
    if (!this.chatContainer) {
      return;
    }
    const lastGroup = this.chatContainer.querySelector(':scope > .systemsculpt-message-group:last-of-type') as HTMLElement | null;
    const lastMessage = lastGroup?.querySelector('.systemsculpt-message:last-of-type') as HTMLElement | null;
    if (lastMessage) {
      const parentGroup = lastMessage.parentElement as HTMLElement | null;
      lastMessage.remove();
      if (parentGroup) {
        removeGroupIfEmpty(parentGroup);
      }
    }
  }

  private async restoreLastUserMessageToComposer(): Promise<void> {
    if (!this.inputHandler) {
      return;
    }
    const lastUserMessage = [...this.messages].reverse().find((msg) => msg.role === "user");
    if (!lastUserMessage) {
      return;
    }
    try {
      const { trimOuterBlankLines } = await import('../../utils/textUtils');
      const asString = typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : JSON.stringify(lastUserMessage.content ?? '');
      const normalized = trimOuterBlankLines(asString);
      this.inputHandler.setInputText(normalized);
    } catch {
      this.inputHandler.setInputText(lastUserMessage.content || '');
    }
  }

  private async resetFailedAssistantTurn(): Promise<void> {
    this.removeLastAssistantMessageFromDom();
    await this.restoreLastUserMessageToComposer();
  }

  private async onLayoutChange() {
    if (this.app.workspace.getActiveViewOfType(ItemView)?.leaf === this.leaf) {
      if (this.inputHandler) this.inputHandler.focus();
    }
  }

  public generateMessageId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }


  public async getCurrentSystemPrompt(): Promise<string> {
    this.ensureCoreServicesReady();
    try {
      return await this.systemPromptService.getSystemPromptContent(
        this.systemPromptType,
        this.systemPromptPath
      );
    } catch (error) {
      // Fall back to the general-use preset
      return GENERAL_USE_PRESET.systemPrompt;
    }
  }

  /**
   * Display the current chat settings status for new/empty chats
   */
  public displayChatStatus(): void {
    if (!this.chatContainer) return;
    
    // Reuse existing container to avoid flicker/animation on refresh
    let statusContainer = this.chatContainer.querySelector('.systemsculpt-chat-status') as HTMLElement | null;
    const isRefresh = !!statusContainer;
    if (statusContainer) {
      statusContainer.empty();
      statusContainer.addClass('no-animate');
    } else {
      // Create status container (first render can animate)
      statusContainer = this.chatContainer.createEl("div", {
        cls: "systemsculpt-chat-status"
      });
    }

    // Header
    statusContainer.createEl("h3", {
      text: "Chat Settings",
      cls: "systemsculpt-status-header"
    });

    const needsProviderSetup = !this.hasConfiguredProvider();
    if (needsProviderSetup) {
      const alert = statusContainer.createDiv({ cls: "systemsculpt-status-alert" });
      const iconWrapper = alert.createSpan({ cls: "ss-status-alert-icon" });
      setIcon(iconWrapper, "plug-zap");
      const content = alert.createDiv({ cls: "ss-status-alert-content" });
      content.createDiv({ cls: "ss-status-alert-title", text: "Connect an AI provider to start chatting" });
      content.createDiv({
        cls: "ss-status-alert-description",
        text: "Activate your SystemSculpt license or add a custom provider in Settings → Overview & Setup."
      });
      const actions = content.createDiv({ cls: "ss-status-alert-actions" });
      const button = actions.createEl("button", {
        cls: "mod-cta systemsculpt-status-alert-button",
        text: "Open Setup"
      });
      button.setAttr('type', 'button');
      this.registerDomEvent(button, "click", () => this.openSetupTab());
    }

    // Pills row
    const pills = statusContainer.createEl("div", { cls: "systemsculpt-status-pills" });

    // Helper to create a pill button
    const createPill = (options: {
      icon: string;
      label: string;
      value: string;
      isOn?: boolean;
      isDisabled?: boolean;
      title?: string;
      onClick?: () => void | Promise<void>;
    }): HTMLElement => {
      const btn = pills.createEl('button', { cls: 'systemsculpt-status-pill' });
      const iconSpan = btn.createSpan({ cls: 'ss-pill-icon' });
      setIcon(iconSpan, options.icon);
      btn.createSpan({ cls: 'ss-pill-label', text: options.label });
      btn.createSpan({ cls: 'ss-pill-sep', text: '·' });
      btn.createSpan({ cls: 'ss-pill-value', text: options.value });
      if (options.isOn !== undefined) {
        btn.addClass(options.isOn ? 'is-on' : 'is-off');
      }
      if (options.isDisabled) {
        btn.addClass('is-disabled');
        btn.setAttr('aria-disabled', 'true');
      } else {
        btn.setAttr('aria-disabled', 'false');
      }
      if (options.title) btn.setAttr('title', options.title);
      if (!options.isDisabled && options.onClick) {
        this.registerDomEvent(btn, 'click', async () => {
          await options.onClick?.();
          // Note: Each handler manages its own UI updates via notifySettingsChanged()
        });
      }
      return btn;
    };

    // Model
    const modelLabel = needsProviderSetup
      ? 'Connect provider'
      : this.currentModelName || this.selectedModelId || 'Select…';
    createPill({
      icon: 'bot',
      label: 'Model',
      value: modelLabel,
      title: needsProviderSetup ? 'Connect a provider to pick a model' : (modelLabel ? `Current model: ${modelLabel}` : 'Choose a model'),
      onClick: () => {
        if (needsProviderSetup) {
          this.openSetupTab();
          return;
        }
        const modal = new StandardModelSelectionModal({
          app: this.app,
          plugin: this.plugin,
          currentModelId: this.selectedModelId || '',
          onSelect: async (result) => {
            await this.setSelectedModelId(result.modelId);
            new Notice('Model updated for this chat.', 3000);
          }
        });
        modal.open();
      }
    });

    // System Prompt
    let promptLabel = '';
    switch (this.systemPromptType) {
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
        if (this.systemPromptPath) {
          const filename = this.systemPromptPath.split('/').pop() || 'Custom';
          const baseName = filename.replace('.md', '');
          promptLabel = baseName;
        } else {
          promptLabel = "Custom";
        }
        break;
      default:
        promptLabel = "General Use";
        break;
    }
    createPill({
      icon: this.systemPromptType === 'agent' ? 'folder-open' : 'sparkles',
      label: 'Prompt',
      value: promptLabel,
      title: `Current system prompt: ${promptLabel}`,
      onClick: async () => {
        const { StandardSystemPromptSelectionModal } = await import('../../modals/StandardSystemPromptSelectionModal');
        const modal = new StandardSystemPromptSelectionModal({
          app: this.app,
          plugin: this.plugin,
          currentType: this.systemPromptType || 'general-use',
          currentPath: this.systemPromptPath,
          onSelect: async (result) => {
            this.systemPromptType = result.type;
            this.systemPromptPath = result.type === 'custom' ? result.path : undefined;
            this.currentPrompt = result.prompt;
            try {
              const useLatestPrompt = this.plugin.settings.useLatestSystemPromptForNewChats ?? true;
              const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
              if (useLatestPrompt || isStandardMode) {
                await this.plugin.getSettingsManager().updateSettings({
                  systemPromptType: result.type,
                  systemPromptPath: result.type === 'custom' ? (result.path || '') : ''
                });
                this.plugin.emitter?.emit?.('systemPromptSettingsChanged');
              }
            } catch {}
            await this.saveChat();
            await this.updateSystemPromptIndicator();
            new Notice('System prompt updated for this chat.', 3000);
            // Keep status synced
            this.notifySettingsChanged();
          }
        });
        modal.open();
      }
    });

    // Web Search
    const webSearchAllowed = this.supportsWebSearch();
    const webSearchEnabled = !!this.inputHandler?.webSearchEnabled;
    createPill({
      icon: 'globe',
      label: 'Search',
      value: webSearchEnabled ? 'On' : 'Off',
      isOn: webSearchEnabled,
      isDisabled: !webSearchAllowed,
      title: webSearchAllowed ? 'Toggle web search' : 'Web search not supported for the selected model',
      onClick: () => {
        if (!this.inputHandler) return;
        this.inputHandler.toggleWebSearchEnabled();
        // Keep status synced
        this.notifySettingsChanged();
      }
    });

    // Font Size
    const fontLabel = this.chatFontSize.charAt(0).toUpperCase() + this.chatFontSize.slice(1);
    createPill({
      icon: 'type',
      label: 'Font',
      value: fontLabel,
      title: 'Click to cycle font size',
      onClick: async () => {
        const order: Array<'small' | 'medium' | 'large'> = ['small', 'medium', 'large'];
        const idx = order.indexOf(this.chatFontSize);
        const next = order[(idx + 1) % order.length];
        await this.setChatFontSize(next);
      }
    });

    // Tip
    statusContainer.createEl("p", {
      text: "Click any setting above to change it.",
      cls: "systemsculpt-status-tip"
    });

    // Remove no-animate after refresh so future first-time displays can animate again
    try { statusContainer.removeClass('no-animate'); } catch {}
  }

  public supportsWebSearch(): boolean {
    if (this.currentModelSupportsWebSearch !== null) {
      if (this.currentModelSupportsWebSearch) {
        return true;
      }
      if (Array.isArray(this.currentModelSupportedParameters) && this.currentModelSupportedParameters.length > 0) {
        if (this.currentModelSupportedParameters.includes('web_search_options') || this.currentModelSupportedParameters.includes('plugins')) {
          return true;
        }
        return false;
      }
    }

    const activeProvider = this.plugin.settings.activeProvider ?? { type: 'native', id: 'systemsculpt' };
    const isNativeProvider = activeProvider.type === 'native';
    const currentProvider = this.plugin.settings.customProviders?.find((p) => p.id === activeProvider.id);
    const isOpenRouter = !!currentProvider?.endpoint?.includes('openrouter.ai');
    return isNativeProvider || isOpenRouter;
  }

  private async refreshModelMetadata(): Promise<void> {
    const canonicalId = this.selectedModelId ? ensureCanonicalId(this.selectedModelId) : '';
    const previouslySupported = this.supportsWebSearch();

    let modelSupportsWebSearch: boolean | null = null;
    let supportedParameters: string[] = [];

    if (canonicalId) {
      try {
        const model = await this.plugin.modelService.getModelById(canonicalId);
        if (model) {
          if (Array.isArray(model.capabilities)) {
            modelSupportsWebSearch = model.capabilities.length > 0 ? model.capabilities.includes('web_search') : null;
          } else {
            modelSupportsWebSearch = null;
          }
          supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
        } else {
          modelSupportsWebSearch = null;
          supportedParameters = [];
        }
      } catch (error) {
        modelSupportsWebSearch = null;
        supportedParameters = [];
      }
    } else {
      modelSupportsWebSearch = false;
      supportedParameters = [];
    }

    this.currentModelSupportsWebSearch = modelSupportsWebSearch;
    this.currentModelSupportedParameters = supportedParameters;

    const supportsNow = this.supportsWebSearch();

    if (!supportsNow && this.inputHandler?.webSearchEnabled) {
      this.inputHandler.disableWebSearch();
      this.webSearchEnabled = false;
      try {
        new Notice('Web search disabled: selected model does not support it.', 2500);
      } catch {}
    } else {
      this.inputHandler?.refreshWebSearchControls();
    }
    this.inputHandler?.refreshTokenCounter();

    if (this.messages.length === 0 || previouslySupported !== supportsNow) {
      this.displayChatStatus();
    }
  }

  /**
   * Re-render the chat status block when the chat is empty so UI stays in sync
   */
  private refreshChatStatusIfEmpty(): void {
    if (!this.chatContainer) return;
    if (this.messages.length === 0) {
      this.displayChatStatus();
    }
  }

  /**
   * Notify the system that chat-level settings have changed. Centralizes
   * status updates and broadcasts a workspace event for any listeners.
   */
  public notifySettingsChanged(): void {
    try {
      (this.app.workspace as any).trigger('systemsculpt:chat-settings-changed', this.chatId);
    } catch {}
    this.refreshChatStatusIfEmpty();
  }

  private getInputValue(): string {
    return this.inputHandler?.getValue() ?? "";
  }

  onunload() {
    this.scrollManager.cleanup();
    this.app.workspace.off("active-leaf-change", this.onLayoutChange);

    // Cleanup interface observer
    // Observer cleanup removed since we're no longer using MutationObserver

    if (this.dragDropCleanup) {
      this.dragDropCleanup();
      this.dragDropCleanup = null;
    }

    this.contextManager.destroy();
    this.inputHandler.unload();
  }

  getState(): any {
    return {
      chatId: this.chatId,
      selectedModelId: this.selectedModelId,
      chatTitle: this.chatTitle,
      systemPromptType: this.systemPromptType,
      systemPromptPath: this.systemPromptPath,
      version: this.chatVersion,
      chatFontSize: this.chatFontSize,
      agentMode: this.agentMode,
    };
  }

  async setState(state: any): Promise<void> {
    // Skip redundant identical state
    try {
      const currentState = this.getState();
      if (JSON.stringify(state) === JSON.stringify(currentState)) {
        return;
      }
    } catch (e) {
    }

    const previousChatId = this.chatId;

    if (!state?.chatId) {
      this.chatId = "";
      this.initializeChatTitle();
      // Ensure the selectedModelId for a new chat defaults to the plugin's setting
      this.agentMode = state?.agentMode !== undefined ? state.agentMode : true;
      this.selectedModelId = this.plugin.settings.selectedModelId || "";
      this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
      // Respect policy for default system prompt when starting new chats
      const useLatestPrompt = this.plugin.settings.useLatestSystemPromptForNewChats ?? true;
      const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
      if (useLatestPrompt || isStandardMode) {
        this.systemPromptType = this.plugin.settings.systemPromptType || 'general-use';
        this.systemPromptPath = this.systemPromptType === 'custom' ? this.plugin.settings.systemPromptPath : undefined;
      } else {
        // fall back to general-use if policy disabled and nothing passed in
        this.systemPromptType = 'general-use';
        this.systemPromptPath = undefined;
      }
 
      // Restore chat font size for new chats if provided in state
      if (state?.chatFontSize) {
        this.chatFontSize = state.chatFontSize;
        // Apply visually without saving
        setTimeout(() => {
          if (this.chatContainer) {
            this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
            this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
          }
        }, 0);
      }
      this.virtualStartIndex = 0;
      this.messages = [];
      this.contextManager?.clearContext();
      this.updateModelIndicator();
      this.updateSystemPromptIndicator();
      // Don't render messages here - let onOpen handle it after UI is ready
      // this.renderMessagesInChunks();
      this.isFullyLoaded = true; // New chat is immediately loaded
      // Notify listeners that a chat has been loaded (new empty chat)
      this.app.workspace.trigger("systemsculpt:chat-loaded", this.chatId);
      if (previousChatId !== this.chatId) {
        this.debugLogService?.resetStreamBuffer();
      }
      return;
    }

    if (this.chatId === state.chatId && this.isFullyLoaded) {
      return;
    }

    // Only proceed with loading if we have a non-empty chatId
    if (!state.chatId || state.chatId === "") {
      // For empty/new chats, just update the state but don't load
      this.chatId = "";
      this.selectedModelId = state.selectedModelId || this.plugin.settings.selectedModelId || "";
      this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
      this.initializeChatTitle(state.chatTitle);
      this.chatVersion = state.version !== undefined ? state.version : -1;
      this.systemPromptType = state.systemPromptType || 'general-use';
      this.systemPromptPath = this.systemPromptType === 'custom' ? state.systemPromptPath : undefined;

      this.agentMode = state.agentMode !== undefined ? state.agentMode : true;

      if (state.chatFontSize) {
        this.chatFontSize = state.chatFontSize;
        setTimeout(() => {
          if (this.chatContainer) {
            this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
            this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
          }
        }, 0);
      }

      this.isFullyLoaded = true;
      if (previousChatId !== this.chatId) {
        this.debugLogService?.resetStreamBuffer();
      }
      return;
    }
    
    this.chatId = state.chatId;
    if (previousChatId !== this.chatId) {
      this.debugLogService?.resetStreamBuffer();
    }
    // When loading an existing chat, use the stored model selection as-is
    this.selectedModelId = state.selectedModelId || this.plugin.settings.selectedModelId || "";
    this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
    this.initializeChatTitle(state.chatTitle);
    this.chatVersion = state.version !== undefined ? state.version : -1;

    // Simplified system prompt handling - use 'general-use' as default
    this.systemPromptType = state.systemPromptType || 'general-use';
    // Only set path for custom prompts
    this.systemPromptPath = this.systemPromptType === 'custom' ? state.systemPromptPath : undefined;

    this.agentMode = state.agentMode !== undefined ? state.agentMode : true;
    // Restore chat font size
    if (state.chatFontSize) {
      this.chatFontSize = state.chatFontSize;
      // Apply visually without saving
      setTimeout(() => {
        if (this.chatContainer) {
          this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
          this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
        }
      }, 0);
    }
    try {
      await this.loadChatById(state.chatId);
      if (this.app.workspace.getActiveViewOfType(ItemView)?.leaf === this.leaf && this.inputHandler) {
        this.inputHandler.focus();
      }
    } catch (error) {
      this.handleError(`Failed to load chat ${state.chatId}`);
      this.chatId = "";
      this.initializeChatTitle();
      this.virtualStartIndex = 0;
      this.messages = [];
      this.contextManager?.clearContext();
      this.systemPromptType = 'general-use';
      this.systemPromptPath = undefined;
      // Don't render here if UI not ready yet
      if (this.chatContainer) {
        this.renderMessagesInChunks();
      }
      this.isFullyLoaded = true; // Even failed loads are "loaded"
    }
  }

  async loadChatById(chatId: string): Promise<void> {
    this.ensureCoreServicesReady();
    this.chatId = chatId;
    this.isFullyLoaded = false; // Mark as not loaded while loading
    this.trustedToolNames.clear(); // Clear session trust on chat load

    try {
      
      const chatData = await this.chatStorage.loadChat(chatId);
      if (!chatData) {
        this.messages = [];
        this.chatContainer.empty();
        this.setTitle("Chat not found");
        this.systemPromptType = 'general-use';
        this.systemPromptPath = undefined;
        this.updateModelIndicator();
        this.updateSystemPromptIndicator();
        this.contextManager?.clearContext();
        this.isFullyLoaded = true; // Mark as loaded even when chat not found
        return;
      }

      // Restore all chat properties
      this.selectedModelId = chatData.selectedModelId || this.plugin.settings.selectedModelId;
      this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
      this.setTitle(chatData.title || generateDefaultChatTitle(), false);
      this.messages = chatData.messages || [];
      this.chatVersion = chatData.version || 0;
      
      // Simplified system prompt handling
      this.systemPromptType = chatData.systemPromptType || 'general-use';
      this.systemPromptPath = this.systemPromptType === 'custom' ? chatData.systemPromptPath : undefined;

      // Load agentMode from chat data, default to true for backward compatibility
      this.agentMode = chatData.agentMode !== undefined ? chatData.agentMode : true;

      // Load chat font size from chat data
      this.chatFontSize = chatData.chatFontSize || this.plugin.settings.chatFontSize || "medium";
      // Apply it after UI is ready (don't save again, just apply visually)
      setTimeout(() => {
        if (this.chatContainer) {
          this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
          this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
        }
      }, 100);
      
      // Handle context files if any
      if (chatData.context_files && this.contextManager) {
        const contextFiles = chatData.context_files.filter(Boolean);
        if (contextFiles.length > 0) {
          await this.contextManager.setContextFiles(contextFiles);
        } else {
          await this.contextManager.clearContext();
        }
      } else if (this.contextManager) {
        await this.contextManager.clearContext();
      }

      // Clear chat container and render messages
      this.chatContainer.empty();
      if (this.messages.length > 0) {
        await this.renderMessagesInChunks();
      }

      this.isFullyLoaded = true; // Mark as loaded after messages are rendered
      
      // Update UI indicators
      await this.updateModelIndicator();
      await this.updateSystemPromptIndicator();
      
      if (this.inputHandler) {
        this.inputHandler.onModelChange();
      }
      
      // Validate context files
      await this.contextManager.validateAndCleanContextFiles();

      // Update the tab title
      this.updateViewState();
      
      // Notify listeners that a chat has been loaded
      this.app.workspace.trigger("systemsculpt:chat-loaded", this.chatId);

    } catch (error) {
      this.handleError(`Failed to load chat: ${error.message}`);
      this.isFullyLoaded = true; // Mark as loaded even on error to prevent stuck state
    }
  }

  /**
   * Trust a specific tool for the remainder of this chat session.
   * Also auto-approves any pending tool calls with the same name.
   */
  public trustToolForSession(toolName: string): void {
    this.trustedToolNames.add(toolName);
    // Auto-approve any pending tool calls with this name
    if (this.toolCallManager) {
      const pendingCalls = this.toolCallManager.getPendingToolCalls();
      for (const tc of pendingCalls) {
        const tcToolName = tc.request?.function?.name;
        if (tcToolName === toolName) {
          this.toolCallManager.approveToolCall(tc.id);
        }
      }
    }
  }

  /**
   * Approve all pending tool calls at once.
   */
  public approveAllPendingToolCalls(): void {
    if (!this.toolCallManager) return;
    const pendingCalls = this.toolCallManager.getPendingToolCalls();
    for (const tc of pendingCalls) {
      this.toolCallManager.approveToolCall(tc.id);
    }
  }

  public async renderMessagesInChunks(): Promise<void> {
    if (!this.chatContainer) return;

    const renderStart = performance.now();

    // Determine the slice of history we want to render.  If this is the first
    // render of the view (virtualStartIndex === 0) we default to showing only
    // the most recent VIRTUAL_BATCH_SIZE messages.
    const total = this.messages.length;
    if (total === 0) {
      this.chatContainer.empty();
      // Display status message for empty chat
      this.displayChatStatus();
      return;
    }

    // Clamp virtualStartIndex to be within bounds – this takes care of cases
    // where messages might have been deleted.
    if (this.virtualStartIndex < 0) this.virtualStartIndex = 0;
    if (this.virtualStartIndex >= total) this.virtualStartIndex = Math.max(0, total - this.VIRTUAL_BATCH_SIZE);

    // Adjust the virtual window only once (on the very first render). After
    // that we trust whatever value is present – e.g. when the user has just
    // clicked "Load earlier messages" we *want* to keep the updated index.
    if (!this.hasAdjustedInitialWindow) {
      if (this.virtualStartIndex === 0 && total > this.VIRTUAL_BATCH_SIZE) {
        this.virtualStartIndex = total - this.VIRTUAL_BATCH_SIZE;
      }
      this.hasAdjustedInitialWindow = true;
    }

    // Clear any existing elements before we repopulate the container.
    this.chatContainer.empty();

    // If we are not rendering from the very first message, insert a
    // _Load earlier messages_ placeholder at the top so the user can fetch
    // older history on-demand.
    if (this.virtualStartIndex > 0) {
      const placeholder = this.createLoadMoreButton();
      this.chatContainer.appendChild(placeholder);
    }

    // Render the slice [virtualStartIndex, total) using a DocumentFragment to reduce reflow
    const frag = document.createDocumentFragment();
    for (let i = this.virtualStartIndex; i < total; i++) {
      const msg = this.messages[i];
      await messageHandling.addMessage(this, msg.role, msg.content, msg.message_id, msg, frag);
    }
    this.chatContainer.appendChild(frag);
    // After batch append, enforce DOM window size once
    this.manageDomSize();

    // Only auto-scroll when the user was already at the bottom (auto-scroll
    // mode).  When they are reviewing earlier history we leave the scroll
    // position untouched.
    if (this.scrollManager?.isAutoScrollEnabled()) {
      setTimeout(() => {
        this.scrollManager?.forceScrollToBottom();
      }, 0);
    }

    const duration = performance.now() - renderStart;
    const renderedCount = total - this.virtualStartIndex;
  }

  /**
   * Creates a clickable element which, when activated, loads the next batch
   * of historical messages above the fold.
   */
  private createLoadMoreButton(): HTMLElement {
    // Use a semantic <button> so we get native accessibility/keyboard behaviour
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'systemsculpt-load-more';

    const remaining = this.virtualStartIndex; // How many messages precede the current window
    btn.textContent = `Load earlier messages (${remaining})`;

    // Make sure it is keyboard-focusable
    btn.tabIndex = 0;

    const load = async () => {
      await this.loadMoreMessages();
    };

    btn.addEventListener('click', load);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        load();
      }
    });

    // Clean up listeners when the view unloads
    this.register(() => {
      btn.removeEventListener('click', load);
    });

    return btn;
  }

  /**
   * Loads an additional batch of older messages and prepends them to the chat
   * container.  We simply re-invoke renderMessagesInChunks() with an updated
   * virtualStartIndex so that we reuse the existing message rendering logic.
   */
  private async loadMoreMessages(): Promise<void> {
    if (!this.chatContainer || this.virtualStartIndex === 0) return; // Nothing more to load

    // Find the placeholder element to update its state
    const placeholder = this.chatContainer.querySelector('.systemsculpt-load-more') as HTMLElement | null;

    const setLoadingState = (isLoading: boolean) => {
      if (!placeholder) return;
      if (isLoading) {
        placeholder.dataset.loading = 'true';
        placeholder.textContent = 'Loading...';
        placeholder.setAttribute('aria-busy', 'true');
        placeholder.setAttribute('aria-disabled', 'true');
      } else {
        placeholder.dataset.loading = 'false';
        placeholder.removeAttribute('aria-busy');
        placeholder.removeAttribute('aria-disabled');
        if (this.virtualStartIndex > 0) {
          placeholder.textContent = `Load earlier messages (${this.virtualStartIndex})`;
        } else {
          // No more messages to load – remove the button
          placeholder.remove();
        }
      }
    };

    try {
      setLoadingState(true);

      // Capture current scroll position so we can restore/adjust after re-render.
      const { scrollTop, scrollHeight } = this.chatContainer;
      // Treat anything within the first 50 px as "user is reading the first visible message".
      // This avoids the situation where a very small offset (often introduced by
      // margins or fractional scrolling) tricks the algorithm into preserving a
      // relative offset that hides the newly-loaded oldest message.
      const wasAtTop = scrollTop <= 50;

      // Decrease start index by batch size.
      this.virtualStartIndex = Math.max(0, this.virtualStartIndex - this.VIRTUAL_BATCH_SIZE);

      await this.renderMessagesInChunks();

      const newScrollHeight = this.chatContainer.scrollHeight;

      if (wasAtTop) {
        // The user was looking at the very first visible message. After
        // loading more we want them to remain at the top so the newly fetched
        // messages are immediately visible.
        this.chatContainer.scrollTop = 0;
      } else {
        // Maintain relative position (user was mid-history)
        this.chatContainer.scrollTop = newScrollHeight - scrollHeight + scrollTop;
      }
    } catch (err) {
      new Notice('Failed to load older messages', 4000);
    } finally {
      setLoadingState(false);
    }
  }

  /**
   * Ensures we don't let the DOM grow without bound while the conversation is
   * ongoing.  Once we exceed a generous threshold (two batches worth) we
   * remove the oldest elements that are still in the document, keeping the
   * load-more placeholder at the top intact.
   *
   * This method should be called after a new message has been appended.
   */
  public manageDomSize(): void {
    if (!this.chatContainer) return;

    const groups = Array.from(this.chatContainer.querySelectorAll(':scope > .systemsculpt-message-group')) as HTMLElement[];
    if (groups.length === 0) return;

    const maxMessages = this.VIRTUAL_BATCH_SIZE * 2;
    let totalMessages = 0;
    for (const group of groups) {
      const groupMessages = Array.from(group.children).filter((child) =>
        (child as HTMLElement).classList?.contains?.('systemsculpt-message')
      );
      totalMessages += groupMessages.length;
    }

    if (totalMessages <= maxMessages) {
      return;
    }

    let messagesToRemove = totalMessages - maxMessages;
    let removedMessages = 0;

    for (const group of groups) {
      if (messagesToRemove <= 0) break;

      const groupMessages = Array.from(group.children).filter((child) =>
        (child as HTMLElement).classList?.contains?.('systemsculpt-message')
      );
      const groupCount = groupMessages.length;

      group.remove();
      messagesToRemove -= groupCount;
      removedMessages += groupCount;
    }

    this.virtualStartIndex = Math.min(this.virtualStartIndex + removedMessages, this.messages.length);

    const placeholder = this.chatContainer.querySelector('.systemsculpt-load-more') as HTMLElement | null;
    if (placeholder) {
      placeholder.textContent = `Load earlier messages (${this.virtualStartIndex})`;
    }
  }

  async addFileToContext(file: TFile): Promise<void> {
    await this.contextManager.addFileToContext(file);
  }

  async copyToClipboard(): Promise<void> {
    try {
      const content = await this.exportChatAsMarkdown();
      await navigator.clipboard.writeText(content);
      new Notice("Chat copied to clipboard", 4000);
    } catch (error) {
      new Notice("Failed to copy chat to clipboard", 4000);
    }
  }

  public getDebugLogService(): ChatDebugLogService | null {
    this.ensureCoreServicesReady();
    return this.debugLogService;
  }

  public async copyDebugSnapshotToClipboard(): Promise<void> {
    try {
      const snapshot = await this.buildChatDebugSnapshot();
      const logger = this.getDebugLogService();
      const uiLog = logger ? await logger.writeUiLog(snapshot) : { errors: ["Debug logger unavailable"], bytes: snapshot.length };
      const streamLog = logger ? await logger.writeStreamLog() : { errors: ["Debug logger unavailable"], bytes: 0 };
      const streamStats = logger?.getStreamStats();
      const streamDiagnostics = logger?.getLastStreamDiagnostics();
      const expectedPaths = logger?.buildLogPathsDetailed();

      const index = {
        generatedAt: new Date().toISOString(),
        warnings: [
          "Debug logs include full chat content, system prompts, and settings. Review for sensitive data before sharing.",
          "Streaming logs are capped in-memory and may be truncated when very large.",
        ],
        chat: {
          chatId: this.chatId || null,
          chatTitle: this.chatTitle || null,
          modelId: this.selectedModelId || null,
          chatVersion: this.chatVersion,
        },
        logFiles: {
          ui: {
            path: uiLog.path,
            absolutePath: uiLog.path && logger ? logger.resolveAbsolutePath(uiLog.path) : null,
            bytes: uiLog.bytes,
            expectedPath: expectedPaths?.ui.relative ?? null,
            expectedAbsolutePath: expectedPaths?.ui.absolute ?? null,
          },
          stream: {
            path: streamLog.path,
            absolutePath: streamLog.path && logger ? logger.resolveAbsolutePath(streamLog.path) : null,
            bytes: streamLog.bytes,
            entryCount: streamStats?.entryCount ?? null,
            bufferBytes: streamStats?.bytes ?? null,
            bufferMaxBytes: streamStats?.maxBytes ?? null,
            truncated: streamStats?.truncated ?? null,
            discardedPayloadCount: streamDiagnostics?.discardedPayloadCount ?? null,
            discardedPayloadSamples: streamDiagnostics?.discardedPayloadSamples ?? null,
            expectedPath: expectedPaths?.stream.relative ?? null,
            expectedAbsolutePath: expectedPaths?.stream.absolute ?? null,
          },
        },
        errors: [...(uiLog.errors || []), ...(streamLog.errors || [])],
      };

      const copied = await tryCopyToClipboard(JSON.stringify(index, null, 2));
      if (copied) {
        new Notice("Chat debug index copied to clipboard", 4000);
      } else {
        new Notice("Unable to copy chat debug index (clipboard unavailable).", 5000);
      }
    } catch (error) {
      new Notice("Failed to copy chat debug snapshot", 4000);
    }
  }

  public async buildChatDebugSnapshot(): Promise<string> {
    this.ensureCoreServicesReady();
    const errors: string[] = [];
    const now = new Date();

    const recordError = (label: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}: ${message}`);
    };

    const safe = <T>(label: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (error) {
        recordError(label, error);
        return fallback;
      }
    };

    const safeAsync = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        recordError(label, error);
        return fallback;
      }
    };

    const systemPromptDetails = await safeAsync<{ basePrompt: string; combinedPrompt: string } | null>(
      "system-prompt",
      async () => {
        const basePrompt = await this.systemPromptService.getSystemPromptContent(
          this.systemPromptType || "general-use",
          this.systemPromptPath,
          this.agentMode
        );
        const combinedPrompt = await this.systemPromptService.combineWithAgentPrefix(
          basePrompt,
          this.systemPromptType,
          this.agentMode
        );
        return {
          basePrompt,
          combinedPrompt,
        };
      },
      null
    );

    const exportOptions: Partial<ChatExportOptions> = {
      includeMetadata: true,
      includeSystemPrompt: true,
      includeContextFiles: true,
      includeContextFileContents: true,
      includeConversation: true,
      includeUserMessages: true,
      includeAssistantMessages: true,
      includeToolMessages: true,
      includeReasoning: true,
      includeToolCalls: true,
      includeToolCallArguments: true,
      includeToolCallResults: true,
      includeImages: true,
    };

    const chatExport = await safeAsync<ChatExportResult | null>(
      "chat-export",
      async () => await this.exportChat(exportOptions),
      null
    );

    const chatFilePath = this.chatId ? `${this.plugin.settings.chatsDirectory}/${this.chatId}.md` : null;
    const chatFile = await safeAsync(
      "chat-file",
      async () => {
        if (!chatFilePath) {
          return { path: null, exists: false };
        }
        const file = this.app.vault.getAbstractFileByPath(chatFilePath);
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file);
          return {
            path: chatFilePath,
            exists: true,
            stat: {
              ctime: file.stat.ctime,
              mtime: file.stat.mtime,
              size: file.stat.size,
            },
            content,
          };
        }
        return { path: chatFilePath, exists: false };
      },
      chatFilePath ? { path: chatFilePath, exists: false } : { path: null, exists: false }
    );

    const contextFiles = safe(
      "context-files",
      () => Array.from(this.contextManager?.getContextFiles?.() || []),
      [] as string[]
    );

    const processingEntries = safe(
      "context-processing",
      () => {
        return (this.contextManager?.getProcessingEntries?.() || []).map((entry) => ({
          key: entry.key,
          updatedAt: entry.updatedAt,
          event: entry.event,
          file: entry.file
            ? {
                path: entry.file.path,
                name: entry.file.name,
                stat: {
                  ctime: entry.file.stat.ctime,
                  mtime: entry.file.stat.mtime,
                  size: entry.file.stat.size,
                },
              }
            : null,
        }));
      },
      [] as Array<{
        key: string;
        updatedAt: number;
        event: DocumentProcessingProgressEvent;
        file: { path: string; name: string; stat: { ctime: number; mtime: number; size: number } } | null;
      }>
    );

    const messageCounts = this.messages.reduce(
      (acc, message) => {
        acc.total += 1;
        if (message.role === "user") acc.user += 1;
        else if (message.role === "assistant") acc.assistant += 1;
        else if (message.role === "tool") acc.tool += 1;
        else if (message.role === "system") acc.system += 1;
        else acc.other += 1;
        if (message.streaming) acc.streaming += 1;
        return acc;
      },
      { total: 0, user: 0, assistant: 0, tool: 0, system: 0, other: 0, streaming: 0 }
    );

    const chatContainerState = safe<{
      id: string | null;
      classList: string[];
      dataset: Record<string, string | null>;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      messageGroupCount: number;
      messageCount: number;
      loadMoreLabel: string | null;
      html: string;
      outerHtml: string;
    } | null>(
      "chat-container",
      () => {
        if (!this.chatContainer) return null;
        const dataset: Record<string, string | null> = {};
        Object.keys(this.chatContainer.dataset || {}).forEach((key) => {
          dataset[key] = this.chatContainer.dataset[key] ?? null;
        });
        return {
          id: this.chatContainer.id || null,
          classList: Array.from(this.chatContainer.classList),
          dataset,
          scrollTop: this.chatContainer.scrollTop,
          scrollHeight: this.chatContainer.scrollHeight,
          clientHeight: this.chatContainer.clientHeight,
          messageGroupCount: this.chatContainer.querySelectorAll(".systemsculpt-message-group").length,
          messageCount: this.chatContainer.querySelectorAll(".systemsculpt-message").length,
          loadMoreLabel: (this.chatContainer.querySelector(".systemsculpt-load-more") as HTMLElement | null)?.textContent ?? null,
          html: this.chatContainer.innerHTML,
          outerHtml: this.chatContainer.outerHTML,
        };
      },
      null
    );

    const viewDomState = safe<{
      containerEl: {
        id: string | null;
        classList: string[];
        dataset: Record<string, string | null>;
        html: string | null;
      };
      contentEl: {
        id: string | null;
        classList: string[];
        html: string | null;
      };
      activeElement: { tag: string; id: string | null; classList: string[] } | null;
    } | null>(
      "view-dom",
      () => {
        const containerDataset: Record<string, string | null> = {};
        Object.keys(this.containerEl.dataset || {}).forEach((key) => {
          containerDataset[key] = this.containerEl.dataset[key] ?? null;
        });
        return {
          containerEl: {
            id: this.containerEl?.id || null,
            classList: Array.from(this.containerEl?.classList || []),
            dataset: containerDataset,
            html: this.containerEl?.outerHTML ?? null,
          },
          contentEl: {
            id: this.contentEl?.id || null,
            classList: Array.from(this.contentEl?.classList || []),
            html: this.contentEl?.outerHTML ?? null,
          },
          activeElement: (() => {
            const active = document.activeElement as HTMLElement | null;
            if (!active) return null;
            return {
              tag: active.tagName,
              id: active.id || null,
              classList: Array.from(active.classList),
            };
          })(),
        };
      },
      null
    );

    const scrollState = safe<{
      scrollTop: number;
      isAtBottom: boolean;
      autoScrollEnabled: boolean;
    } | null>(
      "scroll-state",
      () => {
        if (!this.scrollManager) return null;
        const current = this.scrollManager.getScrollState();
        return {
          scrollTop: current.scrollTop,
          isAtBottom: current.isAtBottom,
          autoScrollEnabled: this.scrollManager.isAutoScrollEnabled(),
        };
      },
      null
    );

    const inputState = safe<ReturnType<InputHandler["getDebugState"]> | null>(
      "input-state",
      () => this.inputHandler?.getDebugState?.() ?? null,
      null
    );

    const toolState = safe<ReturnType<ToolCallManager["getDebugSnapshot"]> | null>(
      "tool-state",
      () => this.toolCallManager?.getDebugSnapshot?.() ?? null,
      null
    );

    const snapshot = {
      generatedAt: now.toISOString(),
      warnings: [
        "This snapshot includes full chat content, context file contents, and plugin settings. Review for sensitive data before sharing.",
      ],
      timezone: safe<string | null>("timezone", () => Intl.DateTimeFormat().resolvedOptions().timeZone, null),
      locale: typeof navigator !== "undefined" ? navigator.language : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      platform: typeof navigator !== "undefined" ? navigator.platform : null,
      viewport: typeof window !== "undefined"
        ? {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          }
        : null,
      plugin: {
        id: this.plugin.manifest.id,
        name: this.plugin.manifest.name,
        version: this.plugin.manifest.version,
      },
      vault: {
        name: this.app.vault.getName(),
        configDir: this.app.vault.configDir,
      },
      settings: this.plugin.settings,
      chat: {
        chatId: this.chatId,
        chatTitle: this.chatTitle,
        chatVersion: this.chatVersion,
        isFullyLoaded: this.isFullyLoaded,
        isGenerating: this.isGenerating,
        selectedModelId: this.selectedModelId,
        currentModelName: this.currentModelName,
        currentModelSupportsWebSearch: this.currentModelSupportsWebSearch,
        currentModelSupportedParameters: this.currentModelSupportedParameters,
        webSearchEnabled: this.webSearchEnabled,
        agentMode: this.agentMode,
        systemPromptType: this.systemPromptType,
        systemPromptPath: this.systemPromptPath,
        systemPrompt: systemPromptDetails,
        currentPrompt: this.currentPrompt,
        chatFontSize: this.chatFontSize,
        viewState: this.getState(),
        virtualization: {
          virtualStartIndex: this.virtualStartIndex,
          virtualBatchSize: this.VIRTUAL_BATCH_SIZE,
          hasAdjustedInitialWindow: this.hasAdjustedInitialWindow,
        },
      },
      messages: {
        counts: messageCounts,
        items: this.messages,
      },
      context: {
        files: contextFiles,
        processingEntries,
      },
      tools: toolState,
      ui: {
        input: inputState,
        scroll: scrollState,
        chatContainer: chatContainerState,
        viewDom: viewDomState,
        indicators: {
          modelIndicatorText: this.modelIndicator?.textContent ?? null,
          systemPromptIndicatorText: this.systemPromptIndicator?.textContent ?? null,
        },
      },
      storage: {
        chatFile,
        export: chatExport,
      },
      errors,
    };

    const seen = new WeakSet();
    const replacer = (_key: string, value: any) => {
      if (typeof value === "undefined") return null;
      if (typeof value === "function") return "[Function]";
      if (value instanceof HTMLElement) {
        return {
          tag: value.tagName,
          id: value.id || null,
          classList: Array.from(value.classList),
        };
      }
      if (value instanceof Map) {
        return Array.from(value.entries());
      }
      if (value instanceof Set) {
        return Array.from(value.values());
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    };

    return JSON.stringify(snapshot, replacer, 2);
  }

  public focusInput(): void {
    if(this.inputHandler) this.inputHandler.focus();
  }

  public getSelectedModelId(): string {
    return this.selectedModelId;
  }

  public async setSelectedModelId(modelId: string): Promise<void> {
    const canonicalId = ensureCanonicalId(modelId);

    this.selectedModelId = canonicalId;
    // Update display name immediately so any displayChatStatus() calls use the correct value
    this.currentModelName = getDisplayName(canonicalId);

    // If global policy is to use latest everywhere (or Standard mode), make this the global default
    try {
      const useLatestEverywhere = this.plugin.settings.useLatestModelEverywhere ?? true;
      const isStandardMode = this.plugin.settings.settingsMode !== 'advanced';
      if (useLatestEverywhere || isStandardMode) {
        await this.plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
      }
    } catch {}

    try {
      const model = await this.plugin.modelService.getModelById(canonicalId);

      if (model) {

        const customProvider = this.plugin.settings.customProviders.find(
          (p) => p.name.toLowerCase() === model.provider.toLowerCase()
        );

        if (customProvider) {
          await this.plugin.getSettingsManager().updateSettings({
            activeProvider: {
              id: customProvider.id,
              name: customProvider.name,
              type: "custom",
            }
          });
        } else {
          await this.plugin.getSettingsManager().updateSettings({
            activeProvider: {
              id: "systemsculpt",
              name: "SystemSculpt",
              type: "native",
            }
          });
        }

        // Settings are saved by the provider selection method
      } else {
      }
    } catch (error) {
    }

    await this.refreshModelMetadata();

    // Save the chat to persist the model change
    await this.saveChat();

    // Update the model indicator UI
    await this.updateModelIndicator();

    if (this.inputHandler) {
      this.inputHandler.onModelChange();
    }
    this.focusInput();
    // Centralized sync + broadcast
    this.notifySettingsChanged();
  }

  private getChatExportService(): ChatExportService {
    if (!this.chatExportService) {
      this.chatExportService = new ChatExportService(this);
    }
    return this.chatExportService;
  }

  public async exportChat(options?: Partial<ChatExportOptions>): Promise<ChatExportResult> {
    return this.getChatExportService().export(options);
  }

  public async exportChatAsMarkdown(options?: Partial<ChatExportOptions>): Promise<string> {
    const result = await this.exportChat(options);
    return result.markdown;
  }

  public getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  public getChatTitle(): string {
    return this.chatTitle;
  }

  private initializeChatTitle(initialTitle?: string): void {
    this.chatTitle = initialTitle || generateDefaultChatTitle();
  }

  public async setTitle(newTitle: string, shouldSave: boolean = true): Promise<void> {
    if (newTitle === this.chatTitle) return;

    this.chatTitle = newTitle;

    this.updateViewState();

    if (shouldSave) {
      await this.saveChat();
      this.app.workspace.requestSaveLayout();
    }
  }

  private updateViewState(): void {
    if (this.leaf) {
      const currentState = this.getState();
      this.leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        state: currentState
      }, { focus: true });
    }
  }

  public async setChatFontSize(size: "small" | "medium" | "large"): Promise<void> {
    this.chatFontSize = size;
    if (this.chatContainer) {
      this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
      this.chatContainer.classList.add(`systemsculpt-chat-${size}`);
    }
    this.updateViewState();
    // Save to the actual chat file to persist across reloads
    if (this.chatId && this.isFullyLoaded) {
      await this.saveChat();
    }
    // Centralized sync + broadcast
    this.notifySettingsChanged();
  }



  public async addContextFile(file: TFile): Promise<void> {
    if (this.contextManager) {
      await this.contextManager.addFileToContext(file);
    }
  }

  async onClose(): Promise<void> {
    // Cancel any pending operations
    if (this.inputHandler && typeof (this.inputHandler as any).abortCurrentGeneration === 'function') {
      (this.inputHandler as any).abortCurrentGeneration();
    }
    
    // Clean up drag and drop
    if (this.dragDropCleanup) {
      this.dragDropCleanup();
      this.dragDropCleanup = null;
    }
    
    // Clean up services - call destroy if available
    if (this.scrollManager) {
      if (typeof (this.scrollManager as any).destroy === 'function') {
        (this.scrollManager as any).destroy();
      }
      this.scrollManager = null as any;
    }
    
    if (this.contextManager) {
      if (typeof (this.contextManager as any).destroy === 'function') {
        (this.contextManager as any).destroy();
      }
      this.contextManager = null as any;
    }
    
    if (this.messageRenderer) {
      if (typeof (this.messageRenderer as any).destroy === 'function') {
        (this.messageRenderer as any).destroy();
      }
      this.messageRenderer = null as any;
    }
    
    if (this.toolCallManager) {
      if (typeof (this.toolCallManager as any).destroy === 'function') {
        (this.toolCallManager as any).destroy();
      }
      this.toolCallManager = null as any;
    }
    
    if (this.inputHandler) {
      if (typeof (this.inputHandler as any).destroy === 'function') {
        (this.inputHandler as any).destroy();
      }
      this.inputHandler = null as any;
    }
    
    // Clear message array to free memory
    this.messages = [];
    
    // Remove any DOM event listeners
    if (this.chatContainer) {
      // The message-edited listener is already registered with Component
      // and will be cleaned up automatically
      this.chatContainer = null as any;
    }
    
    // Clear references to DOM elements
    this.modelIndicator = null as any;
    this.systemPromptIndicator = null as any;
    
    // Clear other references
    this.aiService = null as any;
    this.chatStorage = null as any;
    this.systemPromptService = null as any;
    
    // Call parent cleanup
    await super.onClose?.();
  }
}
