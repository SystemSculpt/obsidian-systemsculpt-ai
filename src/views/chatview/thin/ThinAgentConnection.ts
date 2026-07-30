import { AgentClient } from "agents/client";
import { MessageType } from "agents/chat";
import { WebSocketChatTransport } from "agents/chat/react";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { PlatformRequestClient } from "../../../services/PlatformRequestClient";
import {
  THIN_AGENT_BOOTSTRAP_PATH,
  THIN_AGENT_CONTEXT_PATH,
  THIN_AGENT_CONNECT_PATH,
  THIN_AGENT_CONTRACT_VERSION,
  parseThinAgentBootstrapResponse,
  parseThinAgentContextRequest,
  parseThinAgentContextResponse,
  type ThinAgentBootstrapRequest,
  type ThinAgentBootstrapResponse,
  type ThinAgentContextResponse,
  type ThinAgentContextSource,
} from "../../../services/managed/ThinAgentV1Contract";
import {
  DEFAULT_THIN_AGENT_INPUT_LIMITS,
  type ThinAgentInputLimits,
} from "../../../services/managed/ThinAgentInputLimits";
import {
  type ThinAgentLifecycle,
  type ThinAgentLifecycleInput,
} from "./ThinAgentLifecycle";

export type ThinAgentConnectionOptions = Readonly<{
  baseUrl: string;
  pluginVersion: string;
  licenseKey: () => string;
  bootstrapRequest: () => ThinAgentBootstrapRequest;
  onTerminalConnectionError?: (error: Error) => void;
  lifecycle?: ThinAgentLifecycle;
  requestClient?: PlatformRequestClient;
  createAgentClient?: (options: ConstructorParameters<typeof AgentClient>[0]) => AgentClient;
  createTransport?: (agent: AgentClient, activeRequestIds: Set<string>) => WebSocketChatTransport;
}>;

export class ThinAgentConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly incidentId?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SystemSculptSessionError";
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - Date.now()) / 1_000))
    : undefined;
}

function boundedErrorPayload(text: string): Readonly<{
  code?: string;
  message?: string;
  incidentId?: string;
}> {
  if (text.length > 4_096) return {};
  try {
    const root = JSON.parse(text) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) return {};
    const record = root as Record<string, unknown>;
    const nested = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : {};
    const rawCode = nested.code ?? record.code;
    const rawMessage = nested.message ?? record.message;
    const rawIncident = nested.incident_id ?? record.incident_id;
    const code = typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(rawCode)
      ? rawCode
      : undefined;
    const message = typeof rawMessage === "string"
      && rawMessage.trim() === rawMessage
      && rawMessage.length > 0
      && rawMessage.length <= 512
      ? rawMessage
      : undefined;
    const incidentId = typeof rawIncident === "string"
      && /^incident_[a-f0-9]{32}$/.test(rawIncident)
      ? rawIncident
      : undefined;
    return { code, message, incidentId };
  } catch {
    return {};
  }
}

const INTERNAL_SERVICE_WORDING =
  /\b(?:agent connection|connection ticket|websocket|socket|transport|bootstrap|protocol|provider|openrouter|cloudflare|think|pi|ai sdk)\b/i;

export function userSafeServiceMessage(value: string | undefined, fallback: string): string {
  return value && !INTERNAL_SERVICE_WORDING.test(value) ? value : fallback;
}

export function userSafeServiceCode(value: string | undefined, fallback: string): string {
  if (!value || !/^[a-z][a-z0-9_]{0,79}$/u.test(value)) return fallback;
  return INTERNAL_SERVICE_WORDING.test(value.replace(/[_-]+/g, " "))
    ? fallback
    : value;
}

export class ThinAgentConnection {
  private readonly requestClient: PlatformRequestClient;
  private readonly activeRequestIds = new Set<string>();
  private client: AgentClient | null = null;
  private transport: WebSocketChatTransport | null = null;
  private bootstrap: ThinAgentBootstrapResponse | null = null;
  private firstAccessToken: string | null = null;
  private generation = 0;
  private readonly messageListeners = new Set<(event: MessageEvent) => void>();
  private readonly bufferedMessages: MessageEvent[] = [];
  private lifecycleFramesSent = 0;
  private sessionOpen = false;
  private closed = false;

  constructor(private readonly options: ThinAgentConnectionOptions) {
    this.requestClient = options.requestClient ?? new PlatformRequestClient();
  }

