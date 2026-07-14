/**
 * Type definitions for the improved tool call system
 * This implements a single source of truth architecture for tool calls
 */

/**
 * Represents the state of a tool call throughout its lifecycle
 */
export type ToolCallState = 
  | 'executing'    // Tool is currently executing
  | 'completed'    // Tool execution completed successfully
  | 'failed';      // Tool execution failed

/**
 * Tool call request as received from the LLM
 */
export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Tool execution result
 */
export type ToolCancellationErrorCode =
  | 'TOOL_CANCELLED_BEFORE_START'
  | 'TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN';

export interface ToolCallResult {
  success: boolean;
  data?: any;
  error?: {
    code: string | ToolCancellationErrorCode;
    message: string;
    details?: any;
  };
}

/**
 * Complete tool call record - the single source of truth
 * This is what gets stored in our Map<string, ToolCall>
 */
export interface ToolCall {
  // Core identification
  id: string;
  messageId: string; // The message this tool call belongs to
  
  // Request data from LLM
  request: ToolCallRequest;
  
  // State tracking
  state: ToolCallState;
  timestamp: number; // When the tool call was created
  
  // Execution tracking
  executionStartedAt?: number;
  executionCompletedAt?: number;
  
  // Result data
  result?: ToolCallResult;
  
}
