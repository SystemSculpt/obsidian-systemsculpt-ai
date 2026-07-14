import { presentAgentTool } from "../AgentToolPresentation";
import type { AgentToolPart } from "../AgentConversation";

function part(overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return {
    id: "part-1",
    order: 1,
    kind: "tool",
    messageId: "message-1",
    callId: "call-1",
    name: "read",
    location: "vault",
    input: { paths: ["Projects/Plan.md"] },
    state: "running",
    ...overrides,
  };
}

describe("presentAgentTool", () => {
  it("concentrates labels, state, and compact target summaries", () => {
    expect(presentAgentTool(part())).toMatchObject({
      canonicalName: "read",
      label: "Read files",
      stateLabel: "Working",
      icon: "loader-circle",
      animated: true,
      summary: "Projects/Plan.md",
      hasDetails: true,
      openByDefault: false,
    });
  });

  it("prefers the result summary and truncates it for the single-line row", () => {
    const presentation = presentAgentTool(part({
      state: "succeeded",
      output: { summary: `Updated ${"very ".repeat(30)}long.md` },
    }));
    expect(presentation.stateLabel).toBe("Done");
    expect(presentation.summary?.length).toBeLessThanOrEqual(96);
    expect(presentation.summary).toMatch(/…$/);
  });

  it("opens failures by default so their diagnostic is not hidden", () => {
    expect(presentAgentTool(part({
      state: "failed",
      error: { code: "failed", message: "Could not read the file." },
    }))).toMatchObject({ openByDefault: true, stateLabel: "Failed" });
  });

  it("presents canonical tool names", () => {
    expect(presentAgentTool(part({ name: "write", input: { path: "Note.md" } })))
      .toMatchObject({ canonicalName: "write", label: "Write file", summary: "Note.md" });
  });

  it("summarizes canonical find, search, and open inputs", () => {
    expect(presentAgentTool(part({ name: "find", input: { patterns: ["meeting", "notes"] } })).summary)
      .toBe("meeting");
    expect(presentAgentTool(part({ name: "search", input: { patterns: ["TODO"] } })).summary)
      .toBe("TODO");
    expect(presentAgentTool(part({
      name: "open",
      input: { files: [{ path: "Research/Plan.md" }] },
    })).summary).toBe("Research/Plan.md");
  });
});
