/** @jest-environment jsdom */
import { TFile, type App } from "obsidian";
import type { AgentToolPart } from "../../../chat/ChatConversation";
import { renderHostedToolPreview } from "../HostedToolPreview";

function part(name: string, input: unknown = {}, data?: unknown, overrides: Partial<AgentToolPart> = {}): AgentToolPart {
  return {
    id: "hosted-tool", order: 1, kind: "tool", messageId: "message", callId: "call",
    name, input, location: "vault", state: "succeeded",
    ...(data === undefined ? {} : { output: { data } }), ...overrides,
  };
}
function setup() {
  const read = jest.fn();
  const getAbstractFileByPath = jest.fn();
  const openFile = jest.fn();
  const app = { vault: { read, getAbstractFileByPath, adapter: { read } }, workspace: { getLeaf: () => ({ openFile }) } } as unknown as App;
  const host = document.createElement("div");
  const onOpenPath = jest.fn();
  const render = (tool: AgentToolPart) => renderHostedToolPreview(app, host, tool, undefined, { onOpenPath });
  return { app, host, read, getAbstractFileByPath, openFile, onOpenPath, render };
}

it("renders recorded read paths and partial/error states, not note contents", () => {
  const { host, render, onOpenPath } = setup();
  expect(render(part("read", { paths: ["Requested.md"] }, { files: [
    { path: "Notes/Read.md", content: "PRIVATE NOTE CONTENT", metadata: { hasMore: true } },
    { path: "Missing.md", content: "", error: "File not found" },
  ] }))).toBe(true);
  expect(host.textContent).toContain("Notes/Read.md");
  expect(host.textContent).toContain("Partial file read");
  expect(host.textContent).toContain("File not found");
  expect(host.textContent).not.toContain("PRIVATE NOTE CONTENT");
  expect(host.textContent).not.toContain("Requested.md");
  host.querySelector<HTMLAnchorElement>("a")!.click();
  expect(onOpenPath).toHaveBeenCalledWith("Notes/Read.md");
});

it.each([
  "/private/Note.md", "C:\\Private\\Note.md", "../Note.md", "Notes/../Note.md",
  "file:///private/Note.md", "https://example.com", "~/Note.md", "Note.md\u0000",
])("keeps ambiguous path %s as literal non-clickable text", path => {
  const { host, render, onOpenPath } = setup();
  render(part("read", { paths: [path] }));
  expect(host.querySelector("a")).toBeNull();
  expect(onOpenPath).not.toHaveBeenCalled();
});

it.each(["Notes/#Ideas.md", "Notes/100%.md", "Notes/[Draft].md", "~Ideas.md", "%2e%2e/Note.md"])("preserves literal vault filename %s", path => {
  const { host, render, onOpenPath } = setup();
  render(part("read", { paths: [path] }));
  host.querySelector<HTMLAnchorElement>("a")!.click();
  expect(onOpenPath).toHaveBeenCalledWith(path);
});

it("normalizes relative separators and opens an exact file without parsing link syntax", () => {
  const { app, host, openFile, getAbstractFileByPath } = setup();
  const file = Object.assign(Object.create(TFile.prototype), { path: "Notes/#Read.md" });
  getAbstractFileByPath.mockReturnValue(file);
  renderHostedToolPreview(app, host, part("read", { paths: ["Notes\\#Read.md"] }));
  host.querySelector<HTMLAnchorElement>("a")!.click();
  expect(getAbstractFileByPath).toHaveBeenCalledWith("Notes/#Read.md");
  expect(openFile).toHaveBeenCalledWith(file);
});

it("discloses the first 50 returned directory entries without claiming to fetch another page", () => {
  const { host, render } = setup();
  const files = Array.from({ length: 55 }, (_, index) => ({ path: `Notes/${index}.md`, name: `${index}.md` }));
  render(part("list_items", {}, { results: [{ path: "Notes", files, directories: [], offset: 50, totalItems: 120, nextOffset: 105 }] }));
  expect(host.querySelectorAll("li")).toHaveLength(50);
  expect(host.textContent).toContain("55 returned of 120 items");
  expect(host.textContent).toContain("Starting at item 51");
  expect(host.textContent).toContain("another tool result");
  const all = host.querySelector<HTMLButtonElement>('[data-testid="chat.tool.show-items"]')!;
  expect(all.textContent).toBe("Show all 55 items");
  all.click();
  expect(host.querySelectorAll("li")).toHaveLength(55);
  expect(host.textContent).toContain("Notes/54.md");
  expect(host.querySelector('[data-testid="chat.tool.show-items"]')).toBeNull();
});

