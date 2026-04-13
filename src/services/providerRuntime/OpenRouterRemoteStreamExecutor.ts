import type SystemSculptPlugin from "../../main";
import type { PreparedChatRequest, StreamDebugCallbacks } from "../StreamExecutionTypes";
import type { StreamEvent, StreamPipelineDiagnostics } from "../../streaming/types";
import { PlatformRequestClient } from "../PlatformRequestClient";
import { StreamingErrorHandler } from "../StreamingErrorHandler";
import { StreamingService } from "../StreamingService";
import { resolveStudioPiProviderApiKey } from "../../studio/piAuth/StudioPiAuthStorage";
import { transformToolsForModel } from "../../utils/tooling";
import { toChatCompletionsMessages } from "../../utils/messages/toChatCompletionsMessages";
import { resolveRemoteProviderEndpoint } from "./RemoteProviderCatalog";

type RemoteOpenRouterStreamInput = {
  plugin: SystemSculptPlugin;
  prepared: PreparedChatRequest;
  signal?: AbortSignal;
  reasoningEffort?: string;
  debug?: StreamDebugCallbacks;
};

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

function buildRemoteRequestBody(input: RemoteOpenRouterStreamInput): Record<string, unknown> {
  const providerId = String(
    input.prepared.resolvedModel.sourceProviderId ||
      input.prepared.resolvedModel.provider ||
      "openrouter",
  ).trim();
  const endpoint = resolveRemoteProviderEndpoint(providerId);
  const body: Record<string, unknown> = {
    model: input.prepared.actualModelId,
    messages: toChatCompletionsMessages(input.prepared.preparedMessages, {
      includeDocumentContext: false,
      includeToolNameOnToolMessages: false,
    }),
    stream: true,
  };

  if (Array.isArray(input.prepared.tools) && input.prepared.tools.length > 0) {
    body.tools = transformToolsForModel(
      input.prepared.actualModelId,
      endpoint,
      input.prepared.tools,
    );
  }

  if (input.reasoningEffort) {
    body.reasoning_effort = input.reasoningEffort;
  }

  return body;
}

export async function* executeOpenRouterRemoteStream(
  input: RemoteOpenRouterStreamInput,
): AsyncGenerator<StreamEvent, void, unknown> {
  const providerId = String(
    input.prepared.resolvedModel.sourceProviderId ||
      input.prepared.resolvedModel.provider ||
      "openrouter",
  ).trim();
  const endpoint = resolveRemoteProviderEndpoint(providerId);
  if (!endpoint) {
    throw new Error(`No remote endpoint configured for provider "${providerId}".`);
  }

  const apiKey = await resolveStudioPiProviderApiKey(providerId, { plugin: input.plugin });
  if (!apiKey) {
    throw new Error(`Connect ${providerId} in Providers before using this model.`);
  }

  const requestBody = buildRemoteRequestBody(input);
  const client = new PlatformRequestClient();
  const streamingService = new StreamingService();
  const debugHeaders = {
    Authorization: "Bearer [redacted]",
  };

  try {
    input.debug?.onRequest?.({
      provider: providerId,
      endpoint,
      headers: debugHeaders,
      body: requestBody,
      transport: "remote-provider",
      canStream: true,
      isCustomProvider: true,
    });
  } catch {}

  const response = await client.request({
    url: `${endpoint.replace(/\/$/, "")}/chat/completions`,
    method: "POST",
    body: requestBody,
    stream: true,
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://systemsculpt.com",
      "X-Title": "SystemSculpt AI",
    },
  });

  try {
    input.debug?.onResponse?.({
      provider: providerId,
      endpoint,
      status: response.status,
      headers: serializeResponseHeaders(response.headers),
      isCustomProvider: true,
    });
  } catch {}

  if (!response.ok) {
    await StreamingErrorHandler.handleStreamError(response, true, {
      provider: providerId,
      endpoint,
      model: input.prepared.actualModelId,
    });
  }

  let diagnostics: StreamPipelineDiagnostics | undefined;
  for await (const event of streamingService.streamResponse(response, {
    model: input.prepared.actualModelId,
    isCustomProvider: true,
    signal: input.signal,
    onRawEvent: input.debug?.onRawEvent,
    onDiagnostics: (value) => {
      diagnostics = value;
    },
  })) {
    try {
      input.debug?.onStreamEvent?.({ event });
    } catch {}
    yield event;
  }

  try {
    input.debug?.onStreamEnd?.({
      completed: !input.signal?.aborted,
      aborted: !!input.signal?.aborted,
      diagnostics,
    });
  } catch {}
}
