import { Notice, type App } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { ChatSession } from "../../chat/ChatSession";
import type { ChatMessage } from "../../types";
import type { AgentConversationSnapshot, ManagedAgentError } from "../../chat/ChatConversation";
import type { AgentRunResult, AgentLifecycleCode, AgentLifecyclePhase } from "../../chat/managed/ChatSession";
import { isAgentBillingFailure } from "../../chat/managed/AgentFailurePolicy";
import { toThinAgentUserMessage } from "../../chat/managed/MessageAdapter";
import type { CreditsRefreshReason } from "../../chat/managed/Lifecycle";
import { LocalAgentChatSession } from "../../services/codex/LocalAgentChatSession";
import type { CreditsBalanceSnapshot } from "../../services/credits/HostedCreditsClient";
import { THIN_AGENT_CAPABILITIES, THIN_AGENT_CAPABILITY_CONTRACT_VERSION, THIN_AGENT_CONTRACT_VERSION, type MeasuredThinAgentContext, type ThinAgentBootstrapRequest } from "../../services/managed/ThinAgentV1Contract";
import type { ToolApprovalPolicy } from "../../utils/toolPolicy";
import { planRequiredError } from "../../utils/errors";
import { hasActivePlan } from "../../modals/UpgradePlanModal";
import { chatTitleFromMessage } from "../../utils/titleUtils";
import { showConfirm } from "../../core/ui/notifications";
import { messageId, plainContent, protocolId } from "./ChatViewIdentity";
import { historicalResubmitConsequences, terminalLiveResubmitConsequences } from "./HistoricalReplaySafety";
import type { AgentComposerSubmit } from "./AgentComposer";
import type { AgentWorkspace, AgentQueuedFollowUp } from "./AgentWorkspace";
import type { AgentTranscriptRepository, AgentTranscriptSnapshot, AgentUserCommitInput } from "./AgentTranscriptRepository";
import type { ChatApprovalMode } from "./storage/ChatPersistenceTypes";
import type { FileContextManager } from "./FileContextManager";
import type { ChatAttachmentVaultStore } from "./attachments/ChatAttachmentVaultStore";
import type { AgentQueueStateRepository } from "./AgentQueueStateRepository";
import { isChatAttachmentContentRef } from "./attachments/ChatAttachmentDescriptor";
import { composeAttachmentMetadata, composeUserMessageContent, restoreChatMessageDraft, type ChatMessageAttachment, type RestoredChatMessageDraft } from "./attachments/ChatMessageAttachments";
import { nativeChatSessions } from "./NativeChatSessions";

/** Live conversation and presentation ports. Navigation replaces these resources. */
interface ChatTurnHost {
  readonly viewer: object;
  readonly app: App;
  readonly plugin: SystemSculptPlugin;
  readonly agent: ChatSession;
  readonly transcript: AgentTranscriptRepository;
  readonly attachmentStore: ChatAttachmentVaultStore;
  readonly queueRepository: AgentQueueStateRepository;
  readonly contextManager: FileContextManager;
  readonly workspace: AgentWorkspace | null;
  readonly conversationOriginToken: string;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly creditsBalance: CreditsBalanceSnapshot | null;
  readonly detecting: boolean;
  readonly titleExplicit: boolean;
  readonly approvalMode: ChatApprovalMode;
  readonly automationApprovalMode: "interactive" | "auto-approve" | "deny";
  readonly sessionTrustedToolNames: Set<string>;
  readonly thinClientId: string;
  readonly runConversationOrigins: Map<string, string>;
  chatId: string;
  chatTitle: string;
  draftKey: string;
  detectionPendingBubble: ChatMessage | null;
  pendingThinConversationId: string | null;
  thinBootstrapRequest: ThinAgentBootstrapRequest | null;
  pendingForkHistory: Readonly<{ turnId: string; prefix: readonly ChatMessage[] }> | null;
  unsavedCompletedHistory: Readonly<{ originToken: string; conversationId: string; turnId: string; messages: readonly ChatMessage[] }> | null;
  clientMonotonicNow(): number;
  recordUiLifecycle(code: AgentLifecycleCode, phase?: AgentLifecyclePhase, conversationId?: string): void;
  blockReadOnlyHistoryAction(): boolean;
  isCurrentConversationOrigin(origin: string): boolean;
  historyForDisplay(messages?: readonly ChatMessage[], conversationId?: string): readonly ChatMessage[];
  readThinAgentContextSources(pinned: ReadonlySet<string>): Promise<MeasuredThinAgentContext>;
  applyTranscriptIdentity(snapshot: AgentTranscriptSnapshot): void;
  updateViewState(): void;
  setLegacyHistoryViewOnly(value: boolean): void;
  clearUncommittedFork(turnId: string): void;
  renderAgentSnapshot(snapshot: AgentConversationSnapshot): void;
  getInputText(): string;
  setInputText(text: string): void;
  getMessageAttachments(): readonly ChatMessageAttachment[];
  setMessageAttachments(attachments: readonly ChatMessageAttachment[]): void;
  handleError(error: unknown): Promise<void>;
  logAgentError(error: unknown, method: string): void;
  refreshCreditsBalance(options: { reason: CreditsRefreshReason }): Promise<void>;
}

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

type FailedReceiptTarget = Readonly<{
  transcript: AgentTranscriptRepository;
  turnId: string;
  reportId: string;
}>;

type ActiveSubmissionOperation = {
  readonly kind: "submission" | "transition";
  readonly id: string;
  readonly conversationOriginToken: string;
  readonly turnId: string | null;
  readonly originalSubmission: AgentComposerSubmit | null;
  readonly restoreRejectedSubmission: boolean;
  readonly clientStartedAtMonotonicMs: number;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  readonly resolveFinished: () => void;
  preparedSubmission: AgentComposerSubmit | null;
  runPromise: Promise<AgentRunResult> | null;
  includeContextFiles: boolean;
  draftRestored: boolean;
  draftRestorable: boolean;
  userCommitted: boolean;
  settled: boolean;
};

const LOCAL_FAILED_RECEIPT_MAX_ATTEMPTS = 3;
const LOCAL_FAILED_RECEIPT_RETRY_DELAY_MS = 250;
const CHAT_VIEW_CLOSE_PERSISTENCE_DEADLINE_MS = 750;

/** Owns local turn admission, recovery drafts, edits, receipts, and the durable FIFO.
 * Execution remains in ChatSession and its native or hosted backend.
 */
