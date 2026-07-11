export type ChatTurnLifecycleHost = {
  getIsGenerating: () => boolean;
  setGenerating: (generating: boolean) => void;
};

export type ChatTurnLifecycleState =
  | "terminal"
  | "running"
  | "cancel_requested"
  | "settling";

export class ChatTurnAlreadyActiveError extends Error {
  public readonly code = "chat_turn_already_active" as const;

  constructor(public readonly state: Exclude<ChatTurnLifecycleState, "terminal"> | "reserved") {
    super("A chat turn is already active.");
    this.name = "ChatTurnAlreadyActiveError";
  }
}

/**
 * Owns a turn from admission through terminal settlement. Stop only requests
 * cancellation; the active turn's finally block exclusively clears UI state.
 */
export class ChatTurnLifecycleController {
  private activeTurnPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private state: ChatTurnLifecycleState = "terminal";
  private readonly host: ChatTurnLifecycleHost;

  constructor(host: ChatTurnLifecycleHost) {
    this.host = host;
  }

  public getState(): ChatTurnLifecycleState {
    return this.state;
  }

  public isActive(): boolean {
    return this.activeTurnPromise !== null || this.state !== "terminal" || this.host.getIsGenerating();
  }

  public stop(): Promise<void> {
    const activeTurn = this.activeTurnPromise;
    if (!activeTurn || !this.abortController) {
      return Promise.resolve();
    }

    if (!this.abortController.signal.aborted) {
      this.state = "cancel_requested";
      this.abortController.abort();
    }
    this.state = "settling";
    return activeTurn;
  }

  public async runTurn(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.isActive()) {
      const activeState = this.state === "terminal" ? "running" : this.state;
      throw new ChatTurnAlreadyActiveError(activeState);
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.state = "running";
    this.host.setGenerating(true);

    const turn = (async () => {
      try {
        await executor(controller.signal);
      } finally {
        this.state = "terminal";
        this.host.setGenerating(false);
        if (this.abortController === controller) {
          this.abortController = null;
        }
      }
    })();

    this.activeTurnPromise = turn;
    try {
      await turn;
    } finally {
      if (this.activeTurnPromise === turn) {
        this.activeTurnPromise = null;
      }
    }
  }
}
