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
  reasoningEffort?: string;
  debug?: StreamDebugCallbacks;
};

export async function* executeLocalPiStream(
  input: LocalPiStreamExecutorInput
): AsyncGenerator<StreamEvent, void, unknown> {
  for await (const event of streamPiLocalAgentTurn({
    plugin: input.plugin,
    modelId: input.prepared.actualModelId,
    messages: input.prepared.preparedMessages,
    systemPrompt: input.prepared.finalSystemPrompt,
    sessionFile: input.sessionFile,
    onSessionReady: input.onSessionReady,
    signal: input.signal,
    reasoningEffort: input.reasoningEffort,
  })) {
    try {
      input.debug?.onStreamEvent?.({ event });
    } catch {}
    yield event;
  }
}
