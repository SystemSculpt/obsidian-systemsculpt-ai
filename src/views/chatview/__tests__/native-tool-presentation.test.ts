/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { nativeToolPresentation, renderNativeToolPreview } from "../NativeToolPresentation";
import { nativePathPrefixRewriter, nativeToolPath } from "../../../utils/nativeToolPath";
import { prepareNativeWriteEditPreview } from "../ToolCallPreview";
import { presentAgentTool, presentAgentToolDetails, presentAgentToolFailure } from "../AgentToolPresentation";
import { desktopHost } from "../../../platform/desktopOnly";

jest.mock("../../../platform/hostCapabilities", () => ({ hasHostCapability: jest.fn(() => true) }));
jest.mock("../../../platform/desktopOnly", () => ({ desktopHost: { fs: jest.fn() } }));

const realpath = jest.fn(async (path: string) => path);
beforeEach(() => {
  realpath.mockReset().mockImplementation(async (path: string) => path);
  (desktopHost.fs as jest.Mock).mockResolvedValue({ realpath });
});

function part(name = "Edit", input: unknown = {}, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return {
    id: "native-part", order: 1, kind: "tool", messageId: "message", callId: "call",
    name, input, location: "server", state: "approval-required",
    native: { agent: "claude", workingDirectory: "/vault" }, ...overrides,
  };
}
function vault(contents: Record<string, string> = {}, root = "/vault") {
  const files = new Map(Object.keys(contents).map(path => [path, new TFile({ path })]));
  const read = jest.fn(async (file: TFile) => contents[file.path]);
  const getAbstractFileByPath = jest.fn((path: string) => files.get(path) ?? null);
  const adapter = { getBasePath: () => root, getFullPath: (path: string) => path === "." ? root : `${root}/${path}` };
  return { app: { vault: { adapter, read, getAbstractFileByPath } } as unknown as App, read, getAbstractFileByPath };
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
    ["../outside.md", "/vault", "/outside.md (outside vault)", null],
    ["/vault-copy/Plan.md", "/vault", "/vault-copy/Plan.md (outside vault)", null],
    ["/vault/../private/Plan.md", "/vault", "/private/Plan.md (outside vault)", null],
    ["/vault", "/vault", "Vault root", null],
    ["C:\\Vault\\Notes\\..\\Plan.md", "C:\\Vault", "Plan.md", "Plan.md"],
    [".\\Notes\\Plan.md", "C:\\Vault", "Notes/Plan.md", "Notes/Plan.md"],
    ["D:\\Private\\Plan.md", "C:\\Vault", "D:/Private/Plan.md (outside vault)", null],
    ["~/Plan.md", "/vault", "~/Plan.md (vault location unverified)", null],
    ["Plan.md", "relative", "Plan.md (vault location unverified)", null],
    ["/Plan.md", "/", "Plan.md", "Plan.md"],
  ])("normalizes %s against %s without turning external paths into vault paths", (path, cwd, displayPath, vaultPath) => {
    expect(nativeToolPath(path, cwd)).toEqual({ displayPath, vaultPath });
  });

  it.each([
    ["/vault/Plan.md", "/vault/Notes", "/vault", undefined, "Plan.md", "Plan.md"],
    ["Plan.md", "/vault/Notes", "/vault", undefined, "Notes/Plan.md", "Notes/Plan.md"],
    ["../Plan.md", "/vault/Notes", "/vault", undefined, "Plan.md", "Plan.md"],
    ["/external/Plan.md", "/external", "/vault", undefined, "/external/Plan.md (outside vault)", null],
    ["Plan.md", "/external", "/vault", undefined, "/external/Plan.md (outside vault)", null],
    ["/external", "/external", "/vault", undefined, "/external (outside vault)", null],
    ["/tmp/vault/Plan.md", "/private/tmp/vault", "/private/tmp/vault", "/tmp/vault", "Plan.md", "Plan.md"],
    ["Plan.md", "/tmp/vault/Notes", "/private/tmp/vault", "/tmp/vault", "Notes/Plan.md", "Notes/Plan.md"],
    ["/tmp/vault-copy/Plan.md", "/private/tmp/vault", "/private/tmp/vault", "/tmp/vault", "/tmp/vault-copy/Plan.md (outside vault)", null],
    ["/tmp/vault/../Plan.md", "/private/tmp/vault", "/private/tmp/vault", "/tmp/vault", "/tmp/Plan.md (outside vault)", null],
    ["C:\\Vault\\Plan.md", "C:\\Vault\\Notes", "C:\\Vault", undefined, "Plan.md", "Plan.md"],
    ["Plan.md", "D:\\External", "C:\\Vault", undefined, "D:/External/Plan.md (outside vault)", null],
  ] as const)("separates target %s from request cwd %s and vault root %s", (path, cwd, root, alias, displayPath, vaultPath) => {
    expect(nativeToolPath(path, cwd, root, alias)).toEqual({ displayPath, vaultPath });
  });

  it.each([
    ["/Users/me/Downloads/report.md", "~/Downloads/report.md (outside vault)"],
    ["/Users/me", "/Users/me (outside vault)"],
    ["/Users/meow/Plan.md", "/Users/meow/Plan.md (outside vault)"],
    ["/Users/me/Vault/Plan.md", "Plan.md"],
  ])("shows %s relative to home only when it is outside the vault", (path, displayPath) => {
    expect(nativeToolPath(path, "/Users/me/Vault", "/Users/me/Vault", undefined, "/Users/me/").displayPath).toBe(displayPath);
  });

  it.each([
    ["File created successfully at: /Users/me/Vale Studio/Reviews/Weekly review.md", "File created successfully at: ./Reviews/Weekly review.md"],
    ["/Users/me/Vale Studio\n", ".\n"],
    ['ls "/Users/me/Vale Studio" /Users/me/Vale Studio/Daily', 'ls "." ./Daily'],
    ["/Users/me/Vale Studio/a.md:3:todo\n/Users/me/Vale Studio/b.md:9:todo", "./a.md:3:todo\n./b.md:9:todo"],
    ["/Users/me/Vale Studio 2/Plan.md and /Users/me/Vale Studio.bak", "~/Vale Studio 2/Plan.md and ~/Vale Studio.bak"],
    ["/Users/meow/Plan.md /backup/Users/me/Vale Studio/a.md file:///Users/me/x", "/Users/meow/Plan.md /backup/Users/me/Vale Studio/a.md file:///Users/me/x"],
    ['cd "/Users/me" && cat ~/.zshrc', 'cd "~" && cat ~/.zshrc'],
    // A bare directory followed by a space may begin a sibling's name ("Vale Studio 2").
    ["cd /Users/me/Vale Studio && ls", "cd ~/Vale Studio && ls"],
  ])("rewrites whole directory prefixes in %j", (text, expected) => {
    const rewrite = nativePathPrefixRewriter([["/Users/me/Vale Studio/", "."], ["/Users/me", "~"]]);
    expect(rewrite(text)).toBe(expected);
  });

  it("rewrites Windows prefixes with either separator and drive letter case", () => {
    const rewrite = nativePathPrefixRewriter([["C:\\Users\\me\\Vault\\Notes", "."], ["C:\\Users\\me\\Vault", ".."], ["C:\\Users\\me", "~"]]);
    expect(rewrite("c:\\Users\\me\\Vault\\Notes\\Plan.md, C:/Users/me/Vault/Other.md, C:\\Users\\me\\AppData"))
      .toBe(".\\Plan.md, ../Other.md, ~\\AppData");
  });

  it("matches directory names literally", () => {
    const rewrite = nativePathPrefixRewriter([["/Users/me/Notes (2026)+[a].*", "."]]);
    expect(rewrite("/Users/me/Notes (2026)+[a].*/Plan.md /Users/me/Notes (2026)++[a].*/Plan.md")).toBe("./Plan.md /Users/me/Notes (2026)++[a].*/Plan.md");
  });

  it("never rewrites a filesystem root or a relative directory", () => {
    const rewrite = nativePathPrefixRewriter([["/", "."], ["C:\\", "."], ["//", "."], ["Vault", "."], ["", "."]]);
    expect(rewrite("/Users/me/Vault/Plan.md C:\\Plan.md Vault/Plan.md")).toBe("/Users/me/Vault/Plan.md C:\\Plan.md Vault/Plan.md");
  });
});

