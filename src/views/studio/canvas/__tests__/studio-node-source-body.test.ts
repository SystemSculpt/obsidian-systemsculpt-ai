/** @jest-environment jsdom */
import { EditorView } from '@codemirror/view';
import { renderStudioNodeSourceBody, captureStudioSourceReloadState, restoreStudioSourceReloadState } from '../StudioNodeSourceBody';
import type { StudioNodeInstance } from '../../../../studio/types';
import { parseStudioNodeSource } from '../../../../studio/StudioNodeSource';

let disposals: Array<() => void> = [];
afterEach(() => { disposals.forEach(dispose => dispose()); disposals=[]; document.body.innerHTML=''; });
function mount(node: StudioNodeInstance, scope: string, onApply = jest.fn(), mode: 'source' | 'panel' = 'source') {
  const root = document.body.createDiv();
  const views: string[] = [];
  const handle = renderStudioNodeSourceBody(root,{node,scope,locked:false,definition:null,mode,onApply,renderPanel: mode === 'panel' ? el => {el.setText('Panel data');} : undefined, onViewChange: view => views.push(view)});
  disposals.push(handle.dispose);
  const click = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid="studio.source.${id}.${node.id}"]`)!.click();
  const editor = () => EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
  const edit = (source: string) => { const view = editor(); view.dispatch({changes:{from:0,to:view.state.doc.length,insert:source}}); };
  return {root,dispose: handle.dispose,handle,views,click,edit,editor,onApply};
}
const makeNode = (): StudioNodeInstance => ({id:'data',kind:'studio.json',version:'1.0.0',title:'Data',position:{x:0,y:0},config:{value:{n:1}}});

describe('manual source editing', () => {
  it('validates drafts and applies once without executing', () => {
    const node=makeNode(), onApply=jest.fn((_id,source) => {node.config=parseStudioNodeSource(node,source);});
    const h=mount(node,'apply',onApply); h.click('edit');
    expect(h.root.querySelector('.cm-lineNumbers')).not.toBeNull();
    h.edit('{invalid'); h.click('apply');
    expect(onApply).not.toHaveBeenCalled(); expect(h.editor().state.doc.toString()).toBe('{invalid');
    h.edit('{"n":2}'); h.click('apply');
    expect(onApply).toHaveBeenCalledTimes(1); expect(onApply).toHaveBeenCalledWith('data','{"n":2}','{\n  "n": 1\n}');
    expect(node.config.value).toEqual({n:2});
  });
  it('claims Apply before host hotkeys, only for the focused source editor', () => {
    const consume = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown',consume,true);
    const h=mount(makeNode(),'keyboard'); h.click('edit'); h.edit('{"n":4}');
    const host=jest.fn(); document.addEventListener('keydown',host);
    h.editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}));
    expect(h.onApply).toHaveBeenCalledTimes(1); expect(host).not.toHaveBeenCalled();
    document.removeEventListener('keydown',host);
    window.removeEventListener('keydown',consume,true);
  });
  it('keeps a draft and selection across external rerenders', () => {
    const node=makeNode(), h=mount(node,'refresh'); h.click('edit'); h.edit('{"n":10}');
    h.editor().dispatch({selection:{anchor:4}}); h.dispose(); h.root.remove();
    const next=mount({...node},'refresh');
    expect(next.editor().state.doc.toString()).toBe('{"n":10}'); expect(next.editor().state.selection.main.anchor).toBe(4);
    next.click('cancel'); expect(node.config.value).toEqual({n:1}); expect(next.root.querySelector('.cm-editor')).toBeNull();
  });
  it('restores an unapplied draft and selection from a reload handoff without applying it', () => {
    const node = makeNode(), first = mount(node, 'before-reload'); first.click('edit'); first.edit('{"n":77}');
    first.editor().dispatch({ selection: { anchor: 5 } }); first.dispose(); first.root.remove();
    const saved = JSON.parse(JSON.stringify(captureStudioSourceReloadState(document, 'before-reload')));
    restoreStudioSourceReloadState(document, 'after-reload', saved);
    const restored = mount(node, 'after-reload');
    expect(restored.editor().state.doc.toString()).toBe('{"n":77}');
    expect(restored.editor().state.selection.main.anchor).toBe(5);
    expect(restored.onApply).not.toHaveBeenCalled();
    expect(node.config.value).toEqual({ n: 1 });
  });
  it('retains the draft and blocks Apply when canonical source changes', () => {
    const node=makeNode(), h=mount(node,'conflict'); h.click('edit'); h.edit('{"n":10}'); h.dispose(); h.root.remove();
    node.config.value={n:99}; const next=mount(node,'conflict');
    expect(next.editor().state.doc.toString()).toBe('{"n":10}');
    expect(next.root.querySelector<HTMLButtonElement>('[data-testid="studio.source.apply.data"]')!.disabled).toBe(true);
    expect(next.root.textContent).toContain('Source changed outside'); next.click('apply'); expect(next.onApply).not.toHaveBeenCalled();
    next.click('cancel'); expect(next.root.querySelector('.ss-studio-source-code')?.textContent).toContain('99');
  });
  it('preserves a draft when a panel returns to its content and back to source', () => {
    const h=mount({...makeNode(), kind:'studio.collection'},'panel-draft',jest.fn(),'panel'); h.handle.toggleSource(); h.click('edit'); h.edit('{"n":3}'); h.handle.toggleSource();
    expect(h.root.textContent).toContain('Panel data'); h.handle.toggleSource(); expect(h.editor().state.doc.toString()).toBe('{"n":3}');
    expect(h.views).toEqual(['source', 'panel', 'source']);
  });
});

describe('content-aware node presentation', () => {
  it.each(['studio.script', 'studio.json', 'studio.input', 'studio.value', 'studio.process', 'studio.cli_command', 'studio.terminal'])('shows %s source as the content with no tabs', kind => {
    const h = mount({ ...makeNode(), kind }, `source-only:${kind}`);
    expect(h.root.querySelector('[role="tablist"]')).toBeNull();
    expect(h.root.querySelector('[role="tab"]')).toBeNull();
    expect(h.root.querySelector('.ss-studio-source-code')).not.toBeNull();
    expect(h.root.querySelector<HTMLElement>('.ss-studio-source-toolbar')?.hidden).toBe(false);
    expect(h.root.querySelector('[data-testid="studio.source.edit.data"]')).not.toBeNull();
    expect(h.handle.isSourceView()).toBe(true);
    h.handle.toggleSource();
    expect(h.handle.isSourceView()).toBe(true);
  });
  it('opens a panel on its content, hides the source toolbar, and toggles to source without tabs', () => {
    const h = mount({ ...makeNode(), kind: 'studio.collection' }, 'panel-default', jest.fn(), 'panel');
    expect(h.root.querySelector('[role="tab"]')).toBeNull();
    expect(h.root.textContent).toContain('Panel data');
    expect(h.root.dataset.sourceView).toBe('panel');
    expect(h.root.querySelector<HTMLElement>('.ss-studio-source-toolbar')?.hidden).toBe(true);
    expect(h.root.querySelector('.ss-studio-source-code')).toBeNull();
    expect(h.handle.isSourceView()).toBe(false);
    h.handle.toggleSource();
    expect(h.root.dataset.sourceView).toBe('source');
    expect(h.root.querySelector<HTMLElement>('.ss-studio-source-toolbar')?.hidden).toBe(false);
    expect(h.root.querySelector('.ss-studio-source-code')?.textContent).toContain('n: 1');
    expect(h.root.textContent).not.toContain('Panel data');
  });
  it('does not revive a cached source view when a node becomes source-only', () => {
    const h = mount({ ...makeNode(), kind: 'studio.collection' }, 'changed-kind', jest.fn(), 'panel'); h.handle.toggleSource(); h.dispose(); h.root.remove();
    const next = mount(makeNode(), 'changed-kind');
    expect(next.root.querySelector('[role="tab"]')).toBeNull();
    expect(next.root.querySelector('.ss-studio-source-code')?.textContent).toContain('"n": 1');
  });
});
