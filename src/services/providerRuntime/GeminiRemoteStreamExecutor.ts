import type SystemSculptPlugin from "../../main";
import type { PreparedChatRequest, StreamDebugCallbacks } from "../StreamExecutionTypes";
import type { StreamEvent, StreamToolCall } from "../../streaming/types";
import type { ChatMessage, MultiPartContent } from "../../types";
import type { OpenAITool } from "../../utils/tooling";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { resolveStudioPiProviderApiKey } from "../../studio/piAuth/StudioPiAuthStorage";
import { resolveConfiguredRemoteProviderEndpoint } from "./RemoteProviderCatalog";
import {
  GEMINI_API_KEY_HEADER,
  GEMINI_STREAM_ACTION,
  GEMINI_STREAM_QUERY,
} from "../../constants/gemini";
import { ERROR_CODES, SystemSculptError } from "../../utils/errors";

type RemoteGeminiStreamInput = {
  plugin: SystemSculptPlugin;
  prepared: PreparedChatRequest;
  signal?: AbortSignal;
  reasoningEffort?: string;
  debug?: StreamDebugCallbacks;
};

const GEMINI_PROVIDER_ID = "google";

// ────────────────────────────────────────────────────────────────────────────
// Gemini request-body construction
// ────────────────────────────────────────────────────────────────────────────

type GeminiTextPart = { text: string };
type GeminiInlineDataPart = {
  inlineData: { mimeType: string; data: string };
};
type GeminiFunctionCallPart = {
  functionCall: { name: string; args: Record<string, unknown> };
};
type GeminiFunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> };
};
type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

/**
 * Parse a data URL (or bare base64 payload) into the Gemini inlineData
 * `mimeType`/`data` pair. Returns null when the value is not a usable base64
 * image (e.g. a remote https URL, which inlineData cannot carry). Mirrors the
 * Anthropic executor's `parseImageSource` decision so behaviour stays aligned.
 */
function parseImageSource(
  url: string,
): { mimeType: string; data: string } | null {
  if (typeof url !== "string" || url.length === 0) return null;

  const dataUrlMatch = url.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (dataUrlMatch) {
    const mimeType = (dataUrlMatch[1] || "image/png").trim();
    const data = dataUrlMatch[2] || "";
    if (data.length === 0) return null;
    return { mimeType, data };
  }

  // Gemini's inlineData cannot fetch remote URLs; skip those.
  return null;
}

function toGeminiParts(parts: MultiPartContent[]): GeminiPart[] {
  const result: GeminiPart[] = [];
  for (const part of parts) {
    if (part && part.type === "text" && typeof part.text === "string") {
      // Gemini rejects empty text parts; substitute a single space.
      result.push({ text: part.text.length > 0 ? part.text : " " });
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
        result.push({
          inlineData: { mimeType: source.mimeType, data: source.data },
        });
      }
    }
  }
  return result;
}

function extractFunctionCallPart(
  toolCall: unknown,
): { name: string; args: Record<string, unknown> } | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const tc = toolCall as Record<string, any>;
  const req: Record<string, any> = (tc.request || tc) ?? {};
  const fn: Record<string, any> =
    req.function || tc.function || (req.name ? { name: req.name, arguments: req.arguments } : {});
  const name = typeof fn?.name === "string" ? fn.name.trim() : "";
  if (!name) return null;

  let args: Record<string, unknown> = {};
  const rawArgs = fn?.arguments;
  if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  }

  return { name, args };
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
 * Resolve the function name a `role: "tool"` message responds to. Gemini
 * correlates a functionResponse to its call by name (it has no id), so we
 * prefer the explicit `name`, then fall back to the tool_call_id, then a
 * non-empty placeholder.
 */
function resolveToolResponseName(message: ChatMessage): string {
  if (typeof message.name === "string" && message.name.trim().length > 0) {
    return message.name.trim();
  }
  if (typeof message.tool_call_id === "string" && message.tool_call_id.trim().length > 0) {
    return message.tool_call_id.trim();
  }
  return "tool";
}

/**
 * The Gemini functionResponse `response` field must be an object. If the tool
 * content already parses to a JSON object we pass it through; otherwise we wrap
 * the stringified content under `{ result }`.
 */
function buildToolResponsePayload(content: ChatMessage["content"]): Record<string, unknown> {
  const stringified = stringifyToolResultContent(content);
  if (stringified.trim().length > 0) {
    try {
      const parsed = JSON.parse(stringified);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON; fall through to the wrapped shape
    }
  }
  return { result: stringified };
}

/**
 * Translate the repo's `ChatMessage[]` history into Gemini `contents` turns.
 * System messages are dropped (the system prompt is a top-level
 * `systemInstruction`), assistant turns become role `"model"`, and tool results
 * collapse into `functionResponse` parts on a role `"user"` turn — adjacent tool
 * results merge into one turn, mirroring the Anthropic executor.
 */
