import type { AgentToolPart } from "../../../chat/ChatConversation";
import { presentTurnChanges } from "../TurnChangeSummary";

function part(name: string, input: unknown, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return { id: "tool", kind: "tool", order: 1, messageId: "message", callId: "call", name, input, location: "vault", state: "succeeded", ...overrides };
}
const claude = { native: { agent: "claude" as const, workingDirectory: "/vault" } };
const codex = { native: { agent: "codex" as const, workingDirectory: "/vault" } };

describe("turn change receipts", () => {
  it("deduplicates successful mutations and preserves new, move and trash meanings", () => {
    expect(presentTurnChanges([
      part("edit", { path: "Notes/Plan.md" }),
      part("edit", { path: "Notes/Plan.md" }),
      part("write", { path: "New.md" }, { output: { data: { created: true } } }),
      part("move", { items: [{ source: "Old.md", destination: "Archive/Old.md" }] }),
      part("trash", { paths: ["Discard.md"] }),
      part("read", { paths: ["Reference.md"] }),
    ])).toEqual([
      { path: "Notes/Plan.md", label: "Plan" },
      { path: "New.md", label: "New", meta: "new" },
      { path: "Archive/Old.md", label: "Moved Old to Archive" },
      { path: "Discard.md", label: "Discard", meta: "in trash", deleted: true },
    ]);
  });

  it("names a replaced note as replaced, and keeps that through a later edit", () => {
    expect(presentTurnChanges([
      part("write", { path: "Notes/Launch plan.md", content: "# Launch plan" }, { output: { data: { created: false } } }),
      part("edit", { path: "Notes/Launch plan.md", edits: [{ oldText: "# Launch plan", newText: "# Launch" }] }, { callId: "edit" }),
      part("write", { path: "Log.md", content: "- watered", ifExists: "append" }, { callId: "append", output: { data: { created: false } } }),
    ])).toEqual([
      { path: "Notes/Launch plan.md", label: "Launch\u00a0plan", meta: "replaced" },
      { path: "Log.md", label: "Log", meta: "+1" },
    ]);
  });

  it("never predicts mutations from pending, denied, cancelled or failed input", () => {
    const states = ["approval-required", "running", "failed", "denied", "cancelled", "outcome-unknown"] as const;
    expect(presentTurnChanges(states.flatMap(state => [
      part("edit", { path: "Plan.md" }, { state }),
      part("Edit", { file_path: "/vault/Plan.md" }, { state, ...claude }),
    ]))).toEqual([]);
    expect(presentTurnChanges([
      part("write", { path: "Plan.md" }, { output: { data: { success: false } } }),
      part("edit", { path: "Plan.md" }, { output: { data: { results: [] } } }),
    ])).toEqual([]);
  });

  it("uses only explicit successful result rows, including a partially failed batch", () => {
    expect(presentTurnChanges([
      part("multi_edit", { files: [{ path: "Good.md" }, { path: "Failed.md" }] }, {
        state: "failed", output: { data: { results: [{ path: "Good.md", success: true }, { path: "Failed.md", success: false }] } },
      }),
      part("move", { items: [{ source: "Other.md", destination: "Missing.md" }] }, {
        output: { data: { results: [{ source: "Other.md", destination: "Archive/Other.md", success: true }] } },
      }),
    ])).toEqual([
      { path: "Good.md", label: "Good" },
      { path: "Archive/Other.md", label: "Moved Other to Archive" },
    ]);
  });

  it("marks successful trash result rows as deleted without disabling later recreated files", () => {
    const trashed = part("trash", { paths: ["Gone.md", "Restored.md", "Failed.md"] }, {
      state: "failed", output: { data: { results: [
        { path: "Gone.md", success: true },
        { path: "Restored.md", success: true },
        { path: "Failed.md", success: false },
      ] } },
    });
    expect(presentTurnChanges([trashed, part("write", { path: "Restored.md" }, { output: { data: { created: true } } })])).toEqual([
      { path: "Gone.md", label: "Gone", meta: "in trash", deleted: true },
      { path: "Restored.md", label: "Restored", meta: "new" },
    ]);
  });

  it("never returns external native paths or hosted server payloads as vault links", () => {
    expect(presentTurnChanges([
      part("Edit", { file_path: "/outside/Plan.md" }, claude),
      part("Write", { file_path: "../outside.md" }, claude),
      part("fileChange", { changes: [{ path: "/outside/Plan.md", kind: "update" }] }, codex),
      part("fileChange", { changes: [{ path: "Plan.md", kind: { type: "update", move_path: "/outside/Plan.md" } }] }, codex),
      part("write", { path: "/provider/private.md" }, { location: "server" }),
    ])).toEqual([]);
    expect(presentTurnChanges([part("Edit", { file_path: "/vault/Notes/Plan.md" }, claude)]))
      .toEqual([{ path: "Notes/Plan.md", label: "Plan" }]);
  });

  it("uses native add/delete/move semantics and parsed diff counts", () => {
    expect(presentTurnChanges([part("fileChange", { changes: [
      { path: "Notes/Plan.md", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
      { path: "New.md", kind: "add" },
      { path: "Gone.md", kind: "delete" },
      { path: "Old.md", kind: { type: "update", move_path: "/vault/Archive/Old.md" } },
    ] }, codex)])).toEqual([
      { path: "Notes/Plan.md", label: "Plan", meta: "+1 −1" },
      { path: "New.md", label: "New", meta: "new" },
      { path: "Gone.md", label: "Gone", meta: "deleted", deleted: true },
      { path: "Archive/Old.md", label: "Moved Old to Archive" },
    ]);
  });

  it("names notes as Obsidian does, keeps a short name whole and drops a zero count", () => {
    expect(presentTurnChanges([
      part("edit", { path: "Notes/Launch plan.md" }),
      part("fileChange", { changes: [{ path: "Notes/Basil.md", kind: "update", diff: "@@ -1 +1,2 @@\n basil\n+water\n" }] }, codex),
      part("move", { items: [{ source: "Notes/Old.md", destination: "Archive/Older.md" }] }),
    ])).toEqual([
      { path: "Notes/Launch plan.md", label: "Launch\u00a0plan" },
      { path: "Notes/Basil.md", label: "Basil", meta: "+1" },
      { path: "Archive/Older.md", label: "Moved Old → Archive/Older" },
    ]);
  });

  it("adds up the counts of a note changed twice and drops a count it cannot know", () => {
    const change = (diff: string) => part("fileChange", { changes: [{ path: "Notes/Plan.md", kind: "update", diff }] }, codex);
    expect(presentTurnChanges([change("@@ -1 +1 @@\n-old\n+new\n"), change("@@ -1 +1,2 @@\n new\n+more\n")]))
      .toEqual([{ path: "Notes/Plan.md", label: "Plan", meta: "+2 −1" }]);
    expect(presentTurnChanges([part("edit", { path: "Notes/Plan.md" }), change("@@ -1 +1,2 @@\n new\n+more\n")]))
      .toEqual([{ path: "Notes/Plan.md", label: "Plan" }]);
  });

  it("counts each note as its rows do, a note changed twice added up", () => {
    expect(presentTurnChanges([
      part("edit", { path: "Notes/Garden.md", edits: [{ oldText: "Tomatoes go in the south bed.", newText: "Tomatoes and basil go in the south bed." }] },
        { output: { data: { path: "Notes/Garden.md", success: true, appliedCount: 1, requestedCount: 1, skipped: [] } } }),
      part("write", { path: "Notes/Basil.md", content: "# Basil\n\nSow after the last frost.\nPinch the tips weekly." }, { output: { data: { path: "Notes/Basil.md", success: true } } }),
      part("Edit", { file_path: "/vault/Notes/Launch plan.md", old_string: "# Launch", new_string: "# Launch\n\nPlant basil in week 2." }, claude),
      part("fileChange", { changes: [{ path: "/vault/Notes/Garden.md", kind: { type: "update" }, diff: "@@ -1,3 +1,4 @@\n # Garden plan\n \n Tomatoes and basil go in the south bed.\n+Water every other morning.\n" }] }, codex),
      part("multi_edit", { files: [{ path: "A.md", edits: [{ oldText: "a", newText: "b" }] }, { path: "B.md", edits: [{ oldText: "c", newText: "c\nd" }] }] },
        { output: { data: { results: [{ path: "A.md", success: true }, { path: "B.md", success: true }] } } }),
    ])).toEqual([
      { path: "Notes/Garden.md", label: "Garden", meta: "+2 −1" },
      { path: "Notes/Basil.md", label: "Basil", meta: "+4" },
      { path: "Notes/Launch plan.md", label: "Launch\u00a0plan", meta: "+2" },
      { path: "A.md", label: "A", meta: "+1 −1" },
      { path: "B.md", label: "B", meta: "+1" },
    ]);
  });

  it("resolves native receipts from a nested cwd against the vault root and its alias", () => {
    const native = { agent: "claude" as const, workingDirectory: "/vault/Notes", vaultRoot: "/vault", vaultRootAlias: "/alias/vault" };
    expect(presentTurnChanges([
      part("Edit", { file_path: "Plan.md" }, { native }),
      part("Write", { file_path: "/alias/vault/Ideas.md" }, { native }),
      part("fileChange", { changes: [{ path: "Old.md", kind: { type: "update", move_path: "../Archive/Old.md" } }] },
        { native: { ...native, agent: "codex" } }),
    ])).toEqual([
      { path: "Notes/Plan.md", label: "Plan" },
      { path: "Ideas.md", label: "Ideas", meta: "written" },
      { path: "Archive/Old.md", label: "Moved Old to Archive" },
    ]);
  });
});
