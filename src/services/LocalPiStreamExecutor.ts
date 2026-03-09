import type SystemSculptPlugin from "../main";
import type { StreamEvent } from "../streaming/types";
import type { PreparedChatRequest, StreamDebugCallbacks } from "./StreamExecutionTypes";
import { streamPiLocalAgentTurn } from "./pi-native/PiLocalAgentExecutor";

type PiLocalSessionRef = {
  sessionFile?: string;
  sessionId: string;
};

type LocalPiStreamExecutorInput = {
  plugin: SystemSculptPlugin;
  prepared: PreparedChatRequest;
  sessionFile?: string;
  onSessionReady?: (session: PiLocalSessionRef) => void;
  signal?: AbortSignal;
  debug?: StreamDebugCallbacks;
};

export async function* executeLocalPiStream(
  input: LocalPiStreamExecutorInput
): AsyncGenerator<StreamEvent, void, unknown> {
  try {
    input.debug?.onRequest?.({
      provider: `local-pi:${input.prepared.resolvedModel.sourceProviderId || input.prepared.resolvedModel.provider}`,
      endpoint: "local-pi-rpc",
      headers: {},
      body: {
        model: input.prepared.actualModelId,
        messageCount: input.prepared.preparedMessages.length,
        toolMode: "pi-native",
      },
      transport: "pi-rpc",
      canStream: true,
      isCustomProvider: false,
    });
  } catch {}

  for await (const event of streamPiLocalAgentTurn({
    plugin: input.plugin,
    modelId: input.prepared.actualModelId,
    messages: input.prepared.preparedMessages,
    systemPrompt: input.prepared.finalSystemPrompt,
    sessionFile: input.sessionFile,
    onSessionReady: input.onSessionReady,
    signal: input.signal,
  })) {
    try {
      input.debug?.onStreamEvent?.({ event });
    } catch {}
    yield event;
  }
}