export class ChatTurnCoordinator {
  private activeSubmissionOperation: ActiveSubmissionOperation | null = null;
  private queuedFollowUps: AgentQueuedFollowUp[] = [];
  private pendingLocalReportIds?: Map<string, string>;
  private localFailedReceiptRetryTimers?: Map<
    number,
    (retry: boolean) => void
  >;
  private localFailedReceiptPersistenceTasks?: Set<Promise<void>>;
  private queueHydrated = false;
  private queuePersistence: Promise<void> = Promise.resolve();
  private pendingRetry: PendingHistoricalResubmit | null = null;
  private pendingRejectedRetry: PendingRejectedSubmissionRetry | null = null;
  private messageEditGeneration = 0;
  private queueDrainSuppressionDepth = 0;

  private closingSubmission: ActiveSubmissionOperation | null = null;

  constructor(private readonly host: ChatTurnHost) {}

  public get activeTurnId(): string | null | undefined {
    return this.activeSubmissionOperation?.turnId;
  }

  public get transitionPending(): boolean {
    return this.activeSubmissionOperation?.kind === "transition";
  }

  public get hasPendingOperation(): boolean {
    return this.activeSubmissionOperation !== null;
  }

  public get queuedFollowUpCount(): number {
    return this.queuedFollowUps.length;
  }

  public resetMessageEdits(): void {
    this.messageEditGeneration += 1;
    this.pendingRetry = null;
    this.pendingRejectedRetry = null;
    this.localReportIds().clear();
    this.host.workspace?.resetMessageEditor();
  }

  public clearQueue(): void {
    this.queuedFollowUps = [];
  }

  public async resetQueue(): Promise<void> {
    this.clearQueue();
    this.queueHydrated = true;
    await this.host.queueRepository.save(this.host.draftKey, []);
  }

  public recordFailureReport(turnId: string, reportId: string): void {
    this.localReportIds().set(turnId, reportId);
    this.attachLocalReportToSnapshot(turnId, reportId);
  }

  public drainQueue(origin: string): void {
    const promotion = this.promoteQueuedSubmission(null, origin);
    if (promotion) void this.runPromotedQueuedSubmission(promotion, origin);
  }

  public beginClose(): void {
    this.expediteLocalFailedReceiptRetryTimers();
    this.beginQueueDrainSuppression();
    this.closingSubmission = this.activeSubmissionOperation?.kind === "submission"
      ? this.activeSubmissionOperation
      : null;
  }

  public async persistOnClose(): Promise<void> {
    if (this.host.closed) return;
    await Promise.allSettled([
      this.host.transcript.idle(),
      ...this.localFailedReceiptTasks(),
    ]);
    if (this.host.closed) return;
    const closingSubmission = this.closingSubmission;
    if (closingSubmission && !closingSubmission.userCommitted) {
      const submission = closingSubmission.preparedSubmission
        ?? closingSubmission.originalSubmission;
      if (submission) {
        this.queuedFollowUps.unshift({
          id: messageId("queued"),
          text: submission.text,
          includeContextFiles: closingSubmission.includeContextFiles,
          ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
        });
        this.syncQueue();
      }
    }
    if (this.host.chatId && this.host.draftKey !== this.host.chatId) {
      await this.bindQueueToChat(this.host.chatId)
        .catch((error) => this.reportQueuePersistenceError(error));
    }
    if (this.host.closed) return;
    await this.persistQueueState()
      .catch((error) => this.reportQueuePersistenceError(error));
    if (this.host.closed) return;
    await this.queuePersistence;
  }

