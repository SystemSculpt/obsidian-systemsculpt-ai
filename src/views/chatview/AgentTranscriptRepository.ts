import type { ChatMessage } from "../../types";
import type { ToolCall } from "../../types/toolCalls";
import { ChatStorageService } from "./ChatStorageService";
import { ChatIdAllocator } from "./persistence/ChatIdAllocator";
import {
  parseAgentConversationId,
  type ChatApprovalMode,
} from "./storage/ChatPersistenceTypes";

export type AgentTranscriptSaveOptions = Readonly<{
  contextFiles?: Set<string>;
  title?: string;
  chatFontSize?: "small" | "medium" | "large";
  approvalMode?: ChatApprovalMode;
  agentConversationId?: string;
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
  agentConversationId?: string;
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

function normalizeProjectedServerTimestamps(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((tool) => ({ ...tool, timestamp: 0 })),
    } : {}),
    ...(message.messageParts ? {
      messageParts: message.messageParts.map((part) =>
        part.type === "tool_call"
          ? { ...part, timestamp: 0, data: { ...part.data, timestamp: 0 } }
          : { ...part, timestamp: 0 }),
    } : {}),
  };
}

function isSameProjectedServerHistory(
  left: readonly ChatMessage[],
  right: readonly ChatMessage[],
): boolean {
  return JSON.stringify(left.map(normalizeProjectedServerTimestamps))
    === JSON.stringify(right.map(normalizeProjectedServerTimestamps));
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

/**
 * Sole owner of durable chat messages. Every accepted mutation completes its
 * vault write before exposing the next snapshot, eliminating DOM/state/rollback
 * ownership races from the former monolithic workspace stack.
 */
export class AgentTranscriptRepository {
  private chatId = "";
  private title = "New chat";
  private version = 0;
  private agentConversationId: string | undefined;
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
      ...(this.agentConversationId ? { agentConversationId: this.agentConversationId } : {}),
      messages: Object.freeze(cloneMessages(this.messages)),
    });
  }

  public subscribeToCommits(listener: (commit: AgentTranscriptCommit) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  public load(chatId: string): Promise<AgentLoadedTranscript | null> {
    const generation = this.generation;
    return this.serializeForGeneration(generation, async () => {
      const loaded = await this.storage.loadChat(chatId);
      if (!loaded) return null;
      this.assertGeneration(
        generation,
        "The active chat changed while loading the transcript.",
      );
      this.chatId = loaded.id;
      this.title = loaded.title || "New chat";
      this.version = loaded.version || 0;
      this.messages = reconcileInterruptedTools(loaded.messages || []);
      this.agentConversationId = parseAgentConversationId(loaded.agentConversationId);
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
    this.agentConversationId = undefined;
    this.messages = [];
    this.generation += 1;
    return this.snapshot();
  }

  public setTitle(title: string): void {
    this.title = title.trim() || "New chat";
  }

  public commitUser(
    input: AgentUserCommitInput,
    agentConversationId?: string,
  ): Promise<AgentTranscriptSnapshot> {
    const generation = this.generation;
    return this.serializeForGeneration(generation, async () => {
      const message = cloneMessage(input.message);
      if (message.role !== "user") throw new Error("Agent transcript accepts only user messages through commitUser().");
      const existingIndex = this.messages.findIndex((candidate) => candidate.message_id === message.message_id);
      if (existingIndex >= 0) return this.snapshot();

      const next = input.kind === "append"
        ? [...this.messages, message]
        : this.resendMessages(input, message);
      const normalizedConversationId = agentConversationId
        ? parseAgentConversationId(agentConversationId)
        : undefined;
      if (agentConversationId && !normalizedConversationId) {
        throw new Error("Invalid agent conversation identifier.");
      }
      const previousConversationId = this.agentConversationId;
      if (normalizedConversationId) this.agentConversationId = normalizedConversationId;
      try {
        await this.persist(next, true, generation);
      } catch (error) {
        if (generation === this.generation) {
          this.agentConversationId = previousConversationId;
        }
        throw error;
      }
      const snapshot = this.snapshot();
      this.emitCommit({ snapshot, role: "user", messageId: message.message_id });
      return snapshot;
    });
  }

  public persistAssistant(message: ChatMessage): Promise<AgentTranscriptSnapshot> {
    const generation = this.generation;
    return this.serializeForGeneration(generation, async () => {
      const incoming = cloneMessage(message);
      const next = this.nextAssistantMessages(incoming);
      await this.persist(next, false, generation);
      const snapshot = this.snapshot();
      this.emitCommit({ snapshot, role: "assistant", messageId: incoming.message_id });
      return snapshot;
    });
  }

  public reconcileServerHistory(
    messages: readonly ChatMessage[],
  ): Promise<AgentTranscriptSnapshot> {
    const generation = this.generation;
    return this.serializeForGeneration(generation, async () => {
      const incoming = cloneMessages(messages);
      const ids = incoming.map((message) => message.message_id);
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw new Error("The server returned invalid or duplicate chat message identifiers.");
      }
      const localById = new Map(this.messages.map((message) => [message.message_id, message]));
      const next = incoming.map((message) => {
        const local = localById.get(message.message_id);
        if (message.role !== "user"
          || local?.role !== "user"
          || !local.attachmentMetadata?.length) {
          return message;
        }
        return {
          ...message,
          attachmentMetadata: cloneJson(local.attachmentMetadata),
        };
      });
      // ThinAgentProjection derives assistant part/tool timestamps from the
      // local observation clock. They preserve ordering but are not a server
      // history revision, so a reconnect must not rewrite an otherwise
      // identical transcript. Array order and every other field remain part
      // of the durable equality check.
      if (isSameProjectedServerHistory(next, this.messages)) return this.snapshot();
      await this.persist(
        next,
        true,
        generation,
        "authoritative-server-history",
      );
      return this.snapshot();
    });
  }

  public saveMetadata(): Promise<AgentTranscriptSnapshot> {
    const generation = this.generation;
    return this.serializeForGeneration(generation, async () => {
      if (!this.chatId) return this.snapshot();
      const saved = await this.storage.saveChat(
        this.chatId,
        cloneMessages(this.messages),
        this.options(),
      );
      this.assertGeneration(
        generation,
        "The active chat changed while saving the transcript.",
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
    generation: number,
    source: "local" | "authoritative-server-history" = "local",
  ): Promise<void> {
    if (!this.chatId) {
      if (!allowAllocate) throw new Error("An assistant response cannot precede a durable user turn.");
      const allocator = new ChatIdAllocator(async (candidateId) => {
        const created = await this.storage.createChatExclusive(
          candidateId,
          cloneMessages(next),
          this.options(),
        );
        return created;
      });
      const allocated = await allocator.allocate();
      this.assertGeneration(
        generation,
        "The active chat changed while creating the transcript.",
      );
      this.chatId = allocated.chatId;
      this.version = allocated.value.version;
      this.messages = next;
      return;
    }
    const saved = await this.storage.saveChat(
      this.chatId,
      cloneMessages(next),
      {
        ...this.options(),
        ...(source === "authoritative-server-history"
          ? { authoritativeServerHistoryReconciliation: true }
          : {}),
      },
    );
    this.assertGeneration(
      generation,
      "The active chat changed while saving the transcript.",
    );
    this.version = saved.version;
    this.messages = next;
  }

  private options(): AgentTranscriptSaveOptions {
    return {
      ...this.getSaveOptions(),
      title: this.title,
      ...(this.agentConversationId ? { agentConversationId: this.agentConversationId } : {}),
    };
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

  private serializeForGeneration<T>(
    generation: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      this.assertGeneration(
        generation,
        "The active chat changed before the transcript operation began.",
      );
      return operation();
    });
  }

  private assertGeneration(generation: number, message: string): void {
    if (generation !== this.generation) {
      throw new AgentTranscriptConflictError(message);
    }
  }
}
