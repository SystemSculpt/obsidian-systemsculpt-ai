import type { ChatMessage } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import type { ManagedChatSessionBudgetState } from "../../services/managed/ManagedTypes";
import { ChatStorageService } from "./ChatStorageService";
import { ChatIdAllocator } from "./persistence/ChatIdAllocator";
import {
  parseManagedChatSessionBinding,
  type ManagedChatSessionBinding,
  type ChatApprovalMode,
  type ChatBackend,
} from "./storage/ChatPersistenceTypes";
import type { ManagedChatSessionCheckpoint } from "./turn/ManagedChatRuntimeAdapter";

export type AgentTranscriptSaveOptions = Readonly<{
  contextFiles?: Set<string>;
  title?: string;
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  managedSession?: ManagedChatSessionBinding;
}>;

export type AgentUserCommitInput =
  | Readonly<{ kind: "append"; message: ChatMessage }>
  | Readonly<{
      kind: "resend";
      message: ChatMessage;
      targetMessageId: string;
      expectedIndex: number;
      expectedVersion: number;
    }>;

export type AgentTranscriptSnapshot = Readonly<{
  chatId: string;
  title: string;
  version: number;
  backend: ChatBackend;
  managedSession?: ManagedChatSessionBinding;
  messages: readonly Readonly<ChatMessage>[];
}>;

export type AgentLoadedTranscript = AgentTranscriptSnapshot & Readonly<{
  contextFiles: readonly string[];
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
}>;

export type AgentTranscriptCommit = Readonly<{
  snapshot: AgentTranscriptSnapshot;
  role: "user" | "assistant";
  messageId: string;
}>;

export class AgentTranscriptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTranscriptConflictError";
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneMessage<T extends ChatMessage>(message: T): T {
  return cloneJson(message);
}

function cloneMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map(cloneMessage);
}

function reconcileInterruptedTools(messages: readonly ChatMessage[]): ChatMessage[] {
  return cloneMessages(messages).map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.some((tool) => tool.state === "executing")) return message;
    const replacements = new Map(message.tool_calls.map((tool) => {
      const replacement = tool.state === "executing"
        ? {
            ...tool,
            state: "failed" as const,
            result: {
              success: false,
              error: {
                code: "TOOL_OUTCOME_UNKNOWN_AFTER_RESTART",
                message: "SystemSculpt restarted before this action recorded its outcome. Check the vault before retrying.",
              },
            },
          }
        : tool;
      return [tool.id, replacement] as const;
    }));
    return {
      ...message,
      tool_calls: [...replacements.values()],
      ...(message.messageParts ? {
        messageParts: message.messageParts.map((part) => {
          if (part.type !== "tool_call" || !part.data || typeof part.data !== "object") return part;
          const replacement = replacements.get((part.data as ToolCall).id);
          return replacement ? { ...part, data: replacement } : part;
        }),
      } : {}),
    };
  });
}

function mergeToolCalls(previous: readonly ToolCall[] = [], incoming: readonly ToolCall[] = []): ToolCall[] | undefined {
  const calls = new Map<string, ToolCall>();
  for (const call of previous) calls.set(call.id, cloneJson(call));
  for (const call of incoming) {
    const prior = calls.get(call.id);
    const next = cloneJson(call);
    if (prior?.result && !next.result) next.result = prior.result;
    calls.set(call.id, next);
  }
  return calls.size > 0 ? [...calls.values()] : undefined;
}

function isTrustedLoadedSession(
  session: ManagedChatSessionBinding | undefined,
  chatId: string,
  messages: readonly ChatMessage[],
): session is ManagedChatSessionBinding {
  if (!session || session.boundChatId !== chatId) return false;
  const visible = messages.filter((message) => message.role !== "system");
  const checkpoint = visible[visible.length - 1];
  return checkpoint?.role === "assistant"
    && checkpoint.message_id === session.checkpointMessageId
    && !checkpoint.tool_calls?.length;
}

/**
 * Sole owner of durable chat messages. Every accepted mutation completes its
 * vault write before exposing the next snapshot, eliminating DOM/state/rollback
 * ownership races from the previous ChatView stack.
 */
