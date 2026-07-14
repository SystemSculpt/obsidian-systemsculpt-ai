import fixture from "../../../../testing/fixtures/managed/managed-capabilities-v2.json";
import { inspectManagedToolContinuationBudget } from "../ManagedChatSessionBudget";

const limits = fixture.capabilities.find((entry) => entry.alias === "systemsculpt/chat")!.limits;

describe("ManagedChatSessionBudget", () => {
  it("rotates before tools when retained server-only context fills the bound session", () => {
    const result = inspectManagedToolContinuationBudget({
      limits,
      fullMessagesThroughAssistant: [
        { role: "user", content: "Run it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        },
      ],
      sessionBudget: {
        messageCount: 255,
        imageCount: 0,
        attachmentBytes: 0,
        storedJsonBytes: 512,
      },
      tools: [{ id: "call-1", name: "read" }],
      toolDefinitions: [],
    });

    expect(result).toEqual({ issue: null, rotateSession: true });
  });
});
