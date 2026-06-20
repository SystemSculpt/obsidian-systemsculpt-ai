import type SystemSculptPlugin from "../../main";
import type { PreparedChatRequest, StreamDebugCallbacks } from "../StreamExecutionTypes";
import type { StreamEvent, StreamToolCall } from "../../streaming/types";
import type { ChatMessage, MultiPartContent } from "../../types";
import type { OpenAITool } from "../../utils/tooling";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { resolveStudioPiProviderApiKey } from "../../studio/piAuth/StudioPiAuthStorage";
import { resolveConfiguredRemoteProviderEndpoint } from "./RemoteProviderCatalog";
import { ANTHROPIC_API_VERSION, ANTHROPIC_STREAM_EVENTS } from "../../constants/anthropic";
import { ERROR_CODES, SystemSculptError } from "../../utils/errors";

type RemoteAnthropicStreamInput = {
  plugin: SystemSculptPlugin;
  prepared: PreparedChatRequest;
  signal?: AbortSignal;
  reasoningEffort?: string;
  debug?: StreamDebugCallbacks;
};

const ANTHROPIC_PROVIDER_ID = "anthropic";
// Anthropic's Messages API requires an explicit `max_tokens`. When the model
// metadata does not declare a completion cap we fall back to a conservative
// value that every current Claude model supports.
const DEFAULT_MAX_TOKENS = 8192;

// ────────────────────────────────────────────────────────────────────────────
// Anthropic request-body construction
// ────────────────────────────────────────────────────────────────────────────

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

function resolveMaxTokens(prepared: PreparedChatRequest): number {
  const cap = prepared.resolvedModel?.top_provider?.max_completion_tokens;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    return Math.floor(cap);
  }
  return DEFAULT_MAX_TOKENS;
}

/**
 * Parse a data URL (or bare base64 payload) into the Anthropic image-block
 * `media_type`/`data` pair. Returns null when the value is not a usable base64
 * image (e.g. a remote https URL, which the Messages API base64 source cannot
 * carry).
 */
function parseImageSource(
  url: string,
): { media_type: string; data: string } | null {
  if (typeof url !== "string" || url.length === 0) return null;

  const dataUrlMatch = url.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (dataUrlMatch) {
    const mediaType = (dataUrlMatch[1] || "image/png").trim();
    const data = dataUrlMatch[2] || "";
    if (data.length === 0) return null;
    return { media_type: mediaType, data };
  }

  // Anthropic's base64 source cannot fetch remote URLs; skip those.
  return null;
}

function toAnthropicContentBlocks(parts: MultiPartContent[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part && part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (
      part &&
      part.type === "image_url" &&
      part.image_url &&
      typeof part.image_url.url === "string"
    ) {
      const source = parseImageSource(part.image_url.url);
      if (source) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: source.media_type, data: source.data },
        });
      }
    }
  }
  return blocks;
}

function extractToolCallParts(
  toolCall: unknown,
): { id: string; name: string; input: Record<string, unknown> } | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const tc = toolCall as Record<string, any>;
  const req: Record<string, any> = (tc.request || tc) ?? {};
  const fn: Record<string, any> =
    req.function || tc.function || (req.name ? { name: req.name, arguments: req.arguments } : {});
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  if (!name) return null;

  const id =
    typeof tc.id === "string" && tc.id.length > 0
      ? tc.id
      : typeof req.id === "string" && req.id.length > 0
        ? req.id
        : `toolu_${name}`;

  let input: Record<string, unknown> = {};
  const rawArgs = fn?.arguments;
  if (rawArgs && typeof rawArgs === "object") {
    input = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = {};
    }
  }

  return { id, name, input };
}

