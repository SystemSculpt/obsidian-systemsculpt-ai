import { ERROR_CODES, SystemSculptError, getErrorMessage } from "../utils/errors";
import { errorLogger } from "../utils/errorLogger";
import { createToolCallIdState, sanitizeToolCallId, ToolCallIdState } from "../utils/toolCallId";
import type {
  StreamEvent,
  StreamPipelineOptions,
  StreamPipelineResult,
  StreamPipelineDiagnostics,
  StreamToolCall,
} from "./types";

interface ToolCallAccumulatorState {
  index: number;
  rawId?: string;
  name?: string;
  arguments: string;
  type: "function";
  extra?: Record<string, unknown>;
  functionExtra?: Record<string, unknown>;
}

const DONE_MARKER = "[DONE]";
const MAX_DISCARDED_PAYLOAD_SAMPLES = 5;

type PiNativeToolCallPayload = {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

export class StreamPipeline {
  private readonly decoder = new TextDecoder();
  private readonly options: StreamPipelineOptions;
  private buffer = "";
  private insideThink = false;
  private readonly toolCalls = new Map<number, ToolCallAccumulatorState>();
  private readonly toolCallIdState: ToolCallIdState;
  private discardedPayloadCount = 0;
  private discardedPayloadSamples: string[] = [];
  private pendingDataLines: string[] = [];
  private sawPiNativeTextDelta = false;
  private sawPiNativeThinkingDelta = false;
  private sawPiNativeToolEvent = false;

  constructor(options: StreamPipelineOptions) {
    this.options = options;
    this.toolCallIdState = createToolCallIdState();
  }

  /**
   * Push a raw Uint8Array chunk from the network stream and convert it into
   * higher-level stream events that the rest of the pipeline can consume.
   */
  push(chunk: Uint8Array): StreamPipelineResult {
    const decoded = this.decoder.decode(chunk, { stream: true });
    this.buffer += decoded;

    const events: StreamEvent[] = [];
    let done = false;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      // Remove trailing carriage returns
      if (line.endsWith("\r")) line = line.slice(0, -1);

      const trimmed = line.trim();
      if (trimmed.length === 0) {
        const flushResult = this.flushPendingData();
        if (flushResult.events.length > 0) events.push(...flushResult.events);
        if (flushResult.done) done = true;
        continue;
      }

      if (trimmed.startsWith(":")) {
        continue; // SSE comments such as ': OPENROUTER PROCESSING'
      }
      if (trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith("retry:")) {
        continue;
      }

      if (trimmed.startsWith("data:")) {
        let dataLine = line.slice(line.indexOf("data:") + "data:".length);
        if (dataLine.startsWith(" ")) dataLine = dataLine.slice(1);
        this.pendingDataLines.push(dataLine);
        continue;
      }

      if (this.pendingDataLines.length > 0) {
        this.pendingDataLines.push(line);
        continue;
      }

      const payloadResult = this.handlePayload(trimmed, line);
      if (payloadResult.events.length > 0) events.push(...payloadResult.events);
      if (payloadResult.done) done = true;
    }

    return { events, done };
  }

  /**
   * Flush any remaining buffered data and finalize pending tool calls.
   */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];

    const trailingRaw = this.buffer;
    this.buffer = "";

    if (trailingRaw.length > 0) {
      let line = trailingRaw;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        if (trimmed.startsWith("data:")) {
          let dataLine = line.slice(line.indexOf("data:") + "data:".length);
          if (dataLine.startsWith(" ")) dataLine = dataLine.slice(1);
          this.pendingDataLines.push(dataLine);
        } else if (trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith("retry:") || trimmed.startsWith(":")) {
          // Ignore SSE control lines
        } else if (this.pendingDataLines.length > 0) {
          this.pendingDataLines.push(line);
        } else if (trimmed !== DONE_MARKER) {
          const { events: trailingEvents } = this.processPayload(trimmed, true);
          if (trailingEvents.length > 0) {
            events.push(...trailingEvents);
          }
        }
      }
    }

    const flushed = this.flushPendingData(true);
    if (flushed.events.length > 0) {
      events.push(...flushed.events);
    }

    // Finalize any tool calls that never sent a terminal message
    for (const [index, state] of this.toolCalls.entries()) {
      const finalCall = this.buildToolCall(state);
      events.push({ type: "tool-call", phase: "final", call: finalCall });
      this.toolCalls.delete(index);
    }

    return events;
  }

  public getDiagnostics(): StreamPipelineDiagnostics {
    return {
      discardedPayloadCount: this.discardedPayloadCount,
      discardedPayloadSamples: [...this.discardedPayloadSamples],
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private processPayload(payload: string, isFinalFlush = false): StreamPipelineResult {
    const events: StreamEvent[] = [];
    let done = false;

    let parsed: any = null;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      // Ignore all-caps provider status messages
      if (typeof payload === "string") {
        const statusCandidate = payload.trim();
        if (/^[A-Z0-9 _:-]+$/.test(statusCandidate)) {
          return { events, done };
        }
      }
      this.discardedPayloadCount += 1;
      if (this.discardedPayloadSamples.length < MAX_DISCARDED_PAYLOAD_SAMPLES) {
        this.discardedPayloadSamples.push(payload.slice(0, 240));
      }
      // Any other non-JSON payload is unexpected – log and ignore
      try {
        errorLogger.debug("StreamPipeline: discarding non-JSON payload", {
          source: "StreamPipeline",
          method: "processPayload",
          metadata: { preview: payload.slice(0, 160) },
        });
      } catch {}
      return { events, done };
    }

    if (parsed == null) {
      return { events, done };
    }

    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      const text = String(parsed);
      if (text.length > 0) {
        events.push(...this.splitContentByThinkTags(text));
      }
      return { events, done };
    }

    if (parsed.done === true) {
      done = true;
    }

    if (parsed.webSearchEnabled !== undefined) {
      events.push({ type: "meta", key: "web-search-enabled", value: parsed.webSearchEnabled });
    }

    const piNative = this.handlePiNativeEvent(parsed);
    if (piNative) {
      if (piNative.events.length > 0) {
        events.push(...piNative.events);
      }
      done = done || piNative.done;
      return { events, done };
    }

    if (parsed.error) {
      this.raiseStreamError(parsed);
    }

    if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
      const choice = parsed.choices[0] ?? {};
      const delta = choice.delta ?? {};
      const message = choice.message ?? {};

      // Reasoning chunks
      const reasoningText = this.normalizeText(
        delta.reasoning ??
        delta.reasoning_content ??
        delta.thinking ??
        message.reasoning ??
        message.reasoning_content ??
        message.thinking
      );
      if (reasoningText) {
        events.push({ type: "reasoning", text: reasoningText });
      }

      const deltaReasoningDetails = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : null;
      if (deltaReasoningDetails && deltaReasoningDetails.length > 0) {
        events.push({ type: "reasoning-details", details: deltaReasoningDetails });
      }
      const messageReasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : null;
      if (messageReasoningDetails && messageReasoningDetails.length > 0) {
        events.push({ type: "reasoning-details", details: messageReasoningDetails });
      }

      // Content chunks (delta or final message)
      const contentText = this.normalizeText(
        delta.content ??
        delta.text ??
        delta.output_text ??
        delta.output_text_delta ??
        message.content ??
        message.output_text ??
        message.output_text_delta
      );
      if (contentText) {
        events.push(...this.splitContentByThinkTags(contentText));
      }

      const annotations = Array.isArray(delta.annotations) && delta.annotations.length > 0
        ? delta.annotations
        : Array.isArray(message.annotations) && message.annotations.length > 0
          ? message.annotations
          : undefined;
      if (annotations) {
        events.push({ type: "annotations", annotations });
      }

      // Tool calls (delta or final message)
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        for (const raw of delta.tool_calls) {
          const event = this.handleToolCallDelta(raw);
          if (event) events.push(event);
        }
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const raw of message.tool_calls) {
          const event = this.handleToolCallFinal(raw);
          if (event) events.push(event);
        }
      }

      // Older OpenAI function_call delta shape
      if (delta.function_call) {
        const event = this.handleFunctionCallDelta(delta.function_call);
        if (event) events.push(event);
      }
      if (message.function_call) {
        const event = this.handleFunctionCallFinal(message.function_call);
        if (event) events.push(event);
      }

      if (typeof choice.finish_reason === "string" && choice.finish_reason === "stop") {
        done = done || isFinalFlush;
      }
    } else if (parsed.message?.content) {
      const contentText = this.normalizeText(parsed.message.content);
      if (contentText) {
        events.push(...this.splitContentByThinkTags(contentText));
      }
      const messageAnnotations = Array.isArray(parsed.message.annotations) && parsed.message.annotations.length > 0
        ? parsed.message.annotations
        : undefined;
      if (messageAnnotations) {
        events.push({ type: "annotations", annotations: messageAnnotations });
      }
    } else if (typeof parsed.text === "string") {
      events.push(...this.splitContentByThinkTags(parsed.text));
    } else if (parsed && typeof parsed === "object") {
      const fallbackText = this.normalizeText(parsed);
      if (fallbackText) {
        events.push(...this.splitContentByThinkTags(fallbackText));
      }
    }

    return { events, done };
  }

  private handlePiNativeEvent(parsed: any): { events: StreamEvent[]; done: boolean } | null {
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }

    const events: StreamEvent[] = [];
    const type = parsed.type;
    let done = false;

    switch (type) {
      case "text_delta": {
        if (typeof parsed.delta === "string" && parsed.delta.length > 0) {
          this.sawPiNativeTextDelta = true;
          events.push(...this.splitContentByThinkTags(parsed.delta));
        }
        break;
      }
      case "thinking_delta": {
        if (typeof parsed.delta === "string" && parsed.delta.length > 0) {
          this.sawPiNativeThinkingDelta = true;
          events.push({ type: "reasoning", text: parsed.delta });
        }
        break;
      }
      case "toolcall_delta": {
        const rawCall = this.normalizePiToolCallPayload(parsed.toolCall);
        if (!rawCall) break;
        this.sawPiNativeToolEvent = true;

        const event = this.handleToolCallDelta({
          index: typeof parsed.contentIndex === "number" ? parsed.contentIndex : 0,
          id: rawCall.id,
          function: {
            ...(rawCall.name ? { name: rawCall.name } : {}),
            ...(typeof rawCall.arguments === "string" ? { arguments: rawCall.arguments } : {}),
          },
        });
        if (event) events.push(event);
        break;
      }
      case "toolcall_end": {
        const rawCall = this.normalizePiToolCallPayload(parsed.toolCall);
        if (!rawCall) break;
        this.sawPiNativeToolEvent = true;

        const event = this.handleToolCallFinal({
          index: typeof parsed.contentIndex === "number" ? parsed.contentIndex : 0,
          id: rawCall.id,
          function: {
            ...(rawCall.name ? { name: rawCall.name } : {}),
            ...(typeof rawCall.arguments === "string" ? { arguments: rawCall.arguments } : {}),
          },
        });
        if (event) events.push(event);
        break;
      }
      case "done": {
        done = true;
        if (!this.shouldParsePiDoneMessage()) {
          break;
        }
        if (parsed.message && typeof parsed.message === "object") {
          events.push(...this.parsePiAssistantMessage(parsed.message));
        }
        break;
      }
      case "error": {
        const errorMessage =
          parsed?.error?.errorMessage ||
          parsed?.error?.message ||
          parsed?.errorMessage ||
          "PI runtime error";
        throw new SystemSculptError(String(errorMessage), ERROR_CODES.STREAM_ERROR, 500, {
          model: this.options.model,
          rawError: parsed?.error ?? parsed,
        });
      }
      // These PI event types are markers/aggregates and should not append output by default.
      // `text_end` and `thinking_end` usually carry fully aggregated block text and would
      // duplicate streaming deltas if appended.
      case "start":
      case "text_start":
      case "text_end":
      case "thinking_start":
      case "thinking_end":
      case "toolcall_start":
        break;
      default:
        return null;
    }

    return { events, done };
  }

  private shouldParsePiDoneMessage(): boolean {
    return !this.sawPiNativeTextDelta && !this.sawPiNativeThinkingDelta && !this.sawPiNativeToolEvent;
  }

  private parsePiAssistantMessage(message: any): StreamEvent[] {
    const events: StreamEvent[] = [];
    const content = Array.isArray(message?.content) ? message.content : [];

    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (!block || typeof block !== "object") continue;

      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        events.push(...this.splitContentByThinkTags(block.text));
        continue;
      }

      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
        events.push({ type: "reasoning", text: block.thinking });
        continue;
      }

      if (block.type === "toolCall") {
        const rawCall = this.normalizePiToolCallPayload(block);
        if (!rawCall || !rawCall.name) continue;
        const event = this.handleToolCallFinal({
          index: i,
          id: rawCall.id,
          function: {
            ...(rawCall.name ? { name: rawCall.name } : {}),
            ...(typeof rawCall.arguments === "string" ? { arguments: rawCall.arguments } : {}),
          },
        });
        if (event) events.push(event);
      }
    }

    return events;
  }

  private normalizePiToolCallPayload(
    value: unknown
  ): { id?: string; name?: string; arguments?: string } | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as PiNativeToolCallPayload;

    const id = typeof candidate.id === "string" && candidate.id.trim().length > 0
      ? candidate.id.trim()
      : undefined;
    const name = this.sanitizeToolName(typeof candidate.name === "string" ? candidate.name : "");
    let argumentsText: string | undefined;
    if (typeof candidate.arguments === "string") {
      argumentsText = candidate.arguments;
    } else if (candidate.arguments && typeof candidate.arguments === "object") {
      try {
        argumentsText = JSON.stringify(candidate.arguments);
      } catch {
        argumentsText = undefined;
      }
    }

    if (!id && !name && typeof argumentsText === "undefined") return null;

    return {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(typeof argumentsText === "string" ? { arguments: argumentsText } : {}),
    };
  }

  private handlePayload(payload: string, line?: string): StreamPipelineResult {
    const trimmed = payload.trim();
    if (!trimmed) return { events: [], done: false };

    try {
      this.options.onRawEvent?.({ line: line ?? payload, payload: trimmed });
    } catch {}

    if (trimmed === DONE_MARKER) {
      return { events: [], done: true };
    }

    return this.processPayload(trimmed);
  }

  private flushPendingData(isFinalFlush = false): StreamPipelineResult {
    if (this.pendingDataLines.length === 0) {
      return { events: [], done: false };
    }
    const payload = this.pendingDataLines.join("\n");
    this.pendingDataLines = [];
    const result = this.handlePayload(payload);
    if (result.done && isFinalFlush) {
      return result;
    }
    return result;
  }

  private raiseStreamError(payload: any): never {
    const errorData = payload.error || {};
    const errorCode = (errorData.code || ERROR_CODES.STREAM_ERROR) as keyof typeof ERROR_CODES;
    const message = errorData.message || getErrorMessage(errorCode, this.options.model);

    throw new SystemSculptError(message, errorCode, 500, {
      model: this.options.model,
      rawError: payload.error,
      provider: payload.provider,
      finishReason: payload.choices?.[0]?.finish_reason,
    });
  }

  private normalizeText(value: any): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value
        .map((entry) => this.normalizeText(entry))
        .filter((part): part is string => typeof part === "string" && part.length > 0);
      return parts.length > 0 ? parts.join("") : null;
    }
    if (typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.output_text === "string") return value.output_text;
      if (value.content !== undefined) return this.normalizeText(value.content);
      if (value.value !== undefined) return this.normalizeText(value.value);
    }
    return null;
  }

  private splitContentByThinkTags(text: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (this.insideThink) {
        const closeIdx = remaining.indexOf("</think>");
        if (closeIdx === -1) {
          if (remaining.length > 0) {
            events.push({ type: "reasoning", text: remaining });
          }
          remaining = "";
        } else {
          const reasoningText = remaining.slice(0, closeIdx);
          if (reasoningText.length > 0) {
            events.push({ type: "reasoning", text: reasoningText });
          }
          remaining = remaining.slice(closeIdx + "</think>".length);
          this.insideThink = false;
        }
        continue;
      }

      const openIdx = remaining.indexOf("<think>");
      if (openIdx === -1) {
        if (remaining.length > 0) {
          events.push({ type: "content", text: remaining });
        }
        remaining = "";
        break;
      }

      const before = remaining.slice(0, openIdx);
      if (before.length > 0) {
        events.push({ type: "content", text: before });
      }
      remaining = remaining.slice(openIdx + "<think>".length);
      this.insideThink = true;
    }

    return events;
  }

  private handleToolCallDelta(raw: any): StreamEvent | null {
    const index = typeof raw?.index === "number" ? raw.index : 0;
    const rawId = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    const functionData = raw?.function ?? {};
    const name = this.sanitizeToolName(functionData.name || raw?.name || "");
    const argsDelta = typeof functionData.arguments === "string" ? functionData.arguments : "";
    const extra = this.extractToolCallExtras(raw);
    const functionExtra = this.extractToolCallFunctionExtras(functionData);

    const state = this.toolCalls.get(index) ?? {
      index,
      rawId,
      name,
      arguments: "",
      type: "function" as const,
      extra: {},
      functionExtra: {},
    };

    if (rawId) state.rawId = rawId;
    if (name) state.name = name;
    if (argsDelta) state.arguments += argsDelta;
    if (extra && Object.keys(extra).length > 0) {
      state.extra = { ...(state.extra ?? {}), ...extra };
    }
    if (functionExtra && Object.keys(functionExtra).length > 0) {
      state.functionExtra = { ...(state.functionExtra ?? {}), ...functionExtra };
    }

    this.toolCalls.set(index, state);

    const call = this.buildToolCall(state);
    return { type: "tool-call", phase: "delta", call };
  }

  private handleToolCallFinal(raw: any): StreamEvent | null {
    const index = typeof raw?.index === "number" ? raw.index : 0;
    const extra = this.extractToolCallExtras(raw);
    const functionExtra = this.extractToolCallFunctionExtras(raw?.function);
    const state = this.toolCalls.get(index) ?? {
      index,
      rawId: typeof raw?.id === "string" ? raw.id : undefined,
      name: this.sanitizeToolName(raw?.function?.name || raw?.name || ""),
      arguments: "",
      type: "function" as const,
      extra: {},
      functionExtra: {},
    };

    if (typeof raw?.id === "string" && raw.id.length > 0) {
      state.rawId = raw.id;
    }
    const name = this.sanitizeToolName(raw?.function?.name || raw?.name || "");
    if (name) state.name = name;

    if (typeof raw?.function?.arguments === "string") {
      state.arguments = raw.function.arguments;
    }
    if (extra && Object.keys(extra).length > 0) {
      state.extra = { ...(state.extra ?? {}), ...extra };
    }
    if (functionExtra && Object.keys(functionExtra).length > 0) {
      state.functionExtra = { ...(state.functionExtra ?? {}), ...functionExtra };
    }

    const call = this.buildToolCall(state);
    this.toolCalls.delete(index);
    return { type: "tool-call", phase: "final", call };
  }

  private handleFunctionCallDelta(raw: any): StreamEvent | null {
    const synthetic = {
      index: 0,
      id: typeof raw?.id === "string" ? raw.id : undefined,
      function: raw,
    };
    return this.handleToolCallDelta(synthetic);
  }

  private handleFunctionCallFinal(raw: any): StreamEvent | null {
    const synthetic = {
      index: 0,
      id: typeof raw?.id === "string" ? raw.id : undefined,
      function: raw,
    };
    return this.handleToolCallFinal(synthetic);
  }

  private buildToolCall(state: ToolCallAccumulatorState): StreamToolCall {
    const name = state.name || "tool";
    const id = sanitizeToolCallId(state.rawId, state.index, this.toolCallIdState);
    const args = state.arguments;

    return {
      id,
      index: state.index,
      type: state.type,
      ...(state.extra ?? {}),
      function: {
        ...(state.functionExtra ?? {}),
        name,
        arguments: args,
      },
    };
  }

  private extractToolCallExtras(raw: any): Record<string, unknown> {
    if (!raw || typeof raw !== "object") return {};
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "id" || key === "index" || key === "type" || key === "function") continue;
      extra[key] = value;
    }
    return extra;
  }

  private extractToolCallFunctionExtras(rawFn: any): Record<string, unknown> {
    if (!rawFn || typeof rawFn !== "object") return {};
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawFn)) {
      if (key === "name" || key === "arguments") continue;
      extra[key] = value;
    }
    return extra;
  }

  private sanitizeToolName(name: string): string {
    if (!name) return "";
    let sanitized = String(name).trim();
    while (sanitized.startsWith("functions.")) {
      sanitized = sanitized.slice("functions.".length);
    }

    if (!sanitized.includes(":")) {
      return sanitized;
    }

    // Providers disagree on colon semantics:
    // - Namespace prefixes: `default_api:read`, `default_api:mcp-filesystem_read`
    // - Suffix payload/index: `read:1_foo`, `mcp-filesystem_edit:1_foo`
    const parts = sanitized.split(":").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];

    const mcpPart = parts.find((part) => part.startsWith("mcp-") || part.startsWith("mcp_"));
    if (mcpPart) {
      return mcpPart;
    }

    const first = parts[0];
    const last = parts[parts.length - 1];
    const canonicalPiTools = new Set([
      "read", "write", "edit", "find", "grep", "ls", "move", "trash", "mkdir", "open", "context"
    ]);
    const firstLooksLikeNamespace = /(^|[_-])api$/i.test(first) || /^default_api$/i.test(first);
    const lastLooksLikeProviderSuffix = /^\d+[_-]/.test(last) || /^[a-z]+_[a-z0-9]+$/i.test(last);

    if (canonicalPiTools.has(last.toLowerCase()) || firstLooksLikeNamespace) {
      return last;
    }
    if (lastLooksLikeProviderSuffix) {
      return first;
    }
    return first;
  }
}
