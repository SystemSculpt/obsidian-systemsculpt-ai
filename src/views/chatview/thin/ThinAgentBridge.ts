import {
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { MessageType } from "agents/chat";
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolPartState,
  type WebSocketChatTransport,
} from "agents/chat/react";
import { parseThinAgentDataPart } from "../../../services/managed/ThinAgentV1Contract";
import { FIRST_PARTY_TOOL_NAMES } from "../../../tools/toolNames";
import type { ChatMessage } from "../../../types";
import type { ToolCallResult } from "../../../types/toolCalls";
import {
  isMutatingTool,
  requiresUserApproval,
  type ToolApprovalPolicy,
} from "../../../utils/toolPolicy";
import {
  type AgentConversationSnapshot,
  type AgentRunPhase,
  type ManagedAgentError,
} from "../AgentConversation";
import {
  userSafeServiceCode,
  userSafeServiceMessage,
  type ThinAgentConnection,
} from "./ThinAgentConnection";
import type { ThinAgentLifecycleInput } from "./ThinAgentLifecycle";
import { ThinAgentHeadlessChat } from "./ThinAgentHeadlessChat";
import { ThinAgentMutationJournal } from "./ThinAgentMutationJournal";
import type { ThinAgentInputLimits } from "../../../services/managed/ThinAgentInputLimits";
import {
  durableAssistant,
  durableServerHistory,
  freezeAgentSnapshot,
  currentTurnMessages,
  outputAsToolResult,
  projectThinAgentChat,
  type ThinAgentTerminalOutcome,
} from "./ThinAgentProjection";

const VAULT_TOOL_NAMES = new Set<string>(FIRST_PARTY_TOOL_NAMES);
const CLIENT_DIAGNOSTIC_TYPE = "systemsculpt.client_diagnostic.v1";
const CLIENT_DIAGNOSTIC_INCIDENT_ID = /^incident_[a-f0-9]{32}$/u;

type ClientDiagnosticPhase =
  | "start"
  | "session"
  | "response"
  | "approval"
  | "tool_execution"
  | "mutation_journal"
  | "persistence"
  | "render"
  | "unknown";

type ClientDiagnostic = Readonly<{
  severity: "warn" | "error";
  code: string;
  phase: ClientDiagnosticPhase;
  toolName?: string;
  toolCallId?: string;
  status?: number;
  retryable?: boolean;
  incidentId?: string;
}>;

export type ThinAgentLocalToolCall = Readonly<{
  callId: string;
  name: string;
  input: unknown;
}>;

type ThinAgentToolDelivery =
  | Readonly<{
      state: "output-available";
      output: ToolCallResult;
      lifecycleCode: "tool_result_sent_succeeded" | "tool_result_sent_failed";
    }>
  | Readonly<{
      state: "output-error";
      errorText: string;
      lifecycleCode: "tool_result_sent_failed";
    }>;

export type ThinAgentRunInput = Readonly<{
  conversationId: string;
  turnId: string;
  message: UIMessage;
  buildBody?: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  approvalPolicy: ToolApprovalPolicy;
  beforeSend?: () => Promise<void>;
}>;

export type ThinAgentRunResult =
  | Readonly<{ kind: "completed"; snapshot: AgentConversationSnapshot; message: ChatMessage }>
  | Readonly<{ kind: "cancelled"; snapshot: AgentConversationSnapshot }>
  | Readonly<{ kind: "failed"; snapshot: AgentConversationSnapshot; error: ManagedAgentError }>;

export type ThinAgentBridgeOptions = Readonly<{
  connection: ThinAgentConnection;
  mutationJournal: ThinAgentMutationJournal;
  executeLocalTool: (call: ThinAgentLocalToolCall, signal: AbortSignal) => Promise<ToolCallResult>;
  persistAssistant: (message: ChatMessage) => Promise<void>;
  reconcileHistory?: (messages: readonly ChatMessage[]) => Promise<void>;
  updateInputLimits?: (limits: ThinAgentInputLimits) => void;
  refreshCredits?: () => void | Promise<void>;
  reportError?: (error: unknown) => void;
  now?: () => number;
  runId?: () => string;
}>;

type ActiveRun = {
  token: object;
  origin: "submitted" | "recovered";
  conversationId: string;
  turnId: string;
  runId: string;
  approvalPolicy: ToolApprovalPolicy;
  abort: AbortController;
  chat: ThinAgentHeadlessChat<UIMessage>;
  transport: WebSocketChatTransport;
  statusPhase: AgentRunPhase;
  statusLabel: string;
  serverRunId?: string;
  seenTerminalKeys: Set<string>;
  terminalOutcome: ThinAgentTerminalOutcome | null;
  pendingServerCompletion: boolean;
  pendingContinuationAttach: boolean;
  continuationAttachTimer: ReturnType<typeof setTimeout> | null;
  continuationAttachTask: Promise<void> | null;
  reconnectPending: boolean;
  reconnectTask: Promise<void> | null;
  sawConnectionClose: boolean;
  executingToolIds: Set<string>;
  settledClientToolIds: Set<string>;
  approvalCallIds: Map<string, string>;
  approvalDecisions: Map<string, boolean>;
  approvalAcknowledgements: Set<string>;
  authoritativeApprovalCallIds: Set<string>;
  reportedDiagnostics: Set<string>;
  lifecycleKeys: Set<string>;
  lastLifecyclePhase?: AgentRunPhase;
  toolTasks: Set<Promise<void>>;
  admissionTask: Promise<void> | null;
  finalizationTask: Promise<void> | null;
  stopTask: Promise<void> | null;
  cancelRequested: boolean;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  persistedMessage?: ChatMessage;
};

class ConversationPreparationCancelled extends Error {
  constructor() {
    super("Conversation preparation was superseded.");
    this.name = "ConversationPreparationCancelled";
  }
}

function defaultRunId(): string {
  // Run identity belongs to the shared agent session, not a DOM window.
  // eslint-disable-next-line obsidianmd/no-global-this
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `run-${random}`;
}

function asError(error: unknown, fallbackCode = "response_failed"): ManagedAgentError {
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return {
        code: userSafeServiceCode(candidate.code, fallbackCode),
        message: userSafeServiceMessage(
          candidate.message,
          "SystemSculpt could not complete the response. Retry this message.",
        ),
        ...(Number.isInteger(candidate.status) ? { status: candidate.status as number } : {}),
        ...(typeof candidate.requestId === "string" ? { requestId: candidate.requestId } : {}),
        ...(typeof candidate.incidentId === "string" ? { requestId: candidate.incidentId } : {}),
        ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
        ...(Number.isFinite(candidate.retryAfterSeconds)
          ? { retryAfterSeconds: candidate.retryAfterSeconds as number }
          : {}),
      };
    }
  }
  return {
    code: fallbackCode,
    message: error instanceof Error
      ? userSafeServiceMessage(
          error.message,
          "SystemSculpt could not complete the response. Retry this message.",
        )
      : "SystemSculpt could not complete the request.",
  };
}

type ThinAgentUIPart = UIMessage["parts"][number];
type ThinAgentToolUIPart = Extract<ThinAgentUIPart, { toolCallId: string }>;

function isClientVaultToolPart(
  part: ThinAgentUIPart,
): part is ThinAgentToolUIPart {
  return isToolUIPart(part)
    && part.providerExecuted !== true
    && VAULT_TOOL_NAMES.has(getToolName(part));
}

function keyedParts(parts: readonly ThinAgentUIPart[]): Array<Readonly<{
  key: string;
  part: ThinAgentUIPart;
}>> {
  const ordinals = new Map<string, number>();
  return parts.map((part) => {
    if (isToolUIPart(part)) {
      return { key: `tool:${getToolCallId(part)}`, part };
    }
    const type = typeof part.type === "string" ? part.type : "part";
    if (type === "source-url" && "url" in part && typeof part.url === "string") {
      return { key: `${type}:${part.url}`, part };
    }
    if ("id" in part && typeof part.id === "string" && part.id) {
      return { key: `${type}:${part.id}`, part };
    }
    const ordinal = ordinals.get(type) ?? 0;
    ordinals.set(type, ordinal + 1);
    return { key: `${type}:${ordinal}`, part };
  });
}

