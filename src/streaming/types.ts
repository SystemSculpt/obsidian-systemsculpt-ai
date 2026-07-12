import type { Annotation } from "../types";
import type {
  ToolCallRequest,
  ToolCallResult,
  ToolCallState,
} from "../types/toolCalls";

export interface StreamToolCall extends ToolCallRequest {
  index?: number;
  state?: ToolCallState;
  result?: ToolCallResult;
  executionStartedAt?: number;
  executionCompletedAt?: number;
}

export type StreamEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "reasoning-details"; details: unknown[] }
  | { type: "tool-call"; phase: "delta" | "final"; call: StreamToolCall }
  | { type: "meta"; key: "inline-footnote" | "stop-reason"; value: any }
  | { type: "footnote"; text: string }
  | { type: "annotations"; annotations: Annotation[] };
