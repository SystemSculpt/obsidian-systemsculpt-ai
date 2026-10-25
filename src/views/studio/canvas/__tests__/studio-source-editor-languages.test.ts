/** @jest-environment jsdom */

// Each test takes a fresh registry so the language packs start unloaded, and
// requires CodeMirror from that same registry so facets compare by identity.
type Modules = {
  editor: typeof import('../StudioSourceEditor');
  view: typeof import('@codemirror/view');
  language: typeof import('@codemirror/language');
};
function freshModules(): Modules {
  jest.resetModules();
  return {
    editor: require('../StudioSourceEditor'),
    view: require('@codemirror/view'),
    language: require('@codemirror/language'),
  };
}
const SOURCE = '{"count": 1}';

afterEach(() => { document.body.innerHTML = ''; });

describe('Studio source language packs', () => {
  it('shows source as plain text until the packs load, then the highlighted markup', async () => {
    const { editor } = freshModules();
    const root = document.body.createDiv();

    editor.renderStudioHighlightedSource(root, SOURCE, 'json');
    const code = root.querySelector('code')!;
    expect(code.textContent).toBe(SOURCE);
    expect(code.querySelectorAll('span')).toHaveLength(0);

    await editor.loadStudioSourceLanguages();
    await Promise.resolve();
    expect(code.textContent).toBe(SOURCE);
    expect(code.querySelector('.tok-propertyName')?.textContent).toBe('"count"');
    expect(code.querySelector('.tok-number')?.textContent).toBe('1');
  });

  it('highlights at once once the packs are loaded', async () => {
    const { editor } = freshModules();
    await editor.loadStudioSourceLanguages();
    const root = document.body.createDiv();

    editor.renderStudioHighlightedSource(root, 'const x = 1;', 'javascript');

    expect(root.querySelector('.tok-keyword')?.textContent).toBe('const');
  });

  it('gives an editor opened before the packs load its language when they arrive', async () => {
    const { editor, view: { EditorView }, language: { language } } = freshModules();
    const root = document.body.createDiv();
    const mounted = editor.mountStudioSourceEditor(root, { source: SOURCE, language: 'json', label: 'Data source', onChange: jest.fn(), onApply: jest.fn() });
    const view = EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
    expect(view.state.facet(language)).toBeNull();

    await editor.loadStudioSourceLanguages();
    await Promise.resolve();

    expect(view.state.facet(language)?.name).toBe('json');
    expect(mounted.read()).toBe(SOURCE);
    mounted.destroy();
  });

  it('leaves an editor closed before the packs arrived untouched', async () => {
    const { editor, view: { EditorView } } = freshModules();
    const root = document.body.createDiv();
    const mounted = editor.mountStudioSourceEditor(root, { source: SOURCE, language: 'yaml', label: 'Data source', onChange: jest.fn(), onApply: jest.fn() });
    const view = EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
    const dispatch = jest.spyOn(view, 'dispatch');
    mounted.destroy();

    await editor.loadStudioSourceLanguages();
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalled();
  });
});
