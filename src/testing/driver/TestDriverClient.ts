import type { App, PluginManifest } from "obsidian";
import { TEST_DRIVER_ARTIFACT_ID } from "virtual:systemsculpt-test-driver-artifact";

import { runDriverAction, type ActionContext } from "./actions";
import { DriverDiagnostics } from "./diagnostics";
import type { SupportDiagnosticEvent } from "../../utils/PluginLogger";
import {
  parseTestDriverClientMessage,
  parseHandshake,
  TEST_DRIVER_HANDSHAKE_FILE,
  TEST_DRIVER_MARKER,
  TEST_DRIVER_POLL_INTERVAL_MS,
  type TestDriverActionRequest,
  type TestDriverActionResult,
  type TestDriverHandshake,
  type TestDriverHello,
} from "./protocol";

const DETACHABLE_ACTIONS = new Set([
  "status",
  "read",
  "vault.assertText",
  "logs",
  "notices",
  "catalog",
  "query",
  "snapshot",
  "waitFor",
  "chat.toolLifecycle",
  "chat.assertToolLifecycle",
  "chat.waitForDevelopmentRun",
  "chat.assertLatestToolSettledAfterContinuation",
  "chat.assertNoClientToolsBeforeContinuation",
  "chat.readCopiedIncidentReport",
]);

function isDetachableAction(request: TestDriverActionRequest): boolean {
  if (request.action === "waitForRun") {
    return request.params?.approve === false || request.params?.returnOnApproval === true;
  }
  return DETACHABLE_ACTIONS.has(request.action);
}

function waitForActionOrAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Driver action cancelled."));
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      signal.removeEventListener("abort", cancelled);
      reject(new Error("Driver action cancelled."));
    };
    signal.addEventListener("abort", cancelled, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener("abort", cancelled);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
}

/**
 * SystemSculptTestDriver/v1 client.
 *
 * Present only in non-release builds (see the __SS_TEST_DRIVER__ build flag).
 * The external `npm run e2e` CLI hosts a localhost WebSocket server and writes
 * a token handshake file into this plugin's config directory; this client
 * polls for it and dials out. The plugin never listens on a socket, and every
 * action is a synthesized user interaction on the real DOM.
 */
