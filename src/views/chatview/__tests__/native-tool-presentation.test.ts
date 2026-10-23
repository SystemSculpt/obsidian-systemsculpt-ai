/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { nativeToolPresentation, renderNativeToolPreview } from "../NativeToolPresentation";
import { nativeToolPath, prepareNativeWriteEditPreview } from "../ToolCallPreview";
import { presentAgentTool, presentAgentToolDetails, presentAgentToolFailure } from "../AgentToolPresentation";

function part(name = "Edit", input: unknown = {}, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return {
    id: "native-part", order: 1, kind: "tool", messageId: "message", callId: "call",
    name, input, location: "server", state: "approval-required",
    native: { agent: "claude", workingDirectory: "/vault" }, ...overrides,
  };
}
function vault(contents: Record<string, string> = {}) {
  const files = new Map(Object.keys(contents).map(path => [path, new TFile({ path })]));
  const read = jest.fn(async (file: TFile) => contents[file.path]);
  const getAbstractFileByPath = jest.fn((path: string) => files.get(path) ?? null);
  return { app: { vault: { read, getAbstractFileByPath } } as unknown as App, read, getAbstractFileByPath };
}
function edit(input: Record<string, unknown> = {}) {
  return part("Edit", { file_path: "/vault/Notes/Plan.md", old_string: "before", new_string: "after", ...input });
}
function codex(name: string, input: unknown, requestMethod?: string): AgentToolPart {
  return part(name, input, { native: { agent: "codex", workingDirectory: "/vault", requestMethod } });
}

describe("native tool paths", () => {
  it.each([
    ["/vault/Notes/../Plan.md", "/vault", "Plan.md", "Plan.md"],
    ["./Notes/../Plan.md", "/vault/", "Plan.md", "Plan.md"],
    ["Notes//Plan.md", "/vault", "Notes/Plan.md", "Notes/Plan.md"],
    ["../outside.md", "/vault", "/outside.md", null],
    ["/vault-copy/Plan.md", "/vault", "/vault-copy/Plan.md", null],
    ["/vault/../private/Plan.md", "/vault", "/private/Plan.md", null],
    ["/vault", "/vault", "Vault root", null],
    ["C:\\Vault\\Notes\\..\\Plan.md", "C:\\Vault", "Plan.md", "Plan.md"],
    [".\\Notes\\Plan.md", "C:\\Vault", "Notes/Plan.md", "Notes/Plan.md"],
    ["D:\\Private\\Plan.md", "C:\\Vault", "D:/Private/Plan.md", null],
    ["~/Plan.md", "/vault", "~/Plan.md", null],
    ["Plan.md", "relative", "Plan.md", null],
    ["/Plan.md", "/", "Plan.md", "Plan.md"],
  ])("normalizes %s against %s without turning external paths into vault paths", (path, cwd, displayPath, vaultPath) => {
    expect(nativeToolPath(path, cwd)).toEqual({ displayPath, vaultPath });
  });
});

