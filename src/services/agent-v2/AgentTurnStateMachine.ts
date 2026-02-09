export type AgentTurnState =
  | "idle"
  | "streaming"
  | "waiting_tool_results"
  | "resuming"
  | "completed"
  | "error";

export class AgentTurnStateMachine {
  private state: AgentTurnState = "idle";
  private sessionId: string | null = null;
  private pendingToolCallIds: string[] = [];

  public getState(): AgentTurnState {
    return this.state;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getPendingToolCallIds(): string[] {
    return [...this.pendingToolCallIds];
  }

  public isWaitingForTools(): boolean {
    return this.state === "waiting_tool_results";
  }

  public startTurn(sessionId: string): void {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new Error("startTurn requires a non-empty sessionId");
    }

    if (this.state === "waiting_tool_results") {
      throw new Error("Cannot start a new turn while waiting for tool results.");
    }

    this.state = "streaming";
    this.sessionId = sessionId;
    this.pendingToolCallIds = [];
  }

  public markWaitingForTools(toolCallIds: string[]): void {
    if (this.state !== "streaming" && this.state !== "resuming") {
      throw new Error("markWaitingForTools requires streaming or resuming state.");
    }

    const uniqueIds = Array.from(
      new Set((toolCallIds || []).filter((id) => typeof id === "string" && id.trim().length > 0))
    );

    this.state = "waiting_tool_results";
    this.pendingToolCallIds = uniqueIds;
  }

  public markToolResultsSubmitted(): void {
    if (this.state !== "waiting_tool_results") {
      throw new Error("markToolResultsSubmitted requires waiting_tool_results state.");
    }

    this.state = "resuming";
    this.pendingToolCallIds = [];
  }

  public markCompleted(): void {
    if (this.state !== "streaming" && this.state !== "resuming") {
      throw new Error("markCompleted requires streaming or resuming state.");
    }

    this.state = "completed";
    this.pendingToolCallIds = [];
  }

  public markError(): void {
    this.state = "error";
    this.pendingToolCallIds = [];
  }

  public reset(): void {
    this.state = "idle";
    this.sessionId = null;
    this.pendingToolCallIds = [];
  }
}

