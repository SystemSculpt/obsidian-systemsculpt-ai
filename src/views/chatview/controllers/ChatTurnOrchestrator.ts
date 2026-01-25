import { App } from 'obsidian';
import { ChatMessage } from '../../../types';
import { SystemSculptService } from '../../../services/SystemSculptService';
import { StreamingController } from './StreamingController';
import { ToolCallManager } from '../ToolCallManager';
import { MessageRenderer } from '../MessageRenderer';
import { WEB_SEARCH_CONFIG } from '../../../constants/webSearch';
import { errorLogger } from '../../../utils/errorLogger';
import type { ChatDebugLogService } from '../ChatDebugLogService';
import { StreamingMetricsTracker, StreamingMetrics } from '../StreamingMetricsTracker';
import { SystemSculptError } from '../../../utils/errors';
import { RuntimeIncompatibilityService } from '../../../services/RuntimeIncompatibilityService';

type Host = {
  app: App;
  plugin: any; // Plugin reference for accessing services
  aiService: SystemSculptService;
  streamingController: StreamingController;
  toolCallManager: ToolCallManager | undefined;
  messageRenderer: MessageRenderer;

  // Chat state accessors
  getMessages: () => ChatMessage[];
  getSelectedModelId: () => string;
  getSystemPrompt: () => { type?: string; path?: string };
  getSystemPromptOverride?: () => string | null;
  getContextFiles: () => Set<string>;
  getChatId?: () => string;
  getDebugLogger?: () => ChatDebugLogService | null;
  agentMode: () => boolean;
  webSearchEnabled: () => boolean;

  // UI helpers
  createAssistantMessageContainer: (breakGroup?: boolean) => { messageEl: HTMLElement; contentEl: HTMLElement };
  generateMessageId: () => string;
  onAssistantResponse: (msg: ChatMessage) => Promise<void>;
  onError: (err: any) => void;

  // Streaming indicator lifecycle (turn-level management)
  showStreamingStatus: (el: HTMLElement) => void;
  hideStreamingStatus: (el: HTMLElement) => void;
  updateStreamingStatus: (el: HTMLElement, status: string, text: string, metrics?: StreamingMetrics) => void;
  setStreamingFootnote?: (el: HTMLElement, text: string) => void;
  clearStreamingFootnote?: (el: HTMLElement) => void;
  onCompatibilityNotice?: (info: { modelId: string; tools?: boolean; images?: boolean; source: "cached" | "runtime" }) => void;
};

export interface ChatTurnOptions {
  signal: AbortSignal;
  includeContextFiles: boolean;
}

/**
 * ChatTurnOrchestrator centralizes one conversation turn:
 * - starts assistant stream
 * - watches tool-calls for that turn and executes continuation when finished
 * - limits continuation depth to prevent loops
 */
export class ChatTurnOrchestrator {
  private readonly host: Host;
  private readonly ai: SystemSculptService;
  private readonly streamer: StreamingController;
  private readonly tools?: ToolCallManager;
  private activeAssistantMessage: { messageId: string; messageEl: HTMLElement } | null = null;
  private continuationState: { messageId: string; seenToolCalls: Set<string> } | null = null;
  private readonly MAX_TOOL_CONTINUATIONS = 12;

  constructor(host: Host) {
    this.host = host;
    this.ai = host.aiService;
    this.streamer = host.streamingController;
    this.tools = host.toolCallManager;
  }

  private notifyCompatibility(modelId: string, info: { tools?: boolean; images?: boolean; source: "cached" | "runtime" }): void {
    if (!this.host.onCompatibilityNotice) return;
    if (!info.tools && !info.images) return;
    try {
      this.host.onCompatibilityNotice({
        modelId,
        tools: !!info.tools,
        images: !!info.images,
        source: info.source,
      });
    } catch {}
  }

