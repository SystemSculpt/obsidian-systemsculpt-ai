import { PlatformRequestClient } from "../../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_CONNECT_PATH,
  parseThinAgentBootstrapRequest,
  parseThinAgentBootstrapResponse,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
} from "../../../services/managed/ThinAgentV1Contract";
import {
  FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE,
  canonicalFirstPartyThinAgentRunState,
  parseFirstPartyThinAgentCommand,
  parseFirstPartyThinAgentDiagnosticPayload,
  parseFirstPartyThinAgentServerEvent,
  type FirstPartyThinAgentApprovalCommand,
  type FirstPartyThinAgentCancelCommand,
  type FirstPartyThinAgentDiagnosticPayload,
  type FirstPartyThinAgentRegenerateCommand,
  type FirstPartyThinAgentRunState,
  type FirstPartyThinAgentServerEvent,
  type FirstPartyThinAgentSubmitCommand,
  type FirstPartyThinAgentToolResultCommand,
} from "./FirstPartyThinAgentProtocol";

const WEB_SOCKET_OPEN = 1;
const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
export const FIRST_PARTY_THIN_AGENT_MAX_WIRE_FRAME_BYTES = 96 * 1024 * 1024;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;

export interface FirstPartyThinAgentWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type FirstPartyThinAgentConnectionState =
  | "idle"
  | "connecting"
  | "synchronizing"
  | "open"
  | "reconnecting"
  | "closed";

export type FirstPartyThinAgentTransportIssue = Readonly<{
  code: string;
  message: string;
  recoverable: boolean;
}>;

type RequestClient = Pick<PlatformRequestClient, "request">;

export type FirstPartyThinAgentSessionTransportOptions = Readonly<{
  baseUrl: string;
  pluginVersion: string;
  licenseKey: () => string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  requestClient?: RequestClient;
  createWebSocket?: (url: string) => FirstPartyThinAgentWebSocket;
  reconnectDelayMs?: (attempt: number) => number;
  snapshotTimeoutMs?: number;
  onIssue?: (issue: FirstPartyThinAgentTransportIssue) => void;
}>;

type ConnectionAttempt = {
  readonly generation: number;
  readonly reconnecting: boolean;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
};

export class FirstPartyThinAgentSessionTransportError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FirstPartyThinAgentSessionTransportError";
  }
}

function unknownRunState(): FirstPartyThinAgentRunState {
  return Object.freeze({ version: null, cursor: null, state: "unknown" });
}

function messageData(event: unknown): unknown {
  return event !== null && typeof event === "object" && "data" in event
    ? (event as { data: unknown }).data
    : undefined;
}

function closeData(event: unknown): Readonly<{
  code: number;
  reason: string;
}> {
  if (event === null || typeof event !== "object") return { code: 1006, reason: "" };
  const candidate = event as { code?: unknown; reason?: unknown };
  return {
    code: typeof candidate.code === "number" ? candidate.code : 1006,
    reason: typeof candidate.reason === "string" ? candidate.reason : "",
  };
}

function boundedDelay(value: unknown): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.min(30_000, Math.floor(value as number))
    : 1_000;
}

function defaultReconnectDelay(attempt: number): number {
  return Math.min(5_000, 250 * (2 ** Math.min(attempt, 5)));
}

