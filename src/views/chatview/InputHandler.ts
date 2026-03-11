import { App, TFile, Component, Notice, Modal, Setting, ButtonComponent, Platform } from "obsidian";
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
import { StreamingController } from "./controllers/StreamingController";
import { messageHandling } from "./messageHandling";
import { AtMentionMenu } from "../../components/AtMentionMenu";
import { LARGE_TEXT_THRESHOLDS, LARGE_TEXT_MESSAGES, LargeTextHelpers } from "../../constants/largeText";
import { ERROR_CODES } from "../../utils/errors";
import { showPopup } from "../../core/ui/";

import { createChatComposer } from "./ui/createInputUI";
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
import {
  getManagedSystemSculptModelId,
  hasManagedSystemSculptAccess,
  isManagedSystemSculptModelId,
} from "../../services/systemsculpt/ManagedSystemSculptModel";

export interface InputHandlerOptions {
  app: App;
  container: HTMLElement;
  aiService: SystemSculptService;
  getMessages: () => ChatMessage[];
  getContextFiles: () => Set<string>;
  isChatReady: () => boolean;
  chatContainer: HTMLElement;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  onMessageSubmit: (message: ChatMessage) => Promise<void>;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  onContextFileAdd: (wikilink: string) => Promise<void>;
  onError: (error: string | SystemSculptError) => void;
  onAddContextFile: () => void;
  onOpenChatSettings: () => void;
  plugin: SystemSculptPlugin;
  getChatMarkdown: () => Promise<string>;
  getChatTitle: () => string;
  addFileToContext: (file: TFile) => Promise<void>;
  addMessageToHistory: (message: ChatMessage) => Promise<void>;
  chatStorage: any; // ChatStorageService
  getChatId: () => string;
  chatView: any; // ChatView reference for message grouping
}

export class InputHandler extends Component {
  private app: App;
  private container: HTMLElement;
  private aiService: SystemSculptService;
  private getMessages: () => ChatMessage[];
  private getContextFiles: () => Set<string>;
  private isChatReady: () => boolean;
  private chatContainer: HTMLElement;
  private scrollManager: ScrollManagerService;
  private messageRenderer: MessageRenderer;
  private onMessageSubmit: (message: ChatMessage) => Promise<void>;
  private onAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onContextFileAdd: (wikilink: string) => Promise<void>;
  private onError: (error: string | SystemSculptError) => void;
  private onAddContextFile: () => void;
  private onOpenChatSettings: () => void;
  private input: HTMLTextAreaElement;
  private inputWrapper: HTMLDivElement | null = null;
  private attachmentsEl: HTMLDivElement | null = null;
  private attachmentPillsByKey: Map<string, HTMLElement> = new Map();
  private isGenerating = false;
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
  private addMessageToHistory: (message: ChatMessage) => Promise<void>;
  private pendingLargeTextContent: string | null = null;
  private settingsButton: ButtonComponent;
  private attachButton: ButtonComponent;
  private micButton: ButtonComponent;
  private sendButton: ButtonComponent;
  private chatStorage: any; // ChatStorageService
  private getChatId: () => string;
  private chatView: any;
  private slashCommandMenu?: SlashCommandMenu;
  private atMentionMenu?: AtMentionMenu;
  private agentSelectionMenu?: { isOpen?: () => boolean };
  private liveRegionEl: HTMLElement | null = null;
  private recorderToggleUnsubscribe: (() => void) | null = null;

  /* ------------------------------------------------------------------
   * Batching of tool-call state-changed events to avoid excessive DOM
   * re-renders when many events fire in rapid succession.
   * ------------------------------------------------------------------ */
  private pendingToolCallUpdates: Set<string> = new Set();
  private scheduledToolCallUpdateFrame: number | null = null;

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
    this.getContextFiles = options.getContextFiles;
    this.isChatReady = options.isChatReady;
    this.chatContainer = options.chatContainer;
    this.scrollManager = options.scrollManager;
    this.messageRenderer = options.messageRenderer;
    this.onMessageSubmit = options.onMessageSubmit;
    this.onAssistantResponse = options.onAssistantResponse;
    this.onContextFileAdd = options.onContextFileAdd;
    this.addMessageToHistory = options.addMessageToHistory;
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
    this.chatStorage = options.chatStorage;
    this.getChatId = options.getChatId;
    this.chatView = options.chatView;

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

