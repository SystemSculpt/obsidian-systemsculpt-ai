import { ItemView, normalizePath, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { getLoadedPluginBuildId } from "../../core/plugin/LoadedPluginBuildIdentity";
import { CHAT_VIEW_TYPE } from "../../core/plugin/viewTypes";
import { SystemSculptService, type CreditsBalanceSnapshot } from "../../services/SystemSculptService";
import type { RecorderService } from "../../services/RecorderService";
import { readManagedToolCallFunction } from "../../services/chat/ManagedToolExecution";
import type { ChatMessage } from "../../types";
import type { ChatExportOptions } from "../../types/chatExport";
import { isMutatingTool, type ToolApprovalPolicy } from "../../utils/toolPolicy";
import { tryCopyToClipboard } from "../../utils/clipboard";
import { getRuntimeCrypto } from "../../utils/runtimeWindow";
import { resolveAbsoluteVaultPath } from "../../utils/vaultPathUtils";
import { generateDefaultChatTitle, sanitizeChatTitle } from "../../utils/titleUtils";
import { ChatStorageService, SavedChatCorruptedError } from "./ChatStorageService";
import {
  FILE_CONTEXT_STATE_CHANGED_EVENT,
  FileContextManager,
  type FileContextStateChangedEvent,
} from "./FileContextManager";
import { ChatExportService } from "./export/ChatExportService";
import type { ChatExportResult } from "./export/ChatExportTypes";
import type { ChatApprovalMode } from "./storage/ChatPersistenceTypes";
import { AgentWorkspace, type AgentQueuedFollowUp } from "./AgentWorkspace";
import type { AgentArtifact, AgentConversationSnapshot } from "./AgentConversation";
import type { AgentComposerSubmit } from "./AgentComposer";
import { presentAgentErrorMessage } from "./AgentConversationPresentation";
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
  FirstPartyAgentChatSession,
  type FirstPartyAgentLifecycleCode,
  type FirstPartyAgentLifecyclePhase,
  type FirstPartyAgentRunResult,
} from "./thin/FirstPartyAgentChatSession";
import { ThinAgentMutationJournal } from "./thin/ThinAgentMutationJournal";
import {
  thinAgentDataUrl,
  toThinAgentUserMessage,
} from "./thin/ThinAgentMessageAdapter";
import {
  THIN_AGENT_CAPABILITIES,
  THIN_AGENT_CAPABILITY_CONTRACT_VERSION,
  THIN_AGENT_CONTRACT_VERSION,
  type ThinAgentBootstrapRequest,
  type ThinAgentContextSource,
} from "../../services/managed/ThinAgentV1Contract";
import { AgentQueueStateRepository } from "./AgentQueueStateRepository";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  type ThinAgentInputLimits,
} from "../../services/managed/ThinAgentInputLimits";
import { isVaultImageContextFileExtension } from "../../constants/fileTypes";
import { showConfirm } from "../../core/ui/notifications";

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

type PendingHistoricalResubmit = Extract<AgentUserCommitInput, { kind: "resend" }> & Readonly<{
  attachments: readonly ChatMessageAttachment[];
  laterMessageCount: number;
  unavailableAttachmentCount: number;
  requiresReplayConfirmation: boolean;
}>;

type PreparedHistoricalResubmit = Readonly<{
  pending: PendingHistoricalResubmit;
  text: string;
  hasLaterUserMessage: boolean;
}>;

type PendingRejectedSubmissionRetry = Readonly<{
  turnId: string;
  submission: AgentComposerSubmit;
  historicalResubmit?: PendingHistoricalResubmit;
}>;

type PendingForkHistory = Readonly<{
  turnId: string;
  prefix: readonly ChatMessage[];
}>;

type DeferredRecoveredCompletion = Readonly<{
  conversationOriginToken: string;
  conversationId: string;
  turnId: string;
}>;

const LEGACY_HISTORY_VIEW_ONLY_BANNER =
  "This older saved chat is view-only. You can read or export it. Start a new chat to continue.";
const LEGACY_HISTORY_VIEW_ONLY_COMPOSER =
  "View-only saved chat. Start a new chat to continue.";
const AGENT_SESSION_RESTORE_ERROR =
  "The agent session could not be restored. This cached transcript is shown for reference. Reload the chat to try again.";

type ActiveSubmissionOperation = {
  readonly kind: "submission" | "transition";
  readonly id: string;
  readonly conversationOriginToken: string;
  readonly turnId: string | null;
  readonly originalSubmission: AgentComposerSubmit | null;
  readonly restoreRejectedSubmission: boolean;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  preparedSubmission: AgentComposerSubmit | null;
  runPromise: Promise<FirstPartyAgentRunResult> | null;
  includeContextFiles: boolean;
  draftRestored: boolean;
  draftRestorable: boolean;
  userCommitted: boolean;
  settled: boolean;
};

