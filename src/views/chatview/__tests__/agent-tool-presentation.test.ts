import {
  groupConsecutiveToolActivity,
  presentAgentTool,
  presentAgentToolFailure,
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

const PRIVATE_FAILURE_SENTINEL = "/Users/private/SecretVault failure sentinel";
const BATCH_TOOL_NAMES = [
  "read",
  "create_folders",
  "list_items",
  "move",
  "trash",
  "context",
  "open",
  "multi_edit",
] as const;
type BatchToolName = typeof BATCH_TOOL_NAMES[number];
type BatchOutcome = "succeeded" | "failed";

function batchToolInput(name: BatchToolName): Record<string, unknown> {
  if (name === "open") {
    return { files: [{ path: "Completed.md" }, { path: "Failed.md" }] };
  }
  if (name === "move") {
    return {
      items: [
        { source: "Completed.md", destination: "Archive/Completed.md" },
        { source: "Failed.md", destination: "Archive/Failed.md" },
      ],
    };
  }
  if (name === "multi_edit") {
    return {
      files: ["Completed.md", "Failed.md"].map((path) => ({
        path,
        edits: [{ oldText: "before", newText: "after" }],
      })),
    };
  }
  if (name === "context") {
    return { action: "add", paths: ["Completed.md", "Failed.md"] };
  }
  return { paths: ["Completed.md", "Failed.md"] };
}

function batchToolOutput(
  name: BatchToolName,
  outcomes: readonly BatchOutcome[],
): Record<string, unknown> {
  const successful = outcomes.filter((outcome) => outcome === "succeeded").length;
  if (name === "open") {
    return {
      opened: outcomes.flatMap((outcome, index) =>
        outcome === "succeeded" ? [`Opened-${index}.md`] : []),
      errors: outcomes.flatMap((outcome) =>
        outcome === "failed" ? [PRIVATE_FAILURE_SENTINEL] : []),
    };
  }
  if (name === "read") {
    return {
      files: outcomes.map((outcome, index) => outcome === "succeeded"
        ? { path: `Read-${index}.md`, content: "ok" }
        : { path: `Read-${index}.md`, content: "", error: PRIVATE_FAILURE_SENTINEL }),
    };
  }
  if (name === "list_items") {
    return {
      results: outcomes.map((outcome, index) => outcome === "succeeded"
        ? {
            path: `Folder-${index}`,
            files: [],
            directories: [],
            offset: 0,
            totalItems: 0,
            nextOffset: null,
          }
        : {
            path: `Folder-${index}`,
            error: PRIVATE_FAILURE_SENTINEL,
            offset: 0,
            totalItems: 0,
            nextOffset: null,
          }),
    };
  }
  const results = outcomes.map((outcome, index) => ({
    ...(name === "move"
      ? { source: `Source-${index}.md`, destination: `Destination-${index}.md` }
      : { path: `Item-${index}.md` }),
    success: outcome === "succeeded",
    ...(outcome === "failed"
      ? name === "context"
        ? { reason: PRIVATE_FAILURE_SENTINEL }
        : { error: PRIVATE_FAILURE_SENTINEL }
      : {}),
    ...(name === "multi_edit" ? {
      appliedCount: outcome === "succeeded" ? 1 : 0,
      requestedCount: 1,
      skipped: [],
    } : {}),
  }));
  if (name === "context") {
    return {
      action: "add",
      processed: successful,
      results,
      summary: "Context update completed.",
    };
  }
  if (name === "multi_edit") {
    return {
      success: successful === outcomes.length,
      requestedFiles: outcomes.length,
      appliedFiles: successful,
      preflightFailed: successful === 0,
      results,
    };
  }
  return { results };
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

  it("shows only a completed, privacy-approved web search query", () => {
    expect(presentAgentTool(part({
      name: "web_search",
      location: "server",
      input: {},
      state: "succeeded",
      output: {
        data: { query: "Obsidian agent plugins" },
        title: "Cloudflare search",
        summary: "OpenRouter web search completed",
      },
    }))).toMatchObject({
      canonicalName: "web_search",
      label: "Search the web",
      summary: null,
      itemCount: null,
      queries: ["Obsidian agent plugins"],
    });
    expect(presentAgentTool(part({
      name: "web_search",
      location: "server",
      input: { query: "Private model-authored query" },
      state: "running",
    })).queries).toEqual([null]);
  });

  it("groups an adjacent web-search batch and preserves every query in order", () => {
    const search = (
      id: string,
      query: string,
      state: AgentToolPart["state"] = "succeeded",
    ): AgentToolPart => part({
      id,
      callId: id,
      name: "web_search",
      location: "server",
      input: {},
      state,
      ...(state === "succeeded" ? { output: { data: { query } } } : {}),
    });
    const activities = [
      search("search-1", "Blaxel funding"),
      search("search-2", "site:blaxel.ai seed round"),
      search("search-3", "Blaxel First Round", "running"),
    ];
    const [entry] = groupConsecutiveToolActivity(
      activities,
      (tool) => tool,
      false,
    );

    expect(entry.kind).toBe("tools");
    if (entry.kind !== "tools") throw new Error("Expected a web-search group.");
    expect(entry.tools).toHaveLength(3);
    expect(presentAgentToolGroup(entry.tools)).toMatchObject({
      label: "Search the web (3)",
      displayState: "running",
      stateLabel: "Working",
      itemCount: 3,
      queries: [
        "Blaxel funding",
        "site:blaxel.ai seed round",
        null,
      ],
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

  it("does not group an item-level partial failure", () => {
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
  });

  it.each(BATCH_TOOL_NAMES)(
    "classifies actual %s batch outcomes without exposing failure details",
    (name) => {
      const input = batchToolInput(name);
      const successful = part({
        name,
        input,
        state: "succeeded",
        output: { data: batchToolOutput(name, ["succeeded", "succeeded"]) },
      });
      expect(presentAgentTool(successful)).toMatchObject({
        displayState: "succeeded",
        stateLabel: "Done",
        icon: "circle-check",
      });

      const mixed = part({
        name,
        input,
        state: "failed",
        output: { data: batchToolOutput(name, ["succeeded", "failed"]) },
        error: {
          code: "TOOL_PARTIAL_FAILURE",
          message: PRIVATE_FAILURE_SENTINEL,
        },
      });
      const mixedPresentation = presentAgentTool(mixed);
      const mixedFailure = presentAgentToolFailure(mixed);
      expect(mixedPresentation).toMatchObject({
        displayState: "partial",
        stateLabel: "Partial",
        summary: "1 completed, 1 failed",
        icon: "circle-alert",
      });
      expect(mixedFailure)
        .toBe("Some requested items failed; successful items were kept.");
      expect(JSON.stringify({ mixedPresentation, mixedFailure }))
        .not.toContain(PRIVATE_FAILURE_SENTINEL);

      const failed = part({
        name,
        input,
        state: "failed",
        output: { data: batchToolOutput(name, ["failed", "failed"]) },
        // Structured outcomes must override stale partial metadata.
        error: {
          code: "TOOL_PARTIAL_FAILURE",
          message: PRIVATE_FAILURE_SENTINEL,
        },
      });
      const failedPresentation = presentAgentTool(failed);
      const failedCopy = presentAgentToolFailure(failed);
      expect(failedPresentation).toMatchObject({
        displayState: "failed",
        stateLabel: "Failed",
        summary: "0 completed, 2 failed",
        icon: "circle-x",
      });
      expect(failedCopy).toBe("This vault action could not be completed.");
      expect(JSON.stringify({ failedPresentation, failedCopy }))
        .not.toContain(PRIVATE_FAILURE_SENTINEL);
    },
  );

  it("counts only valid opened paths in the privacy-safe workspace summary", () => {
    const presentation = presentAgentTool(part({
      name: "open",
      state: "failed",
      output: {
        data: {
          opened: ["One.md", "", { path: "not-an-opened-path" }],
          errors: [PRIVATE_FAILURE_SENTINEL],
        },
      },
      error: {
        code: "TOOL_PARTIAL_FAILURE",
        message: PRIVATE_FAILURE_SENTINEL,
      },
    }));

    expect(presentation).toMatchObject({
      displayState: "partial",
      stateLabel: "Partial",
      summary: "1 completed, 1 failed",
    });
    expect(JSON.stringify(presentation)).not.toContain(PRIVATE_FAILURE_SENTINEL);
  });
});