function stringifyToolResultContent(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && part.type === "text" && typeof part.text === "string" ? part.text : "",
      )
      .filter((text) => text.length > 0)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Translate the repo's `ChatMessage[]` history into Anthropic Messages API
 * turns. System messages are dropped (the system prompt is a top-level field),
 * tool results collapse into `tool_result` blocks, and adjacent tool results
 * merge into a single user turn as Anthropic requires.
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const message of messages || []) {
    if (!message || message.role === "system") continue;

    if (message.role === "tool") {
      const block: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        content: stringifyToolResultContent(message.content),
      };
      const last = result[result.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(block);
      } else {
        result.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const hasToolCalls =
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

      // Plain text assistant turns stay a string (matches the user-turn shape);
      // only build a content-block array when tool_use or multimodal blocks are
      // present.
      if (!hasToolCalls && typeof message.content === "string") {
        result.push({
          role: "assistant",
          content: message.content.length > 0 ? message.content : " ",
        });
        continue;
      }

      const blocks: AnthropicContentBlock[] = [];

      if (typeof message.content === "string") {
        if (message.content.length > 0) {
          blocks.push({ type: "text", text: message.content });
        }
      } else if (Array.isArray(message.content)) {
        blocks.push(...toAnthropicContentBlocks(message.content));
      }

      if (hasToolCalls) {
        for (const toolCall of message.tool_calls!) {
          const parts = extractToolCallParts(toolCall);
          if (parts) {
            blocks.push({
              type: "tool_use",
              id: parts.id,
              name: parts.name,
              input: parts.input,
            });
          }
        }
      }

      // Anthropic rejects empty assistant content; fall back to a single space.
      if (blocks.length === 0) {
        result.push({ role: "assistant", content: " " });
      } else {
        result.push({ role: "assistant", content: blocks });
      }
      continue;
    }

    // role === "user"
    if (typeof message.content === "string") {
      result.push({ role: "user", content: message.content.length > 0 ? message.content : " " });
    } else if (Array.isArray(message.content)) {
      const blocks = toAnthropicContentBlocks(message.content);
      result.push({ role: "user", content: blocks.length > 0 ? blocks : " " });
    } else {
      result.push({ role: "user", content: " " });
    }
  }

  return result;
}

/**
 * Convert OpenAI-style tool definitions (`{type, function:{...}}`) — or the
 * already-flattened `{name, description, parameters}` shape — into Anthropic's
 * `{name, description, input_schema}` tool format.
 */
export function toAnthropicTools(tools: unknown[]): AnthropicTool[] {
  if (!Array.isArray(tools)) return [];
  const result: AnthropicTool[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const candidate = tool as Record<string, any>;
    const fn: Record<string, any> = candidate.function || candidate;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (!name) continue;

    const parameters =
      fn?.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : fn?.input_schema && typeof fn.input_schema === "object"
          ? (fn.input_schema as Record<string, unknown>)
          : { type: "object", properties: {} };

    const description = typeof fn?.description === "string" ? fn.description : undefined;

    result.push({
      name,
      ...(description ? { description } : {}),
      input_schema: parameters,
    });
  }

  return result;
}

export function buildAnthropicMessagesRequestBody(
  input: RemoteAnthropicStreamInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.prepared.actualModelId,
    max_tokens: resolveMaxTokens(input.prepared),
    messages: toAnthropicMessages(input.prepared.preparedMessages),
    stream: true,
  };

  const system = input.prepared.finalSystemPrompt;
  if (typeof system === "string" && system.trim().length > 0) {
    body.system = system;
  }

  if (Array.isArray(input.prepared.tools) && input.prepared.tools.length > 0) {
    body.tools = toAnthropicTools(input.prepared.tools as OpenAITool[]);
  }

  return body;
}

// ────────────────────────────────────────────────────────────────────────────
// Anthropic SSE → StreamEvent parser
// ────────────────────────────────────────────────────────────────────────────

interface AnthropicToolUseState {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Maps Anthropic stop reasons onto the SAME stop-reason values the
 * OpenAI-compatible StreamPipeline emits (see
 * StreamPipeline.mapFinishReasonToPiStopReason), so downstream turn-loop logic
 * is provider-agnostic:
 *   end_turn / stop_sequence → "stop"
 *   max_tokens               → "length"
 *   tool_use                 → "toolUse"
 */
function mapAnthropicStopReason(stopReason: string): string {
  const lc = String(stopReason || "").trim().toLowerCase();
  if (!lc) return stopReason;
  if (lc === "end_turn" || lc === "stop_sequence") return "stop";
  if (lc === "max_tokens") return "length";
  if (lc === "tool_use") return "toolUse";
  return stopReason;
}

function buildStreamToolCall(state: AnthropicToolUseState): StreamToolCall {
  return {
    id: state.id,
    type: "function",
    function: {
      name: state.name,
      arguments: state.arguments,
    },
  };
}

/**
 * Incremental parser for the Anthropic Messages API SSE wire format. Mirrors
 * StreamPipeline's `push`/`flush` interface so it can be unit-tested directly
 * with raw SSE strings. Anthropic frames each event as an `event: <type>` line
 * followed by a `data: <json>` line and a blank-line terminator; we buffer
 * partial lines across `push` calls.
 */
export class AnthropicStreamParser {
  private buffer = "";
  private currentEvent: string | null = null;
  private readonly dataLines: string[] = [];
  private readonly toolUseBlocks = new Map<number, AnthropicToolUseState>();