describe("native presentation metadata", () => {
  it.each([
    ["Edit", { file_path: "/vault/Notes/Plan.md" }, "Edit Notes/Plan.md", "Edited Notes/Plan.md", "file-pen-line"],
    ["MultiEdit", { file_path: "Notes/Plan.md" }, "Edit Notes/Plan.md", "Edited Notes/Plan.md", "file-pen-line"],
    ["Write", { file_path: "New.md" }, "Write New.md", "Wrote New.md", "file-plus-2"],
    ["Bash", { command: "git status", description: "Check changed files" }, "Run git status", "Ran git status", "terminal"],
    ["WebFetch", { url: "https://example.com/guide" }, "Read https://example.com/guide", "Read https://example.com/guide", "globe-2"],
    ["WebSearch", { query: "gardening advice" }, "Search the web for gardening advice", "Searched the web for gardening advice", "globe-2"],
  ])("presents %s using a readable verb and target", (name, input, title, completedTitle, icon) => {
    expect(nativeToolPresentation(part(name, input))).toMatchObject({ title, completedTitle, icon, agentName: "Claude Code" });
  });

  it("uses a readable fallback for unknown native actions without exposing protocol names", () => {
    expect(nativeToolPresentation(part("UnknownNativeAction")))
      .toMatchObject({ title: "Run a Claude Code action", completedTitle: "Ran a Claude Code action", icon: "wrench" });
    expect(nativeToolPresentation(codex("future_item", {})))
      .toMatchObject({ title: "Run a Codex action", completedTitle: "Ran a Codex action" });
  });

  it("recognizes raw question requests as well as their native request method", () => {
    const input = { questions: [{ id: "question", header: "Choose", question: "Which file?" }] };
    expect(nativeToolPresentation(codex("requestUserInput", input)))
      .toMatchObject({ title: "Answer a question", completedTitle: "Answered a question", icon: "message-circle-question" });
    expect(nativeToolPresentation(codex("unknown", input, "item/tool/requestUserInput"))?.title).toBe("Answer a question");
  });

  it("uses Codex file kinds and destination paths", () => {
    expect(nativeToolPresentation(codex("fileChange", { changes: [{ path: "/vault/New.md", kind: { type: "add" }, diff: "" }] })))
      .toMatchObject({ title: "Create New.md", completedTitle: "Created New.md", agentName: "Codex" });
    expect(nativeToolPresentation(codex("fileChange", { changes: [{ path: "Old.md", kind: { type: "update", move_path: "/vault/New.md" }, diff: "" }] })))
      .toMatchObject({ title: "Move and edit Old.md → New.md" });
    expect(nativeToolPresentation(codex("fileChange", { changes: [{ path: "Old.md", kind: { type: "delete" }, diff: "" }] })))
      .toMatchObject({ title: "Delete Old.md" });
  });

  it("preserves native approval and decision state without claiming execution", () => {
    const pending = edit();
    expect(presentAgentTool(pending)).toMatchObject({ label: "Edit Notes/Plan.md", displayState: "approval-required", actionIcon: "file-pen-line" });
    expect(presentAgentTool({ ...pending, state: "denied", approvalDecision: "denied" }))
      .toMatchObject({ label: "Edit Notes/Plan.md", displayState: "denied", icon: "x" });
    expect(presentAgentTool({ ...pending, state: "running", approvalDecision: "approved" }).label).toBe("Editing Notes/Plan.md...");
    expect(presentAgentTool({ ...pending, state: "succeeded", approvalDecision: "approved" }).label).toBe("Edited Notes/Plan.md");
    expect(presentAgentTool({ ...pending, state: "cancelled", approvalDecision: "withdrawn" }).label).toBe("Edit Notes/Plan.md");
    expect(presentAgentToolDetails(pending)).toEqual([]);
    expect(presentAgentToolFailure({ ...pending, state: "failed" })).toBe("This Claude Code action could not be completed.");
  });

  it("keeps the hosted path separate and retains its original presentation", async () => {
    const hosted = part("write", { path: "Note.md", content: "hello" }, { native: undefined, location: "vault", state: "running" });
    expect(nativeToolPresentation(hosted)).toBeNull();
    const { app, read } = vault();
    const host = document.createElement("div");
    expect(await renderNativeToolPreview(app, host, hosted)).toBe(false);
    expect(await prepareNativeWriteEditPreview(app, hosted)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(host.childElementCount).toBe(0);
    expect(presentAgentTool(hosted)).toMatchObject({ label: "Writing file...", summary: "Note.md" });
    const server = { ...hosted, location: "server" as const, name: "future_action", state: "approval-required" as const };
    expect(presentAgentTool(server)).toMatchObject({ label: "Running SystemSculpt action...", displayState: "running" });
  });
});

describe("real native edit previews", () => {
  it("reads the actual vault file and applies literal replacement text", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "first\nbefore\nlast\n" });
    const preview = await prepareNativeWriteEditPreview(app, edit({ file_path: "./Notes/../Notes/Plan.md", new_string: "$& after" }));
    expect(getAbstractFileByPath).toHaveBeenCalledWith("Notes/Plan.md");
    expect(read).toHaveBeenCalledTimes(1);
    expect(preview).toMatchObject({ path: "Notes/Plan.md", oldContent: "first\nbefore\nlast\n", newContent: "first\n$& after\nlast\n", status: "changed", requestedCount: 1, appliedCount: 1 });
    expect(preview?.diff.stats).toEqual({ additions: 1, deletions: 1 });
  });

  it("keeps CRLF exact for matching and preserves untouched CRLF content", async () => {
    const { app } = vault({ "Notes/Plan.md": "first\r\nbefore\r\nlast\r\n" });
    const match = await prepareNativeWriteEditPreview(app, edit({ old_string: "before\r\n", new_string: "after\r\n" }));
    expect(match?.newContent).toBe("first\r\nafter\r\nlast\r\n");
    expect(match?.diff.stats).toEqual({ additions: 1, deletions: 1 });
    const mismatch = await prepareNativeWriteEditPreview(app, edit({ old_string: "before\n", new_string: "after\n" }));
    expect(mismatch).toMatchObject({ status: "unmatched", appliedCount: 0, newContent: "first\r\nbefore\r\nlast\r\n" });
    expect(mismatch?.notice).toContain("line endings");
  });

  it("does not use fuzzy whitespace matching or a folder-note alias", async () => {
    const { app, getAbstractFileByPath } = vault({ "Notes/Plan.md": "  before\n  last" });
    expect(await prepareNativeWriteEditPreview(app, edit({ old_string: "before\nlast" }))).toMatchObject({ status: "unmatched", appliedCount: 0 });
    expect(await prepareNativeWriteEditPreview(app, edit({ file_path: "Notes/Plan" }))).toMatchObject({ status: "missing" });
    expect(getAbstractFileByPath.mock.calls.map(([path]) => path)).toEqual(["Notes/Plan.md", "Notes/Plan"]);
  });

  it("requires replace_all for repeated matches and does not expand replacement tokens", async () => {
    const { app } = vault({ "Notes/Plan.md": "before before" });
    expect(await prepareNativeWriteEditPreview(app, edit())).toMatchObject({ status: "unmatched", newContent: "before before", appliedCount: 0 });
    expect(await prepareNativeWriteEditPreview(app, edit({ replace_all: true, new_string: "$&" }))).toMatchObject({ status: "changed", newContent: "$& $&" });
  });

  it("applies MultiEdit sequentially and withholds a fabricated after-file when any edit fails", async () => {
    const { app } = vault({ "Notes/Plan.md": "before" });
    const input = { file_path: "Notes/Plan.md", edits: [{ old_string: "before", new_string: "middle" }, { old_string: "middle", new_string: "after" }] };
    expect(await prepareNativeWriteEditPreview(app, part("MultiEdit", input))).toMatchObject({ status: "changed", newContent: "after", requestedCount: 2, appliedCount: 2 });
    input.edits[1].old_string = "missing";
    const failed = await prepareNativeWriteEditPreview(app, part("MultiEdit", input));
    expect(failed).toMatchObject({ status: "unmatched", newContent: "before", appliedCount: 0 });
    expect(failed?.diff.stats).toEqual({ additions: 0, deletions: 0 });
  });

  it("distinguishes missing files, new writes, existing writes, and genuine no-ops", async () => {
    const { app } = vault({ "Notes/Plan.md": "before" });
    expect(await prepareNativeWriteEditPreview(app, edit({ file_path: "Missing.md" }))).toMatchObject({ status: "missing", appliedCount: 0 });
    expect(await prepareNativeWriteEditPreview(app, part("Write", { file_path: "New.md", content: "new" }))).toMatchObject({ status: "changed", oldContent: "", newContent: "new", notice: "Create a new file." });
    expect(await prepareNativeWriteEditPreview(app, part("Write", { file_path: "Notes/Plan.md", content: "after" }))).toMatchObject({ status: "changed", oldContent: "before", newContent: "after" });
    expect(await prepareNativeWriteEditPreview(app, edit({ new_string: "before" }))).toMatchObject({ status: "identical", newContent: "before" });
  });

  it("does not read a same-named file from a different vault or resolve home paths as vault paths", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" });
    Object.assign(app.vault, { adapter: { getBasePath: () => "/another-vault" } });
    expect(await prepareNativeWriteEditPreview(app, edit())).toMatchObject({ status: "unavailable" });
    expect(await prepareNativeWriteEditPreview(app, edit({ file_path: "~/Plan.md" }))).toMatchObject({ status: "unavailable" });
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
  });

  it("never reads an external file or presents a read failure as a new file", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" });
    for (const file_path of ["/private/Plan.md", "../Plan.md", "/vault-copy/Plan.md"]) {
      expect(await prepareNativeWriteEditPreview(app, edit({ file_path }))).toMatchObject({ status: "unavailable" });
    }
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new Error("unreadable"));
    expect(await prepareNativeWriteEditPreview(app, part("Write", { file_path: "Notes/Plan.md", content: "after" }))).toMatchObject({ status: "unavailable", newContent: "" });
  });
});

