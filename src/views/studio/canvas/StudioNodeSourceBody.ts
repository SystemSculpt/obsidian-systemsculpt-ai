import type { StudioNodeDefinition, StudioNodeInstance } from '../../../studio/types';
import { parseStudioNodeSource, readStudioNodeSource, STUDIO_NODE_SOURCE_MAX_BYTES } from '../../../studio/StudioNodeSource';
import { createStudioAction } from '../StudioAction';
import { markStudioNodeCardInteractive } from './StudioGraphNodeCardPointer';
import { mountStudioSourceEditor, renderStudioHighlightedSource, type StudioSourceEditorSnapshot } from './StudioSourceEditor';

export type StudioSourceBodyView = 'source' | 'panel';
type State = { view: StudioSourceBodyView; editing: boolean; draft: string; base: string; snapshot?: StudioSourceEditorSnapshot };
let nextPanelId = 0;
const states = new WeakMap<Document, Map<string, State>>();
export type StudioSourceReloadState = { nodeId: string; state: State }[];
export function captureStudioSourceReloadState(document: Document, scope: string): StudioSourceReloadState {
  const prefix = `${scope}:`;
  return [...(states.get(document) || [])].filter(([key]) => key.startsWith(prefix)).map(([key, state]) => ({ nodeId: key.slice(prefix.length), state: { ...state, snapshot: state.snapshot ? { ...state.snapshot } : undefined } }));
}
export function restoreStudioSourceReloadState(document: Document, scope: string, saved: StudioSourceReloadState): void {
  const cache = states.get(document) || new Map<string, State>();
  states.set(document, cache);
  for (const entry of saved) cache.set(`${scope}:${entry.nodeId}`, { ...entry.state });
}

export type StudioSourceBodyHandle = {
  dispose: () => void;
  /** Panel mode only: swap between the panel and its source definition. */
  toggleSource: () => void;
  isSourceView: () => boolean;
};

/**
 * The definition surface of a card. In `source` mode the highlighted source
 * IS the content (scripts, JSON, values, commands). In `panel` mode the
 * renderer-owned panel is the content and the source is one toggle away;
 * there are no tabs. Drafts survive re-renders and reloads without being
 * applied.
 */
export function renderStudioNodeSourceBody(root: HTMLElement, options: {
  node: StudioNodeInstance; definition: StudioNodeDefinition | null; scope?: string; locked: boolean;
  mode: StudioSourceBodyView;
  onApply?: (nodeId: string, source: string, expectedSource: string) => void;
  renderPanel?: (root: HTMLElement) => (() => void) | void;
  onViewChange?: (view: StudioSourceBodyView) => void;
}): StudioSourceBodyHandle {
  const { node } = options;
  const source = readStudioNodeSource(node);
  let cache = options.scope ? states.get(root.ownerDocument) : undefined;
  if (!cache) { cache = new Map(); if (options.scope) states.set(root.ownerDocument, cache); }
  const key = `${options.scope ?? ''}:${node.id}`;
  const state: State = cache.get(key) ?? { view: options.mode, editing: false, draft: '', base: source.text };
  if (options.mode === 'source' || !options.renderPanel) state.view = 'source';
  cache.delete(key); cache.set(key, state);
  // Limit idle presentation state, but never evict an unapplied draft merely
  // because another card was rendered in this living workspace.
  for (const [cachedKey, cached] of cache) {
    if (cache.size <= 40) break;
    if (!cached.editing && cachedKey !== key) cache.delete(cachedKey);
  }
  const toolbar = root.createDiv({ cls: 'ss-studio-source-toolbar' });
  markStudioNodeCardInteractive(toolbar);
  const language = toolbar.createSpan({ cls: 'ss-studio-source-language', text: source.language === 'javascript' ? 'JavaScript' : source.language.toUpperCase() });
  const tools = toolbar.createDiv({ cls: 'ss-studio-source-actions' });
  const panelId = `ss-studio-source-panel-${++nextPanelId}`;
  const body = root.createDiv({ cls: 'ss-studio-source-body', attr: { id: panelId } });
  let teardown: (() => void) | undefined;
  const dispose = () => { const fn = teardown; teardown = undefined; fn?.(); };
  function render(): void {
    body.empty(); tools.empty();
    root.dataset.sourceView = state.view;
    toolbar.hidden = state.view !== 'source';
    if (state.view === 'panel') { teardown = options.renderPanel?.(body) || undefined; return; }
    if (!state.editing) {
      createStudioAction(tools, { label: 'Edit source', testId: `studio.source.edit.${node.id}`,
        disabled: options.locked || !options.onApply || new TextEncoder().encode(source.text).byteLength > STUDIO_NODE_SOURCE_MAX_BYTES,
        onSelect: () => { state.editing = true; state.draft = source.text; state.base = source.text; state.snapshot = undefined; render(); } });
      renderStudioHighlightedSource(body, source.text, source.language); return;
    }
    const conflict = state.base !== source.text;
    const message = body.createDiv({ cls: 'ss-studio-source-message', attr: { role: 'status', 'aria-live': 'polite' } });
    message.setText(conflict ? 'Source changed outside this editor. Your draft is retained. Reload to use the new source.' : '');
    message.hidden = !conflict;
    const editorRoot = body.createDiv({ cls: 'ss-studio-source-editor' });
    let editor: ReturnType<typeof mountStudioSourceEditor> | undefined;
    const apply = () => {
      if (options.locked || conflict || !options.onApply) return;
      const text = editor?.read() ?? state.draft;
      try {
        parseStudioNodeSource(node, text, options.definition);
        state.editing = false; dispose();
        options.onApply(node.id, text, state.base);
        state.base = text; state.draft = text;
      } catch (error) {
        state.editing = true; state.draft = text;
        message.hidden = false;
        message.setText(error instanceof Error ? error.message : 'Source could not be saved.');
        message.classList.add('is-error');
        if (!teardown) { render(); const restored = body.querySelector<HTMLElement>('.ss-studio-source-message'); if (restored) { restored.hidden = false; restored.setText(error instanceof Error ? error.message : 'Source could not be saved.'); restored.classList.add('is-error'); } }
      }
    };
    createStudioAction(tools, { label: 'Apply', testId: `studio.source.apply.${node.id}`, disabled: options.locked || conflict, onSelect: apply });
    createStudioAction(tools, { label: conflict ? 'Reload source' : 'Cancel', testId: `studio.source.cancel.${node.id}`, onSelect: () => { state.editing = false; dispose(); state.draft = ''; state.base = source.text; render(); } });
    editor = mountStudioSourceEditor(editorRoot, { source: state.draft, language: source.language, label: `${node.title} source`,
      onChange: text => { state.draft = text; }, onApply: apply, snapshot: state.snapshot });
    teardown = () => { if (state.editing) state.draft = editor.read(); state.snapshot = editor.destroy(); };
  }
  language.hidden = false;
  render();
  return {
    dispose,
    toggleSource: () => {
      if (options.mode !== 'panel' || !options.renderPanel) return;
      dispose(); state.view = state.view === 'source' ? 'panel' : 'source'; render(); options.onViewChange?.(state.view);
    },
    isSourceView: () => state.view === 'source',
  };
}