it("shows folder entries and safe notices without exposing unknown result metadata", () => {
  const { host, render } = setup();
  render(part("list_items", {}, { results: [{
    path: ".", directories: [{ path: "Notes", name: "Notes", itemCount: 2 }], files: [],
    totalItems: 1, offset: 0, nextOffset: null, notice: "Some files are excluded.", privateField: "SECRET",
  }] }));
  expect(host.textContent).toContain("Notes · Folder");
  expect(host.textContent).toContain("Some files are excluded.");
  expect(host.textContent).not.toContain("SECRET");
  expect(host.textContent).not.toContain("another tool result");
});

it("uses actual find results and search snippets, leaving scoring and pagination tokens private", () => {
  const { host, render } = setup();
  render(part("find", { patterns: ["plan"] }, { results: [{ path: "Notes/Plan.md", score: 99, reasoning: "PRIVATE SCORE" }], totalFound: 1 }));
  expect(host.textContent).toContain("Notes/Plan.md");
  expect(host.textContent).toContain("1 file found · 1 returned");
  expect(host.textContent).not.toContain("PRIVATE SCORE");
  render(part("search", {}, {
    results: [{ path: "Notes/Plan.md", reasoning: "PRIVATE SCORE" }], totalFound: 1,
    snippets: ["Notes/Plan.md:7  launch checklist\nnext line", "unknown.md:4  unassociated snippet"],
    page: { omitted_matches: 3, next_cursor: "PRIVATE CURSOR" }, metaInfo: [{ file: "_performance", content: "PRIVATE METADATA" }],
  }));
  expect(host.textContent).toContain("Line 7");
  expect(host.querySelector("code")!.textContent).toBe("launch checklist\nnext line");
  expect(host.textContent).toContain("unknown.md:4  unassociated snippet");
  expect(host.querySelector('a[data-href="unknown.md"]')).toBeNull();
  expect(host.textContent).toContain("3 more matches were not included");
  for (const secret of ["PRIVATE SCORE", "PRIVATE CURSOR", "PRIVATE METADATA"]) expect(host.textContent).not.toContain(secret);
});

it("shows all requested write content as literal text, not a fabricated original diff", () => {
  const { host, render, read, getAbstractFileByPath } = setup();
  const content = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") + "\n<img src=x onerror=alert(1)>";
  render(part("write", { path: "Requested.md", content, ifExists: "skip" }, { path: "Actual.md", success: true, notice: "Used a portable name." }));
  expect(host.textContent).toContain("Actual.md");
  expect(host.textContent).toContain("not a before-and-after diff");
  expect(host.textContent).toContain("does not confirm that this content was written");
  expect(host.textContent).toContain("Used a portable name.");
  expect(host.querySelector("code")!.textContent!.split("\n")).toHaveLength(20);
  host.querySelector<HTMLButtonElement>('[data-testid="chat.tool.show-output"]')!.click();
  expect(host.querySelector("code")!.textContent).toBe(content);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector(".systemsculpt-diff-viewer")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(getAbstractFileByPath).not.toHaveBeenCalled();
});

