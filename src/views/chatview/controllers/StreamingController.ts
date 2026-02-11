import { Component } from "obsidian";
import { ChatMessage, MessagePart, Annotation } from "../../../types";
import type { StreamEvent, StreamToolCall } from "../../../streaming/types";
import { ToolCallManager } from "../ToolCallManager";
import { ScrollManagerService } from "../ScrollManagerService";
import { MessageRenderer } from "../MessageRenderer";
import { SystemSculptError, ERROR_CODES } from "../../../utils/errors";
import { errorLogger } from "../../../utils/errorLogger";
import { ToolCall, ToolCallRequest } from "../../../types/toolCalls";
import { TranscriptAssembler } from "../transcript/TranscriptAssembler";
import { ChatPersistenceManager } from "../persistence/ChatPersistenceManager";
import { createToolCallIdState, sanitizeToolCallId, ToolCallIdState } from "../../../utils/toolCallId";
import { StreamingMetricsTracker, StreamingMetrics } from "../StreamingMetricsTracker";

export interface StreamingControllerOptions {
  toolCallManager: ToolCallManager;
  scrollManager: ScrollManagerService;
  messageRenderer: MessageRenderer;
  saveChat: () => Promise<void>;
  generateMessageId: () => string;
  extractAnnotations: (text: string) => any[];
  showStreamingStatus: (el: HTMLElement) => void;
  hideStreamingStatus: (el: HTMLElement) => void;
  updateStreamingStatus: (el: HTMLElement, status: string, text: string, metrics?: StreamingMetrics) => void;
  toggleStopButton: (show: boolean) => void;
  onAssistantResponse: (msg: ChatMessage) => Promise<void>;
  onError: (err: string | SystemSculptError) => void;
  setStreamingFootnote?: (el: HTMLElement, text: string) => void;
  clearStreamingFootnote?: (el: HTMLElement) => void;
  autosaveDebounceMs?: number;
}

export class StreamingController extends Component {
  private readonly opts: StreamingControllerOptions;
  private readonly activeAssemblers = new Map<string, TranscriptAssembler>();
  private readonly persistence: ChatPersistenceManager;
  private scrollScheduled = false;

  constructor(options: StreamingControllerOptions) {
    super();
    this.opts = options;
    this.persistence = new ChatPersistenceManager({
      saveChat: options.saveChat,
      onAssistantResponse: options.onAssistantResponse,
      debounceMs: options.autosaveDebounceMs,
    });
  }

  public async stream(
    stream: AsyncGenerator<StreamEvent>,
    messageEl: HTMLElement,
    messageId: string,
    abortSignal: AbortSignal,
    seedParts?: MessagePart[],
    externalTracker?: StreamingMetricsTracker,
    skipIndicatorLifecycle?: boolean,
  ): Promise<{ messageId: string; message: ChatMessage; messageEl: HTMLElement; completed: boolean; stopReason?: string }> {
    const {
      toolCallManager,
      scrollManager,
      updateStreamingStatus,
      showStreamingStatus,
      hideStreamingStatus,
      toggleStopButton,
      onError,
      setStreamingFootnote,
      clearStreamingFootnote,
      extractAnnotations,
    } = this.opts;

    const assembler = this.ensureAssembler(messageId);
    assembler.begin(seedParts);

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: "",
      message_id: messageId,
      messageParts: assembler.getParts(),
    } as any;

    const toolCallIdState = createToolCallIdState();
    const pendingToolCalls = new Map<string, StreamToolCall>();
    const emittedToolCalls = new Set<string>();

    let stopReason: string | undefined;
    let collectedAnnotations: Annotation[] = [];
    const collectedReasoningDetails: unknown[] = [];

    const streamStartTime = performance.now();
    let eventCount = 0;

    // Use external tracker if provided (turn-level), otherwise create local one (per-stream)
    const ownsTracker = !externalTracker;
    const metricsTracker = externalTracker ?? new StreamingMetricsTracker({
      onUpdate: (metrics) => {
        updateStreamingStatus(messageEl, metrics.status, metrics.statusLabel, metrics);
      },
    });