    const originalAssistantResponse = options.onAssistantResponse;
    this.onAssistantResponse = async (message: ChatMessage) => {
      await originalAssistantResponse(message);
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

  private async streamAssistantTurn(
    signal: AbortSignal,
    includeContextFiles: boolean
  ): Promise<{ messageId: string; message: ChatMessage; messageEl: HTMLElement; completed: boolean; stopReason?: string }> {
    const { messageEl } = this.createAssistantMessageContainer();
    let messageId = messageEl.dataset.messageId;
    if (!messageId || messageId.trim().length === 0) {
      messageId = this.generateMessageId();
      messageEl.dataset.messageId = messageId;
    }

    const contextFiles = includeContextFiles ? this.chatView.contextManager.getContextFiles() : new Set<string>();
    const managedModelId = getManagedSystemSculptModelId();
	    const stream = this.aiService.streamMessage({
	      messages: this.getMessages(),
	      model: managedModelId,
	      contextFiles,
	      signal,
        sessionFile: this.chatView?.getPiSessionFile?.(),
        sessionId: this.chatView?.getPiSessionId?.(),
        onPiSessionReady: (session) => {
          this.chatView?.setPiSessionState?.(session);
        },
	      debug: this.chatView.getDebugLogService?.()?.createStreamLogger({
	        chatId: this.getChatId(),
	        assistantMessageId: messageId,
        modelId: managedModelId,
      }) || undefined,
    });

	    return await this.streamingController.stream(
	      stream,
	      messageEl,
	      messageId,
	      signal
	    );
	  }

  private shouldContinueHostedToolLoop(message: ChatMessage, stopReason?: string): boolean {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      return false;
    }

    if (String(stopReason || "").trim() === "toolUse") {
      return true;
    }

    return toolCalls.some((toolCall) => toolCall.state === "executing" || !toolCall.result);
  }

  private mergeToolCalls(existingToolCalls: ToolCall[] = [], nextToolCalls: ToolCall[] = []): ToolCall[] | undefined {
    if (existingToolCalls.length === 0 && nextToolCalls.length === 0) {
      return undefined;
    }

    const existingMap = new Map(existingToolCalls.map((toolCall) => [toolCall.id, toolCall]));
    const mergedMap = new Map(existingMap);
    for (const toolCall of nextToolCalls) {
      mergedMap.set(toolCall.id, toolCall);
    }

    for (const [toolCallId, existingToolCall] of existingMap) {
      if (!existingToolCall.result || !mergedMap.has(toolCallId)) {
        continue;
      }
      const mergedToolCall = mergedMap.get(toolCallId)!;
      if (!mergedToolCall.result) {
        mergedToolCall.result = existingToolCall.result;
      }
    }

    return Array.from(mergedMap.values());
  }

