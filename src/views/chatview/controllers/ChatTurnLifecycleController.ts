export type ChatTurnLifecycleHost = {
  getIsGenerating: () => boolean;
  setGenerating: (generating: boolean) => void;
};

/**
 * Coordinates a single active chat "turn" (send → stream → complete), ensuring:
 * - turns are serialized (no concurrent sends)
 * - Stop immediately aborts the active turn via AbortController
 */
export class ChatTurnLifecycleController {
  private activeTurnPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private readonly host: ChatTurnLifecycleHost;

  constructor(host: ChatTurnLifecycleHost) {
    this.host = host;
  }

  public stop(): void {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } finally {
        this.abortController = null;
      }
    }
    this.host.setGenerating(false);
  }

  public async runTurn(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeTurnPromise) {
      try {
        await this.activeTurnPromise;
      } catch (_) {}
    }

    if (this.host.getIsGenerating()) {
      return;
    }

    const turn = (async () => {
      this.host.setGenerating(true);
      this.abortController = new AbortController();

      try {
        await executor(this.abortController.signal);
      } finally {
        this.host.setGenerating(false);
        this.abortController = null;
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

