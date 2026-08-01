import type { PlatformRequestClient } from "../../../services/PlatformRequestClient";
import type { ThinAgentBootstrapRequest } from "../../../services/managed/ThinAgentV1Contract";
import {
  parseAgentCommand,
  type AgentApprovalCommand,
  type AgentCancelCommand,
  type AgentRegenerateCommand,
  type AgentServerEvent,
  type AgentSubmitCommand,
  type AgentToolResultCommand,
} from "./Protocol";
import type {
  AgentConnectionPort,
  AgentConnectionState,
} from "./AuthoritativeSession";

/**
 * Streaming-HTTP implementation of the session's connection port.
 *
 * A turn is one request whose response streams the authoritative events and
 * then ends. That is not a reduced form of the socket transport — the server
 * already terminates a run at every client-tool boundary and rehydrates the
 * next segment from serialized state, so a response per segment is the shape
 * execution already had. The socket wrapped it in a connection that
 * contributed nothing to continuation while re-authenticating on every
 * reconnect.
 *
 * Because there is no connection to lose, there is no reconnect ladder, no
 * cursor, no resynchronization, and no snapshot-required negotiation. A failed
 * turn fails its own request and the next command starts a fresh one.
 */

export type AgentStreamingTransportOptions = Readonly<{
  baseUrl: string;
  licenseKey: () => string;
  pluginVersion: string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  requestClient: Pick<PlatformRequestClient, "request">;
  isAuthoritativeFrame?: (value: unknown) => boolean;
}>;

type BootstrapAccess = Readonly<{ token: string; expiresAt: number }>;

const ACCESS_REFRESH_MARGIN_MS = 5_000;

