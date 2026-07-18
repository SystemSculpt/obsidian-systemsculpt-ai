/** @jest-environment jsdom */

import { App, MarkdownView, TFile } from "obsidian";
import { captureNoteInsertionTarget } from "../NoteInsertionTarget";

describe("captureNoteInsertionTarget", () => {
  function createEditor() {
    let from = { line: 2, ch: 4 };
    let to = { line: 2, ch: 4 };
    let selection = "";
    return {
      replaceSelection: jest.fn(),
      getCursor: jest.fn((side?: "from" | "to") => side === "to" ? to : from),
      getSelection: jest.fn(() => selection),
      moveSelection(nextFrom: typeof from, nextTo: typeof to, text: string) {
        from = nextFrom;
        to = nextTo;
        selection = text;
      },
    };
  }

  it("invalidates the target when the same leaf and editor move to another note", () => {
    const app = new App();
    const originFile = new TFile({ path: "Notes/origin.md" });
    const laterFile = new TFile({ path: "Notes/later.md" });
    const editor = createEditor();
    const view = new MarkdownView() as MarkdownView & {
      file: TFile | null;
      editor: typeof editor;
    };
    view.file = originFile;
    view.editor = editor;
    const leaf = { view } as any;
    (app.workspace as any).activeLeaf = leaf;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(view);

    const target = captureNoteInsertionTarget(app);
    expect(target).toMatchObject({ leaf, view, file: originFile, editor });
    expect(target.validate()).toBe(true);

    view.file = laterFile;

    expect(target.validate()).toBe(false);
  });

  it("remains valid when another leaf becomes active without changing the origin note", () => {
    const app = new App();
    const file = new TFile({ path: "Notes/origin.md" });
    const editor = createEditor();
    const view = new MarkdownView() as MarkdownView & {
      file: TFile | null;
      editor: typeof editor;
    };
    view.file = file;
    view.editor = editor;
    const leaf = { view } as any;
    (app.workspace as any).activeLeaf = leaf;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(view);

    const target = captureNoteInsertionTarget(app);
    (app.workspace as any).activeLeaf = { view: {} };

    expect(target.validate()).toBe(true);
  });

  it("invalidates insertion when the user moves or changes the original selection", () => {
    const app = new App();
    const file = new TFile({ path: "Notes/origin.md" });
    const editor = createEditor();
    const view = new MarkdownView() as MarkdownView & {
      file: TFile | null;
      editor: typeof editor;
    };
    view.file = file;
    view.editor = editor;
    const leaf = { view } as any;
    (app.workspace as any).activeLeaf = leaf;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(view);

    const target = captureNoteInsertionTarget(app);
    editor.moveSelection(
      { line: 8, ch: 0 },
      { line: 9, ch: 12 },
      "paragraph selected later",
    );

    expect(target.validate()).toBe(false);
    expect(editor.replaceSelection).not.toHaveBeenCalled();
  });
});
