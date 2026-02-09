import { AgentTurnStateMachine } from "./AgentTurnStateMachine";
import { SYSTEMSCULPT_API_ENDPOINTS } from "../../constants/api";

export type AgentSessionRequest = {
  url: string;
  method: "POST";
  body?: unknown;
  stream?: boolean;
};

export type AgentSessionRequestFn = (input: AgentSessionRequest) => Promise<Response>;

type ToolResultPayload = {
  toolCallId: string;
  ok: boolean;
  output?: unknown;
  error?: unknown;
  toolName?: string;
};

type ApiLikeMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { name?: unknown } }>;
};

type StartOrContinueArgs = {
  chatId: string;
  modelId: string;
  messages: unknown[];
  tools?: unknown[];
  pluginVersion?: string;
};

type ChatSessionState = {
  sessionId: string;
  machine: AgentTurnStateMachine;
  submittedToolResultIds: Set<string>;
};

function parseToolMessageContent(content: unknown): { ok: boolean; output?: unknown; error?: unknown } {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: true, output: {} };
  }

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return { ok: false, error: (parsed as Record<string, unknown>).error };
    }
    return { ok: true, output: parsed };
  } catch {
    return { ok: true, output: content };
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class AgentSessionClient {
  private baseUrl: string;
  private licenseKey: string;
  private readonly requestFn: AgentSessionRequestFn;
  private readonly sessionByChatId = new Map<string, ChatSessionState>();

  constructor(options: {
    baseUrl: string;
    licenseKey: string;
    request?: AgentSessionRequestFn;
  }) {
    this.baseUrl = options.baseUrl;
    this.licenseKey = options.licenseKey;
    this.requestFn = options.request ?? this.defaultRequest.bind(this);
  }

  public updateConfig(next: { baseUrl: string; licenseKey: string }): void {
    this.baseUrl = next.baseUrl;
    this.licenseKey = next.licenseKey;
  }

  public markWaitingForTools(chatId: string, toolCallIds: string[]): void {
    const state = this.sessionByChatId.get(chatId);
    if (!state) return;

    state.machine.markWaitingForTools(toolCallIds);
    state.submittedToolResultIds.clear();
  }

  public markTurnCompleted(chatId: string): void {
    const state = this.sessionByChatId.get(chatId);
    if (!state) return;
    state.machine.markCompleted();
  }

  public markTurnErrored(chatId: string): void {
    const state = this.sessionByChatId.get(chatId);
    if (!state) return;
    state.machine.markError();
  }

  public clearSession(chatId: string): void {
    this.sessionByChatId.delete(chatId);
  }

  public async startOrContinueTurn(args: StartOrContinueArgs): Promise<Response> {
    const session = await this.ensureSession(args.chatId, args.modelId, args.pluginVersion);
    const sessionId = session.sessionId;

    if (session.machine.isWaitingForTools()) {
      const pendingToolCallIds = session.machine.getPendingToolCallIds();
      const toolResults = this.extractToolResultsFromMessages(
        args.messages,
        pendingToolCallIds,
        session.submittedToolResultIds
      );

      if (toolResults.length === 0) {
        throw new Error("No tool results available for pending tool calls.");
      }

      const toolResultsResponse = await this.requestFn({
        url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_TOOL_RESULTS(sessionId)),
        method: "POST",
        body: { results: toolResults },
      });
      if (!toolResultsResponse.ok) {
        throw this.httpError("submit tool results", toolResultsResponse);
      }

      toolResults.forEach((result) => session.submittedToolResultIds.add(result.toolCallId));
      session.machine.markToolResultsSubmitted();

      const continueResponse = await this.requestFn({
        url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_CONTINUE(sessionId)),
        method: "POST",
        body: { stream: true },
        stream: true,
      });
      if (!continueResponse.ok) {
        throw this.httpError("continue agent turn", continueResponse);
      }

      return continueResponse;
    }

    session.machine.startTurn(sessionId);
    session.submittedToolResultIds.clear();

    const turnResponse = await this.requestFn({
      url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_TURNS(sessionId)),
      method: "POST",
      body: {
        modelId: args.modelId,
        messages: args.messages,
        tools: args.tools || [],
        stream: true,
      },
      stream: true,
    });
    if (!turnResponse.ok) {
      throw this.httpError("start agent turn", turnResponse);
    }

    return turnResponse;
  }

  private async ensureSession(chatId: string, modelId: string, pluginVersion?: string): Promise<ChatSessionState> {
    const existing = this.sessionByChatId.get(chatId);
    if (existing) return existing;

    const response = await this.requestFn({
      url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSIONS),
      method: "POST",
      body: {
        modelId,
        client: {
          platform: "obsidian",
          pluginVersion: pluginVersion || "unknown",
        },
      },
    });

    if (!response.ok) {
      throw this.httpError("create agent session", response);
    }

    const payload = (await response.json()) as { sessionId?: unknown };
    const sessionId = asString(payload?.sessionId);
    if (!sessionId) {
      throw new Error("Agent session response did not include sessionId.");
    }

    const state: ChatSessionState = {
      sessionId,
      machine: new AgentTurnStateMachine(),
      submittedToolResultIds: new Set<string>(),
    };

    this.sessionByChatId.set(chatId, state);
    return state;
  }

  private httpError(action: string, response: Response): Error {
    const status = response?.status ?? 0;
    return new Error(`Failed to ${action}: ${status}`);
  }

  private extractToolResultsFromMessages(
    messages: unknown[],
    pendingToolCallIds: string[],
    submittedToolResultIds: Set<string>
  ): ToolResultPayload[] {
    const pendingSet = new Set(pendingToolCallIds);
    const toolNameByCallId = new Map<string, string>();

    for (const raw of messages) {
      const message = (raw || {}) as ApiLikeMessage;
      if (asString(message.role) !== "assistant") continue;
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        const id = asString(call?.id);
        const name = asString(call?.function?.name);
        if (!id || !name) continue;
        toolNameByCallId.set(id, name);
      }
    }

    const results: ToolResultPayload[] = [];
    for (const raw of messages) {
      const message = (raw || {}) as ApiLikeMessage;
      if (asString(message.role) !== "tool") continue;

      const toolCallId = asString(message.tool_call_id);
      if (!toolCallId || !pendingSet.has(toolCallId)) continue;
      if (submittedToolResultIds.has(toolCallId)) continue;

      const parsed = parseToolMessageContent(message.content);
      results.push({
        toolCallId,
        ok: parsed.ok,
        ...(parsed.ok ? { output: parsed.output } : { error: parsed.error }),
        toolName: asString(message.name) || toolNameByCallId.get(toolCallId) || "tool",
      });
    }

    return results;
  }

  private endpoint(path: string): string {
    return `${this.apiRoot()}${path}`
  }

  private apiRoot(): string {
    const trimmed = this.baseUrl.replace(/\/+$/, "");
    return trimmed.replace(/\/api\/v1$/i, "");
  }

  private async defaultRequest(input: AgentSessionRequest): Promise<Response> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: {
        "Content-Type": "application/json",
        Accept: input.stream ? "text/event-stream" : "application/json",
        "x-license-key": this.licenseKey,
      },
      body: typeof input.body === "undefined" ? undefined : JSON.stringify(input.body),
    });

    return response;
  }
}