export class AgentStreamingTransport
implements AgentConnectionPort {
  private connectionState: AgentConnectionState = "idle";
  private readonly frameListeners =
    new Set<(frame: AgentServerEvent) => void>();
  private readonly stateListeners =
    new Set<(state: AgentConnectionState) => void>();
  private access: BootstrapAccess | null = null;
  private inFlight: AbortController | null = null;
  private disposed = false;

  public constructor(
    private readonly options: AgentStreamingTransportOptions,
  ) {}

  public get state(): AgentConnectionState {
    return this.connectionState;
  }

  public addAuthoritativeFrameListener(
    listener: (frame: AgentServerEvent) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }

  public addConnectionStateListener(
    listener: (state: AgentConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /**
   * Establishes identity, then synchronizes on the authoritative snapshot
   * before reporting open.
   *
   * The snapshot is not optional. A session treats it as the beginning of
   * authority: until one arrives it holds an unknown run state and refuses to
   * dispatch, and it rejects every other frame as arriving out of order. The
   * socket received that frame from the server on open; with no connection to
   * open, the transport asks for the same frame over HTTP.
   */
  public async connect(): Promise<void> {
    this.disposed = false;
    this.setState("connecting");
    const token = await this.ensureAccess();
    await this.synchronize(token);
    this.setState("open");
  }

  /**
   * Delivers the authoritative session snapshot while the transport is still
   * connecting, so the state it publishes on open is already synchronized.
   */
  private async synchronize(token: string): Promise<void> {
    const response = await this.options.requestClient.request({
      url: `${this.options.baseUrl}/api/plugin/agent/connect/get-messages`
        + `?access_token=${encodeURIComponent(token)}`,
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(
        `SystemSculpt could not restore this chat (${response.status}).`,
      );
    }
    if (!this.emit(await response.text())) {
      throw new Error("SystemSculpt returned an unusable chat snapshot.");
    }
  }

  public async sendSubmit(
    command: AgentSubmitCommand | AgentRegenerateCommand,
  ): Promise<void> {
    const parsed = parseAgentCommand(command);
    if (parsed.kind !== "submit" && parsed.kind !== "regenerate") {
      throw new TypeError("sendSubmit accepts only submit and regenerate commands.");
    }
    return this.runTurn(parsed);
  }

  public async sendToolResult(
    command: AgentToolResultCommand,
  ): Promise<void> {
    const parsed = parseAgentCommand(command);
    if (parsed.kind !== "client_tool_result") {
      throw new TypeError("sendToolResult accepts only client tool results.");
    }
    return this.runTurn(parsed);
  }

  public async sendApproval(
    command: AgentApprovalCommand,
  ): Promise<void> {
    const parsed = parseAgentCommand(command);
    if (parsed.kind !== "client_tool_approval") {
      throw new TypeError("sendApproval accepts only client tool approvals.");
    }
    return this.runTurn(parsed);
  }

  public async sendCancel(
    command: AgentCancelCommand,
  ): Promise<void> {
    const parsed = parseAgentCommand(command);
    if (parsed.kind !== "cancel") {
      throw new TypeError("sendCancel accepts only cancellation commands.");
    }
    // Cancelling aborts the stream this transport is holding as well as
    // telling the server, so a user who stops a run is not left waiting on a
    // response for work that is being torn down.
    this.inFlight?.abort();
    return this.runTurn(parsed);
  }

  public close(): void {
    this.disposed = true;
    this.inFlight?.abort();
    this.inFlight = null;
    this.setState("closed");
  }

  private setState(next: AgentConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of this.stateListeners) listener(next);
  }

  private async ensureAccess(): Promise<string> {
    const current = this.access;
    if (current && current.expiresAt - Date.now() > ACCESS_REFRESH_MARGIN_MS) {
      return current.token;
    }
    const response = await this.options.requestClient.request({
      url: `${this.options.baseUrl}/api/plugin/agent/bootstrap`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-license-key": this.options.licenseKey(),
        "x-plugin-version": this.options.pluginVersion,
      },
      // The request client serializes the body itself.
      body: this.options.bootstrapRequest(),
    });
    if (!response.ok) {
      throw new Error(
        `SystemSculpt could not start this chat (${response.status}).`,
      );
    }
    const body = await response.json() as {
      access?: { token?: unknown; expires_at?: unknown };
    };
    const token = typeof body.access?.token === "string" ? body.access.token : "";
    if (!token) throw new Error("SystemSculpt returned an unusable chat session.");
    const expiresAt = typeof body.access?.expires_at === "string"
      ? Date.parse(body.access.expires_at)
      : Number.NaN;
    this.access = {
      token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30_000,
    };
    return token;
  }

  /**
   * Sends one command and consumes the authoritative events its response
   * streams, resolving when the server closes the stream at the turn boundary.
   */
  private async runTurn(command: unknown): Promise<void> {
    if (this.disposed) return;
    const token = await this.ensureAccess();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const response = await this.options.requestClient.request({
        url: `${this.options.baseUrl}/api/plugin/agent/turn`
          + `?access_token=${encodeURIComponent(token)}`,
        method: "POST",
        // stream selects the direct-fetch transport, which is the only one
        // that delivers frames as they are produced rather than buffering the
        // whole turn. The request client serializes the body itself; handing
        // it an already-encoded string would send a JSON string literal.
        stream: true,
        body: command,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `SystemSculpt could not run this message (${response.status}).`,
        );
      }
      await this.consume(response.body);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.emit(chunk);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Returns whether the chunk was delivered as an authoritative frame. A
   * dropped frame is tolerable mid-stream but fatal for the snapshot, so the
   * outcome has to be observable rather than silent.
   */
  private emit(chunk: string): boolean {
    const payload = chunk.startsWith("data: ") ? chunk.slice(6) : chunk;
    if (!payload.trim()) return false;
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      // A frame the transport cannot parse is not authoritative; dropping it
      // is safer than surfacing a partial event as conversation state.
      return false;
    }
    if (this.options.isAuthoritativeFrame
      && !this.options.isAuthoritativeFrame(frame)) return false;
    for (const listener of this.frameListeners) {
      listener(frame as AgentServerEvent);
    }
    return true;
  }
}
