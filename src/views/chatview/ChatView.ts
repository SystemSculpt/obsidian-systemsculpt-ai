import { ItemView, WorkspaceLeaf, TFile, Notice, App, MarkdownRenderer, Component } from "obsidian";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { SystemSculptService, type CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import { ChatMessage, ChatRole, MultiPartContent, SystemSculptSettings } from "../../types";
import { ChatStorageService } from "./ChatStorageService";
import { ScrollManagerService } from "./ScrollManagerService";
import type SystemSculptPlugin from "../../main";
import { showPopup, showAlert } from "../../core/ui/";
import { SystemSculptError, isContextOverflowErrorMessage, ERROR_CODES } from "../../utils/errors";
import { MessageRenderer } from "./MessageRenderer";
import { InputHandler } from "./InputHandler";
import { FileContextManager } from "./FileContextManager";
import { SystemPromptService } from "../../services/SystemPromptService";
import { generateDefaultChatTitle, sanitizeChatTitle } from "../../utils/titleUtils";

import {
  ensureCanonicalId,
  findModelById,
  getDisplayName,
  getModelLabelWithProvider,
} from "../../utils/modelUtils";
import { errorLogger } from "../../utils/errorLogger";
import { GENERAL_USE_PRESET } from "../../constants/prompts";
import { ChatExportService } from "./export/ChatExportService";
import type { ChatExportOptions } from "../../types/chatExport";
import type { ChatExportResult } from "./export/ChatExportTypes";
import { removeGroupIfEmpty } from "./utils/MessageGrouping";
import { classifyQuotaExceededError } from "./utils/quotaError";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import type { DocumentProcessingProgressEvent } from "../../types/documentProcessing";
import { ChatDebugLogService } from "./ChatDebugLogService";
import { resolveProviderLabel } from "../../studio/piAuth/StudioPiProviderRegistry";
import { PlatformContext } from "../../services/PlatformContext";
import {
  getManagedSystemSculptModelId,
  hasManagedSystemSculptAccess,
  isManagedSystemSculptModelId,
} from "../../services/systemsculpt/ManagedSystemSculptModel";
import {
  normalizePiSessionState,
  resolveChatBackend,
  type ChatBackend,
  type PiSessionState,
} from "./storage/ChatPersistenceTypes";
import { loadPiTextMigrationModule } from "./runtimeModules";

import { uiSetup } from "./uiSetup";
import { messageHandling } from "./messageHandling";
import { eventHandling } from "./eventHandling";
import { chatSettingsHandling } from "./chatSettingsHandling";
import { renderChatStatusSurface } from "./ui/ChatStatusSurface";

export { CHAT_VIEW_TYPE };

export class ChatView extends ItemView {
  public messages: ChatMessage[] = [];
  public aiService: SystemSculptService;
  public chatStorage: ChatStorageService;
  public chatContainer: HTMLElement;
  public inputHandler: InputHandler;
  public plugin: SystemSculptPlugin;
  public chatId: string;
  public selectedModelId: string;
  public modelIndicator: HTMLElement;
  public systemPromptIndicator: HTMLElement;
  public creditsIndicator: HTMLElement;
  public currentModelName: string = "";
  public isGenerating = false;
  public creditsBalance: CreditsBalanceSnapshot | null = null;
  private creditsBalanceRefreshPromise: Promise<void> | null = null;
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
  public chatBackend: ChatBackend;
  public piSessionFile?: string;
  public piSessionId?: string;
  public piLastEntryId?: string;
  public piLastSyncedAt?: string;
  /** Tools trusted for this chat session (cleared on chat reload/close) */
  private dragDropCleanup: (() => void) | null = null;
  public chatFontSize: "small" | "medium" | "large";
  private systemPromptService: SystemPromptService;
  private settings: SystemSculptSettings;
  private chatExportService: ChatExportService | null = null;
  private debugLogService: ChatDebugLogService | null = null;
  private warnedImageIncompatModels: Set<string> = new Set();
  /**
   * Virtualized chat rendering state
   * --------------------------------
   * To prevent the DOM from bloating when a chat grows very long we only keep
   * a window of the most recent messages in the document.  Older messages can
   * be incrementally loaded via a _Load earlier messages_ placeholder that
   * sits at the top of the list.
   */
  private virtualStartIndex: number = 0;          // Index of the first message currently rendered
  private readonly VIRTUAL_BATCH_SIZE: number = 20; // How many messages to load at a time
  private hasAdjustedInitialWindow: boolean = false;
  private renderEpoch: number = 0;
  private loadEpoch: number = 0;
  private activeLoad: { chatId: string; promise: Promise<void> } | null = null;

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
        chatBackend?: ChatBackend;
        piSessionFile?: string;
        piSessionId?: string;
        piLastEntryId?: string;
        piLastSyncedAt?: string;
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
    this.chatBackend = this.defaultChatBackend();
    this.applyChatLeafState(initialState);

    this.ensureCoreServicesReady();

    // Initialize chat font size from saved state or plugin settings
    this.chatFontSize = initialState.chatFontSize || (plugin.settings as any).chatFontSize || "medium";

    this.systemPromptType = initialState.systemPromptType
        || plugin.settings.systemPromptType
        || "general-use";

    if (this.systemPromptType === "custom" && !this.systemPromptPath) {
      this.systemPromptPath = plugin.settings.systemPromptPath;
    }
    this.layoutChangeHandler = this.onLayoutChange.bind(this);
  }

  private ensureCoreServicesReady(): void {
    if (!this.aiService) {
      this.aiService = SystemSculptService.getInstance(this.plugin);
    }

    if (!this.chatStorage) {
      this.chatStorage = new ChatStorageService(this.app, this.plugin.settings.chatsDirectory);
    }

    if (!this.messageRenderer) {
      this.messageRenderer = new MessageRenderer(this.app);
    }

    if (!this.systemPromptService) {
      this.systemPromptService = SystemPromptService.getInstance(this.app, () => this.plugin.settings);
    }

    if (!this.debugLogService) {
      this.debugLogService = new ChatDebugLogService(this.plugin, this);
    }
  }

  private defaultChatBackend(): ChatBackend {
    return "systemsculpt";
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
    void this.refreshCreditsBalance();
  }
  updateModelIndicator = () => uiSetup.updateModelIndicator(this);
  updateSystemPromptIndicator = () => uiSetup.updateSystemPromptIndicator(this);
  updateCreditsIndicator = () => uiSetup.updateCreditsIndicator(this);
  updateToolCompatibilityWarning = () => uiSetup.updateToolCompatibilityWarning(this);
  addMessage = (role: ChatRole, content: string | MultiPartContent[] | null, existingMessageId?: string, completeMessage?: ChatMessage) =>
    messageHandling.addMessage(this, role, content, existingMessageId, completeMessage);
  loadMessages = () => messageHandling.loadMessages(this);
  setupDragAndDrop = (container: HTMLElement): void => {
    const cleanup = eventHandling.setupDragAndDrop(this, container);
    if (typeof cleanup === 'function') {
      this.dragDropCleanup = cleanup;
    }
  };
  handleOpenChatSettings = () => chatSettingsHandling.openChatSettings(this);


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
        {
          contextFiles: this.contextManager?.getContextFiles() || new Set(),
          title: this.chatTitle,
          chatFontSize: this.chatFontSize,
          piSessionFile: this.piSessionFile,
          piSessionId: this.piSessionId,
          piLastEntryId: this.piLastEntryId,
          piLastSyncedAt: this.piLastSyncedAt,
          chatBackend: this.chatBackend,
        },
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

    const upstreamMessage =
      error instanceof SystemSculptError && typeof error.metadata?.upstreamMessage === "string"
        ? String(error.metadata.upstreamMessage)
        : "";

    if (isContextOverflowErrorMessage(errorMessage) || isContextOverflowErrorMessage(upstreamMessage)) {
      await this.resetFailedAssistantTurn();

      const result = await showPopup(
        this.app,
        "This request doesn't fit in the current SystemSculpt context window.",
        {
          title: "Context Limit Reached",
          icon: "alert-triangle",
          primaryButton: "Retry (Minimal)",
          secondaryButton: "OK",
          description:
            "Shorten the message or attached context, or retry without the current context attachments.",
        }
      );

      if (result?.action === "primary" || result?.confirmed) {
        try {
          await this.inputHandler?.submitWithOverrides?.({ includeContextFiles: false });
        } catch {}
      }

      return;
    }

    if (error instanceof SystemSculptError && error.code === ERROR_CODES.INSUFFICIENT_CREDITS) {
      await this.resetFailedAssistantTurn();

      const formatCredits = (value: number): string => {
        try {
          return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
        } catch {
          return String(value);
        }
      };

      const formatDate = (iso: string): string => {
        if (!iso) return 'unknown';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return 'unknown';
        try {
          return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
        } catch {
          return date.toISOString().slice(0, 10);
        }
      };

      const remaining = typeof error.metadata?.creditsRemaining === 'number'
        ? error.metadata.creditsRemaining
        : Number(error.metadata?.creditsRemaining ?? 0);
      const cycleEndsAt = typeof error.metadata?.cycleEndsAt === 'string' ? error.metadata.cycleEndsAt : '';
      const purchaseUrl = typeof error.metadata?.purchaseUrl === 'string' ? error.metadata.purchaseUrl : null;

      const actionLabel = purchaseUrl ? 'Buy credits' : 'Open Account';
      const result = await showPopup(
        this.app,
        `You don't have enough credits to run this request.\n\nRemaining: ${formatCredits(remaining)} credits\nResets: ${formatDate(cycleEndsAt)}`,
        {
          title: 'Out of credits',
          icon: 'credit-card',
          primaryButton: actionLabel,
          secondaryButton: 'OK',
        }
      );

      if (result?.action === 'primary' || result?.confirmed) {
        if (purchaseUrl) {
          window.open(purchaseUrl, '_blank');
        } else {
          this.openSetupTab('account');
        }
      }

      void this.refreshCreditsBalance();
      return;
    }

    if (error instanceof SystemSculptError && error.code === ERROR_CODES.TURN_IN_FLIGHT) {
      await this.resetFailedAssistantTurn();
      const lockUntil = typeof error.metadata?.lockUntil === 'string' ? error.metadata.lockUntil : '';
      const suffix = lockUntil ? ` (lock until ${lockUntil})` : '';
      new Notice(`A previous request is still processing. Please wait and try again.${suffix}`, 8000);
      return;
    }

    const quotaClassification =
      error instanceof SystemSculptError && error.code === ERROR_CODES.QUOTA_EXCEEDED
        ? classifyQuotaExceededError(error)
        : null;

    if (quotaClassification) {
      if (quotaClassification.isTransientRateLimit) {
        await this.resetFailedAssistantTurn();
        const details =
          quotaClassification.retryAfterSeconds > 0
            ? ` Please wait about ${quotaClassification.retryAfterSeconds}s and try again.`
            : " Please wait a moment and try again.";
        new Notice(`The SystemSculpt backend is temporarily rate-limited.${details}`, 8000);
        return;
      }

      new Notice(
        "Usage quota is exhausted for your SystemSculpt account. Add credits or wait for the next reset.",
        10000
      );
    }

    const shouldRecoverFromQuotaBySwitching =
      !!quotaClassification && !quotaClassification.isTransientRateLimit;
    
    if (
      error instanceof SystemSculptError &&
      (error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_REQUEST_ERROR" || shouldRecoverFromQuotaBySwitching)
    ) {
      if (!this.hasConfiguredProvider()) {
        await this.promptProviderSetup(
          "Finish setup in Settings → Account before starting a chat."
        );
        await this.resetFailedAssistantTurn();
        return;
      }

      await this.resetFailedAssistantTurn();
      new Notice(
        "SystemSculpt could not complete this request right now. Please try again in a moment or check Account for license and account status.",
        10000
      );
    } else {
      // Handle other types of errors
      // Error already logged and Notice shown by errorLogger
    }
  }

  public async notifyCompatibilityNotice(info: { modelId: string; tools?: boolean; images?: boolean; source?: "cached" | "runtime" }): Promise<void> {
    const images = !!info.images;
    if (!images) return;

    const canonicalId = info.modelId ? ensureCanonicalId(info.modelId) : "";
    const modelLabel = canonicalId ? getModelLabelWithProvider(canonicalId) : (info.modelId || "this model");

    if (!this.warnedImageIncompatModels.has(canonicalId)) {
      this.warnedImageIncompatModels.add(canonicalId);
      const reason = info.source === "runtime" ? " because the backend rejected image inputs" : "";
      try {
        new Notice(
          `Image context was skipped for ${modelLabel}${reason}. Switch to a vision-capable model to include images.`,
          8000
        );
      } catch {}
    }

    // Refresh the warning banner so it reflects runtime incompatibility updates.
    try {
      await uiSetup.updateToolCompatibilityWarning(this);
    } catch {}
  }

  public async refreshCreditsBalance(): Promise<void> {
    const isProActive =
      !!(this.plugin.settings.licenseValid === true && this.plugin.settings.licenseKey?.trim());

    if (!isProActive) {
      this.creditsBalance = null;
      try {
        await this.updateCreditsIndicator();
      } catch {}
      return;
    }

    if (this.creditsBalanceRefreshPromise) {
      return this.creditsBalanceRefreshPromise;
    }

    this.creditsBalanceRefreshPromise = (async () => {
      try {
        this.creditsBalance = await this.aiService.getCreditsBalance();
      } catch {
        // Avoid noisy toasts; the balance UI is a convenience panel.
      } finally {
        try {
          await this.updateCreditsIndicator();
        } catch {}
      }
    })().finally(() => {
      this.creditsBalanceRefreshPromise = null;
    });

    return this.creditsBalanceRefreshPromise;
  }

  public async openCreditsBalanceModal(): Promise<void> {
    await this.plugin.openCreditsBalanceModal({
      initialBalance: this.creditsBalance,
      onBalanceUpdated: async (balance) => {
        this.creditsBalance = balance;
        try {
          await this.updateCreditsIndicator();
        } catch {}
      },
      settingsTab: "account",
    });
  }

  public hasConfiguredProvider(): boolean {
    return hasManagedSystemSculptAccess(this.plugin);
  }

  public openSetupTab(targetTab: string = "account"): void {
    this.plugin.openSettingsTab(targetTab);
  }

  private async resolveLoadedSelectedModelId(savedModelId: string): Promise<string> {
    const rawModelId = String(savedModelId || "").trim();
    if (!rawModelId) {
      return getManagedSystemSculptModelId();
    }

    const platform = PlatformContext.get();
    const supportsDesktopOnlyFeatures = platform.supportsDesktopOnlyFeatures();
    const customProviders = this.plugin.settings.customProviders || [];
    const {
      normalizeLegacyPiTextSelectionId,
      resolveLegacyPiTextSelectionId,
    } = await loadPiTextMigrationModule();
    const normalizedRawModelId = normalizeLegacyPiTextSelectionId(rawModelId);
    const tryResolve = (models: any[]): string => {
      const directMatch = findModelById(models, rawModelId);
      if (directMatch?.id) {
        return directMatch.id;
      }
      const normalizedDirectMatch = findModelById(models, normalizedRawModelId);
      if (normalizedDirectMatch?.id) {
        return normalizedDirectMatch.id;
      }
      return resolveLegacyPiTextSelectionId(rawModelId, models, customProviders);
    };

    try {
      const cachedModels = this.plugin.modelService.getCachedModels();
      const cachedResolved = tryResolve(cachedModels);
      if (cachedResolved !== rawModelId || !!findModelById(cachedModels, cachedResolved)) {
        return cachedResolved;
      }
    } catch {
      // Fall back to the last persisted id if the cache is not ready yet.
    }

    if (!supportsDesktopOnlyFeatures) {
      return getManagedSystemSculptModelId();
    }

    try {
      const models = await this.plugin.modelService.getModels();
      const resolved = tryResolve(models);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Keep the saved id when live model resolution isn't available.
    }

    return isManagedSystemSculptModelId(rawModelId) ? rawModelId : getManagedSystemSculptModelId();
  }

  public async promptProviderSetup(customMessage?: string): Promise<void> {
    const message = customMessage ??
      "Open Settings -> Account to activate your SystemSculpt license, then try again.";
    const result = await showPopup(this.app, message, {
      title: "Finish setup",
      icon: "plug-zap",
      primaryButton: "Open Account",
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

    const needsProviderSetup = !this.hasConfiguredProvider();
    const contextCount = this.contextManager?.getContextFiles?.().size ?? 0;
    const contextLabel = contextCount === 0 ? "No context yet" : `${contextCount} file${contextCount === 1 ? "" : "s"} attached`;
    const historyPath = this.getChatHistoryFilePath();
    const hasHistoryFile = !!historyPath;

    const actionSpecs: Array<{
      label: string;
      icon: string;
      onClick: () => void | Promise<void>;
      primary?: boolean;
      title?: string;
    }> = [];

    const contextActionSpec = {
      label: "Add Context",
      icon: "paperclip",
      primary: !needsProviderSetup,
      title: "Attach notes, documents, images, or audio to this chat",
      onClick: async () => {
        await this.contextManager?.addContextFile?.();
      },
    };

    if (needsProviderSetup) {
      actionSpecs.push({
        label: "Open Account",
        icon: "plug-zap",
        primary: true,
        title: "Open Account and activate your SystemSculpt license",
        onClick: () => {
          this.openSetupTab();
        },
      });
    } else {
      actionSpecs.push(contextActionSpec);
    }

    if (hasHistoryFile) {
      actionSpecs.push({
        label: "Open Transcript",
        icon: "file-text",
        title: "Open the saved markdown file for this chat",
        onClick: async () => {
          await this.inputHandler?.handleOpenChatHistoryFile?.();
        },
      });
    }

    renderChatStatusSurface(statusContainer, {
      eyebrow: needsProviderSetup ? "Setup required" : "Ready",
      title: needsProviderSetup ? "Finish setup" : "New chat",
      description: needsProviderSetup
        ? "Add and validate your SystemSculpt license to start chatting."
        : "Type below or attach context. SystemSculpt handles the rest.",
      chips: [
        {
          label: "Context",
          value: contextLabel,
          icon: "paperclip",
        },
        ...(this.getPiSessionFile()
          ? [
              {
                label: "Session",
                value: "Linked",
                icon: "git-fork",
              },
            ]
          : []),
      ],
      actions: actionSpecs,
      note: hasHistoryFile
        ? "Use / for export and debug tools."
        : "Use / for export and debug tools once this chat is saved.",
    }, {
      registerDomEvent: this.registerDomEvent.bind(this),
    });

    // Remove no-animate after refresh so future first-time displays can animate again
    try { statusContainer.removeClass('no-animate'); } catch {}
  }
  public getExpectedChatHistoryFilePath(): string | null {
    const chatId = String(this.chatId || "").trim();
    if (!chatId) {
      return null;
    }

    const configuredDirectory = String(this.plugin.settings.chatsDirectory || "").trim();
    const chatDirectory = configuredDirectory || "SystemSculpt/Chats";
    return `${chatDirectory}/${chatId}.md`;
  }

  public getChatHistoryFilePath(): string | null {
    const expectedPath = this.getExpectedChatHistoryFilePath();
    if (!expectedPath) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(expectedPath);
    return file instanceof TFile ? file.path : null;
  }

  public getChatHistoryAbsolutePath(): string | null {
    const chatHistoryPath = this.getChatHistoryFilePath();
    return chatHistoryPath ? resolveAbsoluteVaultPath(this.app.vault.adapter, chatHistoryPath) : null;
  }

  public async copyCurrentChatFilePathToClipboard(): Promise<void> {
    const absolutePath = this.getChatHistoryAbsolutePath();
    if (!absolutePath) {
      new Notice(
        this.chatId
          ? "Chat history file is not available yet. Send a message or reopen a saved chat first."
          : "Start or open a chat before copying its path.",
        5000
      );
      return;
    }

    const copied = await tryCopyToClipboard(absolutePath);
    if (!copied) {
      new Notice("Unable to copy chat file path to clipboard.", 5000);
      return;
    }

    new Notice("Chat file path copied to clipboard.", 4000);
  }

  public async copyChatArtifactPathsToClipboard(): Promise<void> {
    const logger = this.getDebugLogService();
    const expectedHistoryPath = this.getExpectedChatHistoryFilePath();
    const historyPath = this.getChatHistoryFilePath();
    const expectedHistoryAbsolutePath = expectedHistoryPath
      ? resolveAbsoluteVaultPath(this.app.vault.adapter, expectedHistoryPath)
      : null;
    const logPaths = logger?.buildLogPathsDetailed();

    const payload = {
      generatedAt: new Date().toISOString(),
      chat: {
        chatId: this.chatId || null,
        chatTitle: this.chatTitle || null,
        modelId: this.selectedModelId || null,
        chatBackend: this.chatBackend || null,
        piSessionFile: this.piSessionFile || null,
        piSessionId: this.piSessionId || null,
        piLastEntryId: this.piLastEntryId || null,
        piLastSyncedAt: this.piLastSyncedAt || null,
      },
      history: {
        path: historyPath,
        absolutePath: historyPath ? this.getChatHistoryAbsolutePath() : null,
        exists: !!historyPath,
        expectedPath: expectedHistoryPath,
        expectedAbsolutePath: expectedHistoryAbsolutePath,
      },
      logFiles: {
        ui: {
          expectedPath: logPaths?.ui.relative ?? null,
          expectedAbsolutePath: logPaths?.ui.absolute ?? null,
        },
        stream: {
          expectedPath: logPaths?.stream.relative ?? null,
          expectedAbsolutePath: logPaths?.stream.absolute ?? null,
        },
      },
    };

    const copied = await tryCopyToClipboard(JSON.stringify(payload, null, 2));
    if (!copied) {
      new Notice("Unable to copy chat file and log paths (clipboard unavailable).", 5000);
      return;
    }

    new Notice("Chat file and log paths copied to clipboard.", 4000);
  }

	  private async refreshModelMetadata(): Promise<void> {
	    this.inputHandler?.refreshTokenCounter();
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
      chatTitle: this.chatTitle,
      version: this.chatVersion,
      chatFontSize: this.chatFontSize,
      chatBackend: this.chatBackend,
      piSessionFile: this.piSessionFile,
      piSessionId: this.piSessionId,
      piLastEntryId: this.piLastEntryId,
      piLastSyncedAt: this.piLastSyncedAt,
      file: this.getExpectedChatHistoryFilePath() || undefined,
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
      this.chatBackend = this.defaultChatBackend();
      this.applyPiSessionState({}, { reset: true, updateViewState: false });
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
      this.hasAdjustedInitialWindow = false;
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
      this.virtualStartIndex = 0;
      this.hasAdjustedInitialWindow = false;
      this.selectedModelId = state.selectedModelId || this.plugin.settings.selectedModelId || "";
      this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
      this.initializeChatTitle(state.chatTitle);
      this.chatVersion = state.version !== undefined ? state.version : -1;
      this.systemPromptType = state.systemPromptType || 'general-use';
      this.systemPromptPath = this.systemPromptType === 'custom' ? state.systemPromptPath : undefined;

      this.applyChatLeafState(state);

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
    this.virtualStartIndex = 0;
    this.hasAdjustedInitialWindow = false;
    // When loading an existing chat, use the stored model selection as-is
    this.selectedModelId = state.selectedModelId || this.plugin.settings.selectedModelId || "";
    this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
    this.initializeChatTitle(state.chatTitle);
    this.chatVersion = state.version !== undefined ? state.version : -1;

    // Simplified system prompt handling - use 'general-use' as default
    this.systemPromptType = state.systemPromptType || 'general-use';
    // Only set path for custom prompts
    this.systemPromptPath = this.systemPromptType === 'custom' ? state.systemPromptPath : undefined;

    this.applyChatLeafState(state);
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
      this.hasAdjustedInitialWindow = false;
      this.messages = [];
      this.contextManager?.clearContext();
      this.systemPromptType = 'general-use';
      this.systemPromptPath = undefined;
      this.chatBackend = this.defaultChatBackend();
      this.applyPiSessionState({}, { reset: true, updateViewState: false });
      // Don't render here if UI not ready yet
      if (this.chatContainer) {
        this.renderMessagesInChunks();
      }
      this.isFullyLoaded = true; // Even failed loads are "loaded"
      this.inputHandler?.notifyChatReadyChanged?.();
    }
  }

  async loadChatById(chatId: string): Promise<void> {
    this.ensureCoreServicesReady();

    // De-dupe redundant concurrent loads for the same chatId.
    if (this.activeLoad && this.activeLoad.chatId === chatId) {
      await this.activeLoad.promise;
      return;
    }

    const loadEpoch = ++this.loadEpoch;
    const promise = (async () => {
      this.chatId = chatId;
      this.isFullyLoaded = false; // Mark as not loaded while loading
      this.virtualStartIndex = 0;
      this.hasAdjustedInitialWindow = false;

      if (this.chatContainer) {
        this.chatContainer.empty();
        this.showChatLoadingBanner("Loading chat…");
      }
      this.inputHandler?.notifyChatReadyChanged?.();

      const yieldToPaint = () => new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(() => resolve(), 0);
        }
      });

      // Give the browser a chance to paint the loading banner before we do any
      // potentially-heavy parsing work.
      await yieldToPaint();

      try {
        const chatData = await this.chatStorage.loadChat(chatId);
        if (loadEpoch !== this.loadEpoch) return;

        if (!chatData) {
          this.messages = [];
          this.chatContainer?.empty();
          this.setTitle("Chat not found");
          this.systemPromptType = 'general-use';
          this.systemPromptPath = undefined;
          this.chatBackend = this.defaultChatBackend();
          this.applyPiSessionState({}, { reset: true, updateViewState: false });
          this.contextManager?.clearContext();
          this.isFullyLoaded = true; // Mark as loaded even when chat not found
          this.inputHandler?.notifyChatReadyChanged?.();
          // UI indicators can update asynchronously
          void this.updateModelIndicator();
          void this.updateSystemPromptIndicator();
          return;
        }

        // Restore all chat properties
        this.selectedModelId = await this.resolveLoadedSelectedModelId(
          chatData.selectedModelId || this.plugin.settings.selectedModelId
        );
        this.currentModelName = this.selectedModelId ? getDisplayName(ensureCanonicalId(this.selectedModelId)) : "";
        this.setTitle(chatData.title || generateDefaultChatTitle(), false);
        const persistedMessages = chatData.messages || [];
        this.chatVersion = chatData.version || 0;

        // Simplified system prompt handling
        this.systemPromptType = chatData.systemPromptType || 'general-use';
        this.systemPromptPath = this.systemPromptType === 'custom' ? chatData.systemPromptPath : undefined;

        this.applyChatLeafState({
          chatBackend: chatData.chatBackend,
          piSessionFile: chatData.piSessionFile,
          piSessionId: chatData.piSessionId,
          piLastEntryId: chatData.piLastEntryId,
          piLastSyncedAt: chatData.piLastSyncedAt,
        });
        const hasPiSession = this.isPiBackedChat() && (!!this.getPiSessionFile() || !!this.getPiSessionId());
        const canHydratePiTranscript = !!this.getPiSessionFile();
        this.messages = persistedMessages;

        // Load chat font size from chat data
        this.chatFontSize = chatData.chatFontSize || this.plugin.settings.chatFontSize || "medium";
        // Apply it after UI is ready (don't save again, just apply visually)
        setTimeout(() => {
          if (this.chatContainer) {
            this.chatContainer.classList.remove("systemsculpt-chat-small", "systemsculpt-chat-medium", "systemsculpt-chat-large");
            this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
          }
        }, 100);

        // Restore context files without blocking first render.
        if (this.contextManager) {
          const contextFiles = (chatData.context_files || []).filter(Boolean);
          if (contextFiles.length > 0) {
            void this.contextManager.setContextFiles(contextFiles);
          } else {
            this.contextManager.clearContext();
          }
        }

        if (persistedMessages.length > 0 || !hasPiSession) {
          await this.renderMessagesInChunks();
          if (loadEpoch !== this.loadEpoch) return;
        }

        if (hasPiSession && canHydratePiTranscript) {
          this.showChatLoadingBanner(
            persistedMessages.length > 0 ? "Syncing SystemSculpt session..." : "Restoring SystemSculpt chat..."
          );
          await yieldToPaint();
          try {
            await this.syncPiSessionTranscript({
              sessionFile: this.piSessionFile,
              sessionId: this.piSessionId,
              syncTitle: true,
              render: true,
              persist: false,
            });
            if (loadEpoch !== this.loadEpoch) return;
          } catch (error) {
            try {
              errorLogger.warn("Failed to hydrate chat history from SystemSculpt session file", {
                source: "ChatView",
                method: "loadChatById",
                metadata: {
                  chatId,
                  sessionFile: this.piSessionFile,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            } catch {}

            if (persistedMessages.length === 0) {
              this.messages = persistedMessages;
              await this.renderMessagesInChunks();
              if (loadEpoch !== this.loadEpoch) return;
            }
          }

          this.removeChatLoadingBanner();
        }

        this.isFullyLoaded = true; // Mark as loaded after messages are rendered
        this.inputHandler?.notifyChatReadyChanged?.();

        // Update UI indicators (async; do not block chat readiness)
        void this.updateModelIndicator();
        void this.updateSystemPromptIndicator();
        void this.refreshModelMetadata();

        if (this.inputHandler) {
          this.inputHandler.onModelChange();
        }

        // Validate context files in the background
        void this.contextManager?.validateAndCleanContextFiles();

        // Update the tab title
        this.updateViewState();

        // Notify listeners that a chat has been loaded
        this.app.workspace.trigger("systemsculpt:chat-loaded", this.chatId);
      } catch (error) {
        if (loadEpoch !== this.loadEpoch) return;
        this.handleError(`Failed to load chat: ${(error as any)?.message ?? String(error)}`);
        this.isFullyLoaded = true; // Mark as loaded even on error to prevent stuck state
        this.removeChatLoadingBanner();
        this.inputHandler?.notifyChatReadyChanged?.();
      }
    })();

    this.activeLoad = { chatId, promise };
    try {
      await promise;
    } finally {
      if (this.activeLoad?.promise === promise) {
        this.activeLoad = null;
      }
    }
  }

  private showChatLoadingBanner(label: string = "Loading chat…"): void {
    if (!this.chatContainer) return;

    let banner = this.chatContainer.querySelector(
      ':scope > .systemsculpt-chat-loading-banner'
    ) as HTMLElement | null;

    if (!banner) {
      banner = document.createElement("div");
      banner.className = "systemsculpt-chat-loading-banner";
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");
      this.chatContainer.insertBefore(banner, this.chatContainer.firstChild);
    } else {
      banner.empty();
    }

    banner.createDiv({ cls: "systemsculpt-chat-loading-spinner", attr: { "aria-hidden": "true" } });
    banner.createDiv({ cls: "systemsculpt-chat-loading-text", text: label });
  }

  private removeChatLoadingBanner(): void {
    if (!this.chatContainer) return;
    const banner = this.chatContainer.querySelector(
      ':scope > .systemsculpt-chat-loading-banner'
    ) as HTMLElement | null;
    banner?.remove();
  }

  public async renderMessagesInChunks(): Promise<void> {
    if (!this.chatContainer) return;

    const renderEpoch = ++this.renderEpoch;

    // Determine the slice of history we want to render.  If this is the first
    // render of the view (virtualStartIndex === 0) we default to showing only
    // the most recent VIRTUAL_BATCH_SIZE messages.
    const total = this.messages.length;
    if (total === 0) {
      this.chatContainer.empty();
      this.removeChatLoadingBanner();
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

    const shouldShowLoadingBanner = !!this.chatId && !this.isFullyLoaded;
    if (shouldShowLoadingBanner) {
      this.showChatLoadingBanner("Loading chat…");
    }

    // If we are not rendering from the very first message, insert a
    // _Load earlier messages_ placeholder at the top so the user can fetch
    // older history on-demand.
    if (this.virtualStartIndex > 0) {
      const placeholder = this.createLoadMoreButton();
      this.chatContainer.appendChild(placeholder);
    }

    const yieldToPaint = () => new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(() => resolve(), 0);
      }
    });

    // Render the slice [virtualStartIndex, total) in small chunks so the view
    // never appears blank for long, even with large histories.
    const chunkSize = 6;
    for (let start = this.virtualStartIndex; start < total; start += chunkSize) {
      if (renderEpoch !== this.renderEpoch) return;

      const frag = document.createDocumentFragment();
      const end = Math.min(total, start + chunkSize);
      for (let i = start; i < end; i++) {
        if (renderEpoch !== this.renderEpoch) return;
        const msg = this.messages[i];
        await messageHandling.addMessage(this, msg.role, msg.content, msg.message_id, msg, frag);
      }

      if (renderEpoch !== this.renderEpoch) return;
      this.chatContainer.appendChild(frag);

      await yieldToPaint();
    }

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

    if (shouldShowLoadingBanner) {
      this.removeChatLoadingBanner();
    }
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
          chatBackend: this.chatBackend || null,
          piSessionFile: this.piSessionFile || null,
          piSessionId: this.piSessionId || null,
          piLastEntryId: this.piLastEntryId || null,
          piLastSyncedAt: this.piLastSyncedAt || null,
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
          this.systemPromptPath
        );
        return {
          basePrompt,
          combinedPrompt: basePrompt,
        };
      },
      null
    );

    const exportOptions: Partial<ChatExportOptions> = {
      includeMetadata: true,
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

    const chatFilePath = this.getExpectedChatHistoryFilePath();
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

  private readPiSessionState(): PiSessionState {
    return normalizePiSessionState({
      sessionFile: this.piSessionFile,
      sessionId: this.piSessionId,
      lastEntryId: this.piLastEntryId,
      lastSyncedAt: this.piLastSyncedAt,
    });
  }

  private applyPiSessionState(
    next: Partial<PiSessionState>,
    options?: {
      backend?: ChatBackend;
      reset?: boolean;
      touchSyncedAt?: boolean;
      updateViewState?: boolean;
    }
  ): void {
    const current = options?.reset ? {} : this.readPiSessionState();
    const merged = normalizePiSessionState({
      sessionFile: next.sessionFile ?? current.sessionFile,
      sessionId: next.sessionId ?? current.sessionId,
      lastEntryId: next.lastEntryId ?? current.lastEntryId,
      lastSyncedAt: next.lastSyncedAt ?? current.lastSyncedAt,
    });

    if (options?.backend) {
      this.chatBackend = options.backend;
    }

    this.piSessionFile = merged.sessionFile;
    this.piSessionId = merged.sessionId;
    this.piLastEntryId = merged.lastEntryId;
    this.piLastSyncedAt =
      options?.touchSyncedAt ? new Date().toISOString() : merged.lastSyncedAt;

    if (options?.updateViewState !== false) {
      this.updateViewState();
    }
  }

  private applyChatLeafState(state: {
    chatBackend?: ChatBackend;
    piSessionFile?: string;
    piSessionId?: string;
    piLastEntryId?: string;
    piLastSyncedAt?: string;
  }): void {
    const chatBackend = resolveChatBackend({
      explicitBackend: state.chatBackend,
      piSessionFile: state.piSessionFile,
      piSessionId: state.piSessionId,
      defaultBackend: this.defaultChatBackend(),
    });
    const canPreserveSessionState = PlatformContext.get().supportsDesktopOnlyFeatures();
    this.applyPiSessionState(
      chatBackend === "systemsculpt" && canPreserveSessionState
        ? {
            sessionFile: state.piSessionFile,
            sessionId: state.piSessionId,
            lastEntryId: state.piLastEntryId,
            lastSyncedAt: state.piLastSyncedAt,
          }
        : {},
      {
        backend: chatBackend,
        reset: true,
        updateViewState: false,
      }
    );
  }

  public getSelectedModelId(): string {
    return this.selectedModelId;
  }

  public getPiSessionFile(): string | undefined {
    return typeof this.piSessionFile === "string" && this.piSessionFile.trim().length > 0
      ? this.piSessionFile
      : undefined;
  }

  public getPiSessionId(): string | undefined {
    return typeof this.piSessionId === "string" && this.piSessionId.trim().length > 0
      ? this.piSessionId
      : undefined;
  }

  public isPiBackedChat(): boolean {
    return this.chatBackend === "systemsculpt";
  }

  public isLegacyReadOnlyChat(): boolean {
    return this.chatBackend === "legacy" && String(this.chatId || "").trim().length > 0;
  }

  private resolvePiSessionRef(nextState?: {
    sessionFile?: string;
    sessionId?: string;
  }): { sessionFile?: string; sessionId?: string } {
    const current = this.readPiSessionState();
    const sessionFile = String(nextState?.sessionFile || current.sessionFile || "").trim();
    const sessionId = String(nextState?.sessionId || current.sessionId || "").trim();
    return {
      sessionFile: sessionFile || undefined,
      sessionId: sessionId || undefined,
    };
  }

  public async syncPiSessionTranscript(options?: {
    sessionFile?: string;
    sessionId?: string;
    syncTitle?: boolean;
    render?: boolean;
    persist?: boolean;
    force?: boolean;
  }): Promise<boolean> {
    const sessionRef = this.resolvePiSessionRef(options);
    if (!PlatformContext.get().supportsDesktopOnlyFeatures()) {
      return false;
    }
    if (!this.isPiBackedChat()) {
      return false;
    }
    if (!sessionRef.sessionFile) {
      this.applyPiSessionState(
        {
          sessionFile: sessionRef.sessionFile,
          sessionId: sessionRef.sessionId,
        },
        {
          backend: "systemsculpt",
          touchSyncedAt: !!sessionRef.sessionId,
        }
      );
      if (options?.persist && this.chatId && this.isFullyLoaded) {
        await this.saveChat();
      }
      return false;
    }

    const { loadPiSessionMirrorWithRecovery } = await import("../../services/pi/PiSessionMirror");
    const snapshot = await loadPiSessionMirrorWithRecovery({
      plugin: this.plugin,
      sessionFile: sessionRef.sessionFile,
      lastEntryId: this.piLastEntryId,
      messageEntryIds: this.messages
        .map((message) => String(message.pi_entry_id || "").trim())
        .filter(Boolean),
    });

    const nextLastEntryId = String(snapshot.lastEntryId || "").trim() || this.piLastEntryId;
    const shouldReplaceTranscript =
      options?.force === true ||
      this.messages.length === 0 ||
      !this.piLastEntryId ||
      (!!nextLastEntryId && nextLastEntryId !== this.piLastEntryId);

    if (shouldReplaceTranscript && snapshot.messages.length > 0) {
      this.messages = snapshot.messages;
    }
    this.applyPiSessionState(
      {
        sessionFile: snapshot.sessionFile || sessionRef.sessionFile,
        sessionId: snapshot.sessionId || sessionRef.sessionId,
        lastEntryId: nextLastEntryId,
      },
      {
        backend: "systemsculpt",
        touchSyncedAt: true,
      }
    );

    const sessionName = String(snapshot.sessionName || "").trim();
    if (options?.syncTitle !== false && sessionName) {
      this.setTitle(sessionName, false);
    }

    this.updateViewState();

    if (options?.render !== false && shouldReplaceTranscript) {
      await this.renderMessagesInChunks();
    }

    if (options?.persist && this.chatId && this.isFullyLoaded) {
      await this.saveChat();
    }

    return shouldReplaceTranscript;
  }

  private async applyLocalPiForkState(options: {
    forkMessageId: string;
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
  }): Promise<void> {
    const forkIndex = this.messages.findIndex(
      (message) => message.message_id === options.forkMessageId && message.role === "user"
    );
    if (forkIndex === -1) {
      throw new Error("Pi could not resolve the chat message selected for forking.");
    }

    // Pi restores the selected user prompt into the editor, so the visible transcript should
    // stop immediately before that message while the new branch waits for its first assistant turn.
    this.messages = this.messages.slice(0, forkIndex);
    this.applyPiSessionState(
      {
        sessionFile: options.sessionFile,
        sessionId: options.sessionId,
        lastEntryId: String(this.messages[this.messages.length - 1]?.pi_entry_id || "").trim() || undefined,
      },
      {
        backend: "systemsculpt",
        reset: !options.sessionFile && !options.sessionId,
        touchSyncedAt: true,
      }
    );

    const sessionName = String(options.sessionName || "").trim();
    if (sessionName) {
      this.setTitle(sessionName, false);
    }

    this.updateViewState();
    await this.renderMessagesInChunks();

    if (this.chatId && this.isFullyLoaded) {
      await this.saveChat();
    }
  }

  public async hydrateFromPiSession(options?: {
    sessionFile?: string;
    sessionId?: string;
    syncTitle?: boolean;
    render?: boolean;
    save?: boolean;
  }): Promise<void> {
    await this.syncPiSessionTranscript({
      sessionFile: options?.sessionFile,
      sessionId: options?.sessionId,
      syncTitle: options?.syncTitle,
      render: options?.render,
      persist: options?.save,
      force: true,
    });
  }

  private async resolvePiForkEntryId(
    client: { getForkMessages(): Promise<Array<{ entryId?: string }>> },
    messageId: string,
  ): Promise<string> {
    const userMessages = this.messages.filter((message) => message.role === "user");
    const userIndex = userMessages.findIndex((message) => message.message_id === messageId);
    if (userIndex === -1) {
      return "";
    }

    const forkMessages = await client.getForkMessages();
    if (userIndex >= forkMessages.length) {
      return "";
    }

    return String(forkMessages[userIndex]?.entryId || "").trim();
  }

  public async forkPiSessionFromMessage(messageId: string): Promise<{
    text: string;
    cancelled: boolean;
  }> {
    const sessionFile = this.getPiSessionFile();
    const sessionId = this.getPiSessionId();
    const targetMessage = this.messages.find(
      (message) => message.message_id === messageId && message.role === "user"
    );
    if (!targetMessage) {
      throw new Error("Only SystemSculpt session user messages can be branched.");
    }

    if (!sessionFile && !sessionId) {
      throw new Error("This chat does not have an active SystemSculpt session to branch.");
    }
    if (sessionFile) {
      const { existsSync } = await import("node:fs");
      if (!existsSync(sessionFile)) {
        throw new Error(
          "The linked session file no longer exists. Reopen the chat to recover it, or start a new chat."
        );
      }
    }

    if (!sessionFile && sessionId) {
      await this.applyLocalPiForkState({
        forkMessageId: messageId,
      });
      return {
        text:
          typeof targetMessage.content === "string"
            ? targetMessage.content
            : JSON.stringify(targetMessage.content ?? ""),
        cancelled: false,
      };
    }

    const { PiRpcProcessClient } = await import("../../services/pi/PiRpcProcessClient");
    const client = new PiRpcProcessClient({
      plugin: this.plugin,
      sessionFile: sessionFile!,
    });

    await client.start();
    try {
      const entryId =
        String(targetMessage.pi_entry_id || "").trim() ||
        (await this.resolvePiForkEntryId(client, messageId));
      if (!entryId) {
        throw new Error("Pi could not resolve a fork point for this message.");
      }

      const result = await client.fork(entryId);
      if (result.cancelled) {
        return result;
      }

      const state = await client.getState();
      const nextSessionFile = String(state.sessionFile || "").trim() || sessionFile;
      const nextSessionId = String(state.sessionId || "").trim() || this.piSessionId;
      const nextSessionName = String(state.sessionName || "").trim();

      if (nextSessionFile) {
        const { existsSync } = await import("node:fs");
        if (!existsSync(nextSessionFile)) {
          await this.applyLocalPiForkState({
            forkMessageId: messageId,
            sessionFile: nextSessionFile,
            sessionId: nextSessionId,
            sessionName: nextSessionName,
          });
        } else {
          await this.syncPiSessionTranscript({
            sessionFile: nextSessionFile,
            sessionId: nextSessionId,
            syncTitle: true,
            render: true,
            persist: true,
            force: true,
          });
        }
      } else {
        await this.syncPiSessionTranscript({
          sessionFile: nextSessionFile,
          sessionId: nextSessionId,
          syncTitle: true,
          render: true,
          persist: true,
          force: true,
        });
      }

      return result;
    } finally {
      await client.stop();
    }
  }

  private async syncPiSessionName(name: string): Promise<void> {
    const sessionFile = this.getPiSessionFile();
    const sessionName = String(name || "").trim();
    if (!PlatformContext.get().supportsDesktopOnlyFeatures() || !sessionFile || !sessionName) {
      return;
    }

    const { PiRpcProcessClient } = await import("../../services/pi/PiRpcProcessClient");
    const client = new PiRpcProcessClient({
      plugin: this.plugin,
      sessionFile,
    });

    await client.start();
    try {
      await client.setSessionName(sessionName);
      const state = await client.getState();
      this.applyPiSessionState(
        {
          sessionFile: String(state.sessionFile || "").trim() || sessionFile,
          sessionId: String(state.sessionId || "").trim() || this.piSessionId,
        },
        {
          backend: "systemsculpt",
        }
      );
    } finally {
      await client.stop();
    }
  }

  public clearPiSessionState(options?: { save?: boolean; updateViewState?: boolean }): void {
    const hadSession = !!this.piSessionFile || !!this.piSessionId;
    this.applyPiSessionState({}, { reset: true, updateViewState: options?.updateViewState });

    if (hadSession && options?.save && this.chatId && this.isFullyLoaded) {
      void this.saveChat();
    }
  }

  public setPiSessionState(session: { sessionFile?: string; sessionId: string }): void {
    const nextState = normalizePiSessionState({
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
    });

    if (this.piSessionFile === nextState.sessionFile && this.piSessionId === nextState.sessionId) {
      return;
    }

    this.applyPiSessionState(nextState, { backend: "systemsculpt" });

    if (this.chatId && this.isFullyLoaded) {
      void this.saveChat();
    }
  }

  public async setSelectedModelId(modelId: string): Promise<void> {
    const requestedModelId = ensureCanonicalId(modelId);
    const canonicalId = isManagedSystemSculptModelId(requestedModelId)
      ? requestedModelId
      : getManagedSystemSculptModelId();

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
        await this.plugin.getSettingsManager().updateSettings({
          activeProvider: {
            id: model.provider,
            name: resolveProviderLabel(model.sourceProviderId || model.provider),
            type: "native",
          }
        });
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
      await this.syncPiSessionName(newTitle);
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
