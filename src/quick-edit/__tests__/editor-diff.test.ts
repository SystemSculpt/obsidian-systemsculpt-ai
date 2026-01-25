import { describe, expect, it } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { generateDiff } from "../../utils/diffUtils";
import { buildQuickEditEditorDiffDecorations } from "../editor-diff";

const countTextLines = (content: string): number => {
  if (!content) return 0;
  if (!content.endsWith("\n")) return content.split("\n").length;
  return content.slice(0, -1).split("\n").length;
};

describe("Quick Edit editor diff decorations", () => {
  it("adds widgets for inserted and removed lines", () => {
    const oldContent = ["one", "two", "three", "four"].join("\n") + "\n";
    const newContent = ["one", "two", "NEW", "four"].join("\n") + "\n";

    const diff = generateDiff(oldContent, newContent, 200);
    const state = EditorState.create({ doc: oldContent });
    const decorations = buildQuickEditEditorDiffDecorations(diff, state, {
      filePath: "Test.md",
      targetLineCount: countTextLines(newContent),
    });

    let addedWidgets = 0;
    let removedWidgets = 0;
    let actionWidgets = 0;
    const actionSides: number[] = [];

    decorations.between(0, state.doc.length, (_from, _to, deco) => {
      const widget = deco.spec?.widget;
      if (!widget) return;
      const name = String((widget as any)?.constructor?.name ?? "");
      if (name === "ChunkActionsWidget") {
        actionWidgets += 1;
        actionSides.push((deco as any).startSide ?? 0);
      }
      if (name === "AddedLineWidget") addedWidgets += 1;
      if (name === "RemovedLineWidget") removedWidgets += 1;
    });

    expect(addedWidgets).toBeGreaterThan(0);
    expect(removedWidgets).toBeGreaterThan(0);
    expect(actionWidgets).toBeGreaterThan(0);
    expect(actionSides.every((side) => side <= 0)).toBe(true);
  });

  it("inserts added widgets at the correct anchor line", () => {
    const oldContent = ["alpha", "bravo", "charlie"].join("\n") + "\n";
    const newContent = ["alpha", "INSERTED", "bravo", "charlie"].join("\n") + "\n";

    const diff = generateDiff(oldContent, newContent, 200);
    const state = EditorState.create({ doc: oldContent });
    const decorations = buildQuickEditEditorDiffDecorations(diff, state, {
      filePath: "Test.md",
      targetLineCount: countTextLines(newContent),
    });

    const expectedInsertPos = state.doc.line(2).from;
    const widgetPositions: number[] = [];
    decorations.between(0, state.doc.length, (from, _to, deco) => {
      const widget = deco.spec?.widget;
      if (!widget) return;
      const name = String((widget as any)?.constructor?.name ?? "");
      if (name === "AddedLineWidget") widgetPositions.push(from);
    });

    expect(widgetPositions).toContain(expectedInsertPos);
  });

  it("supports insertion-only diffs when the original file is empty", () => {
    const oldContent = "";
    const newContent = "hello";

    const diff = generateDiff(oldContent, newContent, 200);
    const state = EditorState.create({ doc: oldContent });
    const decorations = buildQuickEditEditorDiffDecorations(diff, state, {
      filePath: "Test.md",
      targetLineCount: countTextLines(newContent),
    });

    let addedWidgets = 0;
    let removedWidgets = 0;
    let actionWidgets = 0;
    const scanEnd = Math.max(1, state.doc.length);

    decorations.between(0, scanEnd, (_from, _to, deco) => {
      const widget = deco.spec?.widget;
      if (!widget) return;
      const name = String((widget as any)?.constructor?.name ?? "");
      if (name === "ChunkActionsWidget") actionWidgets += 1;
      if (name === "AddedLineWidget") addedWidgets += 1;
      if (name === "RemovedLineWidget") removedWidgets += 1;
    });

    expect(addedWidgets).toBe(1);
    expect(removedWidgets).toBe(0);
    expect(actionWidgets).toBe(1);
  });

  it("supports removal-only diffs when the new file is empty", () => {
    const oldContent = "hello";
    const newContent = "";

    const diff = generateDiff(oldContent, newContent, 200);
    const state = EditorState.create({ doc: oldContent });
    const decorations = buildQuickEditEditorDiffDecorations(diff, state, {
      filePath: "Test.md",
      targetLineCount: countTextLines(newContent),
    });

    let addedWidgets = 0;
    let removedWidgets = 0;
    let actionWidgets = 0;

    decorations.between(0, state.doc.length, (_from, _to, deco) => {
      const widget = deco.spec?.widget;
      if (!widget) return;
      const name = String((widget as any)?.constructor?.name ?? "");
      if (name === "ChunkActionsWidget") actionWidgets += 1;
      if (name === "AddedLineWidget") addedWidgets += 1;
      if (name === "RemovedLineWidget") removedWidgets += 1;
    });

    expect(addedWidgets).toBe(0);
    expect(removedWidgets).toBe(1);
    expect(actionWidgets).toBe(1);
  });

  it("supports single-line removals without insertions", () => {
    const oldContent = ["one", "remove-me", "three"].join("\n");
    const newContent = ["one", "three"].join("\n");

    const diff = generateDiff(oldContent, newContent, 200);
    const state = EditorState.create({ doc: oldContent });
    const decorations = buildQuickEditEditorDiffDecorations(diff, state, {
      filePath: "Test.md",
      targetLineCount: countTextLines(newContent),
    });

    let addedWidgets = 0;
    let removedWidgets = 0;
    let actionWidgets = 0;

    decorations.between(0, state.doc.length, (_from, _to, deco) => {
      const widget = deco.spec?.widget;
      if (!widget) return;
      const name = String((widget as any)?.constructor?.name ?? "");
      if (name === "ChunkActionsWidget") actionWidgets += 1;
      if (name === "AddedLineWidget") addedWidgets += 1;
      if (name === "RemovedLineWidget") removedWidgets += 1;
    });

    expect(addedWidgets).toBe(0);
    expect(removedWidgets).toBe(1);
    expect(actionWidgets).toBe(1);
  });
});
