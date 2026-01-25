import { App } from "obsidian";
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { generateDiff, type DiffResult } from "../utils/diffUtils";

interface QuickEditEditorDiffPayload {
  diff: DiffResult;
  filePath: string;
  targetLineCount: number;
}

const countTextLines = (content: string): number => {
  if (!content) return 0;
  if (!content.endsWith("\n")) return content.split("\n").length;
  return content.slice(0, -1).split("\n").length;
};

const splitTextLines = (content: string): { lines: string[]; hasTrailingNewline: boolean } => {
  if (!content) return { lines: [], hasTrailingNewline: false };
  const hasTrailingNewline = content.endsWith("\n");
  const lines = hasTrailingNewline ? content.slice(0, -1).split("\n") : content.split("\n");
  return { lines, hasTrailingNewline };
};

const setQuickEditEditorDiffEffect = StateEffect.define<QuickEditEditorDiffPayload>();
const clearQuickEditEditorDiffEffect = StateEffect.define<null>();

interface QuickEditDiffChunk {
  id: string;
  oldFromLine: number;
  oldToLine: number;
  newFromLine: number;
  newToLine: number;
  currentLines: string[];
  targetLines: string[];
}

const targetContentByFilePath = new Map<string, string>();
let lastApp: App | null = null;

export const QUICK_EDIT_REVIEW_COMPLETE_EVENT = "systemsculpt:quick-edit-review-complete";

class AddedLineWidget extends WidgetType {
  private content: string;

