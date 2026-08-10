import {
  getPlatformResponseDeliveryMode,
  type PlatformRequestClient,
  type PlatformResponseDeliveryMode,
} from "../../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_CONNECTIVITY_PATH,
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
  type AgentCommandKind,
  type AgentRegenerateCommand,
  type AgentServerEvent,
  type AgentSubmitCommand,
  type AgentToolResultCommand,
} from "./Protocol";
import { parseBoundedServerTiming } from "../../../utils/serverTiming";
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
  requestClient: Pick<PlatformRequestClient, "request">
    & Partial<Pick<PlatformRequestClient, "prewarmStreamingFetch">>;
  isAuthoritativeFrame?: (value: unknown) => boolean;
  monotonicNow?: () => number;
  onTiming?: (event: AgentTransportTimingEvent) => void;
  classifyResponseDelivery?: (
    response: Response,
  ) => PlatformResponseDeliveryMode | undefined;
}>;

export type AgentTransportTimingEvent = Readonly<{
  milestone:
    | "command_dispatch_started"
    | "response_available"
    | "first_body_chunk"
    | "first_sse_frame"
    | "first_assistant_sse_frame"
    | "assistant_sse_frame_delivery_completed"
    | "command_ack_sse_frame"
    | "command_ack_sse_frame_delivery_completed"
    | "terminal_sse_frame"
    | "terminal_sse_frame_delivery_completed";
  requestId: string;
  commandKind: AgentCommandKind;
  commandSegmentOrdinal: number;
  toolCallId?: string;
  observedAtMonotonicMs: number;
  responseDeliveryMode?: PlatformResponseDeliveryMode;
  status?: number;
  latencyTraceId?: string;
  serverTimingAppMs?: number;
  serverTimingAuthMs?: number;
}>;

type BootstrapAccess = Readonly<{
  response: ThinAgentBootstrapResponse;
  expiresAt: number;
}>;

const ACCESS_REFRESH_MARGIN_MS = 5_000;
const MAX_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024 * 1024;
const LATENCY_TRACE_HEADER = "x-systemsculpt-agent-latency-trace";
const LATENCY_TRACE_ID = /^[a-f0-9]{32}$/u;
const AGENT_SERVER_TIMING_NAMES = Object.freeze({
  app: "appMs",
  auth: "authMs",
} as const);

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

