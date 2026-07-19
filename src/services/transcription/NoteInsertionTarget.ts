import type { App, Editor, TFile, WorkspaceLeaf } from "obsidian";
import { MarkdownView } from "obsidian";

export type TranscriptionInsertionValidator = () => boolean;

/**
 * The exact Markdown surface that initiated a transcription. Keeping each
 * identity lets long-running work distinguish a backgrounded note from a
 * different file later opened in the same leaf and editor instance.
 */
export interface NoteInsertionTarget {
  readonly leaf: WorkspaceLeaf | null;
  readonly view: MarkdownView | null;
  readonly file: TFile | null;
  readonly editor: Editor | null;
  readonly validate: TranscriptionInsertionValidator;
}

interface EditorSelectionSnapshot {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  text: string;
}

function readSelection(editor: Editor | null): EditorSelectionSnapshot | null {
  if (!editor) return null;
  try {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    return {
      from: { line: from.line, ch: from.ch },
      to: { line: to.line, ch: to.ch },
      text: editor.getSelection(),
    };
  } catch {
    return null;
  }
}

function selectionMatches(
  editor: Editor | null,
  expected: EditorSelectionSnapshot | null,
): boolean {
  if (!editor || !expected) return false;
  const current = readSelection(editor);
  return Boolean(
    current
    && current.from.line === expected.from.line
    && current.from.ch === expected.from.ch
    && current.to.line === expected.to.line
    && current.to.ch === expected.to.ch
    && current.text === expected.text
  );
}

export function captureNoteInsertionTarget(app: App): NoteInsertionTarget {
  const leaf = app.workspace.activeLeaf;
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file ?? null;
  const editor = view?.editor ?? null;
  const selection = readSelection(editor);
  const wasCoherent = Boolean(
    leaf && view && file && editor && selection && leaf.view === view,
  );

  return {
    leaf,
    view,
    file,
    editor,
    validate: () => Boolean(
      wasCoherent
      && leaf?.view === view
      && view?.file === file
      && view?.editor === editor
      && selectionMatches(editor, selection)
    ),
  };
}
