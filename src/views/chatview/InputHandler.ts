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
import { SlashCommandMenu, SlashCommand } from "./SlashCommandMenu";
import { StreamingController, type StreamTurnResult } from "./controllers/StreamingController";
import { ChatTurnProgressController } from "./controllers/ChatTurnProgressController";
import { messageHandling } from "./messageHandling";
import { AtMentionMenu } from "../../components/AtMentionMenu";
import { LARGE_TEXT_THRESHOLDS, LARGE_TEXT_MESSAGES, LargeTextHelpers } from "../../constants/largeText";
import { ERROR_CODES } from "../../utils/errors";
import { showPopup } from "../../core/ui/";

import { createChatComposer } from "./ui/createInputUI";
import { createPromptChip, updatePromptChip } from "./PromptSelector";
import { PromptService } from "../../services/PromptService";
import { ListSelectionModal, type ListItem } from "../../core/ui/modals/standard/ListSelectionModal";
import { promptChatAccountSetup } from "./ChatAccountSetup";
import { renderContextAttachmentPill } from "./ui/ContextAttachmentPills";
import { handlePaste as handlePasteExternal, handleLargeTextPaste as handleLargeTextPasteExternal, showLargeTextWarning as showLargeTextWarningExternal } from "./handlers/LargePasteHandlers";
import { handleKeyDown as handleKeyDownExternal, handleInputChange as handleInputChangeExternal } from "./handlers/UIKeyHandlers";
import { createAssistantMessageContainer as createAssistantMessageContainerExternal, getStatusIndicator as getStatusIndicatorExternal, addMessageToContainer as addMessageToContainerExternal, updateStreamingStatus as updateStreamingStatusExternal, hideStreamingStatus as hideStreamingStatusExternal, showStreamingStatus as showStreamingStatusExternal, setStreamingFootnote as setStreamingFootnoteExternal, clearStreamingFootnote as clearStreamingFootnoteExternal } from "./handlers/MessageElements";
import type { StreamingMetrics } from "./StreamingMetricsTracker";
import { extractAnnotationsFromResponse as extractAnnotationsFromResponseExternal } from "./handlers/Annotations";
import { handleOpenChatHistoryFile as handleOpenChatHistoryFileExternal, handleSaveChatAsNote as handleSaveChatAsNoteExternal } from "./handlers/NotesHandlers";
// Turn lifecycle handling
import {
  ChatTurnAlreadyActiveError,
  ChatTurnLifecycleController,
} from "./controllers/ChatTurnLifecycleController";
import { errorLogger } from "../../utils/errorLogger";
import { TOOL_LOOP_ERROR_CODE } from "../../utils/tooling";
import { extractPrimaryPathArg, requiresUserApproval } from "../../utils/toolPolicy";
import { ChatTurn } from "./turn/ChatTurn";
import type { ChatTurnFence } from "./turn/ChatTurnEffects";
import type {
  AcceptedChatOperation,
  AcceptedManagedChatOperation,
  ManagedAllowedLease,
  ManagedAdmissionOutcome,
  ManagedChatAdmissionPort,
} from "../../services/managed/ManagedTypes";
import type { AcceptedChatRequestSnapshot } from "../../services/chat/AcceptedChatRequestSnapshot";
import type { AcceptedUserCommitInput, AcceptedUserCommitResult } from "./ChatView";
import type { ChatTranscriptSnapshot } from "./transcript/ChatTranscriptTypes";

export interface InputHandlerOptions {
  app: App;
  container: HTMLElement;
  aiService: SystemSculptService;
  getMessages: () => ChatMessage[];
  isChatReady: () => boolean;
  chatContainer: HTMLElement;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  managedChatAdmission: ManagedChatAdmissionPort;
  onMessageSubmit: (message: ChatMessage) => Promise<void>;
  commitAcceptedUserMessage: (input: AcceptedUserCommitInput) => Promise<AcceptedUserCommitResult>;
  claimAcceptedUserCommit: (result: AcceptedUserCommitResult) => boolean;
  onAssistantResponse: (message: ChatMessage) => Promise<void>;
  onError: (error: string | SystemSculptError) => void;
  onAddContextFile: () => void;
  onOpenChatSettings: () => void;
  plugin: SystemSculptPlugin;
  getChatMarkdown: () => Promise<string>;
  getChatTitle: () => string;
  addFileToContext: (file: TFile) => Promise<void>;
  getChatId: () => string;
  chatView: any; // ChatView reference for message grouping
}

export type AutomationApprovalMode = "interactive" | "auto-approve" | "deny";

type PendingSubmissionIntent =
  | Readonly<{ kind: "append" }>
  | Readonly<{ kind: "resend"; targetMessageId: string; expectedIndex: number; expectedVersion: number }>;

