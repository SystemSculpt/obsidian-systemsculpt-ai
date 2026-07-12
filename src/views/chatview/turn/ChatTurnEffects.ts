import type { ChatMessage } from "../../../types";
import type { ToolCall } from "../../../types/toolCalls";
import type { StreamTurnResult } from "../controllers/StreamingController";
import type { AcceptedChatOperation } from "../../../services/managed/ManagedTypes";
import type { ChatTranscriptSnapshot } from "../transcript/ChatTranscriptTypes";
import type { ChatTurnOutcome } from "./ChatTurnTypes";

export type ChatTurnFence = Readonly<{
  isOpen: (operation?: AcceptedChatOperation) => boolean;
  claimTerminal: (outcome: ChatTurnOutcome) => boolean;
}>;

export type ChatTurnEffects = {
  readonly signal: AbortSignal;
  readonly acceptedOperation: AcceptedChatOperation;
  readonly commitAssistant: (message: ChatMessage, fence: ChatTurnFence) => Promise<void>;
  readonly runInitialStream: (operation: AcceptedChatOperation, retryCount: number, signal: AbortSignal, fence: ChatTurnFence) => Promise<StreamTurnResult>;
  readonly shouldContinueTools: (result: StreamTurnResult) => boolean;
  readonly requestToolApproval: (toolCall: ToolCall, signal: AbortSignal, fence: ChatTurnFence) => Promise<boolean>;
  readonly executeTool: (toolCall: ToolCall, signal: AbortSignal, fence: ChatTurnFence) => Promise<void>;
  readonly commitToolCheckpoint: (message: ChatMessage, fence: ChatTurnFence, outcomeUnknown: boolean) => Promise<void>;
  readonly renderToolCheckpoint: (message: ChatMessage, fence: ChatTurnFence) => Promise<void>;
  readonly readDurableSnapshot?: () => Promise<ChatTranscriptSnapshot>;
  readonly runContinuationStream: (
    operation: AcceptedChatOperation,
    retryCount: number,
    signal: AbortSignal,
    previous: StreamTurnResult,
    postCheckpointSnapshot?: ChatTranscriptSnapshot,
    durableContinuationIndex?: number,
    fence?: ChatTurnFence,
  ) => Promise<StreamTurnResult>;
  readonly retryEmptyStream?: boolean;
  readonly onTerminal?: (outcome: ChatTurnOutcome, operation: AcceptedChatOperation) => void;
  readonly onInitialRetryExhausted?: (latest: StreamTurnResult) => never;
  readonly onContinuationRetryExhausted?: (
    latest: StreamTurnResult,
    retryCount: number,
    previous: StreamTurnResult,
  ) => never;
  readonly onMaxContinuationDepth?: (maxDepth: number) => never;
};
