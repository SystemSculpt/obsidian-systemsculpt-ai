import { ItemView, WorkspaceLeaf, TFile, Notice, App, MarkdownRenderer, Component } from "obsidian";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { SystemSculptService, type CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import { ChatMessage, ChatRole, MultiPartContent } from "../../types";
import { ChatStorageService } from "./ChatStorageService";
import { ScrollManagerService } from "./ScrollManagerService";
import type SystemSculptPlugin from "../../main";
import { showPopup, showAlert } from "../../core/ui/";
import { SystemSculptError, isContextOverflowErrorMessage, ERROR_CODES, isManagedLicenseFailure } from "../../utils/errors";
import { SYSTEMSCULPT_WEBSITE } from "../../constants/externalServices";
import { openExternalUrl } from "../../utils/externalUrl";
import { MessageRenderer } from "./MessageRenderer";
import { InputHandler, type AutomationApprovalMode } from "./InputHandler";
import { FileContextManager } from "./FileContextManager";
import { generateDefaultChatTitle, sanitizeChatTitle } from "../../utils/titleUtils";

import { errorLogger } from "../../utils/errorLogger";
import { AGENT_PRESET } from "../../constants/prompts";
import { ChatExportService } from "./export/ChatExportService";
import type { ChatExportOptions } from "../../types/chatExport";
import type { ChatExportResult } from "./export/ChatExportTypes";
import { removeMessageElement } from "./utils/MessageGrouping";
import { classifyQuotaExceededError } from "./utils/quotaError";
import { classifyStreamError, type StreamErrorKind } from "./utils/streamError";
import { ChatErrorModal } from "./modals/ChatErrorModal";
import type { ToolCall } from "../../types/toolCalls";
import { TOOL_LOOP_ERROR_CODE } from "../../utils/tooling";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import type { DocumentProcessingProgressEvent } from "../../types/documentProcessing";
import { ChatDebugLogService } from "./ChatDebugLogService";
import { detectLoadedChatBackend, type ChatBackend } from "./storage/ChatPersistenceTypes";
import { ChatIdAllocationError, ChatIdAllocator } from "./persistence/ChatIdAllocator";
import { ChatPersistenceError, type ChatPersistenceOperation } from "./persistence/ChatPersistenceError";
import { ChatTranscript } from "./transcript/ChatTranscript";
import type { ChatTranscriptStorage } from "./transcript/ChatTranscriptStorage";
import type { ChatTranscriptSnapshot } from "./transcript/ChatTranscriptTypes";
import type { AcceptedChatOperation, ManagedChatAdmissionPort } from "../../services/managed/ManagedTypes";
import { ManagedChatRuntimeAdapter } from "./turn/ManagedChatRuntimeAdapter";
import { CurrentRuntimeAdapter } from "./turn/CurrentRuntimeAdapter";
import type { ChatTurnFence } from "./turn/ChatTurnEffects";

import { uiSetup } from "./uiSetup";
import { messageHandling } from "./messageHandling";
import { eventHandling } from "./eventHandling";
import { chatSettingsHandling } from "./chatSettingsHandling";
import { renderChatStatusSurface } from "./ui/ChatStatusSurface";
import {
  openChatAccount,
  promptChatAccountSetup,
  type ChatAccountSetupPromptOverrides,
} from "./ChatAccountSetup";

export { CHAT_VIEW_TYPE };

function escapeMessageIdForSelector(messageId: string): string {
  const cssEscape = (globalThis as any)?.CSS?.escape;
  if (typeof cssEscape === "function") {
    return cssEscape(messageId);
  }

  return String(messageId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type ChatSaveOptions = NonNullable<Parameters<ChatStorageService["saveChat"]>[2]>;
export type AcceptedUserCommitInput =
  | Readonly<{ kind: "append"; message: ChatMessage }>
  | Readonly<{ kind: "resend"; message: ChatMessage; targetMessageId: string; expectedIndex: number; expectedVersion: number }>;
export type ChatOwnershipToken = Readonly<{ transcriptIdentity: object; generation: number; originalChatId: string; acceptedChatId: string }>;
export type AcceptedUserCommitResult =
  | Readonly<{ status: "accepted_current"; snapshot: ChatTranscriptSnapshot; message: Readonly<ChatMessage>; ownership: ChatOwnershipToken }>
  | Readonly<{ status: "accepted_not_current"; snapshot: ChatTranscriptSnapshot; message: Readonly<ChatMessage> }>;

export class ChatView extends ItemView {
  public readonly messages: readonly ChatMessage[] = [];
  public aiService: SystemSculptService;
  public chatStorage: ChatStorageService;
  public chatContainer: HTMLElement;
  public inputHandler: InputHandler;
  public plugin: SystemSculptPlugin;
  public chatId: string;
  public systemPromptIndicator: HTMLElement;
  public creditsIndicator: HTMLElement;
  public isGenerating = false;
  public creditsBalance: CreditsBalanceSnapshot | null = null;
  private creditsBalanceRefreshPromise: Promise<void> | null = null;
  public contextManager: FileContextManager;
  public scrollManager: ScrollManagerService;
  public isFullyLoaded = false; // Track when chat is fully loaded
  public messageRenderer: MessageRenderer;
  public chatTitle: string;
  public chatVersion: number = 0;
  public currentPrompt?: string;
  public chatBackend: ChatBackend;
  /** Tools trusted for this chat session (cleared on chat reload/close) */
  private dragDropCleanup: (() => void) | null = null;
  public chatFontSize: "small" | "medium" | "large";
  // Per-chat override for hiding SystemSculpt system + tool messages (#213/#174/#167).
  // undefined = follow the global `hideSystemMessagesInChat` setting.
  public hideSystemMessages: boolean | undefined;
  // Per-chat override for agent mode (#210/#149/#185).
  // undefined = follow the global `agentModeEnabled` setting.
  public agentModeEnabled: boolean | undefined;
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
  private readonly VIRTUAL_BATCH_SIZE: number = 20; // How many messages to load at a time
  private hasAdjustedInitialWindow: boolean = false;
  private renderEpoch: number = 0;
  private loadEpoch: number = 0;
  private chatOwnershipGeneration: number = 0;
  private activeLoad: { chatId: string; promise: Promise<void> } | null = null;
  private chatTranscript: ChatTranscript | null = null;
  private currentRuntimeAdapter: CurrentRuntimeAdapter | null = null;
  private resourcesDisposed = false;
  private resourceDisposalPromise: Promise<void> | null = null;

  // Explicitly re-declare core ItemView fields for clarity / type checking
  declare app: App;
  declare leaf: WorkspaceLeaf;
  declare register: Component["register"];
  declare registerDomEvent: Component["registerDomEvent"];

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.app = plugin.app;
    
    // Use singleton instance instead of creating new one
    this.aiService = SystemSculptService.getInstance(plugin);

    // Get the initial state from the leaf if it exists
    const state = this.leaf.getViewState();
    const initialState = (state?.state as {
        chatId?: string;
        chatTitle?: string;
        selectedModelId?: string;
        version?: number;
        chatFontSize?: "small" | "medium" | "large";
        chatBackend?: ChatBackend;
        hideSystemMessages?: boolean;
        agentModeEnabled?: boolean;
    }) || {};

    this.chatId = initialState.chatId || "";

    // Initialize the chat title
    this.initializeChatTitle(initialState.chatTitle);

    this.isGenerating = false;
    this.isFullyLoaded = false; // Start as not loaded

    // Use -1 as uninitialized state to distinguish from actual version 0
    this.chatVersion = initialState.version !== undefined ? initialState.version : -1;
    this.chatBackend = this.defaultChatBackend();
    this.applyChatLeafState({
      chatBackend: initialState.chatBackend,
      legacyModelId: initialState.selectedModelId,
    });

    this.ensureCoreServicesReady();

    // Initialize chat font size from saved state or plugin settings
    this.chatFontSize = initialState.chatFontSize || (plugin.settings as any).chatFontSize || "medium";
    this.hideSystemMessages = initialState.hideSystemMessages;
    this.agentModeEnabled = initialState.agentModeEnabled;
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

    if (!this.debugLogService) {
      this.debugLogService = new ChatDebugLogService(this.plugin, this);
    }
  }

  private defaultChatBackend(): ChatBackend {
    return "systemsculpt";
  }

  private getActiveSystemPromptType(): "general-use" | "agent" {
    return "agent";
  }

  public getManagedChatAdmission(): ManagedChatAdmissionPort { return this.plugin.getManagedCapabilityClient(); }

  public getCurrentRuntimeAdapter(): CurrentRuntimeAdapter {
    if (!this.currentRuntimeAdapter) {
      this.currentRuntimeAdapter = new CurrentRuntimeAdapter(
        new ManagedChatRuntimeAdapter(this.plugin.getManagedCapabilityClient()),
      );
    }
    return this.currentRuntimeAdapter;
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
    this.refreshChatStatusIfEmpty();
    void this.refreshCreditsBalance();
  }
  updateSystemPromptIndicator = () => uiSetup.updateSystemPromptIndicator(this);
  updateCreditsIndicator = () => uiSetup.updateCreditsIndicator(this);
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


  private getChatSaveOptions(overrides?: Partial<ChatSaveOptions>): ChatSaveOptions {
    return {
      contextFiles: this.contextManager?.getContextFiles() || new Set<string>(),
      title: this.chatTitle,
      chatFontSize: this.chatFontSize,
      selectedPromptPath: this.inputHandler?.getSelectedPromptPath?.() || "",
      agentModeEnabled: this.agentModeEnabled,
      hideSystemMessages: this.hideSystemMessages,
      ...overrides,
    };
  }

  private transcriptStorage(): ChatTranscriptStorage {
    return {
      load: async (chatId) => {
        const loaded = await this.chatStorage.loadChat(chatId);
        return loaded ? {
          chatId,
          version: loaded.version || 0,
          messages: loaded.messages || [],
          readOnly: loaded.chatBackend === "legacy",
        } : null;
      },
      save: async (chatId, messages) => {
        if (Object.prototype.hasOwnProperty.call(this, "saveChat")) {
          await this.saveChat();
          return { version: this.chatVersion };
        }
        const saved = await this.chatStorage.saveChat(chatId, [...messages], this.getChatSaveOptions());
        return { version: saved.version };
      },
      createExclusive: async (chatId, messages) => {
        if (Object.prototype.hasOwnProperty.call(this, "saveChat")) {
          await this.saveChat();
          return { version: this.chatVersion };
        }
        return this.chatStorage.createChatExclusive(chatId, [...messages], this.getChatSaveOptions());
      },
    };
  }

  private ensureChatTranscript(): ChatTranscript {
    if (!this.chatTranscript || this.chatTranscript.snapshot().chatId !== this.chatId) {
      this.chatTranscript = ChatTranscript.fromSnapshot(this.transcriptStorage(), {
        chatId: this.chatId,
        version: Math.max(0, this.chatVersion),
        messages: this.messages,
      });
    }
    return this.chatTranscript;
  }

  private async waitForLegacyPersistenceIdle(): Promise<void> {
    await this.inputHandler?.waitForPersistenceIdle?.();
  }

  private projectTranscript(): void {
    const transcript = this.chatTranscript || this.ensureChatTranscript();
    const accepted = transcript.snapshot();
    // The sole projection adapter: callers receive a frozen readonly snapshot.
    // @ts-expect-error Transcript ownership intentionally centralizes this readonly field assignment.
    this.messages = accepted.messages;
    this.chatId = accepted.chatId;
    this.chatVersion = accepted.version;
    this.isFullyLoaded = true;
  }

  private async persistCandidate(
    candidate: ChatMessage[],
    operation: ChatPersistenceOperation,
    requestedChatId: string = this.chatId,
  ): Promise<{ chatId: string; version: number }> {
    // Unit harnesses historically replace saveChat on the instance. Preserve
    // that public seam without using it in real ChatView instances.
    if (Object.prototype.hasOwnProperty.call(this, "saveChat")) {
      try {
        await this.saveChat();
        return { chatId: requestedChatId || this.chatId, version: this.chatVersion };
      } catch (cause) {
        throw new ChatPersistenceError({ operation, chatId: requestedChatId || this.chatId, cause });
      }
    }

    if (!requestedChatId) {
      try {
        const allocator = new ChatIdAllocator((chatId) =>
          this.chatStorage.createChatExclusive(chatId, candidate, this.getChatSaveOptions())
        );
        const allocated = await allocator.allocate();
        return { chatId: allocated.chatId, version: allocated.value.version };
      } catch (cause) {
        const allocationError = cause instanceof ChatIdAllocationError ? cause : null;
        throw new ChatPersistenceError({
          operation,
          chatId: allocationError?.chatId || "",
          cause: allocationError?.cause || cause,
        });
      }
    }

    try {
      const saved = await this.chatStorage.saveChat(requestedChatId, candidate, this.getChatSaveOptions());
      return { chatId: requestedChatId, version: saved.version };
    } catch (cause) {
      throw new ChatPersistenceError({ operation, chatId: requestedChatId, cause });
    }
  }

  public async saveChat(): Promise<void> {
    this.ensureCoreServicesReady();
    if (!this.isFullyLoaded && this.chatId) return;

    const hasContent = this.messages.length > 0 || (this.contextManager?.getContextFiles().size || 0) > 0;
    if (!this.chatId && !hasContent) {
      this.updateViewState();
      return;
    }

    const saved = await this.persistCandidate([...this.messages], "flush");
    const wasNew = !this.chatId;
    this.chatId = saved.chatId;
    this.chatVersion = saved.version || this.chatVersion;
    this.isFullyLoaded = true;
    if (wasNew && !this.chatTitle) this.initializeChatTitle();
    this.updateViewState();
  }

  private async recoverPersistedProjection(_chatId: string, _fallback: ChatMessage[]): Promise<void> {
    const transcript = this.ensureChatTranscript();
    await transcript.recover();
    this.projectTranscript();
    this.updateViewState();
    await messageHandling.reloadAllMessages(this);
  }

  public async recoverManagedChatConflict(
    operation: AcceptedChatOperation,
    signal: AbortSignal,
    fence: ChatTurnFence,
  ): Promise<boolean> {
    if (operation.initialDurableSnapshot.chatId !== this.chatId) return false;
    if (signal.aborted || !fence.isOpen(operation)) return false;
    const transcript = this.ensureChatTranscript();
    await transcript.recover();
    if (signal.aborted || !fence.isOpen(operation)) return false;
    const recoveryWon = fence.claimTerminal("transport_failed");
    if (!recoveryWon) return false;
    this.projectTranscript();
    this.updateViewState();
    await messageHandling.reloadAllMessages(this);
    return true;
  }

  public async addMessageToHistory(message: ChatMessage): Promise<void> {
    if (this.messages.some((entry) => entry.message_id === message.message_id)) return;
    await this.waitForLegacyPersistenceIdle();
    const transcript = this.ensureChatTranscript();
    const operation: ChatPersistenceOperation = message.role === "tool" ? "tool_checkpoint" : "assistant_commit";
    const candidate = operation === "tool_checkpoint"
      ? transcript.candidateTools(message)
      : transcript.candidateAssistant(message);
    const saved = await transcript.commit(candidate);
    this.projectTranscript();
    try {
      (this.app.workspace as any)?.trigger?.("systemsculpt:chat-message-added", this.chatId);
      this.updateViewState();
    } catch (projectionError) {
      await this.recoverPersistedProjection(saved.chatId, transcript.mutableMessages());
    }
  }

  public async persistSubmittedUserMessage(message: ChatMessage): Promise<void> {
    await this.commitAcceptedUserMessage({ kind: "append", message });
  }

  public async commitAcceptedUserMessage(input: AcceptedUserCommitInput): Promise<AcceptedUserCommitResult> {
    const transcript = this.ensureChatTranscript();
    const generation = this.chatOwnershipGeneration;
    const originalChatId = this.chatId;
    await this.waitForLegacyPersistenceIdle();
    const existingMessage = transcript.snapshot().messages.find((entry) => entry.message_id === input.message.message_id);
    const accepted = await transcript.commitAcceptedUser(input);
    if (this.chatTranscript !== transcript || this.chatOwnershipGeneration !== generation || this.chatId !== originalChatId) {
      return Object.freeze({ status: "accepted_not_current", snapshot: accepted.snapshot, message: accepted.message });
    }
    this.projectAcceptedTranscriptSnapshot(accepted.snapshot);
    const ownership = Object.freeze({ transcriptIdentity: transcript, generation, originalChatId, acceptedChatId: accepted.snapshot.chatId });
    try {
      this.updateViewState();
      if (!existingMessage) (this.app.workspace as any)?.trigger?.("systemsculpt:chat-message-added", this.chatId);
      await this.addMessage(accepted.message.role, accepted.message.content, accepted.message.message_id, accepted.message as ChatMessage);
    } catch {
      if (this.isAcceptedUserCommitCurrentToken(ownership)) {
        await this.recoverPersistedProjection(accepted.snapshot.chatId, transcript.mutableMessages());
      }
    }
    return Object.freeze({ status: "accepted_current", snapshot: accepted.snapshot, message: accepted.message, ownership });
  }

  public getDurableTranscriptSnapshot(): ChatTranscriptSnapshot {
    return this.ensureChatTranscript().snapshot();
  }

  private projectAcceptedTranscriptSnapshot(accepted: ChatTranscriptSnapshot): void {
    // @ts-expect-error Transcript ownership intentionally centralizes this readonly field assignment.
    this.messages = accepted.messages;
    this.chatId = accepted.chatId;
    this.chatVersion = accepted.version;
    this.isFullyLoaded = true;
  }

  private isAcceptedUserCommitCurrentToken(token: ChatOwnershipToken): boolean {
    return this.chatTranscript === token.transcriptIdentity
      && this.chatOwnershipGeneration === token.generation
      && this.chatId === token.acceptedChatId;
  }

  public claimAcceptedUserCommit(result: AcceptedUserCommitResult): result is Extract<AcceptedUserCommitResult, { status: "accepted_current" }> {
    return result.status === "accepted_current" && this.isAcceptedUserCommitCurrentToken(result.ownership);
  }

  public getPendingResendIdentity(messageId: string): { targetMessageId: string; expectedIndex: number; expectedVersion: number } | null {
    const snapshot = this.ensureChatTranscript().snapshot();
    const expectedIndex = snapshot.messages.findIndex((entry) => entry.message_id === messageId && entry.role === "user");
    return expectedIndex < 0 ? null : { targetMessageId: messageId, expectedIndex, expectedVersion: snapshot.version };
  }

  private mergeAssistantToolCalls(existingToolCalls: ToolCall[] = [], nextToolCalls: ToolCall[] = []): ToolCall[] | undefined {
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

  public upsertAssistantMessage(message: ChatMessage): ChatMessage {
    const transcript = this.ensureChatTranscript();
    transcript.previewAssistant(message);
    this.projectTranscript();
    return this.messages.find((entry) => entry.message_id === message.message_id) as ChatMessage;
  }

  public async persistAssistantMessage(
    message: ChatMessage,
    options?: { operation?: "assistant_commit" | "tool_checkpoint" }
  ): Promise<ChatMessage> {
    await this.waitForLegacyPersistenceIdle();
    const existingIndex = this.messages.findIndex((entry) => entry.message_id === message.message_id);
    const existing = existingIndex >= 0 ? this.messages[existingIndex] : undefined;
    const mergedMessage: ChatMessage = existing ? {
      ...existing,
      ...message,
      content: message.content !== undefined ? message.content : existing.content,
      reasoning: message.reasoning || existing.reasoning,
      annotations: message.annotations || existing.annotations,
      tool_calls: this.mergeAssistantToolCalls(existing.tool_calls || [], message.tool_calls || []),
      messageParts: message.messageParts || existing.messageParts,
      reasoning_details: (message as any).reasoning_details || (existing as any).reasoning_details,
    } : message;
    const candidate = [...this.messages];
    if (existingIndex >= 0) candidate[existingIndex] = mergedMessage;
    else candidate.push(mergedMessage);

    const operation: ChatPersistenceOperation = options?.operation
      ?? (mergedMessage.tool_calls?.length ? "tool_checkpoint" : "assistant_commit");
    const transcript = this.ensureChatTranscript();
    const transcriptCandidate = operation === "tool_checkpoint"
      ? transcript.candidateTools(mergedMessage)
      : transcript.candidateAssistant(mergedMessage);
    const saved = await transcript.commit(transcriptCandidate);
    this.projectTranscript();
    try {
      this.updateViewState();
      if (!existing) {
        (this.app.workspace as any)?.trigger?.("systemsculpt:chat-message-added", this.chatId);
      }
    } catch (projectionError) {
      await this.recoverPersistedProjection(saved.chatId, candidate);
    }

    return mergedMessage;
  }

  private shouldRecoverCommittedChatTurn(error: string | SystemSculptError): error is SystemSculptError {
    if (!(error instanceof SystemSculptError)) {
      return false;
    }

    return (
      error.metadata?.recoverCommittedTurn === true ||
      error.metadata?.errorCode === TOOL_LOOP_ERROR_CODE
    );
  }

  private removeUnpersistedAssistantDraft(messageId: string | undefined): void {
    const normalizedMessageId = String(messageId || "").trim();
    if (!normalizedMessageId || !this.chatContainer) {
      return;
    }

    const persisted = this.messages.some((message) => message.message_id === normalizedMessageId);
    if (persisted) {
      return;
    }

    const node = this.chatContainer.querySelector(
      `.systemsculpt-message[data-message-id="${escapeMessageIdForSelector(normalizedMessageId)}"]`,
    ) as HTMLElement | null;
    removeMessageElement(node);
  }

  private findCommittedAssistantMessage(messageId: string | undefined): ChatMessage | null {
    const normalizedMessageId = String(messageId || "").trim();
    if (normalizedMessageId) {
      const directMatch = this.messages.find(
        (message) => message.role === "assistant" && message.message_id === normalizedMessageId
      );
      if (directMatch) {
        return directMatch;
      }
    }

    return [...this.messages].reverse().find((message) => message.role === "assistant") || null;
  }

  private formatCommittedTurnFailureText(errorMessage: string, error: SystemSculptError): string {
    const completedToolCount = Number(error.metadata?.completedToolCount || 0);
    const keptTools =
      Number.isFinite(completedToolCount) && completedToolCount > 0
        ? ` The ${completedToolCount === 1 ? "completed tool result was" : `${completedToolCount} completed tool results were`} kept in the transcript.`
        : "";
    const cleanMessage = String(errorMessage || "The hosted agent did not return a usable continuation.")
      .trim()
      .replace(/[.!?]+$/g, "");

    return `SystemSculpt stopped after the turn was already in progress: ${cleanMessage}.${keptTools}`;
  }

  private appendFailurePart(message: ChatMessage, failureText: string): ChatMessage {
    const normalizedParts = this.messageRenderer.normalizeMessageToParts(message);
    const existingParts = Array.isArray(normalizedParts?.parts) ? [...normalizedParts.parts] : [];
    const alreadyMarked = existingParts.some(
      (part) =>
        part.type === "content" &&
        typeof part.data === "string" &&
        part.data.includes("SystemSculpt stopped after the turn was already in progress")
    );

    if (alreadyMarked) {
      return message;
    }

    const maxTimestamp = existingParts.reduce(
      (max, part) => Math.max(max, Number(part.timestamp || 0)),
      0
    );
    const timestamp = Math.max(Date.now(), maxTimestamp + 1);
    const separator = existingParts.length > 0 ? "\n\n" : "";
    const partText = `${separator}${failureText}`;
    const currentContent = typeof message.content === "string" ? message.content.trim() : "";

    return {
      ...message,
      content: currentContent ? `${currentContent}\n\n${failureText}` : failureText,
      messageParts: [
        ...existingParts,
        {
          id: `turn_failure-${timestamp}`,
          type: "content",
          timestamp,
          data: partText,
        },
      ],
    };
  }

  private async renderAssistantMessageUpdate(message: ChatMessage): Promise<void> {
    const messageId = String(message.message_id || "").trim();
    const messageEl = messageId && this.chatContainer
      ? this.chatContainer.querySelector(
          `.systemsculpt-message[data-message-id="${escapeMessageIdForSelector(messageId)}"]`
        ) as HTMLElement | null
      : null;

    if (!messageEl) {
      await this.addMessage(message.role, message.content, message.message_id, message);
      return;
    }

    try {
      this.messageRenderer.renderUnifiedMessageParts(
        messageEl,
        this.messageRenderer.normalizeMessageToParts(message).parts,
        false
      );
      this.messageRenderer.finalizeInlineBlocks(messageEl);
    } catch {
      await messageHandling.reloadAllMessages(this);
    }
  }

  private async recoverCommittedChatTurn(error: SystemSculptError, errorMessage: string): Promise<void> {
    const assistantMessageId =
      typeof error.metadata?.assistantMessageId === "string"
        ? error.metadata.assistantMessageId
        : undefined;
    const committedAssistantMessageId =
      typeof error.metadata?.committedAssistantMessageId === "string"
        ? error.metadata.committedAssistantMessageId
        : undefined;

    this.removeUnpersistedAssistantDraft(assistantMessageId);

    const committedAssistant = this.findCommittedAssistantMessage(committedAssistantMessageId || assistantMessageId);
    const failureText = this.formatCommittedTurnFailureText(errorMessage, error);
    const message =
      committedAssistant ||
      ({
        role: "assistant",
        content: "",
        message_id: this.generateMessageId(),
      } as ChatMessage);

    const updatedMessage = this.appendFailurePart(message, failureText);
    await this.persistAssistantMessage(updatedMessage);
    await this.renderAssistantMessageUpdate(updatedMessage);
  }

  public async handleError(error: string | SystemSculptError): Promise<void> {
    let errorMessage = typeof error === "string" ? error : error.message;
    const automationRequestActive = this.inputHandler?.isAutomationRequestActive?.() === true;
    
    // Log the error with full details
    const errorContext = {
      source: 'ChatView',
      method: 'handleError',
      metadata: {
        runtime: "managed",
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

    const shouldRecoverCommittedTurn =
      typeof (this as any).shouldRecoverCommittedChatTurn === "function" &&
      (this as any).shouldRecoverCommittedChatTurn(error);
    if (shouldRecoverCommittedTurn) {
      await this.recoverCommittedChatTurn(error as SystemSculptError, errorMessage);
      if (!automationRequestActive) {
        new Notice("The turn stopped, but the submitted message and completed tool results were kept.", 8000);
      }
      return;
    }

    if (isContextOverflowErrorMessage(errorMessage) || isContextOverflowErrorMessage(upstreamMessage)) {
      await this.resetFailedAssistantTurn();

      if (automationRequestActive) {
        return;
      }

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

      if (automationRequestActive) {
        void this.refreshCreditsBalance();
        return;
      }

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
          this.openAccountSettings();
        }
      }

      void this.refreshCreditsBalance();
      return;
    }

    // Capture (rather than narrow `error` in the `if`) so the later
    // `error instanceof SystemSculptError` checks still see the union type — a
    // non-license SystemSculptError must keep flowing to the branches below.
    const managedLicenseError = isManagedLicenseFailure(error) ? error : null;
    if (managedLicenseError) {
      await this.resetFailedAssistantTurn();

      // A rejected managed license is no longer valid — reflect that across the
      // UI so the account panel and banner agree (#249).
      try {
        await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
      } catch {}

      const expired = managedLicenseError.code === ERROR_CODES.LICENSE_EXPIRED;
      const renewUrl =
        typeof managedLicenseError.metadata?.renewUrl === "string" && managedLicenseError.metadata.renewUrl
          ? String(managedLicenseError.metadata.renewUrl)
          : SYSTEMSCULPT_WEBSITE.LICENSE;

      try {
        uiSetup.showLicenseBanner(this, { expired, renewUrl });
      } catch {}

      if (automationRequestActive) {
        return;
      }

      const result = await showPopup(
        this.app,
        expired
          ? "Your SystemSculpt subscription has expired, so the managed AI can't run.\n\nRenew to continue."
          : "Your SystemSculpt license key is invalid or was changed, so the managed AI can't run.\n\nRenew or re-enter your key in Account.",
        {
          title: expired ? "Subscription expired" : "License problem",
          icon: "key-round",
          primaryButton: "Renew subscription",
          secondaryButton: "Open settings",
        }
      );

      if (result?.action === "primary" || result?.confirmed) {
        void openExternalUrl(renewUrl);
      } else if (result?.action === "secondary") {
        this.openAccountSettings();
      }
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

      await this.resetFailedAssistantTurn();
      if (!automationRequestActive) {
        new ChatErrorModal({
          app: this.app,
          title: "Usage limit reached",
          icon: "alert-octagon",
          message:
            "Usage quota is exhausted for your SystemSculpt account. Add credits or wait for the next reset to continue.",
          primaryActionLabel: "Open Account",
          onPrimaryAction: () => this.openAccountSettings(),
        }).open();
      }
      return;
    }

    if (
      error instanceof SystemSculptError &&
      (error.code === "MODEL_UNAVAILABLE" || error.code === "MODEL_REQUEST_ERROR")
    ) {
      await this.resetFailedAssistantTurn();
      if (!automationRequestActive) {
        new ChatErrorModal({
          app: this.app,
          title: "SystemSculpt is unavailable",
          icon: "alert-triangle",
          message:
            "SystemSculpt could not complete this request right now. Try again in a moment, or check Account for license and account status.",
          primaryActionLabel: "Open Account",
          onPrimaryAction: () => this.openAccountSettings(),
        }).open();
      }
    } else {
      // Catch-all: classify the error and always show feedback + clean up.
      await this.resetFailedAssistantTurn();

      if (!automationRequestActive) {
        const classification = classifyStreamError(error);
        if (classification.transient) {
          const duration = classification.kind === "rate_limit" ? 12000 : 10000;
          new Notice(classification.userMessage, duration);
        } else {
          const isHardRateLimit = classification.kind === "rate_limit";
          const wantsAccountAction =
            classification.kind === "auth" || isHardRateLimit;
          new ChatErrorModal({
            app: this.app,
            title: isHardRateLimit
              ? "Usage limit reached"
              : this.titleForStreamErrorKind(classification.kind),
            icon: isHardRateLimit
              ? "alert-octagon"
              : this.iconForStreamErrorKind(classification.kind),
            message: classification.userMessage,
            primaryActionLabel: wantsAccountAction ? "Open Account" : undefined,
            onPrimaryAction: wantsAccountAction
              ? () => this.openAccountSettings()
              : undefined,
          }).open();
        }
      }
    }
  }

  private titleForStreamErrorKind(kind: StreamErrorKind): string {
    switch (kind) {
      case "auth":
        return "Authentication required";
      case "model_not_found":
        return "Request not available";
      case "server":
        return "SystemSculpt error";
      case "rate_limit":
      case "network":
      case "unknown":
      default:
        return "Chat request failed";
    }
  }

  private iconForStreamErrorKind(kind: StreamErrorKind): string {
    switch (kind) {
      case "auth":
        return "key-round";
      case "model_not_found":
        return "help-circle";
      case "server":
        return "server-crash";
      case "rate_limit":
      case "network":
      case "unknown":
      default:
        return "alert-triangle";
    }
  }

  public async refreshCreditsBalance(): Promise<void> {
    if (!String(this.plugin.settings.licenseKey || "").trim()) {
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
        // A successful balance fetch means the license is healthy again — heal
        // any stale invalid state so gating/account UI agree (#249). Guarded so
        // a routine poll doesn't rewrite settings on every refresh.
        if (this.plugin.settings.licenseValid === false) {
          try {
            await this.plugin.getSettingsManager().updateSettings({ licenseValid: true });
          } catch {}
        }
        try { uiSetup.hideLicenseBanner(this); } catch {}
      } catch (creditsError) {
        // Proactively surface an expired/invalid license on chat open — before
        // the user sends a doomed message (#249). Other errors stay silent
        // (the balance UI is a convenience panel).
        if (isManagedLicenseFailure(creditsError)) {
          try {
            await this.plugin.getSettingsManager().updateSettings({ licenseValid: false });
          } catch {}
          const renewUrl =
            typeof creditsError.metadata?.renewUrl === "string" && creditsError.metadata.renewUrl
              ? String(creditsError.metadata.renewUrl)
              : SYSTEMSCULPT_WEBSITE.LICENSE;
          try {
            uiSetup.showLicenseBanner(this, {
              expired: creditsError.code === ERROR_CODES.LICENSE_EXPIRED,
              renewUrl,
            });
          } catch {}
        }
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

  public openAccountSettings(): void {
    openChatAccount(() => {
      this.plugin.openSettingsTab("account");
    });
  }

  public async promptAccountSetup(
    customMessage?: string,
    overrides?: ChatAccountSetupPromptOverrides
  ): Promise<void> {
    await promptChatAccountSetup({
      app: this.app,
      openAccount: () => {
        this.plugin.openSettingsTab("account");
      },
      message: customMessage,
      retryHint: true,
      overrides,
    });
  }

  private removeLastAssistantMessageFromDom(): void {
    if (!this.chatContainer) {
      return;
    }
    const lastGroup = this.chatContainer.querySelector(':scope > .systemsculpt-message-group:last-of-type') as HTMLElement | null;
    const lastMessage = lastGroup?.querySelector('.systemsculpt-message:last-of-type') as HTMLElement | null;
    removeMessageElement(lastMessage);
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

  private removeUserMessageDomById(messageId: string): void {
    if (!this.chatContainer) return;
    const node = this.chatContainer.querySelector(
      `.systemsculpt-message[data-message-id="${escapeMessageIdForSelector(messageId)}"]`,
    ) as HTMLElement | null;
    removeMessageElement(node);
  }

  public async removeFailedSubmissionTurn(): Promise<boolean> {
    const snapshot = this.inputHandler?.peekSubmittedInputSnapshot?.() ?? null;
    if (snapshot) {
      const transcript = this.ensureChatTranscript();
      await transcript.commit(transcript.candidateDeleteMessage(snapshot.messageId));
      this.projectTranscript();
      this.inputHandler?.clearSubmittedInputSnapshot?.(snapshot.messageId);
      this.removeUserMessageDomById(snapshot.messageId);
      this.inputHandler?.setInputText(snapshot.rawText);
    }
    this.removeLastAssistantMessageFromDom();
    return Boolean(snapshot);
  }

  private async resetFailedAssistantTurn(): Promise<void> {
    const restored = await this.removeFailedSubmissionTurn();
    if (!restored) {
      await this.restoreLastUserMessageToComposer();
    }
  }

  public generateMessageId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  public shouldRenderMessageRole(role: ChatRole): boolean {
    if (this.isSystemNoiseHidden() && (role === "system" || role === "tool")) {
      return false;
    }
    return true;
  }

  // Effective visibility for SystemSculpt system + tool messages (#213/#174/#167):
  // a per-chat preference wins; otherwise fall back to the global default.
  public isSystemNoiseHidden(): boolean {
    return this.hideSystemMessages ?? this.plugin.settings.hideSystemMessagesInChat ?? false;
  }

  // Flip the per-chat preference, then re-render and persist so long chats stay
  // de-cluttered across reloads.
  public toggleSystemNoiseHidden(): void {
    this.hideSystemMessages = !this.isSystemNoiseHidden();
    this.applyHideToolActivityClass();
    this.inputHandler?.syncHideSystemMessagesButton?.();
    void this.renderMessagesInChunks();
    void this.saveChat();
  }

  // Inline tool-call blocks live inside assistant messages, so for reloaded chats
  // (where tool-role messages are not persisted) we hide tool activity via a
  // container class rather than the role filter.
  public applyHideToolActivityClass(): void {
    this.chatContainer?.classList.toggle(
      "systemsculpt-hide-tool-activity",
      this.isSystemNoiseHidden(),
    );
  }

  // Effective agent mode (#210/#149/#185): a per-chat preference wins; otherwise
  // fall back to the global `agentModeEnabled` default (enabled when unset).
  public isAgentModeActive(): boolean {
    return this.agentModeEnabled ?? this.plugin.settings.agentModeEnabled ?? true;
  }

  // Flip the per-chat preference, sync the composer toggle, and persist — without
  // mutating the global default (the v5 regression behind #149/#185).
  public toggleAgentMode(): void {
    this.agentModeEnabled = !this.isAgentModeActive();
    this.inputHandler?.syncAgentModeButton?.();
    void this.saveChat();
  }


  public async getCurrentSystemPrompt(): Promise<string> {
    this.ensureCoreServicesReady();
    return AGENT_PRESET.systemPrompt;
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
      primary: true,
      title: "Attach notes, documents, images, or audio to this chat",
      onClick: async () => {
        await this.contextManager?.addContextFile?.();
      },
    };

    actionSpecs.push(contextActionSpec);

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

    const readyDescription =
      "Type below or attach context. SystemSculpt handles the rest.";
    renderChatStatusSurface(statusContainer, {
      eyebrow: "Ready",
      title: "New chat",
      description: readyDescription,
      chips: [
        {
          label: "Context",
          value: contextLabel,
          icon: "paperclip",
        },
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
        runtime: "managed",
        chatBackend: this.chatBackend || null,
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

  private applyChatFontSizeClass(): void {
    if (!this.chatContainer) {
      return;
    }

    this.chatContainer.classList.remove(
      "systemsculpt-chat-small",
      "systemsculpt-chat-medium",
      "systemsculpt-chat-large"
    );
    this.chatContainer.classList.add(`systemsculpt-chat-${this.chatFontSize}`);
  }

  private scheduleChatFontSizeClassSync(delayMs: number = 0): void {
    globalThis.setTimeout(() => this.applyChatFontSizeClass(), delayMs);
  }

  private disposeViewResources(): Promise<void> {
    if (this.resourcesDisposed) {
      return Promise.resolve();
    }
    if (this.resourceDisposalPromise) {
      return this.resourceDisposalPromise;
    }

    const cleanup = () => {
      if (this.resourcesDisposed) return;
      this.resourcesDisposed = true;

      if (this.dragDropCleanup) {
        this.dragDropCleanup();
        this.dragDropCleanup = null;
      }

      try {
        this.scrollManager?.cleanup?.();
      } catch {}
      try {
        (this.scrollManager as any)?.destroy?.();
      } catch {}
      try {
        (this.contextManager as any)?.destroy?.();
      } catch {}
      try {
        this.inputHandler?.unload?.();
      } catch {}
    };

    const disposal = Promise.resolve(this.inputHandler?.disposeLocalResources?.()).finally(cleanup);
    this.resourceDisposalPromise = disposal;
    void disposal.then(
      () => { if (this.resourceDisposalPromise === disposal) this.resourceDisposalPromise = null; },
      () => { if (this.resourceDisposalPromise === disposal) this.resourceDisposalPromise = null; },
    );
    return disposal;
  }

  onunload() {
    void this.disposeViewResources().catch(() => {});
  }

  getState(): any {
    return {
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      version: this.chatVersion,
      chatFontSize: this.chatFontSize,
      hideSystemMessages: this.hideSystemMessages,
      agentModeEnabled: this.agentModeEnabled,
      chatBackend: this.chatBackend,
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
    this.chatOwnershipGeneration += 1;

    if (!state?.chatId) {
      this.chatId = "";
      this.initializeChatTitle();
      this.chatBackend = this.defaultChatBackend();
 
      // Restore chat font size for new chats if provided in state
      if (state?.chatFontSize) {
        this.chatFontSize = state.chatFontSize;
        this.scheduleChatFontSizeClassSync();
      }
      this.hideSystemMessages =
        typeof state?.hideSystemMessages === "boolean" ? state.hideSystemMessages : undefined;
      this.agentModeEnabled =
        typeof state?.agentModeEnabled === "boolean" ? state.agentModeEnabled : undefined;
      this.virtualStartIndex = 0;
      this.hasAdjustedInitialWindow = false;
      this.ensureChatTranscript().clear();
      this.projectTranscript();
      this.contextManager?.clearContext();
      this.inputHandler?.resetForFreshChat?.();
      this.refreshChatStatusIfEmpty();
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
    
    this.chatId = state.chatId;
    if (previousChatId !== this.chatId) {
      this.debugLogService?.resetStreamBuffer();
    }
    this.virtualStartIndex = 0;
    this.hasAdjustedInitialWindow = false;
    this.initializeChatTitle(state.chatTitle);
    this.chatVersion = state.version !== undefined ? state.version : -1;

    this.applyChatLeafState(state);
    if (typeof state.hideSystemMessages === "boolean") {
      this.hideSystemMessages = state.hideSystemMessages;
    }
    if (typeof state.agentModeEnabled === "boolean") {
      this.agentModeEnabled = state.agentModeEnabled;
    }
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
      this.ensureChatTranscript().clear();
      this.projectTranscript();
      this.contextManager?.clearContext();
      this.chatBackend = this.defaultChatBackend();
      this.inputHandler?.resetForFreshChat?.();
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

    this.chatOwnershipGeneration += 1;
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
          this.chatTranscript = ChatTranscript.loadStored(this.transcriptStorage(), {
            chatId,
            version: 0,
            messages: [],
          });
          this.projectTranscript();
          this.chatContainer?.empty();
          this.setTitle("Chat not found");
          this.chatBackend = this.defaultChatBackend();
          this.contextManager?.clearContext();
          this.isFullyLoaded = true; // Mark as loaded even when chat not found
          this.inputHandler?.notifyChatReadyChanged?.();
          // UI indicators can update asynchronously
          this.refreshChatStatusIfEmpty();
          void this.updateSystemPromptIndicator();
          return;
        }

        this.setTitle(chatData.title || generateDefaultChatTitle(), false);
        const persistedMessages = chatData.messages || [];
        this.chatVersion = chatData.version || 0;

        this.applyChatLeafState({
          legacyModelId: chatData.legacyModelId,
          chatBackend: chatData.chatBackend,
        });
        this.chatTranscript = ChatTranscript.loadStored(this.transcriptStorage(), {
          chatId,
          version: this.chatVersion,
          messages: persistedMessages,
          readOnly: chatData.chatBackend === "legacy",
        });
        this.projectTranscript();

        // Load chat font size from chat data
        this.chatFontSize = chatData.chatFontSize || this.plugin.settings.chatFontSize || "medium";
        this.scheduleChatFontSizeClassSync(100);

        // Restore selected prompt and agent mode for this chat
        if (this.inputHandler) {
          this.inputHandler.setSelectedPromptPath(chatData.selectedPromptPath || null);
        }
        // Restore per-chat agent mode (#210/#149/#185); undefined follows the global default.
        this.agentModeEnabled =
          typeof chatData.agentModeEnabled === "boolean" ? chatData.agentModeEnabled : undefined;
        this.inputHandler?.syncAgentModeButton?.();

        // Restore per-chat system/tool message visibility (#213/#174/#167).
        if (typeof chatData.hideSystemMessages === "boolean") {
          this.hideSystemMessages = chatData.hideSystemMessages;
        }
        this.applyHideToolActivityClass();
        this.inputHandler?.syncHideSystemMessagesButton?.();

        // Restore context files without blocking first render.
        if (this.contextManager) {
          const contextFiles = (chatData.context_files || []).filter(Boolean);
          if (contextFiles.length > 0) {
            void this.contextManager.setContextFiles(contextFiles);
          } else {
            this.contextManager.clearContext();
          }
        }

        await this.renderMessagesInChunks();
        if (loadEpoch !== this.loadEpoch) return;

        this.isFullyLoaded = true; // Mark as loaded after messages are rendered
        this.inputHandler?.notifyChatReadyChanged?.();

        // Update UI indicators (async; do not block chat readiness)
        this.refreshChatStatusIfEmpty();
        void this.updateSystemPromptIndicator();

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

    this.applyHideToolActivityClass();

    const renderEpoch = ++this.renderEpoch;
    const visibleMessages = this.messages.filter((message) =>
      this.shouldRenderMessageRole(message.role)
    );

    // Determine the slice of history we want to render.  If this is the first
    // render of the view (virtualStartIndex === 0) we default to showing only
    // the most recent VIRTUAL_BATCH_SIZE messages.
    const total = visibleMessages.length;
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
        const msg = visibleMessages[i];
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
          runtime: "managed",
          chatVersion: this.chatVersion,
          chatBackend: this.chatBackend || null,
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

    const promptProfile = this.getActiveSystemPromptType();
    const systemPromptDetails = await safeAsync<{ basePrompt: string; combinedPrompt: string } | null>(
      "system-prompt",
      async () => {
        const basePrompt = await this.getCurrentSystemPrompt();
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
        runtime: "managed",
        promptProfile,
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

  public getInputText(): string {
    return this.inputHandler?.getValue?.() ?? "";
  }

  public setInputText(value: string | object, options?: { focus?: boolean }): void {
    this.inputHandler?.setInputText(value, options);
  }

  public isWebSearchEnabled(): boolean {
    return this.inputHandler?.isWebSearchEnabled?.() ?? false;
  }

  public setWebSearchEnabled(enabled: boolean): void {
    this.inputHandler?.setWebSearchEnabled?.(enabled);
  }

  public getAutomationApprovalMode(): AutomationApprovalMode | null {
    return this.inputHandler?.getAutomationApprovalMode?.() ?? null;
  }

  public setAutomationApprovalMode(mode: AutomationApprovalMode): void {
    this.inputHandler?.setAutomationApprovalMode?.(mode);
  }

  public isAgentModeEnabled(): boolean {
    return this.isAgentModeActive();
  }

  public setAgentModeEnabled(enabled: boolean): void {
    this.agentModeEnabled = enabled;
    this.inputHandler?.syncAgentModeButton?.();
  }

  public async sendAutomationMessage(options?: {
    text?: string | object;
    includeContextFiles?: boolean;
    approvalMode?: AutomationApprovalMode;
    webSearchEnabled?: boolean;
    agentModeEnabled?: boolean;
  }): Promise<void> {
    if (!this.inputHandler) {
      throw new Error("Chat input is not ready yet.");
    }

    if (typeof options?.webSearchEnabled === "boolean") {
      this.inputHandler.setWebSearchEnabled(options.webSearchEnabled);
    }

    if (typeof options?.agentModeEnabled === "boolean") {
      this.setAgentModeEnabled(options.agentModeEnabled);
    }

    if (options && "text" in options && options.text !== undefined) {
      this.inputHandler.setInputText(options.text, { focus: false });
    }

    await this.inputHandler.submitForAutomation({
      includeContextFiles: options?.includeContextFiles,
      approvalMode: options?.approvalMode,
      focusAfterSend: false,
    });
  }

  public getAutomationSnapshot(): Record<string, unknown> {
    const serializedMessages = this.messages.map((message) => ({
      role: message.role,
      content: message.content,
      messageId: message.message_id ?? null,
      toolCalls: Array.isArray((message as any).tool_calls)
        ? (message as any).tool_calls.map((toolCall: ToolCall) => ({
            id: toolCall.id,
            name: toolCall.request?.function?.name ?? "",
            state: toolCall.state ?? "",
            result: toolCall.result ?? null,
            executionStartedAt: toolCall.executionStartedAt ?? null,
            executionCompletedAt: toolCall.executionCompletedAt ?? null,
          }))
        : [],
    }));

    return {
      leafId: (this.leaf as any)?.id ?? null,
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      backend: this.chatBackend,
      isFullyLoaded: this.isFullyLoaded,
      isGenerating: this.isGenerating,
      runtime: "managed",
      messageCount: serializedMessages.length,
      messages: serializedMessages,
      contextFiles: Array.from(this.contextManager?.getContextFiles?.() || []),
      input: {
        value: this.getInputText(),
        webSearchEnabled: this.isWebSearchEnabled(),
        approvalMode: this.getAutomationApprovalMode(),
        agentModeEnabled: this.isAgentModeEnabled(),
      },
    };
  }

  private applyChatLeafState(state: {
    legacyModelId?: string;
    chatBackend?: ChatBackend;
    piSessionFile?: string;
    piSessionId?: string;
  }): void {
    this.chatBackend = detectLoadedChatBackend({
      explicitBackend: state.chatBackend,
      piSessionFile: state.piSessionFile,
      piSessionId: state.piSessionId,
      model: state.legacyModelId,
    });
  }

  public isLegacyReadOnlyChat(): boolean {
    return this.chatBackend === "legacy" && String(this.chatId || "").trim().length > 0;
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

  public getMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  public clearTranscriptProjection(): void {
    this.ensureChatTranscript().clear();
    this.projectTranscript();
    this.isFullyLoaded = false;
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
      }, { focus: false });
    }
  }

  public async setChatFontSize(size: "small" | "medium" | "large"): Promise<void> {
    this.chatFontSize = size;
    this.applyChatFontSizeClass();
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
    let terminalError: unknown;
    try {
      await this.inputHandler?.abortActiveTurn?.();
    } catch (error) {
      terminalError = error;
    }

    try {
      await this.disposeViewResources();
    } catch (error) {
      terminalError ??= error;
    } finally {
      this.ensureChatTranscript().teardown();
      this.projectTranscript();
      this.isFullyLoaded = false;
      try {
        await super.onClose?.();
      } catch (error) {
        terminalError ??= error;
      }
    }

    if (terminalError !== undefined) {
      throw terminalError;
    }
  }
}
