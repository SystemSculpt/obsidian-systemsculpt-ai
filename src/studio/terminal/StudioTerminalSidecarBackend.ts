import type SystemSculptPlugin from "../../main";
import type {
  StudioTerminalBackend,
  StudioTerminalProcess,
  StudioTerminalProcessExit,
  StudioTerminalSessionSnapshot,
  StudioTerminalSidecarSessionEvent,
  StudioTerminalSidecarSessionEventListener,
  StudioTerminalSidecarStatus,
  StudioTerminalSidecarStatusListener,
  StudioTerminalSpawnOptions,
} from "./StudioTerminalSessionTypes";
import { StudioTerminalSidecarClient, isExpectedTerminalSidecarConnectionError } from "./StudioTerminalSidecarClient";

type SidecarClientLike = {
  ensureSession: (options: StudioTerminalSpawnOptions) => Promise<StudioTerminalSessionSnapshot>;
  writeInput: (options: { sessionId: string; data: string }) => Promise<void>;
  resizeSession: (options: { sessionId: string; cols: number; rows: number }) => Promise<void>;
  stopSession: (sessionId: string) => Promise<StudioTerminalSessionSnapshot | null>;
  clearHistory: (sessionId: string) => Promise<void>;
  peekSession: (options: { sessionId: string }) => Promise<StudioTerminalSessionSnapshot | null>;
  stopProjectSessions: (options: { projectPath: string; reason?: string }) => Promise<void>;
  fetchStatus: () => Promise<StudioTerminalSidecarStatus>;
  getSidecarStatus: () => StudioTerminalSidecarStatus | null;
  subscribeSidecarStatus: (listener: StudioTerminalSidecarStatusListener) => () => void;
  subscribeSessionEvents: (
    options: { sessionId: string },
    listener: StudioTerminalSidecarSessionEventListener,
  ) => () => void;
  dispose: () => Promise<void>;
};

class SidecarTerminalProcessProxy implements StudioTerminalProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: StudioTerminalProcessExit) => void>();
  private disposed = false;
  private exitEmitted = false;

  constructor(
    private readonly client: SidecarClientLike,
    private readonly sessionId: string,
    private readonly unsubscribeSessionEvents: () => void,
  ) {}

  handleSessionEvent(event: StudioTerminalSidecarSessionEvent): void {
    if (this.disposed) {
      return;
    }
    if (event.type === "data") {
      this.emitData(event.data);
      return;
    }
    this.applySnapshot(event.snapshot);
  }

  applySnapshot(snapshot: StudioTerminalSessionSnapshot): void {
    if (this.disposed || this.exitEmitted) {
      return;
    }
    if (snapshot.status === "running" || snapshot.status === "starting") {
      return;
    }
    this.emitExit({
      exitCode: Number.isFinite(snapshot.exitCode) ? Math.floor(Number(snapshot.exitCode)) : 0,
    });
  }

  private emitData(data: string): void {
    if (!data || this.disposed) {
      return;
    }
    for (const listener of this.dataListeners) {
      try {
        listener(data);
      } catch {
        // Listener errors must not break transport.
      }
    }
  }

  private emitExit(event: StudioTerminalProcessExit): void {
    if (this.disposed || this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    for (const listener of this.exitListeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break transport.
      }
    }
  }

  write(data: string): void {
    if (this.disposed || !data) {
      return;
    }
    void this.client.writeInput({
      sessionId: this.sessionId,
      data,
    }).catch(() => {
      // Sidecar data path is best effort from UI perspective.
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    void this.client.resizeSession({
      sessionId: this.sessionId,
      cols,
      rows,
    }).catch(() => {
      // Sidecar resize path is best effort from UI perspective.
    });
  }

  kill(): void {
    if (this.disposed) {
      return;
    }
    void this.client.stopSession(this.sessionId).then((snapshot) => {
      if (!snapshot) {
        return;
      }
      this.applySnapshot(snapshot);
    }).catch(() => {
      // Stop failures are surfaced via backend warning paths.
    });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (event: StudioTerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.unsubscribeSessionEvents();
    } catch {
      // Ignore dispose listener errors.
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export class StudioTerminalSidecarBackend implements StudioTerminalBackend {
  readonly keepsSessionsOnDispose = true;

  private readonly client: SidecarClientLike;
  private warnedUnexpectedRefreshError = false;

  constructor(
    private readonly plugin: SystemSculptPlugin,
    options?: {
      client?: SidecarClientLike;
    }
  ) {
    this.client = options?.client || new StudioTerminalSidecarClient(plugin);
  }

  private warnUnexpected(message: string, metadata?: Record<string, unknown>): void {
    this.plugin.getLogger().warn(message, {
      source: "StudioTerminalSidecarBackend",
      metadata,
    });
  }

  async spawn(options: StudioTerminalSpawnOptions): Promise<StudioTerminalProcess> {
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("Terminal sidecar spawn requires a sessionId.");
    }

    let proxy: SidecarTerminalProcessProxy | null = null;
    const unsubscribeSessionEvents = this.client.subscribeSessionEvents(
      { sessionId },
      (event) => {
        proxy?.handleSessionEvent(event);
      }
    );

    try {
      proxy = new SidecarTerminalProcessProxy(this.client, sessionId, unsubscribeSessionEvents);
      const snapshot = await this.client.ensureSession(options);
      proxy.applySnapshot(snapshot);
      return proxy;
    } catch (error) {
      unsubscribeSessionEvents();
      throw error;
    }
  }

  async peekSession(options: { sessionId: string }): Promise<StudioTerminalSessionSnapshot | null> {
    try {
      return await this.client.peekSession(options);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return null;
      }
      this.warnUnexpected(`Unexpected terminal sidecar peek failure: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  getSidecarStatus(): StudioTerminalSidecarStatus | null {
    return this.client.getSidecarStatus();
  }

  subscribeSidecarStatus(listener: StudioTerminalSidecarStatusListener): () => void {
    return this.client.subscribeSidecarStatus(listener);
  }

  async refreshSidecarStatus(): Promise<StudioTerminalSidecarStatus | null> {
    try {
      const status = await this.client.fetchStatus();
      this.warnedUnexpectedRefreshError = false;
      return status;
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return this.client.getSidecarStatus();
      }
      if (!this.warnedUnexpectedRefreshError) {
        this.warnedUnexpectedRefreshError = true;
        this.warnUnexpected(
          `Unexpected terminal sidecar status refresh failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return this.client.getSidecarStatus();
    }
  }

  async clearHistory(sessionId: string): Promise<void> {
    try {
      await this.client.clearHistory(sessionId);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return;
      }
      throw error;
    }
  }

  async writeInput(options: { sessionId: string; data: string }): Promise<void> {
    try {
      await this.client.writeInput(options);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return;
      }
      throw error;
    }
  }

  async resizeSession(options: { sessionId: string; cols: number; rows: number }): Promise<void> {
    try {
      await this.client.resizeSession(options);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return;
      }
      throw error;
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    try {
      await this.client.stopSession(sessionId);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return;
      }
      throw error;
    }
  }

  async terminateProjectSessions(options: { projectPath: string; reason?: string }): Promise<void> {
    try {
      await this.client.stopProjectSessions(options);
    } catch (error) {
      if (isExpectedTerminalSidecarConnectionError(error)) {
        return;
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }
}
