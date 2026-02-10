import { App, TFile, setIcon, Component, Notice, Modal, Setting, ButtonComponent } from "obsidian";
import {
  ChatMessage,
  SystemPromptInfo,
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
import { ToolCallManager } from "./ToolCallManager";
import { MessagePart } from "../../types";
import { SlashCommandMenu, SlashCommand } from "./SlashCommandMenu";
import { StreamingController } from "./controllers/StreamingController";
import { messageHandling } from "./messageHandling";
import { AtMentionMenu } from "../../components/AtMentionMenu";
import { AgentSelectionMenu } from "./AgentSelectionMenu";
import { LARGE_TEXT_THRESHOLDS, LARGE_TEXT_MESSAGES, LargeTextHelpers } from "../../constants/largeText";
import { ERROR_CODES } from "../../utils/errors";
import { showPopup } from "../../core/ui/";

import { createChatComposer } from "./ui/createInputUI";
import { handlePaste as handlePasteExternal, handleLargeTextPaste as handleLargeTextPasteExternal, showLargeTextWarning as showLargeTextWarningExternal } from "./handlers/LargePasteHandlers";
import { handleKeyDown as handleKeyDownExternal, handleInputChange as handleInputChangeExternal } from "./handlers/UIKeyHandlers";
import { createAssistantMessageContainer as createAssistantMessageContainerExternal, getStatusIndicator as getStatusIndicatorExternal, addMessageToContainer as addMessageToContainerExternal, updateStreamingStatus as updateStreamingStatusExternal, hideStreamingStatus as hideStreamingStatusExternal, showStreamingStatus as showStreamingStatusExternal, setStreamingFootnote as setStreamingFootnoteExternal, clearStreamingFootnote as clearStreamingFootnoteExternal } from "./handlers/MessageElements";
import type { StreamingMetrics } from "./StreamingMetricsTracker";
import { extractAnnotationsFromResponse as extractAnnotationsFromResponseExternal } from "./handlers/Annotations";
import { handleOpenChatHistoryFile as handleOpenChatHistoryFileExternal, handleSaveChatAsNote as handleSaveChatAsNoteExternal } from "./handlers/NotesHandlers";
// Turn lifecycle handling
import { ChatTurnLifecycleController } from "./controllers/ChatTurnLifecycleController";
import { errorLogger } from "../../utils/errorLogger";
import { mentionsObsidianBases } from "../../utils/obsidianBases";

export interface InputHandlerOptions {
  app: App;
  container: HTMLElement;
  aiService: SystemSculptService;
  getMessages: () => ChatMessage[];
  getSelectedModelId: () => string;
  getContextFiles: () => Set<string>;
  getSystemPrompt: () => SystemPromptInfo;
  isChatReady: () => boolean;
  chatContainer: HTMLElement;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  onMessageSubmit: (message: ChatMessage) => Promise<void>;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  onContextFileAdd: (wikilink: string) => Promise<void>;
  onError: (error: string | SystemSculptError) => void;
  onAddContextFile: () => void;
  onEditSystemPrompt: () => void;
  plugin: SystemSculptPlugin;
  getChatMarkdown: () => Promise<string>;
  getChatTitle: () => string;
  addFileToContext: (file: TFile) => Promise<void>;
  addMessageToHistory: (message: ChatMessage) => Promise<void>;
  chatStorage: any; // ChatStorageService
  getChatId: () => string;
  toolCallManager: ToolCallManager;
  chatView: any; // ChatView reference for message grouping
}

export class InputHandler extends Component {
  private app: App;
  private container: HTMLElement;
  private aiService: SystemSculptService;
  private getMessages: () => ChatMessage[];
  private getSelectedModelId: () => string;
  private getContextFiles: () => Set<string>;
  private getSystemPrompt: () => SystemPromptInfo;
  private isChatReady: () => boolean;
  private chatContainer: HTMLElement;
  private scrollManager: ScrollManagerService;
  private messageRenderer: MessageRenderer;
  private onMessageSubmit: (message: ChatMessage) => Promise<void>;
  private onAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onContextFileAdd: (wikilink: string) => Promise<void>;
  private onError: (error: string | SystemSculptError) => void;
  private onAddContextFile: () => void;
  private onEditSystemPrompt: () => void;
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
  private toolCallManager: ToolCallManager;
  private chatView: any;
  private slashCommandMenu?: SlashCommandMenu;
  private atMentionMenu?: AtMentionMenu;
  private agentSelectionMenu?: AgentSelectionMenu;
  private liveRegionEl: HTMLElement | null = null;
  private hasPromptedAgentModeForBases = false;

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
    this.getSelectedModelId = options.getSelectedModelId;
    this.getContextFiles = options.getContextFiles;
    this.getSystemPrompt = options.getSystemPrompt;
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
    this.onEditSystemPrompt = options.onEditSystemPrompt;
    this.plugin = options.plugin;
    // Provide light wrappers for external callers to read/write input
    this.getValue = () => this.input?.value ?? "";
    this.setValue = (text: string) => { if (this.input) { this.input.value = text; this.adjustInputHeight(); } };
    this.getChatMarkdown = options.getChatMarkdown;
    this.getChatTitle = options.getChatTitle;
    this.addFileToContext = options.addFileToContext;
    this.chatStorage = options.chatStorage;
    this.getChatId = options.getChatId;
    this.toolCallManager = options.toolCallManager;
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
      // First, save the message data
      await originalAssistantResponse(message);

      // Prefer an in-place finalization to avoid DOM remove+add (which can trigger
      // extra layout work and false "new messages" increments while detached)
      const currentMessageEl = this.chatContainer.querySelector(`.systemsculpt-message[data-message-id="${message.message_id}"]`) as HTMLElement;
      if (currentMessageEl) {
        try {
          // Ensure a content container exists
          let contentEl = currentMessageEl.querySelector('.systemsculpt-message-content') as HTMLElement | null;
          if (!contentEl) {
            contentEl = currentMessageEl.createDiv({ cls: 'systemsculpt-message-content' });
          }

          // Render unified parts in-place (non-streaming)
          const partList = this.messageRenderer.normalizeMessageToParts(message);
          this.messageRenderer.renderUnifiedMessageParts(currentMessageEl, partList.parts, false);

          // Attach the toolbar if not already present
          if (!currentMessageEl.querySelector('.systemsculpt-message-toolbar')) {
            this.messageRenderer.addMessageButtonToolbar(
              currentMessageEl,
              typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
              message.role,
              message.message_id
            );
          }
          return; // Done via in-place update
        } catch {
          // Fall back to full re-render if anything goes wrong
        }
      }

      // Fallback: re-render using the unified pathway that matches reload behavior
      await messageHandling.addMessage(this.chatView, message.role, message.content, message.message_id, message);
    };

    this.setupInput();
    this.initializeSlashCommands();
    this.initializeAtMentionMenu();
    this.initializeAgentSelectionMenu();

    // ----------------------------------------------------------------------
    // Extracted streaming logic controller
    // ----------------------------------------------------------------------
    this.streamingController = new StreamingController({
      toolCallManager: this.toolCallManager,
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
      // Use centralized policy on ToolCallManager
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
    includeContextFiles: boolean,
    agentModeOverride?: boolean
  ): Promise<{ messageId: string; message: ChatMessage; messageEl: HTMLElement; completed: boolean; stopReason?: string }> {
    const { messageEl } = this.createAssistantMessageContainer();
    let messageId = messageEl.dataset.messageId;
    if (!messageId || messageId.trim().length === 0) {
      messageId = this.generateMessageId();
      messageEl.dataset.messageId = messageId;
    }

    const sys = this.getSystemPrompt();
    const contextFiles = includeContextFiles ? this.chatView.contextManager.getContextFiles() : new Set<string>();
    const agentModeForTurn = typeof agentModeOverride === "boolean" ? agentModeOverride : (this.chatView?.agentMode || false);

	    const stream = this.aiService.streamMessage({
	      messages: this.getMessages(),
	      model: this.getSelectedModelId(),
	      contextFiles,
	      systemPromptType: sys.type,
	      systemPromptPath: sys.path,
	      signal,
	      agentMode: agentModeForTurn,
	      toolCallManager: agentModeForTurn ? this.toolCallManager : undefined,
	      sessionId: this.getChatId(),
	      debug: this.chatView.getDebugLogService?.()?.createStreamLogger({
	        chatId: this.getChatId(),
	        assistantMessageId: messageId,
        modelId: this.getSelectedModelId(),
      }) || undefined,
    });

	    return await this.streamingController.stream(
	      stream,
	      messageEl,
	      messageId,
	      signal
	    );
	  }

  private areToolCallsSettledForMessage(messageId: string): boolean {
    const toolCalls = this.toolCallManager.getToolCallsForMessage(messageId);
    if (toolCalls.length === 0) return true;
    return toolCalls.every((toolCall) => toolCall.state !== "executing");
  }

  private async waitForToolCallsToSettle(messageId: string, signal: AbortSignal): Promise<void> {
    if (this.areToolCallsSettledForMessage(messageId)) return;

    await new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | null = null;
      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };

      unsubscribe = this.toolCallManager.on("tool-call:state-changed", ({ toolCall }) => {
        if (toolCall.messageId !== messageId) return;
        if (!this.areToolCallsSettledForMessage(messageId)) return;
        cleanup();
        resolve();
      });

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async shouldContinuePiTurn(
    turnResult: { messageId: string; message: ChatMessage; completed: boolean; stopReason?: string },
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) return false;
    if (!this.chatView?.agentMode) return false;
    if (!turnResult.completed) return false;

    const stopReason =
      typeof turnResult.stopReason === "string"
        ? turnResult.stopReason
        : typeof (turnResult.message as any)?.stopReason === "string"
          ? String((turnResult.message as any).stopReason)
          : "";
    if (stopReason !== "toolUse") return false;

    const messageId = (turnResult.message as any)?.message_id || turnResult.messageId;
    if (!messageId || typeof messageId !== "string") return false;

    await this.waitForToolCallsToSettle(messageId, signal);
    if (signal.aborted) return false;

    const settledToolCalls = this.toolCallManager.getToolCallsForMessage(messageId);
    return settledToolCalls.length > 0;
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
      onEditSystemPrompt: this.onEditSystemPrompt,
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
    this.recorderService.onToggle((isRecording: boolean) => {
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

  private initializeAgentSelectionMenu(): void {
    this.agentSelectionMenu = new AgentSelectionMenu(this.plugin, this.chatView, this.input);
    this.addChild(this.agentSelectionMenu);
  }

  private handleStopGeneration(): void {
    this.turnLifecycle.stop();

    // Don't force scroll when user stops generation - respect their current position
    // this.scrollManager.resetScrollState();
  }

  private async handleSendMessage(overrides?: { includeContextFiles?: boolean; agentModeOverride?: boolean }): Promise<void> {
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

    if (!(await this.ensureProviderReadyForChat())) {
      return;
    }

    await this.maybePromptEnableAgentModeForBases(messageText);

    const includeContextFiles = overrides?.includeContextFiles ?? true;
    const agentModeOverride = overrides?.agentModeOverride;

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

        // Keep taking PI-native turns until PI signals we're done.
        let shouldContinue = true;
        while (shouldContinue && !signal.aborted) {
          const turnResult = await this.streamAssistantTurn(signal, includeContextFiles, agentModeOverride);
          shouldContinue = await this.shouldContinuePiTurn(turnResult, signal);
        }
      });
    } catch (err) {
      // StreamingController already forwards errors into ChatView.handleError via onError.
      // Swallow here to avoid "Uncaught (in promise)" in the Obsidian console.
      if (!(err instanceof SystemSculptError && err.code === ERROR_CODES.STREAM_ERROR)) {
        try {
          this.onError(err as any);
        } catch {}
      }
      try {
        errorLogger.debug("Chat turn failed", {
          source: "InputHandler",
          method: "handleSendMessage",
          metadata: { modelId: this.getSelectedModelId?.() },
        });
      } catch {}
    } finally {
      this.focus();
      await this.chatView.contextManager.validateAndCleanContextFiles();
    }
  }

  public async submitWithOverrides(overrides: { includeContextFiles?: boolean; agentModeOverride?: boolean }): Promise<void> {
    await this.handleSendMessage(overrides);
  }

  private async maybePromptEnableAgentModeForBases(messageText: string): Promise<void> {
    if (!mentionsObsidianBases(messageText)) return;
    if (this.chatView?.agentMode) return;
    if (this.hasPromptedAgentModeForBases) return;
    this.hasPromptedAgentModeForBases = true;

    const result = await showPopup(
      this.app,
      "This looks like an Obsidian Bases request (.base files), but Agent Mode is OFF. Without Agent Mode, the assistant can't search/read your vault to find or edit bases. Enable Agent Mode now?",
      {
        title: "Enable Agent Mode for Bases",
        icon: "wrench",
        primaryButton: "Enable Agent Mode",
        secondaryButton: "Send without tools",
      }
    );

    if (result?.confirmed) {
      try {
        if (typeof this.chatView?.setAgentMode === "function") {
          await this.chatView.setAgentMode(true);
        } else {
          this.chatView.agentMode = true;
        }
      } catch {}
    }
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
      agentSelectionMenu: this.agentSelectionMenu,
    }, event);
  }

  private handleInputChange(): void {
    const result = handleInputChangeExternal({
      input: this.input,
      adjustInputHeight: () => this.adjustInputHeight(),
      slashCommandMenu: this.slashCommandMenu,
      atMentionMenu: this.atMentionMenu,
      agentSelectionMenu: this.agentSelectionMenu,
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

      pill.empty();
      pill.setAttr("role", "button");
      pill.setAttr("tabindex", "0");

      if (item.kind === "processing") {
        pill.className = "systemsculpt-attachment-pill mod-processing";
        pill.dataset.kind = "processing";
        pill.dataset.processingKey = item.processingKey;
        pill.dataset.linkText = item.file.path;

        const progress = Number.isFinite(item.event?.progress) ? Math.round(item.event.progress) : 0;
        const label = typeof item.event?.label === "string" ? item.event.label : "Processing…";
        pill.setAttr("title", `${item.file.path} — ${label}${Number.isFinite(progress) ? ` (${progress}%)` : ""}`);

        const iconEl = pill.createSpan({ cls: "systemsculpt-attachment-pill-icon" });
        const ext = item.file.extension?.toLowerCase?.() || "";
        const iconName =
          ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
            ? "image"
            : ["mp3", "wav", "ogg", "m4a", "webm"].includes(ext)
              ? "file-audio"
              : "file-text";
        setIcon(iconEl, iconName);

        pill.createSpan({ cls: "systemsculpt-attachment-pill-label", text: item.file.basename });

        const statusEl = pill.createSpan({ cls: "systemsculpt-attachment-pill-status" });
        const statusIcon = typeof item.event?.icon === "string" && item.event.icon.length > 0 ? item.event.icon : "loader-2";
        setIcon(statusEl, statusIcon);
        if (item.event?.stage !== "ready" && item.event?.stage !== "error") {
          statusEl.addClass("is-spinning");
        }

        const removeButton = pill.createEl("button", {
          cls: "clickable-icon systemsculpt-attachment-pill-remove",
          attr: { type: "button", "aria-label": "Dismiss processing status" },
        });
        setIcon(removeButton, "x");
      } else {
        pill.className = "systemsculpt-attachment-pill";
        pill.dataset.kind = "file";
        pill.dataset.wikiLink = item.wikiLink;

        const linkText = item.wikiLink.replace(/^\[\[(.*?)\]\]$/, "$1");
        pill.dataset.linkText = linkText;

        const resolved = this.app.metadataCache.getFirstLinkpathDest(linkText, "") ?? this.app.vault.getAbstractFileByPath(linkText);
        const label = resolved instanceof TFile ? resolved.basename : linkText.split("/").pop() || linkText;
        pill.setAttr("title", linkText);

        const iconEl = pill.createSpan({ cls: "systemsculpt-attachment-pill-icon" });
        const iconName =
          resolved instanceof TFile
            ? ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(resolved.extension.toLowerCase())
              ? "image"
              : ["mp3", "wav", "ogg", "m4a", "webm"].includes(resolved.extension.toLowerCase())
                ? "file-audio"
                : "file-text"
            : "file-text";
        setIcon(iconEl, iconName);

        pill.createSpan({ cls: "systemsculpt-attachment-pill-label", text: label });

        const removeButton = pill.createEl("button", {
          cls: "clickable-icon systemsculpt-attachment-pill-remove",
          attr: { type: "button", "aria-label": "Remove file from context" },
        });
        setIcon(removeButton, "x");
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

    // Unregister any event listeners from the recorder service
    if (this.recorderService) {
      // This only removes our listener, but doesn't unload the service itself
      // as other components might still be using it
      this.recorderService.onToggle(() => {});
    }

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

  private hasConfiguredProviderFallback(): boolean {
    const settings = this.plugin.settings;
    const hasSystemSculpt = !!(settings.enableSystemSculptProvider && settings.licenseKey?.trim() && settings.licenseValid === true);
    const hasCustomProvider = Array.isArray(settings.customProviders) && settings.customProviders.some((provider) => provider?.isEnabled);
    return hasSystemSculpt || hasCustomProvider;
  }

  private async ensureProviderReadyForChat(): Promise<boolean> {
    const providerConfigured = this.chatView?.hasConfiguredProvider?.() ?? this.hasConfiguredProviderFallback();
    if (!providerConfigured) {
      await this.invokeProviderSetupPrompt("Connect an AI provider before sending a message.");
      return false;
    }

    const selectedModelId = this.getSelectedModelId();
    if (!selectedModelId) {
      await this.showModelSelectionModal("Choose a model before starting a chat.");
      return false;
    }

    try {
      const model = await this.plugin.modelService.getModelById(selectedModelId);
      if (model) {
        return true;
      }
    } catch {}

    let models: any[] = [];
    try {
      models = await this.plugin.modelService.getModels();
    } catch {}

    if (!models || models.length === 0) {
      await this.invokeProviderSetupPrompt("SystemSculpt AI couldn't find any available models. Connect a provider or activate your license to continue.");
      return false;
    }

    await this.showModelSelectionModal("The selected model is unavailable. Pick another model to continue.");
    return false;
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
      message ?? "Connect SystemSculpt AI or add your own provider in Settings → Overview & Setup.",
      {
        title: "Connect An AI Provider",
        icon: "plug-zap",
        primaryButton: "Open Setup",
        secondaryButton: "Not Now",
      }
    );
    if (result?.confirmed) {
      this.openSetupTabFallback();
    }
  }

  private openSetupTabFallback(tabId: string = "overview"): void {
    try {
      // @ts-ignore – Obsidian typings omit the settings API
      this.app.setting.open();
      // @ts-ignore
      this.app.setting.openTabById(this.plugin.manifest.id);
      window.setTimeout(() => {
        this.app.workspace.trigger("systemsculpt:settings-focus-tab", tabId);
      }, 100);
    } catch (error) {
      new Notice("Open Settings → SystemSculpt AI to configure providers.", 6000);
    }
  }

  private async showModelSelectionModal(description?: string): Promise<void> {
    const { StandardModelSelectionModal } = await import("../../modals/StandardModelSelectionModal");
    const modal = new StandardModelSelectionModal({
      app: this.app,
      plugin: this.plugin,
      currentModelId: this.getSelectedModelId() || '',
      title: "Select an AI Model",
      description: description || "Choose a model to continue.",
      onSelect: async (result) => {
        if (typeof this.chatView?.setSelectedModelId === 'function') {
          await this.chatView.setSelectedModelId(result.modelId);
        }
        new Notice('Model updated. Send your message again.', 3000);
      }
    });
    modal.open();
  }

}
