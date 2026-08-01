import type { PlatformRequestClient } from "../../../services/PlatformRequestClient";
import type { ThinAgentBootstrapRequest } from "../../../services/managed/ThinAgentV1Contract";
import {
  parseFirstPartyThinAgentCommand,
  type FirstPartyThinAgentApprovalCommand,
  type FirstPartyThinAgentCancelCommand,
  type FirstPartyThinAgentRegenerateCommand,
  type FirstPartyThinAgentServerEvent,
  type FirstPartyThinAgentSubmitCommand,
  type FirstPartyThinAgentToolResultCommand,
} from "./FirstPartyThinAgentProtocol";
import type {
  FirstPartyThinAgentConnectionPort,
} from "./FirstPartyThinAgentSession";
import type {
  FirstPartyThinAgentConnectionState,
} from "./FirstPartyThinAgentSessionTransport";

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

export type FirstPartyThinAgentStreamingTransportOptions = Readonly<{
  baseUrl: string;
  licenseKey: () => string;
  pluginVersion: string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  requestClient: PlatformRequestClient;
  isAuthoritativeFrame?: (value: unknown) => boolean;
}>;

type BootstrapAccess = Readonly<{ token: string; expiresAt: number }>;

const ACCESS_REFRESH_MARGIN_MS = 5_000;

export class FirstPartyThinAgentStreamingTransport
implements FirstPartyThinAgentConnectionPort {
  private connectionState: FirstPartyThinAgentConnectionState = "idle";
  private readonly frameListeners =
    new Set<(frame: FirstPartyThinAgentServerEvent) => void>();
  private readonly stateListeners =
    new Set<(state: FirstPartyThinAgentConnectionState) => void>();
  private access: BootstrapAccess | null = null;
  private inFlight: AbortController | null = null;
  private disposed = false;

  public constructor(
    private readonly options: FirstPartyThinAgentStreamingTransportOptions,
  ) {}

  public get state(): FirstPartyThinAgentConnectionState {
    return this.connectionState;
  }

  public addAuthoritativeFrameListener(
    listener: (frame: FirstPartyThinAgentServerEvent) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }

  public addConnectionStateListener(
    listener: (state: FirstPartyThinAgentConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /**
   * Establishes identity only. There is no socket to hold, so a successful
   * bootstrap is the whole of "connected".
   */
  public async connect(): Promise<void> {
    this.disposed = false;
    this.setState("connecting");
    await this.ensureAccess();
    this.setState("open");
  }

  public async sendSubmit(
    command: FirstPartyThinAgentSubmitCommand | FirstPartyThinAgentRegenerateCommand,
  ): Promise<void> {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "submit" && parsed.kind !== "regenerate") {
      throw new TypeError("sendSubmit accepts only submit and regenerate commands.");
    }
    return this.runTurn(parsed);
  }

  public async sendToolResult(
    command: FirstPartyThinAgentToolResultCommand,
  ): Promise<void> {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "client_tool_result") {
      throw new TypeError("sendToolResult accepts only client tool results.");
    }
    return this.runTurn(parsed);
  }

  public async sendApproval(
    command: FirstPartyThinAgentApprovalCommand,
  ): Promise<void> {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "client_tool_approval") {
      throw new TypeError("sendApproval accepts only client tool approvals.");
    }
    return this.runTurn(parsed);
  }

  public async sendCancel(
    command: FirstPartyThinAgentCancelCommand,
  ): Promise<void> {
    const parsed = parseFirstPartyThinAgentCommand(command);
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

  private setState(next: FirstPartyThinAgentConnectionState): void {
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
      body: JSON.stringify(this.options.bootstrapRequest()),
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
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

  private emit(chunk: string): void {
    const payload = chunk.startsWith("data: ") ? chunk.slice(6) : chunk;
    if (!payload.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      // A frame the transport cannot parse is not authoritative; dropping it
      // is safer than surfacing a partial event as conversation state.
      return;
    }
    if (this.options.isAuthoritativeFrame
      && !this.options.isAuthoritativeFrame(frame)) return;
    for (const listener of this.frameListeners) {
      listener(frame as FirstPartyThinAgentServerEvent);
    }
  }
}