  constructor(content: string) {
    super();
    this.content = content;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "ss-qe-editor-diff-widget ss-qe-editor-diff-widget--added";

    const code = document.createElement("code");
    code.className = "ss-qe-editor-diff-widget__code";
    code.textContent = this.content.length > 0 ? this.content : " ";

    el.appendChild(code);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class RemovedLineWidget extends WidgetType {
  private content: string;

  constructor(content: string) {
    super();
    this.content = content;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "ss-qe-editor-diff-widget ss-qe-editor-diff-widget--removed";

    const code = document.createElement("code");
    code.className = "ss-qe-editor-diff-widget__code";
    code.textContent = this.content.length > 0 ? this.content : " ";

    el.appendChild(code);
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class ChunkActionsWidget extends WidgetType {
  private filePath: string;
  private chunk: QuickEditDiffChunk;

  constructor(filePath: string, chunk: QuickEditDiffChunk) {
    super();
    this.filePath = filePath;
    this.chunk = chunk;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "ss-qe-editor-diff-actions";

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "mod-cta";
    applyBtn.textContent = "Apply";

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "mod-muted";
    discardBtn.textContent = "Discard";

    const stop = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const onApply = (event: Event) => {
      stop(event);
      applyOrDiscardChunk(view, this.filePath, this.chunk, "apply");
    };

    const onDiscard = (event: Event) => {
      stop(event);
      applyOrDiscardChunk(view, this.filePath, this.chunk, "discard");
    };

    applyBtn.addEventListener("mousedown", stop);
    discardBtn.addEventListener("mousedown", stop);
    applyBtn.addEventListener("click", onApply);
    discardBtn.addEventListener("click", onDiscard);

    root.appendChild(applyBtn);
    root.appendChild(discardBtn);
    return root;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const clampLine = (doc: Transaction["state"]["doc"], lineNumber: number) => {
  return Math.max(1, Math.min(doc.lines, lineNumber));
};

const buildQuickEditDiffChunks = (
  diff: DiffResult,
  doc: Transaction["state"]["doc"],
  targetLineCount: number
): QuickEditDiffChunk[] => {
  const firstOldLineNumber = (() => {
    for (const line of diff.lines) {
      if (typeof line.oldLineNumber === "number") return line.oldLineNumber;
    }
    return null;
  })();

  const firstNewLineNumber = (() => {
    for (const line of diff.lines) {
      if (typeof line.newLineNumber === "number") return line.newLineNumber;
    }
    return null;
  })();

  let cursorOldLineNumber = firstOldLineNumber ?? doc.lines + 1;
  let cursorNewLineNumber = firstNewLineNumber ?? targetLineCount + 1;

  const chunks: QuickEditDiffChunk[] = [];
  let chunkCounter = 0;

  for (let i = 0; i < diff.lines.length; i++) {
    const line = diff.lines[i];
    if (line.type === "unchanged") {
      if (typeof line.oldLineNumber === "number") cursorOldLineNumber = line.oldLineNumber + 1;
      if (typeof line.newLineNumber === "number") cursorNewLineNumber = line.newLineNumber + 1;
      continue;
    }

    const oldCursorAtStart = cursorOldLineNumber;
    const newCursorAtStart = cursorNewLineNumber;

    const currentLines: string[] = [];
    const targetLines: string[] = [];
    let oldFromLine: number | null = null;
    let oldToLine: number | null = null;
    let newFromLine: number | null = null;
    let newToLine: number | null = null;

    let j = i;
    for (; j < diff.lines.length; j++) {
      const inner = diff.lines[j];
      if (inner.type === "unchanged") break;

      if (inner.type === "removed") {
        currentLines.push(inner.content ?? "");
        if (typeof inner.oldLineNumber === "number") {
          if (oldFromLine === null) oldFromLine = inner.oldLineNumber;
          oldToLine = inner.oldLineNumber;
          cursorOldLineNumber = inner.oldLineNumber + 1;
        }
      } else if (inner.type === "added") {
        targetLines.push(inner.content ?? "");
        if (typeof inner.newLineNumber === "number") {
          if (newFromLine === null) newFromLine = inner.newLineNumber;
          newToLine = inner.newLineNumber;
          cursorNewLineNumber = inner.newLineNumber + 1;
        }
      }
    }

    i = j - 1;

    if (oldFromLine === null) {
      oldFromLine = oldCursorAtStart;
      oldToLine = oldFromLine - 1;
    } else if (oldToLine === null) {
      oldToLine = oldFromLine;
    }

    if (newFromLine === null) {
      newFromLine = newCursorAtStart;
      newToLine = newFromLine - 1;
    } else if (newToLine === null) {
      newToLine = newFromLine;
    }

    chunkCounter += 1;
    chunks.push({
      id: `qe_chunk_${chunkCounter}_${oldFromLine}_${newFromLine}`,
      oldFromLine,
      oldToLine,
      newFromLine,
      newToLine,
      currentLines,
      targetLines,
    });
  }

  return chunks;
};

const applyLinePatchToString = (
  content: string,
  fromLine: number,
  toLine: number,
  replacementLines: string[]
): string => {
  const { lines, hasTrailingNewline } = splitTextLines(content);
  const startIndex = Math.max(0, Math.min(lines.length, fromLine - 1));

  let deleteCount = 0;
  if (toLine >= fromLine) {
    const endIndexInclusive = Math.max(0, Math.min(lines.length - 1, toLine - 1));
    deleteCount = Math.max(0, endIndexInclusive - startIndex + 1);
  }

  lines.splice(startIndex, deleteCount, ...replacementLines);
  const next = lines.join("\n");
  return hasTrailingNewline ? `${next}\n` : next;
};

const applyChunkToEditorView = (view: EditorView, chunk: QuickEditDiffChunk): void => {
  const doc = view.state.doc;

  const insertionOnly = chunk.oldToLine < chunk.oldFromLine;
  if (insertionOnly) {
    const insertBefore = chunk.oldFromLine;
    const insertPos = insertBefore <= doc.lines ? doc.line(clampLine(doc, insertBefore)).from : doc.length;

    let insertText = chunk.targetLines.join("\n");
    if (insertText.length > 0) {
      if (insertBefore <= doc.lines) {
        insertText = `${insertText}\n`;
      } else if (doc.length > 0) {
        insertText = `\n${insertText}`;
      }
    }

    view.dispatch({ changes: { from: insertPos, to: insertPos, insert: insertText } });
    return;
  }

  const startLine = clampLine(doc, chunk.oldFromLine);
  const endLine = clampLine(doc, chunk.oldToLine);
  const from = doc.line(startLine).from;
  const endInfo = doc.line(endLine);
  const to = endLine < doc.lines ? endInfo.to + 1 : endInfo.to;

  let insertText = chunk.targetLines.join("\n");
  if (insertText.length > 0 && endLine < doc.lines) {
    insertText = `${insertText}\n`;
  }

  view.dispatch({ changes: { from, to, insert: insertText } });
};

const applyOrDiscardChunk = (
  originView: EditorView,
  filePath: string,
  chunk: QuickEditDiffChunk,
  action: "apply" | "discard"
): void => {
  const app = lastApp;
  if (!app) {
    console.warn("[QuickEditEditorDiff] No app instance available for chunk action");
    return;
  }

  const targetContent = targetContentByFilePath.get(filePath);
  if (typeof targetContent !== "string") return;

  let nextTargetContent = targetContent;

  if (action === "discard") {
    nextTargetContent = applyLinePatchToString(targetContent, chunk.newFromLine, chunk.newToLine, chunk.currentLines);
    targetContentByFilePath.set(filePath, nextTargetContent);
  } else {
    const views = getMarkdownViews(app);
    for (const view of views) {
      if (view?.file?.path !== filePath) continue;
      const editorView = getEditorView(view);
      if (!editorView) continue;
      try {
        applyChunkToEditorView(editorView, chunk);
      } catch (error) {
        console.warn("[QuickEditEditorDiff] Failed to apply chunk to editor", error);
      }
    }
  }

  const currentContent = originView.state.doc.toString();
  const nextDiff = generateDiff(currentContent, nextTargetContent, 200);
  const hasChanges = nextDiff.lines.some((line) => line.type !== "unchanged");

  if (!hasChanges) {
    clearQuickEditDiffFromEditors(app, filePath);
    try {
      window.dispatchEvent(new CustomEvent(QUICK_EDIT_REVIEW_COMPLETE_EVENT, { detail: { filePath } }));
    } catch {}
    return;
  }

  applyQuickEditDiffToEditors(app, filePath, nextDiff, nextTargetContent);
};

export function buildQuickEditEditorDiffDecorations(
  diff: DiffResult,
  state: Transaction["state"],
  options: { filePath: string; targetLineCount: number }
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const pending: Array<{ from: number; to: number; deco: Decoration }> = [];
  const doc = state.doc;

  const chunks = buildQuickEditDiffChunks(diff, doc, options.targetLineCount);
  for (const chunk of chunks) {
    const insertionOnly = chunk.oldToLine < chunk.oldFromLine;
    const anchorPos = (() => {
      if (insertionOnly) {
        const insertBefore = chunk.oldFromLine;
        return insertBefore <= doc.lines ? doc.line(clampLine(doc, insertBefore)).from : doc.length;
      }

      const endLine = clampLine(doc, chunk.oldToLine);
      const lineInfo = doc.line(endLine);
      return endLine < doc.lines ? lineInfo.to + 1 : lineInfo.to;
    })();

    pending.push({
      from: anchorPos,
      to: anchorPos,
      deco: Decoration.widget({
        widget: new ChunkActionsWidget(options.filePath, chunk),
        block: true,
        side: 0,
      }),
    });
  }

  const firstOldLineNumber = (() => {
    for (const line of diff.lines) {
      if (typeof line.oldLineNumber === "number") return line.oldLineNumber;
    }
    return null;
  })();

  let cursorOldLineNumber = firstOldLineNumber ?? doc.lines + 1;

  for (const line of diff.lines) {
    if (line.type === "added") {
      const insertBefore = cursorOldLineNumber;
      const insertPos =
        insertBefore <= doc.lines ? doc.line(clampLine(doc, insertBefore)).from : doc.length;
      pending.push({
        from: insertPos,
        to: insertPos,
        deco: Decoration.widget({
          widget: new AddedLineWidget(line.content ?? ""),
          block: true,
          side: -1,
        }),
      });
      continue;
    }

    const oldLineNumber = line.oldLineNumber;
    if (typeof oldLineNumber !== "number") continue;
    cursorOldLineNumber = oldLineNumber + 1;

    if (line.type !== "removed") continue;

    const lineInfo = doc.line(clampLine(doc, oldLineNumber));
    pending.push({
      from: lineInfo.from,
      to: lineInfo.to,
      deco: Decoration.replace({
        widget: new RemovedLineWidget(line.content ?? ""),
        block: true,
      }),
    });
  }

  pending.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const aSide = (a.deco as any).startSide ?? 0;
    const bSide = (b.deco as any).startSide ?? 0;
    if (aSide !== bSide) return aSide - bSide;
    if (a.to !== b.to) return a.to - b.to;
    const aEndSide = (a.deco as any).endSide ?? 0;
    const bEndSide = (b.deco as any).endSide ?? 0;
    return aEndSide - bEndSide;
  });

  for (const item of pending) {
    builder.add(item.from, item.to, item.deco);
  }

  return builder.finish();
}

const diffStateField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value: DecorationSet, tr: Transaction): DecorationSet {
    for (const effect of tr.effects) {
      if (effect.is(setQuickEditEditorDiffEffect)) {
        return buildQuickEditEditorDiffDecorations(effect.value.diff, tr.state, {
          filePath: effect.value.filePath,
          targetLineCount: effect.value.targetLineCount,
        });
      }
      if (effect.is(clearQuickEditEditorDiffEffect)) {
        return Decoration.none;
      }
    }
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const quickEditEditorDiffKeymap: Extension = keymap.of([
  {
    key: "Mod-Enter",
    run: (view) => {
      const filePath = trackedEditors.get(view);
      if (!filePath) return false;

      const app = lastApp;
      if (!app) return false;

      const applied = applyAllQuickEditDiffInEditors(app, filePath);
      if (!applied) return false;

      try {
        window.dispatchEvent(new CustomEvent(QUICK_EDIT_REVIEW_COMPLETE_EVENT, { detail: { filePath } }));
      } catch {}

      return true;
    },
  },
]);

export const quickEditEditorDiffExtension: Extension = [diffStateField, quickEditEditorDiffKeymap];

const getEditorView = (markdownView: any): EditorView | null => {
  const cm = markdownView?.editor ? (markdownView.editor as any).cm : null;
  if (cm && typeof cm.dispatch === "function") return cm as EditorView;
  return null;
};

const getMarkdownViews = (app: App): any[] => {
  try {
    return (app as any)?.workspace?.getLeavesOfType?.("markdown")?.map((leaf: any) => leaf?.view) ?? [];
  } catch {
    return [];
  }
};

const trackedEditors = new Map<EditorView, string>();

const cleanupSessionIfUnused = (filePath: string): void => {
  for (const tracked of trackedEditors.values()) {
    if (tracked === filePath) return;
  }
  targetContentByFilePath.delete(filePath);
};

export function applyQuickEditDiffToEditors(
  app: App,
  filePath: string,
  diff: DiffResult,
  targetContent: string
): number {
  lastApp = app;
  targetContentByFilePath.set(filePath, targetContent);
  guardQuickEditEditorDiffLeaks(app);
  const views = getMarkdownViews(app);

  let applied = 0;
  const targetLineCount = countTextLines(targetContent);
  for (const view of views) {
    if (view?.file?.path !== filePath) continue;
    const editorView = getEditorView(view);
    if (!editorView) continue;
    editorView.dispatch({
      effects: setQuickEditEditorDiffEffect.of({ diff, filePath, targetLineCount }),
    });
    trackedEditors.set(editorView, filePath);
    applied += 1;
  }
  return applied;
}

export function clearQuickEditDiffFromEditors(app: App, filePath: string): number {
  lastApp = app;
  targetContentByFilePath.delete(filePath);
  let cleared = 0;

  for (const [editorView, expectedFile] of trackedEditors.entries()) {
    if (expectedFile !== filePath) continue;
    if ((editorView as any)?.destroyed) {
      trackedEditors.delete(editorView);
      continue;
    }
    editorView.dispatch({ effects: clearQuickEditEditorDiffEffect.of(null) });
    trackedEditors.delete(editorView);
    cleared += 1;
  }

  return cleared;
}

export function applyAllQuickEditDiffInEditors(app: App, filePath: string): boolean {
  lastApp = app;
  const targetContent = targetContentByFilePath.get(filePath);
  if (typeof targetContent !== "string") return false;

  let applied = 0;
  for (const [editorView, expectedFile] of trackedEditors.entries()) {
    if (expectedFile !== filePath) continue;
    if ((editorView as any)?.destroyed) {
      trackedEditors.delete(editorView);
      continue;
    }
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: targetContent } });
    applied += 1;
  }

  if (applied === 0) return false;
  clearQuickEditDiffFromEditors(app, filePath);
  return true;
}

export function discardAllQuickEditDiffInEditors(app: App, filePath: string): void {
  lastApp = app;
  clearQuickEditDiffFromEditors(app, filePath);
}

export function guardQuickEditEditorDiffLeaks(app: App): void {
  const views = getMarkdownViews(app);
  const activeEditorViews = new Set<EditorView>();
  const activeFileByEditor = new Map<EditorView, string>();

  for (const view of views) {
    const editorView = getEditorView(view);
    if (!editorView) continue;
    activeEditorViews.add(editorView);
    if (view?.file?.path) activeFileByEditor.set(editorView, view.file.path);
  }

  for (const [editorView, expectedFile] of trackedEditors.entries()) {
    if ((editorView as any)?.destroyed) {
      trackedEditors.delete(editorView);
      cleanupSessionIfUnused(expectedFile);
      continue;
    }

    if (!activeEditorViews.has(editorView)) {
      continue;
    }

    const currentFile = activeFileByEditor.get(editorView);
    if (currentFile && currentFile !== expectedFile) {
      editorView.dispatch({ effects: clearQuickEditEditorDiffEffect.of(null) });
      trackedEditors.delete(editorView);
      cleanupSessionIfUnused(expectedFile);
    }
  }
}