export class TestDriverClient {
  private readonly diagnostics = new DriverDiagnostics();
  private pollTimer: number | null = null;
  private socket: WebSocket | null = null;
  private connectedServerId: string | null = null;
  private failedServerIds = new Set<string>();
  private actionChain: Promise<void> = Promise.resolve();
  private activeActionControllers = new Map<number, {
    controller: AbortController;
    socket: WebSocket;
  }>();
  private cancelledActionIds = new WeakMap<WebSocket, Set<number>>();
  private pendingNonDetachableActions = 0;
  private pollInFlight = false;
  private stopped = false;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly buildStamp: string,
    private readonly apiBaseUrl: string,
    private readonly settingsRoot?: () => HTMLElement | null,
    private readonly readSupportDiagnostics?: () => readonly SupportDiagnosticEvent[],
  ) {}

  public start(): void {
    if (this.pollTimer !== null || this.stopped) return;
    this.diagnostics.start();
    this.pollTimer = window.setInterval(() => {
      void this.poll();
    }, TEST_DRIVER_POLL_INTERVAL_MS);
    void this.poll();
  }

  public stop(): void {
    this.stopped = true;
    this.diagnostics.stop();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.closeSocket();
  }

  private handshakePath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${TEST_DRIVER_HANDSHAKE_FILE}`;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.socket !== null || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      let raw: string;
      try {
        raw = await this.app.vault.adapter.read(this.handshakePath());
      } catch {
        this.failedServerIds.clear();
        return;
      }
      if (this.stopped || this.socket !== null) return;
      const handshake = parseHandshake(raw);
      if (!handshake) return;
      if (handshake.serverId === this.connectedServerId) return;
      if (this.failedServerIds.has(handshake.serverId)) return;
      this.connect(handshake);
    } finally {
      this.pollInFlight = false;
    }
  }

  private connect(handshake: TestDriverHandshake): void {
    if (this.stopped || this.socket !== null) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/`);
    } catch {
      this.failedServerIds.add(handshake.serverId);
      return;
    }
    this.socket = socket;
    this.connectedServerId = handshake.serverId;
    this.cancelledActionIds.set(socket, new Set());
    // Observational waits can be abandoned safely. A replacement must remain
    // behind any unresolved DOM mutator so stale work cannot overlap it.
    if (this.pendingNonDetachableActions === 0) {
      this.actionChain = Promise.resolve();
    }

    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      const hello: TestDriverHello = {
        type: "hello",
        token: handshake.token,
        serverId: handshake.serverId,
        marker: TEST_DRIVER_MARKER,
        artifactId: TEST_DRIVER_ARTIFACT_ID,
        vault: this.app.vault.getName(),
        pluginVersion: this.manifest.version,
        buildStamp: this.buildStamp,
        apiBaseUrl: this.apiBaseUrl,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(socket, typeof event.data === "string" ? event.data : "");
    });
    const finalize = (failed: boolean): void => {
      if (this.socket !== socket) return;
      this.abortSocketActions(socket);
      this.socket = null;
      this.connectedServerId = null;
      if (failed) this.failedServerIds.add(handshake.serverId);
    };
    socket.addEventListener("error", () => finalize(true));
    socket.addEventListener("close", (event) => finalize(event.code !== 1000));
  }

  private closeSocket(expectedSocket?: WebSocket): void {
    const socket = this.socket;
    if (expectedSocket && socket !== expectedSocket) return;
    if (socket) this.abortSocketActions(socket);
    this.socket = null;
    this.connectedServerId = null;
    if (socket) {
      try {
        socket.close(1000, "driver stopped");
      } catch {
        // The socket may already be closed.
      }
    }
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    if (this.socket !== socket) return;
    const message = parseTestDriverClientMessage(raw);
    if (!message) return;
    if (message.type === "cancel") {
      this.cancelledActionIds.get(socket)?.add(message.id);
      const active = this.activeActionControllers.get(message.id);
      if (active?.socket === socket) active.controller.abort();
      return;
    }
    const request: TestDriverActionRequest = message;
    const detachable = isDetachableAction(request);
    if (!detachable) this.pendingNonDetachableActions += 1;
    const queued = this.actionChain.then(async () => {
      try {
        if (this.socket !== socket) return;
        if (this.cancelledActionIds.get(socket)?.has(request.id)) return;
        await this.execute(socket, request, detachable);
      } finally {
        this.cancelledActionIds.get(socket)?.delete(request.id);
        if (!detachable) this.pendingNonDetachableActions -= 1;
      }
    });
    // A transport send race must not poison the queue for a later action or
    // replacement connection. Action failures are result messages already.
    this.actionChain = queued.catch(() => undefined);
  }

  private abortSocketActions(socket: WebSocket): void {
    for (const active of this.activeActionControllers.values()) {
      if (active.socket === socket) active.controller.abort();
    }
  }

  private async execute(
    socket: WebSocket,
    request: TestDriverActionRequest,
    detachable: boolean,
  ): Promise<void> {
    if (this.socket !== socket) return;
    const controller = new AbortController();
    this.activeActionControllers.set(request.id, { controller, socket });
    const ctx: ActionContext = {
      app: this.app,
      pluginId: this.manifest.id,
      pluginVersion: this.manifest.version,
      buildStamp: this.buildStamp,
      diagnostics: this.diagnostics,
      readSupportDiagnostics: this.readSupportDiagnostics,
      signal: controller.signal,
      settingsRoot: this.settingsRoot,
    };
    let response: TestDriverActionResult;
    try {
      const task = Promise.resolve(runDriverAction(ctx, request.action, request.params ?? {}));
      const result = detachable
        ? await waitForActionOrAbort(task, controller.signal)
        : await task;
      response = { type: "result", id: request.id, ok: true, result };
    } catch (error) {
      response = {
        type: "result",
        id: request.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      const active = this.activeActionControllers.get(request.id);
      if (active?.socket === socket) this.activeActionControllers.delete(request.id);
    }
    const payload = JSON.stringify(response);
    if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}
