import { AgentTurnStateMachine } from "../AgentTurnStateMachine";

describe("AgentTurnStateMachine", () => {
  it("tracks the happy-path lifecycle", () => {
    const machine = new AgentTurnStateMachine();

    expect(machine.getState()).toBe("idle");
    expect(machine.getPendingToolCallIds()).toEqual([]);

    machine.startTurn("sess_1");
    expect(machine.getState()).toBe("streaming");
    expect(machine.getSessionId()).toBe("sess_1");

    machine.markWaitingForTools(["call_1", "call_2"]);
    expect(machine.getState()).toBe("waiting_tool_results");
    expect(machine.getPendingToolCallIds()).toEqual(["call_1", "call_2"]);

    machine.markToolResultsSubmitted();
    expect(machine.getState()).toBe("resuming");
    expect(machine.getPendingToolCallIds()).toEqual([]);

    machine.markCompleted();
    expect(machine.getState()).toBe("completed");
  });

  it("resets back to idle", () => {
    const machine = new AgentTurnStateMachine();
    machine.startTurn("sess_1");
    machine.markWaitingForTools(["call_1"]);
    machine.reset();

    expect(machine.getState()).toBe("idle");
    expect(machine.getSessionId()).toBeNull();
    expect(machine.getPendingToolCallIds()).toEqual([]);
  });

  it("throws on invalid transitions", () => {
    const machine = new AgentTurnStateMachine();

    expect(() => machine.markToolResultsSubmitted()).toThrow(/waiting_tool_results/i);
    expect(() => machine.markCompleted()).toThrow(/streaming|resuming/i);
  });
});