function toolProgress(part: Extract<ThinAgentUIPart, { toolCallId: string }>): number {
  switch (getToolPartState(part)) {
    case "streaming": return 0;
    case "loading": return 1;
    case "waiting-approval": return 2;
    case "approved": return 3;
    case "complete":
    case "denied":
    case "error":
      return 4;
  }
}

function mergeProgressivePart(
  floor: ThinAgentUIPart,
  incoming: ThinAgentUIPart,
): ThinAgentUIPart {
  if ((floor.type === "text" || floor.type === "reasoning")
    && incoming.type === floor.type) {
    const floorText = floor.text;
    const incomingText = incoming.text;
    if (floorText.startsWith(incomingText) && floorText.length > incomingText.length) {
      return floor;
    }
    return incoming;
  }
  if (isToolUIPart(floor) && isToolUIPart(incoming)
    && getToolCallId(floor) === getToolCallId(incoming)) {
    const floorProgress = toolProgress(floor);
    const incomingProgress = toolProgress(incoming);
    const serverExecuted =
      floor.providerExecuted === true || incoming.providerExecuted === true;
    let selected = incoming;
    if (floorProgress > incomingProgress) selected = floor;
    if (floorProgress === incomingProgress
      && floorProgress === 4
      && !serverExecuted
      && isClientVaultToolPart(floor)) {
      selected = floor;
    }
    return serverExecuted && selected.providerExecuted !== true
      ? { ...selected, providerExecuted: true }
      : selected;
  }
  return incoming;
}

function mergeProgressiveAssistant(
  floor: UIMessage,
  incoming: UIMessage,
): UIMessage {
  const floorParts = keyedParts(floor.parts);
  const incomingByKey = new Map(
    keyedParts(incoming.parts).map((entry) => [entry.key, entry.part] as const),
  );
  const mergedParts = floorParts.map(({ key, part }) => {
    const next = incomingByKey.get(key);
    incomingByKey.delete(key);
    return next ? mergeProgressivePart(part, next) : part;
  });
  for (const { key, part } of keyedParts(incoming.parts)) {
    if (incomingByKey.has(key)) {
      mergedParts.push(part);
      incomingByKey.delete(key);
    }
  }
  return {
    ...incoming,
    id: floor.id,
    parts: mergedParts,
  };
}

function mergePrefixCompatibleHistory(
  floor: readonly UIMessage[],
  incoming: readonly UIMessage[],
  preserveLocalTail: boolean,
): UIMessage[] {
  const commonLength = Math.min(floor.length, incoming.length);
  let shared = 0;
  while (
    shared < commonLength
    && floor[shared].id === incoming[shared].id
    && floor[shared].role === incoming[shared].role
  ) {
    shared += 1;
  }
  if (shared < commonLength) return [...incoming];
  const merged = Array.from({ length: shared }, (_, index) => {
    const previous = floor[index];
    const next = incoming[index];
    return previous.role === "assistant" && next.role === "assistant"
      ? mergeProgressiveAssistant(previous, next)
      : next;
  });
  return preserveLocalTail && incoming.length < floor.length
    ? [...merged, ...floor.slice(shared)]
    : [...merged, ...incoming.slice(shared)];
}

export class ThinAgentBridge {
  private readonly listeners = new Set<(snapshot: AgentConversationSnapshot) => void>();
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private currentSnapshot = freezeAgentSnapshot({
    runId: null,
    turnId: null,
    status: "idle",
    messages: [],
    parts: [],
  });
  private active: ActiveRun | null = null;
  private boundConversationId: string | null = null;
  private chat: ThinAgentHeadlessChat<UIMessage> | null = null;
  private transport: WebSocketChatTransport | null = null;
  private sessionDetachers: Array<() => void> = [];
  private pendingHistoryReconcile: Promise<void> = Promise.resolve();
  private reconciledHistorySource: readonly UIMessage[] | null = null;
  private reconciledHistoryActiveToken: object | null = null;
  private reconciledHistoryTurnIndex = -2;
  private completedHistoryFloor: Readonly<{
    conversationId: string;
    messages: readonly UIMessage[];
  }> | null = null;
  private publicationBatchDepth = 0;
  private batchedPublication: ActiveRun | null = null;
  private preparingConversation: {
    conversationId: string;
    token: object;
    promise: Promise<void>;
    cancellation: Promise<void>;
    cancel: () => void;
    cancelled: boolean;
  } | null = null;

  constructor(private readonly options: ThinAgentBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.createRunId = options.runId ?? defaultRunId;
  }

  public getSnapshot(): AgentConversationSnapshot {
    return this.currentSnapshot;
  }

