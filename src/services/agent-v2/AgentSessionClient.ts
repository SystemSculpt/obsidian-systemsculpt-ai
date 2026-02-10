import { SYSTEMSCULPT_API_ENDPOINTS } from "../../constants/api";
import { normalizePiTools } from "./PiToolAdapter";

export type AgentSessionRequest = {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
  body?: unknown;
  stream?: boolean;
};

export type AgentSessionRequestFn = (input: AgentSessionRequest) => Promise<Response>;

type ApiLikeMessage = {
  role?: unknown;
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  timestamp?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
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

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseDataUrlImage(url: string): { mimeType: string; data: string } | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("data:")) return null;

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= 5) return null;

  const metadata = trimmed.slice(5, commaIndex);
  const payload = trimmed.slice(commaIndex + 1);
  if (!payload) return null;

  const parts = metadata
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return null;
  const mimeType = parts[0].toLowerCase();
  if (!mimeType.startsWith("image/")) return null;

  const hasBase64Flag = parts.slice(1).some((part) => part.toLowerCase() === "base64");
  if (!hasBase64Flag) return null;

  return {
    mimeType,
    data: payload,
  };
}

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

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

  public clearSession(chatId: string): void {
    this.sessionByChatId.delete(chatId);
  }

  public async startOrContinueTurn(args: StartOrContinueArgs): Promise<Response> {
    const pluginVersion = this.normalizePluginVersion(args.pluginVersion);
    const session = await this.ensureSession(args.chatId, args.modelId, pluginVersion);
    const sessionId = session.sessionId;

    const turnResponse = await this.requestFn({
      url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSION_TURNS(sessionId)),
      method: "POST",
      headers: { "x-plugin-version": pluginVersion },
      body: {
        modelId: args.modelId,
        context: this.buildPiContext(args.messages, args.tools || [], args.modelId),
        stream: true,
      },
      stream: true,
    });
    if (!turnResponse.ok) {
      throw await this.httpError("start agent turn", turnResponse);
    }

    return turnResponse;
  }

  private async ensureSession(
    chatId: string,
    modelId: string,
    pluginVersion: string
  ): Promise<ChatSessionState> {
    const existing = this.sessionByChatId.get(chatId);
    if (existing) return existing;

    const response = await this.requestFn({
      url: this.endpoint(SYSTEMSCULPT_API_ENDPOINTS.AGENT.SESSIONS),
      method: "POST",
      headers: { "x-plugin-version": pluginVersion },
      body: {
        modelId,
        client: {
          platform: "obsidian",
          pluginVersion,
        },
      },
    });

    if (!response.ok) {
      throw await this.httpError("create agent session", response);
    }

    const payload = (await response.json()) as { sessionId?: unknown };
    const sessionId = asString(payload?.sessionId);
    if (!sessionId) {
      throw new Error("Agent session response did not include sessionId.");
    }

    const state: ChatSessionState = {
      sessionId,
    };

    this.sessionByChatId.set(chatId, state);
    return state;
  }

  private async httpError(action: string, response: Response): Promise<Error> {
    const status = response?.status ?? 0;
    let detail = "";

    try {
      const payload = await response.text();
      const trimmed = payload.trim();
      if (trimmed.length > 0) {
        detail = ` (${trimmed.slice(0, 300)})`;
      }
    } catch {}

    return new Error(`Failed to ${action}: ${status}${detail}`);
  }

  private buildPiContext(messages: unknown[], tools: unknown[], modelId: string): Record<string, unknown> {
    const contextMessages: unknown[] = [];
    const systemPrompts: string[] = [];

    for (let index = 0; index < messages.length; index += 1) {
      const message = (messages[index] || {}) as ApiLikeMessage;
      const role = asString(message.role);
      const timestamp = this.resolveTimestamp(message.timestamp, index);

      if (role === "system") {
        const prompt = this.contentToText(message.content).trim();
        if (prompt.length > 0) {
          systemPrompts.push(prompt);
        }
        continue;
      }

      if (role === "user") {
        contextMessages.push({
          role: "user",
          content: this.normalizeUserContent(message.content),
          timestamp,
        });
        continue;
      }

      if (role === "assistant") {
        contextMessages.push(this.toPiAssistantMessage(message, timestamp, modelId));
        continue;
      }

      if (role === "tool") {
        const toolCallId = asString(message.tool_call_id);
        if (!toolCallId) continue;

        const parsed = parseToolMessageContent(message.content);
        const textPayload = parsed.ok
          ? toText(typeof parsed.output === "undefined" ? {} : parsed.output)
          : toText({ error: parsed.error ?? "Tool execution failed" });

        contextMessages.push({
          role: "toolResult",
          toolCallId,
          toolName: asString(message.name) || "tool",
          content: [{ type: "text", text: textPayload || "{}" }],
          isError: !parsed.ok,
          timestamp,
        });
      }
    }

    if (contextMessages.length === 0) {
      throw new Error("Cannot start PI turn without at least one non-system message.");
    }

    const context: Record<string, unknown> = {
      messages: contextMessages,
    };

    const piTools = normalizePiTools(tools);
    if (piTools.length > 0) {
      context.tools = piTools;
    }

    if (systemPrompts.length > 0) {
      context.systemPrompt = systemPrompts.join("\n\n");
    }

    return context;
  }

  private toPiAssistantMessage(
    message: ApiLikeMessage,
    timestamp: number,
    modelId: string
  ): Record<string, unknown> {
    const contentBlocks: Array<Record<string, unknown>> = [];

    const textContent = this.contentToText(message.content);
    if (textContent.length > 0) {
      contentBlocks.push({ type: "text", text: textContent });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const id = asString(call?.id);
      const name = asString(call?.function?.name);
      if (!id || !name) continue;

      contentBlocks.push({
        type: "toolCall",
        id,
        name,
        arguments: this.parseToolCallArguments(call?.function?.arguments),
      });
    }

    const provider = modelId.split("/")[0] || "systemsculpt";
    const model = modelId.split("/").slice(1).join("/") || modelId;

    const stopReasonRaw = asString(message.stopReason);
    const stopReason = STOP_REASONS.has(stopReasonRaw) ? stopReasonRaw : "stop";

    return {
      role: "assistant",
      api: asString(message.api) || "openai-completions",
      provider: asString(message.provider) || provider,
      model: asString(message.model) || model,
      content: contentBlocks,
      usage: this.normalizeAssistantUsage(message.usage),
      stopReason,
      ...(asString(message.errorMessage) ? { errorMessage: asString(message.errorMessage) } : {}),
      timestamp,
    };
  }

  private parseToolCallArguments(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") {
      return raw as Record<string, unknown>;
    }

    const text = asString(raw).trim();
    if (!text) return {};

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { value: text };
    }
  }

  private normalizeAssistantUsage(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") {
      const usage = raw as Record<string, unknown>;
      const cost = usage.cost as Record<string, unknown> | undefined;

      if (
        typeof usage.input === "number" &&
        typeof usage.output === "number" &&
        typeof usage.cacheRead === "number" &&
        typeof usage.cacheWrite === "number" &&
        typeof usage.totalTokens === "number" &&
        cost &&
        typeof cost.input === "number" &&
        typeof cost.output === "number" &&
        typeof cost.cacheRead === "number" &&
        typeof cost.cacheWrite === "number" &&
        typeof cost.total === "number"
      ) {
        return usage;
      }
    }

    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
  }

  private normalizeUserContent(content: unknown): string | Array<Record<string, unknown>> {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return this.contentToText(content);

    const blocks: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const entry = part as Record<string, unknown>;
      const type = asString(entry.type);

      if (type === "text" && typeof entry.text === "string") {
        blocks.push({ type: "text", text: entry.text });
        continue;
      }

      if (
        type === "image" &&
        typeof entry.data === "string" &&
        typeof entry.mimeType === "string"
      ) {
        blocks.push({ type: "image", data: entry.data, mimeType: entry.mimeType });
        continue;
      }

      if (type === "image_url") {
        const image = entry.image_url as Record<string, unknown> | undefined;
        const url = asString(image?.url);
        const parsed = parseDataUrlImage(url);
        if (parsed) {
          blocks.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
          continue;
        }
        if (url.length > 0) {
          // PI context currently expects inline image data, so preserve non-data URLs as text markers.
          blocks.push({ type: "text", text: `[image:${url}]` });
          continue;
        }
      }
    }

    if (blocks.length > 0) {
      return blocks;
    }

    return this.contentToText(content);
  }

  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content == null) return "";

    if (Array.isArray(content)) {
      const pieces: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const entry = part as Record<string, unknown>;
        const type = asString(entry.type);
        if (type === "text" && typeof entry.text === "string") {
          pieces.push(entry.text);
          continue;
        }
        if (type === "image_url") {
          const image = entry.image_url as Record<string, unknown> | undefined;
          const url = asString(image?.url);
          if (url) {
            pieces.push(`[image:${url}]`);
          }
        }
      }
      return pieces.join("\n");
    }

    return toText(content);
  }

  private resolveTimestamp(raw: unknown, offset = 0): number {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    return Date.now() + offset;
  }

  private normalizePluginVersion(raw: string | undefined): string {
    const pluginVersion = asString(raw).trim();
    return pluginVersion || "0.0.0";
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
        ...(input.headers || {}),
      },
      body: typeof input.body === "undefined" ? undefined : JSON.stringify(input.body),
    });

    return response;
  }
}