  /**
   * Construct the Agent client and transport synchronously. Callers must attach
   * protocol listeners before awaiting whenReady() so the server's initial
   * history broadcast cannot race past the headless chat.
   */
  public connect(): void {
    if (this.closed) throw new Error("SystemSculpt is no longer available in this chat.");
    if (this.client) return;
    const origin = new URL(this.options.baseUrl);
    const createClient = this.options.createAgentClient
      ?? ((options) => new AgentClient(options));
    const client = createClient({
      agent: "SystemSculptAgent",
      host: origin.host,
      protocol: origin.protocol === "http:" ? "ws" : "wss",
      basePath: THIN_AGENT_CONNECT_PATH.slice(1),
      query: async () => {
        if (this.firstAccessToken) {
          const accessToken = this.firstAccessToken;
          this.firstAccessToken = null;
          return { access_token: accessToken };
        }
        const bootstrap = await this.issueBootstrap();
        this.bootstrap = bootstrap;
        return { access_token: bootstrap.access.token };
      },
      defaultCallTimeout: 0,
      onConnectionError: (error: Error) => this.options.onTerminalConnectionError?.(error),
    });
    client.addEventListener("message", this.captureMessage);
    client.addEventListener("open", this.captureLifecycleOpen);
    client.addEventListener("close", this.captureLifecycleClose);
    this.client = client;
    this.transport = this.options.createTransport
      ? this.options.createTransport(client, this.activeRequestIds)
      : new WebSocketChatTransport({
          agent: client,
          activeRequestIds: this.activeRequestIds,
          cancelOnClientAbort: false,
        });
  }

  public get sessionId(): string | null {
    return this.bootstrap?.session.id ?? null;
  }

  public get inputLimits(): ThinAgentInputLimits {
    return this.bootstrap?.client_input_limits ?? DEFAULT_THIN_AGENT_INPUT_LIMITS;
  }

  public async prepare(): Promise<Readonly<{
    messages: UIMessage[];
    inputLimits: ThinAgentInputLimits;
  }>> {
    if (this.closed) throw new Error("SystemSculpt is no longer available in this chat.");
    if (this.client) {
      const bootstrap = await this.refreshBootstrap();
      return {
        messages: await this.fetchAuthoritativeMessagesWithBootstrap(bootstrap),
        inputLimits: this.inputLimits,
      };
    }
    const generation = this.generation;
    const bootstrap = await this.issueBootstrap();
    if (generation !== this.generation) {
      throw new Error("This chat changed while the response was starting.");
    }
    this.bootstrap = bootstrap;
    this.firstAccessToken = bootstrap.access.token;
    const messages = await this.fetchAuthoritativeMessagesWithBootstrap(bootstrap);
    if (generation !== this.generation) {
      throw new Error("This chat changed while its history was loading.");
    }
    return { messages, inputLimits: this.inputLimits };
  }

  public async fetchAuthoritativeMessages(): Promise<UIMessage[]> {
    const bootstrap = await this.refreshBootstrap();
    return this.fetchAuthoritativeMessagesWithBootstrap(bootstrap);
  }

