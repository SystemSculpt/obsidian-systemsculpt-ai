export type AgentConversationSessionPort<TSnapshot> = Readonly<{
  subscribe: (listener: (snapshot: TSnapshot) => void) => () => void;
  detach: () => Promise<void>;
}>;

type ActiveBinding<TSession> = {
  readonly session: TSession;
  acceptingCallbacks: boolean;
  unsubscribe: (() => void) | null;
};

/**
 * Owns the one session allowed to publish into a conversation workspace.
 *
 * Replacement and close share a serialized detach barrier. No caller can
 * attach a session separately or claim that another session finished detaching.
 * A failed detach keeps every subsequent replacement closed, and the callback
 * identity gate makes late transport events inert even if unsubscribe throws.
 */
export class AgentConversationSessionBinding<
  TSnapshot,
  TSession extends AgentConversationSessionPort<TSnapshot>,
> {
  private active: ActiveBinding<TSession> | null = null;
  private detachBarrier: Promise<void> = Promise.resolve();
  private transition: Promise<void> = Promise.resolve();

  public constructor(
    initialSession: TSession,
    private readonly listener: (session: TSession, snapshot: TSnapshot) => void,
  ) {
    this.attach(initialSession);
  }

  public replace(createSession: () => TSession): Promise<TSession> {
    return this.enqueue(async () => {
      await this.detachActive();
      const next = createSession();
      this.attach(next);
      return next;
    });
  }

  public detach(): Promise<void> {
    return this.enqueue(() => this.detachActive());
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

  private attach(session: TSession): void {
    const binding: ActiveBinding<TSession> = {
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

  private detachActive(): Promise<void> {
    const binding = this.active;
    if (binding) {
      this.unsubscribe();
      this.active = null;
      this.detachBarrier = (async () => { await binding.session.detach(); })();
    }
    return this.detachBarrier;
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