  public async runTurn(options: ChatTurnOptions): Promise<void> {
    const { includeContextFiles, signal } = options;

    // Ensure no stale assistant turn state carries over
    this.finalizeActiveAssistantMessage();
    this.resetContinuationState();

    // Create container early so we can manage indicator lifecycle at turn level
    const container = this.ensureAssistantMessageContainer();
    const { messageEl } = container;

    // Create turn-level metrics tracker
    const metricsTracker = new StreamingMetricsTracker({
      onUpdate: (metrics) => {
        this.host.updateStreamingStatus(messageEl, metrics.status, metrics.statusLabel, metrics);
      },
    });

    // Show indicator once at turn start
    this.host.showStreamingStatus(messageEl);
    metricsTracker.start();

    try {
      // First assistant response (may include tool calls)
      const first = await this.streamAssistant({ includeContextFiles, signal, metricsTracker });
      if (!first) return; // aborted

      // If agent mode off or no tool manager, no continuation
      if (!this.host.agentMode() || !this.tools) return;

      this.initializeContinuationState(first.messageId);

      // Continuation loop: keep going while each assistant message produced tool calls
      // and there is no later user message. Bounded to prevent infinite loops.
      let currentMessageId = first.messageId;
      let iteration = 0;
      for (;;) {
        if (signal.aborted) {
          errorLogger.debug('Aborting continuation loop due to signal', {
            source: 'ChatTurnOrchestrator',
            method: 'runTurn',
          });
          break;
        }
        if (iteration >= this.MAX_TOOL_CONTINUATIONS) {
          this.host.onError(new Error(`Stopped after ${this.MAX_TOOL_CONTINUATIONS} tool continuations to prevent an infinite loop.`));
          break;
        }
        iteration += 1;
        errorLogger.debug('Continuation check', {
          source: 'ChatTurnOrchestrator',
          method: 'runTurn',
          metadata: { iteration, currentMessageId },
        });

        // Update status while waiting for tools
        metricsTracker.setStatus("executing_tools");

        const result = await this.continueAfterTools(currentMessageId, signal, metricsTracker);
        if (!result) {
          errorLogger.debug('No further continuation needed', {
            source: 'ChatTurnOrchestrator',
            method: 'runTurn',
            metadata: { iteration, currentMessageId },
          });
          break;
        }
        currentMessageId = result.newMessageId;
      }
    } finally {
      metricsTracker.stop();
      this.host.hideStreamingStatus(messageEl);
      this.finalizeActiveAssistantMessage();
      this.resetContinuationState();
    }
  }

