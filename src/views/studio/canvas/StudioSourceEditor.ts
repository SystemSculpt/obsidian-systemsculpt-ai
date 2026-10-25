import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { classHighlighter, highlightTree, tags } from '@lezer/highlight';
import type { StudioSourceLanguage } from '../../../studio/StudioNodeSource';
import { markStudioNodeCardInteractive } from './StudioGraphNodeCardPointer';

type Languages = typeof import('./StudioSourceLanguages');
let languages: Languages | null = null;
let languagesLoad: Promise<Languages> | null = null;
/**
 * The language packs are evaluated when a card first shows source, not when Studio opens.
 * @internal Unit-tested directly.
 */
export function loadStudioSourceLanguages(): Promise<Languages> {
  languagesLoad ??= import('./StudioSourceLanguages').then(
    loaded => (languages = loaded),
    (error: unknown) => { languagesLoad = null; throw error; },
  );
  return languagesLoad;
}
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, class: 'tok-keyword' }, { tag: [tags.string, tags.special(tags.string)], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' }, { tag: tags.comment, class: 'tok-comment' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-propertyName' }, { tag: tags.function(tags.variableName), class: 'tok-function' },
  { tag: tags.heading, class: 'tok-heading' },
]);

/** Static code keeps overview cards light; only the active editor mounts CodeMirror. */
export function renderStudioHighlightedSource(root: HTMLElement, source: string, name: StudioSourceLanguage): void {
  const preview = source.slice(0, 24000);
  const pre = root.createEl('pre', { cls: 'ss-studio-source-code', attr: { tabindex: '0', 'aria-label': `${name} source` } });
  markStudioNodeCardInteractive(pre);
  const code = pre.createEl('code');
  const paint = (loaded: Languages) => {
    code.empty();
    let cursor = 0;
    const tree = loaded.studioSourceLanguage(name).language.parser.parse(preview);
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (from > cursor) code.appendText(preview.slice(cursor, from));
      code.createSpan({ text: preview.slice(from, to), cls: classes }); cursor = to;
    });
    if (cursor < preview.length) code.appendText(preview.slice(cursor));
  };
  if (!preview) code.appendText('// Empty source');
  else if (languages) paint(languages);
  else {
    // Plain text until the packs load, then the same highlighted markup.
    code.appendText(preview);
    void loadStudioSourceLanguages().then(paint, () => undefined);
  }
  if (source.length > preview.length) root.createDiv({ cls: 'ss-studio-source-note', text: 'Preview shortened. Edit source to inspect the complete document.' });
}

export type StudioSourceEditorSnapshot = { anchor: number; head: number; scrollTop: number; scrollLeft: number; focused: boolean };
export function mountStudioSourceEditor(root: HTMLElement, options: {
  source: string; language: StudioSourceLanguage; label: string;
  onChange: (source: string) => void; onApply: () => void; snapshot?: StudioSourceEditorSnapshot;
}): { read: () => string; destroy: () => StudioSourceEditorSnapshot } {
  markStudioNodeCardInteractive(root);
  const size = options.source.length;
  const languageSlot = new Compartment();
  const view = new EditorView({
    parent: root, root: root.ownerDocument,
    state: EditorState.create({ doc: options.source,
      selection: options.snapshot ? { anchor: Math.min(options.snapshot.anchor, size), head: Math.min(options.snapshot.head, size) } : undefined,
      extensions: [languageSlot.of(languages ? languages.studioSourceLanguage(options.language) : []), syntaxHighlighting(highlightStyle), lineNumbers(), highlightActiveLine(), history(),
        EditorView.contentAttributes.of({ 'aria-label': options.label, 'data-testid': 'studio.source.editor', spellcheck: 'false' }),
        EditorView.updateListener.of(update => { if (update.docChanged) options.onChange(update.state.doc.toString()); }),
        keymap.of([{ key: 'Mod-Enter', run: () => { options.onApply(); return true; } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      ],
    }),
  });
  // Obsidian may mark shortcuts handled before embedded editor keymaps. Claim only
  // this editor's Apply shortcut in its own window, leaving all other keys alone.
  const ownerWindow = root.ownerDocument.defaultView;
  const applyKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !root.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation(); options.onApply();
  };
  ownerWindow?.addEventListener('keydown', applyKey, true);
  let destroyed = false;
  if (!languages) void loadStudioSourceLanguages().then(loaded => {
    if (!destroyed) view.dispatch({ effects: languageSlot.reconfigure(loaded.studioSourceLanguage(options.language)) });
  }, () => undefined);
  view.scrollDOM.scrollTop = options.snapshot?.scrollTop ?? 0;
  view.scrollDOM.scrollLeft = options.snapshot?.scrollLeft ?? 0;
  if (!options.snapshot || options.snapshot.focused) view.focus();
  return { read: () => view.state.doc.toString(), destroy: () => {
    const { anchor, head } = view.state.selection.main;
    const snapshot = { anchor, head, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft, focused: view.hasFocus };
    ownerWindow?.removeEventListener('keydown', applyKey, true);
    destroyed = true; view.destroy(); return snapshot;
  } };
}