export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const result: GeminiContent[] = [];

  for (const message of messages || []) {
    if (!message || message.role === "system") continue;

    if (message.role === "tool") {
      const part: GeminiFunctionResponsePart = {
        functionResponse: {
          name: resolveToolResponseName(message),
          response: buildToolResponsePayload(message.content),
        },
      };
      const last = result[result.length - 1];
      if (
        last &&
        last.role === "user" &&
        last.parts.every((p) => "functionResponse" in p)
      ) {
        last.parts.push(part);
      } else {
        result.push({ role: "user", parts: [part] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];

      if (typeof message.content === "string") {
        if (message.content.length > 0) {
          parts.push({ text: message.content });
        }
      } else if (Array.isArray(message.content)) {
        parts.push(...toGeminiParts(message.content));
      }

      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const fnCall = extractFunctionCallPart(toolCall);
          if (fnCall) {
            parts.push({ functionCall: { name: fnCall.name, args: fnCall.args } });
          }
        }
      }

      // Gemini rejects empty parts; fall back to a single space text part.
      result.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: " " }] });
      continue;
    }

    // role === "user"
    if (typeof message.content === "string") {
      result.push({
        role: "user",
        parts: [{ text: message.content.length > 0 ? message.content : " " }],
      });
    } else if (Array.isArray(message.content)) {
      const parts = toGeminiParts(message.content);
      result.push({ role: "user", parts: parts.length > 0 ? parts : [{ text: " " }] });
    } else {
      result.push({ role: "user", parts: [{ text: " " }] });
    }
  }

  return result;
}

/**
 * Convert OpenAI-style tool definitions (`{type, function:{...}}`) — or the
 * already-flattened `{name, description, parameters}` shape — into Gemini's
 * `functionDeclarations` entries (`{name, description?, parameters}`).
 */
export function toGeminiTools(tools: unknown[]): GeminiFunctionDeclaration[] {
  if (!Array.isArray(tools)) return [];
  const result: GeminiFunctionDeclaration[] = [];

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
      parameters,
    });
  }

  return result;
}

export function buildGeminiRequestBody(
  input: RemoteGeminiStreamInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(input.prepared.preparedMessages),
  };

  const system = input.prepared.finalSystemPrompt;
  if (typeof system === "string" && system.trim().length > 0) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  if (Array.isArray(input.prepared.tools) && input.prepared.tools.length > 0) {
    const functionDeclarations = toGeminiTools(input.prepared.tools as OpenAITool[]);
    if (functionDeclarations.length > 0) {
      body.tools = [{ functionDeclarations }];
    }
  }

  // Gemini does not require maxOutputTokens (unlike Anthropic). Only set it when
  // the model metadata declares a positive completion cap; otherwise omit
  // generationConfig entirely rather than inventing a default.
  const cap = input.prepared.resolvedModel?.top_provider?.max_completion_tokens;
  if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) {
    body.generationConfig = { maxOutputTokens: Math.floor(cap) };
  }

  return body;
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini SSE → StreamEvent parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * Maps Gemini candidate finishReason values onto the SAME stop-reason values
 * the OpenAI-compatible StreamPipeline emits (see
 * StreamPipeline.mapFinishReasonToPiStopReason), so downstream turn-loop logic
 * is provider-agnostic:
 *   MAX_TOKENS              → "length"
 *   STOP / STOP_SEQUENCE    → "toolUse" when a functionCall was seen, else "stop"
 *   SAFETY / RECITATION /
 *   OTHER / unknown         → "stop"
 *
 * Gemini emits `STOP` even when a functionCall is present, so `sawFunctionCall`
 * is how we surface tool use to the turn loop.
 */
function mapGeminiFinishReason(finishReason: string, sawFunctionCall: boolean): string {
  const uc = String(finishReason || "").trim().toUpperCase();
  if (!uc) return "stop";
  if (uc === "MAX_TOKENS") return "length";
  if (uc === "STOP" || uc === "STOP_SEQUENCE") return sawFunctionCall ? "toolUse" : "stop";
  // SAFETY / RECITATION / OTHER / anything unknown collapses to a clean stop.
  return "stop";
}

/**
 * Incremental parser for the Gemini `alt=sse` wire format. Mirrors
 * StreamPipeline's `push`/`flush` interface so it can be unit-tested directly
 * with raw SSE strings. Gemini emits `data: <GenerateContentResponse JSON>`
 * frames terminated by a blank line, with NO `event:` lines. A single JSON
 * object may arrive split across consecutive `data:` lines within one frame, so
 * we accumulate data lines and dispatch on the blank-line terminator; partial
 * lines buffer across `push` calls.
 */
export class GeminiStreamParser {
  private buffer = "";
  private readonly dataLines: string[] = [];
  private functionCallCounter = 0;
  private sawFunctionCall = false;

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

    // Dispatch any frame whose terminating blank line never arrived.
    events.push(...this.dispatchFrame());