it.each(["succeeded", "failed", "denied", "cancelled", "outcome-unknown"] as const)("renders requested edit snippets after %s without reading today's file or inventing positions", state => {
  const { host, render, read, getAbstractFileByPath } = setup();
  render(part("edit", { path: "Notes/Plan.md", edits: [{ oldText: "before", newText: "after" }] }, {
    path: "Notes/Plan.md", success: false, appliedCount: 0, requestedCount: 1,
    skipped: [{ index: 0, reason: "Original text not found" }], diff: "--- file\n+++ file\n- private original receipt",
  }, { state }));
  expect(host.textContent).toContain("Requested text changes only");
  expect(host.textContent).toContain("Original file line numbers are unavailable");
  expect(host.textContent).toContain("0 of 1 requested edits applied");
  expect(host.textContent).toContain("Skipped edit 1: Original text not found");
  expect(host.querySelector(".systemsculpt-diff-line-removed")!.textContent).toContain("before");
  expect(host.querySelector(".systemsculpt-diff-line-added")!.textContent).toContain("after");
  expect(host.textContent).not.toContain("private original receipt");
  expect(host.querySelector(".systemsculpt-diff-line-number")).toBeNull();
  expect(host.querySelector(".systemsculpt-diff-hunk-header")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(getAbstractFileByPath).not.toHaveBeenCalled();
});

it("renders multi-edit deletions and regex/loose semantics honestly", () => {
  const { host, render } = setup();
  render(part("multi_edit", { files: [
    { path: "A.md", edits: [{ oldText: "remove", newText: "" }] },
    { path: "B.md", edits: [{ oldText: "a+", newText: "$1", isRegex: true, mode: "loose", occurrence: "all" }] },
  ] }, { results: [
    { path: "A.md", success: true, appliedCount: 1, requestedCount: 1, skipped: [] },
    { path: "B.md", success: false, appliedCount: 0, requestedCount: 1, error: "No match", skipped: [] },
  ] }));
  expect(host.textContent).toContain("A.md");
  expect(host.textContent).toContain("B.md");
  expect(host.textContent).toContain("1 of 1 requested edits applied");
  expect(host.textContent).toContain("0 of 1 requested edits applied");
  expect(host.textContent).toContain("Regular expression and replacement");
  expect(host.textContent).toContain("Loose matching");
  expect(host.textContent).toContain("Requested occurrence: all");
  expect(host.querySelector(".systemsculpt-diff-line-removed")!.textContent).toContain("remove");
});

it("keeps successful move destinations usable and trashed entries non-clickable", () => {
  const { host, render } = setup();
  render(part("move", {}, { results: [
    { source: "Old.md", destination: "New.md", success: true },
    { source: "Stay.md", destination: "Missing.md", success: false, error: "Move failed" },
  ] }));
  expect(host.textContent).toContain("Old.md → New.md · Moved");
  expect(host.textContent).toContain("Stay.md → Missing.md · Failed");
  expect(host.querySelector('a[data-href="Old.md"]')).toBeNull();
  expect(host.querySelector('a[data-href="New.md"]')).not.toBeNull();
  expect(host.querySelector('a[data-href="Stay.md"]')).not.toBeNull();
  expect(host.querySelector('a[data-href="Missing.md"]')).toBeNull();
  render(part("trash", {}, { results: [{ path: "Gone.md", success: true }, { path: "Stay.md", success: false }] }));
  expect(host.textContent).toContain("Gone.md · In trash");
  expect(host.textContent).toContain("Stay.md · Failed");
  expect(host.querySelector("a")).toBeNull();
});

it("does not infer mutation success from missing or empty per-item results", () => {
  const { host, render } = setup();
  render(part("create_folders", { paths: ["Notes"] }, undefined, { state: "approval-required" }));
  expect(host.textContent).toContain("Notes · Requested");
  render(part("create_folders", { paths: ["Notes"] }, { results: [] }));
  expect(host.textContent).toContain("No item results were recorded");
  expect(host.textContent).not.toContain("Folder ready");
  render(part("create_folders", {}, { results: [{ path: "Notes", success: true }] }));
  expect(host.textContent).toContain("Notes · Folder ready");
});

it("leaves server tools, unknown vault tools, and native calls to their existing privacy projection", () => {
  const { host, render } = setup();
  for (const tool of [
    part("web_search", { query: "PRIVATE INPUT" }, { result_count: 2, sources: [{ title: "PRIVATE EVIDENCE", url: "https://example.com" }] }, { location: "server" }),
    part("write", { content: "PRIVATE INPUT" }, { path: "PRIVATE EVIDENCE" }, { location: "server" }),
    part("unknown_provider_tool", { content: "PRIVATE INPUT" }, { results: [{ path: "PRIVATE EVIDENCE" }] }),
    part("read", { paths: ["PRIVATE INPUT"] }, undefined, { native: { agent: "claude", workingDirectory: "/vault" } }),
  ]) expect(render(tool)).toBe(false);
  expect(host.childElementCount).toBe(0);
});

it("replaces only its own preview and uses the host owner document", () => {
  const { app } = setup();
  const ownerDocument = document.implementation.createHTMLDocument("Popout");
  const host = ownerDocument.createElement("div");
  const details = host.appendChild(ownerDocument.createElement("details"));
  details.textContent = "Raw Details";
  renderHostedToolPreview(app, host, part("read", { paths: ["First.md"] }));
  renderHostedToolPreview(app, host, part("read", { paths: ["Second.md"] }));
  expect(host.querySelectorAll(".ss-hosted-tool-preview")).toHaveLength(1);
  expect(host.textContent).not.toContain("First.md");
  expect(host.textContent).toContain("Second.md");
  expect(host.contains(details)).toBe(true);
  expect(host.querySelector("a")!.ownerDocument).toBe(ownerDocument);
});
