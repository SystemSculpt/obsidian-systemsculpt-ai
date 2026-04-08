import { App, TFile, Component, Notice, ButtonComponent } from "obsidian";
import {
  ChatMessage,
  ChatRole,
  Annotation,
  UrlCitation,
} from "../../types";
import { ToolCall } from "../../types/toolCalls";
import { SystemSculptService } from "../../services/SystemSculptService";
import { SystemSculptError } from "../../utils/errors";
import { ScrollManagerService } from "./ScrollManagerService";
import { MessageRenderer } from "../chatview/MessageRenderer";
import { RecorderService } from "../../services/RecorderService";
import type SystemSculptPlugin from "../../main";
import { validateBrowserFileSize } from "../../utils/FileValidator";
import { MessagePart } from "../../types";
import { SlashCommandMenu, SlashCommand } from "./SlashCommandMenu";
import { StreamingController, type StreamTurnResult } from "./controllers/StreamingController";
import { messageHandling } from "./messageHandling";
import { AtMentionMenu } from "../../components/AtMentionMenu";
import { LARGE_TEXT_THRESHOLDS, LARGE_TEXT_MESSAGES, LargeTextHelpers } from "../../constants/largeText";
import { ERROR_CODES } from "../../utils/errors";
import { showPopup } from "../../core/ui/";

import { createChatComposer } from "./ui/createInputUI";
import {
  getEffectiveChatModelId,
  type ChatModelSetupPromptOverrides,
} from "./modelSelection";
import { renderContextAttachmentPill } from "./ui/ContextAttachmentPills";
import { handlePaste as handlePasteExternal, handleLargeTextPaste as handleLargeTextPasteExternal, showLargeTextWarning as showLargeTextWarningExternal } from "./handlers/LargePasteHandlers";
import { handleKeyDown as handleKeyDownExternal, handleInputChange as handleInputChangeExternal } from "./handlers/UIKeyHandlers";
import { createAssistantMessageContainer as createAssistantMessageContainerExternal, getStatusIndicator as getStatusIndicatorExternal, addMessageToContainer as addMessageToContainerExternal, updateStreamingStatus as updateStreamingStatusExternal, hideStreamingStatus as hideStreamingStatusExternal, showStreamingStatus as showStreamingStatusExternal, setStreamingFootnote as setStreamingFootnoteExternal, clearStreamingFootnote as clearStreamingFootnoteExternal } from "./handlers/MessageElements";
import type { StreamingMetrics } from "./StreamingMetricsTracker";
import { extractAnnotationsFromResponse as extractAnnotationsFromResponseExternal } from "./handlers/Annotations";
import { handleOpenChatHistoryFile as handleOpenChatHistoryFileExternal, handleSaveChatAsNote as handleSaveChatAsNoteExternal } from "./handlers/NotesHandlers";
// Turn lifecycle handling
import { ChatTurnLifecycleController } from "./controllers/ChatTurnLifecycleController";
import { errorLogger } from "../../utils/errorLogger";
import { TOOL_LOOP_ERROR_CODE } from "../../utils/tooling";
import { extractPrimaryPathArg, requiresUserApproval } from "../../utils/toolPolicy";
import { ChatModelSelectionController } from "./ChatModelSelectionController";

export interface InputHandlerOptions {
  app: App;
  container: HTMLElement;
  aiService: SystemSculptService;
  getMessages: () => ChatMessage[];
  isChatReady: () => boolean;
  chatContainer: HTMLElement;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  onMessageSubmit: (message: ChatMessage) => Promise<void>;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  onError: (error: string | SystemSculptError) => void;
  onAddContextFile: () => void;
  onOpenChatSettings: () => void;
  plugin: SystemSculptPlugin;
  getChatMarkdown: () => Promise<string>;
  getChatTitle: () => string;
  addFileToContext: (file: TFile) => Promise<void>;
  getChatId: () => string;
  onModelChange?: (options?: { refreshOptions?: boolean }) => void;
  chatView: any; // ChatView reference for message grouping
}

export type AutomationApprovalMode = "interactive" | "auto-approve" | "deny";

export class InputHandler extends Component {
  private app: App;
  private container: HTMLElement;
  private aiService: SystemSculptService;
  private getMessages: () => ChatMessage[];
  private isChatReady: () => boolean;
  private chatContainer: HTMLElement;
  private scrollManager: ScrollManagerService;
  private messageRenderer: MessageRenderer;
  private onMessageSubmit: (message: ChatMessage) => Promise<void>;
  private persistAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onError: (error: string | SystemSculptError) => void;
  private onAddContextFile: () => void;
  private onOpenChatSettings: () => void;
  private input: HTMLTextAreaElement;
  private inputWrapper: HTMLDivElement | null = null;
  private modelSelectionController!: ChatModelSelectionController;
  private attachmentsEl: HTMLDivElement | null = null;
  private attachmentPillsByKey: Map<string, HTMLElement> = new Map();
  private isGenerating = false;
  private webSearchEnabled = false;
  private agentModeEnabled: boolean;
  private automationApprovalMode: AutomationApprovalMode = "interactive";
  private automationRequestDepth = 0;
  private renderTimeout: NodeJS.Timeout | null = null;

  /**
   * Helper method to properly set generation state and sync with scroll manager
   */
  private setGeneratingState(generating: boolean): void {
    this.isGenerating = generating;
    this.scrollManager.setGenerating(generating);
    this.updateGeneratingState();
  }

  // getValue/setValue are implemented later in the class near input helpers
  private recorderService: RecorderService;
  private plugin: SystemSculptPlugin;
  private recorderVisualizer: HTMLElement | null = null;
  private isRecording = false;
  private updateGeneratingState: () => void;
  private stopButton: ButtonComponent | null = null;
  private getChatMarkdown: () => Promise<string>;
  private getChatTitle: () => string;
  private addFileToContext: (file: TFile) => Promise<void>;
  private pendingLargeTextContent: string | null = null;
  private settingsButton: ButtonComponent;
  private attachButton: ButtonComponent;
  private micButton: ButtonComponent;
  private sendButton: ButtonComponent;
  private getChatId: () => string;
  private notifyModelChange: (options?: { refreshOptions?: boolean }) => void;
  private chatView: any;
  private slashCommandMenu?: SlashCommandMenu;
  private atMentionMenu?: AtMentionMenu;
  private agentSelectionMenu?: { isOpen?: () => boolean };
  private liveRegionEl: HTMLElement | null = null;
  private recorderToggleUnsubscribe: (() => void) | null = null;
  private localResourcesDisposed = false;