  push(text: string): StreamEvent[] {
    this.buffer += text;
    const events: StreamEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      events.push(...this.consumeLine(line));
    }

    return events;
  }

  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];

    if (this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      events.push(...this.consumeLine(line));
    }

    // Dispatch any event whose terminating blank line never arrived.
    events.push(...this.dispatchEvent());

    return events;
  }

  private consumeLine(line: string): StreamEvent[] {
    const trimmed = line.trim();

    // A blank line terminates the current SSE event.
    if (trimmed.length === 0) {
      return this.dispatchEvent();
    }

    if (trimmed.startsWith(":")) {
      return []; // SSE comment / keep-alive
    }

    if (line.startsWith("event:")) {
      this.currentEvent = line.slice("event:".length).trim();
      return [];
    }

    if (line.startsWith("data:")) {
      let dataLine = line.slice("data:".length);
      if (dataLine.startsWith(" ")) dataLine = dataLine.slice(1);
      this.dataLines.push(dataLine);
      return [];
    }

    return [];
  }

  private dispatchEvent(): StreamEvent[] {
    if (this.currentEvent === null && this.dataLines.length === 0) {
      return [];
    }

    const eventType = this.currentEvent;
    const payload = this.dataLines.join("\n");
    this.currentEvent = null;
    this.dataLines.length = 0;

    if (payload.length === 0) {
      return [];
    }

    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }

    // Prefer the explicit SSE event name, but fall back to the payload `type`
    // so a well-formed data block is still routed if the event line was lost.
    const type = eventType || (typeof parsed?.type === "string" ? parsed.type : "");
    return this.handleEvent(type, parsed);
  }

  private handleEvent(type: string, parsed: any): StreamEvent[] {
    const events: StreamEvent[] = [];

    switch (type) {
      case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_START: {
        const index = typeof parsed?.index === "number" ? parsed.index : 0;
        const block = parsed?.content_block;
        if (block && block.type === "tool_use") {
          const state: AnthropicToolUseState = {
            id: typeof block.id === "string" ? block.id : `toolu_${index}`,
            name: typeof block.name === "string" ? block.name : "",
            arguments: "",
          };
          this.toolUseBlocks.set(index, state);
          events.push({ type: "tool-call", phase: "delta", call: buildStreamToolCall(state) });
        }
        break;
      }

      case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_DELTA: {
        const index = typeof parsed?.index === "number" ? parsed.index : 0;
        const delta = parsed?.delta;
        if (!delta || typeof delta !== "object") break;

        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          events.push({ type: "content", text: delta.text });
        } else if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking.length > 0
        ) {
          events.push({ type: "reasoning", text: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const state = this.toolUseBlocks.get(index);
          if (state) {
            state.arguments += delta.partial_json;
            events.push({ type: "tool-call", phase: "delta", call: buildStreamToolCall(state) });
          }
        }
        break;
      }

      case ANTHROPIC_STREAM_EVENTS.CONTENT_BLOCK_STOP: {
        const index = typeof parsed?.index === "number" ? parsed.index : 0;
        const state = this.toolUseBlocks.get(index);
        if (state) {
          events.push({ type: "tool-call", phase: "final", call: buildStreamToolCall(state) });
          this.toolUseBlocks.delete(index);
        }
        break;
      }

      case ANTHROPIC_STREAM_EVENTS.MESSAGE_DELTA: {
        const stopReason = parsed?.delta?.stop_reason;
        if (typeof stopReason === "string" && stopReason.length > 0) {
          events.push({
            type: "meta",
            key: "stop-reason",
            value: mapAnthropicStopReason(stopReason),
          });
        }
        break;
      }

      case ANTHROPIC_STREAM_EVENTS.ERROR: {
        const message =
          (parsed?.error && typeof parsed.error.message === "string" && parsed.error.message) ||
          (typeof parsed?.message === "string" && parsed.message) ||
          "Anthropic stream error";
        throw new SystemSculptError(message, ERROR_CODES.STREAM_ERROR, 500, {
          provider: ANTHROPIC_PROVIDER_ID,
          rawError: parsed?.error ?? parsed,
        });
      }

      // message_start / message_stop / ping carry no StreamEvent payload.
      default:
        break;
    }

    return events;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Executor
// ────────────────────────────────────────────────────────────────────────────

function serializeResponseHeaders(headers: unknown): Record<string, string> {
  const serialized: Record<string, string> = {};
  const maybeHeaders = headers as {
    forEach?: (callback: (value: unknown, key: unknown) => void) => void;
    entries?: () => Iterable<[unknown, unknown]>;
  };

  if (typeof maybeHeaders?.forEach === "function") {
    maybeHeaders.forEach((value, key) => {
      serialized[String(key)] = String(value);
    });
    return serialized;
  }

  if (typeof maybeHeaders?.entries === "function") {
    for (const [key, value] of maybeHeaders.entries()) {
      serialized[String(key)] = String(value);
    }
  }

  return serialized;
}

export async function* executeAnthropicRemoteStream(
  input: RemoteAnthropicStreamInput,
): AsyncGenerator<StreamEvent, void, unknown> {
  const endpoint = resolveConfiguredRemoteProviderEndpoint(input.plugin, ANTHROPIC_PROVIDER_ID);
  if (!endpoint) {
    throw new Error(`No remote endpoint configured for provider "${ANTHROPIC_PROVIDER_ID}".`);
  }

  const apiKey = await resolveStudioPiProviderApiKey(ANTHROPIC_PROVIDER_ID, {
    plugin: input.plugin,
  });
  if (!apiKey) {
    throw new Error(`Connect ${ANTHROPIC_PROVIDER_ID} in Providers before using this model.`);
  }

  const requestBody = buildAnthropicMessagesRequestBody(input);
  const client = new PlatformRequestClient();
  const debugHeaders = {
    "x-api-key": "[redacted]",
    "anthropic-version": ANTHROPIC_API_VERSION,
  };

  try {
    input.debug?.onRequest?.({
      provider: ANTHROPIC_PROVIDER_ID,
      endpoint,
      headers: debugHeaders,
      body: requestBody,
      transport: "remote-provider",
      canStream: true,
      isCustomProvider: true,
    });
  } catch {}

  const response = await client.request({
    url: `${endpoint.replace(/\/$/, "")}/messages`,
    method: "POST",
    body: requestBody,
    stream: true,
    signal: input.signal,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
  });

  try {
    input.debug?.onResponse?.({
      provider: ANTHROPIC_PROVIDER_ID,
      endpoint,
      status: response.status,
      headers: serializeResponseHeaders(response.headers),
      isCustomProvider: true,
    });
  } catch {}

  if (!response.ok) {
    await StreamingErrorHandler.handleStreamError(response, true, {
      provider: ANTHROPIC_PROVIDER_ID,
      endpoint,
      model: input.prepared.actualModelId,
    });
  }

  if (!response.body) {
    throw new SystemSculptError(
      "Missing response body from streaming API",
      ERROR_CODES.STREAM_ERROR,
      response.status,
    );
  }

  const parser = new AnthropicStreamParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  const readWithAbort = async (): Promise<{
    done: boolean;
    value?: Uint8Array;
    aborted: boolean;
  }> => {
    if (!input.signal) {
      const { done, value } = await reader.read();
      return { done, value, aborted: false };
    }

    if (input.signal.aborted) {
      try {
        await reader.cancel();
      } catch {}
      return { done: true, value: undefined, aborted: true };
    }

    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        try {
          void reader.cancel();
        } catch {}
        resolve({ done: true, value: undefined, aborted: true });
      };

      input.signal!.addEventListener("abort", onAbort, { once: true });

      reader
        .read()
        .then(({ done, value }) => resolve({ done, value, aborted: false }))
        .catch(reject)
        .finally(() => {
          input.signal!.removeEventListener("abort", onAbort);
        });
    });
  };

  let aborted = false;

  try {
    while (true) {
      const { done, value, aborted: abortedBySignal } = await readWithAbort();
      if (abortedBySignal) {
        aborted = true;
        break;
      }
      if (done) break;
      if (!value) continue;

      const text = decoder.decode(value, { stream: true });
      const events = parser.push(text);
      for (const event of events) {
        try {
          input.debug?.onStreamEvent?.({ event });
        } catch {}
        yield event;
      }
    }

    if (!aborted) {
      const trailingEvents = parser.flush();
      for (const event of trailingEvents) {
        try {
          input.debug?.onStreamEvent?.({ event });
        } catch {}
        yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  try {
    input.debug?.onStreamEnd?.({
      completed: !aborted,
      aborted,
    });
  } catch {}
}