async function responseErrorPayload(response: Response): Promise<Readonly<{
  code?: string;
  incidentId?: string;
}>> {
  try {
    const text = await readBoundedText(response, 4_096);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const nested = record.error && typeof record.error === "object"
      && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : {};
    const code = nested.code ?? record.code;
    const incidentId = nested.incident_id ?? record.incident_id;
    return {
      ...(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
        ? { code }
        : {}),
      ...(typeof incidentId === "string" && /^incident_[a-f0-9]{32}$/u.test(incidentId)
        ? { incidentId }
        : {}),
    };
  } catch {
    return {};
  }
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

const SSE_FRAGMENT_FLUSH_COUNT = 1_024;
const SSE_BOUNDARY_PREFIXES = ["\r\n\r", "\r\n", "\n\r", "\r", "\n"] as const;

function trailingBoundaryPrefixLength(value: string): number {
  for (const prefix of SSE_BOUNDARY_PREFIXES) {
    if (value.endsWith(prefix)) return prefix.length;
  }
  return 0;
}

function segmentFrameKind(
  frame: unknown,
  conversationId: string,
  command: Readonly<{
    requestId: string;
    commandKind: AgentCommandKind;
    toolCallId?: string;
  }>,
): "assistant_snapshot" | "command_ack" | "terminal" | null {
  let parsed: AgentServerEvent;
  try {
    parsed = parseAgentServerEvent(frame, conversationId);
  } catch {
    return null;
  }
  if (
    parsed.kind === "assistant_snapshot"
    && parsed.request_id === command.requestId
  ) return "assistant_snapshot";
  if (
    parsed.kind === "terminal"
    && parsed.request_id === command.requestId
  ) return "terminal";
  if (
    parsed.kind !== "command_ack"
    || parsed.request_id !== command.requestId
    || parsed.command_kind !== command.commandKind
  ) return null;
  if (
    (parsed.command_kind === "client_tool_result"
      || parsed.command_kind === "client_tool_approval")
    && parsed.tool_call_id !== command.toolCallId
  ) return null;
  return "command_ack";
}

async function cancelReaderSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Closing a stale stream is best effort. The generation gate still blocks
    // every callback after detach.
  }
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
  private nextCommandSegmentOrdinal = 0;

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
    if (this.disposed) {
      throw new Error("This chat connection is closed.");
    }
    const generation = ++this.connectGeneration;
    this.setState("connecting");
    try {
      // The replay-safe CORS decision is observational and shares its in-flight
      // request with an immediate submit. It must not hold session readiness
      // for the probe timeout when bootstrap and synchronization are complete.
      void this.prewarmStreamingTransport();
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

  /**
   * Replaces every command stream that belonged to the previous connection
   * generation with a fresh authoritative snapshot.
   *
   * A Worker restart can leave fetch's response reader open even though its
   * upstream will never publish another byte. `connect()` advances the
   * generation synchronously, so callbacks from those readers are fenced
   * before the snapshot request begins. The readers are aborted only after the
   * replacement synchronization settles, allowing a terminal snapshot to win
   * before the command promise unwinds.
   */
  public async forceReconnect(): Promise<void> {
    if (this.disposed) {
      throw new Error("This chat connection is closed.");
    }
    const superseded = [...this.inFlight];
    try {
      await this.connect();
    } finally {
      for (const controller of superseded) controller.abort();
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

  /** Marks a clean-but-incomplete turn stream as requiring fresh authority. */
  public markUnsynchronized(): void {
    if (!this.disposed) this.setState("closed");
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
      url: `${this.options.baseUrl}${THIN_AGENT_MESSAGES_PATH}`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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
      || !this.emitValue(value, generation)) {
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

  private async prewarmStreamingTransport(): Promise<void> {
    const prewarm = this.options.requestClient.prewarmStreamingFetch;
    if (!prewarm) return;
    try {
      await prewarm.call(
        this.options.requestClient,
        `${this.options.baseUrl}${THIN_AGENT_CONNECTIVITY_PATH}`,
      );
    } catch {
      // Prewarming is observational. The state-changing request still performs
      // the bounded safe probe on demand and retains its no-POST-replay fence.
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
      const payload = await responseErrorPayload(response);
      throw Object.assign(new Error(
        `SystemSculpt could not start this chat (${response.status}).`,
      ), {
        ...(payload.code ? { code: payload.code } : {}),
        ...(payload.incidentId ? { requestId: payload.incidentId } : {}),
        status: response.status,
        retryable: response.status === 401 || response.status === 429
          || response.status >= 500,
      });
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
  private async runTurn(command:
    | AgentSubmitCommand
    | AgentRegenerateCommand
    | AgentToolResultCommand
    | AgentApprovalCommand
    | AgentCancelCommand
  ): Promise<void> {
    if (this.disposed) return;
    const generation = this.connectGeneration;
    const bootstrap = (await this.ensureBootstrap()).response;
    const token = bootstrap.access.token;
    if (!this.isCurrentDelivery(generation)) return;
    const commandSegmentOrdinal = ++this.nextCommandSegmentOrdinal;
    const commandTiming = {
      requestId: command.request_id,
      commandKind: command.kind,
      commandSegmentOrdinal,
      ...(command.kind === "client_tool_result"
        || command.kind === "client_tool_approval"
        ? { toolCallId: command.tool_call_id }
        : {}),
    } as const;
    this.reportTiming({
      milestone: "command_dispatch_started",
      ...commandTiming,
      observedAtMonotonicMs: this.monotonicNow(),
    });
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const response = await this.options.requestClient.request({
        url: `${this.options.baseUrl}${THIN_AGENT_TURN_PATH}`,
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        // stream selects the direct-fetch transport, which is the only one
        // that delivers frames as they are produced rather than buffering the
        // whole turn. The request client serializes the body itself; handing
        // it an already-encoded string would send a JSON string literal.
        stream: true,
        preserveResponseHeaders: true,
        // Prove direct CORS readability with a replay-safe GET before choosing
        // the transport for this state-changing command. A failed probe may
        // select requestUrl once up front; a failed POST must never be replayed.
        streamingProbeUrl:
          `${this.options.baseUrl}${THIN_AGENT_CONNECTIVITY_PATH}`,
        // A direct fetch can fail after the server has admitted this command.
        // Reconcile from authoritative state before any idempotent replay;
        // never immediately send the same state-changing POST through the
        // buffered requestUrl transport.
        allowTransportFallback: false,
        body: command,
        signal: controller.signal,
      });
      const responseDeliveryMode = this.options.classifyResponseDelivery?.(response)
        ?? getPlatformResponseDeliveryMode(response);
      const latencyTraceHeader = response.headers.get(LATENCY_TRACE_HEADER);
      this.reportTiming({
        milestone: "response_available",
        ...commandTiming,
        observedAtMonotonicMs: this.monotonicNow(),
        ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
        status: response.status,
        ...(latencyTraceHeader && LATENCY_TRACE_ID.test(latencyTraceHeader)
          ? { latencyTraceId: latencyTraceHeader }
          : {}),
        ...(() => {
          const serverTiming = parseBoundedServerTiming(
            response.headers.get("server-timing"),
            {
              fields: AGENT_SERVER_TIMING_NAMES,
              maximumHeaderLength: 4_096,
              maximumEntries: 2_048,
            },
          );
          const serverTimingAppMs = serverTiming?.appMs;
          const serverTimingAuthMs = serverTiming?.authMs;
          return {
            ...(serverTimingAppMs === undefined ? {} : { serverTimingAppMs }),
            ...(serverTimingAuthMs === undefined ? {} : { serverTimingAuthMs }),
          };
        })(),
      });
      if (!response.ok || !response.body) {
        if (response.status === 401) this.access = null;
        const payload = response.ok ? {} : await responseErrorPayload(response);
        const serverAdmissionPossible = ![
          400,
          402,
          404,
          405,
          413,
          422,
          429,
        ].includes(response.status);
        throw Object.assign(new Error(
          `SystemSculpt could not run this message (${response.status}).`,
        ), {
          ...(payload.code ? { code: payload.code } : {}),
          ...(payload.incidentId ? { requestId: payload.incidentId } : {}),
          status: response.status,
          serverAdmissionPossible,
        });
      }
      await this.consume(
        response.body,
        generation,
        controller.signal,
        commandTiming,
        responseDeliveryMode,
        latencyTraceHeader && LATENCY_TRACE_ID.test(latencyTraceHeader)
          ? latencyTraceHeader
          : undefined,
        bootstrap.conversation_id,
      );
    } catch (error) {
      if (!this.disposed && generation !== this.connectGeneration) {
        // A newer authoritative synchronization owns the connection now.
        // This command may already be durable, so neither a stale pre-abort
        // error nor the intentional retirement can imply replay or failure.
        return;
      }
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

  private async consume(
    body: ReadableStream<Uint8Array>,
    generation: number,
    signal: AbortSignal,
    commandTiming: Readonly<{
      requestId: string;
      commandKind: AgentCommandKind;
      commandSegmentOrdinal: number;
      toolCallId?: string;
    }>,
    responseDeliveryMode?: PlatformResponseDeliveryMode,
    latencyTraceId?: string,
    conversationId?: string,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    const eventBoundary = /\r?\n\r?\n/gu;
    let boundaryPrefix = "";
    let eventBytes = 0;
    let fragments: string[] = [];
    let fragmentBatch: string[] = [];
    let firstRawChunkObserved = false;
    let firstSseFrameObserved = false;
    let firstAssistantFrame: unknown;
    let commandAckFrame: unknown;
    let terminalFrame: unknown;

    const observeAcceptedFrame = (
      frame: unknown,
      stage: "parsed" | "delivered",
    ): void => {
      if (stage === "parsed" && !firstSseFrameObserved) {
        firstSseFrameObserved = true;
        this.reportTiming({
          milestone: "first_sse_frame",
          ...commandTiming,
          observedAtMonotonicMs: this.monotonicNow(),
          ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
          ...(latencyTraceId ? { latencyTraceId } : {}),
        });
      }
      if (!conversationId) return;
      const kind = segmentFrameKind(frame, conversationId, commandTiming);
      if (stage === "parsed") {
        if (kind === "assistant_snapshot" && firstAssistantFrame === undefined) {
          firstAssistantFrame = frame;
          this.reportTiming({
            milestone: "first_assistant_sse_frame",
            ...commandTiming,
            observedAtMonotonicMs: this.monotonicNow(),
            ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
            ...(latencyTraceId ? { latencyTraceId } : {}),
          });
        } else if (kind === "command_ack" && commandAckFrame === undefined) {
          commandAckFrame = frame;
          this.reportTiming({
            milestone: "command_ack_sse_frame",
            ...commandTiming,
            observedAtMonotonicMs: this.monotonicNow(),
            ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
            ...(latencyTraceId ? { latencyTraceId } : {}),
          });
        } else if (kind === "terminal" && terminalFrame === undefined) {
          terminalFrame = frame;
          this.reportTiming({
            milestone: "terminal_sse_frame",
            ...commandTiming,
            observedAtMonotonicMs: this.monotonicNow(),
            ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
            ...(latencyTraceId ? { latencyTraceId } : {}),
          });
        }
        return;
      }
      const milestone = frame === firstAssistantFrame
        ? "assistant_sse_frame_delivery_completed"
        : frame === commandAckFrame
          ? "command_ack_sse_frame_delivery_completed"
          : frame === terminalFrame
            ? "terminal_sse_frame_delivery_completed"
            : null;
      if (!milestone) return;
      this.reportTiming({
        milestone,
        ...commandTiming,
        observedAtMonotonicMs: this.monotonicNow(),
        ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
        ...(latencyTraceId ? { latencyTraceId } : {}),
      });
    };

    const appendEventText = (text: string): void => {
      if (!text) return;
      eventBytes += encoder.encode(text).byteLength;
      if (eventBytes > MAX_EVENT_BYTES) {
        throw new Error("SystemSculpt returned an oversized session event.");
      }
      fragmentBatch.push(text);
      if (fragmentBatch.length >= SSE_FRAGMENT_FLUSH_COUNT) {
        fragments.push(fragmentBatch.join(""));
        fragmentBatch = [];
      }
    };
    const takeEventText = (): string => {
      if (fragmentBatch.length > 0) fragments.push(fragmentBatch.join(""));
      const event = fragments.join("");
      fragments = [];
      fragmentBatch = [];
      eventBytes = 0;
      return event;
    };
    const consumeDecodedText = (text: string): void => {
      const input = boundaryPrefix + text;
      boundaryPrefix = "";
      eventBoundary.lastIndex = 0;
      let start = 0;
      for (let match = eventBoundary.exec(input);
        match;
        match = eventBoundary.exec(input)) {
        appendEventText(input.slice(start, match.index));
        if (!this.emit(
          takeEventText(),
          generation,
          signal,
          observeAcceptedFrame,
        )) {
          throw new Error("SystemSculpt returned an invalid session event.");
        }
        start = match.index + match[0].length;
      }
      const remainder = input.slice(start);
      const retainedLength = trailingBoundaryPrefixLength(remainder);
      const appendThrough = remainder.length - retainedLength;
      appendEventText(remainder.slice(0, appendThrough));
      boundaryPrefix = remainder.slice(appendThrough);
    };

    const cancelReader = (): void => {
      void cancelReaderSafely(reader);
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    if (signal.aborted) cancelReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!this.isCurrentDelivery(generation, signal)) {
          await cancelReaderSafely(reader);
          return;
        }
        if (done) break;
        if (!firstRawChunkObserved && value.byteLength > 0) {
          firstRawChunkObserved = true;
          this.reportTiming({
            milestone: "first_body_chunk",
            ...commandTiming,
            observedAtMonotonicMs: this.monotonicNow(),
            ...(responseDeliveryMode ? { responseDeliveryMode } : {}),
            ...(latencyTraceId ? { latencyTraceId } : {}),
          });
        }
        consumeDecodedText(decoder.decode(value, { stream: true }));
      }
      if (!this.isCurrentDelivery(generation, signal)) return;
      consumeDecodedText(decoder.decode());
      appendEventText(boundaryPrefix);
      boundaryPrefix = "";
      if (eventBytes > 0) {
        const finalEvent = takeEventText();
        if (finalEvent.trim()
          && !this.emit(
            finalEvent,
            generation,
            signal,
            observeAcceptedFrame,
          )) {
          throw new Error("SystemSculpt returned an invalid session event.");
        }
      }
    } finally {
      signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
  }

  /** Returns whether a complete SSE event became an authoritative frame. */
  private emit(
    chunk: string,
    generation = this.connectGeneration,
    signal?: AbortSignal,
    onAccepted?: (frame: unknown, stage: "parsed" | "delivered") => void,
  ): boolean {
    if (!this.isCurrentDelivery(generation, signal)) return true;
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
    return this.emitValue(frame, generation, signal, onAccepted);
  }

  private emitValue(
    frame: unknown,
    generation = this.connectGeneration,
    signal?: AbortSignal,
    onAccepted?: (frame: unknown, stage: "parsed" | "delivered") => void,
  ): boolean {
    if (!this.isCurrentDelivery(generation, signal)) return true;
    if (this.options.isAuthoritativeFrame
      && !this.options.isAuthoritativeFrame(frame)) return false;
    onAccepted?.(frame, "parsed");
    for (const listener of this.frameListeners) {
      if (!this.isCurrentDelivery(generation, signal)) return true;
      listener(frame as AgentServerEvent);
    }
    onAccepted?.(frame, "delivered");
    return true;
  }

  private isCurrentDelivery(
    generation: number,
    signal?: AbortSignal,
  ): boolean {
    return !this.disposed
      && generation === this.connectGeneration
      && signal?.aborted !== true;
  }

  private monotonicNow(): number {
    try {
      const value = this.options.monotonicNow?.()
        ?? (typeof performance !== "undefined" ? performance.now() : 0);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return typeof performance !== "undefined" ? performance.now() : 0;
    }
  }

  private reportTiming(event: AgentTransportTimingEvent): void {
    try {
      this.options.onTiming?.(Object.freeze(event));
    } catch {
      // Timing diagnostics are observational and cannot affect delivery.
    }
  }
}