  /**
   * A debounced handle used for throttling disk writes while streaming. Every
   * time a chunk arrives we schedule a save 1 s in the future; additional
   * chunks reset the timer.  When the timer fires we persist the chat using
   * the normal saveChat() pathway (now safe because isFullyLoaded is true).
   */

  // ───────────────────────── Streaming controller ──────────────────────────
  private streamingController: StreamingController;
  private turnLifecycle: ChatTurnLifecycleController;

  constructor(options: InputHandlerOptions) {
    super();
    this.app = options.app;
    this.container = options.container;
    this.aiService = options.aiService;
    this.getMessages = options.getMessages;
    this.isChatReady = options.isChatReady;
    this.chatContainer = options.chatContainer;
    this.scrollManager = options.scrollManager;
    this.messageRenderer = options.messageRenderer;
    this.onMessageSubmit = options.onMessageSubmit;
    this.persistAssistantResponse = options.onAssistantResponse;
    this.onAssistantResponse = options.onAssistantResponse;
    this.onError = options.onError;
    this.onAddContextFile = options.onAddContextFile;
    this.onOpenChatSettings = options.onOpenChatSettings;
    this.plugin = options.plugin;
    // Provide light wrappers for external callers to read/write input
    this.getValue = () => this.input?.value ?? "";
    this.setValue = (text: string) => { if (this.input) { this.input.value = text; this.adjustInputHeight(); } };
    this.getChatMarkdown = options.getChatMarkdown;
    this.getChatTitle = options.getChatTitle;
    this.addFileToContext = options.addFileToContext;
    this.getChatId = options.getChatId;
    this.notifyModelChange = options.onModelChange || (() => {});
    this.chatView = options.chatView;
    this.agentModeEnabled = this.plugin.settings.agentModeEnabled ?? true;
    this.modelSelectionController = new ChatModelSelectionController({
      app: this.app,
      container: this.container,
      plugin: this.plugin,
      getSelectedModelId: () => this.getSelectedModelIdForChat(),
      getSelectedModelRecord: async () => await this.getSelectedModelRecordForChat(),
      isAutomationRequestActive: () => this.isAutomationRequestActive(),
      setSelectedModelId: async (value: string) => {
        await this.chatView?.setSelectedModelId?.(value);
      },
      promptProviderSetup: async (message, overrides) => {
        if (typeof this.chatView?.promptProviderSetup !== "function") {
          return false;
        }
        await this.chatView.promptProviderSetup(message, overrides);
        return true;
      },
    });
    this.addChild(this.modelSelectionController);

    // InputHandler initialized with RecorderService - silent setup
    this.recorderService = RecorderService.getInstance(this.app, this.plugin, {
      onTranscriptionComplete: (text: string) => {
        this.insertTextAtCursor(text);

        // Auto-submit if enabled
        if (this.plugin.settings.autoSubmitAfterTranscription) {
          // Use a small delay to ensure text is fully inserted before submitting
          setTimeout(() => {
            this.handleSendMessage();
          }, 100);
        }
      },
    });

    // Simplify message handlers
    const originalMessageSubmit = options.onMessageSubmit;
    this.onMessageSubmit = async (message: ChatMessage) => {
      await originalMessageSubmit(message);
      try {
        this.scrollManager.requestStickToBottom('user-message', { immediate: true });
      } catch {}
    };

    this.onAssistantResponse = async (message: ChatMessage) => {
      await this.persistAssistantResponse(message);
      await this.renderPersistedAssistantMessage(message);
    };

    this.setupInput();
    this.initializeSlashCommands();
    this.initializeAtMentionMenu();

    // ----------------------------------------------------------------------
    // Extracted streaming logic controller
    // ----------------------------------------------------------------------
    this.streamingController = new StreamingController({
      scrollManager: this.scrollManager,
      messageRenderer: this.messageRenderer,
      saveChat: this.saveChatImmediate.bind(this),
      autosaveDebounceMs: 600,
      generateMessageId: this.generateMessageId.bind(this),
      extractAnnotations: this.extractAnnotationsFromResponse.bind(this),
      showStreamingStatus: this.showStreamingStatus.bind(this),
      hideStreamingStatus: this.hideStreamingStatus.bind(this),
      updateStreamingStatus: this.updateStreamingStatus.bind(this),
      toggleStopButton: this.toggleStopButton.bind(this),
      onAssistantResponse: this.onAssistantResponse,
      onError: this.onError,
      setStreamingFootnote: this.setStreamingFootnote.bind(this),
      clearStreamingFootnote: this.clearStreamingFootnote.bind(this),
    });
    this.addChild(this.streamingController);

    this.turnLifecycle = new ChatTurnLifecycleController({
      getIsGenerating: () => this.isGenerating,
      setGenerating: (generating) => this.setGeneratingState(generating),
    });
  }

  private getSelectedModelIdForChat(): string {
    const selectedModelId =
      typeof this.chatView?.getSelectedModelId === "function"
        ? this.chatView.getSelectedModelId()
        : this.chatView?.selectedModelId || this.plugin.settings.selectedModelId || "";
    return getEffectiveChatModelId(selectedModelId, this.plugin.settings.selectedModelId);
  }

  private async getSelectedModelRecordForChat() {
    if (typeof this.chatView?.getSelectedModelRecord === "function") {
      return await this.chatView.getSelectedModelRecord();
    }

    const modelId = this.getSelectedModelIdForChat();
    return await this.plugin.modelService?.getModelById?.(modelId);
  }

