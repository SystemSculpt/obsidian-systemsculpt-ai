import {
  applyStudioNotePreface,
  applyStudioNotePrefaceToTextOutputs,
  readStudioNotePreface,
  parseStudioNoteItems,
  serializeStudioNoteItems,
  readAllStudioNotePaths,
  deriveStudioNoteTitleFromPath,
} from "../StudioNoteConfig";

describe("Studio note paths", () => {
  it("keeps literal Unicode and nonbreaking spaces in existing references", () => {
    const path = "café/with space here.md";
    expect(parseStudioNoteItems({ items: [{ path }] })).toEqual([{ path, enabled: true }]);
    expect(serializeStudioNoteItems([{ path, enabled: false }])).toEqual({ items: [{ path, enabled: false }] });
    expect(readAllStudioNotePaths({ vaultPath: path })).toEqual([path]);
  });

  it("shares canonical paths across parsing, serialization, legacy references and titles", () => {
    const notes = { items: [
      { path: " /Notes\\日本語.md// ", enabled: true },
      { path: "Notes//日本語.md", enabled: false },
      { path: "", enabled: false },
      { path: "Literal%20name.md", enabled: true },
    ] };
    const items = parseStudioNoteItems(notes);
    expect(items).toEqual([
      { path: "Notes/日本語.md", enabled: true },
      { path: "Notes/日本語.md", enabled: false },
      { path: "", enabled: false },
      { path: "Literal%20name.md", enabled: true },
    ]);
    expect(serializeStudioNoteItems(items)).toEqual({ items });
    expect(readAllStudioNotePaths({ notes, vaultPath: "Notes/日本語.md/" })).toEqual([
      "Notes/日本語.md", "Literal%20name.md",
    ]);
    expect(deriveStudioNoteTitleFromPath("/Notes//日本語.MD/")).toBe("日本語");
  });
});

describe("StudioNoteConfig preface helpers", () => {
  it("reads and trims preface text from config", () => {
    expect(
      readStudioNotePreface({
        preface: "  Use these notes as factual context.  ",
      })
    ).toBe("Use these notes as factual context.");

    expect(readStudioNotePreface({ preface: "" })).toBe("");
    expect(readStudioNotePreface({})).toBe("");
  });

  it("applies preface ahead of note text with spacing", () => {
    expect(applyStudioNotePreface("Body", "Preface")).toBe("Preface\n\nBody");
    expect(applyStudioNotePreface("", "Preface")).toBe("Preface");
    expect(applyStudioNotePreface("Body", "")).toBe("Body");
  });

  it("prepends preface to the first text output only", () => {
    expect(
      applyStudioNotePrefaceToTextOutputs(
        ["First body", "Second body"],
        "Treat these as context."
      )
    ).toEqual([
      "Treat these as context.\n\nFirst body",
      "Second body",
    ]);
  });

  it("returns original text outputs when preface is empty or outputs are empty", () => {
    const outputs = ["First body", "Second body"];
    expect(applyStudioNotePrefaceToTextOutputs(outputs, "")).toBe(outputs);
    expect(applyStudioNotePrefaceToTextOutputs([], "Preface")).toEqual([]);
  });
});
