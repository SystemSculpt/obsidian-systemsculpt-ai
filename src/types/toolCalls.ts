/**
 * Type definitions for the improved tool call system
 * This implements a single source of truth architecture for tool calls
 */

import { TFile } from "obsidian";

/**
 * Represents the state of a tool call throughout its lifecycle
 */
export type ToolCallState = 
  | 'pending'      // Tool call detected but not yet approved
  | 'approved'     // User approved the tool call
  | 'denied'       // User denied the tool call
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
export interface ToolCallResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
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
  approvedAt?: number;
  executionStartedAt?: number;
  executionCompletedAt?: number;
  
  // Result data
  result?: ToolCallResult;
  
  // UI state
  autoApproved?: boolean; // Was this auto-approved based on settings
  
  // Metadata
  serverId?: string; // For MCP tools, the server that provides this tool
}

/**
 * Events emitted by the tool call system
 */
export interface ToolCallEvents {
  'tool-call:created': { toolCall: ToolCall };
  'tool-call:state-changed': { 
    toolCallId: string; 
    previousState: ToolCallState; 
    newState: ToolCallState;
    toolCall: ToolCall;
  };
  'tool-call:approved': { toolCallId: string; toolCall: ToolCall };
  'tool-call:denied': { toolCallId: string; toolCall: ToolCall };
  'tool-call:execution-started': { toolCallId: string; toolCall: ToolCall };
  'tool-call:execution-completed': { 
    toolCallId: string; 
    result: ToolCallResult;
    toolCall: ToolCall;
  };
  'tool-call:execution-failed': { 
    toolCallId: string; 
    error: ToolCallResult['error'];
    toolCall: ToolCall;
  };
}

/**
 * Tool definition for type-safe tool system
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  // Optional metadata
  serverId?: string; // For MCP tools
  autoApprove?: boolean; // Can this tool be auto-approved
}

/**
 * Serialized format for persistence
 * This is what gets saved to markdown files
 */
export interface SerializedToolCall {
  id: string;
  request: ToolCallRequest;
  state: ToolCallState;
  timestamp: number;
  approvedAt?: number;
  executionStartedAt?: number;
  executionCompletedAt?: number;
  result?: ToolCallResult;
  autoApproved?: boolean;
}

/**
 * Message format for tool results sent to the API
 */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string; // JSON stringified result
  message_id: string;
}

/**
 * Options for tool execution
 */
export interface ToolExecutionOptions {
  timeout?: number; // Timeout in milliseconds
  retries?: number; // Number of retries on failure
  signal?: AbortSignal; // For cancellation
  sourceFile?: TFile;
}

/**
 * Tool executor function signature
 */
export type ToolExecutor = (
  args: any,
  options?: ToolExecutionOptions
) => Promise<any>;

/**
 * Interface for a local tool that can be registered.
 */
export interface LocalTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/**
 * Registry entry for available tools
 */
export interface ToolRegistryEntry {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