  public isSubmissionActive(): boolean {
    const sessionStatus = this.host.agent?.getSnapshot?.()?.status;
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
  public isRunActive(): boolean {
    const sessionStatus = this.host.agent?.getSnapshot?.()?.status;
    return this.activeSubmissionOperation?.kind === "submission"
      || sessionStatus === "running"
      || sessionStatus === "waiting";
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
    clientStartedAtMonotonicMs = this.host.clientMonotonicNow(),
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
      clientStartedAtMonotonicMs,
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
    options: Readonly<{
      restoreRejectedSubmission?: boolean;
      clientStartedAtMonotonicMs?: number;
      anchorSubmittedPrompt?: boolean;
    }> = {},
  ): ActiveSubmissionOperation | null {
    if (this.isSubmissionActive()) return null;
    const restoreRejectedSubmission = options.restoreRejectedSubmission !== false;
    const clientStartedAtMonotonicMs = options.clientStartedAtMonotonicMs
      ?? this.host.clientMonotonicNow();
    const operation = this.createSubmissionOperation(
      "submission",
      conversationOriginToken,
      submission,
      restoreRejectedSubmission,
      clientStartedAtMonotonicMs,
    );
    this.activeSubmissionOperation = operation;
    if (options.anchorSubmittedPrompt === true) {
      this.host.workspace?.setRunPending(
        true,
        operation.turnId ?? undefined,
        { anchorSubmittedPrompt: true },
      );
    } else {
      this.host.workspace?.setRunPending(true, operation.turnId ?? undefined);
    }
    this.host.workspace?.setBanner(null);
    this.host.agent?.recordLifecycle?.({
      code: "submission_admitted",
      phase: "response",
      requestId: operation.turnId ?? undefined,
      clientMonotonicOffsetMs: 0,
    });
    return operation;
  }

  public beginConversationTransition(
    conversationOriginToken: string,
  ): ActiveSubmissionOperation {
    const current = this.activeSubmissionOperation;
    if (current) this.retireSubmissionOperation(current, false, false);
    else this.host.workspace?.setRunPending(false);
    const transition = this.createSubmissionOperation(
      "transition",
      conversationOriginToken,
      null,
      false,
    );
    this.activeSubmissionOperation = transition;
    return transition;
  }

  public finishSubmissionOperation(
    operation: ActiveSubmissionOperation,
    recordComposerUnlock = true,
  ): void {
    if (operation.settled) return;
    const wasActive = this.activeSubmissionOperation === operation;
    if (wasActive) this.activeSubmissionOperation = null;
    if (wasActive) {
      // A settled active operation leaves nothing pending. Transitions must
      // clear this too: otherwise a conversation switch that retires a
      // streaming submission leaves runPending set, and the next empty
      // conversation renders a phantom pending turn.
      this.host.workspace?.setRunPending(false);
      if (recordComposerUnlock && operation.kind === "submission" && operation.turnId) {
        const snapshot = this.host.agent?.getSnapshot?.();
        const finishedAt = this.host.clientMonotonicNow();
        const elapsed = finishedAt - operation.clientStartedAtMonotonicMs;
        this.host.agent?.recordLifecycle?.({
          code: "composer_unlocked",
          phase: "render",
          requestId: operation.turnId,
          ...(snapshot?.turnId === operation.turnId && snapshot.runId
            ? { serverRunId: snapshot.runId }
            : {}),
          ...(Number.isFinite(elapsed) && elapsed >= 0
            ? { clientMonotonicOffsetMs: elapsed }
            : {}),
        });
      }
    }
    operation.settled = true;
    operation.resolveFinished();
  }

  private retireSubmissionOperation(
    operation: ActiveSubmissionOperation,
    restoreDraft: boolean,
    recordComposerUnlock = true,
  ): void {
    if (operation.settled) return;
    operation.controller.abort();
    if (restoreDraft) this.restoreSubmissionDraft(operation);
    this.finishSubmissionOperation(operation, recordComposerUnlock);
  }

  private restoreSubmissionDraft(operation: ActiveSubmissionOperation): void {
    if (
      operation.kind !== "submission"
      || operation.draftRestored
      || !operation.draftRestorable
      || !operation.restoreRejectedSubmission
      || operation.userCommitted
      || !this.host.isCurrentConversationOrigin(operation.conversationOriginToken)
    ) return;
    const submission = operation.preparedSubmission ?? operation.originalSubmission;
    if (!submission) return;
    operation.draftRestored = true;
    this.host.workspace?.restoreRejectedSubmission(submission);
  }

  private isCurrentSubmissionOperation(operation: ActiveSubmissionOperation): boolean {
    return this.activeSubmissionOperation === operation
      && operation.kind === "submission"
      && !operation.settled
      && !operation.controller.signal.aborted
      && this.host.isCurrentConversationOrigin(operation.conversationOriginToken);
  }

  private queueSubmission(
    submission: AgentComposerSubmit,
    includeContextFiles: boolean,
  ): void {
    if (this.host.blockReadOnlyHistoryAction()) return;
    this.queuedFollowUps.push({
      id: messageId("queued"),
      text: submission.text,
      includeContextFiles,
      ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
    });
    this.host.recordUiLifecycle("submission_queued");
    this.syncQueue();
    this.scheduleQueuePersistence();
  }

  private hasAuthoritativeUnavailableBalance(): boolean {
    if (this.host.agent instanceof LocalAgentChatSession || !this.host.creditsBalance || this.host.creditsBalance.usageClass === "master_auth") return false;
    return (this.host.creditsBalance.availableUnreserved ?? this.host.creditsBalance.totalRemaining) <= 0;
  }

  private unavailableBalanceAdmissionError(): Error {
    const outOfCredits = (this.host.creditsBalance?.totalRemaining ?? 0) <= 0;
    return Object.assign(
      new Error(outOfCredits
        ? "Out of credits. Add more to keep chatting."
        : "Not enough credits. Add more to keep chatting."),
      {
        code: outOfCredits ? "out_of_credits" : "insufficient_credits",
        status: 402,
        retryable: false,
        serverAdmissionPossible: false,
      },
    );
  }

  public refreshCreditsAfterBillingFailure(error: unknown): void {
    if (!isAgentBillingFailure(error)) return;
    void this.host.refreshCreditsBalance({ reason: "billing_failure" });
  }

  public acceptComposerSubmission(
    submission: AgentComposerSubmit,
    expectedConversationOriginToken?: string,
    clearComposerAfterAdmission = false,
    clientStartedAtMonotonicMs = this.host.clientMonotonicNow(),
  ): void | false {
    if (this.host.blockReadOnlyHistoryAction()) return;
    const admissionOriginToken = expectedConversationOriginToken
      ?? this.host.conversationOriginToken;
    const currentOperation = this.activeSubmissionOperation;
    if (currentOperation?.kind === "transition") {
      // A message sent while first-open detection runs waits for the result,
      // but its bubble shows at once (spec 3.1 G).
      if (this.host.detecting && !this.host.detectionPendingBubble) {
        this.host.detectionPendingBubble = {
          role: "user",
          content: composeUserMessageContent(submission.text, submission.attachments),
          message_id: messageId("pending"),
        };
        void this.host.workspace?.setHistory([this.host.detectionPendingBubble]).catch(() => undefined);
      }
      void currentOperation.finished.then(() => {
        const pendingBubble = this.host.detectionPendingBubble;
        this.host.detectionPendingBubble = null;
        if (!this.host.isCurrentConversationOrigin(admissionOriginToken)) {
          if (pendingBubble) void this.host.workspace?.setHistory(this.host.transcript.snapshot().messages).catch(() => undefined);
          this.restoreDeferredSubmissionAfterTransitions(submission);
          return;
        }
        const accepted = this.acceptComposerSubmission(
          submission,
          admissionOriginToken,
          clearComposerAfterAdmission,
          clientStartedAtMonotonicMs,
        );
        if (accepted === false && !clearComposerAfterAdmission) {
          this.restoreDeferredSubmissionAfterTransitions(submission);
        }
      });
      return;
    }
    // Follow-up queueing reads no attachment or vault content. Recheck the
    // spendable balance only when the queued item is promoted for admission.
    if (this.isSubmissionActive()) {
      if (this.host.isCurrentConversationOrigin(admissionOriginToken)) {
        this.queueSubmission(submission, true);
      }
      return;
    }
    if (this.hasAuthoritativeUnavailableBalance()) {
      const error = this.unavailableBalanceAdmissionError();
      void this.host.handleError(error);
      return false;
    }
    const operation = this.beginSubmissionOperation(
      admissionOriginToken,
      submission,
      {
        restoreRejectedSubmission: !clearComposerAfterAdmission,
        clientStartedAtMonotonicMs,
        anchorSubmittedPrompt: true,
      },
    );
    if (!operation) {
      if (this.host.isCurrentConversationOrigin(admissionOriginToken)) {
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
      if (clearComposerAfterAdmission && this.host.getInputText() === submission.text) {
        this.host.setInputText("");
        operation.draftRestorable = true;
      }
      return this.executeSubmission(prepared, {
        expectedConversationOriginToken: admissionOriginToken,
        activeOperation: operation,
      }).catch(async (error) => {
        if (!this.host.isCurrentConversationOrigin(admissionOriginToken)) return;
        if (operation.controller.signal.aborted) return;
        this.restoreSubmissionDraft(operation);
        await this.host.handleError(error);
      });
    }).catch(async (error) => {
      const wasCancelled = operation?.controller.signal.aborted === true;
      if (!wasCancelled) this.restoreSubmissionDraft(operation);
      this.finishSubmissionOperation(operation);
      if (!this.host.isCurrentConversationOrigin(admissionOriginToken)) return;
      if (wasCancelled) return;
      await this.host.handleError(error);
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
    this.host.workspace?.restoreRejectedSubmission(submission);
  }

  private async prepareSubmission(submission: AgentComposerSubmit): Promise<AgentComposerSubmit> {
    if (!submission.attachments?.length) return submission;
    const attachments: ChatMessageAttachment[] = [];
    for (const attachment of submission.attachments) {
      if (attachment.contentRef && isChatAttachmentContentRef(attachment.contentRef)) {
        attachments.push(attachment);
        continue;
      }
      const [externalized] = await this.host.attachmentStore.externalizeAttachments([attachment]);
      attachments.push(externalized);
    }
    return Object.freeze({ ...submission, attachments });
  }

  public async executeSubmission(
    submission: AgentComposerSubmit,
    options: Readonly<{
      includeContextFiles?: boolean;
      restoreRejectedSubmission?: boolean;
      forceDestructiveApproval?: boolean;
      historicalResubmit?: PendingHistoricalResubmit;
      expectedConversationOriginToken?: string;
      activeOperation?: ActiveSubmissionOperation;
      anchorSubmittedPrompt?: boolean;
      onResult?: (result: AgentRunResult) => void;
      queueIfBusy?: boolean;
    }> = {},
  ): Promise<void> {
    // Composer submissions are externalized at admission; queued attachments
    // are restored from durable refs. Do not rewrite the same CAS payload here.
    const prepared = submission;
    const expectedConversationOriginToken = options.expectedConversationOriginToken
      ?? this.host.conversationOriginToken;
    if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
    let operation = options.activeOperation;
    if (operation) {
      if (
        this.activeSubmissionOperation !== operation
        || operation.kind !== "submission"
        || operation.conversationOriginToken !== expectedConversationOriginToken
      ) return;
    } else {
      if (this.isSubmissionActive()) {
        if (!options.historicalResubmit && options.queueIfBusy !== false) {
          this.queueSubmission(prepared, options.includeContextFiles !== false);
        }
        return;
      }
      const begunOperation = this.beginSubmissionOperation(
        expectedConversationOriginToken,
        prepared,
        {
          restoreRejectedSubmission: options.restoreRejectedSubmission !== false,
          anchorSubmittedPrompt: options.anchorSubmittedPrompt === true,
        },
      );
      if (!begunOperation) {
        if (!options.historicalResubmit && options.queueIfBusy !== false) {
          this.queueSubmission(prepared, options.includeContextFiles !== false);
        }
        return;
      }
      operation = begunOperation;
    }
    operation.preparedSubmission = prepared;
    operation.includeContextFiles = options.includeContextFiles !== false;

    let userMessage: ChatMessage | null = null;
    let run: Promise<AgentRunResult> | null = null;
    let result: AgentRunResult | undefined;
    let queuedPromotion: Readonly<{
      operation: ActiveSubmissionOperation;
      item: AgentQueuedFollowUp;
      submission: AgentComposerSubmit;
    }> | null = null;

    try {
      if (this.host.blockReadOnlyHistoryAction()) return;
      if (this.hasAuthoritativeUnavailableBalance()) {
        throw this.unavailableBalanceAdmissionError();
      }
      if (
        options.historicalResubmit
        && !this.host.transcript.snapshot().agentConversationId
      ) {
        this.host.setLegacyHistoryViewOnly(true);
        this.host.blockReadOnlyHistoryAction();
        return;
      }
      if (!this.isCurrentSubmissionOperation(operation)) return;
      // Both calls enqueue onto the workspace's serial render queue, so the
      // history baseline still lands before the projection clear. Neither is
      // awaited: holding the submit behind the coalesced (32ms-debounced)
      // render taxes time-to-first-token, and the queue itself guarantees
      // the cleared projection can never duplicate the previous answer once
      // the next run publishes. Later isCurrentSubmissionOperation guards
      // still fence conversation switches.
      const unsavedConversation = this.host.unsavedCompletedHistory?.originToken === expectedConversationOriginToken
        ? this.host.unsavedCompletedHistory.conversationId : undefined;
      const displayHistory = this.host.historyForDisplay(undefined, unsavedConversation);
      void this.host.workspace?.setHistory(displayHistory).catch(() => {});
      void this.host.workspace?.setAgentSnapshot(null).catch(() => {});

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
      this.host.runConversationOrigins.set(
        admittedUserMessage.message_id,
        expectedConversationOriginToken,
      );
      if (this.host.runConversationOrigins.size > 128) {
        const oldestTurnId = this.host.runConversationOrigins.keys().next().value;
        if (oldestTurnId) this.host.runConversationOrigins.delete(oldestTurnId);
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
        && (this.host.automationApprovalMode === "auto-approve" || this.host.approvalMode === "full-access")
        ? { requireDestructiveApproval: false }
        : {
            // The active run reads this same set between continuations so an
            // "Allow for chat" choice takes effect before the next tool call.
            trustedToolNames: forceDestructiveApproval
              ? new Set<string>()
              : this.host.sessionTrustedToolNames,
            mode: forceDestructiveApproval ? "ask" : this.host.approvalMode,
          };
      if (!(this.host.agent instanceof LocalAgentChatSession) && !hasActivePlan(this.host.plugin)) {
        throw planRequiredError("Chat");
      }
      const previousConversationId = unsavedConversation ?? this.host.transcript.snapshot().agentConversationId;
      const conversationId = historicalResubmit
        ? protocolId("conversation")
        : previousConversationId
          ?? this.host.pendingThinConversationId
          ?? protocolId("conversation");
      this.host.pendingThinConversationId = conversationId;
      if (historicalResubmit) {
        this.host.pendingForkHistory = {
          turnId: admittedUserMessage.message_id,
          prefix: this.host.transcript.snapshot().messages
            .slice(0, historicalResubmit.expectedIndex)
            .map((message) => ({ ...message })),
        };
      }

      // The typed message must be on screen before any network work begins.
      // The durable commit still happens in beforeSend once the session is
      // ready; this is presentation only, and a rejected run rolls it back.
      const optimisticHistory: readonly ChatMessage[] = historicalResubmit
        ? [
            ...this.host.transcript.snapshot().messages
              .slice(0, historicalResubmit.expectedIndex) as readonly ChatMessage[],
            admittedUserMessage,
          ]
        : [
            ...displayHistory,
            admittedUserMessage,
          ];
      await this.host.workspace?.setHistory(optimisticHistory);
      if (!this.isCurrentSubmissionOperation(operation)) return;

      const [hydratedUserMessage, context, pluginBuildId] = await Promise.all([
        this.host.attachmentStore.hydrateMessage(admittedUserMessage),
        this.host.readThinAgentContextSources(
          options.includeContextFiles === false
            ? new Set()
            : new Set(this.host.contextManager.getPinnedFiles()),
        ),
        this.host.plugin.getLoadedPluginBuildId(),
      ]);
      if (!this.isCurrentSubmissionOperation(operation)) return;
      if (historicalResubmit) this.host.agent.disconnect();
      this.host.thinBootstrapRequest = {
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        conversation_id: conversationId,
        client_id: this.host.thinClientId,
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
      const session = this.host.agent;
      const transcript = this.host.transcript;
      run = session.start({
        ...(session instanceof LocalAgentChatSession ? { forkHistory: this.host.pendingForkHistory?.prefix ?? [] } : {}),
        conversationId,
        turnId: admittedUserMessage.message_id,
        message: toThinAgentUserMessage(hydratedUserMessage),
        clientStartedAtMonotonicMs: operation.clientStartedAtMonotonicMs,
        buildBody: async (signal) => {
          if (!this.isCurrentSubmissionOperation(operation)) {
            throw new Error("This chat changed before the request was admitted.");
          }
          // No sources means there is nothing to stage; context_ref is
          // optional on the wire, so skip the staging round trip entirely.
          if (context.sources.length === 0) return undefined;
          const staged = await session.stageContext(
            admittedUserMessage.message_id,
            context,
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
          if (session instanceof LocalAgentChatSession) {
            nativeChatSessions(this.host.plugin).retain(transcript.snapshot().chatId, session, transcript, this.host.viewer);
          }
        },
      });
      operation.runPromise = run;
      result = await run;
      options.onResult?.(result);
      if (
        this.activeSubmissionOperation !== operation
        || !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      ) return;
      if (result.kind === "failed") {
        const reportId = this.localReportIds().get(admittedUserMessage.message_id);
        if (reportId) {
          result = {
            ...result,
            error: { ...result.error, reportId },
            snapshot: this.snapshotWithLocalReport(result.snapshot, reportId),
          };
          this.host.renderAgentSnapshot(result.snapshot);
        }
      }
      if (historicalResubmit && result.kind === "failed") {
        this.host.recordUiLifecycle("historical_resubmit_failed");
      }
      const userWasCommitted = this.host.transcript.snapshot().messages
        .some((message) => message.message_id === admittedUserMessage.message_id);
      operation.userCommitted ||= userWasCommitted;
      if (
        (result.kind === "failed" || result.kind === "cancelled")
        && !userWasCommitted
      ) {
        this.restoreSubmissionDraft(operation);
        // The optimistic bubble is withdrawn with the restored draft so the
        // same words never sit in the transcript and the composer at once.
        await this.host.workspace?.setHistory(displayHistory);
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
      if (result.kind === "failed" && userWasCommitted) {
        this.scheduleLocalFailedReceiptPersistence(result);
      }
      this.handleRunResult();
      if (
        userWasCommitted
        && (result.kind === "failed" || result.kind === "cancelled")
      ) {
        // Terminal protocol truth has already been reconciled and published.
        // Release the admission/composer owner before the best-effort history
        // render below: Markdown postprocessors or disk-backed history can be
        // slow, and must not make a finished response look active or prevent
        // an immediate recovery turn. finishSubmissionOperation is
        // identity-guarded and idempotent, so a later settlement/finally from
        // this turn cannot clear a newer operation admitted in the meantime.
        this.finishSubmissionOperation(operation);
      }
      if (result.kind === "completed") {
        try {
          const cachedMessages = this.host.transcript.snapshot().messages as readonly ChatMessage[];
          // A local save can fail while hosted execution still succeeds.
          // Keep the submitted turn and its prefix on screen in that case;
          // an empty or older cache must not replace the optimistic history.
          const userHistory = userWasCommitted ? this.host.historyForDisplay(cachedMessages, conversationId) : optimisticHistory;
          const completedMessage = result.message;
          const settlementMessages = !completedMessage || userHistory.some((message) =>
            message.message_id === completedMessage.message_id)
            ? userHistory
            : [...userHistory, completedMessage];
          if (!userWasCommitted || this.host.unsavedCompletedHistory?.originToken === expectedConversationOriginToken) {
            this.host.unsavedCompletedHistory = {
              originToken: expectedConversationOriginToken,
              conversationId,
              turnId: admittedUserMessage.message_id,
              messages: settlementMessages,
            };
            this.host.workspace?.setBanner("Chat couldn't be saved. Check the chats folder in Settings.", "error");
          }
          if (completedMessage) {
            await this.host.workspace?.settleCompletedRun(settlementMessages);
          }
          // If no cacheable assistant could be derived, keep the bridge's
          // completed live snapshot visible instead of replacing it with a
          // transcript that only contains the user turn.
        } catch (error) {
          this.host.logAgentError(error, "completedRunSettlement");
        }
      } else if (userWasCommitted) {
        // Failed and cancelled runs reconcile their finalized turn into the
        // transcript too, so the committed history and the still-mounted live
        // turn would otherwise repeat the same content. Settle the live turn
        // down to what history cannot carry: the error and its Retry.
        try {
          await this.host.workspace?.settleUnfinishedRun(this.host.historyForDisplay());
        } catch (error) {
          this.host.logAgentError(error, "unfinishedRunSettlement");
        }
      }
    } catch (error) {
      if (
        this.activeSubmissionOperation !== operation
        || !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
        || operation.controller.signal.aborted
      ) return;
      throw error;
    } finally {
      if (userMessage) this.host.clearUncommittedFork(userMessage.message_id);
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
    expectedConversationOriginToken = this.host.conversationOriginToken,
    operation?: ActiveSubmissionOperation,
  ): Promise<void> {
    if (
      !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && !this.isCurrentSubmissionOperation(operation))
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    if (!this.host.chatId && this.host.transcript.snapshot().messages.length === 0 && !this.host.titleExplicit) {
      this.host.chatTitle = chatTitleFromMessage(plainContent(input.message));
      this.host.transcript.setTitle(this.host.chatTitle);
    }
    const snapshot = await this.host.transcript.commitUser(input, conversationId);
    if (operation) operation.userCommitted = true;
    if (input.kind === "resend") {
      this.host.recordUiLifecycle("historical_resubmit_committed", "persistence");
    }
    if (
      !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    this.host.applyTranscriptIdentity(snapshot);
    if (this.host.unsavedCompletedHistory?.originToken === expectedConversationOriginToken
      && this.host.unsavedCompletedHistory.conversationId !== conversationId) {
      // A durably admitted fork intentionally replaces the outgoing branch.
      this.host.unsavedCompletedHistory = null;
      this.host.workspace?.setBanner(null);
    }
    if (
      this.pendingRetry
      && this.pendingRetry.targetMessageId === (
        resubmittedTargetMessageId
        ?? (input.kind === "resend" ? input.targetMessageId : undefined)
      )
    ) {
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      this.host.workspace?.resetMessageEditor();
    }
    await this.bindQueueToChat(snapshot.chatId)
      .catch((error) => this.reportQueuePersistenceError(error));
    if (
      !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) {
      throw new Error("This chat changed before the request was admitted.");
    }
    await this.host.workspace?.setHistory(this.host.historyForDisplay(snapshot.messages));
    if (
      !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      || (operation && this.activeSubmissionOperation !== operation)
    ) return;
    this.host.updateViewState();
  }

  private handleRunResult(): void {
    this.host.updateViewState();
  }

  private localReportIds(): Map<string, string> {
    return this.pendingLocalReportIds ??= new Map<string, string>();
  }

  private attachLocalReportToSnapshot(turnId: string, reportId: string): void {
    const snapshot = this.host.agent.getSnapshot();
    if (snapshot.turnId !== turnId || snapshot.status !== "failed") return;
    const withReport = this.snapshotWithLocalReport(snapshot, reportId);
    if (withReport !== snapshot) this.host.renderAgentSnapshot(withReport);
  }

  private snapshotWithLocalReport(
    snapshot: AgentConversationSnapshot,
    reportId: string,
  ): AgentConversationSnapshot {
    let changed = false;
    const patchError = (error: ManagedAgentError): ManagedAgentError => {
      if (error.reportId === reportId) return error;
      changed = true;
      return Object.freeze({ ...error, reportId });
    };
    const terminalError = snapshot.terminalError
      ? patchError(snapshot.terminalError)
      : undefined;
    const parts = snapshot.parts.map((part) => {
      if (part.kind !== "error") return part;
      return Object.freeze({ ...part, error: patchError(part.error) });
    });
    if (!changed) return snapshot;
    return Object.freeze({
      ...snapshot,
      ...(terminalError ? { terminalError } : {}),
      parts: Object.freeze(parts),
    });
  }

  private failedReceiptTarget(
    result: Extract<AgentRunResult, { kind: "failed" }>,
  ): FailedReceiptTarget | null {
    const turnId = result.snapshot.turnId;
    if (!turnId) return null;
    const pendingReportId = this.localReportIds().get(turnId);
    const reportId = result.error.reportId ?? pendingReportId;
    if (!reportId || pendingReportId !== reportId) return null;
    const transcript = this.host.transcript;
    if (!transcript.snapshot().messages.some((message) =>
      message.role === "user" && message.message_id === turnId)) return null;
    return { transcript, turnId, reportId };
  }

  private async persistLocalFailedReceipt(
    result: Extract<AgentRunResult, { kind: "failed" }>,
    target = this.failedReceiptTarget(result),
  ): Promise<void> {
    if (!target) return;
    const { transcript, turnId, reportId } = target;
    const snapshot = await transcript.persistFailedReceipt({
      turnId,
      reportId,
      failureCode: result.error.code,
      retryable: result.error.retryable === true,
    });
    if (this.localReportIds().get(turnId) === reportId) {
      this.localReportIds().delete(turnId);
    }
    // A receipt belongs to the failed turn's transcript, even if its retry
    // outlives navigation. It must never adopt that identity into a new chat.
    if (this.host.closed || this.host.transcript !== transcript) return;
    this.host.applyTranscriptIdentity(snapshot);
  }

  private scheduleLocalFailedReceiptPersistence(
    result: Extract<AgentRunResult, { kind: "failed" }>,
  ): void {
    if (this.host.closing) return;
    const target = this.failedReceiptTarget(result);
    if (!target) return;
    let task: Promise<void>;
    task = this.persistLocalFailedReceiptWithRetry(result, target).catch((error) => {
      this.host.logAgentError(error, "failedReceiptPersistence");
    }).finally(() => {
      this.localFailedReceiptTasks().delete(task);
    });
    this.localFailedReceiptTasks().add(task);
  }

  private async persistLocalFailedReceiptWithRetry(
    result: Extract<AgentRunResult, { kind: "failed" }>,
    target: FailedReceiptTarget,
  ): Promise<void> {
    for (let attempt = 1; attempt <= LOCAL_FAILED_RECEIPT_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.persistLocalFailedReceipt(result, target);
        return;
      } catch (error) {
        this.host.logAgentError(error, "failedReceiptPersistence");
        if (attempt >= LOCAL_FAILED_RECEIPT_MAX_ATTEMPTS || this.host.closing) return;
        if (!await this.waitForLocalFailedReceiptRetry(
          LOCAL_FAILED_RECEIPT_RETRY_DELAY_MS * attempt,
        )) return;
      }
    }
  }

  private localFailedReceiptTasks(): Set<Promise<void>> {
    return this.localFailedReceiptPersistenceTasks ??= new Set<Promise<void>>();
  }

  private localFailedReceiptTimers(): Map<number, (retry: boolean) => void> {
    return this.localFailedReceiptRetryTimers
      ??= new Map<number, (retry: boolean) => void>();
  }

  private waitForLocalFailedReceiptRetry(delayMs: number): Promise<boolean> {
    if (this.host.closing) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timers = this.localFailedReceiptTimers();
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        resolve(!this.host.closing);
      }, delayMs);
      timers.set(timer, resolve);
    });
  }

  private expediteLocalFailedReceiptRetryTimers(): void {
    for (const [timer, resolve] of this.localFailedReceiptTimers()) {
      window.clearTimeout(timer);
      resolve(true);
    }
    this.localFailedReceiptTimers().clear();
  }

  public async waitForCloseWork(work: Promise<void>): Promise<void> {
    let deadlineTimer: number | null = null;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = window.setTimeout(
        resolve,
        CHAT_VIEW_CLOSE_PERSISTENCE_DEADLINE_MS,
      );
    });
    try {
      await Promise.race([work, deadline]);
    } finally {
      if (deadlineTimer !== null) window.clearTimeout(deadlineTimer);
    }
  }

  private promoteQueuedSubmission(
    completedOperation: ActiveSubmissionOperation | null,
    expectedConversationOriginToken: string,
  ): Readonly<{
    operation: ActiveSubmissionOperation;
    item: AgentQueuedFollowUp;
    submission: AgentComposerSubmit;
  }> | null {
    if (
      (completedOperation
        ? this.activeSubmissionOperation !== completedOperation || completedOperation.controller.signal.aborted
        : Boolean(this.activeSubmissionOperation))
      || !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
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
    this.host.workspace?.setRunPending(true, operation.turnId ?? undefined);
    this.host.recordUiLifecycle("queued_submission_promoted");
    if (completedOperation) this.finishSubmissionOperation(completedOperation);
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
      if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      this.restoreSubmissionDraft(promotion.operation);
      await this.host.handleError(error);
    }
  }

  public async stopActiveRun(): Promise<void> {
    const activeOperation = this.activeSubmissionOperation;
    if (activeOperation?.kind === "transition") return;
    this.host.recordUiLifecycle("stop_requested");
    if (activeOperation && !activeOperation.runPromise) {
      this.retireSubmissionOperation(activeOperation, true);
      this.host.recordUiLifecycle("stop_completed");
      return;
    }
    activeOperation?.controller.abort();
    const releaseQueueDrainSuppression = this.beginQueueDrainSuppression();
    try {
      await this.host.agent.cancel();
      if (activeOperation) await activeOperation.finished;
    }
    finally {
      releaseQueueDrainSuppression();
      this.host.recordUiLifecycle("stop_completed");
    }
  }

  public async cancelQueuedFollowUp(id: string): Promise<boolean> {
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
    this.host.recordUiLifecycle("queued_submission_removed");
    return true;
  }

  public async runQueuedFollowUpNow(id: string): Promise<void> {
    if (this.host.blockReadOnlyHistoryAction()) return;
    const releaseQueueDrainSuppression = this.beginQueueDrainSuppression();
    let queueDrainSuppressionReleased = false;
    const expectedConversationOriginToken = this.host.conversationOriginToken;
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
      if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      await this.stopActiveRun();
      releaseQueueDrainSuppression();
      queueDrainSuppressionReleased = true;
      await this.executeSubmission(
        submission,
        {
          includeContextFiles: item.includeContextFiles,
          expectedConversationOriginToken,
          anchorSubmittedPrompt: true,
        },
      );
    } catch (error) {
      if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return;
      if (selectedSubmission) {
        this.host.workspace?.restoreRejectedSubmission(selectedSubmission);
      }
      await this.host.handleError(error);
    } finally {
      if (!queueDrainSuppressionReleased) releaseQueueDrainSuppression();
    }
  }

  public async prepareRetry(messageIdToRetry: string): Promise<void> {
    if (this.host.blockReadOnlyHistoryAction()) return;
    const target = this.host.transcript.snapshot().messages.find((message) =>
      message.message_id === messageIdToRetry && message.role === "user");
    if (!target) {
      await this.retryRejectedSubmission(messageIdToRetry);
      return;
    }
    const prepared = await this.prepareHistoricalResubmit(messageIdToRetry);
    if (!prepared) return;
    await this.showHistoricalResubmitEditor(prepared);
  }

  public async retryFailedTurn(messageIdToRetry: string): Promise<void> {
    if (this.host.blockReadOnlyHistoryAction()) return;
    const target = this.host.transcript.snapshot().messages.find((message) =>
      message.message_id === messageIdToRetry && message.role === "user");
    if (!target) {
      await this.retryRejectedSubmission(messageIdToRetry);
      return;
    }
    const prepared = await this.prepareHistoricalResubmit(messageIdToRetry);
    if (!prepared) return;
    const active = this.host.agent.getSnapshot();
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
    const expectedConversationOriginToken = this.host.conversationOriginToken;
    const snapshot = this.host.transcript.snapshot();
    const index = snapshot.messages.findIndex((message) => message.message_id === messageIdToRetry);
    const message = snapshot.messages[index];
    if (index < 0 || message?.role !== "user") return null;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the current response to finish before retrying from here.", 5000);
      return null;
    }
    const generation = ++this.messageEditGeneration;
    let draft: RestoredChatMessageDraft;
    try {
      const hydratedMessage = await this.host.attachmentStore.hydrateMessage(message);
      draft = await restoreChatMessageDraft(hydratedMessage);
    } catch {
      if (generation === this.messageEditGeneration
        && this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
        && !this.isSubmissionActive()) {
        new Notice("This message's attachments could not be prepared. Try again.", 5000);
      }
      return null;
    }
    if (
      generation !== this.messageEditGeneration
      || !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
      || this.isSubmissionActive()
    ) return null;
    const current = this.host.transcript.snapshot();
    if (
      current.version !== snapshot.version
      || current.messages[index]?.message_id !== messageIdToRetry
    ) {
      new Notice("This chat changed before the message could be edited.", 5000);
      return null;
    }
    const expectedAttachments = message.attachmentMetadata?.length ?? 0;
    const unavailableAttachmentCount = Math.max(0, expectedAttachments - draft.attachments.length);
    const durableConsequences = historicalResubmitConsequences(
      snapshot.messages,
      index,
    );
    const liveConsequences = terminalLiveResubmitConsequences(
      this.host.agent.getSnapshot(),
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
      message: { ...message },
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
    await this.host.workspace?.showMessageEditor({
      messageId: pending.targetMessageId,
      text,
      hasAttachments: pending.attachments.length > 0,
      unavailableAttachmentCount: pending.unavailableAttachmentCount,
      laterMessageCount: pending.laterMessageCount,
      requiresReplayConfirmation: pending.requiresReplayConfirmation,
    });
  }

  private async retryRejectedSubmission(turnId: string): Promise<boolean> {
    if (this.host.blockReadOnlyHistoryAction()) return true;
    const expectedConversationOriginToken = this.host.conversationOriginToken;
    const rejected = this.pendingRejectedRetry;
    if (!rejected || rejected.turnId !== turnId) return false;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the current response to finish before retrying from here.", 5000);
      return true;
    }
    const historicalResubmit = rejected.historicalResubmit;
    if (historicalResubmit) {
      const snapshot = this.host.transcript.snapshot();
      if (
        snapshot.version !== historicalResubmit.expectedVersion
        || snapshot.messages[historicalResubmit.expectedIndex]?.message_id
          !== historicalResubmit.targetMessageId
      ) {
        new Notice("This chat changed before the edited message could be retried.", 6000);
        return true;
      }
    } else if (!this.consumeRejectedSubmissionDraft(rejected.submission)) {
      this.host.workspace?.focus();
      new Notice("Your message is back in the composer.", 6000);
      return true;
    }
    this.pendingRejectedRetry = null;
    try {
      await this.executeSubmission(rejected.submission, {
        expectedConversationOriginToken,
        anchorSubmittedPrompt: true,
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
      if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return true;
      if (!this.pendingRejectedRetry) this.pendingRejectedRetry = rejected;
      if (!historicalResubmit) {
        this.host.workspace?.restoreRejectedSubmission(rejected.submission);
      }
      await this.host.handleError(error);
    }
    return true;
  }

  private consumeRejectedSubmissionDraft(submission: AgentComposerSubmit): boolean {
    const rejectedText = submission.text.trim();
    const currentText = this.host.getInputText();
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
    const currentAttachments = this.host.getMessageAttachments();
    const rejectedAttachments = submission.attachments ?? [];
    if (currentAttachments.length < rejectedAttachments.length) return false;
    for (let index = 0; index < rejectedAttachments.length; index += 1) {
      if (currentAttachments[index]?.id !== rejectedAttachments[index]?.id) return false;
    }
    this.host.setInputText(remainingText);
    this.host.setMessageAttachments(currentAttachments.slice(rejectedAttachments.length));
    return true;
  }

  public async cancelMessageEdit(messageIdToCancel: string): Promise<void> {
    if (this.pendingRetry?.targetMessageId !== messageIdToCancel) return;
    this.messageEditGeneration += 1;
    this.pendingRetry = null;
    await this.host.workspace?.hideMessageEditor(messageIdToCancel);
  }

  public async resubmitMessage(messageIdToResubmit: string, text: string): Promise<boolean> {
    if (this.host.blockReadOnlyHistoryAction()) return false;
    const expectedConversationOriginToken = this.host.conversationOriginToken;
    const pending = this.pendingRetry;
    if (!pending || pending.targetMessageId !== messageIdToResubmit) return false;
    const expectedMessageEditGeneration = this.messageEditGeneration;
    if (this.isSubmissionActive()) {
      new Notice("Wait for the response to finish.", 5000);
      return false;
    }
    if (!text.trim() && pending.attachments.length === 0) return false;
    this.host.recordUiLifecycle("historical_resubmit_started");

    const snapshot = this.host.transcript.snapshot();
    if (
      snapshot.version !== pending.expectedVersion
      || snapshot.messages[pending.expectedIndex]?.message_id !== pending.targetMessageId
    ) {
      this.messageEditGeneration += 1;
      this.pendingRetry = null;
      await this.host.workspace?.hideMessageEditor(messageIdToResubmit, false);
      new Notice("This chat changed before the edited message could be resubmitted.", 6000);
      return false;
    }

    if (pending.requiresReplayConfirmation) {
      const { confirmed } = await showConfirm(
        this.host.app,
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
        !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
        || this.messageEditGeneration !== expectedMessageEditGeneration
        || this.pendingRetry !== pending
      ) return false;
      if (!confirmed) return false;
    }

    if (
      !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
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
      {
        restoreRejectedSubmission: false,
        anchorSubmittedPrompt: true,
      },
    );
    if (!operation) {
      new Notice("Wait for the response to finish.", 5000);
      return false;
    }
    let executionStarted = false;
    let prepared: AgentComposerSubmit;
    try {
      prepared = await this.prepareSubmission(requestedSubmission);
      operation.preparedSubmission = prepared;
      if (
        !this.isCurrentSubmissionOperation(operation)
        || !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
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
        !this.host.isCurrentConversationOrigin(expectedConversationOriginToken)
        || operation.controller.signal.aborted
      ) return false;
      this.host.recordUiLifecycle("historical_resubmit_failed");
      this.host.logAgentError(error, "historicalResubmit");
      await this.host.handleError(error);
      return false;
    } finally {
      if (!executionStarted) this.finishSubmissionOperation(operation);
    }

    if (!this.host.isCurrentConversationOrigin(expectedConversationOriginToken)) return false;
    return !this.host.transcript.snapshot().messages
      .some((message) => message.message_id === messageIdToResubmit);
  }

  public syncQueue(): void {
    this.host.workspace?.setQueue(this.queuedFollowUps);
  }

  public async hydrateQueue(key: string): Promise<void> {
    const originToken = this.host.conversationOriginToken;
    const isCurrent = () => this.host.conversationOriginToken === originToken && this.host.draftKey === key;
    try {
      const items = await this.host.queueRepository.load(key);
      if (!isCurrent()) return;
      this.queuedFollowUps = [...items];
    } catch (error) {
      if (!isCurrent()) return;
      this.queuedFollowUps = [];
      this.reportQueuePersistenceError(error, "Queued follow-ups could not be restored.");
    }
    this.queueHydrated = true;
    this.syncQueue();
  }

  public persistQueueState(): Promise<void> {
    if (!this.queueHydrated) return Promise.resolve();
    const key = this.host.draftKey;
    const items = [...this.queuedFollowUps];
    const pending = this.queuePersistence.then(() => this.host.queueRepository.save(key, items));
    this.queuePersistence = pending.catch(() => undefined);
    return pending;
  }

  private scheduleQueuePersistence(): void {
    void this.persistQueueState().catch((error) => this.reportQueuePersistenceError(error));
  }

  public async bindQueueToChat(chatId: string): Promise<void> {
    const durableKey = chatId.trim();
    if (!durableKey || this.host.draftKey === durableKey) return;
    await this.queuePersistence;
    const previousKey = this.host.draftKey;
    await this.host.queueRepository.move(previousKey, durableKey, this.queuedFollowUps);
    this.host.draftKey = durableKey;
    this.queueHydrated = true;
    this.host.updateViewState();
  }

  public reportQueuePersistenceError(error: unknown, fallback = "Queued follow-ups could not be saved."): void {
    const detail = error instanceof Error ? error.message.trim() : "";
    const message = detail ? `${fallback} ${detail}` : fallback;
    this.host.workspace?.setBanner(message, "error");
    new Notice(message, 8000);
  }

}
