import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import { ChatIdAllocationError, ChatIdAllocator } from "../persistence/ChatIdAllocator";
import { ChatPersistenceError } from "../persistence/ChatPersistenceError";
import type { ChatTranscriptStorage } from "./ChatTranscriptStorage";
import type {
  AcceptedUserTranscriptInput,
  AcceptedUserTranscriptResult,
  ChatTranscriptBranch,
  ChatTranscriptCandidate,
  ChatTranscriptSnapshot,
  StoredChatTranscript,
} from "./ChatTranscriptTypes";

function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  const existing = seen.get(value as object);
  if (existing) return existing as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) clone.push(deepClone(entry, seen));
    return clone as T;
  }
  const clone = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value as object, clone);
  for (const key of Reflect.ownKeys(value as object)) {
    clone[key] = deepClone((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return clone as T;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function immutableMessages(messages: readonly ChatMessage[]): readonly Readonly<ChatMessage>[] {
  return deepFreeze(deepClone(messages)) as readonly Readonly<ChatMessage>[];
}

function snapshot(
  chatId: string,
  version: number,
  messages: readonly ChatMessage[],
  readOnly: boolean = false,
): ChatTranscriptSnapshot {
  const accepted = { chatId, version, messages: immutableMessages(messages) } as {
    chatId: string;
    version: number;
    messages: readonly Readonly<ChatMessage>[];
    readOnly?: true;
  };
  if (readOnly) accepted.readOnly = true;
  return Object.freeze(accepted);
}

function mergeToolCalls(existing: readonly ToolCall[] = [], next: readonly ToolCall[] = []): ToolCall[] | undefined {
  if (existing.length === 0 && next.length === 0) return undefined;
  const merged = new Map(existing.map((toolCall) => [toolCall.id, { ...toolCall }]));
  for (const toolCall of next) {
    const previous = merged.get(toolCall.id);
    merged.set(toolCall.id, {
      ...previous,
      ...toolCall,
      result: toolCall.result || previous?.result,
    });
  }
  return Array.from(merged.values());
}

function upsert(messages: readonly Readonly<ChatMessage>[], next: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((entry) => entry.message_id === next.message_id);
  if (index < 0) return [...messages, next] as ChatMessage[];
  const existing = messages[index] as ChatMessage;
  const merged: ChatMessage = {
    ...existing,
    ...next,
    content: next.content !== undefined ? next.content : existing.content,
    reasoning: next.reasoning || existing.reasoning,
    annotations: next.annotations || existing.annotations,
    tool_calls: mergeToolCalls(existing.tool_calls || [], next.tool_calls || []),
    messageParts: next.messageParts || existing.messageParts,
    reasoning_details: (next as any).reasoning_details || (existing as any).reasoning_details,
  };
  const candidate = [...messages] as ChatMessage[];
  candidate[index] = merged;
  return candidate;
}

export class ChatTranscriptReadOnlyError extends Error {
  public readonly code = "chat_transcript_read_only" as const;

  constructor(public readonly chatId: string) {
    super(`Transcript ${chatId || "(new chat)"} is read-only`);
    this.name = "ChatTranscriptReadOnlyError";
  }
}

export class ChatTranscriptStaleTransitionError extends Error {
  public readonly code = "chat_transcript_stale_transition" as const;

  constructor(
    public readonly baseRevision: number,
    public readonly currentRevision: number,
  ) {
    super(`Transcript transition was built from stale revision ${baseRevision}; current revision is ${currentRevision}`);
    this.name = "ChatTranscriptStaleTransitionError";
  }
}

type TransitionQueueEntry = {
  run: () => Promise<ChatTranscriptSnapshot>;
  resolve: (snapshot: ChatTranscriptSnapshot) => void;
  reject: (cause: unknown) => void;
};

export class ChatTranscript {
  private current: ChatTranscriptSnapshot;
  private revision = 0;
  private transitionRunning = false;
  private readonly transitionQueue: TransitionQueueEntry[] = [];
  private readonly candidateBases = new WeakMap<object, { snapshot: ChatTranscriptSnapshot; revision: number }>();
  private readonly committedCandidates = new WeakMap<object, ChatTranscriptSnapshot>();
  private readonly inFlightCandidates = new WeakMap<object, Promise<ChatTranscriptSnapshot>>();
  private inFlightRecovery: Promise<ChatTranscriptSnapshot> | null = null;
  private readonly inFlightBranches = new Map<number, {
    base: ChatTranscriptSnapshot;
    promise: Promise<ChatTranscriptSnapshot>;
  }>();

  private constructor(
    private readonly storage: ChatTranscriptStorage,
    initial: ChatTranscriptSnapshot,
    private readonly now: () => Date,
  ) {
    this.current = initial;
  }

  public static fromSnapshot(
    storage: ChatTranscriptStorage,
    initial: StoredChatTranscript,
    now: () => Date = () => new Date(),
  ): ChatTranscript {
    return new ChatTranscript(
      storage,
      snapshot(initial.chatId, initial.version, initial.messages, initial.readOnly === true),
      now,
    );
  }

  public static loadStored(
    storage: ChatTranscriptStorage,
    loaded: StoredChatTranscript,
    now: () => Date = () => new Date(),
  ): ChatTranscript {
    return new ChatTranscript(
      storage,
      snapshot(loaded.chatId, loaded.version, loaded.messages, loaded.readOnly === true),
      now,
    );
  }

  public static async load(
    storage: ChatTranscriptStorage,
    chatId: string,
    now: () => Date = () => new Date(),
  ): Promise<ChatTranscript> {
    if (!chatId) return new ChatTranscript(storage, snapshot("", 0, []), now);
    try {
      const loaded = await storage.load(chatId);
      return new ChatTranscript(
        storage,
        loaded
          ? snapshot(loaded.chatId, loaded.version, loaded.messages, loaded.readOnly === true)
          : snapshot(chatId, 0, []),
        now,
      );
    } catch (cause) {
      throw new ChatPersistenceError({ operation: "flush", chatId, cause });
    }
  }

  public snapshot(): ChatTranscriptSnapshot {
    return this.current;
  }

  public mutableMessages(): ChatMessage[] {
    return deepClone(this.current.messages) as ChatMessage[];
  }

  public clear(): ChatTranscriptSnapshot {
    return this.replaceProjection("", 0, []);
  }

  public teardown(): ChatTranscriptSnapshot {
    return this.replaceProjection("", 0, []);
  }

  public acceptAuthoritativePiProjection(messages: readonly ChatMessage[]): ChatTranscriptSnapshot {
    this.assertWritable();
    return this.replaceProjection(this.current.chatId, this.current.version, messages);
  }

  public commitPiReplacement(
    messages: readonly ChatMessage[],
    persist: (messages: readonly ChatMessage[]) => Promise<{ chatId?: string; version: number }>,
  ): Promise<ChatTranscriptSnapshot> {
    return this.commitPersistedProjection("pi_sync", messages, persist);
  }

  public commitPiFork(
    messageId: string,
    persist: (messages: readonly ChatMessage[]) => Promise<{ chatId?: string; version: number }>,
  ): Promise<ChatTranscriptSnapshot> {
    const index = this.current.messages.findIndex(
      (message) => message.message_id === messageId && message.role === "user",
    );
    if (index < 0) return Promise.reject(new Error("Pi could not resolve the chat message selected for forking."));
    return this.commitPersistedProjection(
      "pi_fork",
      this.current.messages.slice(0, index) as readonly ChatMessage[],
      persist,
    );
  }

  private commitPersistedProjection(
    operation: "pi_sync" | "pi_fork",
    messages: readonly ChatMessage[],
    persist: (messages: readonly ChatMessage[]) => Promise<{ chatId?: string; version: number }>,
  ): Promise<ChatTranscriptSnapshot> {
    const base = this.current;
    const baseRevision = this.revision;
    return this.serializeTransition(async () => {
      this.assertWritable();
      this.assertCurrentBase(operation, baseRevision, { snapshot: base, revision: baseRevision });
      try {
        const saved = await persist(deepClone(messages));
        this.current = snapshot(saved.chatId || base.chatId, saved.version, messages);
        this.revision += 1;
        return this.current;
      } catch (cause) {
        if (cause instanceof ChatPersistenceError) throw cause;
        throw new ChatPersistenceError({ operation, chatId: base.chatId, cause });
      }
    });
  }

  public previewAssistant(message: ChatMessage): ChatTranscriptSnapshot {
    this.assertWritable();
    return this.replaceProjection(this.current.chatId, this.current.version, upsert(this.current.messages, message));
  }

  private replaceProjection(
    chatId: string,
    version: number,
    messages: readonly ChatMessage[],
  ): ChatTranscriptSnapshot {
    this.current = snapshot(chatId, version, messages);
    this.revision += 1;
    return this.current;
  }

  public candidateDeleteMessage(messageId: string): ChatTranscriptCandidate {
    return this.createCandidate(
      "history_delete",
      this.current.messages.filter((message) => message.message_id !== messageId) as ChatMessage[],
    );
  }

  public commitAcceptedUser(input: AcceptedUserTranscriptInput): Promise<AcceptedUserTranscriptResult> {
    const base = this.current;
    const baseRevision = this.revision;
    return this.serializeTransition(async () => {
      this.assertWritable();
      const operation = input.kind === "resend" ? "resend_user_commit" : "user_commit";
      this.assertCurrentBase(operation, baseRevision, { snapshot: base, revision: baseRevision });
      let messages: readonly ChatMessage[];
      if (input.kind === "resend") {
        const target = base.messages[input.expectedIndex];
        if (base.version !== input.expectedVersion || !target || target.role !== "user" || target.message_id !== input.targetMessageId) {
          throw new ChatPersistenceError({ operation, chatId: base.chatId, cause: new ChatTranscriptStaleTransitionError(baseRevision, this.revision) });
        }
        messages = [...base.messages.slice(0, input.expectedIndex), input.message] as ChatMessage[];
      } else {
        messages = base.messages.some((entry) => entry.message_id === input.message.message_id)
          ? [...base.messages] as ChatMessage[] : [...base.messages, input.message] as ChatMessage[];
      }
      return (await this.persistAcceptedUser(operation, messages)).snapshot;
    }).then((committed) => {
      const message = committed.messages.find((entry) => entry.message_id === input.message.message_id && entry.role === "user");
      if (!message) throw new ChatPersistenceError({ operation: input.kind === "resend" ? "resend_user_commit" : "user_commit", chatId: committed.chatId, cause: new Error("Committed user message is absent from authoritative snapshot") });
      return Object.freeze({ snapshot: committed, message });
    });
  }

  private async persistAcceptedUser(operation: "user_commit" | "resend_user_commit", messages: readonly ChatMessage[]): Promise<AcceptedUserTranscriptResult> {
    let chatId = this.current.chatId;
    let version: number;
    try {
      const storageMessages = deepClone(messages) as readonly ChatMessage[];
      if (chatId) ({ version } = await this.storage.save(chatId, storageMessages));
      else {
        const allocated = await new ChatIdAllocator((candidateId) => this.storage.createExclusive(candidateId, storageMessages), this.now).allocate();
        chatId = allocated.chatId;
        version = allocated.value.version;
      }
    } catch (cause) {
      const allocationError = cause instanceof ChatIdAllocationError ? cause : null;
      throw new ChatPersistenceError({ operation, chatId: allocationError?.chatId || chatId, cause: allocationError?.cause || cause });
    }
    this.current = snapshot(chatId, version!, messages);
    this.revision += 1;
    const message = this.current.messages[this.current.messages.length - 1];
    if (!message || message.role !== "user") throw new ChatPersistenceError({ operation, chatId, cause: new Error("Committed user message is absent from authoritative snapshot") });
    return Object.freeze({ snapshot: this.current, message });
  }

  public candidateUser(message: ChatMessage): ChatTranscriptCandidate {
    const messages = this.current.messages.some((entry) => entry.message_id === message.message_id)
      ? [...this.current.messages]
      : [...this.current.messages, message];
    return this.createCandidate("user_commit", messages as ChatMessage[]);
  }

  public candidateAssistant(message: ChatMessage): ChatTranscriptCandidate {
    return this.createCandidate("assistant_commit", upsert(this.current.messages, message));
  }

  public candidateTools(message: ChatMessage): ChatTranscriptCandidate {
    return this.createCandidate("tool_checkpoint", upsert(this.current.messages, message));
  }

  private createCandidate(
    operation: ChatTranscriptCandidate["operation"],
    messages: readonly ChatMessage[],
  ): ChatTranscriptCandidate {
    const candidate = Object.freeze({
      operation,
      baseRevision: this.revision,
      messages: immutableMessages(messages),
    });
    this.candidateBases.set(candidate, { snapshot: this.current, revision: this.revision });
    return candidate;
  }

  public commit(candidate: ChatTranscriptCandidate): Promise<ChatTranscriptSnapshot> {
    const priorResult = this.committedCandidates.get(candidate);
    if (priorResult) {
      if (priorResult === this.current) return Promise.resolve(priorResult);
      return Promise.reject(new ChatPersistenceError({
        operation: candidate.operation,
        chatId: priorResult.chatId,
        cause: new ChatTranscriptStaleTransitionError(candidate.baseRevision, this.revision),
      }));
    }
    const active = this.inFlightCandidates.get(candidate);
    if (active) return active;

    const base = this.candidateBases.get(candidate);
    const commitPromise = this.serializeTransition(() => this.persistCandidate(candidate, base));
    this.inFlightCandidates.set(candidate, commitPromise);
    void commitPromise.finally(() => {
      if (this.inFlightCandidates.get(candidate) === commitPromise) {
        this.inFlightCandidates.delete(candidate);
      }
    }).catch(() => {});
    return commitPromise;
  }

  private async persistCandidate(
    candidate: ChatTranscriptCandidate,
    base: { snapshot: ChatTranscriptSnapshot; revision: number } | undefined,
  ): Promise<ChatTranscriptSnapshot> {
    this.assertWritable();
    this.assertCurrentBase(candidate.operation, candidate.baseRevision, base);
    let chatId = this.current.chatId;
    let version: number;
    const storageMessages = deepClone(candidate.messages) as readonly ChatMessage[];
    try {
      if (chatId) {
        ({ version } = await this.storage.save(chatId, storageMessages));
      } else {
        const allocated = await new ChatIdAllocator(
          (candidateId) => this.storage.createExclusive(candidateId, storageMessages),
          this.now,
        ).allocate();
        chatId = allocated.chatId;
        version = allocated.value.version;
      }
    } catch (cause) {
      const allocationError = cause instanceof ChatIdAllocationError ? cause : null;
      throw new ChatPersistenceError({
        operation: candidate.operation,
        chatId: allocationError?.chatId || chatId,
        cause: allocationError?.cause || cause,
      });
    }

    const committed = snapshot(chatId, version!, candidate.messages as readonly ChatMessage[]);
    this.current = committed;
    this.revision += 1;
    this.committedCandidates.set(candidate, committed);
    return committed;
  }

  public branchFrom(index: number): Promise<ChatTranscriptSnapshot> {
    const active = this.inFlightBranches.get(index);
    if (active?.base === this.current) return active.promise;

    const base = this.current;
    const baseRevision = this.revision;
    const branchPromise = this.serializeTransition(() => this.persistBranch(index, base, baseRevision));
    this.inFlightBranches.set(index, { base, promise: branchPromise });
    void branchPromise.finally(() => {
      if (this.inFlightBranches.get(index)?.promise === branchPromise) {
        this.inFlightBranches.delete(index);
      }
    }).catch(() => {});
    return branchPromise;
  }

  private async persistBranch(
    index: number,
    base: ChatTranscriptSnapshot,
    baseRevision: number,
  ): Promise<ChatTranscriptSnapshot> {
    this.assertWritable();
    this.assertCurrentBase("resend_branch", baseRevision, { snapshot: base, revision: baseRevision });
    const branch: ChatTranscriptBranch = Object.freeze({
      operation: "resend_branch" as const,
      baseRevision,
      messages: immutableMessages(base.messages.slice(0, index) as ChatMessage[]),
    });
    let chatId = branch.messages.length === 0 ? "" : base.chatId;
    const storageMessages = deepClone(branch.messages) as readonly ChatMessage[];
    try {
      let version: number;
      if (chatId) {
        ({ version } = await this.storage.save(chatId, storageMessages));
      } else {
        const allocated = await new ChatIdAllocator(
          (candidateId) => this.storage.createExclusive(candidateId, storageMessages),
          this.now,
        ).allocate();
        chatId = allocated.chatId;
        version = allocated.value.version;
      }
      this.current = snapshot(chatId, version!, branch.messages as readonly ChatMessage[]);
      this.revision += 1;
      return this.current;
    } catch (cause) {
      const allocationError = cause instanceof ChatIdAllocationError ? cause : null;
      throw new ChatPersistenceError({
        operation: "resend_branch",
        chatId: allocationError?.chatId || chatId,
        cause: allocationError?.cause || cause,
      });
    }
  }

  private assertWritable(): void {
    if (this.current.readOnly) throw new ChatTranscriptReadOnlyError(this.current.chatId);
  }

  private assertCurrentBase(
    operation: ChatTranscriptCandidate["operation"] | "resend_branch" | "resend_user_commit" | "pi_sync" | "pi_fork",
    baseRevision: number,
    base: { snapshot: ChatTranscriptSnapshot; revision: number } | undefined,
  ): void {
    if (base && base.snapshot === this.current && base.revision === this.revision && baseRevision === this.revision) {
      return;
    }
    const cause = new ChatTranscriptStaleTransitionError(baseRevision, this.revision);
    throw new ChatPersistenceError({
      operation,
      chatId: base?.snapshot.chatId || this.current.chatId,
      cause,
    });
  }

  private serializeTransition(run: () => Promise<ChatTranscriptSnapshot>): Promise<ChatTranscriptSnapshot> {
    const promise = new Promise<ChatTranscriptSnapshot>((resolve, reject) => {
      this.transitionQueue.push({ run, resolve, reject });
    });
    this.drainTransitionQueue();
    return promise;
  }

  private drainTransitionQueue(): void {
    if (this.transitionRunning) return;
    const next = this.transitionQueue.shift();
    if (!next) return;
    this.transitionRunning = true;
    let result: Promise<ChatTranscriptSnapshot>;
    try {
      result = next.run();
    } catch (cause) {
      result = Promise.reject(cause);
    }
    void result.then(next.resolve, next.reject).finally(() => {
      this.transitionRunning = false;
      this.drainTransitionQueue();
    });
  }

  public recover(): Promise<ChatTranscriptSnapshot> {
    if (this.inFlightRecovery) return this.inFlightRecovery;

    const recovery = this.serializeTransition(() => this.performRecovery());
    this.inFlightRecovery = recovery;
    void recovery.finally(() => {
      if (this.inFlightRecovery === recovery) {
        this.inFlightRecovery = null;
      }
    }).catch(() => {});
    return recovery;
  }

  private async performRecovery(): Promise<ChatTranscriptSnapshot> {
    if (!this.current.chatId) return this.current;
    const chatId = this.current.chatId;
    let loaded: StoredChatTranscript | null;
    try {
      loaded = await this.storage.load(chatId);
    } catch (cause) {
      throw new ChatPersistenceError({ operation: "flush", chatId, cause });
    }
    if (loaded) {
      this.current = snapshot(loaded.chatId, loaded.version, loaded.messages, loaded.readOnly === true);
      this.revision += 1;
    }
    return this.current;
  }
}