describe("portable saved native activity", () => {
  it("does not resolve a command's saved cwd against itself twice", () => {
    const saved = part("Bash", { command: "pwd" }, {
      native: { agent: "claude", workingDirectory: "Notes", vaultRoot: "." },
    });
    expect(nativeToolPresentation(saved)?.meta).toBe("in Notes");
  });

  it("keeps vault-relative labels and links without treating saved roots as file-read authority", async () => {
    const saved = part("Edit", { file_path: "Plan.md", old_string: "before", new_string: "after" }, {
      native: { agent: "claude", workingDirectory: "Notes", vaultRoot: "." }, state: "succeeded",
    });
    expect(nativeToolPresentation(saved)).toMatchObject({ title: "Edit Plan", meta: "Notes", targetPath: "Notes/Plan.md" });
    const { app, read } = vault({ "Notes/Plan.md": "before" });
    const preview = await prepareNativeWriteEditPreview(app, saved);
    expect(preview?.status).toBe("unavailable");
    expect(read).not.toHaveBeenCalled();
    expect(nativeToolPath("../../outside.md", "Notes", ".").vaultPath).toBeNull();
    expect(nativeToolPath("/private/outside.md", "Notes", ".").vaultPath).toBeNull();
  });
});

describe("native presentation metadata", () => {
  it.each([
    ["Edit", { file_path: "/vault/Notes/Plan.md" }, "Edit Plan.md", "Edited Plan.md", "file-pen-line"],
    ["MultiEdit", { file_path: "Notes/Plan.md" }, "Edit Plan.md", "Edited Plan.md", "file-pen-line"],
    ["Write", { file_path: "New.md" }, "Create New.md", "Created New.md", "file-plus-2"],
    ["Bash", { command: "git status", description: "Check changed files" }, "Run git status", "Ran git status", "terminal"],
    ["WebFetch", { url: "https://example.com/guide" }, "Read example.com", "Read example.com", "globe-2"],
    ["WebSearch", { query: "gardening advice" }, "Search the web for “gardening advice”", "Searched the web for “gardening advice”", "globe-2"],
  ])("presents %s using a readable verb and target", (name, input, title, completedTitle, icon) => {
    expect(nativeToolPresentation(part(name, input))).toMatchObject({ title, completedTitle, icon, agentName: "Claude Code" });
  });

  it("counts the results a web search lists, as a SystemSculpt search counts its own", () => {
    const output = { data: 'Web search results for query: "frost"\n\nLinks: [{"title":"Frost dates","url":"https://example.org/a"},{"title":"Calendar","url":"https://example.org/b"}]\n\nEarly April.' };
    expect(presentAgentTool(part("WebSearch", { query: "frost" }, { state: "succeeded", output })).meta).toBe("2 results");
    expect(presentAgentTool(part("WebSearch", { query: "frost" }, { state: "succeeded", output: { data: "No links." } })).meta).toBeUndefined();
  });

  it("counts every edit and write row from the change its card draws", () => {
    const done = { state: "succeeded" as const };
    expect(presentAgentTool(part("Edit", { file_path: "/vault/Notes/Launch plan.md", old_string: "# Launch", new_string: "# Launch\n\nPlant basil in week 2." }, done)).meta).toBe("+2");
    expect(presentAgentTool(part("MultiEdit", { file_path: "/vault/Plan.md", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "c" }] }, done)).meta).toBe("+1 \u22122");
    // A new note of four lines reads "+4", as its card draws four added lines.
    expect(presentAgentTool(part("Write", { file_path: "/vault/Basil.md", content: "# Basil\n\nSow after the last frost.\nPinch the tips weekly.\n" }, done)).meta).toBe("+4");
    expect(presentAgentTool({ ...edit(), state: "running", approvalDecision: "approved" }).meta).toBe("+1 \u22121");
    // A pending approval shows its own count; a change that didn't go ahead counts nothing.
    expect(presentAgentTool(edit()).meta).toBeUndefined();
    expect(presentAgentTool({ ...edit(), state: "failed" }).meta).toBeUndefined();
    expect(presentAgentTool({ ...edit(), state: "denied", approvalDecision: "denied" }).meta).toBeUndefined();
  });

  it("names a Codex search's first query and counts each query as one search", () => {
    const search = { ...codex("webSearch", { type: "webSearch", query: "tomato soil temperature", action: { type: "search", query: "tomato soil temperature", queries: ["tomato soil temperature", "tomato night temperature"] } }), state: "succeeded" as const };
    expect(presentAgentTool(search)).toMatchObject({ label: "Searched the web for \u201ctomato soil temperature\u201d and 1\u00a0more", groupCount: 2, target: { text: "\u201ctomato soil temperature\u201d" } });
    expect(presentAgentTool(search).meta).toBeUndefined();
    const one = { ...codex("webSearch", { type: "webSearch", query: "frost", action: { type: "search", query: "frost" } }), state: "succeeded" as const };
    expect(presentAgentTool(one)).toMatchObject({ label: "Searched the web for \u201cfrost\u201d", groupCount: 1 });
  });

  it("names unknown native tools without applying the hosted provider privacy rule", () => {
    expect(nativeToolPresentation(part("UnknownNativeAction")))
      .toMatchObject({ title: "Use UnknownNativeAction", completedTitle: "Used UnknownNativeAction", icon: "wrench" });
    expect(nativeToolPresentation(codex("future_item", {})))
      .toMatchObject({ title: "Use future_item", completedTitle: "Used future_item" });
  });

  it("separates the basename, folder, safe link and a meaningful reason", () => {
    expect(nativeToolPresentation(edit({ description: "Edit Plan.md" }))).toMatchObject({
      title: "Edit Plan.md", meta: "Notes", targetPath: "Notes/Plan.md", approvalTitle: "edit Plan.md",
    });
    expect(nativeToolPresentation(edit({ description: "Add the launch checklist" }))?.meta).toBe("Notes · Add the launch checklist");
    expect(nativeToolPresentation(edit({ file_path: "/outside/Plan.md" }))?.targetPath).toBeUndefined();
  });

  it("keeps a nested request cwd relative to the vault root in titles, meta, links and details", async () => {
    const nested = { agent: "claude" as const, workingDirectory: "/vault/Notes", vaultRoot: "/vault", vaultRootAlias: "/alias/vault" };
    expect(nativeToolPresentation(part("Edit", { file_path: "Plan.md", old_string: "a", new_string: "b" }, { native: nested }))).toMatchObject({
      title: "Edit Plan.md", meta: "Notes", targetPath: "Notes/Plan.md",
    });
    expect(nativeToolPresentation(part("Edit", { file_path: "/alias/vault/Notes/Plan.md" }, { native: nested }))?.targetPath).toBe("Notes/Plan.md");
    expect(nativeToolPresentation(part("Read", { file_path: "/vault/Plan.md" }, { native: nested }))?.targetPath).toBe("Plan.md");
    // The row names and links the note by its vault path; its card says only how much was read, never the note again.
    const read = part("Read", { file_path: "Daily/Today.md" }, { native: nested, state: "succeeded", output: { data: "today" } });
    expect(nativeToolPresentation(read)?.targetPath).toBe("Notes/Daily/Today.md");
    const { app } = vault({ "Notes/Daily/Today.md": "today" });
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, read);
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector(".ss-tool-caption")?.textContent).toBe("1 line");
    // A failed read's output is its error, shown by the row's error line: never counted as lines.
    const failed = document.createElement("div");
    await renderNativeToolPreview(app, failed, { ...read, state: "failed", output: { data: "File does not exist." } });
    expect(failed.querySelector(".ss-tool-caption")).toBeNull();
  });

  it("uses progressive verbs and only reports explicit native auto blocks", () => {
    const request = part("Bash", { command: "npm test", exitCode: 0 });
    // A clean exit says nothing a check doesn't; a failed one shows its status, never "Couldn't run".
    expect(presentAgentTool({ ...request, state: "succeeded" }).meta).toBeUndefined();
    expect(presentAgentTool({ ...request, state: "succeeded" }).label).toBe("Ran npm test");
    const missing = part("Bash", { command: "ls missing-folder", description: "List the folder" }, {
      state: "failed", output: { data: "Exit code 1\nls: missing-folder: No such file or directory" }, error: { code: "NATIVE_TOOL_FAILED", message: "failed" },
    });
    expect(presentAgentTool(missing)).toMatchObject({ label: "Ran ls missing-folder", meta: "exit 1", exitCode: 1, summary: null, target: { text: "ls missing-folder", command: true } });
    expect(presentAgentToolFailure(missing)).toBe("");
    // The status may come last; a successful command's own text is never read as one.
    expect(presentAgentTool({ ...missing, output: { data: "ls: missing-folder: No such file or directory\nExit code 2" } }).meta)
      .toBe("exit 2");
    expect(presentAgentTool({ ...missing, state: "succeeded", error: undefined, output: { data: "Exit code 3" } }).meta)
      .toBeUndefined();
    expect(presentAgentTool({ ...request, state: "failed", error: { code: "AUTO_BLOCKED", message: "blocked" } }))
      .toMatchObject({ icon: "shield-x", label: "Run npm test · Blocked by Claude Code" });
    expect(presentAgentTool({ ...request, state: "failed", error: { code: "FAILED", message: "blocked" } }).label).toBe("Couldn't run npm test");
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
    expect(presentAgentTool(pending)).toMatchObject({ label: "Edit Plan.md", displayState: "approval-required", actionIcon: "file-pen-line" });
    expect(presentAgentTool({ ...pending, state: "denied", approvalDecision: "denied" }))
      .toMatchObject({ label: "Edit Plan", displayState: "denied", icon: "ban" });
    // An approval names the file it asks about; once decided, the row names the note as Obsidian does.
    expect(presentAgentTool({ ...pending, state: "running", approvalDecision: "approved" }).label).toBe("Editing Plan");
    expect(presentAgentTool({ ...pending, state: "succeeded", approvalDecision: "approved" }).label).toBe("Edited Plan");
    expect(presentAgentTool({ ...pending, state: "cancelled", approvalDecision: "withdrawn" }).label).toBe("Edit Plan");
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
    expect(presentAgentTool(hosted)).toMatchObject({ label: "Creating Note", summary: null });
    const server = { ...hosted, location: "server" as const, name: "future_action", state: "approval-required" as const };
    expect(presentAgentTool(server)).toMatchObject({ label: "Running SystemSculpt action", displayState: "running" });
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

  it.each(["/private/tmp/t136-qa/vault/Notes/Plan.md", "Notes/Plan.md"])("previews %s against the canonical current vault root", async file_path => {
    const root = "/tmp/t136-qa/vault", canonical = "/private/tmp/t136-qa/vault";
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" }, root);
    realpath.mockResolvedValue(canonical);
    const request = part("Edit", { file_path, old_string: "before", new_string: "after" }, {
      native: { agent: "claude", workingDirectory: canonical },
    });

    expect(nativeToolPresentation(request)?.title).toBe("Edit Plan.md");
    const preview = await prepareNativeWriteEditPreview(app, request);
    expect(preview).toMatchObject({ path: "Notes/Plan.md", status: "changed", oldContent: "before", newContent: "after" });
    expect(preview?.diff.stats).toEqual({ additions: 1, deletions: 1 });
    expect(realpath.mock.calls).toEqual([[root]]);
    expect(getAbstractFileByPath.mock.calls).toEqual([["Notes/Plan.md"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["/tmp/t136-qa/vault/Notes/Plan.md", "/private/tmp/t136-qa/vault/Notes/Plan.md", "Plan.md"])("uses host-provided root aliases for %s without resolving the requested file", async file_path => {
    const root = "/tmp/t136-qa/vault", canonical = "/private/tmp/t136-qa/vault";
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" }, root);
    realpath.mockResolvedValue(canonical);
    const request = part("Edit", { file_path, old_string: "before", new_string: "after" }, {
      native: { agent: "claude", workingDirectory: `${canonical}/Notes`, vaultRoot: canonical, vaultRootAlias: root },
    });
    expect(nativeToolPresentation(request)).toMatchObject({ title: "Edit Plan.md", meta: "Notes", targetPath: "Notes/Plan.md" });
    expect(await prepareNativeWriteEditPreview(app, request)).toMatchObject({ path: "Notes/Plan.md", status: "changed", oldContent: "before", newContent: "after" });
    expect(realpath.mock.calls).toEqual([[root]]);
    expect(getAbstractFileByPath.mock.calls).toEqual([["Notes/Plan.md"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not use restored aliases as authority to read a current vault file", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" });
    const request = edit({ file_path: "/external/Notes/Plan.md" });
    expect(await prepareNativeWriteEditPreview(app, {
      ...request, native: { agent: "claude", workingDirectory: "/vault", vaultRoot: "/vault", vaultRootAlias: "/external" },
    })).toMatchObject({ status: "unavailable" });
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it.each(["/restored/vault", "/private/tmp/t136-qa"])("denies restored workingDirectory %s even with a same-named current vault file", async workingDirectory => {
    const root = "/tmp/t136-qa/vault", canonical = "/private/tmp/t136-qa/vault";
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" }, root);
    realpath.mockResolvedValue(canonical);
    for (const file_path of ["Notes/Plan.md", `${workingDirectory}/Notes/Plan.md`, `${canonical}/Notes/Plan.md`]) {
      const request = part("Edit", { file_path, old_string: "before", new_string: "after" }, {
        native: { agent: "claude", workingDirectory },
      });
      expect(await prepareNativeWriteEditPreview(app, request)).toMatchObject({ status: "unavailable", oldContent: "", newContent: "" });
    }
    expect(realpath).toHaveBeenCalled();
    expect(realpath.mock.calls.every(([path]) => path === root)).toBe(true);
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not trust restored root metadata when the current root cannot be established", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "before" }, "/tmp/t136-qa/vault");
    const request = part("Edit", { file_path: "Notes/Plan.md", old_string: "before", new_string: "after" }, {
      native: { agent: "claude", workingDirectory: "/private/tmp/t136-qa/vault" },
    });
    realpath.mockRejectedValueOnce(new Error("Root unavailable"));
    expect(await prepareNativeWriteEditPreview(app, request)).toMatchObject({ status: "unavailable" });
    Object.assign(app.vault, { adapter: {} });
    expect(await prepareNativeWriteEditPreview(app, request)).toMatchObject({ status: "unavailable" });
    expect(realpath.mock.calls).toEqual([["/tmp/t136-qa/vault"]]);
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
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
    // A new note's lines are its diff; only an empty new note needs words.
    expect(await prepareNativeWriteEditPreview(app, part("Write", { file_path: "New.md", content: "new" }))).toMatchObject({ status: "changed", oldContent: "", newContent: "new", isNewFile: true, notice: undefined });
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
    expect(host.querySelector(".systemsculpt-diff-filename")).toBeNull();
    expect(host.dataset.changeSize).toBe("+1 −1");
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
    expect(host.textContent).not.toContain("Create a new file.");
    expect(host.querySelector(".systemsculpt-diff-line-added")?.textContent).toContain("New note");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "Existing.md", content: "text\n" }));
    expect(host.textContent).toContain("Change the final line break.");
    expect(host.textContent).not.toContain("approving changes nothing");
  });

  it("renders the command as text and keeps its reason and directory in metadata", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const request = part("Bash", { command: 'printf "<script>"\npwd', description: "Check the folder", cwd: "/vault/Notes" }, { native: { agent: "claude", workingDirectory: "/vault", description: "This command needs your approval." } });
    await renderNativeToolPreview(app, host, request);
    expect(host.querySelector("pre code")?.textContent).toBe('$ printf "<script>"\npwd');
    expect(nativeToolPresentation(request)?.meta).toBe("in Notes · Check the folder");
    expect(host.textContent).not.toContain("Check the folder");
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
    // Each file is named once, by its summary; the diff box under it has no second header or gutter.
    expect(Array.from(host.querySelectorAll("details.systemsculpt-inline-diff__file > summary"), el => el.textContent)).toEqual(["Edit One.md · +2 −2", "Create Two.md · +1"]);
    expect(host.querySelector(".systemsculpt-diff-filename")).toBeNull();
    expect(host.querySelectorAll(".systemsculpt-diff-hunk")).toHaveLength(3);
    expect(host.querySelectorAll(".systemsculpt-diff-hunk-separated")).toHaveLength(1);
    expect(host.querySelector(".systemsculpt-diff-line-number")).toBeNull();
    expect(host.textContent).not.toContain("Update the notes");
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
  });

  it("uses the vault root, not the request cwd, for Codex file targets and external destinations", async () => {
    const { app, read, getAbstractFileByPath } = vault();
    const host = document.createElement("div");
    const request = part("fileChange", { changes: [{ path: "/vault/Plan.md", kind: { type: "update", move_path: "/external/Plan.md" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }] }, {
      native: { agent: "codex", workingDirectory: "/external", vaultRoot: "/vault", requestMethod: "item/fileChange/requestApproval" },
    });
    expect(nativeToolPresentation(request)?.title).toBe("Move and edit Plan.md → /external/Plan.md (outside vault)");
    await renderNativeToolPreview(app, host, request);
    // A one-file card names the file and destination once, in its title.
    expect(host.querySelector(".systemsculpt-inline-diff__summary")).toBeNull();
    expect(host.querySelector(".systemsculpt-diff-filename")).toBeNull();
    expect(host.querySelector(".systemsculpt-diff-line-added")?.textContent).toContain("new");
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();

    await renderNativeToolPreview(app, host, { ...request, name: "permissions", input: { cwd: "/external", permissions: { fileSystem: { write: ["/external", "/vault/Notes"] } } },
      native: { ...request.native!, requestMethod: "item/permissions/requestApproval" } });
    expect(nativeToolPresentation({ ...request, name: "permissions", input: { cwd: "/external" },
      native: { ...request.native!, requestMethod: "item/permissions/requestApproval" } })?.meta).toBe("in /external (outside vault)");
    expect(host.textContent).toContain("Write outside this vault: /external");
    expect(host.textContent).not.toContain("Write outside this vault: /external (outside vault)");
    expect(host.textContent).toContain("Read and change Notes");
    expect(host.textContent).not.toContain("Vault root");
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
    expect(nativeToolPresentation(request)?.meta).toBe("in vault · Publish the notes");
    for (const expected of ["Network access", "Read Notes", "Write outside this vault: /outside/Export", "Read Reference", "Read and change project folders", "Block access to files matching **/.env"]) {
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

  it("discloses all lines of a new file after the twelve-line approval preview", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "New.md", content: Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") }));
    // The title says "create" and every line is "+": no "New file" chip says it again.
    expect(host.querySelector(".systemsculpt-inline-diff__new-file")).toBeNull();
    expect(host.querySelector(".systemsculpt-diff-header")).toBeNull();
    expect(host.querySelectorAll(".systemsculpt-diff-line-added")).toHaveLength(12);
    host.querySelector<HTMLButtonElement>('[data-testid="chat.diff.show-all"]')!.click();
    expect(host.querySelectorAll(".systemsculpt-diff-line-added")).toHaveLength(30);
  });

  it("shows the last twenty command output lines with access to the complete output", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const output = Array.from({ length: 25 }, (_, index) => `output ${index}`).join("\n");
    await renderNativeToolPreview(app, host, part("Bash", { command: "npm test" }, { state: "succeeded", output: { data: output } }));
    const code = host.querySelector(".ss-tool-terminal-output")!;
    expect(code.textContent?.split("\n")).toHaveLength(20);
    expect(code.textContent).toMatch(/^output 5\n/u);
    host.querySelector<HTMLButtonElement>('[data-testid="chat.tool.show-output"]')!.click();
    expect(code.textContent).toBe(output);
  });

  it("keeps the full plan available after its initial sixteen-line presentation", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    const plan = Array.from({ length: 20 }, (_, index) => `Step ${index}`).join("\n");
    await renderNativeToolPreview(app, host, part("ExitPlanMode", { plan }));
    expect(host.querySelector(".ss-native-plan-preview")?.classList.contains("is-collapsed")).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-testid="chat.approval.show-plan"]')!.click();
    expect(host.querySelector(".ss-native-plan-preview")?.classList.contains("is-collapsed")).toBe(false);
    expect(host.textContent).toBe(plan);
  });

  it("drops a first heading that only says Plan, which the card's title already says", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part("ExitPlanMode", { plan: "## Plan\n\n1. Read Garden\n2. Add basil" }));
    expect(host.querySelector(".ss-native-plan-preview")?.textContent).toBe("1. Read Garden\n2. Add basil");
    await renderNativeToolPreview(app, host, part("ExitPlanMode", { plan: "# Basil plan\n\n1. Read Garden" }));
    expect(host.querySelector(".ss-native-plan-preview")?.textContent).toBe("# Basil plan\n\n1. Read Garden");
  });

  it("does not mislabel a vault write grant as outside the vault", async () => {
    const { app } = vault();
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, codex("permissions", { permissions: { fileSystem: { write: ["/vault/Notes"] } } }));
    expect(host.textContent).toContain("Read and change Notes");
    expect(host.textContent).not.toContain("outside this vault");
  });

  it.each(["succeeded", "failed", "denied", "cancelled", "running"] as const)("shows a recorded Edit request in %s without reading today's file or inventing line positions", async state => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "later content" });
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, { ...edit(), state });
    // Only the change itself: no caveat about how it is drawn.
    expect(host.textContent).toBe("−before+after");
    expect(host.querySelector(".systemsculpt-diff-line-removed .systemsculpt-diff-line-content")?.textContent).toBe("before");
    expect(host.querySelector(".systemsculpt-diff-line-added .systemsculpt-diff-line-content")?.textContent).toBe("after");
    expect(host.querySelector(".systemsculpt-diff-line-number")).toBeNull();
    expect(host.querySelector(".systemsculpt-diff-hunk-header")).toBeNull();
    expect(host.textContent).not.toContain("later content");
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });

  it("keeps recorded MultiEdit snippets separate, including empty replacements", async () => {
    const { app, read } = vault({ "Notes/Plan.md": "after" });
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part("MultiEdit", { file_path: "Notes/Plan.md", edits: [
      { old_string: "before", new_string: "middle" },
      { old_string: "middle", new_string: "" },
    ] }, { state: "succeeded" }));
    expect(Array.from(host.querySelectorAll(".systemsculpt-diff-line-removed .systemsculpt-diff-line-content"), node => node.textContent)).toEqual(["before", "middle"]);
    expect(Array.from(host.querySelectorAll(".ss-tool-edit > .ss-tool-caption"), node => node.textContent)).toEqual(["Edit 1", "Edit 2"]);
    expect(host.querySelector(".systemsculpt-diff-hunk-header")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("shows completed Write content rather than diffing it against an invented empty original", async () => {
    const { app, read, getAbstractFileByPath } = vault({ "Notes/Plan.md": "later content" });
    const host = document.createElement("div");
    await renderNativeToolPreview(app, host, part("Write", { file_path: "Notes/Plan.md", content: "written content" }, { state: "succeeded" }));
    expect(host.querySelector("pre.ss-tool-file-text code")?.textContent).toBe("written content");
    // What the call wrote reads at full strength, not as a found line.
    expect(host.querySelector("pre.ss-tool-file-text")?.classList.contains("is-written")).toBe(true);
    expect(host.textContent).toBe("written content");
    expect(host.querySelector(".systemsculpt-diff-viewer")).toBeNull();
    expect(host.textContent).not.toContain("later content");
    expect(read).not.toHaveBeenCalled();
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
  });

  it.each([
    part("AskUserQuestion", { questions: [{ question: "Enter a token", isSecret: true }] }),
    codex("requestUserInput", { questions: [{ id: "token", question: "Enter a token", isSecret: true }] }),
    codex("native_request", {}, "item/tool/requestUserInput"),
  ])("never renders output answers from a native question request", async request => {
    const { app } = vault();
    const host = document.createElement("div");
    for (const data of ["secret-answer-sentinel", { output: "secret-answer-sentinel" }, [{ text: "secret-answer-sentinel" }]]) {
      await renderNativeToolPreview(app, host, { ...request, state: "succeeded", output: { data } });
      expect(host.textContent).not.toContain("secret-answer-sentinel");
      expect(host.querySelector(".ss-native-tool-output")).toBeNull();
    }
  });

  it("creates native preview nodes in the pop-out document", async () => {
    const { app } = vault();
    const other = document.implementation.createHTMLDocument("pop-out");
    const host = other.createElement("div");
    await renderNativeToolPreview(app, host, part("Bash", { command: "pwd" }));
    expect(Array.from(host.querySelectorAll("*")).every(node => node.ownerDocument === other)).toBe(true);
  });

  it("names the workflow of a completed Codex dynamic call from its own arguments", () => {
    const item = { type: "dynamicToolCall", id: "call", tool: "studio_list_outputs", arguments: { path: "SystemSculpt/Studio/Garden cards.systemsculpt" }, status: "completed" };
    const presented = nativeToolPresentation(codex("studio_list_outputs", item, undefined));
    expect(presented?.completedTitle).toBe("Listed outputs of Garden cards workflow");
  });
});
