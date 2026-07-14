/** @jest-environment jsdom */

import { describe, expect, it } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { formatRelativeLineNumber, relativeLineNumbersExtension } from "../relative-line-numbers";

describe("formatRelativeLineNumber", () => {
  it("shows the absolute number on the current line", () => {
    expect(formatRelativeLineNumber(1, 1)).toBe("1");
    expect(formatRelativeLineNumber(5, 5)).toBe("5");
    expect(formatRelativeLineNumber(120, 120)).toBe("120");
  });

  it("shows the absolute distance for lines above and below the cursor", () => {
    expect(formatRelativeLineNumber(4, 5)).toBe("1"); // one above
    expect(formatRelativeLineNumber(6, 5)).toBe("1"); // one below
    expect(formatRelativeLineNumber(1, 5)).toBe("4");
    expect(formatRelativeLineNumber(9, 5)).toBe("4");
  });

  it("is symmetric around the cursor line", () => {
    for (let distance = 1; distance <= 12; distance++) {
      expect(formatRelativeLineNumber(20 - distance, 20)).toBe(String(distance));
      expect(formatRelativeLineNumber(20 + distance, 20)).toBe(String(distance));
    }
  });
});

describe("relativeLineNumbersExtension", () => {
  it("builds a valid CodeMirror editor extension", () => {
    const state = EditorState.create({
      doc: ["one", "two", "three", "four"].join("\n") + "\n",
      extensions: relativeLineNumbersExtension(),
    });

    // The extension must not interfere with the underlying document model.
    expect(state.doc.lines).toBe(5);
    expect(state.doc.line(2).text).toBe("two");
  });

  it("renders gutter nodes in the editor's owning document", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const popoutDocument = iframe.contentDocument!;
    const view = new EditorView({
      parent: popoutDocument.body,
      state: EditorState.create({
        doc: "one\ntwo\nthree",
        extensions: relativeLineNumbersExtension(),
      }),
    });

    const gutter = view.dom.querySelector(".ss-relative-line-numbers");
    expect(gutter).not.toBeNull();
    const markerNodes = gutter?.querySelectorAll(".cm-gutterElement") ?? [];
    expect(markerNodes.length).toBeGreaterThan(0);
    for (const marker of Array.from(markerNodes)) {
      expect(marker.ownerDocument).toBe(popoutDocument);
      for (const child of Array.from(marker.childNodes)) {
        expect(child.ownerDocument).toBe(popoutDocument);
      }
    }

    view.destroy();
    iframe.remove();
  });
});