function websocketUrl(baseUrl: string, accessToken: string): string {
  const url = new URL(THIN_AGENT_CONNECT_PATH, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new FirstPartyThinAgentSessionTransportError(
    "invalid_origin",
    "The first-party agent origin must use HTTP or HTTPS.",
    false,
  );
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}

export class FirstPartyThinAgentSessionTransport {
  private readonly requestClient: RequestClient;
  private readonly eventListeners = new Set<
    (event: FirstPartyThinAgentServerEvent) => void
  >();
  private readonly stateListeners = new Set<
    (state: FirstPartyThinAgentConnectionState) => void
  >();
  private readonly runStateListeners = new Set<
    (state: FirstPartyThinAgentRunState) => void
  >();
  private socket: FirstPartyThinAgentWebSocket | null = null;
  private connectionState: FirstPartyThinAgentConnectionState = "idle";
  private authoritativeRunState: FirstPartyThinAgentRunState = unknownRunState();
  private lastRunStateCursor: number | null = null;
  private lastRunStateCanonical: string | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private snapshotTimer: number | null = null;
  private activeAttempt: ConnectionAttempt | null = null;
  private started = false;
  private disposed = false;

  public constructor(
    private readonly options: FirstPartyThinAgentSessionTransportOptions,
  ) {
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
    if (
      options.snapshotTimeoutMs !== undefined
      && (!Number.isFinite(options.snapshotTimeoutMs) || options.snapshotTimeoutMs < 1)
    ) throw new TypeError("Snapshot timeout must be a positive number.");
  }

  public get state(): FirstPartyThinAgentConnectionState {
    return this.connectionState;
  }

  public get runState(): FirstPartyThinAgentRunState {
    return this.authoritativeRunState;
  }

  public get isAuthoritativelyIdle(): boolean {
    return this.authoritativeRunState.state === "idle";
  }

  public get isReady(): boolean {
    return this.connectionState === "open"
      && this.socket?.readyState === WEB_SOCKET_OPEN;
  }

  public addAuthoritativeFrameListener(
    listener: (event: FirstPartyThinAgentServerEvent) => void,
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public addConnectionStateListener(
    listener: (state: FirstPartyThinAgentConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public addRunStateListener(
    listener: (state: FirstPartyThinAgentRunState) => void,
  ): () => void {
    this.runStateListeners.add(listener);
    return () => this.runStateListeners.delete(listener);
  }

  public connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new FirstPartyThinAgentSessionTransportError(
        "transport_closed",
        "The first-party agent session transport is closed.",
        false,
      ));
    }
    this.started = true;
    if (this.connectionState === "open") return Promise.resolve();
    this.clearReconnectTimer();
    return this.ensureConnectionAttempt(this.connectionState === "reconnecting");
  }

  public close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.clearReconnectTimer();
    this.clearSnapshotTimer();
    const attempt = this.activeAttempt;
    if (attempt) {
      this.rejectAttempt(attempt, new FirstPartyThinAgentSessionTransportError(
        "transport_closed",
        "The first-party agent session transport is closed.",
        false,
      ));
      attempt.controller.abort();
    }
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client closed.");
    this.setConnectionState("closed");
  }

  public sendSubmit(
    command: FirstPartyThinAgentSubmitCommand | FirstPartyThinAgentRegenerateCommand,
  ): void {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "submit" && parsed.kind !== "regenerate") {
      throw new TypeError("sendSubmit accepts only submit and regenerate commands.");
    }
    this.sendJson(parsed);
  }

  public sendToolResult(command: FirstPartyThinAgentToolResultCommand): void {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "client_tool_result") {
      throw new TypeError("sendToolResult accepts only client tool results.");
    }
    this.sendJson(parsed);
  }

  public sendApproval(command: FirstPartyThinAgentApprovalCommand): void {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "client_tool_approval") {
      throw new TypeError("sendApproval accepts only client tool approvals.");
    }
    this.sendJson(parsed);
  }

  public sendCancel(command: FirstPartyThinAgentCancelCommand): void {
    const parsed = parseFirstPartyThinAgentCommand(command);
    if (parsed.kind !== "cancel") {
      throw new TypeError("sendCancel accepts only cancellation commands.");
    }
    this.sendJson(parsed);
  }

  public sendDiagnostic(payload: FirstPartyThinAgentDiagnosticPayload): void {
    this.sendJson({
      type: FIRST_PARTY_THIN_AGENT_DIAGNOSTIC_TYPE,
      payload: parseFirstPartyThinAgentDiagnosticPayload(payload),
    });
  }

  private ensureConnectionAttempt(reconnecting: boolean): Promise<void> {
    if (this.activeAttempt) return this.activeAttempt.promise;
    const generation = ++this.generation;
    const controller = new AbortController();
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const attempt: ConnectionAttempt = {
      generation,
      reconnecting,
      controller,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
    };
    this.activeAttempt = attempt;
    this.clearSnapshotTimer();
    this.setConnectionState(reconnecting ? "reconnecting" : "connecting");
    void promise.catch((error: unknown) => {
      if (this.disposed || !this.started) return;
      this.reportIssue(error, "connection_failed", true);
      const recoverable = !(error instanceof FirstPartyThinAgentSessionTransportError)
        || error.recoverable;
      if (recoverable) {
        this.setConnectionState("reconnecting");
        this.scheduleReconnect();
      } else {
        this.started = false;
        this.setConnectionState("closed");
      }
    });
    void this.prepareConnectionAttempt(attempt).catch((error: unknown) => {
      this.rejectAttempt(
        attempt,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    return promise;
  }

  private async prepareConnectionAttempt(attempt: ConnectionAttempt): Promise<void> {
    const bootstrap = await this.issueBootstrap(attempt.controller.signal);
    if (!this.isCurrentAttempt(attempt)) return;
    const url = websocketUrl(this.options.baseUrl, bootstrap.access.token);
    const createWebSocket = this.options.createWebSocket
      ?? ((target: string) => new WebSocket(target) as unknown as FirstPartyThinAgentWebSocket);
    const socket = createWebSocket(url);
    if (!this.isCurrentAttempt(attempt)) {
      socket.close(1000, "Superseded.");
      return;
    }
    this.socket = socket;
    let synchronized = false;
    socket.addEventListener("open", () => {
      if (!this.currentAttemptSocket(attempt, socket)) return;
      this.setConnectionState("synchronizing");
      if (!this.currentAttemptSocket(attempt, socket)) return;
      this.clearSnapshotTimer();
      const timeout = this.options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
      this.snapshotTimer = window.setTimeout(() => {
        if (!this.currentAttemptSocket(attempt, socket) || synchronized) return;
        const error = new FirstPartyThinAgentSessionTransportError(
          "snapshot_timeout",
          "The authoritative session snapshot did not arrive in time.",
          true,
        );
        this.rejectAttempt(attempt, error);
        socket.close(1002, "Authoritative snapshot required.");
      }, timeout);
    });
    socket.addEventListener("message", (rawEvent) => {
      if (!this.currentSocket(attempt.generation, socket)) return;
      try {
        const accepted = this.consumeServerMessage(
          messageData(rawEvent),
          bootstrap,
          !synchronized,
        );
        if (
          !accepted
          || synchronized
          || !this.currentAttemptSocket(attempt, socket)
        ) return;
        synchronized = true;
        this.clearSnapshotTimer();
        this.reconnectAttempt = 0;
        this.setConnectionState("open");
        if (!this.currentAttemptSocket(attempt, socket)) return;
        this.resolveAttempt(attempt);
      } catch (error) {
        if (synchronized) {
          this.reportIssue(error, "invalid_server_event", true);
        }
        this.rejectAttempt(
          attempt,
          error instanceof Error ? error : new Error(String(error)),
        );
        socket.close(1002, "Invalid authoritative event.");
      }
    });
    socket.addEventListener("error", () => {
      if (!this.currentSocket(attempt.generation, socket)) return;
      this.reportIssue(
        new Error("The first-party agent socket reported an error."),
        "socket_error",
        true,
      );
    });
    socket.addEventListener("close", (rawEvent) => {
      if (!this.currentSocket(attempt.generation, socket)) return;
      this.clearSnapshotTimer();
      this.socket = null;
      const closed = closeData(rawEvent);
      const policyClose = closed.code === 1008
        || (closed.code >= 4_000 && closed.code <= 4_999);
      if (policyClose) {
        const error = new FirstPartyThinAgentSessionTransportError(
          "socket_policy_closed",
          `The first-party agent session was rejected (${closed.code}).`,
          false,
        );
        this.started = false;
        this.disposed = true;
        this.clearReconnectTimer();
        this.reportIssue(error, error.code, false);
        this.rejectAttempt(attempt, error);
        this.setConnectionState("closed");
        return;
      }
      if (!synchronized) {
        this.rejectAttempt(attempt, new FirstPartyThinAgentSessionTransportError(
          "socket_closed_before_snapshot",
          `The first-party agent session closed before synchronization (${closed.code}).`,
          true,
        ));
      }
      if (!this.disposed && this.started) {
        this.setConnectionState("reconnecting");
        this.scheduleReconnect();
      }
    });
  }

  private consumeServerMessage(
    rawData: unknown,
    bootstrap: ThinAgentBootstrapResponse,
    requiresSnapshot: boolean,
  ): boolean {
    if (typeof rawData !== "string") {
      throw new FirstPartyThinAgentSessionTransportError(
        "binary_server_event_forbidden",
        "The authoritative server event must be a text frame.",
        true,
      );
    }
    if (
      new TextEncoder().encode(rawData).byteLength
      > FIRST_PARTY_THIN_AGENT_MAX_WIRE_FRAME_BYTES
    ) {
      throw new FirstPartyThinAgentSessionTransportError(
        "server_event_too_large",
        "The authoritative server event exceeds the client safety limit.",
        true,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(rawData) as unknown;
    } catch {
      throw new FirstPartyThinAgentSessionTransportError(
        "malformed_server_event",
        "The authoritative server event is not valid JSON.",
        true,
      );
    }
    const event = parseFirstPartyThinAgentServerEvent(
      value,
      bootstrap.conversation_id,
    );
    if (requiresSnapshot && event.kind !== "session_snapshot") {
      if (event.kind === "unknown") return false;
      throw new FirstPartyThinAgentSessionTransportError(
        "session_snapshot_required",
        "A fresh connection must begin with an authoritative session snapshot.",
        true,
      );
    }
    if (event.kind === "session_snapshot" || event.kind === "run_state") {
      if (!this.applyRunState(event.run_state)) return false;
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // A presentation listener cannot mutate transport authority.
      }
    }
    return event.kind === "session_snapshot";
  }

  private applyRunState(next: FirstPartyThinAgentRunState): boolean {
    if (next.cursor === null) {
      this.setRunState(unknownRunState());
      return true;
    }
    const canonical = canonicalFirstPartyThinAgentRunState(next);
    if (this.lastRunStateCursor !== null) {
      if (next.cursor < this.lastRunStateCursor) {
        this.reportIssue(
          new Error("Ignored a stale authoritative run state."),
          "stale_run_state",
          true,
        );
        return false;
      }
      if (next.cursor === this.lastRunStateCursor) {
        if (canonical !== this.lastRunStateCanonical) {
          throw new FirstPartyThinAgentSessionTransportError(
            "run_state_conflict",
            "The server returned conflicting state for one authoritative cursor.",
            true,
          );
        }
        this.setRunState(next);
        return true;
      }
    }
    this.lastRunStateCursor = next.cursor;
    this.lastRunStateCanonical = canonical;
    this.setRunState(next);
    return true;
  }

  private async issueBootstrap(signal: AbortSignal): Promise<ThinAgentBootstrapResponse> {
    const licenseKey = this.options.licenseKey().trim();
    if (!licenseKey) {
      throw new FirstPartyThinAgentSessionTransportError(
        "license_required",
        "A SystemSculpt license is required to start the agent session.",
        false,
      );
    }
    const request = parseThinAgentBootstrapRequest(this.options.bootstrapRequest());
    const response = await this.requestClient.request({
      url: new URL(THIN_AGENT_BOOTSTRAP_PATH, this.options.baseUrl).toString(),
      method: "POST",
      headers: { "x-plugin-version": this.options.pluginVersion },
      licenseKey,
      body: request,
      signal,
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: MAX_BOOTSTRAP_RESPONSE_BYTES,
    });
    if (!response.ok) {
      throw new FirstPartyThinAgentSessionTransportError(
        "bootstrap_failed",
        `The first-party agent bootstrap failed (${response.status}).`,
        response.status === 401 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BOOTSTRAP_RESPONSE_BYTES) {
      throw new FirstPartyThinAgentSessionTransportError(
        "bootstrap_too_large",
        "The first-party agent bootstrap exceeded the client safety limit.",
        true,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new FirstPartyThinAgentSessionTransportError(
        "invalid_bootstrap",
        "The first-party agent bootstrap response is malformed.",
        true,
      );
    }
    return parseThinAgentBootstrapResponse(value, {
      conversation_id: request.conversation_id,
    });
  }

  private sendJson(value: unknown): void {
    const socket = this.socket;
    if (
      this.connectionState !== "open"
      || !socket
      || socket.readyState !== WEB_SOCKET_OPEN
    ) throw new FirstPartyThinAgentSessionTransportError(
      "session_not_ready",
      "The authoritative agent session is not ready.",
      true,
    );
    const serialized = JSON.stringify(value);
    if (
      new TextEncoder().encode(serialized).byteLength
      > FIRST_PARTY_THIN_AGENT_MAX_WIRE_FRAME_BYTES
    ) {
      throw new FirstPartyThinAgentSessionTransportError(
        "client_frame_too_large",
        "The client command exceeds the transport safety limit.",
        false,
      );
    }
    socket.send(serialized);
  }

  private scheduleReconnect(): void {
    if (
      this.disposed
      || !this.started
      || this.activeAttempt
      || this.reconnectTimer !== null
    ) return;
    const attempt = this.reconnectAttempt++;
    const delay = boundedDelay(
      this.options.reconnectDelayMs?.(attempt) ?? defaultReconnectDelay(attempt),
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.started) return;
      void this.ensureConnectionAttempt(true).catch(() => undefined);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer === null) return;
    window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  private currentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isCurrentAttempt(attempt: ConnectionAttempt): boolean {
    return !attempt.settled
      && this.activeAttempt === attempt
      && this.currentGeneration(attempt.generation);
  }

  private currentAttemptSocket(
    attempt: ConnectionAttempt,
    socket: FirstPartyThinAgentWebSocket,
  ): boolean {
    return this.isCurrentAttempt(attempt) && this.socket === socket;
  }

  private resolveAttempt(attempt: ConnectionAttempt): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (this.activeAttempt === attempt) this.activeAttempt = null;
    attempt.resolve();
  }

  private rejectAttempt(attempt: ConnectionAttempt, error: Error): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (this.activeAttempt === attempt) this.activeAttempt = null;
    attempt.reject(error);
  }

  private currentSocket(
    generation: number,
    socket: FirstPartyThinAgentWebSocket,
  ): boolean {
    return this.currentGeneration(generation) && this.socket === socket;
  }

  private setConnectionState(state: FirstPartyThinAgentConnectionState): void {
    if (this.connectionState === state) return;
    if (state !== "open" && this.authoritativeRunState.state !== "unknown") {
      this.setRunState(unknownRunState());
    }
    this.connectionState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Observers cannot alter transport state.
      }
    }
  }

  private setRunState(state: FirstPartyThinAgentRunState): void {
    this.authoritativeRunState = state;
    for (const listener of this.runStateListeners) {
      try {
        listener(state);
      } catch {
        // Observers cannot alter server authority.
      }
    }
  }

  private reportIssue(
    error: unknown,
    fallbackCode: string,
    recoverable: boolean,
  ): void {
    const typed = error instanceof FirstPartyThinAgentSessionTransportError
      ? error
      : null;
    try {
      this.options.onIssue?.({
        code: typed?.code ?? fallbackCode,
        message: error instanceof Error ? error.message : String(error),
        recoverable: typed?.recoverable ?? recoverable,
      });
    } catch {
      // Diagnostics observers cannot alter transport authority.
    }
  }
}