  private async streamAssistantTurn(
    signal: AbortSignal,
    includeContextFiles: boolean
  ): Promise<StreamTurnResult> {
    const continuationTarget = this.getHostedContinuationTarget();
    const { messageEl } = continuationTarget ?? this.createAssistantMessageContainer();
    let messageId = continuationTarget?.messageId || messageEl.dataset.messageId;
    if (!messageId || messageId.trim().length === 0) {
      messageId = this.generateMessageId();
      messageEl.dataset.messageId = messageId;
    } else if (!messageEl.dataset.messageId || messageEl.dataset.messageId.trim().length === 0) {
      messageEl.dataset.messageId = messageId;
    }

    const contextFiles = includeContextFiles ? this.chatView.contextManager.getContextFiles() : new Set<string>();
    const selectedModelId = this.getSelectedModelIdForChat();
    const stream = this.aiService.streamMessage({
      messages: this.getMessages(),
      model: selectedModelId,
      contextFiles,
      signal,
        sessionFile: this.chatView?.getPiSessionFile?.(),
        sessionId: this.chatView?.getPiSessionId?.(),
        onPiSessionReady: (session) => {
          this.chatView?.setPiSessionState?.(session);
        },
        webSearchEnabled: this.webSearchEnabled,
      debug: this.chatView.getDebugLogService?.()?.createStreamLogger({
        chatId: this.getChatId(),
        assistantMessageId: messageId,
        modelId: selectedModelId,
      }) || undefined,
    });

    return await this.streamingController.stream(
      stream,
      messageEl,
      messageId,
      signal,
      continuationTarget?.seedParts
    );
  }

  private getHostedContinuationTarget():
    | { messageEl: HTMLElement; messageId: string; seedParts: MessagePart[] }
    | null {
    const messages = this.getMessages();
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!lastMessage || lastMessage.role !== "assistant") {
      return null;
    }

    const messageId = String(lastMessage.message_id || "").trim();
    if (!messageId) {
      return null;
    }

    const messageEl = this.findRenderedMessageElement(messageId);
    if (!messageEl) {
      return null;
    }

