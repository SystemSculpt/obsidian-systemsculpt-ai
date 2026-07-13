export interface FirstPartyToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface FirstPartyToolExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class FirstPartyToolExecutionError extends Error {
  constructor(
    public readonly code:
      | "TOOL_CANCELLED_BEFORE_START"
      | "TOOL_CANCEL_REQUESTED_OUTCOME_UNKNOWN",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FirstPartyToolExecutionError";
  }
}