export class AgentTranscriptRepository {
  private chatId = "";
  private title = "New chat";
  private version = 0;
  private backend: ChatBackend = "systemsculpt";
  private managedSession: ManagedChatSessionBinding | undefined;
  private messages: ChatMessage[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private readonly commitListeners = new Set<(commit: AgentTranscriptCommit) => void>();

  constructor(
    private readonly storage: ChatStorageService,
    private readonly getSaveOptions: () => AgentTranscriptSaveOptions,
  ) {}

  public snapshot(): AgentTranscriptSnapshot {
    return Object.freeze({
      chatId: this.chatId,
      title: this.title,
      version: this.version,
      backend: this.backend,
      ...(this.managedSession ? { managedSession: { ...this.managedSession } } : {}),
      messages: Object.freeze(cloneMessages(this.messages)),
    });
  }

  public subscribeToCommits(listener: (commit: AgentTranscriptCommit) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  public async load(chatId: string): Promise<AgentLoadedTranscript | null> {
    return this.serialize(async () => {
      const loaded = await this.storage.loadChat(chatId);
      if (!loaded) return null;
      this.chatId = loaded.id;
      this.title = loaded.title || "New chat";
      this.version = loaded.version || 0;
      this.backend = loaded.chatBackend;
      this.messages = loaded.chatBackend === "systemsculpt"
        ? reconcileInterruptedTools(loaded.messages || [])
        : cloneMessages(loaded.messages || []);
      const restoredSession = parseManagedChatSessionBinding(loaded.managedSession, loaded.id);
      this.managedSession = isTrustedLoadedSession(restoredSession, loaded.id, this.messages)
        ? restoredSession
        : undefined;
      if (loaded.managedSession && !this.managedSession && this.backend === "systemsculpt") {
        const saved = await this.storage.saveChat(
          loaded.id,
          cloneMessages(this.messages),
          this.options(undefined),
        );
        this.version = saved.version;
      }
      this.generation += 1;
      return Object.freeze({
        ...this.snapshot(),
        contextFiles: Object.freeze([...(loaded.context_files || [])]),
        ...(loaded.chatFontSize ? { chatFontSize: loaded.chatFontSize } : {}),
        approvalMode: loaded.approvalMode === "full-access" ? "full-access" : "ask",
      });
    });
  }

  public reset(input: Readonly<{ title?: string }> = {}): AgentTranscriptSnapshot {
    this.chatId = "";
    this.title = input.title?.trim() || "New chat";
    this.version = 0;
    this.backend = "systemsculpt";
    this.managedSession = undefined;
    this.messages = [];
    this.generation += 1;
    return this.snapshot();
  }

  public setTitle(title: string): void {
    this.title = title.trim() || "New chat";
  }

  public commitUser(input: AgentUserCommitInput): Promise<AgentTranscriptSnapshot> {
    return this.serialize(async () => {
      this.assertWritable();
      const message = cloneMessage(input.message);
      if (message.role !== "user") throw new Error("Agent transcript accepts only user messages through commitUser().");
      const existingIndex = this.messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (existingIndex >= 0) return this.snapshot();

      const next = input.kind === "append"
        ? [...this.messages, message]
        : this.resendMessages(input, message);
      await this.persist(next, true, input.kind === "resend" ? undefined : this.managedSession);
      const snapshot = this.snapshot();
      this.emitCommit({ snapshot, role: "user", messageId: message.message_id });
      return snapshot;
    });
  }

  public persistAssistant(message: ChatMessage): Promise<AgentTranscriptSnapshot> {
    return this.serialize(async () => {
      this.assertWritable();
      const incoming = cloneMessage(message);
      const next = this.nextAssistantMessages(incoming);
      await this.persist(next, false, this.managedSession);
      const snapshot = this.snapshot();
      this.emitCommit({ snapshot, role: "assistant", messageId: incoming.message_id });
      return snapshot;
    });
  }

  public persistAssistantWithSession(
    message: ChatMessage,
    checkpoint: ManagedChatSessionCheckpoint,
    toolsetFingerprint: string,
    budget: ManagedChatSessionBudgetState,
  ): Promise<AgentTranscriptSnapshot> {
    return this.serialize(async () => {
      this.assertWritable();
      if (!this.chatId) throw new Error("A managed session cannot precede a durable user turn.");
      const incoming = cloneMessage(message);
      const next = this.nextAssistantMessages(incoming);
      const candidate = parseManagedChatSessionBinding({
        ...checkpoint,
        boundChatId: this.chatId,
        checkpointMessageId: incoming.message_id,
        toolsetFingerprint,
        budget,
      }, this.chatId);
      if (!candidate) throw new Error("SystemSculpt returned an invalid managed session checkpoint.");
      const transitionValid = this.managedSession
        ? candidate.id === this.managedSession.id
          && candidate.revision === this.managedSession.revision + 1
        : candidate.revision === 1;
      if (!transitionValid) throw new Error("SystemSculpt returned a non-sequential managed session checkpoint.");
      await this.persist(next, false, candidate);
      const snapshot = this.snapshot();
      this.emitCommit({ snapshot, role: "assistant", messageId: incoming.message_id });
      return snapshot;
    });
  }

  public clearManagedSession(): Promise<AgentTranscriptSnapshot> {
    return this.serialize(async () => {
      if (!this.managedSession) return this.snapshot();
      this.managedSession = undefined;
      if (!this.chatId || this.backend === "legacy") return this.snapshot();
      const saved = await this.storage.saveChat(
        this.chatId,
        cloneMessages(this.messages),
        this.options(undefined),
      );
      this.version = saved.version;
      return this.snapshot();
    });
  }

  public saveMetadata(): Promise<AgentTranscriptSnapshot> {
    return this.serialize(async () => {
      if (!this.chatId || this.backend === "legacy") return this.snapshot();
      const saved = await this.storage.saveChat(
        this.chatId,
        cloneMessages(this.messages),
        this.options(this.managedSession),
      );
      this.version = saved.version;
      return this.snapshot();
    });
  }

  public idle(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  private resendMessages(input: Extract<AgentUserCommitInput, { kind: "resend" }>, message: ChatMessage): ChatMessage[] {
    if (input.expectedVersion !== this.version) {
      throw new AgentTranscriptConflictError("The chat changed before retrying this message.");
    }
    const actualIndex = this.messages.findIndex((candidate) => candidate.message_id === input.targetMessageId);
    if (actualIndex !== input.expectedIndex || actualIndex < 0) {
      throw new AgentTranscriptConflictError("The retry target no longer matches the durable transcript.");
    }
    if (this.messages[actualIndex].role !== "user") {
      throw new AgentTranscriptConflictError("Only a user turn can be retried.");
    }
    return [...this.messages.slice(0, actualIndex), message];
  }

  private nextAssistantMessages(incoming: ChatMessage): ChatMessage[] {
    if (incoming.role !== "assistant") {
      throw new Error("Agent transcript accepts only assistant messages through assistant persistence.");
    }
    const index = this.messages.findIndex((candidate) => candidate.message_id === incoming.message_id);
    const next = [...this.messages];
    if (index < 0) {
      next.push(incoming);
    } else {
      const previous = next[index];
      next[index] = {
        ...previous,
        ...incoming,
        tool_calls: mergeToolCalls(previous.tool_calls, incoming.tool_calls),
      };
    }
    return next;
  }

  private async persist(
    next: ChatMessage[],
    allowAllocate: boolean,
    nextSession: ManagedChatSessionBinding | undefined,
  ): Promise<void> {
    const generation = this.generation;
    if (!this.chatId) {
      if (!allowAllocate) throw new Error("An assistant response cannot precede a durable user turn.");
      const allocator = new ChatIdAllocator(async (candidateId) => {
        const created = await this.storage.createChatExclusive(
          candidateId,
          cloneMessages(next),
          this.options(nextSession),
        );
        return created;
      });
      const allocated = await allocator.allocate();
      if (generation !== this.generation) throw new AgentTranscriptConflictError("The active chat changed while creating the transcript.");
      this.chatId = allocated.chatId;
      this.version = allocated.value.version;
      this.managedSession = nextSession;
      this.messages = next;
      return;
    }
    const saved = await this.storage.saveChat(
      this.chatId,
      cloneMessages(next),
      this.options(nextSession),
    );
    if (generation !== this.generation) throw new AgentTranscriptConflictError("The active chat changed while saving the transcript.");
    this.version = saved.version;
    this.managedSession = nextSession;
    this.messages = next;
  }

  private options(managedSession: ManagedChatSessionBinding | undefined): AgentTranscriptSaveOptions {
    return {
      ...this.getSaveOptions(),
      title: this.title,
      ...(managedSession ? { managedSession } : {}),
    };
  }

  private assertWritable(): void {
    if (this.backend === "legacy") throw new Error("Legacy chats are read-only.");
  }

  private emitCommit(commit: AgentTranscriptCommit): void {
    for (const listener of this.commitListeners) {
      try { listener(commit); }
      catch { /* A UI observer cannot roll back a completed vault write. */ }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