describe("native preview rendering", () => {
  it("uses the shared diff viewer for real edits and makes unmatched edits visible", async () => {
    const { app } = vault({ "Notes/Plan.md": "first\nbefore\nlast" });
    const host = document.createElement("div");
    expect(await renderNativeToolPreview(app, host, edit())).toBe(true);
    expect(host.querySelector(".systemsculpt-diff-filename")?.textContent).toBe("Notes/Plan.md");
    expect(host.querySelector(".systemsculpt-diff-line-removed .systemsculpt-diff-line-content")?.textContent).toBe("before");
    expect(host.querySelector(".systemsculpt-diff-line-added .systemsculpt-diff-line-content")?.textContent).toBe("after");
    await renderNativeToolPreview(app, host, edit({ old_string: "missing" }));
    expect(host.querySelectorAll(".ss-native-tool-preview")).toHaveLength(1);
    expect(host.textContent).toContain("Can't apply");
    expect(host.textContent).not.toContain("No changes");
    expect(host.querySelector(".systemsculpt-diff-line-added")).toBeNull();
  });

  it("describes empty new files and final newline changes without calling them no-ops", async () => {
    const { app } = vault({ "Existing.md": "text" });
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "Empty.md", content: "" }));
    expect(host.textContent).toContain("Create a new file.");
    expect(host.textContent).not.toContain("No changes");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "New.md", content: "New note\n" }));
    expect(host.textContent).toContain("Create a new file.");
    expect(host.querySelector(".systemsculpt-diff-line-added")?.textContent).toContain("New note");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "Existing.md", content: "text\n" }));
    expect(host.textContent).toContain("Change the final line break.");
    expect(host.textContent).not.toContain("approving changes nothing");
  });

  it("renders command, description, directory, and the native approval reason as text", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const request = part("Bash", { command: 'printf "<script>"\npwd', description: "Check the folder", cwd: "/vault/Notes" }, { native: { agent: "claude", workingDirectory: "/vault", description: "This command needs your approval." } });
    await renderNativeToolPreview(app, host, request);
    expect(host.querySelector("pre code")?.textContent).toBe('printf "<script>"\npwd');
    expect(host.textContent).toContain("Check the folder");
    expect(host.textContent).toContain("FolderNotes");
    expect(host.textContent).toContain("This command needs your approval.");
    expect(host.querySelector("script")).toBeNull();
  });

  it.each([
    ["WebFetch", { url: "https://example.com", prompt: "Find opening hours" }, ["https://example.com", "Find opening hours"]],
    ["WebSearch", { query: "local opening hours" }, ["local opening hours"]],
  ])("shows the full target for %s", async (name, input, expected) => {
    const { app } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part(name, input));
    for (const value of expected) expect(host.textContent).toContain(value);
  });

  it("renders Codex per-file patches without reading any files and keeps separated hunks distinct", async () => {
    const { app, read, getAbstractFileByPath } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, codex("fileChange", { reason: "Update the notes", changes: [
      { path: "/vault/One.md", kind: { type: "update" }, diff: "--- a/One.md\n+++ b/One.md\n@@ -1 +1 @@\n-old\n+new\n@@ -100 +100 @@\n-last\n+final\n" },
      { path: "Two.md", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+hello\n" },
    ] }));
    expect(Array.from(host.querySelectorAll(".systemsculpt-diff-filename"), el => el.textContent)).toEqual(["One.md", "Two.md"]);
    expect(host.querySelectorAll(".systemsculpt-diff-hunk")).toHaveLength(3);
    expect(Array.from(host.querySelectorAll(".systemsculpt-diff-line-number-new"), el => el.textContent)).toContain("100");
    expect(host.textContent).toContain("Update the notes");
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
  });

  it("does not turn a malformed or absent Codex patch into a successful empty diff", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, codex("fileChange", { changes: [{ path: "One.md", kind: { type: "update" }, diff: "@@ -1,3 +1,3 @@\n-old\n+new" }] }));
    expect(host.textContent).toContain("A line-by-line preview is not available");
    expect(host.querySelector("pre code")?.textContent).toContain("@@ -1,3");
    expect(host.textContent).not.toContain("No changes");
  });

  it("translates current Codex permissions into plain words, retaining every requested scope", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const request = codex("permissions", { cwd: "/vault", reason: "Publish the notes", permissions: { network: { enabled: true }, fileSystem: {
      read: ["/vault/Notes"], write: ["/outside/Export"], entries: [
        { access: "read", path: { type: "path", path: "/vault/Reference" } },
        { access: "write", path: { type: "special", value: { kind: "project_roots" } } },
        { access: "deny", path: { type: "glob_pattern", pattern: "**/.env" } },
      ],
    } } }, "item/permissions/requestApproval");
    expect(nativeToolPresentation(request)?.title).toBe("Allow additional access");
    await renderNativeToolPreview(app, host, request);
    for (const expected of ["Connect to the internet", "Read Notes", "Read and change /outside/Export", "Read Reference", "Read and change project folders", "Block access to files matching **/.env", "Publish the notes", "Vault root"]) {
      expect(host.textContent).toContain(expected);
    }
    expect(host.textContent).not.toContain("fileSystem");
  });

  it("renders long native input without denying or silently clipping the request", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const content = "x".repeat(128_001) + "END";
    await renderNativeToolPreview(app, host, part("Write", { file_path: "Large.md", content }));
    expect(host.querySelector(".systemsculpt-diff-line-added .systemsculpt-diff-line-content")?.textContent).toBe(content);
  });

  it("creates native preview nodes in the pop-out document", async () => {
    const { app } = vault();
    const other = document.implementation.createHTMLDocument("pop-out");
    const host = other.createElement("div");
    await renderNativeToolPreview(app, host, part("Bash", { command: "pwd" }));
    expect(Array.from(host.querySelectorAll("*")).every(node => node.ownerDocument === other)).toBe(true);
  });
});
