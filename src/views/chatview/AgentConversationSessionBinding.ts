export type AgentConversationSessionPort<TSnapshot> = Readonly<{
  subscribe: (listener: (snapshot: TSnapshot) => void) => () => void;
  detach: () => Promise<void>;
}>;

const DETACH_CONFIRMATION = Symbol("agent-conversation-detach-confirmation");

type DetachRecord = {
  readonly binding: object;
  confirmed: boolean;
};

/**
 * Proof that one exact outgoing session finished detaching.
 *
 * The symbol keeps callers from constructing a receipt from a conversation ID
 * or another session's successful detach. Only this binding can issue and
 * accept the receipt for its current outgoing session.
 */
export type AgentConversationDetachConfirmation = Readonly<{
  [DETACH_CONFIRMATION]: DetachRecord;
}>;

type ActiveBinding<TSnapshot, TSession extends AgentConversationSessionPort<TSnapshot>> = {
  readonly identity: object;
  readonly session: TSession;
  acceptingCallbacks: boolean;
  unsubscribe: (() => void) | null;
};

const MISSING_DETACH_BARRIER_ERROR =
  "The next chat cannot attach without confirmation from the exact outgoing session.";

/**
 * Owns the one session allowed to publish into a conversation workspace.
 *
 * Replacements serialize through an exact detach barrier. The outgoing
 * callback gate closes before detach starts, and the next callback gate opens
 * only after that same binding confirms detach. A late transport callback is
 * therefore inert even when an unsubscribe or abort arrives too late.
 */
export class AgentConversationSessionBinding<
  TSnapshot,
  TSession extends AgentConversationSessionPort<TSnapshot>,
> {
  private active: ActiveBinding<TSnapshot, TSession> | null = null;
  private detachRecord: DetachRecord | null = null;
  private transition: Promise<void> = Promise.resolve();

  public constructor(
    initialSession: TSession,
    private readonly listener: (session: TSession, snapshot: TSnapshot) => void,
  ) {
    this.attachInitial(initialSession);
  }

  public get currentSession(): TSession | null {
    return this.active?.session ?? null;
  }

  /** Serializes rapid replacements so every attached session has one barrier. */
  public replace(createSession: () => TSession): Promise<TSession> {
    return this.enqueue(async () => {
      const confirmation = this.active
        ? await this.detachActive()
        : this.confirmedDetach();
      const next = createSession();
      this.attach(next, confirmation);
      return next;
    });
  }

  /** Detaches the current binding and returns proof scoped to that binding. */
  public detach(): Promise<AgentConversationDetachConfirmation> {
    return this.enqueue(async () => this.active
      ? this.detachActive()
      : this.confirmedDetach());
  }

  /**
   * Attaches only after the exact outgoing binding confirmed its detach.
   * This method is public so lifecycle coordinators cannot bypass the check.
   */
  public attach(
    session: TSession,
    confirmation: AgentConversationDetachConfirmation | null | undefined,
  ): void {
    if (this.active) {
      throw new Error("A chat session is already attached.");
    }
    const record = confirmation?.[DETACH_CONFIRMATION];
    if (!record || record !== this.detachRecord || !record.confirmed) {
      throw new Error(MISSING_DETACH_BARRIER_ERROR);
    }
    this.attachConfirmed(session);
    this.detachRecord = null;
  }

  /** Stops presentation callbacks without claiming that detach completed. */
  public unsubscribe(): void {
    const binding = this.active;
    if (!binding) return;
    binding.acceptingCallbacks = false;
    const unsubscribe = binding.unsubscribe;
    binding.unsubscribe = null;
    try { unsubscribe?.(); }
    catch { /* The identity gate remains closed even if cleanup throws. */ }
  }

  private attachInitial(session: TSession): void {
    if (this.active || this.detachRecord) {
      throw new Error(MISSING_DETACH_BARRIER_ERROR);
    }
    this.attachConfirmed(session);
  }

  private attachConfirmed(session: TSession): void {
    const binding: ActiveBinding<TSnapshot, TSession> = {
      identity: {},
      session,
      acceptingCallbacks: true,
      unsubscribe: null,
    };
    this.active = binding;
    try {
      binding.unsubscribe = session.subscribe((snapshot) => {
        if (this.active !== binding || !binding.acceptingCallbacks) return;
        this.listener(session, snapshot);
      });
    } catch (error) {
      binding.acceptingCallbacks = false;
      this.active = null;
      throw error;
    }
  }

  private async detachActive(): Promise<AgentConversationDetachConfirmation> {
    const binding = this.active;
    if (!binding) return this.confirmedDetach();

    binding.acceptingCallbacks = false;
    this.active = null;
    const record: DetachRecord = {
      binding: binding.identity,
      confirmed: false,
    };
    this.detachRecord = record;

    const unsubscribe = binding.unsubscribe;
    binding.unsubscribe = null;
    try { unsubscribe?.(); }
    catch { /* The callback identity gate is the authoritative local fence. */ }

    await binding.session.detach();
    if (this.detachRecord !== record || record.binding !== binding.identity) {
      throw new Error(MISSING_DETACH_BARRIER_ERROR);
    }
    record.confirmed = true;
    return Object.freeze({ [DETACH_CONFIRMATION]: record });
  }

  private confirmedDetach(): AgentConversationDetachConfirmation {
    const record = this.detachRecord;
    if (!record?.confirmed) throw new Error(MISSING_DETACH_BARRIER_ERROR);
    return Object.freeze({ [DETACH_CONFIRMATION]: record });
  }

  private enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const operation = this.transition.then(task, task);
    this.transition = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