  private async streamAssistant({
    includeContextFiles,
    signal,
    metricsTracker,
    retryContext,
  }: {
    includeContextFiles: boolean;
    signal: AbortSignal;
    metricsTracker?: StreamingMetricsTracker;
    retryContext?: { skipTools?: boolean; skipImages?: boolean; isRetry?: boolean };
  }): Promise<{ messageId: string } | null> {
    const container = this.ensureAssistantMessageContainer();
    let { messageEl, messageId } = container;

    // Get incompatibility service to check/mark models
    const incompatService = RuntimeIncompatibilityService.getInstance(this.host.plugin);
    const modelId = this.host.getSelectedModelId();

    // Check if model is already known to be incompatible
    const knownToolIncompat = incompatService.isToolIncompatible(modelId);
    const knownImageIncompat = incompatService.isImageIncompatible(modelId);

    // Determine effective agent mode and context handling
    const skipTools = retryContext?.skipTools || knownToolIncompat;
    const skipImages = retryContext?.skipImages || knownImageIncompat;
    const effectiveAgentMode = this.host.agentMode() && !skipTools;

    if (knownToolIncompat || knownImageIncompat) {
      this.notifyCompatibility(modelId, {
        tools: knownToolIncompat,
        images: knownImageIncompat,
        source: "cached",
      });
    }

    // Build provider stream request using the same inputs as StreamFactory but via helper
    const { toApiBaseMessages } = await import('../../../utils/messages/toApiMessages');
    const messagesForApi = toApiBaseMessages(this.host.getMessages());
    const sys = this.host.getSystemPrompt();
    const systemPromptOverride = this.host.getSystemPromptOverride?.() ?? undefined;
    // If skipImages, don't include context files (which may contain images)
    const contextFiles = (includeContextFiles && !skipImages) ? this.host.getContextFiles() : new Set<string>();
    const debugLogger = this.host.getDebugLogger?.() ?? null;
    const debugCallbacks = debugLogger?.createStreamLogger({
      chatId: this.host.getChatId?.(),
      assistantMessageId: messageId,
      modelId,
    });

    let stream: AsyncGenerator<any>;
    try {
      stream = this.ai.streamMessage({
        messages: messagesForApi,
        model: modelId,
        contextFiles,
        systemPromptType: sys.type,
        systemPromptPath: sys.path,
        systemPromptOverride,
        agentMode: effectiveAgentMode,
        signal,
        toolCallManager: effectiveAgentMode ? this.tools : undefined,
        plugins: this.host.webSearchEnabled()
          ? [{ id: WEB_SEARCH_CONFIG.PLUGIN_ID, max_results: WEB_SEARCH_CONFIG.MAX_RESULTS }]
          : undefined,
        web_search_options: this.host.webSearchEnabled()
          ? { search_context_size: WEB_SEARCH_CONFIG.DEFAULT_CONTEXT_SIZE }
          : undefined,
        debug: debugCallbacks || undefined,
      });
      errorLogger.debug('Started assistant stream', {
        source: 'ChatTurnOrchestrator',
        method: 'streamAssistant',
        metadata: { messageId, includeContextFiles, skipTools, skipImages, isRetry: retryContext?.isRetry },
      });
    } catch (e) {
      this.host.onError(e);
      return null;
    }

    // Hook tool state updates to keep UI in sync for this specific assistant message
    const unsubscribers: Array<() => void> = [];
    if (this.tools && effectiveAgentMode) {
      const updateWrapper = (toolCallId: string) => {
        try {
          const wrapper = messageEl.querySelector(`.systemsculpt-chat-structured-line[data-tool-call-id="${toolCallId}"]`) as HTMLElement | null;
          if (!wrapper) return;
          const tc = this.tools!.getToolCall(toolCallId);
          if (!tc) return;
          const part = {
            id: wrapper.dataset.partId || `tool_call_part-${tc.id}`,
            type: 'tool_call',
            timestamp: tc.timestamp,
            data: tc,
          } as any;
          // Force an immediate refresh for responsiveness
          this.host.messageRenderer.updateExistingPart(wrapper, part, false);
        } catch {}
      };

      const sub = this.tools.on('tool-call:state-changed', ({ toolCallId }) => updateWrapper(toolCallId));
      unsubscribers.push(sub);
      const sub2 = this.tools.on('tool-call:execution-completed', ({ toolCallId }) => updateWrapper(toolCallId));
      unsubscribers.push(sub2);
      const sub3 = this.tools.on('tool-call:execution-failed', ({ toolCallId }) => updateWrapper(toolCallId));
      unsubscribers.push(sub3);
      const sub4 = this.tools.on('tool-call:denied', ({ toolCallId }) => updateWrapper(toolCallId));
      unsubscribers.push(sub4);
    }

    let outcome: Awaited<ReturnType<typeof this.streamer.stream>> | null = null;

    try {
      const existingMessage = this.host.getMessages().find((m) => m?.message_id === messageId && m?.role === "assistant");
      const seedParts = existingMessage
        ? this.host.messageRenderer.normalizeMessageToParts(existingMessage).parts
        : undefined;

      // Pass external tracker and skip indicator lifecycle when managed at turn level
      outcome = await this.streamer.stream(stream, messageEl, messageId, signal, this.host.webSearchEnabled(), seedParts, metricsTracker, !!metricsTracker);
      if (outcome?.messageEl && outcome.messageEl !== messageEl) {
        messageEl = outcome.messageEl;
      }
      if (outcome?.messageId) {
        messageId = outcome.messageId;
      }
      if (outcome?.completed) {
        errorLogger.debug('Assistant stream finished', {
          source: 'ChatTurnOrchestrator',
          method: 'streamAssistant',
          metadata: { messageId },
        });
      }
    } catch (e) {
      // Check if this is a retryable error
      if (e instanceof SystemSculptError && e.metadata) {
        const shouldRetryWithoutTools = e.metadata.shouldResubmitWithoutTools && !retryContext?.skipTools;
        const shouldRetryWithoutImages = e.metadata.shouldResubmitWithoutImages && !retryContext?.skipImages;

        if (shouldRetryWithoutTools || shouldRetryWithoutImages) {
          // Record incompatibility and retry
          if (shouldRetryWithoutTools) {
            await incompatService.markToolIncompatible(modelId);
            errorLogger.debug('Model marked as tool-incompatible, retrying without tools', {
              source: 'ChatTurnOrchestrator',
              method: 'streamAssistant',
              metadata: { modelId },
            });
          }
          if (shouldRetryWithoutImages) {
            await incompatService.markImageIncompatible(modelId);
            errorLogger.debug('Model marked as image-incompatible, retrying without images', {
              source: 'ChatTurnOrchestrator',
              method: 'streamAssistant',
              metadata: { modelId },
            });
          }

          this.notifyCompatibility(modelId, {
            tools: shouldRetryWithoutTools,
            images: shouldRetryWithoutImages,
            source: "runtime",
          });

          // Clean up listeners before retry
          unsubscribers.forEach((u) => { try { u(); } catch {} });

          // Retry with appropriate flags
          return this.streamAssistant({
            includeContextFiles,
            signal,
            metricsTracker,
            retryContext: {
              skipTools: retryContext?.skipTools || shouldRetryWithoutTools,
              skipImages: retryContext?.skipImages || shouldRetryWithoutImages,
              isRetry: true,
            },
          });
        }
      }
      // Re-throw if not retryable
      throw e;
    } finally {
      // Clean listeners for this message's wrappers
      unsubscribers.forEach((u) => { try { u(); } catch {} });
    }

    if (!outcome?.completed) {
      return null;
    }

    // After successful completion, if this was a retry, show persistent footnote
    if (retryContext?.isRetry && this.host.setStreamingFootnote) {
      let footnoteText = "";
      if (retryContext.skipTools && retryContext.skipImages) {
        footnoteText = "Response generated without agent tools or images";
      } else if (retryContext.skipTools) {
        footnoteText = "Response generated without agent tools";
      } else if (retryContext.skipImages) {
        footnoteText = "Response generated without images";
      }
      if (footnoteText) {
        this.host.setStreamingFootnote(messageEl, footnoteText);
      }
    }

    // Keep active assistant container aligned with resolved DOM/message id
    this.activeAssistantMessage = { messageId, messageEl };

    return { messageId };
  }

