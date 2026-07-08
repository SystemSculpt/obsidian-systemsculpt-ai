import { type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

/**
 * Vim-style "hybrid" relative line numbers for the markdown editor gutter.
 *
 * The line holding the primary cursor renders its *absolute* line number; every
 * other line renders its *absolute distance* from the cursor line. This keeps
 * the current line easy to locate while making relative jumps (e.g. `5k`,
 * `12j`) trivial to count.
 *
 * Gutter APIs are imported from `@codemirror/view` (which Obsidian provides at
 * runtime and esbuild externalizes), never the stale standalone
 * `@codemirror/gutter` 0.19 package.
 */

const GUTTER_CLASS = "ss-relative-line-numbers";
const MARKER_CLASS = "ss-relative-line-number";
const CURRENT_MARKER_CLASS = "ss-relative-line-number--current";

/**
 * Pure mapping from a line number to the text shown in the gutter, given which
 * line currently holds the cursor. Kept side-effect free so it can be unit
 * tested without a live editor.
 */
export function formatRelativeLineNumber(lineNumber: number, cursorLineNumber: number): string {
  if (lineNumber === cursorLineNumber) {
    return String(lineNumber);
  }
  return String(Math.abs(lineNumber - cursorLineNumber));
}

class RelativeLineNumberMarker extends GutterMarker {
  constructor(
    private readonly text: string,
    private readonly current: boolean
  ) {
    super();
    this.elementClass = current ? `${MARKER_CLASS} ${CURRENT_MARKER_CLASS}` : MARKER_CLASS;
  }

  eq(other: RelativeLineNumberMarker): boolean {
    return this.text === other.text && this.current === other.current;
  }

  toDOM(): Text {
    return document.createTextNode(this.text);
  }
}

/** Line number that holds the primary cursor in the given editor state. */
function cursorLineNumber(view: EditorView): number {
  const { doc, selection } = view.state;
  return doc.lineAt(selection.main.head).number;
}

/** Width-stabilising spacer text: wide enough for the largest line number. */
function spacerText(view: EditorView): string {
  const digits = Math.max(2, String(view.state.doc.lines).length);
  return "0".repeat(digits);
}

const relativeLineNumberTheme = EditorView.baseTheme({
  [`.cm-gutter.${GUTTER_CLASS}`]: {
    minWidth: "2ch",
    color: "var(--text-faint)",
    fontVariantNumeric: "tabular-nums",
  },
  [`.cm-gutter.${GUTTER_CLASS} .cm-gutterElement`]: {
    padding: "0 var(--size-4-1, 3px) 0 var(--size-4-2, 8px)",
    textAlign: "right",
    cursor: "default",
  },
  [`.${CURRENT_MARKER_CLASS}`]: {
    color: "var(--text-normal)",
    fontWeight: "var(--font-semibold, 600)",
  },
});

/**
 * Editor extension that renders the relative line number gutter. Markers are
 * recomputed on edits, viewport changes, and — crucially — cursor movement
 * (`selectionSet`), so the numbers track the caret in real time.
 */
export function relativeLineNumbersExtension(): Extension {
  return [
    gutter({
      class: GUTTER_CLASS,
      lineMarker(view, line) {
        const lineNumber = view.state.doc.lineAt(line.from).number;
        const cursorLine = cursorLineNumber(view);
        return new RelativeLineNumberMarker(
          formatRelativeLineNumber(lineNumber, cursorLine),
          lineNumber === cursorLine
        );
      },
      lineMarkerChange(update) {
        return update.docChanged || update.viewportChanged || update.selectionSet;
      },
      initialSpacer(view) {
        return new RelativeLineNumberMarker(spacerText(view), false);
      },
      updateSpacer(_spacer, update) {
        return new RelativeLineNumberMarker(spacerText(update.view), false);
      },
    }),
    relativeLineNumberTheme,
  ];
}