export class InputHandler extends Component {
  private app: App;
  private container: HTMLElement;
  private aiService: SystemSculptService;
  private getMessages: () => ChatMessage[];
  private isChatReady: () => boolean;
  private chatContainer: HTMLElement;
  private scrollManager: ScrollManagerService;
  private messageRenderer: MessageRenderer;
  private managedChatAdmission: ManagedChatAdmissionPort;
  private onMessageSubmit: (message: ChatMessage) => Promise<void>;
  private commitAcceptedUserMessage: (input: AcceptedUserCommitInput) => Promise<AcceptedUserCommitResult>;
  private claimAcceptedUserCommit: (result: AcceptedUserCommitResult) => boolean;
  private persistAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onAssistantResponse: (message: ChatMessage) => Promise<void>;
  private onError: (error: string | SystemSculptError) => void;
  private onAddContextFile: () => void;
  private onOpenChatSettings: () => void;
  private input: HTMLTextAreaElement;
  private inputWrapper: HTMLDivElement | null = null;
  private attachmentsEl: HTMLDivElement | null = null;
  private attachmentPillsByKey: Map<string, HTMLElement> = new Map();
  private isGenerating = false;
  private webSearchEnabled = false;
  private agentModeButtonEl: HTMLElement | null = null;
  // ButtonComponent for the per-chat hide system/tool toggle (#213/#174/#167).
  private hideSystemButton: any = null;
  private selectedPromptPath: string | null = null;
  private selectedPromptName: string | null = null;
  private promptChip: HTMLElement | null = null;
  private promptService!: PromptService;
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
  private submittedInputSnapshot: { messageId: string; rawText: string } | null = null;
  private settingsButton: ButtonComponent;
  private attachButton: ButtonComponent;
  private micButton: ButtonComponent;
  private sendButton: ButtonComponent;
  private getChatId: () => string;
  private chatView: any;
  private slashCommandMenu?: SlashCommandMenu;
  private atMentionMenu?: AtMentionMenu;
  private agentSelectionMenu?: { isOpen?: () => boolean };
  private liveRegionEl: HTMLElement | null = null;
  private recorderToggleUnsubscribe: (() => void) | null = null;
  private localResourcesDisposed = false;
  private localResourcesDisposing = false;
  private localResourceDisposalPromise: Promise<void> | null = null;
  private submissionReserved = false;
  private submissionReservationGeneration = 0;
  private submissionReservationPromise: Promise<void> | null = null;

