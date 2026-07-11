import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type { StreamTurnResult } from "../controllers/StreamingController";
import type { AcceptedChatOperation } from "../../../services/managed/ManagedTypes";

export type ChatTurnEffects = {
  readonly signal: AbortSignal;
  readonly acceptedOperation: AcceptedChatOperation;
  readonly commitAssistant: (message: ChatMessage) => Promise<void>;
  readonly runInitialStream: (retryCount: number, signal: AbortSignal) => Promise<StreamTurnResult>;
  readonly shouldContinueTools: (result: StreamTurnResult) => boolean;
  readonly requestToolApproval: (toolCall: ToolCall) => Promise<boolean>;
  readonly executeTool: (toolCall: ToolCall, signal: AbortSignal) => Promise<void>;
  readonly commitToolCheckpoint: (message: ChatMessage) => Promise<void>;
  readonly renderToolCheckpoint: (message: ChatMessage) => Promise<void>;
  readonly runContinuationStream: (
    retryCount: number,
    signal: AbortSignal,
    previous: StreamTurnResult,
  ) => Promise<StreamTurnResult>;
  readonly onInitialRetryExhausted?: (latest: StreamTurnResult) => never;
  readonly onContinuationRetryExhausted?: (
    latest: StreamTurnResult,
    retryCount: number,
    previous: StreamTurnResult,
  ) => never;
  readonly onMaxContinuationDepth?: (maxDepth: number) => never;
};