  private ensureAssistantMessageContainer(): { messageEl: HTMLElement; messageId: string } {
    if (this.activeAssistantMessage && this.activeAssistantMessage.messageEl.isConnected) {
      return this.activeAssistantMessage;
    }

    const shouldBreakGroup = !this.activeAssistantMessage;
    errorLogger.debug('Creating assistant container', {
      source: 'ChatTurnOrchestrator',
      method: 'ensureAssistantMessageContainer',
      metadata: { hasActiveMessage: !!this.activeAssistantMessage, shouldBreakGroup },
    });
    const { messageEl } = this.host.createAssistantMessageContainer(shouldBreakGroup);
    let messageId = messageEl.dataset.messageId;
    if (!messageId || messageId.trim().length === 0) {
      messageId = this.host.generateMessageId();
      messageEl.dataset.messageId = messageId;
    }

    this.activeAssistantMessage = { messageId, messageEl };
    return this.activeAssistantMessage;
  }

  private finalizeActiveAssistantMessage(): void {
    if (!this.activeAssistantMessage) {
      return;
    }

    try {
      this.streamer.finalizeMessage(this.activeAssistantMessage.messageId);
    } catch {}

    this.activeAssistantMessage = null;
  }

  private initializeContinuationState(messageId: string): void {
    if (!this.continuationState || this.continuationState.messageId !== messageId) {
      this.continuationState = { messageId, seenToolCalls: new Set() };
    }
  }