  private mergeAssistantMessageIntoHistory(message: ChatMessage): ChatMessage {
    const messages = this.getMessages();
    const existingMessageIndex = messages.findIndex((entry) => entry.message_id === message.message_id);
    if (existingMessageIndex === -1) {
      messages.push(message);
      return message;
    }

    const existingMessage = messages[existingMessageIndex];
    const mergedMessage: ChatMessage = {
      ...existingMessage,
      ...message,
      content: message.content !== undefined ? message.content : existingMessage.content,
      reasoning: message.reasoning || existingMessage.reasoning,
      annotations: message.annotations || existingMessage.annotations,
      tool_calls: this.mergeToolCalls(existingMessage.tool_calls || [], message.tool_calls || []),
      messageParts: message.messageParts || existingMessage.messageParts,
      reasoning_details: (message as any).reasoning_details || (existingMessage as any).reasoning_details,
    };

    messages[existingMessageIndex] = mergedMessage;
    return mergedMessage;
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

  private async persistAssistantToolLoopUpdate(message: ChatMessage): Promise<ChatMessage> {
    const mergedMessage = this.mergeAssistantMessageIntoHistory(message);
    await this.saveChatImmediate();
    await this.renderPersistedAssistantMessage(mergedMessage, { forceRerender: true });
    return mergedMessage;
  }

  private async confirmHostedToolExecution(toolCall: ToolCall): Promise<boolean> {
    const functionName = String(toolCall.request?.function?.name || "").trim();
    if (!requiresUserApproval(functionName, { trustedToolNames: new Set() })) {
      return true;
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

  private async runHostedAgentTurnLoop(signal: AbortSignal, includeContextFiles: boolean): Promise<void> {
    const maxToolContinuationRounds = 8;

    for (let round = 0; round < maxToolContinuationRounds; round += 1) {
      const streamedTurn = await this.streamAssistantTurn(signal, includeContextFiles);
      if (!this.shouldContinueHostedToolLoop(streamedTurn.message, streamedTurn.stopReason)) {
        return;
      }

      const executedMessage = await this.executeHostedToolCalls(streamedTurn.message, signal);
      await this.persistAssistantToolLoopUpdate(executedMessage);
    }

    throw new SystemSculptError(
      "The hosted agent exceeded the maximum tool continuation depth.",
      ERROR_CODES.STREAM_ERROR,
      500,
      { errorCode: TOOL_LOOP_ERROR_CODE }
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
    });

    this.input = composer.input;
    this.inputWrapper = composer.inputWrap;
    this.attachmentsEl = composer.attachments;
    this.micButton = composer.micButton;
    this.sendButton = composer.sendButton;
    this.stopButton = composer.stopButton;
    this.settingsButton = composer.settingsButton;
    this.attachButton = composer.attachButton;

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

  private async handleSendMessage(overrides?: { includeContextFiles?: boolean }): Promise<void> {
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
          metadata: { modelId: getManagedSystemSculptModelId() },
        });
      } catch {}
    } finally {
      this.focus();
      await this.chatView.contextManager.validateAndCleanContextFiles();
    }
  }

  public async submitWithOverrides(overrides: { includeContextFiles?: boolean }): Promise<void> {
    await this.handleSendMessage(overrides);
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

  public setValue(value: string): void {
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

      // Focus the input and move cursor to end
      this.input.focus();
      this.input.setSelectionRange(value.length, value.length);
    } catch (error) {
      new Notice("❌ Failed to set input value");
    }
  }

  public unload(): void {
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }

    // Remove recorder UI elements and clean up
    if (this.recorderVisualizer) {
      this.recorderVisualizer.remove();
      this.recorderVisualizer = null;
    }

    this.recorderToggleUnsubscribe?.();
    this.recorderToggleUnsubscribe = null;

    // Clean up slash command menu
    if (this.slashCommandMenu) {
      this.slashCommandMenu.unload();
    }

    // Clean up @ mention menu
    if (this.atMentionMenu) {
      this.atMentionMenu.unload();
    }

    // Call Component's unload method to clean up event listeners
    super.unload();
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

  public onModelChange(): void {
    // no-op (kept for UI hooks)
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
  public setInputText(content: string | object): void {
    this.setValue(typeof content === "string" ? content : JSON.stringify(content));
    this.focus();
  }

  /**
   * Extract annotations from the response text
   * This method parses markdown links in the format [domain](url) and extracts them as citations
   * Based on the actual OpenRouter response format observed in logs
   */
  private extractAnnotationsFromResponse(responseText: string): Annotation[] {
    return extractAnnotationsFromResponseExternal(responseText);
  }

  public onunload(): void {
    // Clean up any floating status indicators
    this.cleanupAllStatusIndicators();
    
    // Call parent unload
    super.unload();
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
    if (!hasManagedSystemSculptAccess(this.plugin)) {
      await this.invokeProviderSetupPrompt(
        "Activate your SystemSculpt license in Account before starting a chat."
      );
      return false;
    }

    const selectedModelId =
      typeof this.chatView?.getSelectedModelId === "function"
        ? String(this.chatView.getSelectedModelId() || "").trim()
        : String(this.chatView?.selectedModelId || this.plugin.settings.selectedModelId || "").trim();
    if (!isManagedSystemSculptModelId(selectedModelId)) {
      try {
        if (typeof this.chatView?.setSelectedModelId === "function") {
          await this.chatView.setSelectedModelId(getManagedSystemSculptModelId());
        } else {
          await this.plugin.getSettingsManager().updateSettings({
            selectedModelId: getManagedSystemSculptModelId(),
          });
        }
      } catch (error: any) {
        await this.invokeProviderSetupPrompt(
          error?.message || "SystemSculpt is not ready yet. Open Account to confirm your license."
        );
        return false;
      }
    }

    return true;
  }

  private async invokeProviderSetupPrompt(message?: string): Promise<void> {
    if (typeof this.chatView?.promptProviderSetup === 'function') {
      await this.chatView.promptProviderSetup(message);
      return;
    }
    await this.promptProviderSetupFallback(message);
  }

  private async promptProviderSetupFallback(message?: string): Promise<void> {
    const result = await showPopup(
      this.app,
      message ?? "Open Settings -> Account to activate your SystemSculpt license.",
      {
        title: "Finish SystemSculpt setup",
        icon: "plug-zap",
        primaryButton: "Open Account",
        secondaryButton: "Not Now",
      }
    );
    if (result?.confirmed) {
      this.openSetupTabFallback();
    }
  }

  private openSetupTabFallback(tabId: string = "account"): void {
    try {
      this.plugin.openSettingsTab(tabId);
    } catch (error) {
      new Notice("Open Settings -> SystemSculpt AI -> Account to finish SystemSculpt setup.", 6000);
    }
  }
}
