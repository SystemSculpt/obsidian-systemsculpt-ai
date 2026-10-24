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
      { path: "Notes/Plan.md", label: "Plan.md" },
      { path: "New.md", label: "New.md", meta: "new" },
      { path: "Archive/Old.md", label: "Moved Old.md → Archive/Old.md" },
      { path: "Discard.md", label: "Deleted Discard.md", meta: "in trash" },
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
      { path: "Good.md", label: "Good.md" },
      { path: "Archive/Other.md", label: "Moved Other.md → Archive/Other.md" },
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
      .toEqual([{ path: "Notes/Plan.md", label: "Plan.md" }]);
  });

  it("uses native add/delete/move semantics and parsed diff counts", () => {
    expect(presentTurnChanges([part("fileChange", { changes: [
      { path: "Notes/Plan.md", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
      { path: "New.md", kind: "add" },
      { path: "Gone.md", kind: "delete" },
      { path: "Old.md", kind: { type: "update", move_path: "/vault/Archive/Old.md" } },
    ] }, codex)])).toEqual([
      { path: "Notes/Plan.md", label: "Plan.md", meta: "+1 −1" },
      { path: "New.md", label: "New.md", meta: "new" },
      { path: "Gone.md", label: "Deleted Gone.md", meta: "deleted" },
      { path: "Archive/Old.md", label: "Moved Old.md → Archive/Old.md" },
    ]);
  });
});
