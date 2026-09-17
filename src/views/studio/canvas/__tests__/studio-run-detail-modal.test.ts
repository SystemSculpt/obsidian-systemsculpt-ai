/** @jest-environment jsdom */
import { App, Component, MarkdownRenderer } from 'obsidian';
import { StudioRunDetailModal } from '../StudioRunDetailModal';
const markdown = '| Benchmark | Finding |\n| --- | --- |\n| Example | **Verified** |';
function fixture() {
  const run = { id: 'run-1', title: 'Scout', projectId: 'p', projectPath: 'Benchmarks/graph.systemsculpt', status: 'completed', currentActivity: 'Completed', request: { prompt: 'Read the registry.', model: 'gpt-6-astra', effort: 'high', serviceTier: 'default' }, machine: 'mac', result: markdown, activity: [{ kind: 'message', title: 'Response', detail: markdown, status: 'completed', at: '2026-09-09' }, { kind: 'command', title: 'Inspect', detail: 'echo **literal**', status: 'completed', at: '2026-09-09' }], messages: [] };
  let listener!: (projectId: string) => void;
  const unsubscribe = jest.fn();
  const runs = { app: new App(), get: () => run, canControl: () => true, hasRequest: () => false, subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe; } } as any;
  const modal = new StudioRunDetailModal(runs, run.id); modal.onOpen();
  return { modal, run, listener: () => listener('p'), unsubscribe };
}
afterEach(() => jest.restoreAllMocks());
it('opens completed output in Markdown, toggles exact source, and keeps unchanged content stable', async () => {
  const render = jest.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, element) => { element.createEl('p', { text }); });
  const f = fixture();
  expect(f.modal.modalEl.classList.contains('ss-modal--fullwidth')).toBe(true);
  expect(f.modal.modalEl.querySelector('[data-run-tab="Response"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(render).toHaveBeenCalledWith(expect.anything(), markdown, expect.any(HTMLElement), 'Benchmarks/graph.systemsculpt', expect.any(Component));
  const element = f.modal.modalEl.querySelector('.ss-studio-run-markdown');
  f.run.currentActivity = 'Status changed'; f.listener(); expect(f.modal.modalEl.querySelector('.ss-studio-run-markdown')).toBe(element); expect(render).toHaveBeenCalledTimes(1);
  f.modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="studio.run.source"]')!.click();
  expect(f.modal.modalEl.querySelector('.ss-studio-run-stream pre')?.textContent).toBe(markdown);
  f.modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="studio.run.source"]')!.click();
  expect(render).toHaveBeenCalledTimes(2); f.modal.onClose(); expect(f.unsubscribe).toHaveBeenCalled();
});
it('renders public activity messages as Markdown while keeping commands literal', () => {
  const render = jest.spyOn(MarkdownRenderer, 'render').mockResolvedValue(); const f = fixture();
  f.modal.modalEl.querySelector<HTMLButtonElement>('[data-run-tab="Activity"]')!.click();
  expect(render.mock.calls.at(-1)?.[1]).toBe(markdown);
  expect(f.modal.modalEl.querySelector('.ss-studio-run-stream pre')?.textContent).toBe('echo **literal**'); f.modal.onClose();
});
it('unloads Markdown components on replacement and close, ignoring late render completion', async () => {
  const resolvers: (() => void)[] = [];
  const render = jest.spyOn(MarkdownRenderer, 'render').mockImplementation(() => new Promise<void>(resolve => { resolvers.push(resolve); }));
  const f = fixture(), owner = render.mock.calls[0][4]; const unload = jest.spyOn(owner, 'unload');
  f.run.result = 'Updated response'; f.listener(); expect(unload).toHaveBeenCalledTimes(1);
  const second = jest.spyOn(render.mock.calls[1][4], 'unload'); f.modal.onClose(); expect(second).toHaveBeenCalledTimes(1);
  resolvers.forEach(resolve => resolve()); await Promise.resolve(); await Promise.resolve(); expect(f.modal.modalEl.textContent).toBe('');
});
it('falls back to exact text if the host Markdown renderer fails', async () => {
  jest.spyOn(MarkdownRenderer, 'render').mockRejectedValue(new Error('Render failed')); const f = fixture();
  await Promise.resolve(); await Promise.resolve(); expect(f.modal.modalEl.querySelector('pre')?.textContent).toBe(markdown); f.modal.onClose();
});