  private ensureContinuationState(messageId: string): { messageId: string; seenToolCalls: Set<string> } {
    if (!this.continuationState || this.continuationState.messageId !== messageId) {
      this.continuationState = { messageId, seenToolCalls: new Set() };
    }
    return this.continuationState;
  }

  private resetContinuationState(): void {
    this.continuationState = null;
  }

  private async continueAfterTools(messageId: string, signal: AbortSignal, metricsTracker?: StreamingMetricsTracker): Promise<{ newMessageId: string } | null> {
    if (!this.tools) return null;

    const toolCalls = this.tools.getToolCallsForMessage(messageId);
    if (!toolCalls || toolCalls.length === 0) {
      errorLogger.debug('No tool calls for message; stopping', {
        source: 'ChatTurnOrchestrator',
        method: 'continueAfterTools',
        metadata: { messageId },
      });
      return null;
    }

    // Wait until all tool calls reach a terminal state
    const allHandled = () => this.tools!.getToolCallsForMessage(messageId)
      .every(tc => tc.state === 'completed' || tc.state === 'failed' || tc.state === 'denied');

    if (signal.aborted) {
      return null;
    }

    if (!allHandled()) {
      try {
        const finished = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 120000); // safety: 2 min
          const off: Array<() => void> = [];
          const cleanup = () => {
            clearTimeout(timeout);
            off.forEach((u) => { try { u(); } catch {} });
          };
          const check = () => { if (allHandled()) { cleanup(); resolve(true); } };
          const onAbort = () => { cleanup(); resolve(false); };
          signal.addEventListener('abort', onAbort, { once: true });
          off.push(() => signal.removeEventListener('abort', onAbort));
          off.push(this.tools!.on('tool-call:state-changed', ({ toolCall }: any) => { if (toolCall?.messageId === messageId) check(); }));
          off.push(this.tools!.on('tool-call:execution-completed', ({ toolCall }: any) => { if (toolCall?.messageId === messageId) check(); }));
          off.push(this.tools!.on('tool-call:execution-failed', ({ toolCall }: any) => { if (toolCall?.messageId === messageId) check(); }));
          off.push(this.tools!.on('tool-call:denied', ({ toolCall }: any) => { if (toolCall?.messageId === messageId) check(); }));
        });
        if (!finished) {
          if (signal.aborted) {
            return null;
          }
          this.host.onError(new Error("Tool execution timed out. Resolve or retry the pending tool calls."));
          return null;
        }
      } catch {}
    }

    const continuationState = this.ensureContinuationState(messageId);
    const newlyHandledToolCalls = toolCalls.filter(tc => !continuationState.seenToolCalls.has(tc.id));
    if (newlyHandledToolCalls.length === 0) {
      errorLogger.debug('No new tool calls since last continuation; stopping', {
        source: 'ChatTurnOrchestrator',
        method: 'continueAfterTools',
        metadata: { messageId },
      });
      return null;
    }

    newlyHandledToolCalls.forEach(tc => continuationState.seenToolCalls.add(tc.id));

    // If user typed a new message meanwhile, don't continue – last message is user
    const msgs = this.host.getMessages();
    const idx = msgs.findIndex((m) => m.message_id === messageId);
    if (idx !== -1) {
      const hasLaterUser = msgs.slice(idx + 1).some((m) => m.role === 'user');
      if (hasLaterUser) return null;
    }

    // Now stream a continuation WITHOUT re-sending context files.
    const cont = await this.streamAssistant({ includeContextFiles: false, signal, metricsTracker });
    if (!cont) return null;

    if (cont.messageId !== continuationState.messageId) {
      this.initializeContinuationState(cont.messageId);
    }

    try {
      errorLogger.debug('Continuation after tools completed', {
        source: 'ChatTurnOrchestrator',
        method: 'continueAfterTools',
        metadata: { prevMessageId: messageId, newMessageId: cont.messageId }
      });
    } catch {}

    return { newMessageId: cont.messageId };
  }
}
