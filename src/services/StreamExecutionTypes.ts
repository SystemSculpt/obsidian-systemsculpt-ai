import type { StreamEvent, StreamPipelineDiagnostics } from "../streaming/types";
import type { ChatMessage } from "../types";
import type { CustomProvider } from "../types/llm";

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
  isCustom: boolean;
  customProvider?: CustomProvider;
  actualModelId: string;
  serverModelId: string;
  preparedMessages: ChatMessage[];
  requestTools: any[];
  effectiveAgentMode: boolean;
  resolvedWebSearchOptions?: { search_context_size?: "low" | "medium" | "high" };
  finalSystemPrompt: string;
}

export type RebuildPreparedChatRequest = (options: {
  messages: ChatMessage[];
  contextFiles: Set<string>;
  agentMode: boolean;
  emitNotices: boolean;
}) => Promise<PreparedChatRequest>;
