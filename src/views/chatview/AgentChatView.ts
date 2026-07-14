import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { SystemSculptService, type CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import { RecorderService } from "../../services/RecorderService";
import type { ChatMessage } from "../../types";
import type { ChatExportOptions } from "../../types/chatExport";
import type { ToolApprovalPolicy } from "../../utils/toolPolicy";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { getRuntimeCrypto } from "../../utils/runtimeWindow";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { generateDefaultChatTitle, sanitizeChatTitle } from "../../utils/titleUtils";
import { ChatStorageService } from "./ChatStorageService";
import {
  FILE_CONTEXT_STATE_CHANGED_EVENT,
  FileContextManager,
  type FileContextStateChangedEvent,
} from "./FileContextManager";
import { getSurfaceOwnerWindow } from "../../core/ui/surface/SurfaceDomContext";
import { ChatExportService } from "./export/ChatExportService";
import type { ChatExportResult } from "./export/ChatExportTypes";
import type { ChatApprovalMode } from "./storage/ChatPersistenceTypes";
import { AgentWorkspace, type AgentQueuedFollowUp } from "./AgentWorkspace";
import type { AgentArtifact } from "./AgentConversation";
import type { AgentComposerSubmit } from "./AgentComposer";
import {
  composeAttachmentMetadata,
  composeUserMessageContent,
  restoreChatMessageDraft,
  type ChatMessageAttachment,
} from "./attachments/ChatMessageAttachments";
import { ManagedChatDocumentAttachmentProcessor } from "./attachments/ManagedChatDocumentAttachmentProcessor";
import {
  ChatAttachmentVaultStore,
  isChatAttachmentContentRef,
} from "./attachments/ChatAttachmentVaultStore";
import { emitChatTranscriptCommitted } from "./ChatTranscriptEvents";
import {
  AgentTranscriptRepository,
  type AgentTranscriptSnapshot,
  type AgentUserCommitInput,
} from "./AgentTranscriptRepository";
import {
  ManagedAgentController,
  type ManagedAgentRunResult,
} from "./ManagedAgentController";
import { ManagedChatRuntimeAdapter } from "./turn/ManagedChatRuntimeAdapter";
import { AgentQueueStateRepository } from "./AgentQueueStateRepository";
import {
  DEFAULT_MANAGED_CHAT_INPUT_LIMITS,
  type ManagedChatInputLimits,
} from "../../services/managed/ManagedChatInputLimits";

export type AutomationApprovalMode = "interactive" | "auto-approve" | "deny";
export type { ChatApprovalMode } from "./storage/ChatPersistenceTypes";

type ChatLeafState = Readonly<{
  chatId?: string;
  chatTitle?: string;
  version?: number;
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  draftKey?: string;
}>;

function messageId(prefix: string): string {
  const crypto = getRuntimeCrypto();
  const uuid = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function titleFromMessage(text: string): string {
  const firstLine = text.replace(/^\s*#+\s*/, "").split("\n")[0].replace(/\s+/g, " ").trim();
  const compact = firstLine.length > 64 ? `${firstLine.slice(0, 61).trimEnd()}…` : firstLine;
  return sanitizeChatTitle(compact) || generateDefaultChatTitle();
}

function plainContent(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => part.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function formatCredits(value: number): string {
  try { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value); }
  catch { return String(Math.round(value)); }
}

/**
 * Lean Chat view coordinator. Durable transcript, active run, native DOM
 * projection, and local vault tools each have one owner.
 */
export class AgentChatView extends ItemView {
  public readonly plugin: SystemSculptPlugin;
  public readonly aiService: SystemSculptService;
  public readonly chatStorage: ChatStorageService;
  public readonly contextManager: FileContextManager;
  public chatId = "";
  public chatTitle: string;
  public chatVersion = 0;
  public chatFontSize: "small" | "medium" | "large";
  public approvalMode: ChatApprovalMode;
  public isFullyLoaded = false;
  public creditsBalance: CreditsBalanceSnapshot | null = null;

  private readonly transcript: AgentTranscriptRepository;
  private readonly controller: ManagedAgentController;
  private readonly documentAttachmentProcessor: ManagedChatDocumentAttachmentProcessor;
  private readonly attachmentStore: ChatAttachmentVaultStore;
  private readonly queueRepository: AgentQueueStateRepository;
  private workspace: AgentWorkspace | null = null;
  private exportService: ChatExportService | null = null;
  private creditsPromise: Promise<void> | null = null;
  private controllerUnsubscribe: (() => void) | null = null;
  private transcriptCommitUnsubscribe: (() => void) | null = null;
  private recorderToggleUnsubscribe: (() => void) | null = null;
  private recorderTranscriptUnsubscribe: (() => void) | null = null;
  private contextLoading = false;
  private activeWebSearch = false;
  private activeIncludeContextFiles = true;
  private activeRunPromise: Promise<ManagedAgentRunResult> | null = null;
  private queuedFollowUps: AgentQueuedFollowUp[] = [];
  private draftKey: string;
  private queueHydrated = false;
  private queuePersistence: Promise<void> = Promise.resolve();
  private pendingRetry: Extract<AgentUserCommitInput, { kind: "resend" }> | null = null;
  private automationApprovalMode: AutomationApprovalMode = "interactive";
  private readonly sessionTrustedToolNames = new Set<string>();
  private suppressQueueDrain = false;
  private chatInputLimits: ManagedChatInputLimits = DEFAULT_MANAGED_CHAT_INPUT_LIMITS;

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.aiService = SystemSculptService.getInstance(plugin);
    this.chatStorage = new ChatStorageService(plugin.app, plugin.settings.chatsDirectory);
    this.attachmentStore = new ChatAttachmentVaultStore(plugin.app.vault.adapter as any);
    this.queueRepository = new AgentQueueStateRepository(plugin.app.vault.adapter, this.attachmentStore);
    const initial = (leaf.getViewState()?.state ?? {}) as ChatLeafState;
    this.chatId = initial.chatId?.trim() || "";
    this.chatTitle = initial.chatTitle?.trim() || generateDefaultChatTitle();
    this.chatVersion = initial.version ?? 0;
    this.chatFontSize = initial.chatFontSize || plugin.settings.chatFontSize || "medium";
    this.approvalMode = initial.approvalMode === "full-access" ? "full-access" : "ask";
    this.draftKey = initial.draftKey?.trim() || messageId("draft");

    this.contextManager = new FileContextManager({
      app: plugin.app,
      plugin,
      onContextChange: async () => {
        this.syncAttachments();
        if (!this.contextLoading && this.chatId) {
          const snapshot = await this.transcript.saveMetadata();
          this.applyTranscriptIdentity(snapshot);
        }
      },
      getOwnerWindow: () => getSurfaceOwnerWindow(this.contentEl),
    });
    this.transcript = new AgentTranscriptRepository(this.chatStorage, () => ({
      contextFiles: new Set(this.contextManager.getContextFiles()),
      title: this.chatTitle,
      chatFontSize: this.chatFontSize,
      approvalMode: this.approvalMode,
    }));
    this.transcriptCommitUnsubscribe = this.transcript.subscribeToCommits(({ snapshot, role, messageId }) => {
      this.applyTranscriptIdentity(snapshot);
      emitChatTranscriptCommitted(this.app.workspace, {
        chatId: snapshot.chatId,
        version: snapshot.version,
        role,
        messageId,
      });
    });
    this.documentAttachmentProcessor = new ManagedChatDocumentAttachmentProcessor(plugin.app, plugin);

    const runtime = new ManagedChatRuntimeAdapter(plugin.getManagedCapabilityClient(), {
      get: () => this.transcript.snapshot().managedSession,
      invalidate: async () => {
        const snapshot = await this.transcript.clearManagedSession();
        this.applyTranscriptIdentity(snapshot);
      },
    });
    this.controller = new ManagedAgentController({
      runtime,
      host: {
        acquireChatTurnLease: () => plugin.getManagedCapabilityClient().acquireChatTurnLease(),
        commitUser: async (input) => {
          if (!this.chatId && this.transcript.snapshot().messages.length === 0) {
            this.chatTitle = titleFromMessage(plainContent(input.message));
            this.transcript.setTitle(this.chatTitle);
          }
          const snapshot = await this.transcript.commitUser(input);
          this.applyTranscriptIdentity(snapshot);
          await this.bindQueueToChat(snapshot.chatId)
            .catch((error) => this.reportQueuePersistenceError(error));
          await this.workspace?.setHistory(snapshot.messages as readonly ChatMessage[]);
          this.updateViewState();
          return snapshot;
        },
        claimUser: (accepted, input) => {
          const current = this.transcript.snapshot();
          return current.chatId === accepted.chatId
            && current.version === accepted.version
            && current.messages.some((entry) => entry.message_id === input.message.message_id);
        },
        prepareAcceptedRequest: (operation) => this.aiService.prepareAcceptedChatRequest(operation, {
          contextFiles: this.activeIncludeContextFiles
            ? new Set(this.contextManager.getContextFiles())
            : new Set(),
          webSearch: this.activeWebSearch,
          hydrateAttachments: (messages) => this.attachmentStore.hydrateMessages(messages),
        }),
        persistAssistant: async (message) => {
          const snapshot = await this.transcript.persistAssistant(message);
          this.applyTranscriptIdentity(snapshot);
          return snapshot;
        },
        persistAssistantWithSession: async (message, checkpoint, toolsetFingerprint, budget) => {
          const snapshot = await this.transcript.persistAssistantWithSession(
            message,
            checkpoint,
            toolsetFingerprint,
            budget,
          );
          this.applyTranscriptIdentity(snapshot);
          return snapshot;
        },
        clearSessionCheckpoint: async () => {
          const snapshot = await this.transcript.clearManagedSession();
          this.applyTranscriptIdentity(snapshot);
        },
        snapshot: () => this.transcript.snapshot(),
        executeLocalTool: (toolCall, signal) => this.aiService.executeHostedToolCall({
          toolCall,
          chatView: this,
          signal,
        }),
        refreshCredits: () => this.refreshCreditsBalance(),
        reportError: (error) => this.reportControllerError(error),
      },
    });
  }

  public get messages(): ChatMessage[] {
    return this.transcript.snapshot().messages.map((message) => ({ ...message })) as ChatMessage[];
  }

  public getViewType(): string { return CHAT_VIEW_TYPE; }
  public getDisplayText(): string { return this.chatTitle || "SystemSculpt"; }

  public async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("systemsculpt-agent-view");
    this.workspace = new AgentWorkspace(this.contentEl, {
      app: this.app,
      sourcePath: () => this.getExpectedChatHistoryFilePath() || "",
      reducedMotion: () => this.plugin.settings.respectReducedMotion === true,
      onSubmit: (submission) => this.acceptComposerSubmission(submission),
      onStop: () => this.stopActiveRun(),
      onAttach: () => this.contextManager.addContextFile(),
      onVaultContextDrop: (path) => this.addDroppedVaultContext(path),
      documentAttachmentProcessor: this.documentAttachmentProcessor,
      attachmentLimits: this.chatInputLimits,
      onMic: () => this.toggleRecording(),
      onRemoveAttachment: async (attachment) => { await this.contextManager.removeFromContextFiles(attachment.path || attachment.label); },
      onApprove: (approvalId, approved, rememberForChat) => this.respondToToolApproval(approvalId, approved, rememberForChat),
      onOpenArtifact: (artifact) => this.openArtifact(artifact),
      onCopyArtifactPath: (artifact) => this.copyArtifactPath(artifact),
      onRetryMessage: (id) => this.prepareRetry(id),
      onCopyText: async (text) => { await tryCopyToClipboard(text); },
      onNewChat: () => this.startNewChat(),
      onOpenHistory: () => this.openHistory(),
      onOpenSettings: () => this.openChatSettings(),
      onOpenCredits: () => this.openCreditsBalanceModal(),
      onCancelQueued: (id) => this.cancelQueuedFollowUp(id),
      onRunQueuedNow: (id) => this.runQueuedFollowUpNow(id),
      onApprovalModeChange: (mode) => {
        void this.setApprovalMode(mode).catch((error) => this.reportControllerError(error));
      },
    });
    this.addChild(this.workspace);
    this.controllerUnsubscribe = this.controller.subscribe((snapshot) => {
      void this.workspace?.setAgentSnapshot(snapshot);
      if (this.automationApprovalMode === "deny") {
        for (const part of snapshot.parts) {
          if (part.kind === "tool" && part.state === "approval-required" && part.approvalId) {
            this.controller.respondToApproval(part.approvalId, false);
          }
        }
      }
    });
    this.register(() => this.controllerUnsubscribe?.());
    this.installRecorderBindings();
    this.installWorkspaceBindings();
    this.applyFontSize();
    this.syncAttachments();
    this.workspace.setApprovalMode(this.approvalMode);

    if (this.chatId) await this.loadChatById(this.chatId);
    else await this.startNewChat(false, undefined, this.draftKey);
    void this.refreshCreditsBalance();
    void this.refreshManagedChatInputLimits();
    void this.pruneAttachmentStore().catch(() => {});
    this.workspace.focus();
  }

  public getState(): Record<string, unknown> {
    return {
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      version: this.chatVersion,
      chatFontSize: this.chatFontSize,
      approvalMode: this.approvalMode,
      draftKey: this.draftKey,
      file: this.getExpectedChatHistoryFilePath() || undefined,
    };
  }

  public async setState(state: ChatLeafState): Promise<void> {
    if (!state?.chatId) {
      await this.startNewChat(false, state?.chatTitle, state?.draftKey);
      if (state?.chatFontSize) await this.setChatFontSize(state.chatFontSize, false);
      if (state?.approvalMode) this.applyApprovalMode(state.approvalMode);
      return;
    }
    if (state.chatId === this.chatId && this.isFullyLoaded && this.transcript.snapshot().chatId === state.chatId) {
      if (state.approvalMode) this.applyApprovalMode(state.approvalMode);
      return;
    }
    if (state.chatFontSize) this.chatFontSize = state.chatFontSize;
    await this.loadChatById(state.chatId);
  }

  public async loadChatById(chatId: string): Promise<void> {
    if (this.queueHydrated) await this.persistQueueState();
    await this.controller.cancel();
    this.sessionTrustedToolNames.clear();
    this.isFullyLoaded = false;
    this.workspace?.setBanner("Loading chat…");
    const loaded = await this.transcript.load(chatId);
    if (!loaded) {
      this.workspace?.setBanner("This chat could not be loaded.", "error");
      await this.startNewChat(false);
      return;
    }
    this.contextLoading = true;
    try { await this.contextManager.setContextFiles([...loaded.contextFiles]); }
    finally { this.contextLoading = false; }
    this.applyTranscriptIdentity(loaded);
    this.draftKey = loaded.chatId;
    await this.hydrateQueue(this.draftKey);
    if (loaded.chatFontSize) this.chatFontSize = loaded.chatFontSize;
    this.approvalMode = loaded.approvalMode === "full-access" ? "full-access" : "ask";
    this.applyFontSize();
    this.workspace?.setApprovalMode(this.approvalMode);
    this.workspace?.setTitle(this.chatTitle);
    await this.workspace?.setHistory(loaded.messages as readonly ChatMessage[]);
    await this.workspace?.setAgentSnapshot(null);
    this.syncAttachments();
    this.workspace?.setBanner(null);
    this.isFullyLoaded = true;
    this.updateViewState();
    this.app.workspace.trigger("systemsculpt:chat-loaded", this.chatId);
  }

  public async saveChat(): Promise<void> {
    if (!this.chatId) return;
    const snapshot = await this.transcript.saveMetadata();
    this.applyTranscriptIdentity(snapshot);
  }

  public getMessages(): ChatMessage[] { return this.messages; }
  public getChatTitle(): string { return this.chatTitle; }

  public async setTitle(title: string, shouldSave = true): Promise<void> {
    const normalized = sanitizeChatTitle(title.trim()) || generateDefaultChatTitle();
    if (normalized === this.chatTitle) return;
    this.chatTitle = normalized;
    this.transcript.setTitle(normalized);
    this.workspace?.setTitle(normalized);
    if (shouldSave) await this.saveChat();
    this.updateViewState();
    this.app.workspace.requestSaveLayout();
  }

  public async setChatFontSize(size: "small" | "medium" | "large", shouldSave = true): Promise<void> {
    const previous = this.chatFontSize;
    if (size === previous) return;
    this.chatFontSize = size;
    this.applyFontSize();
    this.updateViewState();
    try {
      if (shouldSave) await this.saveChat();
    } catch (error) {
      this.chatFontSize = previous;
      this.applyFontSize();
      this.updateViewState();
      throw error;
    }
  }

  public async setApprovalMode(mode: ChatApprovalMode): Promise<void> {
    const nextMode = mode === "full-access" ? "full-access" : "ask";
    if (nextMode === this.approvalMode) return;
    if (this.activeRunPromise) {
      throw new Error("Tool access cannot change while the agent is running.");
    }
    const previousMode = this.approvalMode;
    this.applyApprovalMode(nextMode);
    try {
      if (this.chatId) await this.saveChat();
    } catch (error) {
      this.applyApprovalMode(previousMode);
      throw error;
    }
  }

  private applyApprovalMode(mode: ChatApprovalMode): void {
    this.approvalMode = mode === "full-access" ? "full-access" : "ask";
    this.workspace?.setApprovalMode(this.approvalMode);
    this.updateViewState();
    this.app.workspace.requestSaveLayout();
  }

  public async addFileToContext(file: TFile): Promise<void> {
    await this.contextManager.addFileToContext(file);
  }

  public async addContextFile(file: TFile): Promise<void> {
    await this.addFileToContext(file);
  }

  public focusInput(): void { this.workspace?.focus(); }
  public getInputText(): string { return this.workspace?.getInputText() || ""; }
  public setInputText(value: string | object, options?: { focus?: boolean }): void {
    this.workspace?.setInputText(typeof value === "string" ? value : JSON.stringify(value, null, 2), options);
  }
  public isWebSearchEnabled(): boolean { return this.workspace?.composer.isWebSearchEnabled() ?? false; }
  public setWebSearchEnabled(enabled: boolean): void { this.workspace?.setWebSearchEnabled(enabled); }
  public getAutomationApprovalMode(): AutomationApprovalMode { return this.automationApprovalMode; }
  public setAutomationApprovalMode(mode: AutomationApprovalMode): void { this.automationApprovalMode = mode; }
  public async sendAutomationMessage(options: {
    message?: string;
    includeContextFiles?: boolean;
    approvalMode?: AutomationApprovalMode;
    focusAfterSend?: boolean;
  } = {}): Promise<void> {
    const text = (options.message ?? this.getInputText()).trim();
    if (!text) return;
    const previous = this.automationApprovalMode;
    if (options.approvalMode) this.automationApprovalMode = options.approvalMode;
    try {
      await this.executeSubmission(
        { text, webSearch: this.isWebSearchEnabled(), mode: "send" },
        { includeContextFiles: options.includeContextFiles !== false },
      );
    } finally {
      this.automationApprovalMode = previous;
      if (options.focusAfterSend !== false) this.focusInput();
    }
  }

  public getAutomationSnapshot(): Record<string, unknown> {
    const run = this.controller.getSnapshot();
    return {
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      inputText: this.getInputText(),
      webSearchEnabled: this.isWebSearchEnabled(),
      approvalMode: this.automationApprovalMode,
      runStatus: run.status,
      queuedFollowUps: this.queuedFollowUps.length,
    };
  }

  public getExpectedChatHistoryFilePath(): string | null {
    return this.chatId ? `${this.plugin.settings.chatsDirectory}/${this.chatId}.md` : null;
  }

  public getChatHistoryFilePath(): string | null {
    const path = this.getExpectedChatHistoryFilePath();
    if (!path) return null;
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile ? path : null;
  }

  public getChatHistoryAbsolutePath(): string | null {
    const path = this.getChatHistoryFilePath();
    return path ? resolveAbsoluteVaultPath(this.app.vault.adapter, path) : null;
  }

  public async copyCurrentChatFilePathToClipboard(): Promise<void> {
    const path = this.getChatHistoryAbsolutePath();
    if (!path || !(await tryCopyToClipboard(path))) new Notice("Chat path is not available yet.");
  }

  public async exportChat(options?: Partial<ChatExportOptions>): Promise<ChatExportResult> {
    this.exportService ??= new ChatExportService(this);
    return this.exportService.export(options);
  }

  public async exportChatAsMarkdown(options?: Partial<ChatExportOptions>): Promise<string> {
    return (await this.exportChat(options)).markdown;
  }

  public async refreshCreditsBalance(): Promise<void> {
    if (!this.plugin.settings.licenseKey?.trim()) {
      this.creditsBalance = null;
      this.workspace?.setCredits(null);
      return;
    }
    if (this.creditsPromise) return this.creditsPromise;
    this.creditsPromise = (async () => {
      try {
        this.creditsBalance = await this.aiService.getCreditsBalance();
        this.workspace?.setCredits(formatCredits(this.creditsBalance.totalRemaining), this.creditsBalance.totalRemaining <= 1000);
      } catch {
        this.workspace?.setCredits(null);
      }
    })().finally(() => { this.creditsPromise = null; });
    return this.creditsPromise;
  }

  private async refreshManagedChatInputLimits(): Promise<void> {
    try {
      const limits = await this.plugin.getManagedCapabilityClient().getChatInputLimits();
      this.chatInputLimits = limits;
      this.workspace?.setMessageAttachmentLimits(limits);
    } catch {
      // The pinned bootstrap limits keep attachment validation safe while the
      // catalog is offline; normal admission will surface availability later.
    }
  }

  public async openCreditsBalanceModal(): Promise<void> {
    await this.plugin.openCreditsBalanceModal({
      initialBalance: this.creditsBalance,
      onBalanceUpdated: async (balance) => {
        this.creditsBalance = balance;
        this.workspace?.setCredits(
          balance ? formatCredits(balance.totalRemaining) : null,
          !!balance && balance.totalRemaining <= 1000,
        );
      },
      settingsTab: "account",
    });
  }

  public async handleError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error || "Agent request failed.");
    this.workspace?.setBanner(message, "error");
  }

  public async onClose(): Promise<void> {
    this.suppressQueueDrain = true;
    await this.controller.cancel();
    if (this.chatId && this.draftKey !== this.chatId) {
      await this.bindQueueToChat(this.chatId)
        .catch((error) => this.reportQueuePersistenceError(error));
    }
    if (this.queueHydrated) {
      await this.persistQueueState().catch((error) => this.reportQueuePersistenceError(error));
    }
    await this.queuePersistence;
    await this.transcript.idle();
    this.controllerUnsubscribe?.();
    this.transcriptCommitUnsubscribe?.();
    this.recorderToggleUnsubscribe?.();
    this.recorderTranscriptUnsubscribe?.();
    this.contextManager.destroy();
    this.workspace = null;
  }

  private acceptComposerSubmission(submission: AgentComposerSubmit): void {
    void this.prepareSubmission(submission).then((prepared) => {
      if (prepared.mode === "queue" || this.activeRunPromise) {
        this.queuedFollowUps.push({
          id: messageId("queued"),
          text: prepared.text,
          webSearch: prepared.webSearch,
          includeContextFiles: true,
          ...(prepared.attachments?.length ? { attachments: prepared.attachments } : {}),
        });
        this.syncQueue();
        this.scheduleQueuePersistence();
        return;
      }
      return this.executeSubmission(prepared).catch(async (error) => {
        this.workspace?.restoreRejectedSubmission(prepared);
        await this.handleError(error);
      });
    }).catch(async (error) => {
      this.workspace?.restoreRejectedSubmission(submission);
      await this.handleError(error);
    });
  }

  private async prepareSubmission(submission: AgentComposerSubmit): Promise<AgentComposerSubmit> {
    if (!submission.attachments?.length) return submission;
    const attachments: ChatMessageAttachment[] = [];
    for (const attachment of submission.attachments) {
      if (attachment.contentRef && isChatAttachmentContentRef(attachment.contentRef)) {
        attachments.push(attachment);
        continue;
      }
      const [externalized] = await this.attachmentStore.externalizeAttachments([attachment]);
      attachments.push(externalized);
    }
    return Object.freeze({ ...submission, attachments });
  }

  private async executeSubmission(
    submission: AgentComposerSubmit,
    options: Readonly<{ includeContextFiles?: boolean }> = {},
  ): Promise<void> {
    // Composer submissions are externalized at admission; queued attachments
    // are restored from durable refs. Do not rewrite the same CAS payload here.
    const prepared = submission;
    if (this.activeRunPromise) {
      this.queuedFollowUps.push({
        id: messageId("queued"),
        text: prepared.text,
        webSearch: prepared.webSearch,
        includeContextFiles: options.includeContextFiles !== false,
        ...(prepared.attachments?.length ? { attachments: prepared.attachments } : {}),
      });
      this.syncQueue();
      this.scheduleQueuePersistence();
      return;
    }
    await this.workspace?.setHistory(this.transcript.snapshot().messages as readonly ChatMessage[]);
    // The completed run remains as the live projection until the durable
    // assistant turn enters history. Clear it before admission so a denied or
    // slow next request never duplicates the previous answer.
    await this.workspace?.setAgentSnapshot(null);
    this.activeWebSearch = prepared.webSearch;
    this.activeIncludeContextFiles = options.includeContextFiles !== false;
    this.workspace?.setRunPending(true);
    this.workspace?.setBanner(null);
    const attachmentMetadata = composeAttachmentMetadata(prepared.text, prepared.attachments);
    const userMessage: ChatMessage = {
      role: "user",
      content: composeUserMessageContent(prepared.text, prepared.attachments),
      message_id: messageId("user"),
      ...(attachmentMetadata ? { attachmentMetadata } : {}),
    };
    const commit: AgentUserCommitInput = this.pendingRetry
      ? { ...this.pendingRetry, message: userMessage }
      : { kind: "append", message: userMessage };
    const policy: ToolApprovalPolicy = this.automationApprovalMode === "auto-approve"
      || this.approvalMode === "full-access"
      ? { requireDestructiveApproval: false }
      : {
          // The active run reads this same set between continuations so an
          // "Allow for chat" choice takes effect before the next tool call.
          trustedToolNames: this.sessionTrustedToolNames,
        };
    const run = this.controller.start({ commit, turnBoundaryId: userMessage.message_id, approvalPolicy: policy });
    this.activeRunPromise = run;
    let result: ManagedAgentRunResult;
    try {
      result = await run;
      if ("operation" in result && result.operation) this.pendingRetry = null;
      const userWasCommitted = this.transcript.snapshot().messages
        .some((message) => message.message_id === userMessage.message_id);
      const rejectedBeforeCommit = result.kind === "admission_denied"
        || result.kind === "busy"
        || (result.kind === "cancelled" && !result.operation)
        || (result.kind === "failed" && !result.operation);
      if (rejectedBeforeCommit && !userWasCommitted) {
        this.workspace?.restoreRejectedSubmission(prepared);
      }
      this.handleRunResult(result);
      if (result.kind === "completed") {
        await this.workspace?.setHistory(this.transcript.snapshot().messages as readonly ChatMessage[]);
        await this.workspace?.setAgentSnapshot(null);
      }
    } finally {
      if (this.activeRunPromise === run) this.activeRunPromise = null;
      this.activeWebSearch = false;
      this.activeIncludeContextFiles = true;
      this.workspace?.setRunPending(false);
    }
    if (!this.suppressQueueDrain && result.kind === "completed") await this.drainQueue();
  }

  private handleRunResult(result: ManagedAgentRunResult): void {
    if ("operation" in result && result.operation) this.aiService.releaseAcceptedChatRequest(result.operation);
    if (result.kind === "admission_denied") {
      const messages: Record<string, string> = {
        license_required: "Add your SystemSculpt license to start the agent.",
        license_rejected: "Your SystemSculpt license could not be verified.",
        temporarily_unavailable: "SystemSculpt is temporarily unavailable.",
        rate_limited: "SystemSculpt is busy. Try again shortly.",
        capability_unavailable: "SystemSculpt chat is unavailable in this plugin version.",
      };
      this.workspace?.setBanner(messages[result.outcome] || "SystemSculpt chat is unavailable.", "error");
    } else if (result.kind === "failed" && !result.operation) {
      this.workspace?.setBanner(result.error.message, "error");
    }
    this.updateViewState();
  }

  private async drainQueue(): Promise<void> {
    const next = this.queuedFollowUps.shift();
    this.syncQueue();
    if (!next) return;
    try {
      await this.persistQueueState();
    } catch (error) {
      this.queuedFollowUps.unshift(next);
      this.syncQueue();
      this.reportQueuePersistenceError(error);
      return;
    }
    const submission: AgentComposerSubmit = {
      text: next.text,
      webSearch: next.webSearch,
      mode: "send",
      ...(next.attachments?.length ? { attachments: next.attachments } : {}),
    };
    try {
      await this.executeSubmission(submission, { includeContextFiles: next.includeContextFiles });
    } catch (error) {
      this.workspace?.restoreRejectedSubmission(submission);
      await this.handleError(error);
    }
  }

  private async stopActiveRun(): Promise<void> {
    this.suppressQueueDrain = true;
    try { await this.controller.cancel(); }
    finally { this.suppressQueueDrain = false; }
  }

  private async cancelQueuedFollowUp(id: string): Promise<void> {
    const index = this.queuedFollowUps.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = this.queuedFollowUps.splice(index, 1);
    this.syncQueue();
    try {
      await this.persistQueueState();
    } catch (error) {
      this.queuedFollowUps.splice(index, 0, removed);
      this.syncQueue();
      this.reportQueuePersistenceError(error);
      throw error;
    }
  }

  private async runQueuedFollowUpNow(id: string): Promise<void> {
    const item = this.queuedFollowUps.find((candidate) => candidate.id === id);
    if (!item) return;
    await this.cancelQueuedFollowUp(id);
    this.suppressQueueDrain = true;
    try { await this.controller.cancel(); }
    finally { this.suppressQueueDrain = false; }
    await this.executeSubmission(
      {
        text: item.text,
        webSearch: item.webSearch,
        mode: "send",
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
      },
      { includeContextFiles: item.includeContextFiles },
    );
  }

  private async prepareRetry(messageIdToRetry: string): Promise<void> {
    const snapshot = this.transcript.snapshot();
    const index = snapshot.messages.findIndex((message) => message.message_id === messageIdToRetry);
    const message = snapshot.messages[index];
    if (index < 0 || message?.role !== "user") return;
    if (this.activeRunPromise) {
      new Notice("Wait for the current response to finish before retrying from here.", 5000);
      return;
    }
    if (this.workspace?.hasDraft()) {
      new Notice("Send or clear the current draft before retrying from here.", 5000);
      this.workspace.focus();
      return;
    }
    const hydratedMessage = await this.attachmentStore.hydrateMessage(message as ChatMessage);
    const draft = restoreChatMessageDraft(hydratedMessage);
    const expectedAttachments = message.attachmentMetadata?.length ?? 0;
    if (draft.attachments.length < expectedAttachments) {
      const warning = "One or more attachments are unavailable. They were left out of this retry.";
      this.workspace?.setBanner(warning, "error");
      new Notice(warning, 8000);
    }
    this.pendingRetry = {
      kind: "resend",
      message: { ...message } as ChatMessage,
      targetMessageId: messageIdToRetry,
      expectedIndex: index,
      expectedVersion: snapshot.version,
    };
    this.workspace?.setInputText(draft.text, { focus: true });
    if (draft.attachments.length) this.workspace?.restoreMessageAttachments(draft.attachments);
  }

  private respondToToolApproval(approvalId: string, approved: boolean, rememberForChat = false): void {
    const tool = this.controller.getSnapshot().parts.find((part) =>
      part.kind === "tool" && part.approvalId === approvalId);
    const trustedToolName = approved && rememberForChat && tool?.kind === "tool"
      ? tool.name
      : null;
    const wasAlreadyTrusted = trustedToolName
      ? this.sessionTrustedToolNames.has(trustedToolName)
      : false;
    if (trustedToolName) this.sessionTrustedToolNames.add(trustedToolName);
    const settled = this.controller.respondToApproval(approvalId, approved);
    if (!settled && trustedToolName && !wasAlreadyTrusted) {
      this.sessionTrustedToolNames.delete(trustedToolName);
    }
  }

  private async startNewChat(
    focus = true,
    title?: string,
    restoredDraftKey?: string,
  ): Promise<void> {
    this.suppressQueueDrain = true;
    try { await this.controller.cancel(); }
    finally { this.suppressQueueDrain = false; }
    const previousKey = this.draftKey;
    const carryUndurableQueue = !this.chatId ? [...this.queuedFollowUps] : [];
    if (this.queueHydrated) await this.persistQueueState();
    const preservedKey = restoredDraftKey?.trim();
    this.draftKey = preservedKey || messageId("draft");
    this.queuedFollowUps = preservedKey ? [] : carryUndurableQueue;
    this.pendingRetry = null;
    this.sessionTrustedToolNames.clear();
    this.approvalMode = "ask";
    this.workspace?.setApprovalMode(this.approvalMode);
    this.contextLoading = true;
    try { this.contextManager.clearContext(); }
    finally { this.contextLoading = false; }
    const snapshot = this.transcript.reset({ title: title?.trim() || generateDefaultChatTitle() });
    this.applyTranscriptIdentity(snapshot);
    this.workspace?.setTitle(this.chatTitle);
    this.workspace?.setBanner(null);
    await this.workspace?.setHistory([]);
    await this.workspace?.setAgentSnapshot(null);
    this.syncAttachments();
    this.syncQueue();
    if (preservedKey) {
      await this.hydrateQueue(this.draftKey);
    } else {
      this.queueHydrated = true;
      if (carryUndurableQueue.length > 0) {
        await this.queueRepository.move(previousKey, this.draftKey, carryUndurableQueue);
      } else {
        await this.queueRepository.save(this.draftKey, []);
      }
    }
    this.isFullyLoaded = true;
    this.updateViewState();
    this.app.workspace.trigger("systemsculpt:chat-loaded", "");
    if (focus) this.workspace?.focus();
  }

  private applyTranscriptIdentity(snapshot: AgentTranscriptSnapshot): void {
    this.chatId = snapshot.chatId;
    this.chatTitle = snapshot.title;
    this.chatVersion = snapshot.version;
    this.workspace?.setTitle(this.chatTitle);
  }

  private syncAttachments(): void {
    this.workspace?.setAttachments([...this.contextManager.getContextFiles()].map((entry) => {
      const path = entry.replace(/^\[\[(.*?)\]\]$/, "$1");
      return { id: entry, label: path.split("/").pop() || path, path: entry, kind: "vault" as const };
    }));
  }

  private async addDroppedVaultContext(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Vault file not found: ${path}`, 5000);
      return;
    }
    await this.contextManager.addFileToContext(file);
  }

  private syncQueue(): void {
    this.workspace?.setQueue(this.queuedFollowUps);
  }

  private async hydrateQueue(key: string): Promise<void> {
    try {
      this.queuedFollowUps = [...await this.queueRepository.load(key)];
    } catch (error) {
      this.queuedFollowUps = [];
      this.reportQueuePersistenceError(error, "Queued follow-ups could not be restored.");
    }
    this.queueHydrated = true;
    this.syncQueue();
  }

  private persistQueueState(): Promise<void> {
    if (!this.queueHydrated) return Promise.resolve();
    const key = this.draftKey;
    const items = [...this.queuedFollowUps];
    const pending = this.queuePersistence.then(() => this.queueRepository.save(key, items));
    this.queuePersistence = pending.catch(() => undefined);
    return pending;
  }

  private scheduleQueuePersistence(): void {
    void this.persistQueueState().catch((error) => this.reportQueuePersistenceError(error));
  }

  private pruneAttachmentStore(): Promise<void> {
    return this.attachmentStore.pruneOncePerSession(async () => {
      const [chatReferences, queueReferences] = await Promise.all([
        this.chatStorage.collectAttachmentRefKeys(),
        this.queueRepository.collectAttachmentRefKeys(),
      ]);
      // Reference discovery fails closed. Keeping an orphan is preferable to
      // deleting a blob referenced by a temporarily unreadable chat or queue.
      if (!chatReferences || !queueReferences) return null;
      return new Set([...chatReferences, ...queueReferences]);
    });
  }

  private async bindQueueToChat(chatId: string): Promise<void> {
    const durableKey = chatId.trim();
    if (!durableKey || this.draftKey === durableKey) return;
    await this.queuePersistence;
    const previousKey = this.draftKey;
    await this.queueRepository.move(previousKey, durableKey, this.queuedFollowUps);
    this.draftKey = durableKey;
    this.queueHydrated = true;
    this.updateViewState();
  }

  private reportQueuePersistenceError(error: unknown, fallback = "Queued follow-ups could not be saved."): void {
    const detail = error instanceof Error ? error.message.trim() : "";
    const message = detail ? `${fallback} ${detail}` : fallback;
    this.workspace?.setBanner(message, "error");
    new Notice(message, 8000);
  }

  private applyFontSize(): void {
    const element = this.workspace?.element;
    if (!element) return;
    element.removeClass("is-font-small", "is-font-medium", "is-font-large");
    element.addClass(`is-font-${this.chatFontSize}`);
  }

  private updateViewState(): void {
    if (!this.leaf) return;
    void this.leaf.setViewState({ type: CHAT_VIEW_TYPE, state: this.getState() }, { focus: false });
  }

  private installWorkspaceBindings(): void {
    this.registerEvent((this.app.workspace as any).on(
      FILE_CONTEXT_STATE_CHANGED_EVENT,
      (event: FileContextStateChangedEvent) => {
        if (event?.manager === this.contextManager) this.syncAttachments();
      },
    ));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) this.workspace?.focus();
    }));
    this.registerEvent(this.app.workspace.on("systemsculpt:settings-updated", () => {
      void this.refreshCreditsBalance();
    }));
  }

  private installRecorderBindings(): void {
    let recorder: RecorderService;
    try { recorder = RecorderService.getInstance(this.app, this.plugin); }
    catch { return; }
    this.recorderToggleUnsubscribe = recorder.onToggle((recording) => this.workspace?.setRecording(recording));
    this.recorderTranscriptUnsubscribe = recorder.onTranscription((text) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      const current = this.getInputText();
      const combined = [current.trim(), text.trim()].filter(Boolean).join(current.trim() ? "\n\n" : "");
      this.setInputText(combined, { focus: true });
      if (this.plugin.settings.autoSubmitAfterTranscription && combined.trim()) {
        this.setInputText("");
        this.acceptComposerSubmission({ text: combined, webSearch: this.isWebSearchEnabled(), mode: "send" });
      }
    });
    this.workspace?.setRecording(recorder.isCurrentlyRecording());
  }

  private async toggleRecording(): Promise<void> {
    try { await RecorderService.getInstance(this.app, this.plugin).toggleRecording(); }
    catch (error) { await this.handleError(error); }
  }

  private async openHistory(): Promise<void> {
    const { SystemSculptHistoryModal } = await import("../history/SystemSculptHistoryModal");
    new SystemSculptHistoryModal(this.plugin).open();
  }

  private async openChatSettings(): Promise<void> {
    const { showStandardChatSettingsModal } = await import("../../modals/StandardChatSettingsModal");
    showStandardChatSettingsModal(this.app, {
      initialValues: {
        approvalMode: this.approvalMode,
        chatFontSize: this.chatFontSize,
      },
      approvalModeDisabled: this.activeRunPromise !== null,
      onChange: (change) => {
        if (change.kind === "approval-mode") {
          return this.setApprovalMode(change.value);
        }
        return this.setChatFontSize(change.value);
      },
    });
  }

  private async openArtifact(artifact: AgentArtifact): Promise<void> {
    if (!artifact.path) return;
    const path = artifact.path.replace(/^\[\[(.*?)\]\]$/, "$1");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Artifact not found: ${path}`);
  }

  private async copyArtifactPath(artifact: AgentArtifact): Promise<void> {
    if (artifact.path) await tryCopyToClipboard(artifact.path);
  }

  private reportControllerError(error: unknown): void {
    if (this.controller.getSnapshot().status === "failed") return;
    void this.handleError(error);
  }
}