function messageId(prefix: string): string {
  const crypto = getRuntimeCrypto();
  const uuid = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function protocolId(prefix: "client" | "conversation"): string {
  const crypto = getRuntimeCrypto();
  let hex = "";
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } else {
    hex = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
      .padEnd(32, "0")
      .slice(0, 32);
  }
  return `${prefix}_${hex}`;
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

function imageMimeType(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  return "image/png";
}

function historicalReplayToolOccurrences(
  message: Readonly<ChatMessage>,
): readonly NonNullable<ChatMessage["tool_calls"]>[number][] {
  const tools = [...(message.tool_calls ?? [])];
  for (const part of message.messageParts ?? []) {
    if (part.type === "tool_call") tools.push(part.data);
  }
  return tools;
}

function cachedTranscriptRecoverySnapshot(
  messages: readonly Readonly<ChatMessage>[],
): AgentConversationSnapshot | null {
  const hasCachedExecutingTool = messages.some((message) =>
    historicalReplayToolOccurrences(message).some((tool) => tool.state === "executing"));
  if (!hasCachedExecutingTool) return null;
  return Object.freeze({
    runId: null,
    turnId: null,
    status: "running",
    phase: "retrying",
    statusLabel: "Recovering",
    messages: Object.freeze([]),
    parts: Object.freeze([]),
  });
}

function historicalReplayToolSignature(
  tool: NonNullable<ChatMessage["tool_calls"]>[number],
): string | null {
  const fn = readManagedToolCallFunction(tool);
  try {
    return JSON.stringify({
      functionName: fn?.name ?? null,
      functionArguments: fn?.arguments ?? null,
      state: typeof tool.state === "string" ? tool.state : null,
      result: tool.result ?? null,
      executedOn: "executedOn" in tool ? tool.executedOn ?? null : null,
    });
  } catch {
    return null;
  }
}

function historicalResubmitConsequences(
  messages: readonly Readonly<ChatMessage>[],
  targetIndex: number,
): Readonly<{ laterMessageCount: number; requiresReplayConfirmation: boolean }> {
  const laterMessages = messages.slice(targetIndex + 1)
    .filter((message) => message.role === "user" || message.role === "assistant");
  const tools: NonNullable<ChatMessage["tool_calls"]>[number][] = [];
  const seenToolIds = new Set<string>();
  let hasAmbiguousReplayHistory = false;
  for (const message of laterMessages) {
    const messageTools = new Map<string, {
      tool: NonNullable<ChatMessage["tool_calls"]>[number];
      signature: string;
    }>();
    for (const tool of historicalReplayToolOccurrences(message)) {
      const toolId = typeof tool.id === "string" ? tool.id.trim() : "";
      if (!toolId || seenToolIds.has(toolId)) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      const signature = historicalReplayToolSignature(tool);
      if (signature === null) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      const existing = messageTools.get(toolId);
      if (existing) {
        if (existing.signature !== signature) hasAmbiguousReplayHistory = true;
        continue;
      }
      messageTools.set(toolId, { tool, signature });
    }
    for (const [toolId, entry] of messageTools) {
      if (!toolId || seenToolIds.has(toolId)) {
        hasAmbiguousReplayHistory = true;
        continue;
      }
      seenToolIds.add(toolId);
      tools.push(entry.tool);
    }
  }
  const explicitlyDidNotStart = new Set([
    "USER_DENIED",
    "TOOL_CANCELLED_BEFORE_START",
  ]);
  const requiresReplayConfirmation = hasAmbiguousReplayHistory || tools.some((tool) => {
    const name = readManagedToolCallFunction(tool)?.name;
    if (!name) return true;
    if (!isMutatingTool(name)) return false;
    const code = tool.result?.error?.code;
    return !code || !explicitlyDidNotStart.has(String(code));
  });
  let laterMessageCount = 0;
  for (let index = 0; index < laterMessages.length;) {
    laterMessageCount += 1;
    if (laterMessages[index].role !== "assistant") {
      index += 1;
      continue;
    }
    // The renderer presents consecutive assistant protocol records as one
    // response. Keep edit/resubmit consequences in those same user-visible
    // units instead of counting reasoning, tool, and answer records
    // separately.
    do { index += 1; }
    while (index < laterMessages.length && laterMessages[index].role === "assistant");
  }
  return {
    laterMessageCount,
    requiresReplayConfirmation,
  };
}

function terminalLiveResubmitConsequences(
  snapshot: AgentConversationSnapshot | null,
  targetTurnId: string,
  laterMessages: readonly Readonly<ChatMessage>[],
): Readonly<{ laterMessageCount: number; requiresReplayConfirmation: boolean }> {
  if (
    !snapshot
    || snapshot.turnId !== targetTurnId
    || (
      snapshot.status !== "completed"
      && snapshot.status !== "cancelled"
      && snapshot.status !== "failed"
    )
  ) {
    return { laterMessageCount: 0, requiresReplayConfirmation: false };
  }
  const durableMessageIds = new Set(
    laterMessages.map((message) => message.message_id),
  );
  const hasUnpersistedProjection = snapshot.messages.some((message) =>
    !durableMessageIds.has(message.id));
  if (!hasUnpersistedProjection && snapshot.messages.length > 0) {
    return { laterMessageCount: 0, requiresReplayConfirmation: false };
  }
  const explicitlyDidNotStart = new Set([
    "USER_DENIED",
    "TOOL_CANCELLED_BEFORE_START",
  ]);
  const relevantParts = snapshot.parts.filter((part) =>
    part.kind !== "error" && (
      snapshot.messages.length === 0
      || snapshot.messages.some((message) => message.partIds.includes(part.id))
    ));
  const requiresReplayConfirmation = relevantParts.some((part) => {
    if (
      part.kind !== "tool"
      || part.location !== "vault"
      || !isMutatingTool(part.name)
    ) return false;
    const code = part.error?.code;
    if (part.state === "denied") return false;
    if (code && explicitlyDidNotStart.has(code)) return false;
    return true;
  });
  return {
    laterMessageCount: relevantParts.length > 0 ? 1 : 0,
    requiresReplayConfirmation,
  };
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
  private agent: FirstPartyAgentChatSession;
  private readonly agentBaseUrl: string;
  // One journal per view, not per conversation: it owns a single file, so a
  // second instance on the same path would race the first.
  private readonly agentMutationJournal: ThinAgentMutationJournal;
  private readonly documentAttachmentProcessor: ManagedChatDocumentAttachmentProcessor;
  private readonly attachmentStore: ChatAttachmentVaultStore;
  private readonly queueRepository: AgentQueueStateRepository;
  private workspace: AgentWorkspace | null = null;
  private exportService: ChatExportService | null = null;
  private creditsPromise: Promise<void> | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private transcriptCommitUnsubscribe: (() => void) | null = null;
  private recorderToggleUnsubscribe: (() => void) | null = null;
  private recorderTranscriptUnsubscribe: (() => void) | null = null;
  private contextLoading = false;
  private activeSubmissionOperation: ActiveSubmissionOperation | null = null;
  private queuedFollowUps: AgentQueuedFollowUp[] = [];
  private draftKey: string;
  private conversationOriginToken = messageId("conversation-origin");
  private readonly runConversationOrigins = new Map<string, string>();
  private queueHydrated = false;
  private queuePersistence: Promise<void> = Promise.resolve();
  private pendingRetry: PendingHistoricalResubmit | null = null;
  private pendingRejectedRetry: PendingRejectedSubmissionRetry | null = null;
  private messageEditGeneration = 0;
  private automationApprovalMode: AutomationApprovalMode = "interactive";
  private readonly sessionTrustedToolNames = new Set<string>();
  private queueDrainSuppressionDepth = 0;
  private chatInputLimits: ThinAgentInputLimits = DEFAULT_THIN_AGENT_INPUT_LIMITS;
  private thinBootstrapRequest: ThinAgentBootstrapRequest | null = null;
  private pendingThinConversationId: string | null = null;
  private readonly thinClientId: string;
  private loadedPluginBuildId: Promise<`sha256:${string}`> | null = null;
  private pendingForkHistory: PendingForkHistory | null = null;
  private deferredRecoveredCompletion: DeferredRecoveredCompletion | null = null;
  private legacyHistoryViewOnly = false;

  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.thinClientId = /^client_[a-f0-9]{32}$/.test(
      plugin.settings.thinAgentClientId ?? "",
    )
      ? plugin.settings.thinAgentClientId!
      : protocolId("client");
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
        if (!this.contextLoading && this.chatId && !this.legacyHistoryViewOnly) {
          const snapshot = await this.transcript.saveMetadata();
          this.applyTranscriptIdentity(snapshot);
        }
      },
    });
    this.transcript = new AgentTranscriptRepository(this.chatStorage, () => ({
      // `context_files` is the persisted compatibility key. Its values are
      // precisely the files the user pinned for rereading on every message.
      contextFiles: new Set(this.contextManager.getPinnedFiles()),
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

    this.agentBaseUrl = new URL(this.aiService.baseUrl).origin;
    this.agentMutationJournal = new ThinAgentMutationJournal(
      plugin.app.vault.adapter,
      normalizePath([
        plugin.app.vault.configDir,
        "plugins",
        plugin.manifest.id,
        "thin-agent-mutations.json",
      ].join("/")),
    );
    this.agent = this.createAgentSession();
  }

  /**
   * Builds a session for exactly one conversation.
   *
   * A session owns a conversation's connection, its active run, and every
   * derived flag such as "is a run in progress". Reusing one instance across
   * conversations means each switch has to remember to reset all of that, and
   * anything missed leaks into the next chat: a brand-new conversation could
   * report a previous chat's run as still working, refuse a tool-access
   * change, and queue its first message behind a run that no longer exists.
   * Building a fresh session per conversation makes that unrepresentable, and
   * lets independent conversations run at the same time.
   */
  private createAgentSession(): FirstPartyAgentChatSession {
    return new FirstPartyAgentChatSession({
      baseUrl: this.agentBaseUrl,
      pluginVersion: this.plugin.manifest.version,
      licenseKey: () => this.plugin.settings.licenseKey,
      bootstrapRequest: () => {
        if (!this.thinBootstrapRequest) {
          throw new Error("SystemSculpt started before this message was ready.");
        }
        return this.thinBootstrapRequest;
      },
      mutationJournal: this.agentMutationJournal,
      executeLocalTool: (call, signal) => this.aiService.executeLocalVaultToolCall({
          toolCall: {
            id: call.callId,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {}),
            },
          },
          chatView: this,
          signal,
        }),
      persistAssistant: async (message) => {
        const snapshot = await this.transcript.persistAssistant(message);
        this.applyTranscriptIdentity(snapshot);
      },
      reconcileHistory: (messages) => this.reconcileAgentHistory(messages),
      updateInputLimits: (limits) => {
        this.chatInputLimits = limits;
        this.workspace?.setMessageAttachmentLimits(limits);
      },
      refreshCredits: () => this.refreshCreditsBalance(),
      reportError: (error) => this.logAgentError(error, "agentSession"),
      onLifecycle: (record) => this.plugin.getLogger().lifecycle({ ...record }),
    });
  }

  private bindAgentSession(): void {
    this.agentUnsubscribe = this.agent.subscribe((snapshot) => {
      this.renderAgentSnapshot(snapshot);
      if (this.automationApprovalMode === "deny") {
        for (const part of snapshot.parts) {
          if (part.kind === "tool" && part.state === "approval-required" && part.approvalId) {
            this.agent.respondToApproval(part.approvalId, false);
          }
        }
      }
    });
  }

  /**
   * Hands the next conversation its own session instead of recycling this
   * one. The outgoing session is detached independently, so a run it still
   * owns settles on its own timeline and can never report itself as active to
   * the conversation that replaced it.
   */
  private replaceAgentSession(): void {
    const previous = this.agent;
    this.agentUnsubscribe?.();
    this.agentUnsubscribe = null;
    this.agent = this.createAgentSession();
    this.bindAgentSession();
    void previous.detach().catch((error) =>
      this.reportAgentError(error, "retireAgentSession"));
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
      onSubmit: (submission) => this.acceptComposerSubmission(
        submission,
        this.conversationOriginToken,
      ),
      onStop: () => this.stopActiveRun(),
      onAttach: () => this.contextManager.openPinFiles(),
      onVaultContextDrop: (path) => this.pinDroppedVaultFile(path),
      documentAttachmentProcessor: this.documentAttachmentProcessor,
      attachmentLimits: this.chatInputLimits,
      onMic: () => this.toggleRecording(),
      onRemoveAttachment: async (attachment) => {
        await this.contextManager.unpinFile(attachment.path || attachment.label);
      },
      onApprove: (approvalId, approved, rememberForChat) => this.respondToToolApproval(approvalId, approved, rememberForChat),
      onOpenArtifact: (artifact) => this.openArtifact(artifact),
      onCopyArtifactPath: (artifact) => this.copyArtifactPath(artifact),
      onRetryFailedTurn: (id) => this.retryFailedTurn(id),
      onRetryMessage: (id) => this.prepareRetry(id),
      onResubmitMessage: (id, text) => this.resubmitMessage(id, text),
      onCancelMessageEdit: (id) => this.cancelMessageEdit(id),
      onCopyText: (text) => tryCopyToClipboard(text, this.containerEl),
      onNewChat: () => this.startNewChat(),
      onOpenHistory: () => this.openHistory(),
      onOpenSettings: () => this.openChatSettings(),
      onOpenCredits: () => this.openCreditsBalanceModal(),
      onCancelQueued: async (id) => { await this.cancelQueuedFollowUp(id); },
      onRunQueuedNow: (id) => this.runQueuedFollowUpNow(id),
      onApprovalModeChange: (mode) => {
        void this.setApprovalMode(mode)
          .catch((error) => this.reportAgentError(error, "approvalModeChange"));
      },
    });
    this.addChild(this.workspace);
    this.bindAgentSession();
    this.register(() => this.agentUnsubscribe?.());
    this.installRecorderBindings();
    this.installWorkspaceBindings();
    this.applyFontSize();
    this.syncAttachments();
    this.workspace.setApprovalMode(this.approvalMode);

    if (this.chatId) await this.loadChatById(this.chatId);
    else await this.startNewChat(false, undefined, this.draftKey);
    void this.refreshCreditsBalance();
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
      const incomingDraftKey = state?.draftKey?.trim();
      const preservesCurrentDraft = this.isFullyLoaded
        && !this.chatId
        && Boolean(incomingDraftKey)
        && incomingDraftKey === this.draftKey;
      if (!preservesCurrentDraft) {
        await this.startNewChat(false, state?.chatTitle, state?.draftKey);
      } else {
        const incomingTitle = state?.chatTitle?.trim();
        if (incomingTitle && incomingTitle !== this.chatTitle) {
          this.chatTitle = incomingTitle;
          this.workspace?.setTitle(incomingTitle);
        }
      }
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
    this.conversationOriginToken = messageId("conversation-origin");
    const loadOriginToken = this.conversationOriginToken;
    const transition = this.beginConversationTransition(loadOriginToken);
    let thinConversationHydrated = false;
    try {
      // Retire the outgoing draft identity before cancelling it. Any stale
      // preparation belongs to the replaced draft, not this chat.
      this.pendingThinConversationId = null;
      this.thinBootstrapRequest = null;
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      this.pendingRejectedRetry = null;
      this.workspace?.resetMessageEditor();
      if (this.queueHydrated) await this.persistQueueState();
      await this.agent.cancel();
      this.agent.disconnect();
      this.sessionTrustedToolNames.clear();
      this.isFullyLoaded = false;
      this.pendingForkHistory = null;
      this.deferredRecoveredCompletion = null;
      this.setLegacyHistoryViewOnly(false);
      this.workspace?.setBanner("Loading chat…");
      let loaded;
      try {
        loaded = await this.transcript.load(chatId);
      } catch (error) {
        const message = error instanceof SavedChatCorruptedError
          ? "This saved chat is corrupted and was left unchanged. Start a new chat to continue."
          : "This chat could not be loaded.";
        await this.resetAfterFailedChatLoad(message);
        return;
      }
      if (!loaded) {
        await this.resetAfterFailedChatLoad("This chat could not be loaded.");
        return;
      }
      this.contextLoading = true;
      try { await this.contextManager.setPinnedFiles([...loaded.contextFiles]); }
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
      const recoverySnapshot = loaded.agentConversationId
        ? cachedTranscriptRecoverySnapshot(loaded.messages)
        : null;
      await this.workspace?.setAgentSnapshot(recoverySnapshot);
      const legacyHistoryViewOnly = loaded.messages.length > 0 && !loaded.agentConversationId;
      this.setLegacyHistoryViewOnly(legacyHistoryViewOnly);
      let hydrationFailed = false;
      if (loaded.agentConversationId) {
        const conversationId = loaded.agentConversationId;
        this.pendingThinConversationId = conversationId;
        try {
          const pluginBuildId = await this.getLoadedPluginBuildId();
          if (
            this.conversationOriginToken !== loadOriginToken
            || this.pendingThinConversationId !== conversationId
          ) return;
          this.thinBootstrapRequest = {
            contract_version: THIN_AGENT_CONTRACT_VERSION,
            conversation_id: conversationId,
            client_id: this.thinClientId,
            plugin_build_id: pluginBuildId,
            capability_manifest: {
              contract_version: THIN_AGENT_CAPABILITY_CONTRACT_VERSION,
              capabilities: THIN_AGENT_CAPABILITIES,
            },
          };
          // Opening a chat is a local act: the cache renders and the composer
          // is ready without any server round trip. The session connects when
          // the user actually sends a message. The one exception is a cached
          // unfinished run — its owner already sent a message, so the session
          // reconnects now to resume or settle that run.
          if (recoverySnapshot) {
            await this.agent.hydrate(conversationId);
          }
          if (
            this.conversationOriginToken !== loadOriginToken
            || this.pendingThinConversationId !== conversationId
          ) return;
          thinConversationHydrated = true;
        } catch (error) {
          if (
            this.conversationOriginToken !== loadOriginToken
            || this.pendingThinConversationId !== conversationId
          ) return;
          hydrationFailed = true;
          this.logAgentError(error, "loadChatHydration");
          try {
            await this.workspace?.setAgentSnapshot(null);
          } catch (renderError) {
            this.logAgentError(renderError, "loadChatHydrationReset");
          }
          this.workspace?.setBanner(AGENT_SESSION_RESTORE_ERROR, "error");
        }
      } else if (loaded.messages.length === 0) {
        this.pendingThinConversationId = protocolId("conversation");
        void this.prepareThinConversation(this.pendingThinConversationId)
          .catch((error) => this.reportAgentError(error, "prepareThinConversation"));
      }
      this.syncAttachments();
      if (!legacyHistoryViewOnly && !hydrationFailed) {
        this.workspace?.setBanner(null);
      }
      this.isFullyLoaded = true;
      this.updateViewState();
      this.app.workspace.trigger("systemsculpt:chat-loaded", this.chatId);
    } finally {
      this.finishSubmissionOperation(transition);
      this.promoteDeferredRecoveredCompletion(loadOriginToken);
      if (thinConversationHydrated) {
        this.promoteHydratedQueuedSubmission(loadOriginToken);
      }
    }
  }

  private async resetAfterFailedChatLoad(message: string): Promise<void> {
    await this.startNewChat(false);
    this.workspace?.setBanner(message, "error");
  }

  public async saveChat(): Promise<void> {
    if (!this.chatId || this.legacyHistoryViewOnly) return;
    const snapshot = await this.transcript.saveMetadata();
    this.applyTranscriptIdentity(snapshot);
  }

  public getMessages(): ChatMessage[] { return this.messages; }
  public getChatTitle(): string { return this.chatTitle; }
  public getConversationOriginToken(): string { return this.conversationOriginToken; }

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
    if (this.isRunActive()) {
      throw new Error("Tool access cannot change while SystemSculpt is working.");
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

  public async pinFile(file: TFile): Promise<void> {
    if (this.blockLegacyHistoryAction()) return;
    await this.contextManager.pinVaultFile(file);
  }

  public async addFileToContext(file: TFile): Promise<void> {
    await this.pinFile(file);
  }

  public focusInput(): void { this.workspace?.focus(); }
  public getInputText(): string { return this.workspace?.getInputText() || ""; }
  public setInputText(value: string | object, options?: { focus?: boolean }): void {
    this.workspace?.setInputText(typeof value === "string" ? value : JSON.stringify(value, null, 2), options);
  }
  public getMessageAttachments(): readonly ChatMessageAttachment[] {
    return this.workspace?.getMessageAttachments() || [];
  }
  public setMessageAttachments(attachments: readonly ChatMessageAttachment[]): void {
    this.workspace?.setMessageAttachments(attachments);
  }
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
    if (this.blockLegacyHistoryAction()) return;
    const expectedConversationOriginToken = this.conversationOriginToken;
    const previous = this.automationApprovalMode;
    if (options.approvalMode) this.automationApprovalMode = options.approvalMode;
    try {
      await this.executeSubmission(
        { text, mode: "send" },
        {
          includeContextFiles: options.includeContextFiles !== false,
          expectedConversationOriginToken,
        },
      );
    } finally {
      this.automationApprovalMode = previous;
      if (options.focusAfterSend !== false) this.focusInput();
    }
  }

  public getAutomationSnapshot(): Record<string, unknown> {
    const run = this.agent.getSnapshot();
    return {
      chatId: this.chatId,
      chatTitle: this.chatTitle,
      inputText: this.getInputText(),
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
      this.workspace?.setCreditsBalance(null);
      return;
    }
    if (this.creditsPromise) return this.creditsPromise;
    this.creditsPromise = (async () => {
      try {
        this.creditsBalance = await this.aiService.getCreditsBalance();
        this.workspace?.setCreditsBalance(this.creditsBalance);
      } catch {
        this.workspace?.setCreditsBalance(null);
      }
    })().finally(() => { this.creditsPromise = null; });
    return this.creditsPromise;
  }

  public async openCreditsBalanceModal(): Promise<void> {
    await this.plugin.openCreditsBalanceModal({
      initialBalance: this.creditsBalance,
      onBalanceUpdated: async (balance) => {
        this.creditsBalance = balance;
        this.workspace?.setCreditsBalance(balance);
      },
      settingsTab: "account",
    });
  }

  public async handleError(error: unknown): Promise<void> {
    // Session failures reject with structured payloads ({code, message,
    // retryable}), not Error instances — read message the same way as
    // retryable so an object never renders as "[object Object]".
    const structuredMessage = error
      && typeof error === "object"
      && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message).trim()
      : "";
    const rawMessage = error instanceof Error
      ? error.message
      : structuredMessage
        || (typeof error === "string" && error.trim()
          ? error
          : "SystemSculpt could not complete the response.");
    const retryable = Boolean(
      error
      && typeof error === "object"
      && !Array.isArray(error)
      && (error as { retryable?: unknown }).retryable === true,
    );
    this.workspace?.setBanner(
      presentAgentErrorMessage(rawMessage, retryable),
      "error",
    );
  }

  public async onClose(): Promise<void> {
    this.beginQueueDrainSuppression();
    const closingSubmission = this.activeSubmissionOperation?.kind === "submission"
      ? this.activeSubmissionOperation
      : null;
    this.conversationOriginToken = messageId("conversation-origin");
    const closeOriginToken = this.conversationOriginToken;
    const transition = this.beginConversationTransition(closeOriginToken);
    // Obsidian can close a transient view while its no-spend warm bootstrap is
    // still in flight. Invalidate that work before closing the connection so
    // the expected cancellation cannot surface as a user-facing agent error.
    this.pendingThinConversationId = null;
    this.thinBootstrapRequest = null;
    try {
      await this.agent.detach();
      await this.transcript.idle();
      if (closingSubmission && !closingSubmission.userCommitted) {
        const submission = closingSubmission.preparedSubmission
          ?? closingSubmission.originalSubmission;
        if (submission) {
          this.queuedFollowUps.unshift({
            id: messageId("queued"),
            text: submission.text,
            includeContextFiles: closingSubmission.includeContextFiles,
            ...(submission.attachments?.length
              ? { attachments: submission.attachments }
              : {}),
          });
          this.syncQueue();
        }
      }
      if (this.chatId && this.draftKey !== this.chatId) {
        await this.bindQueueToChat(this.chatId)
          .catch((error) => this.reportQueuePersistenceError(error));
      }
      if (this.queueHydrated) {
        await this.persistQueueState().catch((error) => this.reportQueuePersistenceError(error));
      }
      await this.queuePersistence;
      this.agentUnsubscribe?.();
      this.transcriptCommitUnsubscribe?.();
      this.recorderToggleUnsubscribe?.();
      this.recorderTranscriptUnsubscribe?.();
      this.workspace = null;
    } finally {
      // A submit that began while Obsidian was closing must not resume against
      // a destroyed view when the transition promise settles.
      this.conversationOriginToken = messageId("conversation-origin");
      this.finishSubmissionOperation(transition);
    }
  }

  private isSubmissionActive(): boolean {
    const sessionStatus = this.agent?.getSnapshot?.()?.status;
    return this.activeSubmissionOperation != null
      || sessionStatus === "running"
      || sessionStatus === "waiting";
  }

  /**
   * Whether a run is actually executing, as opposed to the view merely being
   * between conversations.
   *
   * Local policy like tool access has to be protected from changing underneath
   * a live run, but not from a conversation switch: opening a chat runs no
   * model step, so refusing the change there only produces an error the user
   * cannot act on.
   */
  private isRunActive(): boolean {
    const sessionStatus = this.agent?.getSnapshot?.()?.status;
    return this.activeSubmissionOperation?.kind === "submission"
      || sessionStatus === "running"
      || sessionStatus === "waiting";
  }

  private recordUiLifecycle(
    code: FirstPartyAgentLifecycleCode,
    phase: FirstPartyAgentLifecyclePhase = "response",
    conversationId?: string,
  ): void {
    this.agent?.recordLifecycle?.({
      code,
      phase,
      ...(conversationId ? { conversationId } : {}),
    });
  }

  private beginQueueDrainSuppression(): () => void {
    this.queueDrainSuppressionDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.queueDrainSuppressionDepth = Math.max(
        0,
        this.queueDrainSuppressionDepth - 1,
      );
    };
  }

  private isQueueDrainSuppressed(): boolean {
    return this.queueDrainSuppressionDepth > 0;
  }

  private createSubmissionOperation(
    kind: ActiveSubmissionOperation["kind"],
    conversationOriginToken: string,
    submission: AgentComposerSubmit | null,
    restoreRejectedSubmission: boolean,
  ): ActiveSubmissionOperation {
    let resolveFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const originalSubmission = submission
      ? Object.freeze({
          ...submission,
          ...(submission.attachments?.length
            ? { attachments: Object.freeze([...submission.attachments]) }
            : {}),
        })
      : null;
    return {
      kind,
      id: messageId("submission-operation"),
      conversationOriginToken,
      turnId: kind === "submission" ? messageId("user") : null,
      originalSubmission,
      restoreRejectedSubmission,
      controller: new AbortController(),
      finished,
      resolveFinished,
      preparedSubmission: null,
      runPromise: null,
      includeContextFiles: true,
      draftRestored: false,
      draftRestorable: restoreRejectedSubmission,
      userCommitted: false,
      settled: false,
    };
  }

  private beginSubmissionOperation(
    conversationOriginToken: string,
    submission: AgentComposerSubmit,
    restoreRejectedSubmission = true,
  ): ActiveSubmissionOperation | null {
    if (this.isSubmissionActive()) return null;
    const operation = this.createSubmissionOperation(
      "submission",
      conversationOriginToken,
      submission,
      restoreRejectedSubmission,
    );
    this.activeSubmissionOperation = operation;
    this.workspace?.setRunPending(true, operation.turnId ?? undefined);
    this.workspace?.setBanner(null);
    this.recordUiLifecycle("submission_admitted");
    return operation;
  }

  private beginConversationTransition(
    conversationOriginToken: string,
  ): ActiveSubmissionOperation {
    const current = this.activeSubmissionOperation;
    if (current) this.retireSubmissionOperation(current, false);
    else this.workspace?.setRunPending(false);
    const transition = this.createSubmissionOperation(
      "transition",
      conversationOriginToken,
      null,
      false,
    );
    this.activeSubmissionOperation = transition;
    return transition;
  }

  private finishSubmissionOperation(operation: ActiveSubmissionOperation): void {
    if (operation.settled) return;
    const wasActive = this.activeSubmissionOperation === operation;
    if (wasActive) this.activeSubmissionOperation = null;
    if (wasActive) {
      // A settled active operation leaves nothing pending. Transitions must
      // clear this too: otherwise a conversation switch that retires a
      // streaming submission leaves runPending set, and the next empty
      // conversation renders a phantom pending turn.
      this.workspace?.setRunPending(false);
    }
    operation.settled = true;
    operation.resolveFinished();
  }

  private retireSubmissionOperation(
    operation: ActiveSubmissionOperation,
    restoreDraft: boolean,
  ): void {
    if (operation.settled) return;
    operation.controller.abort();
    if (restoreDraft) this.restoreSubmissionDraft(operation);
    this.finishSubmissionOperation(operation);
  }

  private restoreSubmissionDraft(operation: ActiveSubmissionOperation): void {
    if (
      operation.kind !== "submission"
      || operation.draftRestored
      || !operation.draftRestorable
      || !operation.restoreRejectedSubmission
      || operation.userCommitted
      || !this.isCurrentConversationOrigin(operation.conversationOriginToken)
    ) return;
    const submission = operation.preparedSubmission ?? operation.originalSubmission;
    if (!submission) return;
    operation.draftRestored = true;
    this.workspace?.restoreRejectedSubmission(submission);
  }

  private isCurrentSubmissionOperation(operation: ActiveSubmissionOperation): boolean {
    return this.activeSubmissionOperation === operation
      && operation.kind === "submission"
      && !operation.settled
      && !operation.controller.signal.aborted
      && this.isCurrentConversationOrigin(operation.conversationOriginToken);
  }

  private queueSubmission(
    submission: AgentComposerSubmit,
    includeContextFiles: boolean,
  ): void {
    if (this.blockLegacyHistoryAction()) return;
    this.queuedFollowUps.push({
      id: messageId("queued"),
      text: submission.text,
      includeContextFiles,
      ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
    });
    this.recordUiLifecycle("submission_queued");
    this.syncQueue();
    this.scheduleQueuePersistence();
  }

  private acceptComposerSubmission(
    submission: AgentComposerSubmit,
    expectedConversationOriginToken?: string,
    clearComposerAfterAdmission = false,
  ): void | Promise<void> {
    if (this.blockLegacyHistoryAction()) return;
    const admissionOriginToken = expectedConversationOriginToken
      ?? this.conversationOriginToken;
    const currentOperation = this.activeSubmissionOperation;
    if (currentOperation?.kind === "transition") {
      void currentOperation.finished.then(() => {
        if (!this.isCurrentConversationOrigin(admissionOriginToken)) {
          this.restoreDeferredSubmissionAfterTransitions(submission);
          return;
        }
        this.acceptComposerSubmission(
          submission,
          admissionOriginToken,
          clearComposerAfterAdmission,
        );
      });
      return;
    }
    const operation = this.beginSubmissionOperation(
      admissionOriginToken,
      submission,
      !clearComposerAfterAdmission,
    );
    if (!operation) {
      if (this.isCurrentConversationOrigin(admissionOriginToken)) {
        this.queueSubmission(submission, true);
      }
      return;
    }
    void this.prepareSubmission(submission).then((prepared) => {
      operation.preparedSubmission = prepared;
      if (!this.isCurrentSubmissionOperation(operation)) return;
      // Recorder dictation remains visible and recoverable until asynchronous
      // attachment preparation/admission has revalidated the exact chat. Do
      // not erase text the user added while that work was pending.
      if (clearComposerAfterAdmission && this.getInputText() === submission.text) {
        this.setInputText("");
        operation.draftRestorable = true;
      }
      return this.executeSubmission(prepared, {
        expectedConversationOriginToken: admissionOriginToken,
        activeOperation: operation,
      }).catch(async (error) => {
        if (!this.isCurrentConversationOrigin(admissionOriginToken)) return;
        if (operation.controller.signal.aborted) return;
        this.restoreSubmissionDraft(operation);
        await this.handleError(error);
      });
    }).catch(async (error) => {
      const wasCancelled = operation?.controller.signal.aborted === true;
      if (!wasCancelled) this.restoreSubmissionDraft(operation);
      this.finishSubmissionOperation(operation);
      if (!this.isCurrentConversationOrigin(admissionOriginToken)) return;
      if (wasCancelled) return;
      await this.handleError(error);
    });
  }

  private restoreDeferredSubmissionAfterTransitions(
    submission: AgentComposerSubmit,
  ): void {
    const currentOperation = this.activeSubmissionOperation;
    if (currentOperation?.kind === "transition") {
      void currentOperation.finished.then(() => {
        this.restoreDeferredSubmissionAfterTransitions(submission);
      });
      return;
    }
    this.workspace?.restoreRejectedSubmission(submission);
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

  private async readThinAgentContextSources(
    pinnedEntries: ReadonlySet<string>,
  ): Promise<ThinAgentContextSource[]> {
    const sources: ThinAgentContextSource[] = [];
    let textBytes = 0;
    let imageBytes = 0;
    let imageCount = 0;
    for (const entry of pinnedEntries) {
      if (sources.length >= this.chatInputLimits.maxContentBlocksPerMessage) {
        throw new Error("Pinned files exceed the per-message source limit.");
      }
      if (entry.startsWith("doc:")) {
        const documentId = entry.slice(4).trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(documentId)) {
          throw new Error("A pinned document reference is invalid.");
        }
        if (entry.length > 1_024 || entry.includes("\0")) {
          throw new Error("A pinned document path is invalid.");
        }
        sources.push({
          kind: "document_ref",
          path: entry,
          document_id: documentId,
        });
        continue;
      }
      const linkPath = entry.replace(/^\[\[(.*?)\]\]$/, "$1").trim();
      const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, "")
        ?? this.app.vault.getAbstractFileByPath(linkPath)
        ?? (!linkPath.endsWith(".md")
          ? this.app.vault.getAbstractFileByPath(`${linkPath}.md`)
          : null);
      if (!(resolved instanceof TFile)) {
        throw new Error(`Pinned file not found: ${linkPath}`);
      }
      if (resolved.path.length > 1_024 || resolved.path.includes("\0")) {
        throw new Error(`${resolved.name} has an invalid context path.`);
      }
      if (isVaultImageContextFileExtension(resolved.extension)) {
        imageCount += 1;
        if (imageCount > this.chatInputLimits.maxImagesPerTurn) {
          throw new Error("Pinned files exceed the per-message image count limit.");
        }
        if (resolved.stat.size > this.chatInputLimits.maxImageBytes) {
          throw new Error(`${resolved.name} exceeds the pinned image limit.`);
        }
        const bytes = new Uint8Array(await this.app.vault.readBinary(resolved));
        imageBytes += bytes.byteLength;
        if (imageBytes > this.chatInputLimits.maxTotalImageBytes) {
          throw new Error("Pinned images exceed the total per-message image limit.");
        }
        sources.push({
          kind: "image",
          path: resolved.path,
          data_url: thinAgentDataUrl(imageMimeType(resolved.extension), bytes),
        });
      } else {
        const content = await this.app.vault.read(resolved);
        const byteLength = new TextEncoder().encode(content).byteLength;
        if (byteLength > this.chatInputLimits.maxTextBytesPerBlock) {
          throw new Error(`${resolved.name} exceeds the pinned text file limit.`);
        }
        textBytes += new TextEncoder().encode(resolved.path).byteLength + byteLength;
        if (textBytes > this.chatInputLimits.maxTotalTextBytes) {
          throw new Error("Pinned files exceed the total per-message text limit.");
        }
        sources.push({ kind: "text", path: resolved.path, content });
      }
    }
    return sources;
  }

  private getLoadedPluginBuildId(): Promise<`sha256:${string}`> {
    return this.loadedPluginBuildId
      ??= getLoadedPluginBuildId(this.app, this.plugin.manifest);
  }

  /**
   * Prepares a draft conversation entirely locally: identity and bootstrap
   * payload only. A new chat never opens a server connection — the session
   * connects when the user sends their first message, so an offline or slow
   * server can never paint a fresh chat with reconnect or phantom-run state.
   */
  private async prepareThinConversation(conversationId: string): Promise<void> {
    if (!this.plugin.settings.licenseKey?.trim()) return;
    const pluginBuildId = await this.getLoadedPluginBuildId();
    if (this.pendingThinConversationId !== conversationId) return;
    this.thinBootstrapRequest = {
      contract_version: THIN_AGENT_CONTRACT_VERSION,
      conversation_id: conversationId,
      client_id: this.thinClientId,
      plugin_build_id: pluginBuildId,
      capability_manifest: {
        contract_version: THIN_AGENT_CAPABILITY_CONTRACT_VERSION,
        capabilities: THIN_AGENT_CAPABILITIES,
      },
    };
  }

  private async executeSubmission(
    submission: AgentComposerSubmit,
    options: Readonly<{
      includeContextFiles?: boolean;
      restoreRejectedSubmission?: boolean;
      forceDestructiveApproval?: boolean;
      historicalResubmit?: PendingHistoricalResubmit;
      expectedConversationOriginToken?: string;
      activeOperation?: ActiveSubmissionOperation;
    }> = {},
  ): Promise<void> {
    // Composer submissions are externalized at admission; queued attachments
    // are restored from durable refs. Do not rewrite the same CAS payload here.
    const prepared = submission;
    const expectedConversationOriginToken = options.expectedConversationOriginToken
      ?? this.conversationOriginToken;
    if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
    let operation = options.activeOperation;
    if (operation) {
      if (
        this.activeSubmissionOperation !== operation
        || operation.kind !== "submission"
        || operation.conversationOriginToken !== expectedConversationOriginToken
      ) return;
    } else {
      if (this.isSubmissionActive()) {
        if (!options.historicalResubmit) {
          this.queueSubmission(prepared, options.includeContextFiles !== false);
        }
        return;
      }
      const begunOperation = this.beginSubmissionOperation(
        expectedConversationOriginToken,
        prepared,
        options.restoreRejectedSubmission !== false,
      );
      if (!begunOperation) {
        if (!options.historicalResubmit) {
          this.queueSubmission(prepared, options.includeContextFiles !== false);
        }
        return;
      }
      operation = begunOperation;
    }
    operation.preparedSubmission = prepared;
    operation.includeContextFiles = options.includeContextFiles !== false;

    let userMessage: ChatMessage | null = null;
    let run: Promise<FirstPartyAgentRunResult> | null = null;
    let result: FirstPartyAgentRunResult | undefined;
    let queuedPromotion: Readonly<{
      operation: ActiveSubmissionOperation;
      item: AgentQueuedFollowUp;
      submission: AgentComposerSubmit;
    }> | null = null;

    try {
      if (
        options.historicalResubmit
        && !this.transcript.snapshot().agentConversationId
      ) {
        this.setLegacyHistoryViewOnly(true);
        this.blockLegacyHistoryAction();
        return;
      }
      if (!this.isCurrentSubmissionOperation(operation)) return;
      await this.workspace?.setHistory(
        this.transcript.snapshot().messages as readonly ChatMessage[],
      );
      if (!this.isCurrentSubmissionOperation(operation)) return;
      // The completed run remains as the live projection until the durable
      // assistant turn enters history. Clear it before admission so a denied
      // or slow next request never duplicates the previous answer.
      await this.workspace?.setAgentSnapshot(null);
      if (!this.isCurrentSubmissionOperation(operation)) return;

      const attachmentMetadata = composeAttachmentMetadata(
        prepared.text,
        prepared.attachments,
      );
      const admittedUserMessage: ChatMessage = {
        role: "user",
        content: composeUserMessageContent(prepared.text, prepared.attachments),
        message_id: operation.turnId!,
        ...(attachmentMetadata ? { attachmentMetadata } : {}),
      };
      userMessage = admittedUserMessage;
      this.runConversationOrigins.set(
        admittedUserMessage.message_id,
        expectedConversationOriginToken,
      );
      if (this.runConversationOrigins.size > 128) {
        const oldestTurnId = this.runConversationOrigins.keys().next().value;
        if (oldestTurnId) this.runConversationOrigins.delete(oldestTurnId);
      }
      const historicalResubmit = options.historicalResubmit;
      const postHydrationCommit: AgentUserCommitInput = historicalResubmit
        ? {
            kind: "resend",
            message: admittedUserMessage,
            targetMessageId: historicalResubmit.targetMessageId,
            expectedIndex: historicalResubmit.expectedIndex,
            expectedVersion: historicalResubmit.expectedVersion,
          }
        : {
            kind: "append",
            message: admittedUserMessage,
          };
      const forceDestructiveApproval = options.forceDestructiveApproval === true;
      const policy: ToolApprovalPolicy = !forceDestructiveApproval
        && (this.automationApprovalMode === "auto-approve" || this.approvalMode === "full-access")
        ? { requireDestructiveApproval: false }
        : {
            // The active run reads this same set between continuations so an
            // "Allow for chat" choice takes effect before the next tool call.
            trustedToolNames: forceDestructiveApproval
              ? new Set<string>()
              : this.sessionTrustedToolNames,
          };
      if (!this.plugin.settings.licenseKey?.trim()) {
        throw new Error("Add your SystemSculpt license to start a response.");
      }
      const previousConversationId = this.transcript.snapshot().agentConversationId;
      const conversationId = historicalResubmit
        ? protocolId("conversation")
        : previousConversationId
          ?? this.pendingThinConversationId
          ?? protocolId("conversation");
      this.pendingThinConversationId = conversationId;
      if (historicalResubmit) {
        this.pendingForkHistory = {
          turnId: admittedUserMessage.message_id,
          prefix: this.transcript.snapshot().messages
            .slice(0, historicalResubmit.expectedIndex)
            .map((message) => ({ ...message })),
        };
      }

      // The typed message must be on screen before any network work begins.
      // The durable commit still happens in beforeSend once the session is
      // ready; this is presentation only, and a rejected run rolls it back.
      const optimisticHistory: readonly ChatMessage[] = historicalResubmit
        ? [
            ...this.transcript.snapshot().messages
              .slice(0, historicalResubmit.expectedIndex) as readonly ChatMessage[],
            admittedUserMessage,
          ]
        : [
            ...this.transcript.snapshot().messages as readonly ChatMessage[],
            admittedUserMessage,
          ];
      await this.workspace?.setHistory(optimisticHistory);
      if (!this.isCurrentSubmissionOperation(operation)) return;

      const [hydratedUserMessage, contextSources, pluginBuildId] = await Promise.all([
        this.attachmentStore.hydrateMessage(admittedUserMessage),
        this.readThinAgentContextSources(
          options.includeContextFiles === false
            ? new Set()
            : new Set(this.contextManager.getPinnedFiles()),
        ),
        this.getLoadedPluginBuildId(),
      ]);
      if (!this.isCurrentSubmissionOperation(operation)) return;
      if (historicalResubmit) this.agent.disconnect();
      this.thinBootstrapRequest = {
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        conversation_id: conversationId,
        client_id: this.thinClientId,
        plugin_build_id: pluginBuildId,
        capability_manifest: {
          contract_version: THIN_AGENT_CAPABILITY_CONTRACT_VERSION,
          capabilities: THIN_AGENT_CAPABILITIES,
        },
        ...(historicalResubmit && previousConversationId
          ? {
              fork: {
                source_conversation_id: previousConversationId,
                before_message_id: historicalResubmit.targetMessageId,
              },
            }
          : {}),
      };
      run = this.agent.start({
        conversationId,
        turnId: admittedUserMessage.message_id,
        message: toThinAgentUserMessage(hydratedUserMessage),
        buildBody: async (signal) => {
          if (!this.isCurrentSubmissionOperation(operation)) {
            throw new Error("This chat changed before the request was admitted.");
          }
          const staged = await this.agent.stageContext(
            admittedUserMessage.message_id,
            contextSources,
            signal,
          );
          if (!this.isCurrentSubmissionOperation(operation)) {
            throw new Error("This chat changed before the request was admitted.");
          }
          return {
            context_ref: staged.context_ref,
          };
        },
        approvalPolicy: policy,
        beforeSend: async () => {
          if (!this.isCurrentSubmissionOperation(operation)) {
            throw new Error("This chat changed before the request was admitted.");
          }
          await this.commitUserTurn(
            postHydrationCommit,
            conversationId,
            historicalResubmit?.targetMessageId,
            expectedConversationOriginToken,
            operation,
          );
        },
      });
      operation.runPromise = run;
      result = await run;
      if (
        this.activeSubmissionOperation !== operation
        || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      ) return;
      if (historicalResubmit && result.kind === "failed") {
        this.recordUiLifecycle("historical_resubmit_failed");
      }
      const userWasCommitted = this.transcript.snapshot().messages
        .some((message) => message.message_id === admittedUserMessage.message_id);
      operation.userCommitted ||= userWasCommitted;
      if (
        (result.kind === "failed" || result.kind === "cancelled")
        && !userWasCommitted
      ) {
        this.restoreSubmissionDraft(operation);
        // The optimistic bubble is withdrawn with the restored draft so the
        // same words never sit in the transcript and the composer at once.
        await this.workspace?.setHistory(
          this.transcript.snapshot().messages as readonly ChatMessage[],
        );
        if (result.kind === "failed") {
          this.pendingRejectedRetry = {
            turnId: admittedUserMessage.message_id,
            submission: prepared,
            ...(historicalResubmit ? { historicalResubmit } : {}),
          };
        }
      } else if (userWasCommitted) {
        this.pendingRejectedRetry = null;
      }
      this.handleRunResult();
      if (result.kind === "completed") {
        try {
          const cachedMessages = this.transcript.snapshot().messages as readonly ChatMessage[];
          const completedMessage = result.message;
          if (completedMessage) {
            const settlementMessages = cachedMessages.some((message) =>
              message.message_id === completedMessage.message_id)
              ? cachedMessages
              : [...cachedMessages, completedMessage];
            await this.workspace?.settleCompletedRun(settlementMessages);
          }
          // If no cacheable assistant could be derived, keep the bridge's
          // completed live snapshot visible instead of replacing it with a
          // transcript that only contains the user turn.
        } catch (error) {
          this.logAgentError(error, "completedRunSettlement");
        }
      }
    } catch (error) {
      if (
        this.activeSubmissionOperation !== operation
        || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
        || operation.controller.signal.aborted
      ) return;
      throw error;
    } finally {
      if (userMessage) this.clearUncommittedFork(userMessage.message_id);
      if (result?.kind === "completed" && !this.isQueueDrainSuppressed()) {
        queuedPromotion = this.promoteQueuedSubmission(
          operation,
          expectedConversationOriginToken,
        );
      }
      if (!queuedPromotion) this.finishSubmissionOperation(operation);
    }
    if (queuedPromotion) {
      await this.runPromotedQueuedSubmission(
        queuedPromotion,
        expectedConversationOriginToken,
      );
    }
  }

  private async commitUserTurn(
    input: AgentUserCommitInput,
    conversationId: string,
    resubmittedTargetMessageId?: string,
    expectedConversationOriginToken = this.conversationOriginToken,
    operation?: ActiveSubmissionOperation,
  ): Promise<void> {
    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && !this.isCurrentSubmissionOperation(operation))
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    if (!this.chatId && this.transcript.snapshot().messages.length === 0) {
      this.chatTitle = titleFromMessage(plainContent(input.message));
      this.transcript.setTitle(this.chatTitle);
    }
    const snapshot = await this.transcript.commitUser(input, conversationId);
    if (operation) operation.userCommitted = true;
    if (input.kind === "resend") {
      this.recordUiLifecycle("historical_resubmit_committed", "persistence");
    }
    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    this.applyTranscriptIdentity(snapshot);
    if (
      this.pendingRetry
      && this.pendingRetry.targetMessageId === (
        resubmittedTargetMessageId
        ?? (input.kind === "resend" ? input.targetMessageId : undefined)
      )
    ) {
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      this.workspace?.resetMessageEditor();
    }
    await this.bindQueueToChat(snapshot.chatId)
      .catch((error) => this.reportQueuePersistenceError(error));
    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    await this.workspace?.setHistory(snapshot.messages as readonly ChatMessage[]);
    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) return;
    this.updateViewState();
  }

  private handleRunResult(): void {
    this.updateViewState();
  }

  private promoteQueuedSubmission(
    completedOperation: ActiveSubmissionOperation,
    expectedConversationOriginToken: string,
  ): Readonly<{
    operation: ActiveSubmissionOperation;
    item: AgentQueuedFollowUp;
    submission: AgentComposerSubmit;
  }> | null {
    if (
      this.activeSubmissionOperation !== completedOperation
      || completedOperation.controller.signal.aborted
      || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
    ) return null;
    const item = this.queuedFollowUps.shift();
    if (!item) return null;
    const submission: AgentComposerSubmit = {
      text: item.text,
      mode: "send",
      ...(item.attachments?.length ? { attachments: item.attachments } : {}),
    };
    const operation = this.createSubmissionOperation(
      "submission",
      expectedConversationOriginToken,
      submission,
      true,
    );
    operation.preparedSubmission = submission;
    operation.includeContextFiles = item.includeContextFiles;
    this.syncQueue();
    // Install the queued owner before settling the completed owner. There is
    // never an observable idle gap in which a newer composer send can overtake
    // the durable FIFO item while its removal is being persisted.
    this.activeSubmissionOperation = operation;
    this.workspace?.setRunPending(true, operation.turnId ?? undefined);
    this.recordUiLifecycle("queued_submission_promoted");
    this.finishSubmissionOperation(completedOperation);
    return { operation, item, submission };
  }

  private promoteRecoveredQueuedSubmission(
    expectedConversationOriginToken: string,
  ): Readonly<{
    operation: ActiveSubmissionOperation;
    item: AgentQueuedFollowUp;
    submission: AgentComposerSubmit;
  }> | null {
    if (
      this.activeSubmissionOperation
      || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
    ) return null;
    const item = this.queuedFollowUps.shift();
    if (!item) return null;
    const submission: AgentComposerSubmit = {
      text: item.text,
      mode: "send",
      ...(item.attachments?.length ? { attachments: item.attachments } : {}),
    };
    const operation = this.createSubmissionOperation(
      "submission",
      expectedConversationOriginToken,
      submission,
      true,
    );
    operation.preparedSubmission = submission;
    operation.includeContextFiles = item.includeContextFiles;
    this.syncQueue();
    this.activeSubmissionOperation = operation;
    this.workspace?.setRunPending(true, operation.turnId ?? undefined);
    this.recordUiLifecycle("queued_submission_promoted");
    return { operation, item, submission };
  }

  private async runPromotedQueuedSubmission(
    promotion: Readonly<{
      operation: ActiveSubmissionOperation;
      item: AgentQueuedFollowUp;
      submission: AgentComposerSubmit;
    }>,
    expectedConversationOriginToken: string,
  ): Promise<void> {
    try {
      await this.persistQueueState();
    } catch (error) {
      if (this.activeSubmissionOperation === promotion.operation) {
        this.queuedFollowUps.unshift(promotion.item);
        this.syncQueue();
        this.finishSubmissionOperation(promotion.operation);
        this.reportQueuePersistenceError(error);
      }
      return;
    }
    if (!this.isCurrentSubmissionOperation(promotion.operation)) return;
    try {
      await this.executeSubmission(promotion.submission, {
        includeContextFiles: promotion.item.includeContextFiles,
        expectedConversationOriginToken,
        activeOperation: promotion.operation,
      });
    } catch (error) {
      if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      this.restoreSubmissionDraft(promotion.operation);
      await this.handleError(error);
    }
  }

  private async stopActiveRun(): Promise<void> {
    const activeOperation = this.activeSubmissionOperation;
    if (activeOperation?.kind === "transition") return;
    this.recordUiLifecycle("stop_requested");
    if (activeOperation && !activeOperation.runPromise) {
      this.retireSubmissionOperation(activeOperation, true);
      this.recordUiLifecycle("stop_completed");
      return;
    }
    activeOperation?.controller.abort();
    const releaseQueueDrainSuppression = this.beginQueueDrainSuppression();
    try {
      await this.agent.cancel();
      if (activeOperation) await activeOperation.finished;
    }
    finally {
      releaseQueueDrainSuppression();
      this.recordUiLifecycle("stop_completed");
    }
  }

  private async cancelQueuedFollowUp(id: string): Promise<boolean> {
    const index = this.queuedFollowUps.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = this.queuedFollowUps.splice(index, 1);
    this.syncQueue();
    try {
      await this.persistQueueState();
    } catch (error) {
      this.queuedFollowUps.splice(index, 0, removed);
      this.syncQueue();
      this.reportQueuePersistenceError(error);
      return false;
    }
    this.recordUiLifecycle("queued_submission_removed");
    return true;
  }

  private async runQueuedFollowUpNow(id: string): Promise<void> {
    if (this.blockLegacyHistoryAction()) return;
    const releaseQueueDrainSuppression = this.beginQueueDrainSuppression();
    let queueDrainSuppressionReleased = false;
    const expectedConversationOriginToken = this.conversationOriginToken;
    let selectedSubmission: AgentComposerSubmit | null = null;
    try {
      const item = this.queuedFollowUps.find((candidate) => candidate.id === id);
      if (!item) return;
      const submission: AgentComposerSubmit = {
        text: item.text,
        mode: "send",
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
      };
      selectedSubmission = submission;
      if (!(await this.cancelQueuedFollowUp(id))) return;
      if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      await this.stopActiveRun();
      releaseQueueDrainSuppression();
      queueDrainSuppressionReleased = true;
      await this.executeSubmission(
        submission,
        {
          includeContextFiles: item.includeContextFiles,
          expectedConversationOriginToken,
        },
      );
    } catch (error) {
      if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      if (selectedSubmission) {
        this.workspace?.restoreRejectedSubmission(selectedSubmission);
      }
      await this.handleError(error);
    } finally {
      if (!queueDrainSuppressionReleased) releaseQueueDrainSuppression();
    }
  }

  private async prepareRetry(messageIdToRetry: string): Promise<void> {
    if (this.blockLegacyHistoryAction()) return;
    const target = this.transcript.snapshot().messages.find((message) =>
      message.message_id === messageIdToRetry && message.role === "user");
    if (!target) {
      await this.retryRejectedSubmission(messageIdToRetry);
      return;
    }
    const prepared = await this.prepareHistoricalResubmit(messageIdToRetry);
    if (!prepared) return;
    await this.showHistoricalResubmitEditor(prepared);
  }

  private async retryFailedTurn(messageIdToRetry: string): Promise<void> {
    if (this.blockLegacyHistoryAction()) return;
    const target = this.transcript.snapshot().messages.find((message) =>
      message.message_id === messageIdToRetry && message.role === "user");
    if (!target) {
      await this.retryRejectedSubmission(messageIdToRetry);
      return;
    }
    const prepared = await this.prepareHistoricalResubmit(messageIdToRetry);
    if (!prepared) return;
    const active = this.agent.getSnapshot();
    const canRetryDirectly = active?.status === "failed"
      && active.turnId === messageIdToRetry
      && !prepared.hasLaterUserMessage
      && prepared.pending.unavailableAttachmentCount === 0
      && !prepared.pending.requiresReplayConfirmation;
    if (!canRetryDirectly) {
      await this.showHistoricalResubmitEditor(prepared);
      return;
    }
    await this.resubmitMessage(messageIdToRetry, prepared.text);
  }

  private async prepareHistoricalResubmit(
    messageIdToRetry: string,
  ): Promise<PreparedHistoricalResubmit | null> {
    const expectedConversationOriginToken = this.conversationOriginToken;
    const snapshot = this.transcript.snapshot();
    const index = snapshot.messages.findIndex((message) => message.message_id === messageIdToRetry);
    const message = snapshot.messages[index];
    if (index < 0 || message?.role !== "user") return null;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the current response to finish before retrying from here.", 5000);
      return null;
    }
    const generation = ++this.messageEditGeneration;
    const hydratedMessage = await this.attachmentStore.hydrateMessage(message as ChatMessage);
    if (
      generation !== this.messageEditGeneration
      || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || this.isSubmissionActive()
    ) return null;
    const current = this.transcript.snapshot();
    if (
      current.version !== snapshot.version
      || current.messages[index]?.message_id !== messageIdToRetry
    ) {
      new Notice("This chat changed before the message could be edited.", 5000);
      return null;
    }
    const draft = restoreChatMessageDraft(hydratedMessage);
    const expectedAttachments = message.attachmentMetadata?.length ?? 0;
    const unavailableAttachmentCount = Math.max(0, expectedAttachments - draft.attachments.length);
    const durableConsequences = historicalResubmitConsequences(
      snapshot.messages,
      index,
    );
    const liveConsequences = terminalLiveResubmitConsequences(
      this.agent.getSnapshot(),
      messageIdToRetry,
      snapshot.messages.slice(index + 1),
    );
    const consequences = {
      laterMessageCount:
        durableConsequences.laterMessageCount + liveConsequences.laterMessageCount,
      requiresReplayConfirmation:
        durableConsequences.requiresReplayConfirmation
        || liveConsequences.requiresReplayConfirmation,
    };
    const pending: PendingHistoricalResubmit = {
      kind: "resend",
      message: { ...message } as ChatMessage,
      targetMessageId: messageIdToRetry,
      expectedIndex: index,
      expectedVersion: snapshot.version,
      attachments: draft.attachments,
      unavailableAttachmentCount,
      ...consequences,
    };
    this.pendingRetry = pending;
    return {
      pending,
      text: draft.text,
      hasLaterUserMessage: current.messages
        .slice(index + 1)
        .some((entry) => entry.role === "user"),
    };
  }

  private async showHistoricalResubmitEditor(
    prepared: PreparedHistoricalResubmit,
  ): Promise<void> {
    const { pending, text } = prepared;
    await this.workspace?.showMessageEditor({
      messageId: pending.targetMessageId,
      text,
      hasAttachments: pending.attachments.length > 0,
      unavailableAttachmentCount: pending.unavailableAttachmentCount,
      laterMessageCount: pending.laterMessageCount,
      requiresReplayConfirmation: pending.requiresReplayConfirmation,
    });
  }

  private async retryRejectedSubmission(turnId: string): Promise<boolean> {
    if (this.blockLegacyHistoryAction()) return true;
    const expectedConversationOriginToken = this.conversationOriginToken;
    const rejected = this.pendingRejectedRetry;
    if (!rejected || rejected.turnId !== turnId) return false;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the current response to finish before retrying from here.", 5000);
      return true;
    }
    const historicalResubmit = rejected.historicalResubmit;
    if (historicalResubmit) {
      const snapshot = this.transcript.snapshot();
      if (
        snapshot.version !== historicalResubmit.expectedVersion
        || snapshot.messages[historicalResubmit.expectedIndex]?.message_id
          !== historicalResubmit.targetMessageId
      ) {
        new Notice("This chat changed before the edited message could be retried.", 6000);
        return true;
      }
    } else if (!this.consumeRejectedSubmissionDraft(rejected.submission)) {
      this.workspace?.focus();
      new Notice("The failed request is back in the composer. Send it again from there or edit it first.", 6000);
      return true;
    }
    this.pendingRejectedRetry = null;
    try {
      await this.executeSubmission(rejected.submission, {
        expectedConversationOriginToken,
        ...(historicalResubmit
          ? {
              restoreRejectedSubmission: false,
              forceDestructiveApproval:
                historicalResubmit.requiresReplayConfirmation,
              historicalResubmit,
            }
          : {}),
      });
    } catch (error) {
      if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return true;
      if (!this.pendingRejectedRetry) this.pendingRejectedRetry = rejected;
      if (!historicalResubmit) {
        this.workspace?.restoreRejectedSubmission(rejected.submission);
      }
      await this.handleError(error);
    }
    return true;
  }

  private consumeRejectedSubmissionDraft(submission: AgentComposerSubmit): boolean {
    const rejectedText = submission.text.trim();
    const currentText = this.getInputText();
    let remainingText = currentText;
    if (rejectedText) {
      if (currentText === rejectedText) {
        remainingText = "";
      } else if (currentText.startsWith(`${rejectedText}\n\n`)) {
        remainingText = currentText.slice(rejectedText.length + 2);
      } else {
        return false;
      }
    }
    const currentAttachments = this.getMessageAttachments();
    const rejectedAttachments = submission.attachments ?? [];
    if (currentAttachments.length < rejectedAttachments.length) return false;
    for (let index = 0; index < rejectedAttachments.length; index += 1) {
      if (currentAttachments[index]?.id !== rejectedAttachments[index]?.id) return false;
    }
    this.setInputText(remainingText);
    this.setMessageAttachments(currentAttachments.slice(rejectedAttachments.length));
    return true;
  }

  private async cancelMessageEdit(messageIdToCancel: string): Promise<void> {
    if (this.pendingRetry?.targetMessageId !== messageIdToCancel) return;
    this.messageEditGeneration += 1;
    this.pendingRetry = null;
    await this.workspace?.hideMessageEditor(messageIdToCancel);
  }

  private async resubmitMessage(messageIdToResubmit: string, text: string): Promise<boolean> {
    if (this.blockLegacyHistoryAction()) return false;
    const expectedConversationOriginToken = this.conversationOriginToken;
    const pending = this.pendingRetry;
    if (!pending || pending.targetMessageId !== messageIdToResubmit) return false;
    const expectedMessageEditGeneration = this.messageEditGeneration;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the current response to finish before resubmitting this message.", 5000);
      return false;
    }
    if (!text.trim() && pending.attachments.length === 0) return false;
    this.recordUiLifecycle("historical_resubmit_started");

    const snapshot = this.transcript.snapshot();
    if (
      snapshot.version !== pending.expectedVersion
      || snapshot.messages[pending.expectedIndex]?.message_id !== pending.targetMessageId
    ) {
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      await this.workspace?.hideMessageEditor(messageIdToResubmit, false);
      new Notice("This chat changed before the edited message could be resubmitted.", 6000);
      return false;
    }

    if (pending.requiresReplayConfirmation) {
      const { confirmed } = await showConfirm(
        this.app,
        [
          `Resubmitting will replace ${pending.laterMessageCount} later ${
            pending.laterMessageCount === 1 ? "message" : "messages"
          } in this chat.`,
          "Vault changes already made after this message will not be undone.",
          "Any new vault changes will require approval.",
        ].join(" "),
        {
          title: "Resubmit this message?",
          primaryButton: "Resubmit",
          secondaryButton: "Cancel",
          icon: "triangle-alert",
        },
      );
      if (
        !this.isCurrentConversationOrigin(expectedConversationOriginToken)
        || this.messageEditGeneration !== expectedMessageEditGeneration
        || this.pendingRetry !== pending
      ) return false;
      if (!confirmed) return false;
    }

    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || this.messageEditGeneration !== expectedMessageEditGeneration
      || this.pendingRetry !== pending
    ) return false;
    const requestedSubmission: AgentComposerSubmit = {
      text: text.trim(),
      mode: "send",
      ...(pending.attachments.length > 0 ? { attachments: pending.attachments } : {}),
    };
    const operation = this.beginSubmissionOperation(
      expectedConversationOriginToken,
      requestedSubmission,
      false,
    );
    if (!operation) {
      new Notice("Wait for the current response to finish before resubmitting this message.", 5000);
      return false;
    }
    let executionStarted = false;
    let prepared: AgentComposerSubmit;
    try {
      prepared = await this.prepareSubmission(requestedSubmission);
      operation.preparedSubmission = prepared;
      if (
        !this.isCurrentSubmissionOperation(operation)
        || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
        || this.messageEditGeneration !== expectedMessageEditGeneration
        || this.pendingRetry !== pending
      ) return false;
      executionStarted = true;
      await this.executeSubmission(prepared, {
        restoreRejectedSubmission: false,
        forceDestructiveApproval: pending.requiresReplayConfirmation,
        historicalResubmit: pending,
        expectedConversationOriginToken,
        activeOperation: operation,
      });
    } catch (error) {
      if (
        !this.isCurrentConversationOrigin(expectedConversationOriginToken)
        || operation.controller.signal.aborted
      ) return false;
      this.recordUiLifecycle("historical_resubmit_failed");
      this.logAgentError(error, "historicalResubmit");
      await this.handleError(error);
      return false;
    } finally {
      if (!executionStarted) this.finishSubmissionOperation(operation);
    }

    if (!this.isCurrentConversationOrigin(expectedConversationOriginToken)) return false;
    return !this.transcript.snapshot().messages
      .some((message) => message.message_id === messageIdToResubmit);
  }

  private respondToToolApproval(approvalId: string, approved: boolean, rememberForChat = false): void {
    const tool = this.agent.getSnapshot().parts.find((part) =>
      part.kind === "tool" && part.approvalId === approvalId);
    const rememberAllMutations = approved
      && rememberForChat
      && tool?.kind === "tool"
      && tool.location === "vault"
      && isMutatingTool(tool.name)
      && tool.name !== "trash";
    const introducedChatTrust = rememberAllMutations
      && !this.sessionTrustedToolNames.has("*");
    if (rememberAllMutations) this.sessionTrustedToolNames.add("*");
    try {
      const settled = this.agent.respondToApproval(approvalId, approved);
      if (!settled && introducedChatTrust) {
        this.sessionTrustedToolNames.delete("*");
      }
    } catch (error) {
      if (introducedChatTrust) this.sessionTrustedToolNames.delete("*");
      throw error;
    }
  }

  private async startNewChat(
    focus = true,
    title?: string,
    restoredDraftKey?: string,
  ): Promise<void> {
    this.conversationOriginToken = messageId("conversation-origin");
    const newChatOriginToken = this.conversationOriginToken;
    const transition = this.beginConversationTransition(newChatOriginToken);
    try {
      this.setLegacyHistoryViewOnly(false);
      this.pendingForkHistory = null;
      this.deferredRecoveredCompletion = null;
      // The old draft no longer owns preparation errors once New chat wins.
      this.pendingThinConversationId = null;
      this.thinBootstrapRequest = null;
      this.replaceAgentSession();
      this.workspace?.resetComposerDraft();
      const newConversationId = protocolId("conversation");
      this.pendingThinConversationId = newConversationId;
      if (this.queueHydrated) await this.persistQueueState();
      const preservedKey = restoredDraftKey?.trim();
      this.draftKey = preservedKey || messageId("draft");
      this.queuedFollowUps = [];
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      this.pendingRejectedRetry = null;
      this.workspace?.resetMessageEditor();
      this.sessionTrustedToolNames.clear();
      this.approvalMode = "ask";
      this.workspace?.setApprovalMode(this.approvalMode);
      this.contextLoading = true;
      try { this.contextManager.clearPinnedFiles(); }
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
        await this.queueRepository.save(this.draftKey, []);
      }
      this.isFullyLoaded = true;
      this.recordUiLifecycle("conversation_reset", "session", newConversationId);
      this.updateViewState();
      this.app.workspace.trigger("systemsculpt:chat-loaded", "");
      void this.prepareThinConversation(newConversationId)
        .catch((error) => this.reportAgentError(error, "prepareThinConversation"));
      if (focus) this.workspace?.focus();
    } finally {
      this.finishSubmissionOperation(transition);
    }
  }

  private applyTranscriptIdentity(snapshot: AgentTranscriptSnapshot): void {
    this.chatId = snapshot.chatId;
    this.chatTitle = snapshot.title;
    this.chatVersion = snapshot.version;
    this.workspace?.setTitle(this.chatTitle);
  }

  private syncAttachments(): void {
    this.workspace?.setAttachments([...this.contextManager.getPinnedFiles()].map((entry) => {
      const path = entry.replace(/^\[\[(.*?)\]\]$/, "$1");
      const file = this.app.vault.getAbstractFileByPath(path);
      const isImage = file instanceof TFile
        && isVaultImageContextFileExtension(file.extension);
      const previewUrl = isImage ? this.resolveVaultImagePreview(file) : undefined;
      return {
        id: entry,
        label: path.split("/").pop() || path,
        path: entry,
        kind: isImage ? "image" as const : "vault" as const,
        ...(previewUrl ? { previewUrl } : {}),
      };
    }));
  }

  private resolveVaultImagePreview(file: TFile): string | undefined {
    try {
      return this.app.vault.getResourcePath(file) || undefined;
    } catch {
      return undefined;
    }
  }

  private async pinDroppedVaultFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Vault file not found: ${path}`, 5000);
      return;
    }
    await this.contextManager.pinVaultFile(file);
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
    try { recorder = this.plugin.getRecorderService(); }
    catch { return; }
    this.recorderToggleUnsubscribe = recorder.onToggle((recording) => this.workspace?.setRecording(recording));
    this.recorderTranscriptUnsubscribe = recorder.onTranscription((
      text,
      originLeaf,
      conversationOriginToken,
    ) => this.handleRecorderTranscription(text, originLeaf, conversationOriginToken));
    this.workspace?.setRecording(recorder.isCurrentlyRecording());
  }

  private handleRecorderTranscription(
    text: string,
    originLeaf: WorkspaceLeaf | null,
    conversationOriginToken: string | null,
  ): boolean {
    if (
      originLeaf !== this.leaf
      || !conversationOriginToken
      || conversationOriginToken !== this.conversationOriginToken
    ) {
      return false;
    }

    const current = this.getInputText();
    const combined = [current.trim(), text.trim()].filter(Boolean).join(current.trim() ? "\n\n" : "");
    this.setInputText(combined, { focus: this.app.workspace.activeLeaf === this.leaf });
    if (this.plugin.settings.autoSubmitAfterTranscription && combined.trim()) {
      this.acceptComposerSubmission(
        { text: combined, mode: "send" },
        conversationOriginToken,
        true,
      );
    }
    return true;
  }

  private async toggleRecording(): Promise<void> {
    try { await this.plugin.getRecorderService().toggleRecording(); }
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
      approvalModeDisabled: this.isSubmissionActive(),
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

  private async copyArtifactPath(artifact: AgentArtifact): Promise<boolean> {
    return artifact.path
      ? tryCopyToClipboard(artifact.path, this.workspace?.element)
      : false;
  }

  private async reconcileAgentHistory(
    messages: readonly ChatMessage[],
  ): Promise<void> {
    const pendingFork = this.pendingForkHistory;
    const includesForkTurn = pendingFork
      ? messages.some((message) => message.message_id === pendingFork.turnId)
      : false;
    // Fork bootstrap can legitimately return only the source prefix. Do not
    // let that prefix increment the local transcript version before the resend
    // commits against its captured version. The headless chat publishes again
    // after inserting the edited user turn, which releases reconciliation.
    if (pendingFork && !includesForkTurn) return;

    let candidate = messages;
    if (pendingFork) {
      const incomingById = new Map(
        messages.map((message) => [message.message_id, message] as const),
      );
      const prefixIds = new Set(
        pendingFork.prefix.map((message) => message.message_id),
      );
      candidate = [
        ...pendingFork.prefix.map((message) =>
          incomingById.get(message.message_id) ?? message),
        ...messages.filter((message) => !prefixIds.has(message.message_id)),
      ];
    }

    const previousSnapshot = this.transcript.snapshot();
    const snapshot = await this.transcript.reconcileServerHistory(candidate);
    this.applyTranscriptIdentity(snapshot);
    if (
      snapshot.chatId !== previousSnapshot.chatId
      || snapshot.version !== previousSnapshot.version
    ) {
      await this.workspace?.setHistory(snapshot.messages as readonly ChatMessage[]);
    }

    if (
      pendingFork
      && pendingFork.prefix.every((message) =>
        messages.some((candidateMessage) =>
          candidateMessage.message_id === message.message_id))
    ) {
      this.pendingForkHistory = null;
    }
    this.updateViewState();
  }

  private clearUncommittedFork(turnId: string): void {
    if (this.pendingForkHistory?.turnId !== turnId) return;
    if (this.transcript.snapshot().messages.some((message) =>
      message.message_id === turnId)) {
      return;
    }
    this.pendingForkHistory = null;
  }

  private setLegacyHistoryViewOnly(viewOnly: boolean): void {
    this.legacyHistoryViewOnly = viewOnly;
    this.workspace?.setComposerReadOnly?.(
      viewOnly ? LEGACY_HISTORY_VIEW_ONLY_COMPOSER : null,
    );
    if (viewOnly) this.workspace?.setBanner(LEGACY_HISTORY_VIEW_ONLY_BANNER);
  }

  private blockLegacyHistoryAction(): boolean {
    if (!this.legacyHistoryViewOnly) return false;
    this.workspace?.setBanner(LEGACY_HISTORY_VIEW_ONLY_BANNER);
    new Notice(
      "This older saved chat is view-only. Start a new chat to continue.",
      6000,
    );
    return true;
  }

  private reportAgentError(
    error: unknown,
    method = "reportAgentError",
  ): void {
    this.logAgentError(error, method);
    void this.handleError(error);
  }

  private isCurrentConversationOrigin(expectedConversationOriginToken: string): boolean {
    return expectedConversationOriginToken === this.conversationOriginToken;
  }

  private renderAgentSnapshot(snapshot: AgentConversationSnapshot): void {
    const snapshotOrigin = snapshot.turnId
      ? this.runConversationOrigins.get(snapshot.turnId)
      : undefined;
    if (snapshotOrigin && !this.isCurrentConversationOrigin(snapshotOrigin)) return;
    const rendering = this.workspace?.setAgentSnapshot(snapshot);
    if (rendering) {
      void rendering.catch((error) => {
        this.logAgentError(error, "agentSnapshotRender");
      });
    }
    if (snapshot.status !== "completed") return;
    const expectedConversationOriginToken = this.conversationOriginToken;
    if (this.activeSubmissionOperation?.kind === "transition") {
      const conversationId = this.transcript.snapshot().agentConversationId;
      if (
        conversationId
        && conversationId === this.pendingThinConversationId
        && snapshot.turnId
        && this.transcript.snapshot().messages.some((message) =>
          message.message_id === snapshot.turnId)
      ) {
        this.deferredRecoveredCompletion = {
          conversationOriginToken: expectedConversationOriginToken,
          conversationId,
          turnId: snapshot.turnId,
        };
      }
      return;
    }
    const promotion = this.promoteRecoveredQueuedSubmission(
      expectedConversationOriginToken,
    );
    if (!promotion) return;
    void this.runPromotedQueuedSubmission(
      promotion,
      expectedConversationOriginToken,
    );
  }

  private promoteDeferredRecoveredCompletion(
    expectedConversationOriginToken: string,
  ): void {
    const deferred = this.deferredRecoveredCompletion;
    if (!deferred) return;
    this.deferredRecoveredCompletion = null;
    const transcript = this.transcript.snapshot();
    if (
      deferred.conversationOriginToken !== expectedConversationOriginToken
      || !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || transcript.agentConversationId !== deferred.conversationId
      || !transcript.messages.some((message) =>
        message.message_id === deferred.turnId)
    ) return;
    const promotion = this.promoteRecoveredQueuedSubmission(
      expectedConversationOriginToken,
    );
    if (!promotion) return;
    void this.runPromotedQueuedSubmission(
      promotion,
      expectedConversationOriginToken,
    );
  }

  /**
   * A detached server run can finish before the replacement view hydrates it.
   * In that case there is no recovered active run to publish a fresh completed
   * snapshot, so resume the durable local FIFO only after authoritative
   * hydration has succeeded and the load transition has released ownership.
   */
  private promoteHydratedQueuedSubmission(
    expectedConversationOriginToken: string,
  ): void {
    if (
      !this.isCurrentConversationOrigin(expectedConversationOriginToken)
      || this.activeSubmissionOperation
      || this.queuedFollowUps.length === 0
    ) return;
    const status = this.agent.getSnapshot().status;
    if (status !== "idle" && status !== "completed") return;
    const promotion = this.promoteRecoveredQueuedSubmission(
      expectedConversationOriginToken,
    );
    if (!promotion) return;
    void this.runPromotedQueuedSubmission(
      promotion,
      expectedConversationOriginToken,
    );
  }

  private logAgentError(error: unknown, method: string): void {
    // Diagnostics are observational: a torn-down view (or a partial test
    // harness) must never turn an error report into a second failure.
    this.plugin?.getLogger?.().error("ChatView agent session failed", error, {
      source: "AgentChatView",
      method,
      metadata: {
        chatId: this.chatId || undefined,
      },
    });
  }
}