    return events;
  }

  private consumeLine(line: string): StreamEvent[] {
    const trimmed = line.trim();

    // A blank line terminates the current SSE frame.
    if (trimmed.length === 0) {
      return this.dispatchFrame();
    }

    if (trimmed.startsWith(":")) {
      return []; // SSE comment / keep-alive
    }

    if (line.startsWith("data:")) {
      let dataLine = line.slice("data:".length);
      if (dataLine.startsWith(" ")) dataLine = dataLine.slice(1);
      this.dataLines.push(dataLine);
      return [];
    }

    return [];
  }

  private dispatchFrame(): StreamEvent[] {
    if (this.dataLines.length === 0) {
      return [];
    }

    // Gemini frames carry a single JSON object. When the server chops that
    // object across consecutive `data:` lines it is a transport split, not a
    // logical newline in the value, so we concatenate rather than join on "\n".
    const payload = this.dataLines.join("");
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

    return this.handleResponse(parsed);
  }

  private handleResponse(parsed: any): StreamEvent[] {
    const events: StreamEvent[] = [];

    // Top-level error object: { error: { code, message, status } }
    if (parsed && parsed.error && typeof parsed.error === "object") {
      const error = parsed.error;
      const message =
        (typeof error.message === "string" && error.message) || "Gemini stream error";
      const code = typeof error.code === "number" ? error.code : 500;
      throw new SystemSculptError(message, ERROR_CODES.STREAM_ERROR, code, {
        provider: GEMINI_PROVIDER_ID,
        rawError: error,
      });
    }

    const candidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : undefined;
    if (!candidate || typeof candidate !== "object") {
      return events;
    }

    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;

        if (part.functionCall && typeof part.functionCall === "object") {
          const name =
            typeof part.functionCall.name === "string" ? part.functionCall.name : "";
          const args =
            part.functionCall.args && typeof part.functionCall.args === "object"
              ? part.functionCall.args
              : {};
          // Gemini sends the complete call in one part and provides no id, so we
          // synthesize a stable one and emit both delta + final (the turn loop
          // treats the final, with full arguments, as authoritative).
          const call: StreamToolCall = {
            id: `call_${this.functionCallCounter++}_${name}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(args ?? {}),
            },
          };
          this.sawFunctionCall = true;
          events.push({ type: "tool-call", phase: "delta", call });
          events.push({ type: "tool-call", phase: "final", call });
          continue;
        }

        if (typeof part.text === "string") {
          if (part.text.length === 0) continue;
          if (part.thought === true) {
            events.push({ type: "reasoning", text: part.text });
          } else {
            events.push({ type: "content", text: part.text });
          }
        }
      }
    }

    if (typeof candidate.finishReason === "string" && candidate.finishReason.length > 0) {
      events.push({
        type: "meta",
        key: "stop-reason",
        value: mapGeminiFinishReason(candidate.finishReason, this.sawFunctionCall),
      });
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

export async function* executeGeminiRemoteStream(
  input: RemoteGeminiStreamInput,
): AsyncGenerator<StreamEvent, void, unknown> {
  const endpoint = resolveConfiguredRemoteProviderEndpoint(input.plugin, GEMINI_PROVIDER_ID);
  if (!endpoint) {
    throw new Error(`No remote endpoint configured for provider "${GEMINI_PROVIDER_ID}".`);
  }

  const apiKey = await resolveStudioPiProviderApiKey(GEMINI_PROVIDER_ID, {
    plugin: input.plugin,
  });
  if (!apiKey) {
    throw new Error(`Connect ${GEMINI_PROVIDER_ID} in Providers before using this model.`);
  }

  const requestBody = buildGeminiRequestBody(input);
  const client = new PlatformRequestClient();
  const debugHeaders = {
    [GEMINI_API_KEY_HEADER]: "[redacted]",
  };

  try {
    input.debug?.onRequest?.({
      provider: GEMINI_PROVIDER_ID,
      endpoint,
      headers: debugHeaders,
      body: requestBody,
      transport: "remote-provider",
      canStream: true,
      isCustomProvider: true,
    });
  } catch {}

  const url = `${endpoint.replace(/\/+$/, "")}/models/${encodeURIComponent(
    input.prepared.actualModelId,
  )}:${GEMINI_STREAM_ACTION}?${GEMINI_STREAM_QUERY}`;

  const response = await client.request({
    url,
    method: "POST",
    body: requestBody,
    stream: true,
    signal: input.signal,
    headers: {
      [GEMINI_API_KEY_HEADER]: apiKey,
      "content-type": "application/json",
    },
  });

  try {
    input.debug?.onResponse?.({
      provider: GEMINI_PROVIDER_ID,
      endpoint,
      status: response.status,
      headers: serializeResponseHeaders(response.headers),
      isCustomProvider: true,
    });
  } catch {}

  if (!response.ok) {
    await StreamingErrorHandler.handleStreamError(response, true, {
      provider: GEMINI_PROVIDER_ID,
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

  const parser = new GeminiStreamParser();
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
