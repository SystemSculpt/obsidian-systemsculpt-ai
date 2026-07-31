import {
  groupConsecutiveToolActivity,
  presentAgentTool,
  presentAgentToolGroup,
} from "../AgentToolPresentation";
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
      label: "Read 1 file",
      stateLabel: "Working",
      icon: "loader-circle",
      animated: true,
      summary: "Projects/Plan.md",
      itemCount: 1,
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

  it("keeps a clear failed state for the inline error treatment", () => {
    expect(presentAgentTool(part({
      state: "failed",
      error: { code: "failed", message: "Could not read the file." },
    }))).toMatchObject({ stateLabel: "Failed", icon: "circle-x" });
  });

  it("presents canonical tool names", () => {
    expect(presentAgentTool(part({ name: "write", input: { path: "Note.md" } })))
      .toMatchObject({ canonicalName: "write", label: "Write file", summary: "Note.md" });
  });

  it("names context-tool rows by the actual pinning action", () => {
    expect(presentAgentTool(part({
      name: "context",
      input: { action: "add", paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Pin files",
      summary: "Project.md",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { action: "remove", paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Unpin files",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Manage pinned files",
    });
  });

  it("uses a fixed product label for visible web search activity", () => {
    expect(presentAgentTool(part({
      name: "web_search",
      location: "server",
      input: { query: "Obsidian agent plugins" },
      output: {
        title: "Cloudflare search",
        summary: "OpenRouter web search completed",
      },
    }))).toMatchObject({
      canonicalName: "web_search",
      label: "Search web",
      summary: null,
      itemCount: null,
    });
  });

  it("never derives visible copy from an additive server tool name or payload", () => {
    const presentation = presentAgentTool(part({
      name: "cf_agent_provider_retry",
      location: "server",
      input: { patterns: ["provider-internal"] },
      output: {
        title: "Cloudflare provider action",
        summary: "cf_agent_provider_retry completed",
      },
    }));

    expect(presentation).toMatchObject({
      canonicalName: "server_action",
      label: "SystemSculpt action",
      summary: null,
      itemCount: null,
    });
    expect(JSON.stringify(presentation)).not.toMatch(
      /cf_agent|provider|cloudflare|retry/i,
    );
    expect(presentAgentTool(part({
      name: "read",
      location: "server",
      input: { paths: ["Private provider path"] },
    }))).toMatchObject({
      label: "SystemSculpt action",
      summary: null,
      itemCount: null,
    });
    expect(presentAgentToolGroup([
      part({
        id: "server-read-1",
        callId: "server-read-1",
        name: "read",
        location: "server",
        input: { paths: ["Private provider path 1"] },
        state: "succeeded",
      }),
      part({
        id: "server-read-2",
        callId: "server-read-2",
        name: "read",
        location: "server",
        input: { paths: ["Private provider path 2"] },
        state: "succeeded",
      }),
    ])).toMatchObject({
      label: "SystemSculpt action",
      summary: null,
      itemCount: null,
    });
  });

  it("never presents a server-owned tool as requiring vault approval", () => {
    expect(presentAgentTool(part({
      name: "write",
      location: "server",
      state: "approval-required",
      approvalId: "server-approval",
    }))).toMatchObject({
      canonicalName: "server_action",
      label: "SystemSculpt action",
      stateLabel: "Working",
      animated: true,
    });
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

  it("uses accurate singular and plural labels for safely countable tools", () => {
    expect(presentAgentTool(part({ input: { paths: ["One.md"] } })).label)
      .toBe("Read 1 file");
    expect(presentAgentTool(part({ input: { paths: ["One.md", "Two.md"] } })).label)
      .toBe("Read 2 files");
    expect(presentAgentTool(part({
      name: "open",
      input: { files: [{ path: "One.md" }, { path: "Two.md" }] },
    })).label).toBe("Open 2 files");
    expect(presentAgentTool(part({
      name: "list_items",
      input: { paths: ["Projects", "Archive"] },
    })).label).toBe("List 2 folders");
    expect(presentAgentTool(part({
      name: "find",
      input: { patterns: ["project", "meeting"] },
    })).label).toBe("Search 2 file patterns");
    expect(presentAgentTool(part({
      name: "search",
      input: { patterns: ["TODO"] },
    })).label).toBe("Search 1 text pattern");
  });

  it("groups adjacent successful reads and counts files rather than calls", () => {
    const tools = [
      part({
        id: "read-1",
        callId: "read-1",
        state: "succeeded",
        input: { paths: Array.from({ length: 10 }, (_, index) => `Batch A/${index}.md`) },
      }),
      part({
        id: "read-2",
        callId: "read-2",
        state: "succeeded",
        input: { paths: Array.from({ length: 10 }, (_, index) => `Batch B/${index}.md`) },
      }),
      part({
        id: "read-3",
        callId: "read-3",
        state: "succeeded",
        input: { paths: Array.from({ length: 10 }, (_, index) => `Batch C/${index}.md`) },
      }),
    ];
    const [entry] = groupConsecutiveToolActivity(tools, (tool) => tool);

    expect(entry.kind).toBe("tools");
    if (entry.kind !== "tools") throw new Error("Expected a tool group.");
    expect(entry.tools).toHaveLength(3);
    expect(presentAgentToolGroup(entry.tools)).toMatchObject({
      label: "Read 30 files",
      itemCount: 30,
      summary: "Batch A/0.md, Batch A/1.md, +28 more",
    });
  });

  it("keeps chronology, state, failure, location, duplicate-scope, and tool-kind boundaries", () => {
    type Activity = AgentToolPart | Readonly<{ kind: "reasoning" | "text"; id: string }>;
    const read = (
      id: string,
      overrides: Partial<AgentToolPart> = {},
    ): AgentToolPart => part({
      id,
      callId: id,
      state: "succeeded",
      input: { paths: [`${id}.md`] },
      ...overrides,
    });
    const activities: Activity[] = [
      read("first"),
      read("second"),
      { kind: "reasoning", id: "reasoning" },
      read("third"),
      read("open", { name: "open", input: { files: [{ path: "Open.md" }] } }),
      read("server", { location: "server" }),
      read("failed", {
        state: "failed",
        error: { code: "READ_FAILED", message: "Could not read Failed.md." },
      }),
      read("approval", { state: "approval-required", approvalId: "approval-1" }),
      read("duplicate-a", { input: { paths: ["Same.md"] } }),
      read("duplicate-b", { input: { paths: ["Same.md"] } }),
      { kind: "text", id: "text" },
      read("after-text"),
    ];
    const entries = groupConsecutiveToolActivity(
      activities,
      (activity) => "callId" in activity ? activity : null,
    );

    expect(entries.map((entry) => entry.kind === "tools"
      ? entry.tools.map((tool) => tool.id)
      : entry.item.kind)).toEqual([
      ["first", "second"],
      "reasoning",
      ["third"],
      ["open"],
      ["server"],
      ["failed"],
      ["approval"],
      ["duplicate-a"],
      ["duplicate-b"],
      "text",
      ["after-text"],
    ]);
  });

  it("does not group an item-level partial failure and summarizes its outcome plainly", () => {
    const successful = part({
      id: "read-ok",
      callId: "read-ok",
      state: "succeeded",
      input: { paths: ["One.md"] },
    });
    const partial = part({
      id: "read-partial",
      callId: "read-partial",
      state: "succeeded",
      input: { paths: ["Two.md", "Missing.md"] },
      output: {
        data: {
          files: [
            { path: "Two.md", content: "ok" },
            { path: "Missing.md", content: "", error: "File not found" },
          ],
        },
      },
    });
    const entries = groupConsecutiveToolActivity([successful, partial], (tool) => tool);

    expect(entries).toHaveLength(2);
    expect(presentAgentTool(partial)).toMatchObject({
      label: "Read 2 files",
      summary: "1 completed, 1 failed",
      stateLabel: "Done",
    });
  });
});
