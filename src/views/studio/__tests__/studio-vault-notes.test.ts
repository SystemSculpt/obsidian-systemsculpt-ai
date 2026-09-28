import { TFile, TFolder, type TAbstractFile } from "obsidian";
import { serializeStudioNoteItems } from "../../../studio/StudioNoteConfig";
import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { StudioRunPresentationState } from "../StudioRunPresentationState";
import { StudioVaultNotes } from "../StudioVaultNotes";

function file(path: string): TFile {
  return Object.assign(new TFile(), { path, extension: path.split(".").pop(), basename: path.split("/").pop()?.replace(/\.md$/u, "") });
}
function node(id: string, paths: string[], options: Partial<StudioNodeInstance> = {}): StudioNodeInstance {
  return { id, kind: "studio.note", version: "1.0.0", title: "Note", position: { x: 0, y: 0 },
    config: { notes: serializeStudioNoteItems(paths.map(path => ({ path, enabled: true }))) },
    disabled: false, continueOnError: false, ...options };
}
function project(...nodes: StudioNodeInstance[]): StudioProjectV1 {
  return { graph: { nodes, edges: [], entryNodeIds: [] } } as unknown as StudioProjectV1;
}
function harness(entries: Record<string, string | TAbstractFile> = {}) {
  const files = new Map(Object.entries(entries).map(([path, content]) => [path, typeof content === "string" ? file(path) : content]));
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    cachedRead: jest.fn(async (note: TFile) => String(entries[note.path])),
  };
  const presentation = new StudioRunPresentationState();
  return { notes: new StudioVaultNotes(vault, presentation), presentation, vault };
}

describe("StudioVaultNotes", () => {
  it("migrates legacy references while hydrating output and leaves unrelated nodes alone", async () => {
    const { notes, presentation } = harness({ "Notes/One.md": "One" });
    const linked = node("one", [], { config: { vaultPath: "Notes\\One.md", value: "stale" } });
    const unrelated = node("other", [], { kind: "studio.text", config: { value: "Keep me" } });
    expect(await notes.refresh(project(linked, unrelated))).toBe(true);
    expect(linked.config).toEqual({ notes: { items: [{ path: "Notes/One.md", enabled: true }] } });
    expect(presentation.getNodeOutput("one")).toEqual({ text: "One", path: "Notes/One.md", title: "One" });
    expect(unrelated.config).toEqual({ value: "Keep me" });
    expect(await notes.refresh(project(linked))).toBe(false);
  });

  it("preserves note order, disabled references, and single versus multiple output shapes", async () => {
    const { notes, presentation, vault } = harness({ "A.md": "A", "B.md": "B", "Disabled.md": "D" });
    const linked = node("many", ["A.md", "B.md"]);
    linked.config.notes = serializeStudioNoteItems([{ path: "A.md", enabled: true }, { path: "Disabled.md", enabled: false }, { path: "B.md", enabled: true }]);
    await notes.refresh(project(linked));
    expect(presentation.getNodeOutput("many")).toEqual({ text: ["A", "B"], path: ["A.md", "B.md"], title: ["A", "B"] });
    expect(vault.cachedRead).toHaveBeenCalledTimes(2);
    expect(notes.affectedNodeIds(project(linked), file("Disabled.md"))).toEqual(new Set(["many"]));
  });

  it("replaces stale previews after deletion and only refreshes the affected nodes", async () => {
    const { notes, presentation } = harness();
    presentation.primeNodeOutput("missing", { text: "old" });
    presentation.primeNodeOutput("untouched", { text: "keep" });
    const linked = node("missing", ["Missing.md"]);
    const other = node("untouched", ["Other.md"]);
    await notes.refresh(project(linked, other), { onlyNodeIds: new Set(["missing"]) });
    expect(presentation.getNodeState("missing")).toMatchObject({ message: "Linked notes unavailable", outputs: { text: "", path: "Missing.md", title: "Missing" } });
    expect(presentation.getNodeOutput("untouched")).toEqual({ text: "keep" });
    expect(notes.badge(linked)).toMatchObject({ text: "Broken link", title: 'Vault note "Missing.md" was not found.' });
  });

  it("shows partial availability without discarding readable notes", async () => {
    const { notes, presentation } = harness({ "Good.md": "readable" });
    await notes.refresh(project(node("partial", ["Missing.md", "Good.md"])));
    expect(presentation.getNodeState("partial")).toMatchObject({ message: "Preview ready (1/2 notes loaded)", outputs: { text: "readable", path: "Good.md", title: "Good" } });
  });

  it("clears an empty selection and distinguishes folders from non-markdown files", async () => {
    const folder = Object.assign(new TFolder(), { path: "Folder" });
    const { notes, presentation } = harness({ Folder: folder, "File.png": file("File.png") });
    const empty = node("empty", []);
    await notes.refresh(project(empty));
    expect(presentation.getNodeState("empty")).toMatchObject({ message: "No enabled notes selected", outputs: { text: "", path: "", title: "" } });
    expect(notes.badge(empty)?.title).toBe("No enabled markdown notes selected.");
    expect(notes.badge(node("folder", ["Folder"]))?.title).toContain("points to a folder");
    expect(notes.badge(node("image", ["File.png"]))?.title).toContain("is not a markdown file");
  });

  it("renames matching references and default titles while preserving custom titles", async () => {
    const { notes, presentation } = harness({ "Renamed.md": "new bytes" });
    const automatic = node("auto", ["Old.md"], { title: "Old" });
    const custom = node("custom", ["Old.md"], { title: "My title" });
    expect(await notes.renameReferences(project(automatic, custom), file("Renamed.md"), "Old.md")).toBe(true);
    expect(automatic.title).toBe("Renamed");
    expect(custom.title).toBe("My title");
    expect(presentation.getNodeOutput("auto")).toMatchObject({ path: "Renamed.md", text: "new bytes" });
    expect(notes.affectedNodeIds(project(automatic, custom), file("Old.md"))).toEqual(new Set());
  });

  it("handles folder moves on path segments and keeps disabled references disabled", async () => {
    const { notes, presentation } = harness({ "New/A.md": "moved", "Oldish/B.md": "unmoved" });
    const moved = node("moved", [], { title: "My group", config: { notes: serializeStudioNoteItems([{ path: "Old/A.md", enabled: true }, { path: "Old/Disabled.md", enabled: false }]) } });
    const other = node("other", ["Oldish/B.md"]);
    const folder = Object.assign(new TFolder(), { path: "New" });
    expect(await notes.renameReferences(project(moved, other), folder, "Old")).toBe(true);
    expect(moved.config.notes).toEqual({ items: [{ path: "New/A.md", enabled: true }, { path: "New/Disabled.md", enabled: false }] });
    expect(moved.title).toBe("My group");
    expect(other.config.notes).toEqual({ items: [{ path: "Oldish/B.md", enabled: true }] });
    expect(presentation.getNodeOutput("other")).toBeNull();
    expect(notes.affectedNodeIds(project(moved, other), folder)).toEqual(new Set(["moved"]));
    expect(notes.affectedNodeIds(project(moved), file("New/image.png"))).toEqual(new Set());
  });
});
