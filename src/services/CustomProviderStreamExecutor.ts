import { Notice } from "obsidian";
import type SystemSculptPlugin from "../main";
import type { StreamEvent, StreamPipelineDiagnostics } from "../streaming/types";
import type { ChatMessage } from "../types";
import type { CustomProvider } from "../types/llm";
import { errorLogger } from "../utils/errorLogger";
import { PlatformContext } from "./PlatformContext";
import { RuntimeIncompatibilityService } from "./RuntimeIncompatibilityService";
import { StreamingErrorHandler } from "./StreamingErrorHandler";
import type { StreamingService } from "./StreamingService";
import type {
  PreparedChatRequest,
  RebuildPreparedChatRequest,
  StreamDebugCallbacks,
} from "./StreamExecutionTypes";
import { postJsonStreaming } from "../utils/streaming";

type CustomProviderStreamExecutorInput = {
  plugin: SystemSculptPlugin;
  streamingService: StreamingService;
  prepared: PreparedChatRequest;
  customProvider: CustomProvider;
  messages: ChatMessage[];
  model: string;
  contextFiles?: Set<string>;
  agentMode?: boolean;
  signal?: AbortSignal;
  maxTokens?: number;
  includeReasoning?: boolean;
  debug?: StreamDebugCallbacks;
  rebuildPrepared: RebuildPreparedChatRequest;
  shouldFallbackWithoutTools: (error: unknown) => boolean;
  isContextOverflowError: (error: unknown) => boolean;
};