    const normalizedParts = this.messageRenderer.normalizeMessageToParts(lastMessage);
    return {
      messageEl,
      messageId,
      seedParts: Array.isArray(normalizedParts?.parts) ? normalizedParts.parts : [],
    };
  }

  private findRenderedMessageElement(messageId: string): HTMLElement | null {
    const renderedMessages = Array.from(
      this.chatContainer.querySelectorAll<HTMLElement>(".systemsculpt-message")
    );
    return renderedMessages.find((messageEl) => messageEl.dataset.messageId === messageId) ?? null;
  }

  private shouldContinueHostedToolLoop(message: ChatMessage, _stopReason?: string): boolean {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      return false;
    }

    return toolCalls.some(
      (toolCall) =>
        toolCall.state !== "completed" &&
        toolCall.state !== "failed" &&
        (toolCall.state === "executing" || !toolCall.result)
    );
  }

  private async renderPersistedAssistantMessage(
    message: ChatMessage,
    options?: { forceRerender?: boolean }
  ): Promise<void> {
    const shouldSkipPiPostPersistRerender =
      !options?.forceRerender &&
      !!this.chatView?.isPiBackedChat?.() &&
      !!this.chatView?.getPiSessionFile?.();

    const currentMessageEl = this.chatContainer.querySelector(`.systemsculpt-message[data-message-id="${message.message_id}"]`) as HTMLElement | null;
    if (currentMessageEl) {
      try {
        if (shouldSkipPiPostPersistRerender) {
          if (!currentMessageEl.querySelector(".systemsculpt-message-toolbar")) {
            this.messageRenderer.addMessageButtonToolbar(
              currentMessageEl,
              typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
              message.role,
              message.message_id
            );
          }
          return;
        }

        this.messageRenderer.renderUnifiedMessageParts(
          currentMessageEl,
          this.messageRenderer.normalizeMessageToParts(message).parts,
          false
        );

        if (!currentMessageEl.querySelector(".systemsculpt-message-toolbar")) {
          this.messageRenderer.addMessageButtonToolbar(
            currentMessageEl,
            typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
            message.role,
            message.message_id
          );
        }
        return;
      } catch {
        // Fall back to the full message reload path below if an in-place update fails.
      }
    }

    if (shouldSkipPiPostPersistRerender) {
      return;
    }

    await messageHandling.addMessage(this.chatView, message.role, message.content, message.message_id, message);
  }

  private async persistAssistantToolLoopUpdate(message: ChatMessage): Promise<void> {
    if (typeof this.chatView?.persistAssistantMessage === "function") {
      await this.chatView.persistAssistantMessage(message, { syncPiTranscript: false });
    } else {
      await this.persistAssistantResponse(message);
    }
    await this.renderPersistedAssistantMessage(message, { forceRerender: true });
  }

  private async confirmHostedToolExecution(toolCall: ToolCall): Promise<boolean> {
    const functionName = String(toolCall.request?.function?.name || "").trim();
    if (!requiresUserApproval(functionName, { trustedToolNames: new Set() })) {
      return true;
    }

    if (this.automationApprovalMode === "auto-approve") {
      return true;
    }

    if (this.automationApprovalMode === "deny") {
      return false;
    }

    let parsedArgs: Record<string, unknown> = {};
    const rawArguments = toolCall.request?.function?.arguments;
    if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(rawArguments);
      } catch {
        parsedArgs = {};
      }
    }

    const primaryPath = extractPrimaryPathArg(functionName, parsedArgs);
    const popup = await showPopup(
      this.app,
      primaryPath
        ? `${functionName} wants to modify ${primaryPath}.`
        : `${functionName} wants to modify your vault.`,
      {
        title: "Approve Tool Action",
        description: "Allow this hosted SystemSculpt tool call to continue in your local vault.",
        primaryButton: "Approve",
        secondaryButton: "Deny",
      }
    );

    return popup?.confirmed === true && popup.action === "primary";
  }

  private async executeHostedToolCalls(message: ChatMessage, signal: AbortSignal): Promise<ChatMessage> {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      return message;
    }

    for (const toolCall of toolCalls) {
      if (signal.aborted) {
        break;
      }
      if (toolCall.state === "completed" || toolCall.state === "failed") {
        continue;
      }

      toolCall.state = "executing";
      toolCall.executionStartedAt = toolCall.executionStartedAt || Date.now();

      const approved = await this.confirmHostedToolExecution(toolCall);
      if (!approved) {
        toolCall.state = "failed";
        toolCall.executionCompletedAt = Date.now();
        toolCall.result = {
          success: false,
          error: {
            code: "USER_DENIED",
            message: "The user denied this tool execution.",
          },
        };
        continue;
      }

      const result = await this.aiService.executeHostedToolCall({
        toolCall,
        chatView: this.chatView,
      });

      toolCall.result = result;
      toolCall.executionCompletedAt = Date.now();
      toolCall.state = result.success ? "completed" : "failed";
    }

    return message;
  }

  private failHostedToolTurn(message: string, statusCode: number, metadata?: Record<string, unknown>): never {
    const error = new SystemSculptError(
      message,
      ERROR_CODES.STREAM_ERROR,
      statusCode,
      {
        errorCode: TOOL_LOOP_ERROR_CODE,
        ...metadata,
      }
    );

    try {
      this.onError(error);
    } catch {}

    throw error;
  }

  private async runHostedAgentTurnLoop(signal: AbortSignal, includeContextFiles: boolean): Promise<void> {
    const maxToolContinuationRounds = 8;
    const maxEmptyContinuationRetries = 3;
    let completedToolContinuationRounds = 0;
    let emptyContinuationRetries = 0;
    let hasExecutedHostedToolRound = false;

    while (completedToolContinuationRounds < maxToolContinuationRounds) {
      const streamedTurn = await this.streamAssistantTurn(signal, includeContextFiles);
      if (streamedTurn.completionState === "aborted") {
        return;
      }

      if (streamedTurn.completionState === "empty") {
        if (hasExecutedHostedToolRound && emptyContinuationRetries < maxEmptyContinuationRetries) {
          emptyContinuationRetries += 1;
          try {
            errorLogger.debug("Retrying empty hosted continuation round", {
              source: "InputHandler",
              method: "runHostedAgentTurnLoop",
              metadata: {
                retryAttempt: emptyContinuationRetries,
                maxEmptyContinuationRetries,
                chatId: this.getChatId(),
              },
            });
          } catch {}
          continue;
        }

        this.failHostedToolTurn(
          hasExecutedHostedToolRound
            ? "The hosted agent returned an empty continuation after tool execution."
            : "The hosted agent returned an empty response.",
          502,
          {
            reason: hasExecutedHostedToolRound ? "empty-continuation" : "empty-response",
            emptyContinuationRetries,
          }
        );
      }

      emptyContinuationRetries = 0;
      if (!this.shouldContinueHostedToolLoop(streamedTurn.message, streamedTurn.stopReason)) {
        return;
      }

      const executedMessage = await this.executeHostedToolCalls(streamedTurn.message, signal);
      await this.persistAssistantToolLoopUpdate(executedMessage);
      hasExecutedHostedToolRound = true;
      completedToolContinuationRounds += 1;
    }

    this.failHostedToolTurn(
      "The hosted agent exceeded the maximum tool continuation depth.",
      500,
      {
        reason: "max-tool-continuation-depth",
        maxToolContinuationRounds,
      }
    );
  }

  private setupInput(): void {
    // Create an aria-live region for streaming status updates (a11y)
    if (!this.liveRegionEl) {
      this.liveRegionEl = this.container.createEl("div", {
        cls: "systemsculpt-visually-hidden",
        attr: { "aria-live": "polite", "aria-atomic": "true" },
      });
    }

    const composer = createChatComposer(this.container, {
      onOpenChatSettings: this.onOpenChatSettings,
      onAddContextFile: this.onAddContextFile,
      onSend: () => this.handleSendMessage(),
      onStop: () => this.handleStopGeneration(),
      registerDomEvent: this.registerDomEvent.bind(this),
      onKeyDown: (e) => this.handleKeyDown(e),
      onInput: () => this.handleInputChange(),
      onPaste: (e) => this.handlePaste(e),
      handleMicClick: () => this.handleMicClick(),
      hasProLicense: () => !!(this.plugin.settings.licenseKey?.trim() && this.plugin.settings.licenseValid),
      onToggleWebSearch: () => { this.webSearchEnabled = !this.webSearchEnabled; },
      isWebSearchEnabled: () => this.webSearchEnabled,
      onToggleAgentMode: () => { this.agentModeEnabled = !this.agentModeEnabled; },
      isAgentModeEnabled: () => this.agentModeEnabled,
    });

    this.input = composer.input;
    this.inputWrapper = composer.inputWrap;
    this.attachmentsEl = composer.attachments;
    this.micButton = composer.micButton;
    this.sendButton = composer.sendButton;
    this.stopButton = composer.stopButton;
    this.settingsButton = composer.settingsButton;
    this.attachButton = composer.attachButton;
    this.modelSelectionController.ensureHost({
      modelSlot: (composer as any).modelSlot,
      toolbar: (composer as any).toolbar,
    });
    this.modelSelectionController.render();

    // Initialize states that depend on runtime conditions
    this.updateSendButtonState();
    this.renderContextAttachments();

    const onContextChanged = () => {
      this.renderContextAttachments();
    };
    document.addEventListener("systemsculpt:context-changed", onContextChanged as any);
    document.addEventListener("systemsculpt:context-processing-changed", onContextChanged as any);
    this.register(() => {
      document.removeEventListener("systemsculpt:context-changed", onContextChanged as any);
      document.removeEventListener("systemsculpt:context-processing-changed", onContextChanged as any);
    });

    // Recorder handling with visual feedback
    this.recorderToggleUnsubscribe?.();
    this.recorderToggleUnsubscribe = this.recorderService.onToggle((isRecording: boolean) => {
      this.isRecording = isRecording;

      // Update the mic button state
      if (this.micButton && this.micButton.buttonEl) {
        // Add/remove the ss-active class to trigger the pulse animation
        this.micButton.buttonEl.classList.toggle("ss-active", isRecording);

        // Update the tooltip based on recording state
        if (isRecording) {
          this.micButton.setTooltip("Recording in progress (click to stop)");
        } else {
          this.micButton.setTooltip("Record audio message");
        }
      }
    });

    // Update UI when generating state changes
    this.updateGeneratingState = () => {
      // Keep input enabled to allow typing next message
      this.input.disabled = false;
      
      // Keep most controls enabled - they only affect future messages, not current generation
      this.settingsButton.setDisabled(false); // Settings changes only affect next message
      this.attachButton.setDisabled(false); // Users can add context for their next message
      this.micButton.setDisabled(!this.hasProLicense()); // Voice input just adds text to input field
      // Note: Save As Note functionality moved to slash command menu
      
      if (this.stopButton) {
        this.stopButton.setDisabled(!this.isGenerating);
        this.stopButton.buttonEl.style.display = this.isGenerating ? "flex" : "none";
        // Reduce clutter: show Stop while generating, Send otherwise
        this.sendButton.buttonEl.style.display = this.isGenerating ? "none" : "flex";
      }

      this.input.placeholder = this.isGenerating
        ? "Type your next message…"
        : "Write a message…";

      // Remove visual disabled state since input stays enabled
      this.input.classList.remove("disabled");

      this.updateSendButtonState();
      this.scrollManager.setGenerating(this.isGenerating);
    };

    this.registerEvent(
      this.app.workspace.on("systemsculpt:settings-updated", () => {
        this.updateGeneratingState();
        this.onModelChange({ refreshOptions: true });
      })
    );
  }

  private initializeSlashCommands(): void {
    this.slashCommandMenu = new SlashCommandMenu({
      plugin: this.plugin,
      chatView: this.chatView,
      inputElement: this.input,
      inputHandler: this,
      onClose: () => {
        // Re-focus the input when slash menu closes
        this.input.focus();
      },
      onExecute: async (command: SlashCommand) => {
        // Clear the slash command from input
        const currentValue = this.input.value;
        const slashIndex = currentValue.lastIndexOf('/');
        if (slashIndex !== -1) {
          this.input.value = currentValue.substring(0, slashIndex);
        }
        
        // Execute the command
        await command.execute(this.chatView);
      }
    });
    
    this.addChild(this.slashCommandMenu);
  }

  private initializeAtMentionMenu(): void {
    this.atMentionMenu = new AtMentionMenu(this.chatView, this.input);
    this.addChild(this.atMentionMenu);
  }

  private handleStopGeneration(): void {
    this.turnLifecycle.stop();

    // Don't force scroll when user stops generation - respect their current position
    // this.scrollManager.resetScrollState();
  }

  private async handleSendMessage(overrides?: {
    includeContextFiles?: boolean;
    focusAfterSend?: boolean;
    rethrowErrors?: boolean;
  }): Promise<void> {
    let messageText: string = this.input.value.trim();
    if (!messageText) return;

    // Replace placeholder with actual large text content if present
    if (this.pendingLargeTextContent && LargeTextHelpers.containsPlaceholder(messageText)) {
      const placeholderRegex = /\[PASTED TEXT - \d+ LINES OF TEXT\]/g;
      messageText = messageText.replace(placeholderRegex, this.pendingLargeTextContent);
      this.pendingLargeTextContent = null;
    }

    if (!this.isChatReady()) {
      new Notice("Chat is still loading—please wait a moment.");
      return;
    }

    if (this.chatView?.isLegacyReadOnlyChat?.()) {
      new Notice("This archived chat is read-only. Open a new chat to continue the conversation.", 6000);
      return;
    }

    if (!(await this.ensureProviderReadyForChat())) {
      return;
    }

    const includeContextFiles = overrides?.includeContextFiles ?? true;

    try {
      await this.turnLifecycle.runTurn(async (signal) => {
        this.input.value = "";
        this.adjustInputHeight();

        const userMessage: ChatMessage = {
          role: "user",
          content: messageText,
          message_id: this.generateMessageId(),
        } as any;
        await this.onMessageSubmit(userMessage);

        await this.runHostedAgentTurnLoop(signal, includeContextFiles);
        void this.chatView.refreshCreditsBalance();
      });
    } catch (err) {
      // StreamingController already forwards errors into ChatView.handleError via onError.
      // Swallow here to avoid "Uncaught (in promise)" in the Obsidian console.
      if (!(err instanceof SystemSculptError)) {
        try {
          this.onError(err as any);
        } catch {}
      }
      try {
        errorLogger.debug("Chat turn failed", {
          source: "InputHandler",
          method: "handleSendMessage",
          metadata: { modelId: this.getSelectedModelIdForChat() },
        });
      } catch {}

      if (overrides?.rethrowErrors) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(String(err ?? "Unknown chat turn failure"));
      }
    } finally {
      if (overrides?.focusAfterSend !== false) {
        this.focus();
      }
      await this.chatView.contextManager.validateAndCleanContextFiles();
    }
  }

  public async submitWithOverrides(overrides: { includeContextFiles?: boolean }): Promise<void> {
    await this.handleSendMessage(overrides);
  }

  public async submitForAutomation(options?: {
    includeContextFiles?: boolean;
    approvalMode?: AutomationApprovalMode;
    focusAfterSend?: boolean;
  }): Promise<void> {
    const previousApprovalMode = this.automationApprovalMode;
    this.automationRequestDepth += 1;
    if (options?.approvalMode) {
      this.automationApprovalMode = options.approvalMode;
    }

    try {
      await this.handleSendMessage({
        includeContextFiles: options?.includeContextFiles,
        focusAfterSend: options?.focusAfterSend,
        rethrowErrors: true,
      });
    } finally {
      this.automationApprovalMode = previousApprovalMode;
      this.automationRequestDepth = Math.max(0, this.automationRequestDepth - 1);
    }
  }

  public isAutomationRequestActive(): boolean {
    return this.automationRequestDepth > 0;
  }

  private handleMicClick(): void {
    this.toggleRecording();
  }

  private async toggleRecording(): Promise<void> {
    await this.recorderService.toggleRecording();

    // The button state is handled by the onToggle callback registered earlier
    // so we don't need to manually update the button state here

    // Keep focus/cursor in chat
    this.input.focus();
  }

  private async handlePaste(e: ClipboardEvent): Promise<void> {
    return handlePasteExternal({
      app: this.app,
      plugin: this.plugin,
      addFileToContext: this.addFileToContext,
      insertTextAtCursor: (t: string) => this.insertTextAtCursor(t),
      getPendingLargeTextContent: () => this.pendingLargeTextContent,
      setPendingLargeTextContent: (t: string | null) => { this.pendingLargeTextContent = t; },
    }, e);
  }

  /**
   * Show warning dialog for large text pastes
   */
  private async showLargeTextWarning(sizeKB: number, text: string): Promise<boolean> {
    return showLargeTextWarningExternal({
      app: this.app,
      plugin: this.plugin,
      addFileToContext: this.addFileToContext,
      insertTextAtCursor: (t: string) => this.insertTextAtCursor(t),
      getPendingLargeTextContent: () => this.pendingLargeTextContent,
      setPendingLargeTextContent: (t: string | null) => { this.pendingLargeTextContent = t; },
    }, sizeKB, text);
  }

  /**
   * Handle large text paste with chunking to prevent UI freeze
   */
  private async handleLargeTextPaste(text: string): Promise<void> {
    return handleLargeTextPasteExternal({
      app: this.app,
      plugin: this.plugin,
      addFileToContext: this.addFileToContext,
      insertTextAtCursor: (t: string) => this.insertTextAtCursor(t),
      getPendingLargeTextContent: () => this.pendingLargeTextContent,
      setPendingLargeTextContent: (t: string | null) => { this.pendingLargeTextContent = t; },
    }, text);
  }

  private async handleKeyDown(event: KeyboardEvent): Promise<void> {
    return handleKeyDownExternal({
      isChatReady: () => this.isChatReady(),
      isGenerating: () => this.isGenerating,
      handleSendMessage: () => this.handleSendMessage(),
      handleStopGeneration: () => this.handleStopGeneration(),
      input: this.input,
      slashCommandMenu: this.slashCommandMenu,
      atMentionMenu: this.atMentionMenu,
    }, event);
  }

  private handleInputChange(): void {
    const result = handleInputChangeExternal({
      input: this.input,
      adjustInputHeight: () => this.adjustInputHeight(),
      slashCommandMenu: this.slashCommandMenu,
      atMentionMenu: this.atMentionMenu,
      setPendingLargeTextContent: (t: string | null) => { this.pendingLargeTextContent = t; },
    });
    this.updateSendButtonState();
    return result as any;
  }

  private adjustInputHeight(): void {
    if (!this.input) return;

    this.input.style.height = "auto";
    const newHeight = Math.min(Math.max(this.input.scrollHeight, 48), 200); // Min 48px, max 200px
    this.input.style.height = newHeight + "px";
  }

  private hasProLicense(): boolean {
    return !!(this.plugin.settings.licenseKey?.trim() && this.plugin.settings.licenseValid);
  }

  private updateSendButtonState(): void {
    const hasText = this.input.value.trim().length > 0;
    this.sendButton.setDisabled(this.isGenerating || !hasText || !this.isChatReady());
  }

  public notifyChatReadyChanged(): void {
    this.updateSendButtonState();
  }

  public refreshContextAttachments(): void {
    this.renderContextAttachments();
  }

  private renderContextAttachments(): void {
    if (!this.attachmentsEl || !this.chatView?.contextManager) {
      return;
    }

    const contextManager = this.chatView.contextManager as {
      getContextFiles: () => Set<string>;
      removeFromContextFiles: (path: string) => Promise<boolean>;
      getProcessingEntries?: () => Array<{ key: string; file: TFile; event: any; updatedAt: number }>;
      dismissProcessingStatus?: (filePath: string) => void;
    };

    const files = Array.from(contextManager.getContextFiles()).filter((v): v is string => typeof v === "string");
    const processing = contextManager.getProcessingEntries ? contextManager.getProcessingEntries() : [];

    const items: Array<
      | { kind: "file"; key: string; wikiLink: string }
      | { kind: "processing"; key: string; processingKey: string; file: TFile; event: any }
    > = [];

    for (const wikiLink of files) {
      items.push({ kind: "file", key: wikiLink, wikiLink });
    }

    for (const entry of processing) {
      items.push({
        kind: "processing",
        key: `processing:${entry.key}`,
        processingKey: entry.key,
        file: entry.file,
        event: entry.event,
      });
    }

    const desiredKeys = new Set(items.map((item) => item.key));
    for (const [key, el] of this.attachmentPillsByKey) {
      if (!desiredKeys.has(key)) {
        el.remove();
        this.attachmentPillsByKey.delete(key);
      }
    }

    if (items.length === 0) {
      this.attachmentsEl.style.display = "none";
      return;
    }

    this.attachmentsEl.style.display = "flex";

    for (const item of items) {
      let pill = this.attachmentPillsByKey.get(item.key);
      if (!pill) {
        pill = this.attachmentsEl.createDiv();
        pill.addEventListener("click", this.handleAttachmentPillClick);
        pill.addEventListener("keydown", this.handleAttachmentPillKeydown);
        this.attachmentPillsByKey.set(item.key, pill);
      }

      if (item.kind === "processing") {
        const progress = Number.isFinite(item.event?.progress) ? Math.round(item.event.progress) : 0;
        const label = typeof item.event?.label === "string" ? item.event.label : "Processing…";
        const ext = item.file.extension?.toLowerCase?.() || "";
        const iconName =
          ["png", "jpg", "jpeg", "webp", "svg"].includes(ext)
            ? "image"
            : ["mp3", "wav", "ogg", "m4a", "webm"].includes(ext)
              ? "file-audio"
              : "file-text";
        const statusIcon = typeof item.event?.icon === "string" && item.event.icon.length > 0 ? item.event.icon : "loader-2";
        renderContextAttachmentPill(pill, {
          kind: "processing",
          processingKey: item.processingKey,
          linkText: item.file.path,
          label: item.file.basename,
          icon: iconName,
          title: `${item.file.path} — ${label}${Number.isFinite(progress) ? ` (${progress}%)` : ""}`,
          statusIcon,
          spinning: item.event?.stage !== "ready" && item.event?.stage !== "error",
          removeAriaLabel: "Dismiss processing status",
        });
      } else {
        const linkText = item.wikiLink.replace(/^\[\[(.*?)\]\]$/, "$1");
        const resolved = this.app.metadataCache.getFirstLinkpathDest(linkText, "") ?? this.app.vault.getAbstractFileByPath(linkText);
        const label = resolved instanceof TFile ? resolved.basename : linkText.split("/").pop() || linkText;
        const iconName =
          resolved instanceof TFile
            ? ["png", "jpg", "jpeg", "webp", "svg"].includes(resolved.extension.toLowerCase())
              ? "image"
              : ["mp3", "wav", "ogg", "m4a", "webm"].includes(resolved.extension.toLowerCase())
                ? "file-audio"
                : "file-text"
            : "file-text";
        renderContextAttachmentPill(pill, {
          kind: "file",
          wikiLink: item.wikiLink,
          linkText,
          label,
          icon: iconName,
          title: linkText,
          removeAriaLabel: "Remove file from context",
        });
      }

      this.attachmentsEl.appendChild(pill);
    }
  }

  private handleAttachmentPillClick = (event: MouseEvent) => {
    const pill = event.currentTarget as HTMLElement | null;
    if (!pill || !this.chatView?.contextManager) return;

    const contextManager = this.chatView.contextManager as any;
    const kind = pill.dataset.kind;

    const clickedRemove = (event.target as HTMLElement | null)?.closest?.(".systemsculpt-attachment-pill-remove");
    if (clickedRemove) {
      if (kind === "file") {
        const wikiLink = pill.dataset.wikiLink;
        if (wikiLink) void contextManager.removeFromContextFiles(wikiLink);
      } else if (kind === "processing") {
        const key = pill.dataset.processingKey;
        if (key) contextManager.dismissProcessingStatus?.(key);
      }
      return;
    }

    const linkText = pill.dataset.linkText;
    if (linkText) {
      this.app.workspace.openLinkText(linkText, "", true);
    }
  };

  private handleAttachmentPillKeydown = (event: KeyboardEvent) => {
    const pill = event.currentTarget as HTMLElement | null;
    if (!pill || !this.chatView?.contextManager) return;

    const contextManager = this.chatView.contextManager as any;
    const kind = pill.dataset.kind;

    if ((event.target as HTMLElement | null)?.closest?.(".systemsculpt-attachment-pill-remove")) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const linkText = pill.dataset.linkText;
      if (linkText) {
        this.app.workspace.openLinkText(linkText, "", true);
      }
      return;
    }
  };

  public focus(): void {
    this.input.focus();
  }

	  public getDebugState(): {
	    value: string;
	    placeholder: string | null;
	    disabled: boolean;
	    selectionStart: number | null;
	    selectionEnd: number | null;
	    isGenerating: boolean;
	    pendingLargeTextContent: string | null;
	    pendingLargeTextContentLength: number | null;
	    attachments: Array<{
	      key: string;
      text: string;
      dataset: Record<string, string | null>;
      html: string;
    }>;
    attachmentCount: number;
    attachmentsHtml: string | null;
    inputWrapperHtml: string | null;
    inputHtml: string;
	    buttons: {
      send: {
        text: string;
        tooltip: string | null;
        disabled: boolean;
        display: string | null;
        classList: string[];
      } | null;
      stop: {
        text: string;
        tooltip: string | null;
        disabled: boolean;
        display: string | null;
        classList: string[];
	      } | null;
		      mic: {
		        text: string;
		        tooltip: string | null;
		        disabled: boolean;
	        display: string | null;
	        classList: string[];
	      } | null;
	      attach: {
	        text: string;
	        tooltip: string | null;
        disabled: boolean;
        display: string | null;
        classList: string[];
      } | null;
      settings: {
        text: string;
        tooltip: string | null;
        disabled: boolean;
        display: string | null;
        classList: string[];
      } | null;
    };
    menus: {
      slashCommandMenuOpen: boolean | null;
      atMentionMenuOpen: boolean | null;
      agentSelectionMenuOpen: boolean | null;
    };
	    recorder: {
	      isRecording: boolean;
	    };
	  } {
    const describeButton = (button: ButtonComponent | null | undefined) => {
      const el = button?.buttonEl;
      if (!el) return null;
      const disabled = (el as HTMLButtonElement).disabled ?? el.hasAttribute?.("disabled");
      return {
        text: el.textContent ?? "",
        tooltip: el.getAttribute("aria-label") ?? el.getAttribute("data-tooltip"),
        disabled: Boolean(disabled),
        display: el.style?.display || null,
        classList: Array.from(el.classList),
      };
    };

    const attachments = Array.from(this.attachmentPillsByKey.entries()).map(([key, el]) => {
      const dataset: Record<string, string | null> = {};
      Object.keys(el.dataset || {}).forEach((datasetKey) => {
        dataset[datasetKey] = el.dataset[datasetKey] ?? null;
      });
      return {
        key,
        text: el.textContent ?? "",
        dataset,
        html: el.outerHTML,
      };
    });

	    return {
	      value: this.input?.value ?? "",
	      placeholder: this.input?.placeholder ?? null,
	      disabled: Boolean(this.input?.disabled),
	      selectionStart: this.input?.selectionStart ?? null,
	      selectionEnd: this.input?.selectionEnd ?? null,
	      isGenerating: this.isGenerating,
	      pendingLargeTextContent: this.pendingLargeTextContent,
	      pendingLargeTextContentLength: this.pendingLargeTextContent ? this.pendingLargeTextContent.length : null,
	      attachments,
      attachmentCount: attachments.length,
      attachmentsHtml: this.attachmentsEl?.innerHTML ?? null,
      inputWrapperHtml: this.inputWrapper?.innerHTML ?? null,
      inputHtml: this.input?.outerHTML ?? "",
		      buttons: {
		        send: describeButton(this.sendButton),
		        stop: describeButton(this.stopButton),
		        mic: describeButton(this.micButton),
		        attach: describeButton(this.attachButton),
		        settings: describeButton(this.settingsButton),
		      },
      menus: {
        slashCommandMenuOpen: this.slashCommandMenu?.isOpen?.() ?? null,
        atMentionMenuOpen: this.atMentionMenu?.isOpen?.() ?? null,
        agentSelectionMenuOpen: this.agentSelectionMenu?.isOpen?.() ?? null,
      },
	      recorder: {
	        isRecording: this.isRecording,
	      },
	    };
  }

  public getValue(): string {
    return this.input.value;
  }

  public setValue(value: string, options?: { focus?: boolean }): void {
    if (!this.input) {
      return;
    }

    try {
      // Set the value directly
      this.input.value = value;

      // Trigger input event for any listeners
      const inputEvent = new Event("input", {
        bubbles: true,
        cancelable: true,
      });
      this.input.dispatchEvent(inputEvent);

      // Adjust height after value is set
      this.adjustInputHeight();

      if (options?.focus !== false) {
        // Focus the input and move cursor to end
        this.input.focus();
        this.input.setSelectionRange(value.length, value.length);
      }
    } catch (error) {
      new Notice("❌ Failed to set input value");
    }
  }

  public isWebSearchEnabled(): boolean {
    return this.webSearchEnabled;
  }

  public setWebSearchEnabled(enabled: boolean): void {
    this.webSearchEnabled = Boolean(enabled);
  }

  public getAutomationApprovalMode(): AutomationApprovalMode {
    return this.automationApprovalMode;
  }

  public setAutomationApprovalMode(mode: AutomationApprovalMode): void {
    this.automationApprovalMode = mode;
  }

  public resetForFreshChat(): void {
    this.pendingLargeTextContent = null;
    this.webSearchEnabled = false;
    this.automationApprovalMode = "interactive";
    this.setValue("", { focus: false });
  }

  private disposeLocalResources(): void {
    if (this.localResourcesDisposed) {
      return;
    }
    this.localResourcesDisposed = true;

    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }

    if (this.recorderVisualizer) {
      this.recorderVisualizer.remove();
      this.recorderVisualizer = null;
    }

    this.recorderToggleUnsubscribe?.();
    this.recorderToggleUnsubscribe = null;
    this.cleanupAllStatusIndicators();
  }

  public unload(): void {
    this.disposeLocalResources();
    super.unload();
  }

  public onunload(): void {
    this.disposeLocalResources();
  }

  private generateMessageId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Add message to appropriate container, handling visual grouping for consecutive assistant messages
   */
  private addMessageToContainer(messageEl: HTMLElement, role: ChatRole, breakGroup: boolean = false): { isNewGroup: boolean; groupContainer?: HTMLElement } {
    return addMessageToContainerExternal(this.chatContainer, messageEl, role, breakGroup);
  }

  private createAssistantMessageContainer(breakGroup: boolean = false): { messageEl: HTMLElement; contentEl: HTMLElement } {
    return createAssistantMessageContainerExternal(this.chatContainer, () => this.generateMessageId(), this.chatView, breakGroup);
  }

  /**
   * Sort message parts to ensure reasoning shows before tool calls
   */
  private sortMessageParts(parts: any[]): any[] {
    // Sort by timestamp, but reasoning (negative timestamps) will come first
    return [...parts].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Insert text at the current cursor position in the input field.
   * This also handles resizing the input field if necessary.
   */
  private insertTextAtCursor(text: string): void {
    const cursorPos = this.input.selectionStart;
    const currentValue = this.input.value;

    if (cursorPos !== null) {
      // Insert at cursor position
      const newValue =
        currentValue.slice(0, cursorPos) + text + currentValue.slice(cursorPos);
      this.input.value = newValue;
      // Move cursor to end of inserted text
      this.input.selectionStart = this.input.selectionEnd =
        cursorPos + text.length;
    } else {
      // Append to end if no cursor position
      this.input.value = currentValue + text;
      this.input.selectionStart = this.input.selectionEnd =
        this.input.value.length;
    }

    // Trigger input event for height adjustment
    this.input.dispatchEvent(new Event("input"));

    // Focus the input after insertion
    this.input.focus();
  }

  public refreshTokenCounter(): void {
    // Token counter has been removed
  }

  public onModelChange(options?: { refreshOptions?: boolean }): void {
    this.modelSelectionController.refresh({
      reloadOptions: options?.refreshOptions,
    });
    this.notifyModelChange(options);
  }

  public async handleOpenChatHistoryFile(): Promise<void> {
    return handleOpenChatHistoryFileExternal(this as any);
  }

  public async handleSaveChatAsNote(): Promise<void> {
    return handleSaveChatAsNoteExternal(this as any);
  }

  /**
   * Sets the input text content
   * @param content The content to set in the input field
   */
  public setInputText(content: string | object, options?: { focus?: boolean }): void {
    const shouldFocus = options?.focus !== false;
    this.setValue(typeof content === "string" ? content : JSON.stringify(content), {
      focus: shouldFocus,
    });
    if (shouldFocus) {
      this.focus();
    }
  }

  /**
   * Extract annotations from the response text
   * This method parses markdown links in the format [domain](url) and extracts them as citations
   * Based on the actual OpenRouter response format observed in logs
   */
  private extractAnnotationsFromResponse(responseText: string): Annotation[] {
    return extractAnnotationsFromResponseExternal(responseText);
  }

  /**
   * Clean up any remaining status indicators to prevent memory leaks
   */
  private cleanupAllStatusIndicators(): void {
    // Clean up any status indicators that might still be in the chat container
    this.chatContainer?.querySelectorAll('.systemsculpt-streaming-status').forEach(el => {
      el.remove();
    });
  }

  /**
   * Update the streaming status indicator for a message
   */
  private updateStreamingStatus(messageEl: HTMLElement, status: string, text: string, metrics?: StreamingMetrics): void {
    updateStreamingStatusExternal(messageEl, this.liveRegionEl, status, text, metrics);
  }

  /**
   * Hide the streaming status indicator when response is complete
   */
  private hideStreamingStatus(messageEl: HTMLElement): void {
    hideStreamingStatusExternal(messageEl, this.liveRegionEl);
  }

  /**
   * Show the streaming status indicator
   */
  private showStreamingStatus(messageEl: HTMLElement): void {
    showStreamingStatusExternal(messageEl, this.liveRegionEl);
  }

  /**
   * Helper method to get the status indicator for a message
   */
  private getStatusIndicator(messageEl: HTMLElement): HTMLElement | null {
    return getStatusIndicatorExternal(messageEl);
  }

  public setStreamingFootnote(messageEl: HTMLElement, text: string): void {
    setStreamingFootnoteExternal(messageEl, text);
  }

  public clearStreamingFootnote(messageEl: HTMLElement): void {
    clearStreamingFootnoteExternal(messageEl);
  }

  private toggleStopButton(show: boolean): void {
    if (this.stopButton) {
      // StreamingController toggles this based on stream activity.
      // Never hide Stop while the handler is generating.
      const shouldShow = show || this.isGenerating;
      this.stopButton.setDisabled(!shouldShow);
      this.stopButton.buttonEl.style.display = shouldShow ? "flex" : "none";
    }
  }

  private async saveChatImmediate(): Promise<void> {
    if (!this.chatView?.isFullyLoaded) {
      return;
    }
    try {
      await this.chatView.saveChat();
    } catch (e) {
      errorLogger.error("Chat save failed", e as Error, {
        source: "InputHandler",
        method: "saveChatImmediate",
      });
    }
  }

  private async ensureProviderReadyForChat(): Promise<boolean> {
    return await this.modelSelectionController.ensureProviderReadyForChat();
  }

  private async invokeProviderSetupPrompt(
    message?: string,
    overrides?: ChatModelSetupPromptOverrides
  ): Promise<void> {
    await this.modelSelectionController.invokeProviderSetupPrompt(message, overrides);
  }
}