    toggleStopButton(true);
    if (!skipIndicatorLifecycle) {
      showStreamingStatus(messageEl);
    }
    if (ownsTracker) {
      metricsTracker.start();
    }

    let abortedBySignal = false;
    let completedNaturally = false;
    try {
      for await (const event of stream) {
        eventCount++;
        if (abortSignal.aborted) {
          try {
            errorLogger.debug("Stream aborted by signal", {
              source: "StreamingController",
              method: "stream",
              metadata: { messageId },
            });
          } catch {}
          abortedBySignal = true;
          break;
        }

        switch (event.type) {
          case "reasoning": {
            assembler.apply(event);
            this.updateMessageRendering(assembler, messageEl, assistantMessage, true);
            metricsTracker.setStatus("reasoning");
            break;
          }
          case "reasoning-details": {
            if (Array.isArray(event.details) && event.details.length > 0) {
              collectedReasoningDetails.push(...event.details);
            }
            break;
          }
          case "content": {
            assembler.apply(event);
            this.updateMessageRendering(assembler, messageEl, assistantMessage, true);
            metricsTracker.setStatus("content");
            break;
          }
          case "tool-call": {
            metricsTracker.setStatus("tool_calls");
            this.handleToolCallEvent({
              event,
              assembler,
              messageEl,
              assistantMessage,
              messageId,
              pendingToolCalls,
              emittedToolCalls,
              toolCallIdState,
            });
            break;
          }
          case "annotations": {
            if (Array.isArray(event.annotations)) {
              collectedAnnotations = [...event.annotations];
            }
            break;
          }
          case "meta": {
            if (event.key === "inline-footnote" && setStreamingFootnote) {
              setStreamingFootnote(messageEl, String(event.value ?? ""));
            } else if (event.key === "stop-reason") {
              const normalized = String(event.value ?? "").trim();
              stopReason = normalized.length > 0 ? normalized : undefined;
            }
            break;
          }
          case "footnote": {
            if (setStreamingFootnote) {
              setStreamingFootnote(messageEl, event.text);
            }
            break;
          }
          default:
            break;
        }

        this.scheduleStickToBottom(scrollManager);
      }
      // Abort can happen while awaiting the next event (no further events emitted).
      // In that case the loop exits naturally, so we need a final abort check here.
      if (abortSignal.aborted) {
        abortedBySignal = true;
      }

      // If we exit the loop without throwing and not via abort, mark as completed
      if (!abortedBySignal) completedNaturally = true;
    } catch (err: any) {
      try {
        errorLogger.error("Stream error in StreamingController", err, {
          source: "StreamingController",
          method: "stream",
          metadata: { messageId },
        });
      } catch {}

      if (onError) {
        if (err instanceof SystemSculptError) {
          onError(err);
        } else {
          const errorMessage = err?.message || err?.toString?.() || "Unknown streaming error";
          onError(new SystemSculptError(errorMessage, ERROR_CODES.STREAM_ERROR, 500, { cause: err }));
        }
      }
      throw err;
    } finally {
      if (ownsTracker) {
        metricsTracker.stop();
      }
      toggleStopButton(false);
      if (!skipIndicatorLifecycle) {
        hideStreamingStatus(messageEl);
        if (clearStreamingFootnote) {
          try { clearStreamingFootnote(messageEl); } catch {}
        }
      }

      const summary = assembler.finalize();
      assistantMessage.content = summary.content;
      assistantMessage.reasoning = summary.reasoning || undefined;
      assistantMessage.messageParts = summary.parts;
      assistantMessage.tool_calls = this.collectToolCalls(summary.parts);
      assistantMessage.reasoning_details = collectedReasoningDetails.length > 0 ? collectedReasoningDetails : undefined;

      // OpenRouter -> Gemini sometimes omits `reasoning_details[].id` even though follow-up
      // tool continuations require it for thought signatures. When possible, backfill it
      // from the tool_calls array using `reasoning_details[].index` (tool call index).
      if (Array.isArray(assistantMessage.tool_calls) && Array.isArray((assistantMessage as any).reasoning_details)) {
        const toolCalls = assistantMessage.tool_calls as any[];
        const details = (assistantMessage as any).reasoning_details as any[];
        for (const detail of details) {
          if (!detail || typeof detail !== "object") continue;
          if (typeof detail.id === "string" && detail.id.length > 0) continue;

          const idx = Number(detail.index);
          if (Number.isFinite(idx) && idx >= 0 && idx < toolCalls.length) {
            const toolId = toolCalls[idx]?.id;
            if (typeof toolId === "string" && toolId.length > 0) {
              detail.id = toolId;
              continue;
            }
          }

          if (toolCalls.length === 1) {
            const soleId = toolCalls[0]?.id;
            if (typeof soleId === "string" && soleId.length > 0) {
              detail.id = soleId;
            }
          }
        }
      }
      const resolvedAnnotations = collectedAnnotations.length > 0
        ? [...collectedAnnotations]
        : extractAnnotations(summary.content);
      assistantMessage.annotations = resolvedAnnotations;
      if (stopReason) {
        (assistantMessage as any).stopReason = stopReason;
      }

      const hasRenderableOutput =
        summary.content.trim().length > 0 ||
        ((summary.reasoning ?? "").trim().length > 0) ||
        ((assistantMessage.tool_calls?.length ?? 0) > 0);

      if (!abortedBySignal && completedNaturally && !hasRenderableOutput) {
        completedNaturally = false;
        try {
          messageEl.remove();
        } catch {}
        try {
          onError(
            new SystemSculptError(
              "Upstream model returned an empty completion.",
              ERROR_CODES.STREAM_ERROR,
              502
            )
          );
        } catch {}
      }

      // Only persist if: not aborted, and either completed naturally or we recovered from an error
      const completedSuccessfully = !abortedBySignal && completedNaturally;
      if (completedSuccessfully) {
        this.updateMessageRendering(assembler, messageEl, assistantMessage, false);
        // Finalize inline blocks (auto-collapse reasoning/tool blocks)
        try {
          this.opts.messageRenderer.finalizeInlineBlocks(messageEl);
        } catch {}
        await this.persistence.commit(assistantMessage);
      } else {
        // Ensure any pending autosave timers are cancelled so partial output is not saved
        try { this.persistence.cancelAutosave(); } catch {}
      }

      this.scheduleStickToBottom(scrollManager, true);

      const streamEndTime = performance.now();
      const streamDuration = streamEndTime - streamStartTime;
      const plugin = (this.opts as any).app?.plugins?.plugins?.['systemsculpt-plugin'];
      const debugMode = plugin?.settingsManager?.settings?.debugMode ?? false;
      if (debugMode) {
        console.debug(`[StreamingController] Stream finished in ${streamDuration.toFixed(2)}ms. Total events: ${eventCount}`);
      }
    }

