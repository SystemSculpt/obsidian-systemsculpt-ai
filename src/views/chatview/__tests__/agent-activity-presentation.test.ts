import type { AgentPart, AgentToolPart } from "../../../chat/ChatConversation";
import {
  finalAgentAnswerPartIds,
  formatAgentActivityDuration,
  formatAgentWorkingDuration,
  groupAdjacentAgentActivity,
  isAgentActivityPart,
  splitPreviousAgentActivity,
  summarizeAgentActivity,
} from "../AgentActivityPresentation";

function tool(name: string, input: unknown, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return { id: name, kind: "tool", order: 1, messageId: "message", callId: name, name, input, location: "vault", state: "succeeded", ...overrides };
}

describe("AgentActivityPresentation", () => {
  it("joins counted clauses, keeps single edit targets and counts remaining activity", () => {
    expect(summarizeAgentActivity([
      tool("read", { paths: ["One.md", "Two.md"] }),
      tool("Read", { file_path: "/vault/Three.md" }, { native: { agent: "claude", workingDirectory: "/vault" } }),
      tool("search", { patterns: ["launch", "date"] }),
      tool("edit", { path: "Notes/Plan.md" }),
      tool("write", { path: "New.md" }),
      tool("write", { path: "Other.md" }),
    ])).toEqual({ label: "Read 3 notes, searched 2 patterns, edited Plan.md · 2 more", failedCount: 0 });
  });

  it.each(["claude", "codex"] as const)("labels a denied %s edit without counting a failure", agent => {
    const denied = tool(agent === "claude" ? "Edit" : "fileChange", agent === "claude"
      ? { file_path: "/vault/Notes/Launch plan.md" }
      : { changes: [{ path: "/vault/Notes/Launch plan.md", kind: { type: "update" } }] }, {
      location: "server", native: { agent, workingDirectory: "/vault" }, state: "denied", approvalDecision: "denied",
    });
    expect(summarizeAgentActivity([denied])).toEqual({ label: "Edit Launch plan.md · Denied", failedCount: 0 });
    expect(summarizeAgentActivity([denied, { ...denied, callId: "another", id: "another" }]))
      .toEqual({ label: "Denied 2 actions", failedCount: 0 });
    expect(summarizeAgentActivity([{ ...denied, state: "succeeded", approvalDecision: "approved" }, denied]))
      .toEqual({ label: "Edited Launch plan.md, edit Launch plan.md · Denied", failedCount: 0 });
  });

  it.each(["claude", "codex"] as const)("does not claim a denied %s command ran or failed", agent => {
    expect(summarizeAgentActivity([
      tool(agent === "claude" ? "Bash" : "commandExecution", { command: "printf hello" }, {
        location: "server", native: { agent, workingDirectory: "/vault" }, state: "denied", approvalDecision: "denied",
      }),
    ])).toEqual({ label: "Run printf hello · Denied", failedCount: 0 });
  });

  it.each(["claude", "codex", "hosted"] as const)("counts a %s note edited twice as one edited note", backend => {
    const edit = (id: string, path: string, overrides: Partial<AgentToolPart> = {}) => backend === "hosted"
      ? tool("edit", { path }, { id, callId: id, ...overrides })
      : tool(backend === "claude" ? "Edit" : "fileChange", backend === "claude"
        ? { file_path: `/vault/${path}` }
        : { changes: [{ path: `/vault/${path}`, kind: { type: "update" } }] }, {
        id, callId: id, location: "server", native: { agent: backend, workingDirectory: "/vault" }, ...overrides,
      });
    expect(summarizeAgentActivity([
      edit("first", "Notes/Launch plan.md", { approvalDecision: "approved" }),
      edit("second", "Notes/Launch plan.md", { approvalDecision: "approved", approvalScope: "session" }),
    ])).toEqual({ label: "Edited Launch plan.md", failedCount: 0 });
    expect(summarizeAgentActivity([
      edit("first", "Notes/Launch plan.md"),
      edit("second", "Notes/Research.md"),
      edit("third", "Notes/Launch plan.md"),
    ])).toEqual({ label: "Edited 2 notes", failedCount: 0 });
  });

  it("counts distinct notes across multi-path reads, Codex multi-file changes and the remaining count", () => {
    expect(summarizeAgentActivity([
      tool("read", { paths: ["One.md", "Two.md"] }),
      tool("read", { paths: ["Two.md"] }, { id: "again", callId: "again" }),
      tool("Read", { file_path: "/vault/One.md" }, { id: "native", callId: "native", native: { agent: "claude", workingDirectory: "/vault" } }),
    ])).toEqual({ label: "Read 2 notes", failedCount: 0 });
    const codex = { location: "server" as const, native: { agent: "codex" as const, workingDirectory: "/vault" } };
    expect(summarizeAgentActivity([
      tool("fileChange", { changes: [{ path: "/vault/A.md", kind: { type: "update" } }, { path: "/vault/B.md", kind: { type: "update" } }] }, codex),
      tool("fileChange", { changes: [{ path: "/vault/A.md", kind: { type: "update" } }] }, { ...codex, id: "again", callId: "again" }),
    ])).toEqual({ label: "Edited 2 notes", failedCount: 0 });
    expect(summarizeAgentActivity([
      tool("search", { patterns: ["launch"] }),
      tool("read", { paths: ["One.md"] }),
      tool("list_items", { paths: ["Notes"] }),
      tool("edit", { path: "Plan.md" }),
      tool("edit", { path: "Plan.md" }, { id: "again", callId: "again" }),
    ])).toEqual({ label: "Searched 1 pattern, read One.md, listed Notes · 1 more", failedCount: 0 });
  });

  it("matches the resolved approval fixture: repeated approvals, two denials and a withdrawn edit", () => {
    const native = { agent: "claude" as const, workingDirectory: "/synthetic-vault", vaultRoot: "/synthetic-vault" };
    const edit = (id: string, overrides: Partial<AgentToolPart>) => tool("Edit", { file_path: "/synthetic-vault/Notes/Launch plan.md" }, {
      id, callId: id, approvalId: id, location: "server", native, ...overrides,
    });
    expect(summarizeAgentActivity([
      edit("approved", { state: "succeeded", approvalDecision: "approved" }),
      edit("chat-approved", { state: "succeeded", approvalDecision: "approved", approvalScope: "session" }),
      edit("denied", { state: "denied", approvalDecision: "denied" }),
      edit("withdrawn", { state: "cancelled", approvalDecision: "withdrawn" }),
      tool("ExitPlanMode", { plan: "Review the checklist before editing." }, {
        id: "kept-planning", callId: "kept-planning", approvalId: "kept-planning", location: "server", native, state: "denied", approvalDecision: "denied",
      }),
    ])).toEqual({ label: "Edited Launch plan.md, denied 2 actions, edit Launch plan.md · Withdrawn", failedCount: 0 });
  });

  it.each(["claude", "codex", "hosted"] as const)("never counts a cancelled or withdrawn %s action as a change or failure", backend => {
    const edit = (id: string, overrides: Partial<AgentToolPart>) => backend === "hosted"
      ? tool("edit", { path: "Notes/Launch plan.md" }, { id, callId: id, ...overrides })
      : tool(backend === "claude" ? "Edit" : "fileChange", backend === "claude"
        ? { file_path: "/vault/Notes/Launch plan.md" }
        : { changes: [{ path: "/vault/Notes/Launch plan.md", kind: { type: "update" } }] }, {
        id, callId: id, approvalId: id, location: "server", native: { agent: backend, workingDirectory: "/vault" }, ...overrides,
      });
    const withdrawn = edit("withdrawn", { state: "cancelled", ...(backend === "hosted" ? {} : { approvalDecision: "withdrawn" as const }) });
    expect(summarizeAgentActivity([withdrawn])).toEqual({ label: "Edit Launch plan.md · Withdrawn", failedCount: 0 });
    expect(summarizeAgentActivity([withdrawn, edit("stopped", { state: "cancelled" })]))
      .toEqual({ label: "2 actions withdrawn", failedCount: 0 });
    expect(summarizeAgentActivity([edit("done", { state: "succeeded" }), withdrawn]))
      .toEqual({ label: "Edited Launch plan.md, edit Launch plan.md · Withdrawn", failedCount: 0 });
    if (backend === "hosted") return;
    // A card still pending when the run finished is withdrawn, not an uncertain edit.
    expect(summarizeAgentActivity([edit("unanswered", { state: "outcome-unknown", approvalDecision: "withdrawn" })]))
      .toEqual({ label: "Edit Launch plan.md · Withdrawn", failedCount: 0 });
  });

  it("keeps mixed completed, failed and denied work in separate truthful clauses", () => {
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }),
      tool("edit", { path: "Notes/B.md" }, { id: "failed", callId: "failed", state: "failed" }),
      tool("edit", { path: "Notes/C.md" }, { id: "denied", callId: "denied", state: "denied" }),
    ])).toEqual({ label: "Edited A.md, couldn't edit B.md, edit C.md · Denied · 1 failed", failedCount: 1 });
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }, { state: "failed" }),
      tool("edit", { path: "Notes/A.md" }, { id: "retry", callId: "retry" }),
    ])).toEqual({ label: "Couldn't edit A.md, edited A.md · 1 failed", failedCount: 1 });
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }, { state: "failed" }),
      tool("write", { path: "Notes/B.md" }, { id: "uncertain", callId: "uncertain", state: "outcome-unknown" }),
    ])).toEqual({ label: "Couldn't complete 2 actions · 2 failed", failedCount: 2 });
    const native = { location: "server" as const, native: { agent: "claude" as const, workingDirectory: "/vault" } };
    expect(summarizeAgentActivity([
      tool("Edit", { file_path: "/vault/A.md" }, { ...native, approvalDecision: "approved" }),
      tool("Bash", { command: "npm test" }, { ...native, id: "bash", callId: "bash", state: "failed", output: { data: { exitCode: 1 } } }),
      tool("Edit", { file_path: "/vault/B.md" }, { ...native, id: "denied", callId: "denied", state: "denied", approvalDecision: "denied" }),
    ])).toEqual({ label: "Edited A.md, couldn't run npm test, edit B.md · Denied · 1 failed", failedCount: 1 });
  });

  it("distinguishes failed and denied work without exposing hosted server inputs", () => {
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/Plan.md" }, { state: "failed" }),
      tool("edit", { path: "Notes/Other.md" }, { state: "denied" }),
    ])).toEqual({ label: "Couldn't edit Plan.md, edit Other.md · Denied · 1 failed", failedCount: 1 });
    const summary = summarizeAgentActivity([tool("private_provider_action", { paths: ["Secret.md"] }, { location: "server" })]);
    expect(summary.label).toBe("Ran SystemSculpt action");
    expect(JSON.stringify(summary)).not.toMatch(/private|Secret/u);
  });

  it("groups adjacent reasoning and tools without crossing text or errors", () => {
    const items = ["reasoning", "tool", "text", "tool", "reasoning", "error", "tool"];

    const timeline = groupAdjacentAgentActivity(
      items,
      (item) => item === "reasoning" || item === "tool",
    );

    expect(timeline).toEqual([
      { kind: "activity", items: ["reasoning", "tool"] },
      { kind: "item", item: "text" },
      { kind: "activity", items: ["tool", "reasoning"] },
      { kind: "item", item: "error" },
      { kind: "activity", items: ["tool"] },
    ]);
  });

  it("keeps only the newest adjacent activity row outside the overflow fold", () => {
    expect(splitPreviousAgentActivity(["reasoning", "read", "search"])).toEqual({
      previous: ["reasoning", "read"],
      latest: "search",
    });
    expect(splitPreviousAgentActivity<string>([])).toEqual({ previous: [], latest: null });
  });

  it.each([
    [undefined, null],
    [0, "1ms"],
    [949, "949ms"],
    [1_050, "1.1s"],
    [9_950, "10s"],
    [10_200, "10s"],
    [59_600, "60s"],
    [60_000, "1m"],
    [105_000, "1m 45s"],
    [119_600, "2m"],
  ])("formats %s milliseconds like the T3 activity timer", (milliseconds, expected) => {
    expect(formatAgentActivityDuration(milliseconds)).toBe(expected);
  });

  it.each([
    [undefined, null],
    [0, "0s"],
    [999, "0s"],
    [9_999, "9s"],
    [62_900, "1m 2s"],
    [3_600_000, "1h"],
    [3_660_000, "1h 1m"],
  ])("formats %s milliseconds like the T3 live Working timer", (milliseconds, expected) => {
    expect(formatAgentWorkingDuration(milliseconds)).toBe(expected);
  });

  it("classifies reasoning and tools as activity without folding text or errors", () => {
    const part = (kind: AgentPart["kind"]): AgentPart => ({ kind } as AgentPart);
    expect(isAgentActivityPart(part("reasoning"))).toBe(true);
    expect(isAgentActivityPart(part("tool"))).toBe(true);
    expect(isAgentActivityPart(part("text"))).toBe(false);
    expect(isAgentActivityPart(part("error"))).toBe(false);
  });

  it("keeps only the final answer suffix and later sources outside the fold", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "progress-1", messageId: "assistant-1", kind: "content", visible: true },
      { id: "reasoning-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "progress-2", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("keeps a terminal answer and Sources outside after late activity", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "commentary", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool-1", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "late-tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("ignores invisible terminal content after late activity in a newer message", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "answer", messageId: "assistant-1", kind: "content", visible: true },
      { id: "late-tool", messageId: "assistant-2", kind: "activity", visible: true },
      { id: "blank", messageId: "assistant-2", kind: "content", visible: false },
      { id: "sources", messageId: "assistant-2", kind: "sources", visible: true },
    ])]).toEqual(["answer", "sources"]);
  });

  it("stops terminal content at an activity or durable message boundary", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "commentary", messageId: "assistant-1", kind: "content", visible: true },
      { id: "tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "prior-message", messageId: "assistant-1", kind: "content", visible: true },
      { id: "answer-a", messageId: "assistant-2", kind: "content", visible: true },
      { id: "answer-b", messageId: "assistant-2", kind: "content", visible: true },
    ])]).toEqual(["answer-a", "answer-b"]);
  });

  it("keeps Sources outside when no ordinary answer text exists", () => {
    expect([...finalAgentAnswerPartIds([
      { id: "tool", messageId: "assistant-1", kind: "activity", visible: true },
      { id: "sources", messageId: "assistant-1", kind: "sources", visible: true },
    ])]).toEqual(["sources"]);
  });
});
