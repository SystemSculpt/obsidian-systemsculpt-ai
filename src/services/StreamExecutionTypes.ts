import type { StreamEvent, StreamPipelineDiagnostics } from "../streaming/types";
import type { ChatMessage } from "../types";
import type { SystemSculptModel, SystemSculptTextModelSourceMode } from "../types/llm";
import type { OpenAITool } from "../utils/tooling";

export interface StreamDebugCallbacks {
  onRequest?: (data: {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    body: Record<string, any>;
    transport?: string;
    canStream?: boolean;
    isCustomProvider?: boolean;
  }) => void;
  onResponse?: (data: {
    provider: string;
    endpoint: string;
    status: number;
    headers: Record<string, string>;
    isCustomProvider?: boolean;
  }) => void;
  onRawEvent?: (data: { line: string; payload: string }) => void;
  onStreamEvent?: (data: { event: StreamEvent }) => void;
  onStreamEnd?: (data: {
    completed: boolean;
    aborted: boolean;
    diagnostics?: StreamPipelineDiagnostics;
  }) => void;
  onError?: (data: { error: string; details?: any }) => void;
}

export interface PreparedChatRequest {
  modelSource: SystemSculptTextModelSourceMode;
  resolvedModel: SystemSculptModel;
  actualModelId: string;
  preparedMessages: ChatMessage[];
  finalSystemPrompt: string;
  tools: OpenAITool[];
}
