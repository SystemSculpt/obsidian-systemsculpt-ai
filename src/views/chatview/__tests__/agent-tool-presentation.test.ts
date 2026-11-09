import {
  presentToolLineMeta,
  presentAgentTool,
  presentAgentToolDetails,
  presentAgentToolFailure,
} from "../AgentToolPresentation";
import type { AgentToolPart } from "../../../chat/ChatConversation";

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
      label: "Reading Plan",
      actionIcon: "file-text",
      icon: "loader-circle",
      targetPath: "Projects/Plan.md",
      groupKind: "read",
      groupCount: 1,
      // The label names the note and the card shows its path: the row never repeats it as meta.
      summary: null,
    });
  });

  it.each([
    ["input-streaming", "loader-circle"],
    ["input-ready", "loader-circle"],
    ["approved", "loader-circle"],
    ["running", "loader-circle"],
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
    ["approval-required", "shield-question"],
    ["failed", "x"],
    ["denied", "ban"],
    ["cancelled", "circle-stop"],
    ["outcome-unknown", "circle-help"],
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
        label: "Creating Note",
        actionIcon: "file-plus-2",
        summary: null,
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
      label: "Pinning files",
      summary: "Project.md",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { action: "remove", paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Unpinning files",
    });
    expect(presentAgentTool(part({
      name: "context",
      input: { paths: ["Project.md"] },
    }))).toMatchObject({
      canonicalName: "context",
      label: "Managing pinned files",
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

  it("never counts a hosted web search's results, which its card cannot list", () => {
    const search = part({ name: "web_search", location: "server", state: "succeeded", input: {},
      output: { data: { query: "Public query", result_count: 3, matches: ["private"] } } });
    // Its sources reach the answer's Sources list, not the call: a row counts only results its card lists.
    expect(presentAgentToolDetails(search)).toEqual([{ label: "Query", value: "Public query" }]);
    expect(presentAgentTool(search).meta).toBeUndefined();
    expect(presentAgentTool({ ...search, name: "private_server_tool" }).meta).toBeUndefined();
  });

  it("counts a vault edit's or write's lines from the diff its card draws", () => {
    const edit = part({ name: "edit", state: "succeeded",
      input: { path: "Notes/Garden.md", edits: [{ oldText: "Tomatoes go in the south bed.", newText: "Tomatoes and basil go in the south bed." }] },
      output: { data: { path: "Notes/Garden.md", success: true, appliedCount: 1, requestedCount: 1, skipped: [] } } });
    expect(presentAgentTool(edit).meta).toBe("+1 \u22121");
    const write = part({ name: "write", state: "succeeded",
      input: { path: "Notes/Basil.md", content: "# Basil\n\nSow after the last frost.\nPinch the tips weekly." },
      output: { data: { path: "Notes/Basil.md", success: true } } });
    expect(presentAgentTool(write).meta).toBe("+4");
    const multi = part({ name: "multi_edit", state: "succeeded",
      input: { files: [
        { path: "A.md", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "c\nd" }] },
        { path: "B.md", edits: [{ oldText: "x", newText: "y" }] },
      ] },
      output: { data: { results: [
        { path: "A.md", success: true, appliedCount: 1, requestedCount: 2, skipped: [{ index: 0, reason: "Not found" }] },
        { path: "B.md", success: false, error: "File not found" },
      ] } } });
    // Only what applied counts: A.md's second edit; the skipped edit and the failed note count nothing.
    expect(presentAgentTool(multi).meta).toBe("+1");
    // A regular expression isn't the text it changes; a write that may have kept the old note claims nothing.
    expect(presentAgentTool({ ...edit, input: { path: "Notes/Garden.md", edits: [{ oldText: "a+", newText: "b", isRegex: true }] } }).meta).toBeUndefined();
    expect(presentAgentTool({ ...write, input: { ...(write.input as object), ifExists: "skip" } }).meta).toBeUndefined();
    for (const state of ["approval-required", "failed", "denied", "cancelled", "outcome-unknown"] as const) {
      expect(presentAgentTool({ ...edit, state }).meta).toBeUndefined();
    }
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
      label: "Running SystemSculpt action",
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
      label: "Running SystemSculpt action",
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
      label: "Running SystemSculpt action",
      icon: "loader-circle",
    });
  });

  it("names find, search and open inputs in the label, never again as meta", () => {
    expect(presentAgentTool(part({ name: "find", input: { patterns: ["meeting", "notes"] } })).summary)
      .toBeNull();
    expect(presentAgentTool(part({ name: "search", input: { patterns: ["TODO"] } }))).toMatchObject({
      label: "Searching “TODO”", summary: null, target: { text: "“TODO”" },
    });
    expect(presentAgentTool(part({
      name: "open",
      input: { files: [{ path: "Research/Plan.md" }] },
    }))).toMatchObject({ summary: null, targetPath: "Research/Plan.md", target: { text: "Plan" } });
  });

  it("uses accurate singular and plural labels for safely countable tools", () => {
    expect(presentAgentTool(part({ state: "succeeded", input: { paths: ["One.md"] } })).label)
      .toBe("Read One");
    expect(presentAgentTool(part({ state: "succeeded", input: { paths: ["One.md", "Two.md"] } })).label)
      .toBe("Read 2 notes");
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
    })).label).toBe("Searched for 2 patterns");
    expect(presentAgentTool(part({
      state: "succeeded",
      name: "search",
      input: { patterns: ["TODO"] },
    })).label).toBe("Searched “TODO”");
  });

  it("uses explicit action failures, meaningful result metadata and from/to moves", () => {
    expect(presentAgentTool(part({ name: "edit", input: { path: "Notes/Plan.md" }, state: "failed" })))
      .toMatchObject({ label: "Couldn't edit Plan", targetPath: "Notes/Plan.md" });
    expect(presentAgentTool(part({ name: "search", input: { patterns: ["launch"] }, state: "succeeded", output: { data: { totalMatches: 7 } } })))
      .toMatchObject({ label: "Searched “launch”", meta: "7 results" });
    expect(presentAgentTool(part({ name: "move", input: { items: [{ source: "Notes/Plan.md", destination: "Archive/Plan.md" }] }, state: "succeeded" })).label)
      .toBe("Moved Plan to Archive");
    expect(presentAgentTool(part({ name: "move", input: { items: [{ source: "Notes/Plan.md", destination: "Plan.md" }] }, state: "succeeded" })).label)
      .toBe("Moved Plan to the vault root");
    expect(presentAgentTool(part({ name: "move", input: { items: [{ source: "Notes/Plan.md", destination: "Archive/Old plan.md" }] }, state: "succeeded" })).label)
      .toBe("Moved Plan → Archive/Old plan");
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
        icon: "triangle-alert",
      });
      // The card lists each item with its own outcome, so no notice repeats it.
      expect(mixedFailure).toBe("");
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
      expect(failedCopy).toBe("");
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
      icon: "triangle-alert",
      summary: "1 completed, 1 failed",
    });
    expect(JSON.stringify(presentation)).not.toContain(PRIVATE_FAILURE_SENTINEL);
  });
});

describe("tool line meta", () => {
  const hosted = (name: string, input: unknown) => ({
    kind: "tool" as const, id: "t", callId: "t", messageId: "m", order: 0, name, input, state: "succeeded" as const, location: "vault" as const,
  });
  it("doesn't repeat the label or name one of several targets", () => {
    const meta = (name: string, input: unknown) => presentToolLineMeta(presentAgentTool(hosted(name, input)));
    expect(meta("search", { patterns: ["milestone"], paths: ["Notes"] })).toBeUndefined();
    expect(meta("read", { paths: ["Notes/A.md", "B.md"] })).toBeUndefined();
    // The card shows the note's path; the row's label already names it.
    expect(meta("read", { paths: ["Research/One.md"] })).toBeUndefined();
  });
});
