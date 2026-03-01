import {
  applyStudioNotePreface,
  applyStudioNotePrefaceToTextOutputs,
  readStudioNotePreface,
} from "../StudioNoteConfig";

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
