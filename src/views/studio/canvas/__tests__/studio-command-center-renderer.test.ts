/** @jest-environment jsdom */
import { renderStudioCommandCenter } from '../StudioCommandCenterRenderer';
import { hasHostCapability } from '../../../../platform/hostCapabilities';
import { readStudioCommandActions } from '../../../../studio/nodes/commandCenterNode';
import { isStudioVisualOnlyNodeKind } from '../../../../studio/StudioNodeKinds';
jest.mock('../../../../platform/hostCapabilities', () => ({ hasHostCapability: jest.fn(() => true) }));
const node = (id: string, kind = 'studio.codex', config: any = {}) => ({ id, kind, title: id, version: '1', position: { x: 0, y: 0 }, config });
const actions = [{ id: 'start', label: 'Start Worker', kind: 'run', target: 'worker', section: 'Run', description: '' }, { id: 'view', label: 'View runs', kind: 'focus', target: 'runs', section: 'View', description: '' }];
function fixture(kind = 'studio.command_center', config: any = { actions: { items: actions } }) {
  const root = document.createElement('div'), run = jest.fn(), focus = jest.fn();
  renderStudioCommandCenter(root, { node: node('control', kind, config), nodes: [node('worker'), node('runs','studio.run_collection')], projectId: 'p', busy: true, definition: target => ({ requiredHostCapabilities: target.kind === 'studio.codex' ? ['local-cli'] : [] }) as any, run, focus });
  return { root, run, focus };
}
afterEach(() => jest.mocked(hasHostCapability).mockReturnValue(true));
it('dispatches only explicit clicks and permits multiple independent role instances while busy', () => {
  const { root, run, focus } = fixture(); expect(run).not.toHaveBeenCalled();
  const start = root.querySelector<HTMLButtonElement>('[data-testid="studio.command.start"]')!;
  expect(start.disabled).toBe(false); start.click(); start.click(); expect(run.mock.calls).toEqual([['worker'],['worker']]);
  root.querySelector<HTMLButtonElement>('[data-testid="studio.command.view"]')!.click(); expect(focus).toHaveBeenCalledWith('runs');
});
it('disables desktop execution on mobile while retaining navigation', () => {
  jest.mocked(hasHostCapability).mockReturnValue(false); const { root, run, focus } = fixture();
  expect(root.querySelector('[data-testid="studio.command.models-retry"]')).toBeNull();
  const start = root.querySelector<HTMLButtonElement>('[data-testid="studio.command.start"]')!;
  expect(start.disabled).toBe(true); start.click(); expect(run).not.toHaveBeenCalled();
  root.querySelector<HTMLButtonElement>('[data-testid="studio.command.view"]')!.click(); expect(focus).toHaveBeenCalledWith('runs');
});
it('supports a standalone Button node and disables a removed target', () => {
  const { root, run } = fixture('studio.button', { label: 'Start', action: 'run', target: 'worker' });
  expect(root.querySelectorAll('button')).toHaveLength(1); root.querySelector('button')!.click(); expect(run).toHaveBeenCalledWith('worker');
  const missing = fixture('studio.button', { label: 'Start', action: 'run', target: 'missing' }); expect(missing.root.querySelector('button')!.disabled).toBe(true);
});
it('keeps controls outside execution traversal and bounds configuration', () => {
  expect(isStudioVisualOnlyNodeKind('studio.button')).toBe(true); expect(isStudioVisualOnlyNodeKind('studio.command_center')).toBe(true);
  expect(() => readStudioCommandActions({ items: [...actions, actions[0]] })).toThrow('unique');
  expect(() => readStudioCommandActions(Array(41).fill(actions[0]))).toThrow('40');
});
