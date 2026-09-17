/** @jest-environment jsdom */
import { renderStudioRunCollection, StudioRunDetailModal } from '../StudioRunCollectionRenderer';
import type { StudioAgentRun } from '../../../../services/codex/StudioAgentRunStore';
import { runCollectionPorts } from '../../../../studio/nodes/runCollectionNode';
import { isStudioVisualOnlyNodeKind } from '../../../../studio/StudioNodeKinds';

it('shows distinct instances, keeps their DOM stable during activity, opens details and unsubscribes', async () => {
  const records = ['one','two'].map(id => ({ id, title: 'Worker', nodeId: 'worker', status: 'running', createdAt: new Date().toISOString(), currentActivity: 'Starting', messages: [] })) as unknown as StudioAgentRun[];
  let listener!: (project: string) => void; const unsubscribe = jest.fn();
  const runs = { app: {}, list: () => records, load: async () => {}, subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe; } } as any;
  const open = jest.spyOn(StudioRunDetailModal.prototype, 'open').mockImplementation(() => {});
  const root = document.createElement('div');
  const dispose = renderStudioRunCollection(root, { runs, projectId: 'p', projectPath: 'p.systemsculpt' }); await Promise.resolve();
  expect(root.querySelectorAll('[data-run-id]')).toHaveLength(2);
  const card = root.querySelector('[data-run-id="one"]')!;
  records[0].currentActivity = 'Running tests'; listener('p');
  expect(root.querySelector('[data-run-id="one"]')).toBe(card); expect(card.textContent).toContain('Running tests');
  card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); expect(open).toHaveBeenCalledTimes(1);
  const input = root.querySelector('input')!; input.value = 'two'; input.dispatchEvent(new Event('input'));
  expect(root.querySelectorAll('[data-run-id]')).toHaveLength(1);
  dispose(); expect(unsubscribe).toHaveBeenCalled(); open.mockRestore();
});
it('declares bounded observation ports on a visual-only collection', () => {
  expect(isStudioVisualOnlyNodeKind('studio.run_collection')).toBe(true);
  expect(runCollectionPorts(['worker', 'worker', '../bad', 'scout'])).toEqual([{ id: 'worker', type: 'json', required: false }, { id: 'scout', type: 'json', required: false }]);
});
