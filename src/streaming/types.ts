import type { Annotation } from "../types";
import type { ToolCallRequest } from "../types/toolCalls";

export interface StreamToolCall extends ToolCallRequest {
  index?: number;
}

export type StreamEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "reasoning-details"; details: unknown[] }
  | { type: "tool-call"; phase: "delta" | "final"; call: StreamToolCall }
  | { type: "meta"; key: "web-search-enabled" | "inline-footnote" | "stop-reason"; value: any }
  | { type: "footnote"; text: string }
  | { type: "annotations"; annotations: Annotation[] };

export interface StreamPipelineOptions {
  model: string;
  isCustomProvider?: boolean;
  onRawEvent?: (data: { line: string; payload: string }) => void;
}

export interface StreamPipelineDiagnostics {
  discardedPayloadCount: number;
  discardedPayloadSamples: string[];
}

export interface StreamPipelineResult {
  events: StreamEvent[];
  done: boolean;
}