  // ───────────────────────── Streaming controller ──────────────────────────
  private streamingController: StreamingController;
  private turnLifecycle: ChatTurnLifecycleController | null = null;
  private pendingSubmissionIntent: PendingSubmissionIntent = Object.freeze({ kind: "append" });
  private acceptedOperation: AcceptedChatOperation | null = null;
  private acceptedRequestSnapshot: AcceptedChatRequestSnapshot | null = null;
  private compatibilityResult: Readonly<{ kind: "contract_unsupported"; feature: "web_search"; action: "disable_web_search" }> | null = null;

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
    this.managedChatAdmission = options.managedChatAdmission;
    this.onMessageSubmit = options.onMessageSubmit;
    this.commitAcceptedUserMessage = options.commitAcceptedUserMessage;
    this.claimAcceptedUserCommit = options.claimAcceptedUserCommit;
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
    this.chatView = options.chatView;
    this.selectedPromptPath = this.plugin.settings.lastUsedPromptPath || null;
    this.promptService = new PromptService(
      this.app,
      this.plugin.settings.systemPromptsDirectory || "SystemSculpt/System Prompts"
    );
    if (this.selectedPromptPath) {
      this.selectedPromptName = this.selectedPromptPath.split("/").pop()?.replace(/\.md$/, "") || null;
    }
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
      generateMessageId: this.generateMessageId.bind(this),
      extractAnnotations: this.extractAnnotationsFromResponse.bind(this),
      showStreamingStatus: this.showStreamingStatus.bind(this),
      hideStreamingStatus: this.hideStreamingStatus.bind(this),
      updateStreamingStatus: this.updateStreamingStatus.bind(this),
      toggleStopButton: this.toggleStopButton.bind(this),
      onError: this.onError,
      setStreamingFootnote: this.setStreamingFootnote.bind(this),
      clearStreamingFootnote: this.clearStreamingFootnote.bind(this),
    });
    this.addChild(this.streamingController);

  }

  public waitForPersistenceIdle(): Promise<void> {
    return this.streamingController.waitForPersistenceIdle();
  }

  private async streamAssistantTurn(
    acceptedOperation: AcceptedChatOperation,
    signal: AbortSignal,
    turnProgress?: ChatTurnProgressController,
    options?: {
      phase?: "initial" | "continuation";
      postCheckpointSnapshot?: ChatTranscriptSnapshot;
      durableContinuationIndex?: number;
      fence?: ChatTurnFence;
    },
  ): Promise<StreamTurnResult> {
    return this.streamManagedAssistantTurn(acceptedOperation, signal, turnProgress, options);
  }

  private async streamManagedAssistantTurn(
    acceptedOperation: AcceptedManagedChatOperation,
    signal: AbortSignal,
    turnProgress?: ChatTurnProgressController,
    options?: {
      phase?: "initial" | "continuation";
      postCheckpointSnapshot?: ChatTranscriptSnapshot;
      durableContinuationIndex?: number;
      fence?: ChatTurnFence;
    },
  ): Promise<StreamTurnResult> {
    const acceptedRequest = this.acceptedRequestSnapshot;
    if (
      !acceptedRequest ||
      acceptedRequest.runtime !== "managed" ||
      acceptedRequest.operation !== acceptedOperation
    ) {
      throw new Error("Accepted Chat request snapshot is unavailable for the active operation.");
    }
    if (!options?.fence || !options.fence.isOpen(acceptedOperation)) {
      throw new Error("Managed Chat turn fence is unavailable for the active operation.");
    }
    const phase = options.phase ?? "initial";
    const continuationIndex = phase === "initial" ? 0 : options.durableContinuationIndex;
    if (typeof continuationIndex !== "number" || !Number.isInteger(continuationIndex) || continuationIndex < 0) {
      throw new Error("Managed Chat continuation requires a durable continuation index.");
    }
    if (phase === "continuation" && !options.postCheckpointSnapshot) {
      throw new Error("Managed Chat continuation requires a post-checkpoint durable snapshot.");
    }
    const runtime = this.chatView.getCurrentRuntimeAdapter();
    const dispatched = await runtime.dispatch({
      operation: acceptedOperation,
      acceptedRequestSnapshot: acceptedRequest,
      phase,
      continuationIndex,
      ...(options.postCheckpointSnapshot ? { postCheckpointDurableSnapshot: options.postCheckpointSnapshot } : {}),
      signal,
      fence: options.fence,
    });
    if (signal.aborted || !options.fence.isOpen(acceptedOperation)) {
      throw new Error("Managed Chat dispatch was cancelled before projection.");
    }
    if (dispatched.kind === "recovery") {
      await this.chatView.recoverManagedChatConflict(acceptedOperation, signal, options.fence);
      throw new Error(`Managed Chat recovered durable state (${dispatched.disposition}). Explicit resend is required.`);
    }

    if (signal.aborted || !options.fence.isOpen(acceptedOperation)) {
      throw new Error("Managed Chat dispatch was cancelled before projection.");
    }
    const { messageEl } = this.createAssistantMessageContainer();
    let messageId = messageEl.dataset.messageId;
    if (!messageId || !messageId.trim()) {
      messageId = this.generateMessageId();
      messageEl.dataset.messageId = messageId;
    }
    turnProgress?.attach(messageEl);
    return this.streamingController.stream(
      dispatched.events,
      messageEl,
      messageId,
      signal,
      undefined,
      turnProgress?.getTracker(),
      !!turnProgress,
    );
  }

  private shouldContinueHostedToolLoop(message: ChatMessage, stopReason?: string): boolean {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // The model signalled it wants to use a tool (stopReason "toolUse") but no
    // tool call materialised on the message — e.g. a continuation error
    // dropped the call. Continuing would re-prompt with nothing to execute, and
    // returning here would look like the agent silently died after its first
    // tool call (#146). Surface it as an actionable error, never a silent stall
    // (#210). The turn cap and empty-completion retries above remain the
    // backstops for the other terminal paths.
    if (stopReason === "toolUse" && toolCalls.length === 0) {
      this.failHostedToolTurn(
        "The model requested a tool call but none was returned. Stopping to avoid a silent stall — please try again.",
        502,
        { reason: "tool-use-without-tool-calls", stopReason }
      );
    }

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
    _options?: { forceRerender?: boolean }
  ): Promise<void> {
    const currentMessageEl = this.chatContainer.querySelector(`.systemsculpt-message[data-message-id="${message.message_id}"]`) as HTMLElement | null;
    if (currentMessageEl) {
      try {
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

    await messageHandling.addMessage(this.chatView, message.role, message.content, message.message_id, message);
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

  private async executeHostedToolCall(
    toolCall: ToolCall,
    signal: AbortSignal,
    fence?: ChatTurnFence,
    operation?: AcceptedChatOperation,
  ): Promise<void> {
    if (signal.aborted || (fence && !fence.isOpen(operation))) return;

    toolCall.state = "executing";
    toolCall.executionStartedAt = toolCall.executionStartedAt || Date.now();
    const result = await this.aiService.executeHostedToolCall({ toolCall, chatView: this.chatView, signal });
    const outcomeUnknown = !result.success && result.error?.code === "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN";
    if ((fence && !fence.isOpen(operation)) || (signal.aborted && !outcomeUnknown)) return;
    toolCall.result = result;
    toolCall.executionCompletedAt = Date.now();
    toolCall.state = result.success ? "completed" : "failed";
  }

  private failHostedToolTurn(message: string, statusCode: number, metadata?: Record<string, unknown>): never {
    const submitted = this.submittedInputSnapshot;
    const error = new SystemSculptError(
      message,
      ERROR_CODES.STREAM_ERROR,
      statusCode,
      {
        errorCode: TOOL_LOOP_ERROR_CODE,
        recoverCommittedTurn: true,
        submittedUserMessageId: submitted?.messageId,
        submittedUserText: submitted?.rawText,
        ...metadata,
      }
    );

    try {
      this.onError(error);
    } catch {}

    throw error;
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
      onToggleAgentMode: () => this.chatView?.toggleAgentMode?.(),
      isAgentModeEnabled: () => this.chatView?.isAgentModeActive?.() ?? true,
      onToggleHideSystemMessages: () => this.chatView?.toggleSystemNoiseHidden?.(),
      isHideSystemMessagesEnabled: () => this.chatView?.isSystemNoiseHidden?.() ?? false,
    });

    this.input = composer.input;
    this.inputWrapper = composer.inputWrap;
    this.attachmentsEl = composer.attachments;
    this.micButton = composer.micButton;
    this.sendButton = composer.sendButton;
    this.stopButton = composer.stopButton;
    this.settingsButton = composer.settingsButton;
    this.attachButton = composer.attachButton;
    this.agentModeButtonEl = composer.agentModeButton?.buttonEl || null;
    this.hideSystemButton = composer.hideSystemButton || null;
    // Render prompt selector chip
    const promptSlot = (composer as any).promptSlot as HTMLDivElement;
    if (promptSlot) {
      this.promptChip = createPromptChip(promptSlot, {
        currentPromptName: this.selectedPromptName,
        onClick: () => this.openPromptSelector(),
      });
    }

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
      this.app.workspace.on("systemsculpt:settings-updated", () => this.handleSettingsUpdated())
    );
  }

  /**
       * React to a global settings change. Refresh the generating-state UI and
       * re-sync the composer toggles whose active state follows
   * a per-chat value with a global-default fallback — a chat that follows the
   * global default (per-chat value unset) would otherwise show a stale toggle
   * after the global setting changes (#210, #213).
   */
  public handleSettingsUpdated(): void {
    this.updateGeneratingState();
    this.syncAgentModeButton();
    this.syncHideSystemMessagesButton();
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
    this.abortActiveTurn();

    // Don't force scroll when user stops generation - respect their current position
    // this.scrollManager.resetScrollState();
  }

  /**
   * Abort the in-flight chat turn (if any), aborting its stream's AbortController.
   *
   * Safe to call when no turn is active: ChatTurnLifecycleController.stop() is
   * idempotent and never throws. This is the canonical teardown hook — the Stop
   * button, the input handler's own dispose path, and ChatView.onClose() all go
   * through it so any route that ends a turn aborts the stream (BUG-03).
   */
  public abortActiveTurn(): Promise<void> {
    return this.turnLifecycle?.stop() ?? Promise.resolve();
  }

  private async handleSendMessage(overrides?: {
    includeContextFiles?: boolean;
    focusAfterSend?: boolean;
    rethrowErrors?: boolean;
  }): Promise<void> {
    if (this.submissionReserved) {
      throw new ChatTurnAlreadyActiveError("reserved");
    }
    if (this.localResourcesDisposed || this.localResourcesDisposing) {
      return;
    }
    if (this.turnLifecycle?.isActive()) {
      await this.turnLifecycle.runTurn(async () => {});
      return;
    }

    const reservationGeneration = ++this.submissionReservationGeneration;
    this.submissionReserved = true;
    const reservation = this.handleReservedSendMessage(reservationGeneration, overrides);
    this.submissionReservationPromise = reservation;
    try {
      await reservation;
    } finally {
      if (this.submissionReservationGeneration === reservationGeneration) {
        this.submissionReserved = false;
      }
      if (this.submissionReservationPromise === reservation) {
        this.submissionReservationPromise = null;
      }
    }
  }

  private async handleReservedSendMessage(reservationGeneration: number, overrides?: {
    includeContextFiles?: boolean;
    focusAfterSend?: boolean;
    rethrowErrors?: boolean;
  }): Promise<void> {
    const candidateMessageId = this.generateMessageId();
    const originalInputValue = this.input.value;
    const originalPendingLargeText = this.pendingLargeTextContent;
    const candidateText = originalInputValue.trim();
    if (!candidateText) return;
    if (!this.isChatReady()) return;
    if (this.chatView?.isLegacyReadOnlyChat?.()) return;

    if (this.webSearchEnabled) {
      this.compatibilityResult = Object.freeze({ kind: "contract_unsupported", feature: "web_search", action: "disable_web_search" });
      return;
    }
    this.compatibilityResult = null;
    const admission = await this.managedChatAdmission.acquireChatTurnLease();
    if (admission.outcome !== "allowed") {
      await this.handleManagedAdmissionDenied(admission.outcome);
      return;
    }
    const managedLease: ManagedAllowedLease = admission.lease;
    if (
      reservationGeneration !== this.submissionReservationGeneration ||
      this.localResourcesDisposed ||
      this.localResourcesDisposing
    ) {
      return;
    }

    let consumedLargeText = false;
    let userCommitted = false;
    let messageText = candidateText;
    if (originalPendingLargeText && LargeTextHelpers.containsPlaceholder(messageText)) {
      const placeholderRegex = /\[PASTED TEXT - \d+ LINES OF TEXT\]/g;
      messageText = messageText.replace(placeholderRegex, originalPendingLargeText);
      consumedLargeText = true;
    }

    const includeContextFiles = overrides?.includeContextFiles ?? true;
    const submittedRawText = messageText;
    if (consumedLargeText) {
      this.pendingLargeTextContent = null;
    }

    try {
      const userMessage: ChatMessage = { role: "user", content: messageText, message_id: candidateMessageId };
      const intent = this.pendingSubmissionIntent;
      const commitInput: AcceptedUserCommitInput = intent.kind === "resend" ? { ...intent, message: userMessage } : { kind: "append", message: userMessage };
      const accepted = await this.commitAcceptedUserMessage(commitInput);
      userCommitted = true;
      if (!this.claimAcceptedUserCommit(accepted) || accepted.status !== "accepted_current") return;
      const durableTurnId = String(accepted.message.message_id || "").trim();
      if (!durableTurnId) throw new Error("Accepted chat operation requires a durable turn ID.");
      this.pendingSubmissionIntent = Object.freeze({ kind: "append" });
      const operationBase = {
        durableTurnId,
        acceptedUserMessage: accepted.message,
        initialDurableSnapshot: accepted.snapshot,
        turnBoundaryId: candidateMessageId,
      } as const;
      const acceptedOperation: AcceptedChatOperation = Object.freeze({
        ...operationBase,
        runtime: "managed",
        lease: managedLease,
      });
      this.acceptedOperation = acceptedOperation;
      const acceptedContextFiles = includeContextFiles ? this.chatView.contextManager.getContextFiles() : new Set<string>();
      let acceptedPrompt: string | undefined;
      if (this.selectedPromptPath) acceptedPrompt = await this.promptService.readPromptContent(this.selectedPromptPath) || undefined;
      this.acceptedRequestSnapshot = await this.aiService.prepareAcceptedChatRequest(acceptedOperation, {
        contextFiles: acceptedContextFiles,
        systemPromptOverride: acceptedPrompt,
        allowTools: this.chatView?.isAgentModeActive?.() ?? true,
      });
      this.submittedInputSnapshot = { messageId: durableTurnId, rawText: submittedRawText };
      this.input.value = "";
      this.adjustInputHeight();
      this.turnLifecycle = new ChatTurnLifecycleController({ getIsGenerating: () => this.isGenerating, setGenerating: (generating) => this.setGeneratingState(generating) });
      const lifecycleTurn = this.turnLifecycle.runTurn(async (signal) => {
        const streamWithProgress = async (
          turnSignal: AbortSignal,
          phase: "initial" | "continuation",
          retryCount: number,
          previous?: StreamTurnResult,
          postCheckpointSnapshot?: ChatTranscriptSnapshot,
          durableContinuationIndex?: number,
          fence?: ChatTurnFence,
        ): Promise<StreamTurnResult> => {
          const progress = new ChatTurnProgressController({
            showStreamingStatus: this.showStreamingStatus.bind(this),
            hideStreamingStatus: this.hideStreamingStatus.bind(this),
            updateStreamingStatus: this.updateStreamingStatus.bind(this),
          });
          progress.begin();
          try {
            progress.setStatus(retryCount > 0 ? "retrying" : "preparing");
            return await this.streamAssistantTurn(acceptedOperation, turnSignal, progress, {
              phase,
              postCheckpointSnapshot,
              durableContinuationIndex,
              fence,
            });
          } finally {
            progress.end();
          }
        };
        const turn = new ChatTurn({
          signal,
          acceptedOperation,
          commitAssistant: async (message, fence) => {
            if (signal.aborted || !fence.isOpen(acceptedOperation)) return;
            if (typeof this.chatView?.persistAssistantMessage === "function") {
              await this.chatView.persistAssistantMessage(message, { operation: "assistant_commit" });
              if (signal.aborted || !fence.isOpen(acceptedOperation)) return;
              await this.renderPersistedAssistantMessage(message);
            } else {
              await this.onAssistantResponse(message);
              if (signal.aborted || !fence.isOpen(acceptedOperation)) return;
            }
          },
          runInitialStream: (operation, retryCount, turnSignal, fence) => {
            if (operation !== acceptedOperation) throw new Error("Chat turn operation identity changed before initial stream.");
            return streamWithProgress(turnSignal, "initial", retryCount, undefined, undefined, undefined, fence);
          },
          shouldContinueTools: (result) => this.shouldContinueHostedToolLoop(result.message, result.stopReason),
          requestToolApproval: async (toolCall, turnSignal, fence) => {
            if (turnSignal.aborted || !fence.isOpen(acceptedOperation)) return false;
            const approved = await this.confirmHostedToolExecution(toolCall);
            if (turnSignal.aborted || !fence.isOpen(acceptedOperation)) return false;
            if (!approved) {
              toolCall.state = "failed";
              toolCall.executionCompletedAt = Date.now();
              toolCall.result = {
                success: false,
                error: { code: "USER_DENIED", message: "The user denied this tool execution." },
              };
            }
            return approved;
          },
          executeTool: (toolCall, turnSignal, fence) => {
            if (turnSignal.aborted || !fence.isOpen(acceptedOperation)) return Promise.resolve();
            return this.executeHostedToolCall(toolCall, turnSignal, fence, acceptedOperation);
          },
          commitToolCheckpoint: async (message, fence, outcomeUnknown) => {
            if ((!outcomeUnknown && signal.aborted) || !fence.isOpen(acceptedOperation)) return;
            if (typeof this.chatView?.persistAssistantMessage === "function") {
              await this.chatView.persistAssistantMessage(message, { operation: "tool_checkpoint" });
            } else {
              await this.persistAssistantResponse(message);
            }
            if ((!outcomeUnknown && signal.aborted) || !fence.isOpen(acceptedOperation)) return;
          },
          renderToolCheckpoint: (message, fence) => !signal.aborted && fence.isOpen(acceptedOperation)
            ? this.renderPersistedAssistantMessage(message, { forceRerender: true })
            : Promise.resolve(),
          readDurableSnapshot: async () => this.chatView.getDurableTranscriptSnapshot(),
          runContinuationStream: (operation, retryCount, turnSignal, previous, postCheckpointSnapshot, durableContinuationIndex, fence) => {
            if (operation !== acceptedOperation) throw new Error("Chat turn operation identity changed before continuation.");
            return streamWithProgress(
              turnSignal,
              "continuation",
              retryCount,
              previous,
              postCheckpointSnapshot,
              durableContinuationIndex,
              fence,
            );
          },
          retryEmptyStream: false,
          onTerminal: (_outcome, operation) => {
            this.chatView.getCurrentRuntimeAdapter().notifyDurablyTerminal(operation);
          },
          onInitialRetryExhausted: (latest) => this.failHostedToolTurn(
            "The hosted agent returned an empty response.", 502, {
              reason: "empty-response", emptyInitialRetries: 2,
              latestStreamCompletionState: latest.completionState, committedPhase: "submitted_user",
            },
          ),
          onContinuationRetryExhausted: (latest, emptyContinuationRetries, previous) => this.failHostedToolTurn(
            "The hosted agent returned an empty continuation after tool execution.", 502, {
              reason: "empty-continuation", emptyContinuationRetries,
              latestStreamCompletionState: latest.completionState,
              committedAssistantMessageId: previous.messageId,
              committedPhase: "tool_execution_committed",
              completedToolCount: (previous.message.tool_calls || []).filter(
                (toolCall) => toolCall.state === "completed" || toolCall.state === "failed"
              ).length,
            },
          ),
          onMaxContinuationDepth: (maxToolContinuationRounds) => this.failHostedToolTurn(
            "The hosted agent exceeded the maximum tool continuation depth.", 500,
            { reason: "max-tool-continuation-depth", maxToolContinuationRounds },
          ),
        });
        await turn.run(accepted.message as ChatMessage);
        void this.chatView.refreshCreditsBalance();
      });
      if (this.submissionReservationGeneration !== reservationGeneration) {
        return;
      }
      this.submissionReserved = false;
      this.submissionReservationPromise = null;
      try {
        await lifecycleTurn;
      } finally {
        this.releaseAcceptedRequestIfTerminal();
      }
    } catch (err) {
      this.releaseAcceptedRequestIfTerminal();
      if (!userCommitted) {
        this.input.value = originalInputValue;
        this.pendingLargeTextContent = originalPendingLargeText;
        this.adjustInputHeight();
      }
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
          metadata: { runtime: "managed" },
        });
      } catch {}

      if (overrides?.rethrowErrors) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(String(err ?? "Unknown chat turn failure"));
      }
    } finally {
      this.submittedInputSnapshot = null;
      if (overrides?.focusAfterSend !== false) {
        this.focus();
      }
      await this.chatView.contextManager.validateAndCleanContextFiles();
    }
  }

  public setPendingResendIntent(identity: { targetMessageId: string; expectedIndex: number; expectedVersion: number }): void {
    this.pendingSubmissionIntent = Object.freeze({ kind: "resend", ...identity });
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
      // Set the value directly.
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

  // Keep the composer agent-mode toggle's active state in sync with the per-chat
  // value owned by ChatView (e.g. restored on chat load) (#210/#149/#185).
  public syncAgentModeButton(): void {
    if (!this.agentModeButtonEl) return;
    const active = this.chatView?.isAgentModeActive?.() ?? true;
    this.agentModeButtonEl.classList.toggle("ss-active", active);
  }

  // Keep the composer toggle in sync when the per-chat preference changes outside
  // a click (e.g. restored on chat load) (#213/#174/#167).
  public syncHideSystemMessagesButton(): void {
    if (!this.hideSystemButton) return;
    const hidden = this.chatView?.isSystemNoiseHidden?.() ?? false;
    this.hideSystemButton.setIcon(hidden ? "eye-off" : "eye");
    this.hideSystemButton.setTooltip(hidden ? "Show system & tool messages" : "Hide system & tool messages");
    this.hideSystemButton.buttonEl?.classList.toggle("ss-active", hidden);
  }

  public getSelectedPromptPath(): string | null {
    return this.selectedPromptPath;
  }

  public setSelectedPromptPath(path: string | null): void {
    this.selectedPromptPath = path;
    this.selectedPromptName = path
      ? path.split("/").pop()?.replace(/\.md$/, "") || null
      : null;
    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }
  }

  private releaseAcceptedRequestIfTerminal(): void {
    const operation = this.acceptedOperation;
    if (!operation || (this.turnLifecycle && this.turnLifecycle.getState() !== "terminal")) return;
    this.aiService.releaseAcceptedChatRequest(operation);
    if (this.acceptedOperation === operation) {
      this.acceptedOperation = null;
      this.acceptedRequestSnapshot = null;
    }
  }

  public resetForFreshChat(): void {
    this.releaseAcceptedRequestIfTerminal();
    this.pendingLargeTextContent = null;
    this.webSearchEnabled = false;
    this.syncAgentModeButton();
    this.selectedPromptPath = this.plugin.settings.lastUsedPromptPath || null;
    this.selectedPromptName = this.selectedPromptPath
      ? this.selectedPromptPath.split("/").pop()?.replace(/\.md$/, "") || null
      : null;
    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }
    this.automationApprovalMode = "interactive";
    this.setValue("", { focus: false });
  }

  private async openPromptSelector(): Promise<void> {
    const prompts = await this.promptService.listPrompts();

    const items: ListItem[] = [
      { id: "__none__", title: "None", description: "No custom system prompt", icon: "x" },
      ...prompts.map((p) => ({
        id: p.path,
        title: p.name,
        description: p.description,
        icon: p.icon || "scroll-text",
        selected: p.path === this.selectedPromptPath,
      })),
      { id: "__create__", title: "Create new prompt...", icon: "plus" },
    ];

    const modal = new ListSelectionModal(this.app, items, {
      title: "System Prompt",
      placeholder: "Search prompts...",
    });

    const selected = await modal.openAndGetSelection();
    if (!selected.length) return;

    const item = selected[0];
    if (item.id === "__none__") {
      this.selectedPromptPath = null;
      this.selectedPromptName = null;
    } else if (item.id === "__create__") {
      void this.createNewPrompt();
      return;
    } else {
      this.selectedPromptPath = item.id;
      this.selectedPromptName = item.title;
    }

    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }

    this.plugin.settings.lastUsedPromptPath = this.selectedPromptPath || "";
    void this.plugin.saveSettings();
  }

  private async createNewPrompt(): Promise<void> {
    const { path, name } = await this.promptService.createPrompt("New Prompt");
    this.selectedPromptPath = path;
    this.selectedPromptName = name;
    if (this.promptChip) {
      updatePromptChip(this.promptChip, this.selectedPromptName);
    }
    this.plugin.settings.lastUsedPromptPath = path;
    void this.plugin.saveSettings();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      await this.app.workspace.openLinkText(path, "", true);
    }
  }

  public disposeLocalResources(): Promise<void> {
    if (this.localResourcesDisposed) {
      return Promise.resolve();
    }
    if (this.localResourceDisposalPromise) {
      return this.localResourceDisposalPromise;
    }

    this.localResourcesDisposing = true;
    this.submissionReservationGeneration = (this.submissionReservationGeneration || 0) + 1;
    this.submissionReserved = false;
    const reservedPreflight = this.submissionReservationPromise;
    this.submissionReservationPromise = null;

    const cleanup = () => {
      if (this.localResourcesDisposed) return;
      this.releaseAcceptedRequestIfTerminal();
      this.localResourcesDisposed = true;
      this.localResourcesDisposing = false;

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
    };

    const terminal = this.abortActiveTurn();
    let disposal: Promise<void>;
    if (!reservedPreflight && (!this.turnLifecycle || this.turnLifecycle.getState() === "terminal")) {
      cleanup();
      disposal = Promise.resolve();
    } else {
      const reservedSettlement = reservedPreflight
        ? reservedPreflight.then(() => undefined, () => undefined)
        : Promise.resolve();
      disposal = Promise.all([reservedSettlement, terminal]).then(() => undefined).finally(cleanup);
    }
    this.localResourceDisposalPromise = disposal;
    void disposal.then(
      () => { if (this.localResourceDisposalPromise === disposal) this.localResourceDisposalPromise = null; },
      () => { if (this.localResourceDisposalPromise === disposal) this.localResourceDisposalPromise = null; },
    );
    return disposal;
  }

  public unload(): void {
    void this.disposeLocalResources().then(
      () => super.unload(),
      () => super.unload(),
    );
  }

  public onunload(): void {
    void this.disposeLocalResources().catch(() => {});
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

  public peekSubmittedInputSnapshot(): Readonly<{ messageId: string; rawText: string }> | null {
    return this.submittedInputSnapshot;
  }

  public clearSubmittedInputSnapshot(expectedMessageId: string): boolean {
    if (this.submittedInputSnapshot?.messageId !== expectedMessageId) return false;
    this.submittedInputSnapshot = null;
    return true;
  }

  public consumeSubmittedInputSnapshot(): { messageId: string; rawText: string } | null {
    const snapshot = this.peekSubmittedInputSnapshot();
    if (snapshot) this.clearSubmittedInputSnapshot(snapshot.messageId);
    return snapshot ? { ...snapshot } : null;
  }

  /**
   * Extract annotations from the response text
   * This method parses markdown links in the format [domain](url) and extracts them as citations
   * Based on the managed gateway response format observed in logs.
   */
  private extractAnnotationsFromResponse(responseText: string): Annotation[] {
    return extractAnnotationsFromResponseExternal(responseText);
  }

  /**
   * Clean up any remaining status indicators to prevent memory leaks
   */
  private cleanupAllStatusIndicators(): void {
    // Clean up any status indicators that might still be in the chat container
    this.chatContainer?.querySelectorAll('.systemsculpt-streaming-status, .ss-streaming-indicator').forEach(el => {
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

  private async handleManagedAdmissionDenied(
    outcome: Exclude<ManagedAdmissionOutcome, "allowed">,
  ): Promise<void> {
    if (outcome === "license_required" || outcome === "license_rejected") {
      const message = outcome === "license_required"
        ? "Activate your SystemSculpt license in Account before starting a chat."
        : "Your SystemSculpt license was rejected. Check Account before starting a chat.";
      if (this.isAutomationRequestActive()) throw new Error(message);
      if (typeof this.chatView?.promptAccountSetup === "function") {
        await this.chatView.promptAccountSetup(message);
      } else {
        await promptChatAccountSetup({
          app: this.app,
          openAccount: () => this.plugin.openSettingsTab("account"),
          message,
        });
      }
      return;
    }

    const message =
      outcome === "rate_limited"
        ? "SystemSculpt is rate-limited. Try again in a moment."
        : outcome === "capability_unavailable"
          ? "SystemSculpt Chat is unavailable right now."
          : "SystemSculpt is temporarily unavailable. Try again in a moment.";
    if (this.isAutomationRequestActive()) {
      throw new Error(message);
    }
    new Notice(message, 8000);
  }
}