    const completed = !abortedBySignal && completedNaturally;
    return {
      messageId: assistantMessage.message_id ?? messageId,
      message: assistantMessage,
      messageEl,
      completed,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  public finalizeMessage(messageId: string): void {
    this.activeAssemblers.delete(messageId);
  }

  private ensureAssembler(messageId: string): TranscriptAssembler {
    let assembler = this.activeAssemblers.get(messageId);
    if (!assembler) {
      assembler = new TranscriptAssembler();
      this.activeAssemblers.set(messageId, assembler);
    }
    return assembler;
  }

  private updateMessageRendering(
    assembler: TranscriptAssembler,
    messageEl: HTMLElement,
    assistantMessage: ChatMessage,
    isStreaming: boolean,
  ): void {
    const parts = assembler.getParts();
    assistantMessage.messageParts = parts;
    try {
      this.opts.messageRenderer.renderMessageParts(messageEl, { messageParts: parts }, isStreaming);
    } catch {}
    this.persistence.scheduleAutosave();
  }

  private handleToolCallEvent(params: {
    event: StreamEvent & { type: "tool-call" };
    assembler: TranscriptAssembler;
    messageEl: HTMLElement;
    assistantMessage: ChatMessage;
    messageId: string;
    pendingToolCalls: Map<string, StreamToolCall>;
    emittedToolCalls: Set<string>;
    toolCallIdState: ToolCallIdState;
  }): void {
    const {
      event,
      assembler,
      messageEl,
      assistantMessage,
      messageId,
      pendingToolCalls,
      emittedToolCalls,
      toolCallIdState,
    } = params;

    const { toolCallManager } = this.opts;
    if (!toolCallManager) return;

    const callIndex = typeof event.call.index === "number" ? event.call.index : 0;
    const sanitizedId = sanitizeToolCallId(event.call.id, callIndex, toolCallIdState);

    if (event.phase === "delta") {
      const existing = pendingToolCalls.get(sanitizedId);
      const merged: StreamToolCall = {
        ...(existing ?? {}),
        ...event.call,
        id: sanitizedId,
        function: {
          ...(existing?.function ?? {}),
          ...(event.call.function ?? {}),
          name: event.call.function.name || existing?.function.name || "",
          arguments: event.call.function.arguments || existing?.function.arguments || "",
        },
      } as StreamToolCall;
      pendingToolCalls.set(sanitizedId, merged);
      return;
    }

    if (emittedToolCalls.has(sanitizedId)) {
      return;
    }

    const aggregated = pendingToolCalls.get(sanitizedId);
    pendingToolCalls.delete(sanitizedId);

    const effectiveCall: StreamToolCall = {
      ...(aggregated ?? {}),
      ...event.call,
      id: sanitizedId,
      type: "function",
      function: {
        ...(aggregated?.function ?? {}),
        ...(event.call.function ?? {}),
        name: event.call.function.name || aggregated?.function.name || "",
        arguments: event.call.function.arguments || aggregated?.function.arguments || "",
      },
    } as StreamToolCall;

    if (!effectiveCall.function.name) {
      try {
        errorLogger.debug("Skipping tool call without function name", {
          source: "StreamingController",
          method: "handleToolCallEvent",
          metadata: { messageId, toolCallId: sanitizedId },
        });
      } catch {}
      return;
    }

    let normalizedArgs = effectiveCall.function.arguments || "";

    const { index: _index, ...withoutIndex } = effectiveCall as any;

    const request: ToolCallRequest = {
      ...withoutIndex,
      id: sanitizedId,
      type: "function",
      function: {
        ...(withoutIndex.function ?? {}),
        name: effectiveCall.function.name,
        arguments: normalizedArgs,
      },
    };

    const toolCall = toolCallManager.createToolCall(request, messageId);
    if (!toolCall) {
      try {
        errorLogger.debug("Tool call manager returned null", {
          source: "StreamingController",
          method: "handleToolCallEvent",
          metadata: { messageId, toolCallId: sanitizedId },
        });
      } catch {}
      return;
    }

    emittedToolCalls.add(toolCall.id);
    assembler.attachToolCall(toolCall);
    this.updateMessageRendering(assembler, messageEl, assistantMessage, true);
  }

  private collectToolCalls(parts: MessagePart[]): ToolCall[] | undefined {
    const calls = parts
      .filter((part): part is MessagePart & { type: "tool_call"; data: ToolCall } => part.type === "tool_call")
      .map((part) => part.data);
    return calls.length > 0 ? calls : undefined;
  }

  private scheduleStickToBottom(scrollManager: ScrollManagerService, immediate = false): void {
    if (immediate) {
      try { scrollManager.requestStickToBottom("assistant-chunk", { immediate: true }); } catch {}
      return;
    }
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    const run = () => {
      this.scrollScheduled = false;
      try { scrollManager.requestStickToBottom("assistant-chunk"); } catch {}
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => run());
    } else {
      setTimeout(run, 0);
    }
  }
}