  private async fetchAuthoritativeMessagesWithBootstrap(
    bootstrap: ThinAgentBootstrapResponse,
  ): Promise<UIMessage[]> {
    const url = new URL(
      `${this.options.baseUrl.replace(/\/$/, "")}${THIN_AGENT_CONNECT_PATH}/get-messages`,
    );
    url.searchParams.set("access_token", bootstrap.access.token);
    const response = await this.requestClient.request({
      url: url.toString(),
      method: "GET",
      headers: {
        "x-plugin-version": this.options.pluginVersion,
      },
      preserveResponseHeaders: true,
      allowTransportFallback: true,
      responseEncoding: "arrayBuffer",
      maxResponseBytes: 32 * 1024 * 1024,
    });
    if (!response.ok) {
      throw new ThinAgentConnectionError(
        `SystemSculpt could not restore this chat (${response.status}).`,
        "session_history_load_failed",
        response.status,
        response.status >= 500,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("This chat history is too large to restore safely.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("SystemSculpt returned malformed chat history.");
    }
    // The AI SDK validator intentionally requires at least one message, while
    // a newly initialized durable conversation canonically has no messages.
    if (Array.isArray(parsed) && parsed.length === 0) return [];
    const validated = await safeValidateUIMessages<UIMessage>({ messages: parsed });
    if (!validated.success) {
      throw new Error("SystemSculpt returned invalid chat history.");
    }
    return validated.data;
  }

  public async stageContext(
    rootMessageId: string,
    contextSources: readonly ThinAgentContextSource[],
    signal?: AbortSignal,
  ): Promise<ThinAgentContextResponse> {
    this.recordLifecycle({ code: "context_prepare_started", phase: "start" });
    try {
      const bootstrap = await this.refreshBootstrap();
      const url = new URL(
        `${this.options.baseUrl.replace(/\/$/, "")}${THIN_AGENT_CONTEXT_PATH}`,
      );
      url.searchParams.set("access_token", bootstrap.access.token);
      const request = parseThinAgentContextRequest({
        contract_version: THIN_AGENT_CONTRACT_VERSION,
        root_message_id: rootMessageId,
        context_sources: contextSources,
      }, this.inputLimits);
      const response = await this.requestClient.request({
        url: url.toString(),
        method: "POST",
        headers: {
          "x-plugin-version": this.options.pluginVersion,
        },
        body: request,
        signal,
        preserveResponseHeaders: true,
        allowTransportFallback: true,
        responseEncoding: "arrayBuffer",
        maxResponseBytes: 16 * 1024,
      });
      if (response.status !== 201) {
        const payload = boundedErrorPayload(await response.text());
        const headerIncident = response.headers.get("x-request-id");
        const incidentId = payload.incidentId
          ?? (headerIncident && /^[A-Za-z0-9._:-]{1,160}$/.test(headerIncident)
            ? headerIncident
            : undefined);
        const message = response.status === 413
          ? userSafeServiceMessage(payload.message, "Selected vault context is too large.")
          : response.status === 401
            ? "Your SystemSculpt session expired. Retry this message."
            : userSafeServiceMessage(
                payload.message,
                `SystemSculpt could not prepare vault context (${response.status}).`,
              );
        throw new ThinAgentConnectionError(
          message,
          response.status === 413
            ? "context_too_large"
            : response.status === 401
              ? "session_expired"
              : "context_prepare_failed",
          response.status,
          response.status === 401 || response.status >= 500,
          incidentId,
          retryAfterSeconds(response),
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 16 * 1024) {
        throw new Error("The prepared vault context is too large to use safely.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new Error("SystemSculpt returned a malformed vault context response.");
      }
      const context = parseThinAgentContextResponse(parsed);
      this.recordLifecycle({ code: "context_prepare_completed", phase: "start" });
      return context;
    } catch (error) {
      const cancelled = signal?.aborted
        || (error instanceof DOMException && error.name === "AbortError");
      this.recordLifecycle({
        code: cancelled ? "context_prepare_cancelled" : "context_prepare_failed",
        phase: "start",
        ...(error instanceof ThinAgentConnectionError
          ? {
              status: error.status,
              retryable: error.retryable,
              incidentId: error.incidentId,
            }
          : {}),
      });
      throw error;
    }
  }

  private async refreshBootstrap(): Promise<ThinAgentBootstrapResponse> {
    if (!this.bootstrap) throw new Error("This chat session is no longer ready. Retry this message.");
    const bootstrap = await this.issueBootstrap();
    this.bootstrap = bootstrap;
    return bootstrap;
  }

  public chatTransport(): WebSocketChatTransport {
    return this.requireTransport();
  }

  public agentClient(): AgentClient {
    return this.requireClient();
  }

  public whenReady(): Promise<void> {
    return this.requireClient().ready;
  }

  public cancel(): boolean {
    return this.transport?.cancelActiveServerTurn() ?? false;
  }

  public addMessageListener(listener: (event: MessageEvent) => void): () => void {
    this.requireClient();
    this.messageListeners.add(listener);
    for (const event of this.bufferedMessages.splice(0)) listener(event);
    return () => this.messageListeners.delete(listener);
  }

  public addOpenListener(listener: (event: Event) => void): () => void {
    const client = this.requireClient();
    client.addEventListener("open", listener);
    return () => client.removeEventListener("open", listener);
  }

  public addCloseListener(listener: (event: CloseEvent) => void): () => void {
    const client = this.requireClient();
    client.addEventListener("close", listener);
    return () => client.removeEventListener("close", listener);
  }

  public handleProtocolFrame(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    const transport = this.transport;
    if (!transport) return false;
    if (frame.type === MessageType.CF_AGENT_STREAM_RESUMING && typeof frame.id === "string") {
      return transport.handleStreamResuming({ id: frame.id });
    }
    if (frame.type === MessageType.CF_AGENT_STREAM_RESUME_NONE) {
      return transport.handleStreamResumeNone({
        ...(typeof frame.probeId === "string" ? { probeId: frame.probeId } : {}),
      });
    }
    if (frame.type === MessageType.CF_AGENT_STREAM_PENDING) {
      return transport.handleStreamPending();
    }
    return false;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
  }

  public disconnect(): void {
    this.generation += 1;
    this.transport?.resetResumeState();
    if (this.client && this.sessionOpen) {
      this.recordLifecycle({
        code: "session_closed",
        phase: "session",
      });
    }
    this.client?.removeEventListener("message", this.captureMessage);
    this.client?.removeEventListener("open", this.captureLifecycleOpen);
    this.client?.removeEventListener("close", this.captureLifecycleClose);
    this.client?.close(1000, "Chat changed.");
    this.transport = null;
    this.client = null;
    this.bootstrap = null;
    this.firstAccessToken = null;
    this.activeRequestIds.clear();
    this.messageListeners.clear();
    this.bufferedMessages.length = 0;
    this.lifecycleFramesSent = 0;
    this.sessionOpen = false;
  }

  public recordLifecycle(input: ThinAgentLifecycleInput): void {
    const record = this.options.lifecycle?.record(input);
    if (!record || !this.client || this.lifecycleFramesSent >= 256) return;
    try {
      this.client.send(JSON.stringify(this.options.lifecycle!.diagnosticFrame(record)));
      this.lifecycleFramesSent += 1;
    } catch {
      // Lifecycle diagnostics must never alter the connection flow.
    }
  }

  private readonly captureLifecycleOpen = (): void => {
    this.sessionOpen = true;
    this.recordLifecycle({
      code: "session_opened",
      phase: "session",
    });
  };

  private readonly captureLifecycleClose = (event: CloseEvent): void => {
    this.sessionOpen = false;
    this.recordLifecycle({
      code: event.code === 1000
        ? "session_closed"
        : event.code === 1008 || (event.code >= 4000 && event.code <= 4999)
          ? "session_failed"
          : "session_interrupted",
      phase: "session",
    });
  };

  private readonly captureMessage = (event: MessageEvent): void => {
    if (this.messageListeners.size === 0) {
      this.bufferedMessages.push(event);
      return;
    }
    for (const listener of this.messageListeners) listener(event);
  };

  private async issueBootstrap(): Promise<ThinAgentBootstrapResponse> {
    this.recordLifecycle({ code: "response_prepare_started", phase: "start" });
    try {
      const licenseKey = this.options.licenseKey().trim();
      if (!licenseKey) throw new Error("Add your SystemSculpt license to use Chat.");
      const request = this.options.bootstrapRequest();
      const response = await this.requestClient.request({
        url: `${this.options.baseUrl.replace(/\/$/, "")}${THIN_AGENT_BOOTSTRAP_PATH}`,
        method: "POST",
        headers: {
          "x-plugin-version": this.options.pluginVersion,
        },
        licenseKey,
        body: request,
        preserveResponseHeaders: true,
        allowTransportFallback: true,
      });
      if (!response.ok) {
        const payload = boundedErrorPayload(await response.text());
        const headerIncident = response.headers.get("x-request-id");
        const incidentId = payload.incidentId
          ?? (headerIncident && /^[A-Za-z0-9._:-]{1,160}$/.test(headerIncident)
            ? headerIncident
            : undefined);
        const rateLimited = response.status === 429;
        const retryAfter = retryAfterSeconds(response);
        const message = rateLimited
          ? (() => {
              const safe = userSafeServiceMessage(
                payload.message,
                "SystemSculpt is receiving too many requests.",
              );
              return `${safe}${/(?:try|retry|again)/i.test(safe) ? "" : " Try again shortly."}`;
            })()
          : userSafeServiceMessage(
              payload.message,
              `SystemSculpt could not start the response (${response.status}).`,
            );
        throw new ThinAgentConnectionError(
          message,
          rateLimited ? "response_start_rate_limited" : "response_start_failed",
          response.status,
          rateLimited || response.status >= 500,
          incidentId,
          retryAfter,
        );
      }
      const bootstrap = parseThinAgentBootstrapResponse(await response.json(), {
        conversation_id: request.conversation_id,
      });
      this.recordLifecycle({ code: "response_prepare_completed", phase: "start" });
      return bootstrap;
    } catch (error) {
      this.recordLifecycle({
        code: "response_prepare_failed",
        phase: "start",
        ...(error instanceof ThinAgentConnectionError
          ? {
              status: error.status,
              retryable: error.retryable,
              incidentId: error.incidentId,
            }
          : {}),
      });
      throw error;
    }
  }

  private requireClient(): AgentClient {
    if (!this.client) throw new Error("SystemSculpt is not ready. Retry this message.");
    return this.client;
  }

  private requireTransport(): WebSocketChatTransport {
    if (!this.transport) throw new Error("SystemSculpt is not ready. Retry this message.");
    return this.transport;
  }
}
