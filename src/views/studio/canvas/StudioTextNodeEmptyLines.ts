import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Marks empty source rows in Studio text-node live editors so text-nodes.css
 * can match their height to the rendered preview without a `:has()` selector.
 *
 * Obsidian builds the embedded editor with every registered editor extension,
 * so this is registered once by the plugin and stays inert in any editor that
 * is not mounted inside a Studio text node.
 */

/** @internal Tests assert against this value. */
export const STUDIO_TEXT_NODE_EMPTY_LINE_CLASS = "ss-studio-text-node-empty-line";
const STUDIO_TEXT_NODE_EDITOR_SELECTOR = ".ss-studio-text-node-live-editor";

const emptyLineDecoration = Decoration.line({ class: STUDIO_TEXT_NODE_EMPTY_LINE_CLASS });

function isStudioTextNodeEditor(view: EditorView): boolean {
  return view.dom.closest(STUDIO_TEXT_NODE_EDITOR_SELECTOR) !== null;
}

function buildEmptyLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  let nextLineStart = 0;
  for (const { from, to } of view.visibleRanges) {
    let pos = Math.max(from, nextLineStart);
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.length === 0) {
        builder.add(line.from, line.from, emptyLineDecoration);
      }
      nextLineStart = line.to + 1;
      pos = nextLineStart;
    }
  }
  return builder.finish();
}

class StudioTextNodeEmptyLines {
  decorations: DecorationSet = Decoration.none;
  private scoped = false;

  constructor(view: EditorView) {
    this.refresh(view);
  }

  update(update: ViewUpdate): void {
    // The editor DOM can be created before it is attached to its Studio host,
    // so keep checking until the host is found.
    if (!this.scoped || update.docChanged || update.viewportChanged) {
      this.refresh(update.view);
    }
  }

  private refresh(view: EditorView): void {
    this.scoped = isStudioTextNodeEditor(view);
    this.decorations = this.scoped ? buildEmptyLineDecorations(view) : Decoration.none;
  }
}

export function studioTextNodeEmptyLines(): Extension {
  return ViewPlugin.fromClass(StudioTextNodeEmptyLines, {
    decorations: (plugin) => plugin.decorations,
  });
}