export async function* executeCustomProviderStream(
  input: CustomProviderStreamExecutorInput
): AsyncGenerator<StreamEvent, void, unknown> {
  const platform = PlatformContext.get();
  const adapter = input.plugin.customProviderService.getProviderAdapter(input.customProvider);
  const endpoint = adapter.getChatEndpoint();
  const headers = {
    "Content-Type": "application/json",
    ...adapter.getHeaders(),
  };

  const baseContextFiles = input.contextFiles ? new Set(input.contextFiles) : new Set<string>();
  const baseMessages = Array.isArray(input.messages) ? [...input.messages] : [];

  const trimToRecentMessages = (all: ChatMessage[], maxCount: number): ChatMessage[] => {
    if (!Array.isArray(all)) return [];
    if (maxCount <= 0) return [];
    if (all.length <= maxCount) return all;
    return all.slice(-maxCount);
  };

  const trimToMinimalMessages = (all: ChatMessage[]): ChatMessage[] => {
    if (!Array.isArray(all) || all.length === 0) return [];
    const lastUser = [...all].reverse().find((msg) => msg?.role === "user");
    return lastUser ? [lastUser] : [all[all.length - 1]];
  };

  const buildRequestBody = (prepared: PreparedChatRequest): any =>
    adapter.buildRequestBody(prepared.preparedMessages, prepared.actualModelId, prepared.requestTools, true, {
      maxTokens: input.maxTokens,
      includeReasoning: input.includeReasoning,
    });

  const rebuildRequest = async (
    attemptMessages: ChatMessage[],
    attemptContextFiles: Set<string>,
    attemptAgentMode: boolean
  ): Promise<{ prepared: PreparedChatRequest; requestBody: any }> => {
    const prepared = await input.rebuildPrepared({
      messages: attemptMessages,
      contextFiles: attemptContextFiles,
      agentMode: attemptAgentMode,
      emitNotices: false,
    });
    return { prepared, requestBody: buildRequestBody(prepared) };
  };

  let attemptAgentMode = !!input.agentMode;
  let attemptContextFiles = baseContextFiles;
  let attemptMessages = baseMessages;
  let activePrepared = input.prepared;
  let activeRequestBody = buildRequestBody(input.prepared);
  let emittedAssistantOutput = false;
  let attempt = 0;
  let droppedContextFiles = false;
  let trimmedHistory = false;
  let trimmedMinimal = false;
  let disabledToolsForToolRejection = false;
  let disabledToolsForContextLimit = false;

  const maxAttempts = 5;
  while (attempt < maxAttempts) {
    try {
      try {
        input.debug?.onRequest?.({
          provider: input.customProvider.name || "custom-provider",
          endpoint,
          headers,
          body: activeRequestBody,
          transport: platform.preferredTransport({ endpoint }),
          canStream: platform.supportsStreaming({ endpoint }),
          isCustomProvider: true,
        });
      } catch {}

      const response = await postJsonStreaming(
        endpoint,
        headers,
        activeRequestBody,
        platform.isMobile(),
        input.signal
      );

      try {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        input.debug?.onResponse?.({
          provider: input.customProvider.name || "custom-provider",
          endpoint,
          status: response.status,
          headers: responseHeaders,
          isCustomProvider: true,
        });
      } catch {}

      if (!response.ok) {
        await StreamingErrorHandler.handleStreamError(response, true, {
          provider: input.customProvider.name,
          endpoint,
          model: activePrepared.actualModelId,
        });
      }

      const transformed = await adapter.transformStreamResponse(response, platform.isMobile());
      const streamResponse = new Response(transformed.stream, {
        status: response.status,
        headers: transformed.headers,
      });

      let streamDiagnostics: StreamPipelineDiagnostics | null = null;
      const streamIterator = input.streamingService.streamResponse(streamResponse, {
        model: activePrepared.actualModelId,
        isCustomProvider: true,
        signal: input.signal,
        onRawEvent: (data) => {
          try {
            input.debug?.onRawEvent?.(data);
          } catch {}
        },
        onDiagnostics: (diagnostics) => {
          streamDiagnostics = diagnostics;
        },
      });

      let streamCompleted = false;
      let streamAborted = false;
      try {
        for await (const event of streamIterator) {
          if (event.type === "content" || event.type === "reasoning" || event.type === "tool-call") {
            emittedAssistantOutput = true;
          }
          try {
            input.debug?.onStreamEvent?.({ event });
          } catch {}
          yield event;
        }
        streamCompleted = true;
      } finally {
        streamAborted = !!input.signal?.aborted;
        try {
          input.debug?.onStreamEnd?.({
            completed: streamCompleted,
            aborted: streamAborted,
            diagnostics: streamDiagnostics ?? undefined,
          });
        } catch {}
      }

      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (input.signal?.aborted) {
        return;
      }

      const canRetry = !emittedAssistantOutput && attempt < maxAttempts - 1;
      const needsToolFallback =
        canRetry &&
        !disabledToolsForToolRejection &&
        input.shouldFallbackWithoutTools(error);

      if (needsToolFallback) {
        attempt += 1;
        disabledToolsForToolRejection = true;
        attemptAgentMode = false;

        try {
          const incompat = RuntimeIncompatibilityService.getInstance(input.plugin);
          await incompat.markToolIncompatible(input.model);
        } catch {}
        try {
          new Notice("Model rejected tools; continuing without Agent Mode tools.", 5000);
        } catch {}

        try {
          yield { type: "meta", key: "inline-footnote", value: "Retrying without Agent Mode tools…" } as any;
        } catch {}

        const rebuilt = await rebuildRequest(attemptMessages, attemptContextFiles, attemptAgentMode);
        activePrepared = rebuilt.prepared;
        activeRequestBody = rebuilt.requestBody;
        continue;
      }

      const isContextOverflow = canRetry && input.isContextOverflowError(error);
      if (isContextOverflow) {
        if (!droppedContextFiles && attemptContextFiles.size > 0) {
          attempt += 1;
          droppedContextFiles = true;
          attemptContextFiles = new Set<string>();
          try {
            yield {
              type: "meta",
              key: "inline-footnote",
              value: "Prompt too long. Retrying without attached context files…",
            } as any;
          } catch {}

          const rebuilt = await rebuildRequest(attemptMessages, attemptContextFiles, attemptAgentMode);
          activePrepared = rebuilt.prepared;
          activeRequestBody = rebuilt.requestBody;
          continue;
        }

        if (!trimmedHistory && attemptMessages.length > 8) {
          attempt += 1;
          trimmedHistory = true;
          attemptMessages = trimToRecentMessages(baseMessages, 12);
          try {
            yield {
              type: "meta",
              key: "inline-footnote",
              value: "Prompt too long. Retrying with shortened chat history…",
            } as any;
          } catch {}

          const rebuilt = await rebuildRequest(attemptMessages, attemptContextFiles, attemptAgentMode);
          activePrepared = rebuilt.prepared;
          activeRequestBody = rebuilt.requestBody;
          continue;
        }

        if (!disabledToolsForContextLimit && attemptAgentMode) {
          attempt += 1;
          disabledToolsForContextLimit = true;
          attemptAgentMode = false;
          try {
            yield {
              type: "meta",
              key: "inline-footnote",
              value: "Prompt too long. Retrying without Agent Mode tools…",
            } as any;
          } catch {}

          const rebuilt = await rebuildRequest(attemptMessages, attemptContextFiles, attemptAgentMode);
          activePrepared = rebuilt.prepared;
          activeRequestBody = rebuilt.requestBody;
          continue;
        }

        if (!trimmedMinimal) {
          attempt += 1;
          trimmedMinimal = true;
          attemptMessages = trimToMinimalMessages(baseMessages);
          try {
            yield {
              type: "meta",
              key: "inline-footnote",
              value: "Prompt too long. Retrying with minimal context…",
            } as any;
          } catch {}

          const rebuilt = await rebuildRequest(attemptMessages, attemptContextFiles, attemptAgentMode);
          activePrepared = rebuilt.prepared;
          activeRequestBody = rebuilt.requestBody;
          continue;
        }
      }

      try {
        errorLogger.debug("Custom provider stream failed without retry", {
          source: "CustomProviderStreamExecutor",
          method: "executeCustomProviderStream",
          metadata: {
            endpoint,
            provider: input.customProvider.name,
            attempt,
          },
        });
      } catch {}
      throw error;
    }
  }
}
