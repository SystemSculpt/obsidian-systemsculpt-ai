import type { PlatformRequestClient } from "../../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_MESSAGES_PATH,
  THIN_AGENT_TURN_PATH,
  parseThinAgentBootstrapResponse,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
} from "../../../services/managed/ThinAgentV1Contract";
import {
  parseAgentCommand,
  parseAgentServerEvent,
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
 * A turn is one request whose response streams authoritative events and then
 * ends. The server terminates a segment at each client-tool boundary and
 * restores the next segment from durable state.
 *
 * HTTP delivery can still fail after the server accepts a command. The
 * transport marks that outcome unsynchronized. Its owner then obtains a fresh
 * snapshot before it replays the same idempotent command.
 */

export type AgentStreamingTransportOptions = Readonly<{
  baseUrl: string;
  licenseKey: () => string;
  pluginVersion: string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  requestClient: Pick<PlatformRequestClient, "request">;
  isAuthoritativeFrame?: (value: unknown) => boolean;
}>;

type BootstrapAccess = Readonly<{
  response: ThinAgentBootstrapResponse;
  expiresAt: number;
}>;

const ACCESS_REFRESH_MARGIN_MS = 5_000;
const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024 * 1024;

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("SystemSculpt returned an oversized chat snapshot.");
  }
  if (!response.body) {
    throw new Error("SystemSculpt returned an empty chat snapshot.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new Error("SystemSculpt returned an oversized chat snapshot.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isInitialSessionSnapshot(
  value: unknown,
  conversationId: string,
): boolean {
  try {
    return parseAgentServerEvent(value, conversationId).kind
      === "session_snapshot";
  } catch {
    return false;
  }
}

function nextEventBoundary(buffer: string): Readonly<{
  index: number;
  length: number;
}> | null {
  const match = /\r?\n\r?\n/u.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

export class AgentStreamingTransport
implements AgentConnectionPort {
  private connectionState: AgentConnectionState = "idle";
  private readonly frameListeners =
    new Set<(frame: AgentServerEvent) => void>();
  private readonly stateListeners =
    new Set<(state: AgentConnectionState) => void>();
  private access: BootstrapAccess | null = null;
  private accessRequest: Promise<BootstrapAccess> | null = null;
  private readonly inFlight = new Set<AbortController>();
  private disposed = false;
  private connectGeneration = 0;

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
   * transport reads that snapshot over HTTP.
   */
  public async connect(): Promise<void> {
    this.disposed = false;
    const generation = ++this.connectGeneration;
    this.setState("connecting");
    try {
      const bootstrap = (await this.ensureBootstrap()).response;
      if (this.disposed || generation !== this.connectGeneration) return;
      await this.synchronize(
        bootstrap.access.token,
        bootstrap.conversation_id,
        generation,
      );
      if (this.disposed || generation !== this.connectGeneration) return;
      this.setState("open");
    } catch (error) {
      if (!this.disposed && generation === this.connectGeneration) {
        this.setState("closed");
      }
      throw error;
    }
  }

  /** Returns the same validated bootstrap used to authenticate this session. */
  public async bootstrap(): Promise<ThinAgentBootstrapResponse> {
    return (await this.ensureBootstrap()).response;
  }

  /** Invalidates access rejected by another HTTP route for this session. */
  public invalidateBootstrap(): void {
    this.access = null;
  }

  /**
   * Delivers the authoritative session snapshot while the transport is still
   * connecting, so the state it publishes on open is already synchronized.
   */
  private async synchronize(
    token: string,
    conversationId: string,
    generation: number,
  ): Promise<void> {
    const response = await this.options.requestClient.request({
      url: `${this.options.baseUrl}${THIN_AGENT_MESSAGES_PATH}`
        + `?access_token=${encodeURIComponent(token)}`,
      method: "GET",
    });
    if (this.disposed || generation !== this.connectGeneration) return;
    if (!response.ok) {
      if (response.status === 401) this.access = null;
      throw new Error(
        `SystemSculpt could not restore this chat (${response.status}).`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(
        await readBoundedText(response, MAX_SNAPSHOT_BYTES),
      ) as unknown;
    } catch (error) {
      if (this.disposed || generation !== this.connectGeneration) return;
      if (error instanceof Error
        && error.message.includes("oversized chat snapshot")) {
        throw error;
      }
      throw new Error("SystemSculpt returned an unusable chat snapshot.");
    }
    if (this.disposed || generation !== this.connectGeneration) return;
    if (!isInitialSessionSnapshot(value, conversationId)
      || !this.emitValue(value)) {
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
    // Cancelling aborts every response stream this session holds before it
    // tells the server. Parallel tool-result streams must not keep a stopped
    // run attached to this renderer.
    for (const controller of this.inFlight) controller.abort();
    return this.runTurn(parsed);
  }

  public close(): void {
    this.disposed = true;
    this.connectGeneration += 1;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.setState("closed");
  }

  private setState(next: AgentConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of this.stateListeners) listener(next);
  }

  private async ensureBootstrap(): Promise<BootstrapAccess> {
    const current = this.access;
    if (current && current.expiresAt - Date.now() > ACCESS_REFRESH_MARGIN_MS) {
      return current;
    }
    if (this.accessRequest) return this.accessRequest;

    const request = this.requestBootstrap();
    this.accessRequest = request;
    try {
      const access = await request;
      this.access = access;
      return access;
    } finally {
      if (this.accessRequest === request) this.accessRequest = null;
    }
  }

  private async requestBootstrap(): Promise<BootstrapAccess> {
    const request = this.options.bootstrapRequest();
    const response = await this.options.requestClient.request({
      url: `${this.options.baseUrl}${THIN_AGENT_BOOTSTRAP_PATH}`,
      method: "POST",
      headers: { "x-plugin-version": this.options.pluginVersion },
      licenseKey: this.options.licenseKey(),
      body: request,
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: MAX_BOOTSTRAP_RESPONSE_BYTES,
    });
    if (!response.ok) {
      throw new Error(
        `SystemSculpt could not start this chat (${response.status}).`,
      );
    }
    const value = JSON.parse(
      await readBoundedText(response, MAX_BOOTSTRAP_RESPONSE_BYTES),
    ) as unknown;
    const bootstrap = parseThinAgentBootstrapResponse(value, {
      conversation_id: request.conversation_id,
    });
    const expiresAt = Date.parse(bootstrap.access.expires_at);
    return {
      response: bootstrap,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30_000,
    };
  }

  /**
   * Sends one command and consumes the authoritative events its response
   * streams, resolving when the server closes the stream at the turn boundary.
   */
  private async runTurn(command: unknown): Promise<void> {
    if (this.disposed) return;
    const token = (await this.ensureBootstrap()).response.access.token;
    if (this.disposed) return;
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const response = await this.options.requestClient.request({
        url: `${this.options.baseUrl}${THIN_AGENT_TURN_PATH}`
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
        if (response.status === 401) this.access = null;
        const serverAdmissionPossible = ![
          400,
          404,
          405,
          413,
          422,
          429,
        ].includes(response.status);
        throw Object.assign(new Error(
          `SystemSculpt could not run this message (${response.status}).`,
        ), {
          status: response.status,
          serverAdmissionPossible,
        });
      }
      await this.consume(response.body);
    } catch (error) {
      const definitelyRejected = error !== null
        && typeof error === "object"
        && "serverAdmissionPossible" in error
        && (error as { serverAdmissionPossible?: unknown })
          .serverAdmissionPossible === false;
      if (!controller.signal.aborted && !this.disposed && !definitelyRejected) {
        this.setState("closed");
      }
      throw error;
    } finally {
      this.inFlight.delete(controller);
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    let buffer = "";
    let bufferBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bufferBytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        let boundary = nextEventBoundary(buffer);
        while (boundary) {
          const chunk = buffer.slice(0, boundary.index);
          if (encoder.encode(chunk).byteLength > MAX_EVENT_BYTES) {
            throw new Error("SystemSculpt returned an oversized session event.");
          }
          const consumedCharacters = boundary.index + boundary.length;
          bufferBytes -= encoder.encode(
            buffer.slice(0, consumedCharacters),
          ).byteLength;
          buffer = buffer.slice(consumedCharacters);
          if (!this.emit(chunk)) {
            throw new Error("SystemSculpt returned an invalid session event.");
          }
          boundary = nextEventBoundary(buffer);
        }
        if (bufferBytes > MAX_EVENT_BYTES) {
          throw new Error("SystemSculpt returned an oversized session event.");
        }
      }
      buffer += decoder.decode();
      if (bufferBytes > MAX_EVENT_BYTES) {
        throw new Error("SystemSculpt returned an oversized session event.");
      }
      if (buffer.trim() && !this.emit(buffer)) {
        throw new Error("SystemSculpt returned an invalid session event.");
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Returns whether a complete SSE event became an authoritative frame. */
  private emit(chunk: string): boolean {
    const lines = chunk.split(/\r?\n/u);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""));
    if (data.length === 0) {
      return lines.every((line) => {
        const trimmed = line.trim();
        return !trimmed
          || trimmed.startsWith(":")
          || /^(?:event|id|retry):/u.test(trimmed);
      });
    }
    const payload = data.join("\n");
    if (!payload.trim()) return true;
    let frame: unknown;
    try {
      frame = JSON.parse(payload) as unknown;
    } catch {
      // A frame the transport cannot parse is not authoritative; dropping it
      // is safer than surfacing a partial event as conversation state.
      return false;
    }
    return this.emitValue(frame);
  }

  private emitValue(frame: unknown): boolean {
    if (this.options.isAuthoritativeFrame
      && !this.options.isAuthoritativeFrame(frame)) return false;
    for (const listener of this.frameListeners) {
      listener(frame as AgentServerEvent);
    }
    return true;
  }
}