  public subscribe(listener: (snapshot: AgentConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private createActiveRun(input: Readonly<{
    origin: ActiveRun["origin"];
    conversationId: string;
    turnId: string;
    approvalPolicy: ToolApprovalPolicy;
    chat: ThinAgentHeadlessChat<UIMessage>;
    transport: WebSocketChatTransport;
  }>): ActiveRun {
    let resolveTerminal: () => void = () => {};
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const authoritativeApprovalCallIds = new Set<string>();
    if (input.origin === "recovered") {
      for (const message of currentTurnMessages(input.chat.messages, input.turnId)) {
        for (const part of message.parts) {
          if (isClientVaultToolPart(part) && getToolPartState(part) === "approved") {
            authoritativeApprovalCallIds.add(getToolCallId(part));
          }
        }
      }
    }
    return {
      token: {},
      origin: input.origin,
      conversationId: input.conversationId,
      turnId: input.turnId,
      runId: this.createRunId(),
      approvalPolicy: input.approvalPolicy,
      abort: new AbortController(),
      chat: input.chat,
      transport: input.transport,
      statusPhase: input.origin === "recovered" ? "retrying" : "submitted",
      statusLabel: input.origin === "recovered" ? "Recovering" : "Starting",
      seenTerminalKeys: new Set(),
      terminalOutcome: null,
      pendingServerCompletion: false,
      pendingContinuationAttach: false,
      continuationAttachTimer: null,
      continuationAttachTask: null,
      reconnectPending: false,
      reconnectTask: null,
      sawConnectionClose: false,
      executingToolIds: new Set(),
      settledClientToolIds: new Set(),
      approvalCallIds: new Map(),
      approvalDecisions: new Map(),
      approvalAcknowledgements: new Set(),
      authoritativeApprovalCallIds,
      reportedDiagnostics: new Set(),
      lifecycleKeys: new Set(),
      toolTasks: new Set(),
      admissionTask: null,
      finalizationTask: null,
      stopTask: null,
      cancelRequested: false,
      terminalPromise,
      resolveTerminal,
    };
  }

  private findRecoverableTurnId(messages: readonly UIMessage[]): string | null {
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) return null;
    const turnId = messages[userIndex].id;
    const tail = messages.slice(userIndex + 1);
    let sawAssistant = false;
    let sawTerminal = false;
    let unsettledVaultTool = false;
    let explicitlyStreaming = false;
    for (const message of tail) {
      if (message.role !== "assistant") continue;
      sawAssistant = true;
      for (const part of message.parts) {
        if (isClientVaultToolPart(part)) {
          const state = getToolPartState(part);
          if (!["complete", "error", "denied"].includes(state)) {
            unsettledVaultTool = true;
          }
        }
        if ("state" in part && part.state === "streaming") {
          explicitlyStreaming = true;
        }
        const terminal = parseThinAgentDataPart(part);
        if (terminal?.kind === "known"
          && terminal.type === "data-systemsculpt-run-terminal"
          && terminal.data.root_message_id === turnId) {
          sawTerminal = true;
        }
      }
    }
    if (sawTerminal && !unsettledVaultTool && !explicitlyStreaming) return null;
    return !sawAssistant || unsettledVaultTool || explicitlyStreaming ? turnId : null;
  }

  private handleCurrentTurnDataParts(active: ActiveRun): void {
    if (!this.isActive(active)) return;
    for (const message of currentTurnMessages(active.chat.messages, active.turnId)) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (typeof part.type === "string" && part.type.startsWith("data-")) {
          this.handleDataPart(active, part);
        }
      }
    }
  }

  private async ensureConversation(conversationId: string): Promise<void> {
    if (this.boundConversationId === conversationId && this.chat && this.transport) return;
    if (this.active) throw new Error("The current response must stop before changing chats.");
    if (this.preparingConversation) {
      if (this.preparingConversation.conversationId === conversationId) {
        await this.preparingConversation.promise;
        return;
      }
      await this.preparingConversation.promise.catch(() => undefined);
      return this.ensureConversation(conversationId);
    }
    let cancelPreparation: () => void = () => {};
    const cancellation = new Promise<void>((resolve) => {
      cancelPreparation = resolve;
    });
    const preparation = {
      conversationId,
      token: {},
      promise: Promise.resolve(),
      cancellation,
      cancel: cancelPreparation,
      cancelled: false,
    };
    this.preparingConversation = preparation;
    const promise = this.prepareConversation(conversationId, preparation.token);
    preparation.promise = promise;
    try {
      await promise;
    } finally {
      if (this.preparingConversation?.promise === promise) {
        this.preparingConversation = null;
      }
    }
  }

  private assertPreparationCurrent(token: object): void {
    if (
      this.preparingConversation?.token !== token
      || this.preparingConversation.cancelled
    ) {
      throw new ConversationPreparationCancelled();
    }
  }

  private async awaitPreparationStep<T>(token: object, promise: Promise<T>): Promise<T> {
    const preparation = this.preparingConversation;
    if (preparation?.token !== token || preparation.cancelled) {
      throw new ConversationPreparationCancelled();
    }
    try {
      const value = await Promise.race([
        promise,
        preparation.cancellation.then(() => {
          throw new ConversationPreparationCancelled();
        }),
      ]);
      this.assertPreparationCurrent(token);
      return value;
    } catch (error) {
      this.assertPreparationCurrent(token);
      throw error;
    }
  }

  private async prepareConversation(conversationId: string, token: object): Promise<void> {
    if (this.boundConversationId) {
      this.clearConversation();
      this.options.connection.disconnect();
    }
    const prepared = await this.awaitPreparationStep(
      token,
      this.options.connection.prepare(),
    );
    this.options.connection.connect();
    const transport = this.options.connection.chatTransport();
    const chat = new ThinAgentHeadlessChat<UIMessage>({
      id: conversationId,
      messages: prepared.messages,
      transport,
      onToolCall: ({ toolCall }) => {
        const active = this.active;
        if (!active) return;
        void this.handleToolCall(active, {
          callId: toolCall.toolCallId,
          name: toolCall.toolName,
          input: toolCall.input,
        });
      },
      onData: (part) => {
        const active = this.active;
        if (active) this.handleDataPart(active, part, false);
      },
      onError: (error) => {
        const active = this.active;
        if (active) {
          this.fail(
            active,
            asError(error, "response_interrupted"),
            { severity: "error", code: "response_interrupted", phase: "response" },
          );
        } else {
          this.options.reportError?.(error);
        }
      },
    }, (error) => {
      const active = this.active;
      if (active) {
        this.fail(
          active,
          asError(error, "response_state_update_failed"),
          { severity: "error", code: "response_state_update_failed", phase: "render" },
        );
      } else {
        this.options.reportError?.(error);
      }
    });
    this.boundConversationId = conversationId;
    this.chat = chat;
    this.transport = transport;
    const recoveryTurnId = this.findRecoverableTurnId(prepared.messages);
    const recovered = recoveryTurnId
      ? this.createActiveRun({
          origin: "recovered",
          conversationId,
          turnId: recoveryTurnId,
          approvalPolicy: {},
          chat,
          transport,
        })
      : null;
    if (recovered) {
      this.active = recovered;
      this.recordLifecycle(recovered, {
        code: "run_started",
        phase: "response",
      });
      this.handleChatMessages(recovered);
      this.handleCurrentTurnDataParts(recovered);
    }
    this.sessionDetachers.push(
      chat.subscribe(() => {
        const active = this.active;
        if (active) {
          this.withPublicationBatch(active, () => {
            this.handleChatMessages(active, false);
            this.handleChatStatus(active);
            if (chat.error) {
              this.fail(
                active,
                asError(chat.error, "response_interrupted"),
                { severity: "error", code: "response_interrupted", phase: "response" },
              );
            }
          });
        } else if (chat.status === "ready") {
          this.reconcileServerHistory();
        }
      }),
    );
    const initialResume = chat.resumeStream();
    if (recovered) recovered.reconnectTask = initialResume;
    this.sessionDetachers.push(
      this.options.connection.addMessageListener((event) =>
        this.handleConnectionFrame(event)),
      this.options.connection.addCloseListener((event) => {
        const active = this.active;
        if (active) {
          this.handleConnectionClose(active, event);
        } else if (event.code === 1008 || (event.code >= 4000 && event.code <= 4999)) {
          this.clearConversation();
          this.options.connection.disconnect();
        }
      }),
      this.options.connection.addOpenListener(() => {
        const active = this.active;
        if (active) this.handleConnectionOpen(active);
      }),
    );
    await this.awaitPreparationStep(token, this.options.connection.whenReady());
    this.options.updateInputLimits?.(prepared.inputLimits);
    this.reconcileServerHistory();
    if (recovered) {
      void initialResume.finally(() => {
        if (recovered.reconnectTask === initialResume) {
          recovered.reconnectTask = null;
        }
        if (!this.isActive(recovered)) return;
        this.handleChatMessages(recovered);
        this.handleCurrentTurnDataParts(recovered);
        this.scheduleContinuationAttach(recovered);
      });
    } else {
      await this.awaitPreparationStep(token, initialResume);
    }
    // Local cache reconciliation is observational. A vault write failure must
    // not reject hydration or take terminal authority from a recovered run.
    await this.awaitPreparationStep(
      token,
      this.pendingHistoryReconcile.catch(() => undefined),
    );
  }

  private clearConversation(): void {
    for (const detach of this.sessionDetachers.splice(0)) detach();
    this.boundConversationId = null;
    this.chat = null;
    this.transport = null;
    this.reconciledHistorySource = null;
    this.reconciledHistoryActiveToken = null;
    this.reconciledHistoryTurnIndex = -2;
    this.completedHistoryFloor = null;
  }

  public async hydrate(conversationId: string): Promise<void> {
    try {
      await this.ensureConversation(conversationId);
    } catch (error) {
      if (!this.active) {
        this.clearConversation();
        this.options.connection.disconnect();
      }
      throw error;
    }
  }

  public async start(input: ThinAgentRunInput): Promise<ThinAgentRunResult> {
    if (this.active) {
      return {
        kind: "failed",
        snapshot: this.currentSnapshot,
        error: { code: "response_in_progress", message: "SystemSculpt is already working." },
      };
    }
    try {
      await this.hydrate(input.conversationId);
    } catch (error) {
      if (error instanceof ConversationPreparationCancelled) {
        return { kind: "cancelled", snapshot: this.currentSnapshot };
      }
      const normalized = asError(error, "response_start_failed");
      this.options.reportError?.(normalized);
      const runId = this.createRunId();
      const snapshot = freezeAgentSnapshot({
        runId,
        turnId: input.turnId,
        status: "failed",
        phase: "submitted",
        terminalError: normalized,
        messages: [],
        parts: [{
          id: `error:${input.turnId}`,
          kind: "error",
          error: normalized,
          retryable: normalized.retryable === true,
          retryMessageId: input.turnId,
          order: 0,
        }],
      });
      this.currentSnapshot = snapshot;
      for (const listener of this.listeners) {
        try { listener(snapshot); }
        catch (listenerError) { this.options.reportError?.(listenerError); }
      }
      return { kind: "failed", snapshot, error: normalized };
    }
    if (this.active) {
      return {
        kind: "failed",
        snapshot: this.currentSnapshot,
        error: {
          code: "response_in_progress",
          message: "The previous response is still active.",
          retryable: true,
        },
      };
    }
    const transport = this.transport!;
    const chat = this.chat!;
    const active = this.createActiveRun({
      origin: "submitted",
      conversationId: input.conversationId,
      turnId: input.turnId,
      approvalPolicy: input.approvalPolicy,
      chat,
      transport,
    });
    this.active = active;

    this.recordLifecycle(active, {
      code: "run_started",
      phase: "response",
    });
    this.publish(active);

    try {
      let body: Record<string, unknown> | undefined;
      if (!active.terminalOutcome && input.buildBody) {
        try {
          body = await input.buildBody(active.abort.signal);
        } catch (error) {
          if (!active.terminalOutcome) {
            if (active.cancelRequested || active.abort.signal.aborted) {
              this.finish(active, { kind: "cancelled" });
            } else {
              const normalized = asError(error, "context_prepare_failed");
              this.fail(
                active,
                normalized,
                {
                  severity: "error",
                  code: normalized.code,
                  phase: "start",
                  ...(normalized.status === undefined ? {} : { status: normalized.status }),
                  ...(normalized.retryable === undefined ? {} : { retryable: normalized.retryable }),
                },
              );
            }
          }
        }
      }
      if (!active.terminalOutcome && input.beforeSend) {
        let admissionTask: Promise<void> | null = null;
        try {
          admissionTask = input.beforeSend();
          active.admissionTask = admissionTask;
          await admissionTask;
        } catch (error) {
          this.fail(
            active,
            asError(error, "message_save_failed"),
            {
              severity: "error",
              code: "message_save_failed",
              phase: "persistence",
            },
          );
        } finally {
          if (active.admissionTask === admissionTask) {
            active.admissionTask = null;
          }
        }
      }
      if (!active.terminalOutcome) {
        void chat.sendMessage(
          input.message as Parameters<ThinAgentHeadlessChat<UIMessage>["sendMessage"]>[0],
          body ? { body } : undefined,
        );
        // AbstractChat inserts the user turn synchronously before returning its
        // send promise. Reconcile only now, after beforeSend durably committed
        // the local branch, so a fork prefix cannot race the resend version.
        this.reconcileServerHistory();
      }
      await active.terminalPromise;
      if (active.terminalOutcome?.kind === "completed" && active.persistedMessage) {
        return {
          kind: "completed",
          snapshot: this.currentSnapshot,
          message: active.persistedMessage,
        };
      }
      if (active.terminalOutcome?.kind === "cancelled") {
        return { kind: "cancelled", snapshot: this.currentSnapshot };
      }
      const error = active.terminalOutcome?.kind === "failed"
        ? active.terminalOutcome.error
        : { code: "response_failed", message: "SystemSculpt could not complete the request." };
      return { kind: "failed", snapshot: this.currentSnapshot, error };
    } finally {
      // The headless Chat lifecycle is intentionally independent of a DOM realm.
      // eslint-disable-next-line obsidianmd/prefer-window-timers
      if (active.continuationAttachTimer) clearTimeout(active.continuationAttachTimer);
      if (this.active?.token === active.token) this.active = null;
    }
  }

  public respondToApproval(approvalId: string, approved: boolean): boolean {
    const active = this.active;
    if (!active || active.terminalOutcome) return false;
    const toolCallId = active.approvalCallIds.get(approvalId);
    if (!toolCallId || active.approvalDecisions.has(toolCallId)) return false;
    active.approvalDecisions.set(toolCallId, approved);
    const approvalTool = this.findToolCall(active, toolCallId);
    this.recordLifecycle(active, {
      code: approved
        ? "approval_submitted_approved"
        : "approval_submitted_denied",
      phase: "approval",
      ...(approvalTool ? { toolName: approvalTool.name } : {}),
      toolCallId,
    });
    try {
      this.sendNativeToolApproval(toolCallId, approved);
      void Promise.resolve(active.chat.addToolApprovalResponse({ id: approvalId, approved }))
        .catch((error) => this.fail(
          active,
          asError(error, "approval_failed"),
          {
            severity: "error",
            code: "approval_failed",
            phase: "approval",
            toolCallId,
          },
        ));
    } catch (error) {
      this.fail(
        active,
        asError(error, "approval_failed"),
        {
          severity: "error",
          code: "approval_failed",
          phase: "approval",
          toolCallId,
        },
      );
      return false;
    }
    active.pendingContinuationAttach = true;
    this.scheduleContinuationAttach(active);
    this.publish(active);
    return true;
  }

  public async cancel(): Promise<void> {
    const active = this.active;
    if (!active) {
      const preparation = this.preparingConversation;
      if (!preparation) return;
      preparation.cancelled = true;
      preparation.cancel();
      this.options.connection.disconnect();
      await preparation.promise.catch(() => undefined);
      return;
    }
    if (active.terminalOutcome) return;
    active.cancelRequested = true;
    const admissionTask = active.admissionTask;
    if (admissionTask) {
      await admissionTask.catch(() => undefined);
      if (!this.isActive(active) || active.terminalOutcome) return;
    }
    const finalizationTask = active.finalizationTask;
    if (finalizationTask) {
      await finalizationTask.catch(() => undefined);
      return;
    }
    active.abort.abort();
    this.options.connection.cancel();
    this.finish(active, { kind: "cancelled" });
    await this.stopChat(active);
  }

  public async close(): Promise<void> {
    if (this.preparingConversation) {
      this.preparingConversation.cancelled = true;
      this.preparingConversation.cancel();
    }
    await this.cancel();
    this.clearConversation();
    this.options.connection.close();
    await this.options.mutationJournal.idle();
    await this.pendingHistoryReconcile.catch(() => undefined);
  }

  public disconnect(): void {
    if (this.active) throw new Error("The current response must stop before changing chats.");
    if (this.preparingConversation) {
      this.preparingConversation.cancelled = true;
      this.preparingConversation.cancel();
    }
    this.clearConversation();
    this.options.connection.disconnect();
  }

  private handleChatMessages(active: ActiveRun, publishSnapshot = true): void {
    if (!this.isActive(active)) return;
    for (const message of currentTurnMessages(active.chat.messages, active.turnId)) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isClientVaultToolPart(part)) continue;
        const name = getToolName(part);
        const callId = getToolCallId(part);
        const approval = getToolApproval(part);
        const state = getToolPartState(part);
        if (["complete", "error", "denied"].includes(state)) {
          active.settledClientToolIds.add(callId);
          continue;
        }
        if (state === "waiting-approval" && approval) {
          active.approvalCallIds.set(approval.id, callId);
          this.recordLifecycle(active, {
            code: "approval_presented",
            phase: "approval",
            toolName: name,
            toolCallId: callId,
          }, `approval-presented:${callId}`);
          if (!active.approvalDecisions.has(callId)
            && !requiresUserApproval(name, active.approvalPolicy)) {
            this.respondToApproval(approval.id, true);
          }
          continue;
        }
        if (state === "approved" && approval) {
          const approved = approval.approved === true;
          active.approvalCallIds.set(approval.id, callId);
          active.approvalDecisions.set(callId, approved);
          if (active.authoritativeApprovalCallIds.has(callId)) {
            active.approvalAcknowledgements.add(callId);
          }
          if (approved) {
            this.handleToolCall(active, {
              callId,
              name,
              input: getToolInput(part),
            });
          } else if (!approved && active.approvalAcknowledgements.has(callId)) {
            active.settledClientToolIds.add(callId);
          }
          continue;
        }
        if (state === "loading") {
          this.handleToolCall(active, {
            callId,
            name,
            input: getToolInput(part),
          });
        }
      }
    }
    if (publishSnapshot) this.publish(active);
    this.tryFinalizeSuccess(active);
  }

  private handleChatStatus(active: ActiveRun): void {
    if (!this.isActive(active) || active.terminalOutcome) return;
    const chatStatus = active.chat.status;
    if (chatStatus === "submitted") {
      active.statusPhase = "submitted";
      active.statusLabel = "Starting";
    } else if (chatStatus === "streaming" && active.statusPhase === "submitted") {
      active.statusPhase = "working";
      active.statusLabel = "Working";
    }
    this.publish(active);
    if (chatStatus === "ready") {
      this.scheduleContinuationAttach(active);
      this.scheduleReconnect(active);
      this.tryFinalizeSuccess(active);
    }
  }

  private handleToolCall(active: ActiveRun, call: ThinAgentLocalToolCall): void {
    const part = this.findClientVaultToolPart(active, call.callId);
    if (!this.isActive(active)
      || !VAULT_TOOL_NAMES.has(call.name)
      || !part
      || getToolName(part) !== call.name
      || active.settledClientToolIds.has(call.callId)
      || active.executingToolIds.has(call.callId)) {
      return;
    }
    if (isMutatingTool(call.name)) {
      const acknowledged = active.approvalAcknowledgements.has(call.callId);
      const approved = active.approvalDecisions.get(call.callId) === true;
      if (!acknowledged || !approved) return;
    }
    const task = this.executeTool(active, call);
    active.toolTasks.add(task);
    void task.finally(() => {
      active.toolTasks.delete(task);
      this.scheduleContinuationAttach(active);
      this.tryFinalizeSuccess(active);
    });
  }

  private async executeTool(active: ActiveRun, call: ThinAgentLocalToolCall): Promise<void> {
    if (!this.isActive(active) || active.abort.signal.aborted) return;
    this.recordLifecycle(active, {
      code: "local_tool_started",
      phase: "tool_execution",
      toolName: call.name,
      toolCallId: call.callId,
    }, `local-tool-started:${call.callId}`);
    active.executingToolIds.add(call.callId);
    this.publish(active);
    let deliveryStarted = false;
    try {
      let result: ToolCallResult;
      if (isMutatingTool(call.name)) {
        const claim = await this.options.mutationJournal.claim(
          active.conversationId,
          call.callId,
          call.name,
          call.input,
        ).catch((error) => {
          this.options.reportError?.(error);
          this.reportClientDiagnostic(active, {
            severity: "error",
            code: "tool_mutation_journal_unavailable",
            phase: "mutation_journal",
            toolName: call.name,
            toolCallId: call.callId,
          });
          return { kind: "journal-unavailable" as const };
        });
        if (claim.kind === "replay") {
          result = outputAsToolResult(claim.result);
        } else if (claim.kind === "outcome-unknown") {
          this.reportClientDiagnostic(active, {
            severity: "warn",
            code: "tool_mutation_outcome_unknown",
            phase: "mutation_journal",
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = {
            success: false,
            error: {
              code: "TOOL_PREVIOUS_OUTCOME_UNKNOWN",
              message: "This vault action started previously, so it was not repeated automatically.",
            },
          };
        } else if (claim.kind === "conflict") {
          this.reportClientDiagnostic(active, {
            severity: "error",
            code: "tool_call_id_conflict",
            phase: "response",
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = {
            success: false,
            error: {
              code: "TOOL_CALL_ID_CONFLICT",
              message: "This vault action could not be matched safely.",
            },
          };
        } else if (claim.kind === "journal-unavailable") {
          this.reportClientDiagnostic(active, {
            severity: "error",
            code: "tool_mutation_journal_unavailable",
            phase: "mutation_journal",
            toolName: call.name,
            toolCallId: call.callId,
          });
          result = {
            success: false,
            error: {
              code: "TOOL_MUTATION_JOURNAL_UNAVAILABLE",
              message: "Vault changes are blocked because the mutation safety journal is unavailable.",
            },
          };
        } else {
          result = await this.options.executeLocalTool(call, active.abort.signal);
          try {
            await this.options.mutationJournal.complete(
              active.conversationId,
              call.callId,
              call.name,
              call.input,
              result,
            );
          } catch (error) {
            this.options.reportError?.(error);
            this.reportClientDiagnostic(active, {
              severity: "error",
              code: "tool_mutation_outcome_unknown",
              phase: "mutation_journal",
              toolName: call.name,
              toolCallId: call.callId,
            });
            result = {
              success: false,
              error: {
                code: "TOOL_MUTATION_OUTCOME_UNKNOWN",
                message: "The vault action returned, but its safety receipt could not be saved. Its outcome is unknown and it must not be retried automatically.",
              },
            };
          }
        }
      } else {
        result = await this.options.executeLocalTool(call, active.abort.signal);
      }
      if (!this.isActive(active) || active.abort.signal.aborted) return;
      this.recordLifecycle(active, {
        code: result.success
          ? "local_tool_completed_succeeded"
          : "local_tool_completed_failed",
        phase: "tool_execution",
        toolName: call.name,
        toolCallId: call.callId,
      }, `local-tool-completed:${call.callId}`);
      deliveryStarted = true;
      await this.deliverToolResult(active, call, {
        state: "output-available",
        output: result,
        lifecycleCode: result.success
          ? "tool_result_sent_succeeded"
          : "tool_result_sent_failed",
      });
    } catch (error) {
      if (!this.isActive(active) || active.abort.signal.aborted) return;
      if (deliveryStarted) {
        this.fail(
          active,
          asError(error, "local_tool_result_failed"),
          {
            severity: "error",
            code: "local_tool_result_failed",
            phase: "tool_execution",
            toolName: call.name,
            toolCallId: call.callId,
          },
        );
        return;
      }
      this.recordLifecycle(active, {
        code: "local_tool_completed_failed",
        phase: "tool_execution",
        toolName: call.name,
        toolCallId: call.callId,
      }, `local-tool-completed:${call.callId}`);
      const message = error instanceof Error ? error.message : "The vault action failed.";
      await this.deliverToolResult(active, call, {
        state: "output-error",
        errorText: message,
        lifecycleCode: "tool_result_sent_failed",
      });
    } finally {
      active.executingToolIds.delete(call.callId);
      this.publish(active);
    }
  }

  private async deliverToolResult(
    active: ActiveRun,
    call: ThinAgentLocalToolCall,
    delivery: ThinAgentToolDelivery,
  ): Promise<void> {
    let projectionError: unknown;
    try {
      if (delivery.state === "output-available") {
        await active.chat.addToolOutput({
          tool: call.name,
          toolCallId: call.callId,
          output: delivery.output,
          state: delivery.state,
        });
      } else {
        await active.chat.addToolOutput({
          tool: call.name,
          toolCallId: call.callId,
          state: delivery.state,
          errorText: delivery.errorText,
        });
      }
    } catch (error) {
      projectionError = error;
    }
    if (!this.isActive(active) || active.abort.signal.aborted) return;
    try {
      this.sendNativeToolResult({
        toolCallId: call.callId,
        toolName: call.name,
        ...(delivery.state === "output-available"
          ? { output: delivery.output }
          : { errorText: delivery.errorText }),
        state: delivery.state,
      });
    } catch (error) {
      this.fail(
        active,
        asError(error, "local_tool_result_failed"),
        {
          severity: "error",
          code: "local_tool_result_failed",
          phase: "tool_execution",
          toolName: call.name,
          toolCallId: call.callId,
        },
      );
      return;
    }
    this.recordLifecycle(active, {
      code: delivery.lifecycleCode,
      phase: "tool_execution",
      toolName: call.name,
      toolCallId: call.callId,
    }, `tool-result-sent:${call.callId}`);
    active.settledClientToolIds.add(call.callId);
    active.pendingContinuationAttach = true;
    if (projectionError) {
      this.fail(
        active,
        asError(projectionError, "tool_result_display_failed"),
        {
          severity: "error",
          code: "tool_result_display_failed",
          phase: "render",
          toolName: call.name,
          toolCallId: call.callId,
        },
      );
    }
  }

  private handleDataPart(
    active: ActiveRun,
    value: unknown,
    publishSuccess = true,
  ): void {
    if (!this.isActive(active)) return;
    if (!active.chat.messages.some((message) =>
      message.role === "user" && message.id === active.turnId)) {
      return;
    }
    const parsed = parseThinAgentDataPart(value);
    if (!parsed || parsed.kind === "unknown") return;
    if (parsed.kind === "invalid") {
      this.fail(active, {
        code: "invalid_response_data",
        message: "SystemSculpt returned invalid response data.",
        retryable: false,
      }, { severity: "error", code: "invalid_response_data", phase: "response" });
      return;
    }
    switch (parsed.type) {
      case "data-systemsculpt-run-terminal":
        {
          const data = parsed.data;
          if (data.root_message_id !== active.turnId) return;
          if (!active.serverRunId) active.serverRunId = data.run_id;
          else if (data.run_id !== active.serverRunId) return;
          const incidentId = "incident_id" in data && typeof data.incident_id === "string"
            ? data.incident_id
            : "";
          const terminalKey = [
            data.run_id,
            data.root_message_id,
            data.outcome,
            data.code,
            incidentId,
          ].join("\0");
          if (active.seenTerminalKeys.has(terminalKey)) return;
          active.seenTerminalKeys.add(terminalKey);
          this.recordLifecycle(active, {
            code: data.outcome === "succeeded"
              ? "response_result_received_succeeded"
              : data.outcome === "cancelled"
                ? "response_result_received_cancelled"
                : "response_result_received_failed",
            phase: "response",
            ...("retryable" in data ? { retryable: data.retryable } : {}),
            ...("incident_id" in data ? { incidentId: data.incident_id } : {}),
          }, `terminal-received:${terminalKey}`);
          if (data.outcome === "succeeded") {
            active.pendingServerCompletion = true;
            active.statusPhase = "settling";
            active.statusLabel = "Finishing";
            if (publishSuccess) this.publish(active);
            this.tryFinalizeSuccess(active);
          } else if (data.outcome === "cancelled") {
            this.finish(active, { kind: "cancelled" });
          } else {
            this.fail(active, {
              code: userSafeServiceCode(data.code, "response_failed"),
              message: (() => {
                const message = userSafeServiceMessage(
                  data.message,
                  "SystemSculpt could not complete the response. Retry this message.",
                );
                return data.retryable
                  && /(?:429|rate[_ -]?limit)/i.test(`${data.code} ${message}`)
                  && !/(?:try|retry|again)/i.test(message)
                  ? `${message} Try again shortly.`
                  : message;
              })(),
              requestId: data.incident_id,
              retryable: data.retryable,
            });
          }
        }
    }
  }

  private handleConnectionFrame(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    this.options.connection.handleProtocolFrame(frame);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
    const outer = frame as Record<string, unknown>;
    if (outer.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
      if (!Array.isArray(outer.messages) || !this.chat) return;
      const active = this.active;
      const apply = (): void => {
        if (!this.chat) return;
        const preserveLocalTail = active !== null
          && active.terminalOutcome === null
          && this.active === active
          && this.isActive(active);
        const completedFloor = this.completedHistoryFloor?.conversationId
          === this.boundConversationId
          ? this.completedHistoryFloor.messages
          : null;
        const floor = preserveLocalTail
          ? active.chat.messages
          : completedFloor ?? this.chat.messages;
        const messages = mergePrefixCompatibleHistory(
          floor,
          outer.messages as UIMessage[],
          preserveLocalTail,
        );
        if (active) {
          for (const message of currentTurnMessages(messages, active.turnId)) {
            for (const part of message.parts) {
              if (isClientVaultToolPart(part) && getToolPartState(part) === "approved") {
                active.authoritativeApprovalCallIds.add(getToolCallId(part));
              }
            }
          }
        }
        this.chat.messages = messages;
        if (!active && completedFloor && this.boundConversationId) {
          this.completedHistoryFloor = {
            conversationId: this.boundConversationId,
            messages,
          };
        }
        this.reconcileServerHistory();
        if (active && this.isActive(active)) {
          this.handleCurrentTurnDataParts(active);
        }
      };
      if (active) {
        this.withPublicationBatch(active, apply);
      } else {
        apply();
      }
      return;
    }
    if (outer.type === MessageType.CF_AGENT_MESSAGE_UPDATED) {
      const active = this.active;
      if (active) {
        this.withPublicationBatch(active, () => this.applyMessageUpdate(outer.message));
      } else {
        this.applyMessageUpdate(outer.message);
      }
      return;
    }
    const active = this.active;
    if (!active || !this.isActive(active)) return;
    this.withPublicationBatch(active, () => {
      if (outer.type === MessageType.CF_AGENT_CHAT_RECOVERING) {
        active.statusPhase = outer.recovering ? "retrying" : "working";
        active.statusLabel = outer.recovering ? "Recovering" : "Continuing";
        this.publish(active);
      }
      if (outer.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE || typeof outer.body !== "string") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(outer.body);
      } catch {
        return;
      }
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return;
      const candidate = chunk as Record<string, unknown>;
      if (candidate.type !== "tool-approval-response"
        || typeof candidate.approvalId !== "string"
        || typeof candidate.approved !== "boolean") {
        return;
      }
      const toolCallId = active.approvalCallIds.get(candidate.approvalId);
      if (!toolCallId) return;
      active.approvalAcknowledgements.add(toolCallId);
      active.approvalDecisions.set(toolCallId, candidate.approved);
      const tool = this.findToolCall(active, toolCallId);
      this.recordLifecycle(active, {
        code: candidate.approved
          ? "approval_acknowledged_approved"
          : "approval_acknowledged_denied",
        phase: "approval",
        ...(tool ? { toolName: tool.name } : {}),
        toolCallId,
      }, `approval-acknowledged:${toolCallId}`);
      if (!candidate.approved) return;
      const call = this.findToolCall(active, toolCallId);
      if (call) this.handleToolCall(active, call);
    });
  }

  private applyMessageUpdate(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const chat = this.chat;
    if (!chat) return;
    const updatedMessage = value as UIMessage;
    if (typeof updatedMessage.id !== "string" || !Array.isArray(updatedMessage.parts)) return;
    const messages = chat.messages;
    let index = messages.findIndex((message) => message.id === updatedMessage.id);
    if (index < 0) {
      const updatedCallIds = new Set(
        updatedMessage.parts
          .filter(isToolUIPart)
          .map((part) => getToolCallId(part)),
      );
      if (updatedCallIds.size > 0) {
        index = messages.findIndex((message) =>
          message.parts.some((part) =>
            isToolUIPart(part) && updatedCallIds.has(getToolCallId(part))));
      }
    }
    if (index < 0) return;
    const candidate = {
      ...updatedMessage,
      id: messages[index].id,
    };
    const previous = messages[index];
    const replacement = previous.role === "assistant" && candidate.role === "assistant"
      ? mergeProgressiveAssistant(previous, candidate)
      : candidate;
    const activeBeforeUpdate = this.active;
    if (activeBeforeUpdate && this.isActive(activeBeforeUpdate)) {
      const activeUserIndex = messages.findIndex((message) =>
        message.role === "user" && message.id === activeBeforeUpdate.turnId);
      const updatesLatestActiveAssistant = activeUserIndex >= 0
        && index > activeUserIndex
        && !messages.slice(activeUserIndex + 1, index)
          .some((message) => message.role === "user")
        && replacement.role === "assistant"
        && !messages.slice(index + 1)
          .some((message) => message.role === "assistant" || message.role === "user");
      if (updatesLatestActiveAssistant) {
        for (const part of replacement.parts) {
          if (isClientVaultToolPart(part) && getToolPartState(part) === "approved") {
            activeBeforeUpdate.authoritativeApprovalCallIds.add(getToolCallId(part));
          }
        }
      }
    }
    chat.messages = [
      ...messages.slice(0, index),
      replacement,
      ...messages.slice(index + 1),
    ];
    if (!activeBeforeUpdate
      && this.completedHistoryFloor?.conversationId === this.boundConversationId
      && this.completedHistoryFloor.messages.some((message) =>
        message.id === replacement.id && message.role === replacement.role)) {
      this.completedHistoryFloor = {
        conversationId: this.completedHistoryFloor.conversationId,
        messages: chat.messages,
      };
    }
    if (!this.active
      && replacement.role === "assistant"
      && this.boundConversationId
      && this.transport) {
      const terminalRootId = replacement.parts
        .map((part) => parseThinAgentDataPart(part))
        .find((part) =>
          part?.kind === "known"
          && part.type === "data-systemsculpt-run-terminal")
        ?.data.root_message_id;
      const terminalUserIndex = typeof terminalRootId === "string"
        ? chat.messages.findIndex((message) =>
            message.role === "user" && message.id === terminalRootId)
        : -1;
      const isLatestTurnTerminal = terminalUserIndex >= 0
        && index > terminalUserIndex
        && !chat.messages.slice(terminalUserIndex + 1, index)
          .some((message) => message.role === "user")
        && !chat.messages.slice(index + 1)
          .some((message) => message.role === "assistant" || message.role === "user");
      if (terminalRootId && isLatestTurnTerminal) {
        const recovered = this.createActiveRun({
          origin: "recovered",
          conversationId: this.boundConversationId,
          turnId: terminalRootId,
          approvalPolicy: {},
          chat,
          transport: this.transport,
        });
        this.active = recovered;
        this.recordLifecycle(recovered, {
          code: "run_started",
          phase: "response",
        });
      }
    }
    this.reconcileServerHistory();
    const active = this.active;
    if (!active || !this.isActive(active)) return;
    const activeUserIndex = chat.messages.findIndex((message) =>
      message.role === "user" && message.id === active.turnId);
    if (activeUserIndex < 0 || index <= activeUserIndex) return;
    if (chat.messages.slice(activeUserIndex + 1, index)
      .some((message) => message.role === "user")) {
      return;
    }
    const isLatestAssistant = replacement.role === "assistant"
      && !chat.messages.slice(index + 1).some((message) =>
        message.role === "assistant" || message.role === "user");
    if (!isLatestAssistant) return;
    for (const part of replacement.parts) {
      if (typeof part.type === "string" && part.type.startsWith("data-")) {
        this.handleDataPart(active, part);
      }
    }
  }

  private reconcileServerHistory(): void {
    const chat = this.chat;
    const reconcile = this.options.reconcileHistory;
    if (!chat || !reconcile) {
      this.pendingHistoryReconcile = Promise.resolve();
      return;
    }
    const conversationId = this.boundConversationId;
    const active = this.active;
    const activeTurnIndex = active
      ? chat.messages.findIndex((message) =>
          message.role === "user" && message.id === active.turnId)
      : -1;
    const activeToken = active?.token ?? null;
    if (
      this.reconciledHistoryActiveToken === activeToken
      && this.reconciledHistoryTurnIndex === activeTurnIndex
      && (
        activeTurnIndex >= 0
        || this.reconciledHistorySource === chat.messages
      )
    ) {
      return;
    }
    const source = chat.messages;
    this.reconciledHistorySource = source;
    this.reconciledHistoryActiveToken = activeToken;
    this.reconciledHistoryTurnIndex = activeTurnIndex;
    const authoritativeMessages = activeTurnIndex >= 0
      ? chat.messages.slice(0, activeTurnIndex + 1)
      : chat.messages;
    const messages = durableServerHistory(authoritativeMessages, this.now());
    this.options.connection.recordLifecycle({
      code: "history_sync_started",
      phase: "persistence",
      ...(active ? { runId: active.runId } : {}),
    });
    const operation = reconcile(messages);
    this.pendingHistoryReconcile = operation;
    void operation.then(
      () => {
        if (this.boundConversationId !== conversationId) return;
        this.options.connection.recordLifecycle({
          code: "history_sync_completed",
          phase: "persistence",
          ...(active ? { runId: active.runId } : {}),
        });
      },
      () => undefined,
    );
    void operation.catch((error) => {
      if (this.boundConversationId !== conversationId) return;
      if (
        this.reconciledHistorySource === source
        && this.reconciledHistoryActiveToken === activeToken
        && this.reconciledHistoryTurnIndex === activeTurnIndex
      ) {
        // A later authoritative observation may retry a failed local cache
        // write, but synchronous duplicate triggers share this one attempt.
        this.reconciledHistorySource = null;
        this.reconciledHistoryActiveToken = null;
        this.reconciledHistoryTurnIndex = -2;
      }
      this.options.connection.recordLifecycle({
        code: "history_sync_failed",
        phase: "persistence",
        ...(active ? { runId: active.runId } : {}),
      });
      this.options.reportError?.(error);
      const currentActive = this.active;
      if (currentActive) {
        this.reportClientDiagnostic(currentActive, {
          severity: "error",
          code: "history_sync_failed",
          phase: "persistence",
        });
      }
    });
  }

  private handleConnectionClose(active: ActiveRun, event: CloseEvent): void {
    if (!this.isActive(active)) return;
    active.sawConnectionClose = true;
    if (event.code === 1008 || (event.code >= 4000 && event.code <= 4999)) {
      this.fail(active, {
        code: "session_interrupted",
        message: "The response was interrupted. Retry this message.",
        retryable: true,
      }, {
        severity: "error",
        code: "session_interrupted",
        phase: "session",
        retryable: true,
      });
      this.clearConversation();
      this.options.connection.disconnect();
      return;
    }
    active.statusPhase = "retrying";
    active.statusLabel = "Reconnecting";
    this.publish(active);
  }

  private handleConnectionOpen(active: ActiveRun): void {
    if (!this.isActive(active) || !active.sawConnectionClose) return;
    active.sawConnectionClose = false;
    active.reconnectPending = true;
    this.scheduleReconnect(active);
  }

  private findClientVaultToolPart(
    active: ActiveRun,
    toolCallId: string,
  ): ThinAgentToolUIPart | null {
    for (const message of currentTurnMessages(active.chat.messages, active.turnId)) {
      for (const part of message.parts) {
        if (!isClientVaultToolPart(part) || getToolCallId(part) !== toolCallId) continue;
        return part;
      }
    }
    return null;
  }

  private findToolCall(active: ActiveRun, toolCallId: string): ThinAgentLocalToolCall | null {
    const part = this.findClientVaultToolPart(active, toolCallId);
    return part
      ? {
          callId: toolCallId,
          name: getToolName(part),
          input: getToolInput(part),
        }
      : null;
  }

  private scheduleContinuationAttach(active: ActiveRun): void {
    if (!this.isActive(active)
      || !active.pendingContinuationAttach
      || active.chat.status !== "ready"
      || active.toolTasks.size > 0
      || active.continuationAttachTimer
      || active.continuationAttachTask
      || active.reconnectTask) {
      return;
    }
    this.recordLifecycle(active, {
      code: "response_resume_scheduled",
      phase: "response",
    });
    // The headless Chat lifecycle is intentionally independent of a DOM realm.
    // eslint-disable-next-line obsidianmd/prefer-window-timers
    active.continuationAttachTimer = setTimeout(() => {
      active.continuationAttachTimer = null;
      if (!this.isActive(active)
        || !active.pendingContinuationAttach
        || active.chat.status !== "ready"
        || active.toolTasks.size > 0
        || active.reconnectTask) {
        return;
      }
      active.pendingContinuationAttach = false;
      active.reconnectPending = false;
      active.transport.expectToolContinuation();
      this.recordLifecycle(active, {
        code: "response_resume_started",
        phase: "response",
      });
      const task = active.chat.resumeStream()
        .then(() => {
          this.recordLifecycle(active, {
            code: "response_resume_completed",
            phase: "response",
          });
        })
        .catch((error) => {
          this.recordLifecycle(active, {
            code: "response_resume_failed",
            phase: "response",
          });
          this.fail(active, asError(error, "response_resume_failed"));
        })
        .finally(() => {
          if (active.continuationAttachTask === task) active.continuationAttachTask = null;
          this.scheduleContinuationAttach(active);
          this.scheduleReconnect(active);
          this.tryFinalizeSuccess(active);
        });
      active.continuationAttachTask = task;
    }, 0);
  }

  /**
   * Mirrors Cloudflare useAgentChat's native client-tool frame exactly. Tool
   * schemas are intentionally absent because the server owns the catalog.
   */
  private sendNativeToolResult(input: Readonly<{
    toolCallId: string;
    toolName: string;
    output?: unknown;
    state: "output-available" | "output-error";
    errorText?: string;
  }>): void {
    this.options.connection.agentClient().send(JSON.stringify({
      type: MessageType.CF_AGENT_TOOL_RESULT,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      ...(input.output !== undefined ? { output: input.output } : {}),
      state: input.state,
      ...(input.errorText !== undefined ? { errorText: input.errorText } : {}),
    }));
  }

  private sendNativeToolApproval(toolCallId: string, approved: boolean): void {
    this.options.connection.agentClient().send(JSON.stringify({
      type: MessageType.CF_AGENT_TOOL_APPROVAL,
      toolCallId,
      approved,
    }));
  }

  private scheduleReconnect(active: ActiveRun): void {
    if (!this.isActive(active)
      || !active.reconnectPending
      || active.chat.status !== "ready"
      || active.reconnectTask
      || active.continuationAttachTask
      || active.continuationAttachTimer
      || active.pendingContinuationAttach) {
      return;
    }
    active.reconnectPending = false;
    if (active.transport.retryPendingResume()) return;
    const task = active.chat.resumeStream()
      .catch((error) => this.fail(active, asError(error, "response_resume_failed")))
      .finally(() => {
        if (active.reconnectTask === task) active.reconnectTask = null;
      });
    active.reconnectTask = task;
  }

  private tryFinalizeSuccess(active: ActiveRun): void {
    if (!this.isActive(active)
      || !active.pendingServerCompletion
      || active.chat.status !== "ready"
      || active.toolTasks.size > 0
      || active.continuationAttachTask
      || active.reconnectTask
      || active.pendingContinuationAttach) {
      return;
    }
    active.pendingServerCompletion = false;
    const snapshot = projectThinAgentChat(active);
    const unsettledVaultTool = snapshot.parts.some((part) =>
      part.kind === "tool"
      && part.location === "vault"
      && !["succeeded", "failed", "denied"].includes(part.state));
    if (unsettledVaultTool) {
      this.fail(active, {
        code: "response_finished_with_pending_vault_action",
        message: "The response finished before a vault action settled.",
        retryable: false,
      }, {
        severity: "error",
        code: "response_finished_with_pending_vault_action",
        phase: "response",
      });
      return;
    }
    const hasVisibleNarrative = snapshot.parts.some((part) =>
      part.kind === "text"
      && !part.id.startsWith("sources:")
      && part.markdown.trim().length > 0);
    if (!hasVisibleNarrative) {
      this.fail(active, {
        code: "response_missing_final_answer",
        message: "SystemSculpt did not return a final response. Retry this message.",
        retryable: true,
      }, {
        severity: "error",
        code: "response_missing_final_answer",
        phase: "response",
      });
      return;
    }
    const finalizationTask = (async () => {
      let assistantPersisted = false;
      try {
        const message = durableAssistant(snapshot, active.chat.messages, this.now());
        this.recordLifecycle(active, {
          code: "response_save_started",
          phase: "persistence",
        });
        await this.options.persistAssistant(message);
        assistantPersisted = true;
        this.recordLifecycle(active, {
          code: "response_save_completed",
          phase: "persistence",
        });
        active.persistedMessage = message;
        this.completedHistoryFloor = {
          conversationId: active.conversationId,
          messages: active.chat.messages,
        };
        this.finish(active, { kind: "completed" });
        try {
          await this.options.refreshCredits?.();
        } catch (error) {
          this.options.reportError?.(error);
        }
      } catch (error) {
        if (!assistantPersisted) {
          this.recordLifecycle(active, {
            code: "response_save_failed",
            phase: "persistence",
          });
        }
        this.fail(
          active,
          asError(error, "response_save_failed"),
          { severity: "error", code: "response_save_failed", phase: "persistence" },
        );
      }
    })();
    active.finalizationTask = finalizationTask;
    void finalizationTask.finally(() => {
      if (active.finalizationTask === finalizationTask) {
        active.finalizationTask = null;
      }
    });
  }

  private fail(
    active: ActiveRun,
    error: ManagedAgentError,
    diagnostic?: ClientDiagnostic,
  ): void {
    if (!this.isActive(active) || active.terminalOutcome) return;
    if (diagnostic) {
      const incidentId = error.requestId
        && CLIENT_DIAGNOSTIC_INCIDENT_ID.test(error.requestId)
        ? error.requestId
        : undefined;
      this.reportClientDiagnostic(active, {
        ...diagnostic,
        ...(incidentId ? { incidentId } : {}),
      });
    }
    active.abort.abort();
    this.options.reportError?.(error);
    this.finish(active, { kind: "failed", error });
  }

  private finish(active: ActiveRun, outcome: ThinAgentTerminalOutcome): void {
    if (!this.isActive(active) || active.terminalOutcome) return;
    active.terminalOutcome = outcome;
    if (outcome.kind !== "completed") {
      active.transport.cancelPendingResume();
      active.transport.abortActiveToolContinuation();
      void this.stopChat(active);
    }
    this.publish(active);
    this.recordLifecycle(active, {
      code: outcome.kind === "completed"
        ? "run_finished_completed"
        : outcome.kind === "cancelled"
          ? "run_finished_cancelled"
          : "run_finished_failed",
      phase: "response",
      ...(outcome.kind === "failed"
        ? {
            retryable: outcome.error.retryable,
            incidentId: outcome.error.requestId,
          }
        : {}),
    }, "run-finished");
    active.resolveTerminal();
    if (active.origin === "recovered") {
      queueMicrotask(() => {
        // eslint-disable-next-line obsidianmd/prefer-window-timers
        if (active.continuationAttachTimer) clearTimeout(active.continuationAttachTimer);
        if (this.active?.token === active.token) this.active = null;
      });
    }
  }

  private stopChat(active: ActiveRun): Promise<void> {
    if (active.stopTask) return active.stopTask;
    const task = active.chat.stop().finally(() => {
      if (active.stopTask === task) active.stopTask = null;
    });
    active.stopTask = task;
    return task;
  }

  private withPublicationBatch<T>(_active: ActiveRun, operation: () => T): T {
    this.publicationBatchDepth += 1;
    try {
      return operation();
    } finally {
      this.publicationBatchDepth -= 1;
      if (this.publicationBatchDepth === 0) {
        const pending = this.batchedPublication;
        this.batchedPublication = null;
        if (pending) this.publishNow(pending);
      }
    }
  }

  private publish(active: ActiveRun): void {
    if (!this.isActive(active)) return;
    if (this.publicationBatchDepth > 0) {
      this.batchedPublication = active;
      return;
    }
    this.publishNow(active);
  }

  private publishNow(active: ActiveRun): void {
    if (!this.isActive(active)) return;
    if (active.lastLifecyclePhase !== active.statusPhase) {
      active.lastLifecyclePhase = active.statusPhase;
      this.recordLifecycle(active, {
        code: `phase_${active.statusPhase}`,
        phase: "response",
      });
    }
    this.currentSnapshot = projectThinAgentChat(active);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentSnapshot);
      } catch (error) {
        this.listeners.delete(listener);
        this.fail(active, {
          code: "response_display_failed",
          message: error instanceof Error
            ? userSafeServiceMessage(
                error.message,
                "SystemSculpt could not display the response.",
              )
            : "SystemSculpt could not display the response.",
          retryable: false,
        }, {
          severity: "error",
          code: "response_display_failed",
          phase: "render",
        });
        return;
      }
    }
  }

  private isActive(active: ActiveRun): boolean {
    return this.active?.token === active.token;
  }

  private recordLifecycle(
    active: ActiveRun,
    input: Omit<ThinAgentLifecycleInput, "runId">,
    onceKey?: string,
  ): void {
    if (onceKey) {
      if (active.lifecycleKeys.has(onceKey)) return;
      active.lifecycleKeys.add(onceKey);
    }
    this.options.connection.recordLifecycle({
      ...input,
      runId: active.runId,
    });
  }

  private reportClientDiagnostic(active: ActiveRun, diagnostic: ClientDiagnostic): void {
    const code = /^[a-z0-9_.:-]{1,80}$/.test(diagnostic.code)
      ? diagnostic.code
      : "client_failure";
    const toolName = diagnostic.toolName
      && /^[A-Za-z0-9_.:-]{1,64}$/.test(diagnostic.toolName)
      ? diagnostic.toolName
      : undefined;
    const toolCallId = diagnostic.toolCallId?.slice(0, 160);
    const runId = active.runId.slice(0, 160);
    const status = Number.isInteger(diagnostic.status)
      && diagnostic.status! >= 100
      && diagnostic.status! <= 599
      ? diagnostic.status
      : undefined;
    const incidentId = diagnostic.incidentId
      && CLIENT_DIAGNOSTIC_INCIDENT_ID.test(diagnostic.incidentId)
      ? diagnostic.incidentId
      : undefined;
    const key = [
      diagnostic.severity,
      code,
      diagnostic.phase,
      toolName,
      toolCallId,
      status,
      incidentId,
    ].join("\0");
    if (active.reportedDiagnostics.has(key)) return;
    active.reportedDiagnostics.add(key);
    try {
      this.options.connection.agentClient().send(JSON.stringify({
        type: CLIENT_DIAGNOSTIC_TYPE,
        payload: {
          version: 1,
          severity: diagnostic.severity,
          code,
          phase: diagnostic.phase,
          run_id: runId,
          ...(toolName ? { tool_name: toolName } : {}),
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
          ...(status ? { status } : {}),
          ...(typeof diagnostic.retryable === "boolean"
            ? { retryable: diagnostic.retryable }
            : {}),
          ...(incidentId ? { incident_id: incidentId } : {}),
        },
      }));
    } catch {
      // Diagnostics are best effort and must never change or recurse into turn behavior.
    }
  }

}
