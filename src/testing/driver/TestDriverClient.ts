import type { App, PluginManifest } from "obsidian";

import { runDriverAction, type ActionContext } from "./actions";
import {
  parseHandshake,
  TEST_DRIVER_HANDSHAKE_FILE,
  TEST_DRIVER_MARKER,
  TEST_DRIVER_POLL_INTERVAL_MS,
  type TestDriverActionRequest,
  type TestDriverActionResult,
  type TestDriverHandshake,
  type TestDriverHello,
} from "./protocol";

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
  private pollTimer: number | null = null;
  private socket: WebSocket | null = null;
  private connectedServerId: string | null = null;
  private failedServerIds = new Set<string>();
  private actionChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly buildStamp: string,
  ) {}

  public start(): void {
    if (this.pollTimer !== null || this.stopped) return;
    this.pollTimer = window.setInterval(() => {
      void this.poll();
    }, TEST_DRIVER_POLL_INTERVAL_MS);
    void this.poll();
  }

  public stop(): void {
    this.stopped = true;
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
    if (this.stopped || this.socket !== null) return;
    let raw: string;
    try {
      raw = await this.app.vault.adapter.read(this.handshakePath());
    } catch {
      this.failedServerIds.clear();
      return;
    }
    const handshake = parseHandshake(raw);
    if (!handshake) return;
    if (handshake.serverId === this.connectedServerId) return;
    if (this.failedServerIds.has(handshake.serverId)) return;
    this.connect(handshake);
  }

  private connect(handshake: TestDriverHandshake): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${handshake.port}/`);
    } catch {
      this.failedServerIds.add(handshake.serverId);
      return;
    }
    this.socket = socket;
    this.connectedServerId = handshake.serverId;

    socket.addEventListener("open", () => {
      const hello: TestDriverHello = {
        type: "hello",
        token: handshake.token,
        serverId: handshake.serverId,
        marker: TEST_DRIVER_MARKER,
        vault: this.app.vault.getName(),
        pluginVersion: this.manifest.version,
        buildStamp: this.buildStamp,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : "");
    });
    const finalize = (failed: boolean): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectedServerId = null;
      if (failed) this.failedServerIds.add(handshake.serverId);
    };
    socket.addEventListener("error", () => finalize(true));
    socket.addEventListener("close", (event) => finalize(event.code !== 1000));
  }

  private closeSocket(): void {
    const socket = this.socket;
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

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.type === "bye") {
      this.closeSocket();
      return;
    }
    if (value.type !== "action") return;
    if (typeof value.id !== "number" || typeof value.action !== "string") return;
    const request: TestDriverActionRequest = {
      type: "action",
      id: value.id,
      action: value.action,
      params: typeof value.params === "object" && value.params !== null
        ? value.params as Record<string, unknown>
        : {},
    };
    this.actionChain = this.actionChain.then(() => this.execute(request));
  }

  private async execute(request: TestDriverActionRequest): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const ctx: ActionContext = {
      app: this.app,
      pluginId: this.manifest.id,
      pluginVersion: this.manifest.version,
      buildStamp: this.buildStamp,
    };
    let response: TestDriverActionResult;
    try {
      const result = await runDriverAction(ctx, request.action, request.params ?? {});
      response = { type: "result", id: request.id, ok: true, result };
    } catch (error) {
      response = {
        type: "result",
        id: request.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
    const payload = JSON.stringify(response);
    if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}
