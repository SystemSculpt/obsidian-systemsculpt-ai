import { DebugLogger } from "../utils/debugLogger";
import { errorLogger } from "../utils/errorLogger";
import { normalizePiTools } from "./agent-v2/PiToolAdapter";
import type { AgentSessionClient } from "./agent-v2/AgentSessionClient";
import { PlatformContext } from "./PlatformContext";
import { StreamingErrorHandler } from "./StreamingErrorHandler";
import type { StreamingService } from "./StreamingService";
import type { StreamEvent, StreamPipelineDiagnostics } from "../streaming/types";
import type { StreamDebugCallbacks } from "./StreamExecutionTypes";

type ManagedAgentStreamExecutorInput = {
  agentSessionClient: AgentSessionClient;
  streamingService: StreamingService;
  chatSessionId: string;
  pluginVersion?: string;
  actualModelId: string;
  serverModelId: string;
  apiMessages: unknown[];
  requestTools: unknown[];
  endpoint: string;
  responseLogEndpoint: string;
  licenseKey: string;
  signal?: AbortSignal;
  debug?: StreamDebugCallbacks;
  shouldRetryRateLimitedStreamTurn: (error: unknown) => { retryAfterSeconds?: number } | null;
  getRateLimitedRetryDelayMs: (retryAfterSeconds: number | undefined, retryAttempt: number) => number;
  waitForRetryWindow: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

export async function* executeManagedAgentStream(
  input: ManagedAgentStreamExecutorInput
): AsyncGenerator<StreamEvent, void, unknown> {
  const platform = PlatformContext.get();
  const piTools = normalizePiTools(input.requestTools);
  const requestBody = {
    messages: input.apiMessages,
    tools: piTools,
    stream: true,
  };

  try {
    input.debug?.onRequest?.({
      provider: "systemsculpt-v2",
      endpoint: input.endpoint,
      headers: {
        "Content-Type": "application/json",
        "x-license-key": input.licenseKey,
      },
      body: requestBody,
      transport: platform.preferredTransport({ endpoint: input.endpoint }),
      canStream: true,
      isCustomProvider: false,
    });
  } catch {}

  const logger = DebugLogger.getInstance();
  let emittedAssistantOutput = false;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    if (input.signal?.aborted) {
      return;
    }

    try {
      const response = await input.agentSessionClient.startOrContinueTurn({
        chatId: input.chatSessionId,
        messages: input.apiMessages,
        tools: piTools,
        pluginVersion: input.pluginVersion,
      });

      logger?.logAPIResponse(input.responseLogEndpoint, response.status);

      try {
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        input.debug?.onResponse?.({
          provider: "systemsculpt",
          endpoint: input.responseLogEndpoint,
          status: response.status,
          headers: responseHeaders,
          isCustomProvider: false,
        });
      } catch {}

      if (!response.ok) {
        logger?.logAPIResponse(input.responseLogEndpoint, response.status, null, {
          message: `HTTP ${response.status}`,
        });
        await StreamingErrorHandler.handleStreamError(response, false, {
          provider: "systemsculpt-v2",
          endpoint: input.responseLogEndpoint,
          model: input.serverModelId || input.actualModelId,
        });
      }

      if (!response.body) {
        throw new Error("Missing response body from streaming API");
      }

      try {
        errorLogger.debug("Streaming response received", {
          source: "ManagedAgentStreamExecutor",
          method: "executeManagedAgentStream",
          metadata: {
            status: response.status,
            contentType: response.headers.get("content-type") || "unknown",
            hasBody: !!response.body,
            attempt: attempt + 1,
          },
        });
      } catch {}

      let streamDiagnostics: StreamPipelineDiagnostics | null = null;
      const streamIterator = input.streamingService.streamResponse(response, {
        model: input.serverModelId || input.actualModelId,
        isCustomProvider: false,
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

      const retryHints = input.shouldRetryRateLimitedStreamTurn(error);
      const canRetry = !emittedAssistantOutput && retryHints !== null && attempt < maxAttempts - 1;
      if (!canRetry) {
        throw error;
      }

      attempt += 1;
      const retryDelayMs = input.getRateLimitedRetryDelayMs(retryHints?.retryAfterSeconds, attempt);
      try {
        errorLogger.debug("Retrying PI turn after transient upstream rate limit", {
          source: "ManagedAgentStreamExecutor",
          method: "executeManagedAgentStream",
          metadata: {
            model: input.serverModelId || input.actualModelId,
            attempt,
            maxAttempts,
            delayMs: retryDelayMs,
          },
        });
      } catch {}

      await input.waitForRetryWindow(retryDelayMs, input.signal);
      if (input.signal?.aborted) {
        return;
      }
      await input.waitForRetryWindow(0, input.signal);
      if (input.signal?.aborted) {
        return;
      }

      try {
        yield {
          type: "meta",
          key: "inline-footnote",
          value: `Provider is temporarily rate-limited. Retrying automatically (${attempt + 1}/${maxAttempts})…`,
        } as any;
      } catch {}
    }
  }
}
