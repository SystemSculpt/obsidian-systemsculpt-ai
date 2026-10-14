/** @jest-environment jsdom */

import { afterEach, describe, expect, it } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  STUDIO_TEXT_NODE_EMPTY_LINE_CLASS,
  studioTextNodeEmptyLines,
} from "../StudioTextNodeEmptyLines";

const doc = ["# Title", "", "body", "", "", "end"].join("\n");

function mountEditor(hostClass?: string): EditorView {
  const host = document.createElement("div");
  if (hostClass) host.className = hostClass;
  document.body.appendChild(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: studioTextNodeEmptyLines() }),
  });
}

function markedLineTexts(view: EditorView): string[] {
  return Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>(`.cm-line.${STUDIO_TEXT_NODE_EMPTY_LINE_CLASS}`)
  ).map((line) => line.textContent ?? "");
}

describe("studioTextNodeEmptyLines", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks only empty rows inside a Studio text-node editor", () => {
    const view = mountEditor("ss-studio-text-node-live-editor");
    expect(markedLineTexts(view)).toEqual(["", "", ""]);
    const lines = Array.from(view.contentDOM.querySelectorAll(".cm-line"));
    expect(lines.map((line) => line.classList.contains(STUDIO_TEXT_NODE_EMPTY_LINE_CLASS))).toEqual([
      false,
      true,
      false,
      true,
      true,
      false,
    ]);
    view.destroy();
  });

  it("follows document edits", () => {
    const view = mountEditor("ss-studio-text-node-live-editor");
    view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: "filled" } });
    expect(markedLineTexts(view)).toHaveLength(2);
    view.destroy();
  });

  it("leaves editors outside Studio untouched", () => {
    const view = mountEditor();
    expect(markedLineTexts(view)).toHaveLength(0);
    view.destroy();
  });
});
