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
    ])).toEqual({ label: "Read 3 notes, searched for 2 patterns, edited Plan · 2 more", failedCount: 0 });
  });

  it("names one thing once when several steps act on it", () => {
    const poster = { path: "SystemSculpt/Studio/Poster.systemsculpt" };
    expect(summarizeAgentActivity([
      tool("studio_list_workflows", {}),
      tool("studio_edit_workflow", { ...poster, edits: [] }),
      tool("studio_run_workflow", poster),
      tool("studio_list_outputs", poster),
    ]).label).toBe("Listed Studio workflows, edited, ran and listed outputs of Poster workflow");
    // A failure keeps its own clause: "Couldn't" never joins a verb list.
    expect(summarizeAgentActivity([
      tool("read", { paths: ["Plan.md"] }),
      tool("edit", { path: "Plan.md" }, { id: "edit-plan", callId: "edit-plan", state: "failed", error: { code: "x", message: "No match" } }),
    ]).label).toBe("Read Plan, couldn't edit Plan");
  });

  it("counts each web query as one search, a Codex call's several included", () => {
    const claude = { agent: "claude" as const, workingDirectory: "/vault" };
    const codex = { agent: "codex" as const, workingDirectory: "/vault" };
    expect(summarizeAgentActivity([
      tool("web_search", { query: "when to plant tomatoes outside" }, { location: "server", output: { data: { query: "when to plant tomatoes outside", result_count: 6 } } }),
      tool("WebSearch", { query: "last frost date portland" }, { id: "claude-search", callId: "claude-search", native: claude }),
      tool("webSearch", { type: "webSearch", query: "tomato soil temperature", action: { type: "search", query: "tomato soil temperature", queries: ["tomato soil temperature", "tomato night temperature"] } },
        { id: "codex-search", callId: "codex-search", native: codex }),
      tool("WebFetch", { url: "https://example.org/grow/hardening-off", prompt: "How long to harden off?" }, { id: "claude-fetch", callId: "claude-fetch", native: claude }),
    ]).label).toBe("Searched the web 4 times, read example.org");
  });

  it("says how far a partly done batch got and counts one tool used twice", () => {
    const partial = tool("trash", { paths: ["Notes/Old.md", "Notes/Draft.md"] }, {
      state: "failed",
      output: { data: { results: [{ path: "Notes/Old.md", success: true }, { path: "Notes/Draft.md", success: false, error: "File not found" }] } },
      error: { code: "TOOL_PARTIAL_FAILURE", message: "partial" },
    } as Partial<AgentToolPart>);
    const summary = summarizeAgentActivity([partial]);
    expect(summary.label).toMatch(/^Moved 1 of 2 notes to trash$/u);
    expect(summary.failedCount).toBe(1);
    const forecast = (agent: "claude" | "codex", id: string) => tool(agent === "claude" ? ["mcp", "weather", "forecast"].join("__") : "forecast",
      agent === "claude" ? { city: "Portland" } : { type: "mcpToolCall", server: "weather", tool: "forecast", arguments: { city: "Portland" } },
      { id, callId: id, location: "server", native: { agent, workingDirectory: "/vault" } } as Partial<AgentToolPart>);
    // The same server's tool from Claude Code and Codex is one tool, used twice.
    expect(summarizeAgentActivity([forecast("claude", "a"), forecast("codex", "b")]).label).toBe("Used weather forecast twice");
  });

  it.each(["claude", "codex"] as const)("labels a denied %s edit without counting a failure", agent => {
    const denied = tool(agent === "claude" ? "Edit" : "fileChange", agent === "claude"
      ? { file_path: "/vault/Notes/Launch plan.md" }
      : { changes: [{ path: "/vault/Notes/Launch plan.md", kind: { type: "update" } }] }, {
      location: "server", native: { agent, workingDirectory: "/vault" }, state: "denied", approvalDecision: "denied",
    });
    expect(summarizeAgentActivity([denied])).toEqual({ label: "Edit Launch plan · Denied", failedCount: 0, denied: true });
    expect(summarizeAgentActivity([denied, { ...denied, callId: "another", id: "another" }]))
      .toEqual({ label: "Denied 2 actions", failedCount: 0, denied: true });
    // What didn't go ahead is counted after the work, never listed as a bare instruction ("edit X").
    expect(summarizeAgentActivity([{ ...denied, state: "succeeded", approvalDecision: "approved" }, denied]))
      .toEqual({ label: "Edited Launch plan · 1 denied", failedCount: 0, denied: true });
  });

  it.each(["claude", "codex"] as const)("does not claim a denied %s command ran or failed", agent => {
    expect(summarizeAgentActivity([
      tool(agent === "claude" ? "Bash" : "commandExecution", { command: "printf hello" }, {
        location: "server", native: { agent, workingDirectory: "/vault" }, state: "denied", approvalDecision: "denied",
      }),
    ])).toEqual({ label: "Run printf hello · Denied", failedCount: 0, denied: true });
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
    ])).toEqual({ label: "Edited Launch plan", failedCount: 0 });
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
    // "More" counts the rows behind it: two edits of one note are two rows.
    ])).toEqual({ label: "Searched “launch”, read One, listed the Notes folder · 2 more", failedCount: 0 });
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
    ])).toEqual({ label: "Edited Launch plan · 2 denied · 1 withdrawn", failedCount: 0, denied: true });
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
    // A hosted call has no approval to withdraw: cancelled means it was stopped while running.
    const word = backend === "hosted" ? "Stopped" : "Withdrawn";
    expect(summarizeAgentActivity([withdrawn])).toEqual({ label: `Edit Launch plan · ${word}`, failedCount: 0 });
    expect(summarizeAgentActivity([withdrawn, edit("stopped", { state: "cancelled" })]))
      .toEqual({ label: backend === "hosted" ? "Stopped 2 actions" : "2 actions withdrawn", failedCount: 0 });
    expect(summarizeAgentActivity([edit("done", { state: "succeeded" }), withdrawn]))
      .toEqual({ label: `Edited Launch plan · 1 ${word.toLowerCase()}`, failedCount: 0 });
    if (backend === "hosted") return;
    // A card still pending when the run finished is withdrawn, not an uncertain edit.
    expect(summarizeAgentActivity([edit("unanswered", { state: "outcome-unknown", approvalDecision: "withdrawn" })]))
      .toEqual({ label: "Edit Launch plan · Withdrawn", failedCount: 0 });
  });

  it("keeps mixed completed, failed and denied work in separate truthful clauses", () => {
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }),
      tool("edit", { path: "Notes/B.md" }, { id: "failed", callId: "failed", state: "failed" }),
      tool("edit", { path: "Notes/C.md" }, { id: "denied", callId: "denied", state: "denied" }),
    ])).toEqual({ label: "Edited A, couldn't edit B · 1 denied", failedCount: 1, denied: true });
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }, { state: "failed" }),
      tool("edit", { path: "Notes/A.md" }, { id: "retry", callId: "retry" }),
    ])).toEqual({ label: "Couldn't edit A, edited A", failedCount: 1 });
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }, { state: "failed" }),
      tool("write", { path: "Notes/B.md" }, { id: "uncertain", callId: "uncertain", state: "outcome-unknown" }),
    ])).toEqual({ label: "Couldn't edit A · 1 uncertain", failedCount: 2 });
    expect(summarizeAgentActivity([
      tool("Bash", { command: "rm -rf build" }, {
        location: "server", state: "failed", native: { agent: "claude", workingDirectory: "/vault" },
        error: { code: "CLAUDE_AUTO_BLOCKED", message: "Blocked" },
      } as Partial<AgentToolPart>),
    ]).label).toMatch(/· Blocked by Claude Code$/u);
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/A.md" }, { id: "denied", callId: "denied", state: "denied" }),
      tool("read", { paths: ["One.md"] }, { id: "r", callId: "r" }),
      tool("search", { patterns: ["x"] }, { id: "s", callId: "s" }),
      tool("write", { path: "Notes/B.md" }, { id: "u", callId: "u", state: "outcome-unknown" }),
    ]).label).toBe("Read One, searched “x” · 1 uncertain · 1 denied");
    const native = { location: "server" as const, native: { agent: "claude" as const, workingDirectory: "/vault" } };
    expect(summarizeAgentActivity([
      tool("Edit", { file_path: "/vault/A.md" }, { ...native, approvalDecision: "approved" }),
      tool("Bash", { command: "npm test" }, { ...native, id: "bash", callId: "bash", state: "failed", output: { data: { exitCode: 1 } } }),
      tool("Edit", { file_path: "/vault/B.md" }, { ...native, id: "denied", callId: "denied", state: "denied", approvalDecision: "denied" }),
    // A command that exited non-zero ran: it is named, and its failure counted.
    ])).toEqual({ label: "Edited A, ran npm test · 1 failed · 1 denied", failedCount: 1, denied: true });
  });

  it("distinguishes failed and denied work without exposing hosted server inputs", () => {
    expect(summarizeAgentActivity([
      tool("edit", { path: "Notes/Plan.md" }, { state: "failed" }),
      tool("edit", { path: "Notes/Other.md" }, { state: "denied" }),
    ])).toEqual({ label: "Couldn't edit Plan · 1 denied", failedCount: 1, denied: true });
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
