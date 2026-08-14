import {
  presentAgentTool,
  presentAgentToolDetails,
  presentAgentToolFailure,
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
      label: "Reading 1 file...",
      actionIcon: "file-text",
      icon: "minus",
      summary: "Projects/Plan.md",
    });
  });

  it.each([
    ["input-streaming", "minus"],
    ["input-ready", "minus"],
    ["approved", "minus"],
    ["running", "minus"],
    ["succeeded", "check"],
  ] as const)(
    "omits routine state text for %s while preserving its static mark",
    (state, icon) => {
      expect(presentAgentTool(part({ state }))).toMatchObject({
        icon,
      });
    },
  );

  it.each([
    ["approval-required", "minus"],
    ["failed", "x"],
    ["denied", "x"],
    ["cancelled", "x"],
    ["outcome-unknown", "x"],
  ] as const)(
    "uses a static mark without visible state text for %s",
    (state, icon) => {
      expect(presentAgentTool(part({ state }))).toMatchObject({
        icon,
      });
    },
  );

  it("prefers the result summary and truncates it for the single-line row", () => {
    const presentation = presentAgentTool(part({
      state: "succeeded",
      output: { summary: `Updated ${"very ".repeat(30)}long.md` },
    }));
    expect(presentation.summary?.length).toBeLessThanOrEqual(96);
    expect(presentation.summary).toMatch(/…$/);
  });

  it("keeps a clear failed state for the inline error treatment", () => {
    expect(presentAgentTool(part({
      state: "failed",
      error: { code: "failed", message: "Could not read the file." },
    }))).toMatchObject({ icon: "x" });
  });

  it("presents canonical tool names", () => {
    expect(presentAgentTool(part({ name: "write", input: { path: "Note.md" } })))
      .toMatchObject({
        canonicalName: "write",
        label: "Writing file...",
        actionIcon: "file-plus-2",
        summary: "Note.md",
      });
    expect(presentAgentTool(part({ name: "future_tool" }))).toMatchObject({
      canonicalName: "future_tool",
      actionIcon: "wrench",
    });
  });

  it("names context-tool rows by the actual pinning action", () => {
    expect(presentAgentTool(part({
      name: "context",
      input: { action: "add", paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Pinning files...",
      summary: "Project.md",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { action: "remove", paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Unpinning files...",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Managing pinned files...",
    });
  });

  it("exposes only a completed public web query in tool details", () => {
    expect(presentAgentToolDetails(part({
      name: "web_search",
      location: "server",
      input: { query: "Private model-authored query" },
      state: "running",
    }))).toEqual([]);
    expect(presentAgentToolDetails(part({
      name: "web_search",
      location: "server",
      input: { query: "Completed public query" },
      state: "succeeded",
    }))).toEqual([{ label: "Query", value: "Completed public query" }]);
  });

  it("presents capped, known vault details without exposing file or edit content", () => {
    const secret = "private edit text sentinel";
    const details = presentAgentToolDetails(part({
      name: "multi_edit",
      input: {
        files: Array.from({ length: 10 }, (_, index) => ({
          path: `Projects/${index}-${"long".repeat(80)}.md`,
          edits: [{ oldText: secret, newText: secret }],
        })),
      },
      state: "succeeded",
      output: { summary: "Updated project files." },
    }));

    expect(details).toHaveLength(8);
    expect(details.at(-1)).toEqual({ label: "More", value: "3 more items" });
    expect(details.every((detail) => detail.value.length <= 240)).toBe(true);
    expect(JSON.stringify(details)).not.toContain(secret);
  });

  it("shows only successful artifacts for a partial vault result", () => {
    const details = presentAgentToolDetails(part({
      name: "multi_edit",
      input: {
        files: ["Completed.md", "Failed.md"].map((path) => ({
          path,
          edits: [{ oldText: "before", newText: "after" }],
        })),
      },
      state: "failed",
      output: {
        summary: "Failed.md could not be edited.",
        data: batchToolOutput("multi_edit", ["succeeded", "failed"]),
        artifacts: [{
          id: "completed-artifact",
          kind: "vault_file",
          title: "Completed.md",
          path: "Completed.md",
        }],
      },
      error: {
        code: "TOOL_PARTIAL_FAILURE",
        message: PRIVATE_FAILURE_SENTINEL,
      },
    }));

    expect(details).toEqual([{ label: "Path", value: "Completed.md" }]);
    expect(JSON.stringify(details)).not.toContain("Failed.md");
  });

  it("omits a result that repeats the visible summary or a detail path", () => {
    expect(presentAgentToolDetails(part({
      state: "succeeded",
      input: { paths: ["Projects/Plan.md"] },
      output: { summary: "Projects/Plan.md" },
    }))).toEqual([{ label: "Path", value: "Projects/Plan.md" }]);
  });

  it("does not expose unknown server input or output as tool details", () => {
    const secret = "private provider detail sentinel";
    expect(presentAgentToolDetails(part({
      name: "provider_action",
      location: "server",
      input: { query: secret, path: secret },
      state: "succeeded",
      output: { title: secret, summary: secret, data: { value: secret } },
    }))).toEqual([]);
  });

  it("does not expose unknown vault input or output as tool details", () => {
    const secret = "private additive vault detail sentinel";
    expect(presentAgentToolDetails(part({
      name: "future_vault_tool",
      input: { path: secret },
      state: "succeeded",
      output: { title: secret, summary: secret, data: { value: secret } },
    }))).toEqual([]);
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
      label: "Running SystemSculpt action...",
      actionIcon: "wand-sparkles",
      summary: null,
    });
    expect(JSON.stringify(presentation)).not.toMatch(
      /cf_agent|provider|cloudflare|retry/i,
    );
    expect(presentAgentTool(part({
      name: "read",
      location: "server",
      input: { paths: ["Private provider path"] },
    }))).toMatchObject({
      label: "Running SystemSculpt action...",
      summary: null,
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
      label: "Running SystemSculpt action...",
      icon: "minus",
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
    expect(presentAgentTool(part({ state: "succeeded", input: { paths: ["One.md"] } })).label)
      .toBe("Read 1 file");
    expect(presentAgentTool(part({ state: "succeeded", input: { paths: ["One.md", "Two.md"] } })).label)
      .toBe("Read 2 files");
    expect(presentAgentTool(part({
      state: "succeeded",
      name: "open",
      input: { files: [{ path: "One.md" }, { path: "Two.md" }] },
    })).label).toBe("Opened 2 files");
    expect(presentAgentTool(part({
      state: "succeeded",
      name: "list_items",
      input: { paths: ["Projects", "Archive"] },
    })).label).toBe("Listed 2 folders");
    expect(presentAgentTool(part({
      state: "succeeded",
      name: "find",
      input: { patterns: ["project", "meeting"] },
    })).label).toBe("Searched 2 patterns");
    expect(presentAgentTool(part({
      state: "succeeded",
      name: "search",
      input: { patterns: ["TODO"] },
    })).label).toBe("Searched 1 pattern");
  });

  it("presents an item-level partial failure independently", () => {
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
    expect([successful, partial].map((tool) => presentAgentTool(tool).displayState))
      .toEqual(["succeeded", "partial"]);
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
        icon: "check",
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
        summary: "1 completed, 1 failed",
        icon: "x",
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
        summary: "0 completed, 2 failed",
        icon: "x",
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
      icon: "x",
      summary: "1 completed, 1 failed",
    });
    expect(JSON.stringify(presentation)).not.toContain(PRIVATE_FAILURE_SENTINEL);
  });
});
